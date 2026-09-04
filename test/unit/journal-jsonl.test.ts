import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { newEntryId, newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import { appendJournalRecord, journalShardPath, scanJournal } from "../../src/journal/jsonl.ts";
import {
	buildJournalRecord,
	MAX_RECORD_BYTES,
	parseJournalLine,
	serializeJournalRecord,
} from "../../src/journal/record.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

function store(): string {
	const path = mkdtempSync(join(tmpdir(), "muninn-jsonl-"));
	roots.push(path);
	return path;
}

function identity() {
	return { project: newProjectId(), member: newMemberId(), host: newHostId() };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("journal record schema", () => {
	it("serializes one canonical golden line and round-trips", () => {
		const ids = identity();
		const record = buildJournalRecord(
			{
				type: "outcome",
				source: "agent",
				channel: "tui",
				status: "completed",
				body: "Phase 3 JSONL is implemented.",
				cue: "when inspecting the journal",
				tags: ["phase-3", "phase-3"],
				paths: ["./src/journal/record.ts", "src/journal/record.ts"],
				relations: [],
			},
			{ ...ids, id: "j-019c0123-7f2a-7a10-9c44-2d6e0f1a8b01", now: new Date("2026-08-30T11:32:04.000Z") },
		);
		const line = serializeJournalRecord(record);
		expect(line).toBe(
			`${JSON.stringify({
				schema: 1,
				id: "j-019c0123-7f2a-7a10-9c44-2d6e0f1a8b01",
				at: "2026-08-30T11:32:04.000Z",
				type: "outcome",
				project: ids.project,
				member: ids.member,
				host: ids.host,
				source: "agent",
				channel: "tui",
				status: "completed",
				body: "Phase 3 JSONL is implemented.",
				cue: "when inspecting the journal",
				tags: ["phase-3"],
				paths: ["src/journal/record.ts"],
				relations: [],
			})}\n`,
		);
		expect(parseJournalLine(line.trimEnd()).record).toEqual(record);
	});

	it("round-trips varied optional fields and exposes unknown fields separately", () => {
		for (let index = 0; index < 20; index++) {
			const record = buildJournalRecord(
				{
					type: index % 2 ? "checkpoint" : "note",
					source: index % 3 ? "agent" : "user",
					channel: "cli",
					body: `body ${index}\nline two`,
					tags: [`tag-${index}`, "shared"],
					paths: [`src/${index}.ts`],
					session: { file: `/sessions/${index}.jsonl`, first: `e-${index}` },
				},
				identity(),
			);
			expect(parseJournalLine(serializeJournalRecord(record).trimEnd()).record).toEqual(record);
		}
		const base = buildJournalRecord({ type: "note", source: "agent", channel: "sdk", body: "known" }, identity());
		const parsed = parseJournalLine(JSON.stringify({ ...base, future: { score: 3 } }));
		expect(parsed.extensions).toEqual({ future: { score: 3 } });
		expect(parsed.record).toEqual(base);
	});

	it("redacts before serialization and enforces the 64 KiB line limit", () => {
		const record = buildJournalRecord(
			{ type: "note", source: "user", channel: "cli", body: "token sk-abcdefghijklmnopqrstuvwxyz123456" },
			identity(),
		);
		expect(record.redacted).toBe(true);
		expect(record.body).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
		expect(() =>
			serializeJournalRecord(
				buildJournalRecord(
					{ type: "note", source: "agent", channel: "sdk", body: "x".repeat(MAX_RECORD_BYTES) },
					identity(),
				),
			),
		).toThrow(/maximum/);
	});

	it("validates, canonically serializes, and redacts integration provenance", () => {
		const record = buildJournalRecord(
			{
				type: "checkpoint",
				source: "external",
				channel: "hook",
				body: "Sandbox checkpoint",
				integration: {
					provider: "pi-enclave",
					kind: "sandbox-audit",
					event: "audit-checkpoint",
					external_id: "session-7:42",
					observed_at: "2026-09-04T12:00:00.000Z",
					metadata: { records: 42, safe: true, credential: "token=abcdefghijklmnopqrstuvwxyz123456" },
				},
			},
			identity(),
		);
		expect(record.integration).toMatchObject({
			provider: "pi-enclave",
			kind: "sandbox-audit",
			event: "audit-checkpoint",
			external_id: "session-7:42",
		});
		expect(record.integration?.metadata.credential).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
		expect(record.redacted).toBe(true);
		expect(parseJournalLine(serializeJournalRecord(record).trimEnd()).record).toEqual(record);
		expect(() =>
			buildJournalRecord(
				{
					type: "note",
					source: "external",
					channel: "hook",
					body: "bad",
					integration: {
						provider: "Not Valid",
						kind: "event",
						event: "seen",
						external_id: "1",
						observed_at: "2026-09-04T12:00:00.000Z",
						metadata: {},
					},
				},
				identity(),
			),
		).toThrow(/integration identifier/);
	});
});

describe("JSONL append and scan", () => {
	it("selects UTC monthly member/host shards and rolls over", async () => {
		const path = store();
		const ids = identity();
		const august = new Date("2026-08-31T23:59:59.999Z");
		const september = new Date("2026-09-01T00:00:00.000Z");
		await appendJournalRecord(
			{ type: "note", source: "agent", channel: "sdk", body: "August" },
			{ storePath: path, ...ids, now: august },
		);
		await appendJournalRecord(
			{ type: "note", source: "agent", channel: "sdk", body: "September" },
			{ storePath: path, ...ids, now: september },
		);
		expect(journalShardPath(path, ids.member, ids.host, august)).toContain("2026-08.jsonl");
		expect(scanJournal(path).records.map((item) => item.record.body)).toEqual(["August", "September"]);
	});

	it("skips malformed middle lines and an unterminated final line", () => {
		const path = store();
		const ids = identity();
		const shard = journalShardPath(path, ids.member, ids.host, new Date("2026-08-01T00:00:00.000Z"));
		mkdirSync(dirname(shard), { recursive: true });
		const first = serializeJournalRecord(
			buildJournalRecord(
				{ type: "note", source: "agent", channel: "sdk", body: "first" },
				{ ...ids, now: new Date("2026-08-01T00:00:00.000Z") },
			),
		);
		writeFileSync(shard, `${first}{bad json}\n{"schema":1`);
		const scan = scanJournal(path);
		expect(scan.records.map((item) => item.record.body)).toEqual(["first"]);
		expect(scan.problems.map((problem) => problem.kind)).toEqual(["malformed", "truncated"]);
	});

	it("preserves an interrupted tail and makes the following record visible", async () => {
		const path = store();
		const ids = identity();
		const now = new Date("2026-08-10T00:00:00.000Z");
		const shard = journalShardPath(path, ids.member, ids.host, now);
		mkdirSync(dirname(shard), { recursive: true });
		writeFileSync(shard, '{"schema":1');
		await appendJournalRecord(
			{ type: "note", source: "agent", channel: "sdk", body: "survived" },
			{ storePath: path, ...ids, now },
		);
		const scan = scanJournal(path);
		expect(scan.records.map((item) => item.record.body)).toEqual(["survived"]);
		expect(scan.problems[0]?.kind).toBe("malformed");
	});

	it("reports non-identical duplicate IDs and keeps the first canonical record", () => {
		const path = store();
		const ids = identity();
		const id = newEntryId();
		const one = buildJournalRecord({ type: "note", source: "agent", channel: "sdk", body: "one" }, { ...ids, id });
		const otherHost = newHostId();
		const two = buildJournalRecord(
			{ type: "note", source: "agent", channel: "sdk", body: "two" },
			{ ...ids, host: otherHost, id },
		);
		for (const [host, record] of [
			[ids.host, one],
			[otherHost, two],
		] as const) {
			const shard = journalShardPath(path, ids.member, host, new Date());
			mkdirSync(dirname(shard), { recursive: true });
			writeFileSync(shard, serializeJournalRecord(record));
		}
		const scan = scanJournal(path);
		expect(scan.records).toHaveLength(1);
		expect(scan.problems).toEqual([expect.objectContaining({ kind: "collision" })]);
	});

	it("serializes simultaneous processes writing one host shard", async () => {
		const path = store();
		const ids = identity();
		const worker = fileURLToPath(new URL("../fixtures/jsonl-append-worker.ts", import.meta.url));
		const run = (label: string) =>
			execFileAsync(process.execPath, [worker, path, ids.project, ids.member, ids.host, label, "10"], {
				env: process.env,
				maxBuffer: 1024 * 1024,
			});
		const outputs = await Promise.all([run("left"), run("right")]);
		const expected = outputs.flatMap(({ stdout }) => JSON.parse(stdout) as string[]);
		const scan = scanJournal(path);
		expect(scan.problems).toEqual([]);
		expect(scan.records).toHaveLength(20);
		expect(new Set(scan.records.map((item) => item.record.id))).toEqual(new Set(expected));
		const shard = journalShardPath(path, ids.member, ids.host, new Date());
		expect(readFileSync(shard, "utf-8").endsWith("\n")).toBe(true);
	});
});
