import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newEntryId, newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import { scanJournal } from "../../src/journal/jsonl.ts";
import { buildJournalRecord, type JournalRecord } from "../../src/journal/record.ts";
import { correctionRank, projectRelations, relationNeighborhood } from "../../src/journal/relations.ts";
import {
	appendAuthorizedJournalRecord,
	appendIntegrationObservation,
	appendUserRelation,
	JournalAuthorityError,
	resolveUserConflict,
} from "../../src/journal/writer.ts";

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

	it("accepts only external integration records and makes retries idempotent", async () => {
		const path = store();
		const ids = identity();
		const record = {
			type: "checkpoint" as const,
			source: "external" as const,
			channel: "rpc" as const,
			body: "Remote session completed.",
			integration: {
				provider: "pi-huginn",
				kind: "remote-session",
				event: "completed",
				external_id: "remote-session-1:revision-3",
				observed_at: "2026-09-04T12:00:00.000Z",
				metadata: { revision: 3 },
			},
		};
		const first = await appendIntegrationObservation(record, { storePath: path, ...ids });
		const replay = await appendIntegrationObservation(record, { storePath: path, ...ids });
		expect(first.replayed).toBe(false);
		expect(replay).toMatchObject({ id: first.id, replayed: true });
		expect(scanJournal(path).records).toHaveLength(1);
		await expect(
			appendIntegrationObservation({ ...record, body: "changed" }, { storePath: path, ...ids }),
		).rejects.toThrow(/reused with different content/);
		await expect(
			appendAuthorizedJournalRecord({ authority: "integration", record }, { storePath: path, ...ids }),
		).rejects.toThrow(/idempotent integration writer/);
		await expect(
			appendIntegrationObservation({ ...record, source: "agent" }, { storePath: path, ...ids }),
		).rejects.toThrow(/source: external/);
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

	it("removes explicitly superseded branches and reopens on a later correction", () => {
		const ids = identity();
		const target = newEntryId();
		const left = newEntryId();
		const right = newEntryId();
		const resolution = newEntryId();
		const later = newEntryId();
		const base = [
			record(target, ids, "target"),
			record(left, ids, "left", [{ type: "corrects", target }], { source: "user", type: "correction" }),
			record(right, ids, "right", [{ type: "corrects", target }], { source: "user", type: "correction" }),
		];
		const resolved = record(
			resolution,
			ids,
			"resolved",
			[
				{ type: "corrects", target },
				{ type: "supersedes", target: left },
				{ type: "supersedes", target: right },
			],
			{ source: "user", type: "correction" },
		);
		expect(projectRelations([...base, resolved], ids.member).conflicts).toEqual([]);
		const reopened = record(later, ids, "later", [{ type: "corrects", target }], {
			source: "user",
			type: "correction",
		});
		expect(projectRelations([...base, resolved, reopened], ids.member).conflicts).toEqual([
			{ target, records: [resolution, later].sort() },
		]);
	});

	it("keeps concurrent resolutions as an active conflict", () => {
		const ids = identity();
		const target = newEntryId();
		const left = newEntryId();
		const right = newEntryId();
		const first = newEntryId();
		const second = newEntryId();
		const base = [
			record(target, ids, "target"),
			record(left, ids, "left", [{ type: "corrects", target }], { source: "user", type: "correction" }),
			record(right, ids, "right", [{ type: "corrects", target }], { source: "user", type: "correction" }),
		];
		const resolution = (id: string, body: string) =>
			record(
				id,
				ids,
				body,
				[
					{ type: "corrects", target },
					{ type: "supersedes", target: left },
					{ type: "supersedes", target: right },
				],
				{ source: "user", type: "correction" },
			);
		expect(
			projectRelations([...base, resolution(first, "one"), resolution(second, "two")], ids.member).conflicts,
		).toEqual([{ target, records: [first, second].sort() }]);
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

describe("explicit conflict resolution", () => {
	it("atomically supersedes every active branch without modifying prior bytes", async () => {
		const path = store();
		const ids = identity();
		const target = await appendAuthorizedJournalRecord(
			{ authority: "headless-user", record: { type: "note", source: "user", channel: "cli", body: "old" } },
			{ storePath: path, ...ids },
		);
		const left = await appendUserRelation({
			authority: "headless-user",
			target: target.id,
			text: "left",
			relation: "corrects",
			channel: "cli",
			storePath: path,
			...ids,
		});
		const right = await appendUserRelation({
			authority: "headless-user",
			target: target.id,
			text: "right",
			relation: "corrects",
			channel: "cli",
			storePath: path,
			...ids,
		});
		const bytes = readFileSync(target.path, "utf-8").split("\n")[0];
		const result = await resolveUserConflict({
			authority: "headless-user",
			target: target.id,
			text: "chosen",
			channel: "cli",
			storePath: path,
			...ids,
		});
		expect(result.status).toBe("resolved");
		if (result.status !== "resolved") return;
		expect(result.branches).toEqual([left.id, right.id].sort());
		expect(result.written.record.relations).toEqual([
			{ type: "corrects", target: target.id },
			...[left.id, right.id].sort().map((branch) => ({ type: "supersedes", target: branch })),
		]);
		expect(readFileSync(target.path, "utf-8").split("\n")[0]).toBe(bytes);
		expect(
			projectRelations(
				scanJournal(path).records.map((item) => item.record),
				ids.member,
			).conflicts,
		).toEqual([]);
	});

	it("writes nothing for a missing or non-conflicted target", async () => {
		const path = store();
		const ids = identity();
		const missing = await resolveUserConflict({
			authority: "headless-user",
			target: newEntryId(),
			text: "nothing",
			channel: "cli",
			storePath: path,
			...ids,
		});
		expect(missing.status).toBe("missing");
		const target = await appendAuthorizedJournalRecord(
			{ authority: "headless-user", record: { type: "note", source: "user", channel: "cli", body: "only" } },
			{ storePath: path, ...ids },
		);
		const before = scanJournal(path).records.length;
		expect(
			(
				await resolveUserConflict({
					authority: "headless-user",
					target: target.id,
					text: "nothing",
					channel: "cli",
					storePath: path,
					...ids,
				})
			).status,
		).toBe("not-conflicted");
		expect(scanJournal(path).records).toHaveLength(before);
	});

	it("serialises two same-store resolutions so only one can write", async () => {
		const path = store();
		const ids = identity();
		const target = await appendAuthorizedJournalRecord(
			{ authority: "headless-user", record: { type: "note", source: "user", channel: "cli", body: "old" } },
			{ storePath: path, ...ids },
		);
		for (const text of ["left", "right"]) {
			await appendUserRelation({
				authority: "headless-user",
				target: target.id,
				text,
				relation: "corrects",
				channel: "cli",
				storePath: path,
				...ids,
			});
		}
		const resolve = (text: string) =>
			resolveUserConflict({
				authority: "headless-user",
				target: target.id,
				text,
				channel: "cli",
				storePath: path,
				...ids,
			});
		const outcomes = await Promise.all([resolve("chosen one"), resolve("chosen two")]);
		expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["not-conflicted", "resolved"]);
		expect(scanJournal(path).records).toHaveLength(4);
	});
});
