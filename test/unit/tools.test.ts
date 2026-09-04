import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MuninnSessionState } from "../../src/capture/session-state.ts";
import { newEntryId, newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import { appendJournalRecord, scanJournal } from "../../src/journal/jsonl.ts";
import { JournalQueryService } from "../../src/journal/query.ts";
import type { NewJournalRecord } from "../../src/journal/record.ts";
import { appendAuthorizedJournalRecord } from "../../src/journal/writer.ts";
import type { SessionContext } from "../../src/session.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import { journalContextTool } from "../../src/tools/journal-context.ts";
import { journalNoteTool } from "../../src/tools/journal-note.ts";
import { journalReadTool } from "../../src/tools/journal-read.ts";
import type { JournalToolRuntime } from "../../src/tools/journal-runtime.ts";
import { journalSearchTool } from "../../src/tools/journal-search.ts";

let store: string;
let projectId: string;
let member: string;
let host: string;
let state: MuninnSessionState;

beforeEach(() => {
	store = mkdtempSync(join(tmpdir(), "muninn-journal-tools-"));
	projectId = newProjectId();
	member = newMemberId();
	host = newHostId();
	state = { task: "task-tools", written: [] };
});

afterEach(() => rmSync(store, { recursive: true, force: true }));

function sessionContext(): SessionContext {
	return {
		host: { id: host, name: "test-host", createdAt: "2026-08-30T00:00:00.000Z" },
		loaded: {
			settings: structuredClone(DEFAULT_SETTINGS),
			warnings: [],
			sources: {
				global: { path: "/agent/settings.json", present: false, hasMuninnBlock: false },
				project: { path: "/project/.pi/settings.json", present: false, hasMuninnBlock: false },
			},
		},
		project: {
			id: projectId,
			name: "test-project",
			storePath: store,
			registryPath: "/agent/muninn-projects/registry.json",
			member: { id: member, name: "tester", createdAt: "2026-08-30T00:00:00.000Z" },
			root: "/project",
			locations: [{ root: "/project", linkedAt: "2026-08-30T00:00:00.000Z" }],
			reason: "root",
			reasonDetail: "test mapping",
		},
		scopes: {
			active: [{ scope: "project", path: store, exists: true, projectId }],
			captureTarget: "project",
			reasons: [],
		},
		problems: [],
	};
}

function runtime(): JournalToolRuntime {
	const session = sessionContext();
	const service = new JournalQueryService({ storePath: store, localMember: member, mode: "scan", maxChars: 16_000 });
	return {
		settle: async () => {},
		session: () => session,
		state: () => state,
		query: () => service,
		async append(record: NewJournalRecord) {
			const written = await appendAuthorizedJournalRecord(
				{ authority: "model", record },
				{ storePath: store, project: projectId, member, host },
			);
			state.written.push(written.id);
			service.add(written.record);
			return written;
		},
	};
}

const context = {
	mode: "tui",
	cwd: "/project",
	sessionManager: { getSessionFile: () => "/sessions/tools.jsonl", getLeafId: () => "e-tool" },
} as unknown as ExtensionContext;

async function run<T>(
	tool: { execute: (...args: never[]) => Promise<T> },
	params: unknown,
	signal?: AbortSignal,
): Promise<T> {
	return tool.execute(...(["call-1", params, signal, undefined, context] as never[]));
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

async function seed(input: NewJournalRecord) {
	return appendJournalRecord(input, { storePath: store, project: projectId, member, host });
}

describe("journal tool schemas", () => {
	it("registers three parallel readers and one sequential writer without memory aliases", () => {
		const rt = runtime();
		const tools = [journalSearchTool(rt), journalReadTool(rt), journalContextTool(rt), journalNoteTool(rt)];
		expect(tools.map((tool) => tool.name)).toEqual([
			"journal_search",
			"journal_read",
			"journal_context",
			"journal_note",
		]);
		expect(tools.map((tool) => tool.executionMode)).toEqual(["parallel", "parallel", "parallel", "sequential"]);
		const schemas = JSON.stringify(tools.map((tool) => tool.parameters));
		expect(schemas).not.toContain("memory_");
		expect(JSON.stringify(tools[3]?.parameters)).not.toContain('"source"');
		expect(schemas).not.toContain('"path":{"description":"A path inside');
		const searchProperties = JSON.parse(JSON.stringify(tools[0]?.parameters)).properties;
		expect(searchProperties).toHaveProperty("relatedTo");
		expect(searchProperties).toHaveProperty("trust");
		expect(searchProperties).toHaveProperty("label");
		expect(searchProperties).toHaveProperty("explain");
		expect(JSON.parse(JSON.stringify(tools[3]?.parameters)).properties.relations.items.properties.type.const).toBe(
			"annotates",
		);
	});

	it("registers no lifecycle hook that injects journal content into prompts", () => {
		const source = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf-8");
		expect(source).not.toContain('pi.on("before_agent_start"');
		expect(source).not.toContain("systemPromptOverride");
	});
});

describe("journal_search and journal_read", () => {
	it("return the canonical query IDs and explicit relation neighborhood", async () => {
		const target = await seed({ type: "note", source: "user", channel: "cli", body: "Deploys require the VPN." });
		const correction = await seed({
			type: "correction",
			source: "user",
			channel: "cli",
			body: "Only production deploys require the VPN.",
			relations: [{ type: "corrects", target: target.id }],
		});
		const rt = runtime();
		const search = JSON.parse(textOf(await run(journalSearchTool(rt), { query: "Deploys require VPN" }))) as {
			records: Array<{ id: string }>;
		};
		expect(new Set(search.records.map((record) => record.id))).toEqual(new Set([target.id, correction.id]));
		const read = JSON.parse(textOf(await run(journalReadTool(rt), { id: target.id, relationDepth: 1 }))) as {
			records: Array<{ id: string }>;
		};
		expect(read.records.map((record) => record.id)).toEqual([target.id, correction.id]);
		const explained = JSON.parse(textOf(await run(journalSearchTool(rt), { query: "VPN", explain: true }))) as {
			records: Array<{ id: string; explanation?: { match: string; total: number }; score: number }>;
		};
		const direct = explained.records.find((record) => record.id === target.id);
		expect(direct?.explanation).toMatchObject({ match: "direct" });
		expect(direct?.explanation?.total).toBe(direct?.score);
	});

	it("accepts only stable IDs, never filesystem or transcript paths", async () => {
		await expect(run(journalReadTool(runtime()), { id: "../../etc/passwd" })).rejects.toThrow(/full journal record id/);
		await expect(run(journalReadTool(runtime()), { id: "/sessions/private.jsonl#e-1" })).rejects.toThrow(
			/full journal record id/,
		);
	});

	it("honors cancellation before reading", async () => {
		const abort = new AbortController();
		abort.abort();
		await expect(run(journalSearchTool(runtime()), { query: "anything" }, abort.signal)).rejects.toThrow(/cancelled/);
	});
});

describe("journal_context", () => {
	it("batches only selected IDs and stays under its hard budget", async () => {
		const selected = await seed({ type: "note", source: "agent", channel: "sdk", body: "selected evidence" });
		const unselected = await seed({ type: "note", source: "agent", channel: "sdk", body: "do not include me" });
		const missing = newEntryId();
		const text = textOf(
			await run(journalContextTool(runtime()), { ids: [selected.id, selected.id, missing], maxChars: 1000 }),
		);
		expect(text.length).toBeLessThanOrEqual(1000);
		const parsed = JSON.parse(text) as { records: Array<{ id: string }>; missing: string[] };
		expect(parsed.records.map((record) => record.id)).toEqual([selected.id]);
		expect(parsed.missing).toEqual([missing]);
		expect(text).not.toContain(unselected.id);
	});
});

describe("journal_note", () => {
	it("writes source: agent, indexes immediately, and preserves only annotation relations", async () => {
		const target = await seed({ type: "note", source: "user", channel: "cli", body: "target" });
		const rt = runtime();
		const result = JSON.parse(
			textOf(
				await run(journalNoteTool(rt), {
					text: "Agent observation for later.",
					cue: "when debugging",
					tags: ["debug"],
					relations: [{ type: "annotates", target: target.id }],
				}),
			),
		) as { id: string; source: string };
		expect(result.source).toBe("agent");
		const written = scanJournal(store).records.find((item) => item.record.id === result.id)?.record;
		expect(written).toMatchObject({
			source: "agent",
			type: "note",
			cue: "when debugging",
			tags: ["debug"],
			relations: [{ type: "annotates", target: target.id }],
		});
		expect(rt.query().query({ query: "Agent observation" }).records[0]?.id).toBe(result.id);
	});

	it("cannot create a user correction even when execute is called outside schema validation", async () => {
		const target = newEntryId();
		await expect(
			run(journalNoteTool(runtime()), {
				text: "pretend correction",
				relations: [{ type: "corrects", target }],
			}),
		).rejects.toThrow(/cannot create corrects relations/);
	});
});
