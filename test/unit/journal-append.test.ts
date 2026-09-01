import { execFile } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newHostId } from "../../src/ids.ts";
import { appendEntry, dailyFilePath } from "../../src/journal/append.ts";
import { parseDailyFile, readDailyFile } from "../../src/journal/read.ts";

const execFileAsync = promisify(execFile);
const WORKER = fileURLToPath(new URL("../fixtures/append-worker.ts", import.meta.url));

let store: string;
let host: string;

beforeEach(() => {
	store = mkdtempSync(join(tmpdir(), "muninn-journal-"));
	host = newHostId();
});

afterEach(() => {
	rmSync(store, { recursive: true, force: true });
});

describe("appendEntry", () => {
	it("writes an entry that reads back identically", async () => {
		const result = await appendEntry(
			{ source: "user", channel: "tui", phase: "test", cue: "when vitest hangs", prose: "context", claims: ["a", "b"] },
			{ storePath: store, hostId: host },
		);

		const read = readDailyFile(result.path);
		expect(read.problems).toEqual([]);
		expect(read.entries).toHaveLength(1);
		expect(read.entries[0]?.id).toBe(result.id);
		expect(read.entries[0]?.claims).toEqual(["a", "b"]);
		expect(read.entries[0]?.cue).toBe("when vitest hangs");
	});

	it("returns the addresses of the claims it wrote", async () => {
		const result = await appendEntry(
			{ source: "user", prose: "", claims: ["one", "two"] },
			{ storePath: store, hostId: host },
		);
		expect(result.claimIds).toEqual([`${result.id}.1`, `${result.id}.2`]);
	});

	it("files entries by host and local day", async () => {
		const day = new Date(2026, 7, 22, 14, 32);
		const result = await appendEntry(
			{ source: "user", prose: "x", claims: [] },
			{ storePath: store, hostId: host, now: day },
		);
		expect(result.path).toBe(dailyFilePath(store, host, day));
		expect(result.path).toContain(join("journal", host, "2026-08-22.md"));
		expect(readFileSync(result.path, "utf-8")).toContain("## 14:32 · ");
	});

	it("keeps several entries of one day in one file, in write order", async () => {
		const day = new Date(2026, 7, 22, 9, 0);
		const first = await appendEntry(
			{ source: "user", prose: "1", claims: [] },
			{ storePath: store, hostId: host, now: day },
		);
		const second = await appendEntry(
			{ source: "user", prose: "2", claims: [] },
			{ storePath: store, hostId: host, now: day },
		);

		const read = readDailyFile(first.path);
		expect(read.problems).toEqual([]);
		expect(read.entries.map((e) => e.id)).toEqual([first.id, second.id]);
	});

	it("separates two hosts into two directories", async () => {
		const other = newHostId();
		const mine = await appendEntry({ source: "user", prose: "mine", claims: [] }, { storePath: store, hostId: host });
		const theirs = await appendEntry(
			{ source: "user", prose: "theirs", claims: [] },
			{ storePath: store, hostId: other },
		);
		expect(mine.path).not.toBe(theirs.path);
		expect(readDailyFile(mine.path).entries).toHaveLength(1);
		expect(readDailyFile(theirs.path).entries).toHaveLength(1);
	});

	it("starts on a fresh line after a crash left the file mid-entry", async () => {
		// The damaged entry stays; the next one must still be readable rather
		// than being glued onto the end of the broken one.
		const path = dailyFilePath(store, host, new Date());
		await appendEntry({ source: "user", prose: "good", claims: [] }, { storePath: store, hostId: host });
		appendFileSync(path, "## 15:00 · j-truncated-half-written");

		const result = await appendEntry(
			{ source: "user", prose: "after", claims: [] },
			{ storePath: store, hostId: host },
		);
		const text = readFileSync(path, "utf-8");
		expect(text).toContain("j-truncated-half-written\n## ");

		const read = readDailyFile(path);
		expect(read.entries.map((e) => e.prose)).toEqual(["good", "after"]);
		expect(read.problems.map((p) => p.kind)).toEqual(["unreadable-entry"]);
		expect(result.id).toBeDefined();
	});
});

describe("journal concurrency", () => {
	it("survives 8 processes writing 50 entries each to one daily file", async () => {
		// The acceptance test for step 3: every entry well-formed, none lost,
		// none interleaved, and each writer's own entries in the order it wrote
		// them.
		const writers = 8;
		const perWriter = 50;

		const results = await Promise.all(
			Array.from({ length: writers }, (_, index) =>
				execFileAsync(process.execPath, [
					"--experimental-strip-types",
					WORKER,
					store,
					host,
					String(index),
					String(perWriter),
				]),
			),
		);

		const idsByWriter = results.map((result) => JSON.parse(result.stdout) as string[]);
		expect(idsByWriter.every((ids) => ids.length === perWriter)).toBe(true);

		const path = dailyFilePath(store, host, new Date());
		const read = readDailyFile(path);

		expect(read.problems).toEqual([]);
		expect(read.entries).toHaveLength(writers * perWriter);

		// Nothing was lost or duplicated.
		const written = new Set(idsByWriter.flat());
		const found = new Set(read.entries.map((entry) => entry.id));
		expect(found).toEqual(written);

		// Every entry is intact: appends never interleaved mid-block.
		for (const entry of read.entries) {
			expect(entry.source).toBe("agent");
			expect(entry.claims).toHaveLength(1);
			expect(entry.claims[0]).toMatch(/^claim \d+ from writer \d$/);
			expect(entry.prose).toMatch(/^writer \d entry \d+$/);
		}

		// Each writer's entries appear in the file in the order it wrote them.
		for (const ids of idsByWriter) {
			const positions = ids.map((id) => read.entries.findIndex((entry) => entry.id === id));
			expect(positions).toEqual([...positions].sort((a, b) => a - b));
		}
	}, 60_000);
});

describe("truncated files", () => {
	it("reports exactly one truncated entry and keeps everything before it", async () => {
		await appendEntry({ source: "user", prose: "first", claims: [] }, { storePath: store, hostId: host });
		const second = await appendEntry(
			{ source: "user", prose: "second", claims: [] },
			{ storePath: store, hostId: host },
		);

		// Simulate a crash partway through a third append.
		const text = readFileSync(second.path, "utf-8");
		writeFileSync(second.path, `${text}## 16:00 · j-01a02e19-f1c6-7142-bcb1-2806083bd725\nsource: us`);

		const read = readDailyFile(second.path);
		expect(read.entries.map((e) => e.prose)).toEqual(["first", "second"]);
		expect(read.problems).toHaveLength(1);
		expect(read.problems[0]?.kind).toBe("truncated");
		expect(read.problems[0]?.message).toContain("never finished");
	});

	it("does not call a well-terminated last entry truncated", () => {
		const id = "j-01a02e19-f1c6-7142-bcb1-2806083bd725";
		const read = parseDailyFile(`## 10:00 · ${id}\nsource: user\n\nbody\n\n`);
		expect(read.problems).toEqual([]);
		expect(read.entries).toHaveLength(1);
	});

	it("returns nothing for an empty file, without complaint", () => {
		expect(parseDailyFile("")).toEqual({ entries: [], problems: [] });
	});

	it("reports a file with no headings at all", () => {
		const read = parseDailyFile("just some text nobody meant to put here\n");
		expect(read.problems[0]?.kind).toBe("unreadable-file");
	});
});

describe("appended entries are scrubbed", () => {
	it("never writes a secret to disk and marks the entry redacted", async () => {
		// Redaction lives inside appendEntry precisely so no caller can forget
		// it: the journal is append-only and syncs, so a secret that lands here
		// is in history on every machine that pulls.
		const result = await appendEntry(
			{
				source: "user",
				prose: "Deploy failed until I exported AKIAIOSFODNN7EXAMPLE.",
				claims: ["The CI job needs api_key: deadbeefcafebabe0123456789abcdef to talk to the registry."],
			},
			{ storePath: store, hostId: host },
		);

		const text = readFileSync(result.path, "utf-8");
		expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(text).not.toContain("deadbeefcafebabe");
		expect(text).toContain("[redacted: aws-access-key]");
		expect(text).toContain("redacted: true");

		const read = readDailyFile(result.path);
		expect(read.entries[0]?.redacted).toBe(true);
	});

	it("scrubs the cue as well as prose and claims", async () => {
		const result = await appendEntry(
			{ source: "user", cue: "when ghp_1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ12 expires", prose: "", claims: ["x"] },
			{ storePath: store, hostId: host },
		);
		expect(readFileSync(result.path, "utf-8")).not.toContain("ghp_1a2B3c");
	});

	it("leaves identifiers intact so pointers keep resolving", async () => {
		// A redacted id is a broken pointer, so task and session identifiers are
		// never scrubbed.
		const task = "0198f2b0-1111-7000-8000-000000000001";
		const session = "~/.pi/agent/sessions/--x--/y.jsonl#e5f6";
		const result = await appendEntry(
			{
				source: "user",
				task,
				session,
				prose: "ok",
				claims: [],
			},
			{ storePath: store, hostId: host },
		);

		const read = readDailyFile(result.path);
		expect(read.entries[0]?.task).toBe(task);
		expect(read.entries[0]?.session).toBe(session);
		expect(read.entries[0]?.redacted).toBeUndefined();
	});

	it("does not mark a clean entry as redacted", async () => {
		const result = await appendEntry(
			{ source: "user", prose: "Run `pnpm test --run`.", claims: [] },
			{ storePath: store, hostId: host },
		);
		expect(readDailyFile(result.path).entries[0]?.redacted).toBeUndefined();
	});
});
