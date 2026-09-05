import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import { openJournalFile } from "../../src/journal/files.ts";
import { appendJournalRecord, journalShardPath, scanJournal } from "../../src/journal/jsonl.ts";
import { buildJournalRecord, serializeJournalRecord } from "../../src/journal/record.ts";
import { ensureStore } from "../../src/store/init.ts";

let root: string;
let store: string;
const identity = { project: newProjectId(), member: newMemberId(), host: newHostId() };
const now = new Date("2026-09-05T12:00:00.000Z");
const input = { type: "note", source: "user", channel: "cli", body: "owned journal data" } as const;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "muninn-journal-files-"));
	store = join(root, "store");
	mkdirSync(store);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function append() {
	return appendJournalRecord(input, { ...identity, storePath: store, now });
}

describe("journal filesystem boundary", () => {
	it.each(["missing", "empty", "valid"])("rejects a shard symlink to a %s external file", async (targetState) => {
		const target = join(root, "outside.jsonl");
		const before =
			targetState === "valid" ? serializeJournalRecord(buildJournalRecord(input, { ...identity, now })) : "";
		if (targetState !== "missing") writeFileSync(target, before);
		const shard = journalShardPath(store, identity.member, identity.host, now);
		mkdirSync(dirname(shard), { recursive: true });
		symlinkSync(target, shard);

		expect(scanJournal(store)).toMatchObject({ records: [], problems: [{ kind: "unsafe-path", path: shard }] });
		await expect(append()).rejects.toThrow(/unsafe journal path/);
		// The open itself must reject a link even without an earlier directory scan.
		expect(() => openJournalFile(shard, true)).toThrow(/unsafe journal path/);
		if (targetState === "missing") expect(existsSync(target)).toBe(false);
		else expect(readFileSync(target, "utf-8")).toBe(before);
	});

	it.each([
		"journal",
		"member",
		"host",
	])("rejects a linked %s directory before append or initialization creates descendants", async (level) => {
		const components = ["journal", identity.member, identity.host];
		const depth = ["journal", "member", "host"].indexOf(level) + 1;
		const linked = join(store, ...components.slice(0, depth));
		const outside = join(root, "outside");
		mkdirSync(outside);
		mkdirSync(dirname(linked), { recursive: true });
		symlinkSync(outside, linked, "dir");

		expect(scanJournal(store)).toMatchObject({ records: [], problems: [{ kind: "unsafe-path", path: linked }] });
		await expect(append()).rejects.toThrow(/unsafe journal path/);
		await expect(
			ensureStore(store, {
				host: { id: identity.host, name: "host", createdAt: now.toISOString() },
				project: {
					id: identity.project,
					name: "project",
					member: { id: identity.member, name: "member", createdAt: now.toISOString() },
				},
			}),
		).rejects.toThrow(/unsafe journal path/);
		expect(readdirSync(outside)).toEqual([]);
	});

	it.each([false, true])("rejects a FIFO shard without blocking (linked=%s)", async (linked) => {
		const shard = journalShardPath(store, identity.member, identity.host, now);
		mkdirSync(dirname(shard), { recursive: true });
		const fifo = linked ? join(root, "outside.fifo") : shard;
		execFileSync("mkfifo", [fifo]);
		if (linked) symlinkSync(fifo, shard);
		expect(scanJournal(store).problems[0]?.kind).toBe("unsafe-path");
		await expect(append()).rejects.toThrow(/unsafe journal path/);
		expect(() => openJournalFile(shard, true)).toThrow(/unsafe journal path/);
	});

	it("rejects links to another shard inside the same store", async () => {
		const original = await append();
		const before = readFileSync(original.path);
		const next = journalShardPath(store, identity.member, identity.host, new Date("2026-10-01"));
		symlinkSync(original.path, next);
		await expect(
			appendJournalRecord(input, { ...identity, storePath: store, now: new Date("2026-10-01") }),
		).rejects.toThrow(/unsafe journal path/);
		expect(readFileSync(original.path)).toEqual(before);
	});

	it("preserves store-root aliases, ordinary append, and interrupted-tail recovery", async () => {
		const actual = store;
		store = join(root, "alias");
		symlinkSync(actual, store, "dir");
		const first = await append();
		writeFileSync(first.path, '{"interrupted":');
		await append();
		const scan = scanJournal(actual);
		expect(scan.records.map((item) => item.record.body)).toEqual([input.body]);
		expect(scan.problems.map((problem) => problem.kind)).toEqual(["malformed"]);
		expect(readFileSync(first.path, "utf-8")).toMatch(/^\{"interrupted":\n/);
	});
});
