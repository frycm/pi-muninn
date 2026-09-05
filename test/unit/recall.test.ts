import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import { appendJournalRecord } from "../../src/journal/jsonl.ts";
import { JournalQueryService } from "../../src/journal/query.ts";
import type { MemoryCaller } from "../../src/memory/runtime.ts";
import { recallMemories } from "../../src/recall/recall.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";

let root: string;
let write: { storePath: string; project: string; member: string; host: string };
let service: JournalQueryService;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "muninn-recall-"));
	write = { storePath: root, project: newProjectId(), member: newMemberId(), host: newHostId() };
	service = new JournalQueryService({ storePath: root, localMember: write.member, maxChars: 64_000, mode: "scan" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function caller(
	select: (candidates: Array<{ match: { id: string }; records: unknown[] }>) => unknown | Promise<unknown>,
): MemoryCaller {
	return {
		maxInputTokens: 12000,
		signal: new AbortController().signal,
		json: async (_prompt, input, parse) => {
			const candidates = (input as { candidates?: Array<{ match: { id: string }; records: unknown[] }> }).candidates;
			return parse(candidates ? await select(candidates) : { queries: ["vitest watch mode"] });
		},
	};
}

describe("assisted recall", () => {
	it("does not present an old solution when its correction chain exceeds the read depth", async () => {
		const first = await appendJournalRecord(
			{ type: "note", source: "user", channel: "cli", body: "vitest watch mode" },
			write,
		);
		let previous = first.id;
		for (let i = 0; i < 7; i++) {
			previous = (
				await appendJournalRecord(
					{
						type: "correction",
						source: "user",
						channel: "cli",
						body: `Revision ${i}`,
						relations: [{ type: "corrects", target: previous }],
					},
					write,
				)
			).id;
		}
		const model = caller((candidates) => {
			expect(candidates.some((c) => c.match.id === first.id)).toBe(false);
			return { selected: [] };
		});
		const result = await recallMemories(service, model, DEFAULT_SETTINGS.recall, { query: "vitest" });
		expect(result.selected).toEqual([]);
		expect(result.truncated).toBe(true);
	});

	it("expands different wording and returns legacy evidence with its correction", async () => {
		const old = await appendJournalRecord(
			{ type: "outcome", source: "agent", channel: "sdk", body: "vitest watch mode needs pnpm test --run" },
			write,
		);
		const fix = await appendJournalRecord(
			{
				type: "correction",
				source: "user",
				channel: "cli",
				body: "For this workspace use pnpm test:ci; the script already disables watch.",
				relations: [{ type: "corrects", target: old.id }],
			},
			write,
		);
		const result = await recallMemories(
			service,
			caller(() => ({
				selected: [{ id: old.id, reason: "The observed CI symptom matches; use the corrected workspace command." }],
			})),
			DEFAULT_SETTINGS.recall,
			{ query: "The build worker waits forever" },
		);
		expect(result.status).toBe("recalled");
		expect(result.selected[0]?.records.map((r) => r.id)).toEqual([old.id, fix.id]);
		expect(result.selected[0]?.match.labels).toContain("corrected");
		expect(JSON.stringify(result).length).toBeLessThanOrEqual(DEFAULT_SETTINGS.recall.maxChars);
	});

	it("supports abstention and does not accept invented selection IDs", async () => {
		await appendJournalRecord({ type: "note", source: "user", channel: "cli", body: "vitest watch mode" }, write);
		const empty = await recallMemories(
			service,
			caller(() => ({ selected: [] })),
			DEFAULT_SETTINGS.recall,
			{ query: "unrelated deployment" },
		);
		expect(empty.status).toBe("no-match");
		const invalid = await recallMemories(
			service,
			caller(() => ({ selected: [{ id: "made-up", reason: "imagined" }] })),
			DEFAULT_SETTINGS.recall,
			{ query: "vitest" },
		);
		expect(invalid.status).toBe("unavailable");
		expect(invalid.selected).toEqual([]);
	});

	it("refuses stale selections when a correction arrives during the model call", async () => {
		const old = await appendJournalRecord(
			{ type: "note", source: "user", channel: "cli", body: "vitest watch mode" },
			write,
		);
		const model = caller(async () => {
			await appendJournalRecord(
				{
					type: "correction",
					source: "user",
					channel: "cli",
					body: "This workaround is obsolete.",
					relations: [{ type: "corrects", target: old.id }],
				},
				write,
			);
			return { selected: [{ id: old.id, reason: "old reason" }] };
		});
		const result = await recallMemories(service, model, DEFAULT_SETTINGS.recall, { query: "vitest" });
		expect(result.selected).toEqual([]);
		expect(result.warnings.join(" ")).toContain("changed during selection");
	});

	it("omits a solution whose correction neighborhood cannot fit intact", async () => {
		const old = await appendJournalRecord(
			{ type: "note", source: "user", channel: "cli", body: "vitest watch mode" },
			write,
		);
		await appendJournalRecord(
			{
				type: "correction",
				source: "user",
				channel: "cli",
				body: "long correction ".repeat(1500),
				relations: [{ type: "corrects", target: old.id }],
			},
			write,
		);
		const bounded = new JournalQueryService({ storePath: root, localMember: write.member, maxChars: 1500 });
		const result = await recallMemories(
			bounded,
			caller(() => ({ selected: [{ id: old.id, reason: "must not be used alone" }] })),
			{ ...DEFAULT_SETTINGS.recall, maxChars: 1000 },
			{ query: "vitest" },
		);
		expect(result.selected).toEqual([]);
		expect(result.truncated).toBe(true);
		expect(JSON.stringify(result).length).toBeLessThanOrEqual(1000);
	});
});
