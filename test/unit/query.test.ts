import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
			integration: {
				provider: "pi-huginn",
				kind: "remote-session",
				event: "completed",
				external_id: "deploy-42",
				observed_at: "2026-08-03T10:00:00.000Z",
				metadata: { revision: 4 },
			},
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

	it("ranks exact, prefix, and conservative one-edit token matches in that order", async () => {
		const at = "2026-08-06T10:00:00.000Z";
		const exact = await append({ type: "note", source: "agent", channel: "sdk", body: "deploy marker" }, at);
		const prefix = await append({ type: "note", source: "agent", channel: "sdk", body: "deployment marker" }, at);
		const fuzzy = await append({ type: "note", source: "agent", channel: "sdk", body: "deplox marker" }, at);
		const result = service().query({ query: "deploy", explain: true });
		const selected = result.records.filter((record) => [exact.id, prefix.id, fuzzy.id].includes(record.id));
		expect(selected.map((record) => record.id)).toEqual([exact.id, prefix.id, fuzzy.id]);
		expect(selected.map((record) => record.explanation?.terms.find((term) => term.field === "body")?.kind)).toEqual([
			"exact",
			"prefix",
			"fuzzy",
		]);
		expect(service().query({ query: "opx" }).records).toEqual([]);
	});

	it("rewards query-term coverage and handles Unicode typos by code point", async () => {
		const partial = await append(
			{ type: "note", source: "agent", channel: "sdk", body: "alpha appears alone" },
			"2026-08-06T10:00:00.000Z",
		);
		const complete = await append(
			{ type: "note", source: "agent", channel: "sdk", body: "alpha separates beta markers" },
			"2026-08-06T10:00:00.000Z",
		);
		const unicode = await append(
			{ type: "note", source: "agent", channel: "sdk", body: "Résumé deployment checklist." },
			"2026-08-06T10:00:00.000Z",
		);
		const covered = service().query({ query: "alpha beta", explain: true }).records;
		expect(covered.map((record) => record.id)).toEqual([complete.id, partial.id]);
		expect(covered.map((record) => record.explanation?.coverage)).toEqual([
			{ matched: 2, total: 2, score: 50 },
			{ matched: 1, total: 2, score: 25 },
		]);
		const unicodeResult = service().query({ query: "resumé", explain: true }).records[0];
		expect(unicodeResult?.id).toBe(unicode.id);
		expect(unicodeResult?.explanation?.terms[0]).toMatchObject({
			term: "resumé",
			matched: "résumé",
			kind: "fuzzy",
		});
		const canonicallyEquivalent = service().query({ query: "re\u0301sume\u0301", explain: true }).records[0];
		expect(canonicallyEquivalent?.id).toBe(unicode.id);
		expect(canonicallyEquivalent?.explanation?.terms[0]?.kind).toBe("exact");
	});

	it("expands corrections for fuzzy targets without inventing lexical evidence", () => {
		const result = service().query({ query: "databaze", explain: true });
		expect(result.records.find((record) => record.id === records[0]?.id)?.explanation?.match).toBe("direct");
		for (const correction of result.records.filter((record) => [records[3]?.id, records[4]?.id].includes(record.id))) {
			expect(correction.explanation).toMatchObject({
				match: "relation-expanded",
				expanded_from: records[0]?.id,
				terms: [],
				phrases: [],
			});
		}
	});

	it("applies actor, status, date, Git, path and relation filters with empty text", () => {
		const query = service();
		expect(ids(query.query({ source: ["external"] }))).toEqual([records[2]?.id]);
		expect(ids(query.query({ integration: ["pi-huginn"] }))).toEqual([records[2]?.id]);
		expect(query.query({ integration: ["pi-huginn"] }).records[0]?.integration).toEqual({
			provider: "pi-huginn",
			kind: "remote-session",
			event: "completed",
		});
		expect(query.query({ integration: ["pi-enclave"] }).records).toEqual([]);
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
			coverage: { matched: 2, total: 2, score: 50 },
			evidence_truncated: false,
		});
		const components = result?.explanation?.components;
		expect(components && Object.values(components).reduce((sum, value) => sum + value, 0)).toBe(result?.score);
		const lexicalEvidence = [...(result?.explanation?.phrases ?? []), ...(result?.explanation?.terms ?? [])].reduce(
			(sum, evidence) => sum + evidence.score,
			result?.explanation?.coverage.score ?? 0,
		);
		expect(lexicalEvidence).toBe(components?.lexical);

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
		expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(1024);
		const read = service().read(records[0]?.id as string, 1, 2);
		expect(read?.records).toHaveLength(2);
		expect(read?.truncated).toBe(true);
	});

	it("bounds hostile query shapes and explanation evidence", async () => {
		const terms = Array.from({ length: 40 }, (_, index) => `evidence-${index}`);
		const written = await append(
			{ type: "note", source: "agent", channel: "sdk", body: `${terms.join(" ")} unrelated-private-marker` },
			"2026-08-06T10:00:00.000Z",
		);
		const explained = service().query({ query: terms[0] as string, ids: [written.id], explain: true }).records[0];
		expect(JSON.stringify(explained?.explanation)).not.toContain("unrelated-private-marker");
		const bounded = service("scan", { maxChars: 1024 }).query({ query: terms.join(" "), explain: true });
		expect(bounded.truncated).toBe(true);
		expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(1024);
		expect(bounded.next_cursor).toBeUndefined();

		const query = service();
		expect(() => query.query({ query: Array.from({ length: 65 }, (_, index) => `term-${index}`).join(" ") })).toThrow(
			/64 distinct terms/,
		);
		expect(() => query.query({ tag: Array.from({ length: 51 }, (_, index) => `tag-${index}`) })).toThrow(/1 to 50/);
		expect(() => query.query({ cursor: "x".repeat(4097) })).toThrow(/cursor/);
		expect(() => query.query({ surprise: true } as unknown as JournalQuery)).toThrow(/unsupported field/);
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
	it("returns identical records, scores, and explanations for every query fixture", () => {
		const scan = service("scan");
		const indexed = service("index");
		const fixtures: JournalQuery[] = [
			{ query: "database migration", explain: true },
			{ query: "databaze", explain: true },
			{ query: "vitest hangs", source: ["user"], explain: true },
			{ query: "canry", member: [teammateMember], explain: true },
			{ query: "ary", explain: true },
			{ tag: ["ci"] },
			{ path: ["deploy"] },
			{ branch: ["main"] },
			{ relatedTo: records[0]?.id as string },
			{ ids: [records[1]?.id as string] },
		];
		for (const fixture of fixtures) expect(indexed.query(fixture).records).toEqual(scan.query(fixture).records);
	});

	it("upgrades the legacy schema and produces deterministic schema-2 bytes", () => {
		const legacy = join(store, ".index", "journal-v1.json");
		mkdirSync(dirname(legacy), { recursive: true });
		writeFileSync(legacy, '{"schema":1,"records":{}}\n');
		const upgraded = service("index").query({ query: "database" });
		expect(upgraded.warnings).toContain("index rebuilt: legacy index schema");
		expect(existsSync(legacy)).toBe(false);
		const first = readFileSync(journalIndexPath(store), "utf-8");
		expect(JSON.parse(first)).toMatchObject({ schema: 2, analyzer: "unicode-nfkc-lower-v1" });
		new JournalQueryService({
			storePath: store,
			localMember,
			mode: "index",
			forceReindex: true,
		});
		expect(readFileSync(journalIndexPath(store), "utf-8")).toBe(first);
	});

	it("repairs tampered terms from canonical records before querying", () => {
		service("index");
		const path = journalIndexPath(store);
		const persisted = JSON.parse(readFileSync(path, "utf-8")) as {
			records: Record<string, { terms: string[] }>;
		};
		const tampered = persisted.records[records[0]?.id as string];
		expect(tampered).toBeDefined();
		if (!tampered) throw new Error("fixture index record is missing");
		tampered.terms = [records[0]?.id as string, "wrong-term"];
		writeFileSync(path, `${JSON.stringify(persisted)}\n`);
		expect(ids(service("index").query({ query: "database" }))).toContain(records[0]?.id as string);
		expect(readFileSync(path, "utf-8")).toContain('"database"');
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

	it("refreshes index diagnostics when the cache is damaged and then repaired", async () => {
		const indexed = service("index");
		writeFileSync(journalIndexPath(store), "{broken");
		const fresh = await append(
			{ type: "note", source: "user", channel: "cli", body: "fresh after cache corruption" },
			"2026-09-05T10:00:00.000Z",
		);
		const repaired = indexed.query({ ids: [fresh.id] });
		expect(repaired.records[0]?.id).toBe(fresh.id);
		expect(repaired.warnings.some((warning) => warning.startsWith("index rebuilt:"))).toBe(true);
		indexed.refresh();
		expect(indexed.query().warnings.some((warning) => warning.startsWith("index rebuilt:"))).toBe(false);
	});
});

describe("live query snapshots and read budgets", () => {
	it.each([
		"scan",
		"index",
	] as const)("refreshes %s readers after another session appends or replaces a shard", async (mode) => {
		const first = service(mode);
		const second = service(mode);
		const fresh = await append(
			{ type: "note", source: "user", channel: "cli", body: "external-session unique" },
			"2026-09-05T10:00:00.000Z",
		);
		for (const reader of [first, second]) {
			expect(reader.has(fresh.id)).toBe(true);
			expect(reader.query({ query: "external-session" }).records[0]?.id).toBe(fresh.id);
			expect(reader.read(fresh.id)?.records[0]?.body).toBe(fresh.body);
		}
		const path = join(store, "journal", localMember, localHost, "2026-09.jsonl");
		writeFileSync(path, readFileSync(path, "utf-8").replace("external-session", "modified-session"));
		expect(first.query({ query: "modified-session" }).records[0]?.id).toBe(fresh.id);
		rmSync(path);
		expect(second.has(fresh.id)).toBe(false);
	});

	it("bounds full records, relations and warnings without changing signed payloads", async () => {
		const target = records[0] as JournalRecord;
		const largeRecords: JournalRecord[] = [];
		for (let n = 0; n < 5; n++)
			largeRecords.push(
				await append(
					{
						type: "note",
						source: "agent",
						channel: "tui",
						body: "x".repeat(60_000),
						relations: [{ type: "annotates", target: target.id }],
					},
					"2026-09-05T10:00:00.000Z",
				),
			);
		const reader = service("index", { maxChars: 16_000 });
		const read = reader.read(target.id, 1);
		expect(JSON.stringify(read).length).toBeLessThanOrEqual(16_000);
		expect(read?.truncated).toBe(true);
		expect(read?.records[0]?.body).toBe(target.body);
		expect(read?.warnings.join(" ")).toContain("omitted");
		const oversized = largeRecords[0];
		if (!oversized) throw new Error("missing oversized fixture");
		const omitted = reader.read(oversized.id);
		expect(omitted).toMatchObject({ records: [], truncated: true });
		expect(omitted?.warnings.join(" ")).toContain(`muninn show ${oversized.id}`);
		expect(JSON.stringify({ schema: 1, id: oversized.id, ...omitted }).length).toBeLessThanOrEqual(16_000);
	});

	it("does not let returned nested objects mutate a cached snapshot", () => {
		const reader = service();
		const record = reader.read(records[0]?.id as string)?.records[0];
		if (!record) throw new Error("missing fixture");
		record.tags.push("tampered");
		expect(reader.read(record.id)?.records[0]?.tags).not.toContain("tampered");
	});
});
