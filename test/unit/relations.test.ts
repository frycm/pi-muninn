import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newEntryId, newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import { scanJournal } from "../../src/journal/jsonl.ts";
import { buildJournalRecord, type JournalRecord } from "../../src/journal/record.ts";
import { correctionRank, projectRelations, relationNeighborhood } from "../../src/journal/relations.ts";
import { appendAuthorizedJournalRecord, appendUserRelation, JournalAuthorityError } from "../../src/journal/writer.ts";

const roots: string[] = [];

function store(): string {
	const path = mkdtempSync(join(tmpdir(), "muninn-relations-"));
	roots.push(path);
	return path;
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function identity() {
	return { project: newProjectId(), member: newMemberId(), host: newHostId() };
}

function record(
	id: string,
	ids: ReturnType<typeof identity>,
	body: string,
	relations: JournalRecord["relations"] = [],
	overrides: Partial<JournalRecord> = {},
): JournalRecord {
	return {
		...buildJournalRecord(
			{ type: "note", source: "agent", channel: "sdk", body, relations },
			{ ...ids, id, now: new Date(`2026-08-30T11:32:${String(Math.floor(Math.random() * 50)).padStart(2, "0")}.000Z`) },
		),
		...overrides,
	};
}

describe("journal write authority", () => {
	it("rejects every way a model could impersonate a user correction", async () => {
		const path = store();
		const ids = identity();
		const target = newEntryId();
		await expect(
			appendAuthorizedJournalRecord(
				{
					authority: "model",
					record: {
						type: "correction",
						source: "user",
						channel: "sdk",
						body: "wrong",
						relations: [{ type: "corrects", target }],
					},
				},
				{ storePath: path, ...ids },
			),
		).rejects.toBeInstanceOf(JournalAuthorityError);
		await expect(
			appendAuthorizedJournalRecord(
				{
					authority: "model",
					record: {
						type: "note",
						source: "agent",
						channel: "sdk",
						body: "wrong",
						relations: [{ type: "corrects", target }],
					},
				},
				{ storePath: path, ...ids },
			),
		).rejects.toThrow(/cannot create corrects relations/);
		expect(scanJournal(path).records).toEqual([]);
	});

	it("allows only agent outcomes without relations through automatic capture", async () => {
		const path = store();
		const ids = identity();
		await expect(
			appendAuthorizedJournalRecord(
				{
					authority: "automatic",
					record: {
						type: "outcome",
						source: "agent",
						channel: "hook",
						body: "done",
						relations: [{ type: "annotates", target: newEntryId() }],
					},
				},
				{ storePath: path, ...ids },
			),
		).rejects.toThrow(/cannot assign correction meaning/);
		const written = await appendAuthorizedJournalRecord(
			{ authority: "automatic", record: { type: "outcome", source: "agent", channel: "hook", body: "done" } },
			{ storePath: path, ...ids },
		);
		expect(written.record).toMatchObject({ type: "outcome", source: "agent" });
	});

	it("rejects self-links and duplicate relations before writing", async () => {
		const path = store();
		const ids = identity();
		const id = newEntryId();
		await expect(
			appendAuthorizedJournalRecord(
				{
					authority: "headless-user",
					record: {
						type: "correction",
						source: "user",
						channel: "cli",
						body: "self",
						relations: [{ type: "corrects", target: id }],
					},
				},
				{ storePath: path, ...ids, id },
			),
		).rejects.toThrow(/cannot relate to itself/);
		expect(scanJournal(path).records).toEqual([]);
	});
});

describe("relation projection", () => {
	it("appends a direct-user correction without changing the target line", async () => {
		const path = store();
		const ids = identity();
		const target = await appendAuthorizedJournalRecord(
			{ authority: "attended-user", record: { type: "note", source: "user", channel: "tui", body: "PostgreSQL 16" } },
			{ storePath: path, ...ids },
		);
		const targetLine = readFileSync(target.path, "utf-8").split("\n")[0];
		const correction = await appendUserRelation({
			authority: "attended-user",
			target: target.id,
			text: "The service now uses PostgreSQL 17.",
			relation: "corrects",
			channel: "tui",
			storePath: path,
			...ids,
		});
		expect(readFileSync(target.path, "utf-8").split("\n")[0]).toBe(targetLine);
		const projection = projectRelations(
			scanJournal(path).records.map((item) => item.record),
			ids.member,
		);
		expect(projection.views.get(target.id)?.labels).toContain("corrected");
		expect(projection.views.get(correction.id)?.labels).toContain("correction");
		expect(correctionRank(correction.record, projection)).toBe(20);
	});

	it("keeps a missing target visible on the correction", async () => {
		const path = store();
		const ids = identity();
		const target = newEntryId();
		const correction = await appendUserRelation({
			authority: "headless-user",
			target,
			text: "The remote record is stale.",
			relation: "corrects",
			channel: "cli",
			storePath: path,
			...ids,
		});
		const projection = projectRelations([correction.record], ids.member);
		expect(projection.missing).toEqual([{ from: correction.id, to: target, type: "corrects" }]);
		expect(projection.views.get(correction.id)?.labels).toContain("missing-target");
	});

	it("reads a correction chain in both directions", () => {
		const ids = identity();
		const first = newEntryId();
		const second = newEntryId();
		const third = newEntryId();
		const records = [
			record(first, ids, "old"),
			record(second, ids, "new", [{ type: "corrects", target: first }], { source: "user", type: "correction" }),
			record(third, ids, "newest", [{ type: "supersedes", target: second }], { source: "user", type: "correction" }),
		];
		const projection = projectRelations(records, ids.member);
		expect(relationNeighborhood(projection, first, { depth: 2 })?.records.map((view) => view.record.id)).toEqual([
			first,
			second,
			third,
		]);
	});

	it("reports cycles and competing corrections instead of resolving by timestamp", () => {
		const ids = identity();
		const target = newEntryId();
		const left = newEntryId();
		const right = newEntryId();
		const cycleA = newEntryId();
		const cycleB = newEntryId();
		const projection = projectRelations(
			[
				record(target, ids, "target"),
				record(left, ids, "left", [{ type: "corrects", target }], { source: "user", type: "correction" }),
				record(right, ids, "right", [{ type: "supersedes", target }], { source: "user", type: "correction" }),
				record(cycleA, ids, "a", [{ type: "annotates", target: cycleB }]),
				record(cycleB, ids, "b", [{ type: "annotates", target: cycleA }]),
			],
			ids.member,
		);
		expect(projection.conflicts).toEqual([{ target, records: [left, right].sort() }]);
		expect(projection.views.get(left)?.labels).toContain("conflict");
		expect(projection.views.get(right)?.labels).toContain("conflict");
		expect(projection.cycles).toEqual([[cycleA, cycleB].sort()]);
	});

	it("labels a teammate correction as teammate-user", () => {
		const ids = identity();
		const target = newEntryId();
		const teammate = { ...ids, member: newMemberId(), host: newHostId() };
		const correction = record(newEntryId(), teammate, "team says newer", [{ type: "corrects", target }], {
			source: "user",
			type: "correction",
		});
		const projection = projectRelations([record(target, ids, "old"), correction], ids.member);
		expect(projection.views.get(correction.id)?.trust).toBe("teammate-user");
	});
});
