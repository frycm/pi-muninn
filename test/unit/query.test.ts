import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import { appendJournalRecord } from "../../src/journal/jsonl.ts";
import { type JournalQuery, JournalQueryError, JournalQueryService } from "../../src/journal/query.ts";
import { journalIndexPath } from "../../src/journal/query-index.ts";
import type { JournalRecord, NewJournalRecord } from "../../src/journal/record.ts";

let store: string;
let project: string;
let localMember: string;
let localHost: string;
let teammateMember: string;
let teammateHost: string;
let records: JournalRecord[];

afterEach(() => rmSync(store, { recursive: true, force: true }));

async function append(
	input: NewJournalRecord,
	now: string,
	actor: "local" | "teammate" = "local",
): Promise<JournalRecord> {
	const result = await appendJournalRecord(input, {
		storePath: store,
		project,
		member: actor === "local" ? localMember : teammateMember,
		host: actor === "local" ? localHost : teammateHost,
		now: new Date(now),
	});
	return result.record;
}

beforeEach(async () => {
	store = mkdtempSync(join(tmpdir(), "muninn-query-"));
	project = newProjectId();
	localMember = newMemberId();
	localHost = newHostId();
	teammateMember = newMemberId();
	teammateHost = newHostId();
	const database = await append(
		{
			type: "outcome",
			source: "agent",
			channel: "tui",
			status: "completed",
			body: "Completed the PostgreSQL 16 database migration.",
			cue: "when the database schema changes",
			tags: ["database", "release"],
			paths: ["src/db/migrate.ts"],
			git: {
				worktree: "/work/project",
				cwd: "/work/project",
				branch: "main",
				head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				dirty: false,
			},
		},
		"2026-08-01T10:00:00.000Z",
	);
	const ci = await append(
		{
			type: "note",
			source: "user",
			channel: "cli",
			body: "CI must run pnpm test with watch mode disabled.",
			cue: "when vitest hangs",
			tags: ["ci"],
			paths: [".github/workflows/ci.yml"],
			git: {
				worktree: "/work/project",
				cwd: "/work/project",
				branch: "feature/ci",
				head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
				dirty: true,
			},
		},
		"2026-08-02T10:00:00.000Z",
	);
	const deploy = await append(
		{
			type: "checkpoint",
			source: "external",
			channel: "rpc",
			status: "partial",
			body: "Production deploy uses a canary rollout.",
			tags: ["ops"],
			paths: ["deploy/canary.yaml"],
		},
		"2026-08-03T10:00:00.000Z",
		"teammate",
	);
	const correction = await append(
		{
			type: "correction",
			source: "user",
			channel: "cli",
			body: "The primary service has moved to version 17.",
			relations: [{ type: "corrects", target: database.id }],
		},
		"2026-08-04T10:00:00.000Z",
	);
	const competing = await append(
		{
			type: "correction",
			source: "user",
			channel: "cli",
			body: "The legacy service has not moved yet.",
			relations: [{ type: "corrects", target: database.id }],
		},
		"2026-08-05T10:00:00.000Z",
		"teammate",
	);
	records = [database, ci, deploy, correction, competing];
});

function service(
	mode: "scan" | "index" = "scan",
	options: { maxChars?: number; transcriptRoots?: string[] } = {},
): JournalQueryService {
	return new JournalQueryService({
		storePath: store,
		localMember,
		mode,
		currentGit: {
			branch: "main",
			head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			paths: ["src/db/migrate.ts"],
		},
		...options,
	});
}

function ids(result: ReturnType<JournalQueryService["query"]>): string[] {
	return result.records.map((record) => record.id);
}

describe("canonical journal query", () => {
	it("exposes a bounded conflict inbox with target, trust, and lifecycle-aware branch summaries", () => {
		const inbox = service().conflictInbox();
		expect(inbox.conflicts).toHaveLength(1);
		expect(inbox.conflicts[0]?.target).toBe(records[0]?.id);
		expect(inbox.conflicts[0]?.target_record.snippet).toContain("PostgreSQL 16");
		expect(inbox.conflicts[0]?.branches.map((branch) => branch.trust).sort()).toEqual(["local-user", "teammate-user"]);
		expect(inbox.conflicts[0]?.branches.every((branch) => branch.labels.includes("conflict"))).toBe(true);
		const bounded = service("scan", { maxChars: 1024 }).conflictInbox();
		expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(1024);
		expect(bounded.truncated).toBe(true);
	});

	it("ranks an exact ID first, then its explicit corrections", () => {
		const result = service().query({ query: records[0]?.id as string });
		expect(ids(result)[0]).toBe(records[0]?.id);
		expect(new Set(ids(result).slice(1))).toEqual(new Set([records[3]?.id, records[4]?.id]));
		expect(result.conflicts).toEqual([{ target: records[0]?.id, records: [records[3]?.id, records[4]?.id].sort() }]);
	});

	it("weights phrase, cue, path and tag matches deterministically", () => {
		const query = service();
		expect(ids(query.query({ query: "PostgreSQL 16 database migration" }))).toContain(records[0]?.id as string);
		expect(ids(query.query({ query: "vitest hangs" }))[0]).toBe(records[1]?.id);
		expect(ids(query.query({ query: "migrate.ts" }))).toContain(records[0]?.id as string);
		expect(ids(query.query({ query: "ops" }))).toEqual([records[2]?.id]);
	});

	it("applies actor, status, date, Git, path and relation filters with empty text", () => {
		const query = service();
		expect(ids(query.query({ source: ["external"] }))).toEqual([records[2]?.id]);
		expect(ids(query.query({ member: [teammateMember], type: ["checkpoint"] }))).toEqual([records[2]?.id]);
		expect(ids(query.query({ host: [localHost], status: ["completed"] }))).toEqual([records[0]?.id]);
		expect(ids(query.query({ branch: ["feature/ci"] }))).toEqual([records[1]?.id]);
		expect(ids(query.query({ path: ["src/db"] }))).toEqual([records[0]?.id]);
		expect(ids(query.query({ tag: ["release"] }))).toEqual([records[0]?.id]);
		expect(ids(query.query({ since: "2026-08-03", until: "2026-08-04T23:59:59Z" }))).toEqual([
			records[3]?.id,
			records[2]?.id,
		]);
		expect(new Set(ids(query.query({ relatedTo: records[0]?.id as string })))).toEqual(
			new Set([records[0]?.id, records[3]?.id, records[4]?.id]),
		);
	});

	it("filters projected trust and labels with OR within fields and AND across fields", () => {
		const query = service();
		expect(ids(query.query({ trust: ["teammate-user"], label: ["conflict"] }))).toEqual([records[4]?.id]);
		expect(
			new Set(
				query
					.query({ trust: ["local-agent", "teammate-user"], label: ["conflict", "cycle"] })
					.records.map((record) => record.id),
			),
		).toEqual(new Set([records[0]?.id, records[4]?.id]));
	});

	it("returns bounded, auditable explanations only when requested", () => {
		const hidden = service().query({ query: "vitest hangs" });
		expect(hidden.records[0]?.explanation).toBeUndefined();

		const explained = service().query({ query: "vitest hangs", explain: true });
		const result = explained.records[0];
		expect(result?.id).toBe(records[1]?.id);
		expect(result?.explanation).toMatchObject({
			match: "direct",
			exact_id: false,
			phrases: [{ field: "cue", score: 300 }],
			coverage: { matched: 2, total: 2, score: 0 },
			evidence_truncated: false,
		});
		const components = result?.explanation?.components;
		expect(components && Object.values(components).reduce((sum, value) => sum + value, 0)).toBe(result?.score);

		const byId = service().query({ query: records[0]?.id as string, explain: true });
		expect(byId.records[0]?.explanation).toMatchObject({ match: "direct", exact_id: true });
		for (const correction of byId.records.slice(1)) {
			expect(correction.explanation).toMatchObject({
				match: "relation-expanded",
				expanded_from: records[0]?.id,
				relation_type: "corrects",
				terms: [],
				phrases: [],
			});
		}
	});

	it("paginates stably and rejects a cursor used with another query", () => {
		const query = service();
		const first = query.query({ limit: 2 });
		expect(first.records).toHaveLength(2);
		expect(first.next_cursor).toBeTypeOf("string");
		const second = query.query({ limit: 2, cursor: first.next_cursor as string });
		expect(new Set([...ids(first), ...ids(second)]).size).toBe(4);
		expect(() => query.query({ query: "different", limit: 2, cursor: first.next_cursor as string })).toThrow(
			JournalQueryError,
		);
		const explained = query.query({ query: "database", explain: true, limit: 1 });
		expect(() =>
			query.query({ query: "database", explain: false, limit: 1, cursor: explained.next_cursor as string }),
		).toThrow(JournalQueryError);
	});

	it("bounds summaries and full relation reads", () => {
		const bounded = service("scan", { maxChars: 1024 }).query({ limit: 100 });
		expect(bounded.truncated).toBe(true);
		expect(JSON.stringify(bounded.records).length).toBeLessThanOrEqual(1024);
		const read = service().read(records[0]?.id as string, 1, 2);
		expect(read?.records).toHaveLength(2);
		expect(read?.truncated).toBe(true);
	});

	it("checks transcript availability only inside configured session roots", async () => {
		const sessions = join(store, "sessions");
		mkdirSync(sessions);
		const allowed = join(sessions, "allowed.jsonl");
		const outside = join(store, "outside.jsonl");
		writeFileSync(allowed, "", { flag: "wx" });
		writeFileSync(outside, "", { flag: "wx" });
		const allowedRecord = await append(
			{ type: "note", source: "user", channel: "cli", body: "Allowed transcript.", session: { file: allowed } },
			"2026-08-06T10:00:00.000Z",
		);
		const outsideRecord = await append(
			{ type: "note", source: "user", channel: "cli", body: "Outside transcript.", session: { file: outside } },
			"2026-08-07T10:00:00.000Z",
		);
		const query = service("scan", { transcriptRoots: [sessions] });
		expect(query.read(allowedRecord.id)?.transcripts[0]?.available).toBe(true);
		expect(query.read(outsideRecord.id)?.transcripts[0]?.available).toBe(false);
	});
});

describe("scan/index equivalence", () => {
	it("returns identical filtered IDs for every query fixture", () => {
		const scan = service("scan");
		const indexed = service("index");
		const fixtures: JournalQuery[] = [
			{ query: "database migration" },
			{ query: "vitest hangs", source: ["user"] },
			{ query: "canary", member: [teammateMember] },
			{ tag: ["ci"] },
			{ path: ["deploy"] },
			{ branch: ["main"] },
			{ relatedTo: records[0]?.id as string },
			{ ids: [records[1]?.id as string] },
		];
		for (const fixture of fixtures) expect(ids(indexed.query(fixture))).toEqual(ids(scan.query(fixture)));
	});

	it("rebuilds after index deletion or corruption without changing results", () => {
		const expected = ids(service("scan").query({ query: "database" }));
		const first = service("index");
		expect(existsSync(journalIndexPath(store))).toBe(true);
		rmSync(dirname(journalIndexPath(store)), { recursive: true, force: true });
		expect(ids(service("index").query({ query: "database" }))).toEqual(expected);
		writeFileSync(journalIndexPath(store), "{broken");
		const rebuilt = service("index").query({ query: "database" });
		expect(ids(rebuilt)).toEqual(expected);
		expect(rebuilt.warnings.some((warning) => warning.startsWith("index rebuilt:"))).toBe(true);
		expect(first.size).toBe(5);
	});

	it("updates incrementally after append and reports malformed canonical lines", async () => {
		const indexed = service("index");
		const appended = await append(
			{ type: "note", source: "agent", channel: "sdk", body: "A newly indexed zebra marker." },
			"2026-08-06T10:00:00.000Z",
		);
		indexed.add(appended);
		expect(ids(indexed.query({ query: "zebra" }))).toEqual([appended.id]);
		const shard = join(store, "journal", records[0]?.member as string, records[0]?.host as string, "2026-08.jsonl");
		appendFileSync(shard, "{bad json}\n");
		const result = service("scan").query({ query: "database" });
		expect(result.warnings.some((warning) => warning.startsWith("malformed:"))).toBe(true);
	});
});
