import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newHostId } from "../../src/ids.ts";
import { appendEntry } from "../../src/journal/append.ts";
import { listJournalFiles, readStoreJournal } from "../../src/journal/read.ts";
import {
	emptySupersessions,
	formatSupersession,
	parseSupersessions,
	readSupersessions,
} from "../../src/journal/supersessions.ts";

let store: string;

beforeEach(() => {
	store = mkdtempSync(join(tmpdir(), "muninn-read-"));
});

afterEach(() => {
	rmSync(store, { recursive: true, force: true });
});

function writeDaily(host: string, date: string, body: string): void {
	mkdirSync(join(store, "journal", host), { recursive: true });
	writeFileSync(join(store, "journal", host, `${date}.md`), body);
}

const ID_A = "j-01a02e19-f1c6-7142-bcb1-2806083bd725";
const ID_B = "j-01a02e1b-655b-7317-bf15-3bba2f63f9c1";

describe("listJournalFiles", () => {
	it("finds every daily file, sorted by host then date", () => {
		const hostA = newHostId();
		const hostB = newHostId();
		writeDaily(hostA, "2026-08-22", "");
		writeDaily(hostA, "2026-08-21", "");
		writeDaily(hostB, "2026-08-22", "");

		const files = listJournalFiles(store);
		expect(files).toHaveLength(3);
		expect(files.filter((f) => f.host === hostA).map((f) => f.date)).toEqual(["2026-08-21", "2026-08-22"]);
	});

	it("returns nothing for a store with no journal yet", () => {
		expect(listJournalFiles(store)).toEqual([]);
	});

	it("ignores directories that are not host ids and files that are not daily files", () => {
		// A user may well drop a note in the journal directory; that is not a
		// fault to report on every session start.
		const host = newHostId();
		writeDaily(host, "2026-08-22", "");
		mkdirSync(join(store, "journal", "scratch"), { recursive: true });
		writeFileSync(join(store, "journal", host, "notes.md"), "mine\n");
		writeFileSync(join(store, "journal", host, "2026-8-2.md"), "wrong shape\n");

		expect(listJournalFiles(store).map((f) => f.date)).toEqual(["2026-08-22"]);
	});
});

describe("readStoreJournal", () => {
	it("reads every host's entries and tags them with host and date", async () => {
		const hostA = newHostId();
		const hostB = newHostId();
		await appendEntry({ source: "user", prose: "from a", claims: [] }, { storePath: store, hostId: hostA });
		await appendEntry({ source: "agent", prose: "from b", claims: [] }, { storePath: store, hostId: hostB });

		const read = readStoreJournal(store);
		expect(read.problems).toEqual([]);
		expect(read.entries).toHaveLength(2);
		expect(new Set(read.entries.map((e) => e.host))).toEqual(new Set([hostA, hostB]));
		expect(read.entries.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date))).toBe(true);
	});

	it("keeps reading other files when one is damaged", () => {
		const host = newHostId();
		writeDaily(host, "2026-08-21", `## 10:00 · ${ID_A}\nsource: user\n\nfine\n\n`);
		writeDaily(host, "2026-08-22", `## 10:00 · ${ID_B}\nsource: user\n\nhalf`);

		const read = readStoreJournal(store);
		expect(read.entries.map((e) => e.prose)).toEqual(["fine"]);
		expect(read.problems).toHaveLength(1);
		expect(read.problems[0]?.kind).toBe("truncated");
		expect(read.problems[0]?.path).toContain("2026-08-22.md");
	});

	it("returns nothing for an empty store", () => {
		expect(readStoreJournal(store)).toEqual({ entries: [], problems: [] });
	});
});

describe("supersessions", () => {
	it("treats an absent file as nothing superseded", () => {
		expect(readSupersessions(store)).toEqual(emptySupersessions());
		expect(readSupersessions(store).superseded.size).toBe(0);
	});

	it("parses the documented line shape", () => {
		const line = `- ${ID_A}.1 · valid_to: 2026-08-22 · by: ${ID_B}.1 · fact: f-testing-01a02e19-f1c6-7142-bcb1-2806083bd725`;
		const result = parseSupersessions(line);
		expect(result.problems).toEqual([]);
		expect(result.superseded.has(`${ID_A}.1`)).toBe(true);
		expect(result.byClaim.get(`${ID_A}.1`)).toEqual({
			claim: `${ID_A}.1`,
			validTo: "2026-08-22",
			by: `${ID_B}.1`,
			fact: "f-testing-01a02e19-f1c6-7142-bcb1-2806083bd725",
		});
	});

	it("keys on a claim, never a whole entry", () => {
		// One outcome entry routinely supports several independent facts;
		// superseding one of them must not hide the others.
		const result = parseSupersessions(`- ${ID_A}.1 · valid_to: 2026-08-22`);
		expect(result.superseded.has(`${ID_A}.1`)).toBe(true);
		expect(result.superseded.has(`${ID_A}.2`)).toBe(false);
		expect(result.superseded.has(ID_A)).toBe(false);
	});

	it("reports a line whose key is not a claim id", () => {
		const result = parseSupersessions(`- ${ID_A} · valid_to: 2026-08-22`);
		expect(result.superseded.size).toBe(0);
		expect(result.problems).toHaveLength(1);
	});

	it("ignores headings and blank lines", () => {
		const result = parseSupersessions(`# Supersessions\n\n- ${ID_A}.1 · valid_to: 2026-08-22\n\n`);
		expect(result.superseded.size).toBe(1);
		expect(result.problems).toEqual([]);
	});

	it("round-trips a line it formatted", () => {
		const entry = {
			claim: `${ID_A}.2`,
			validTo: "2026-08-22",
			by: `${ID_B}.1`,
			fact: "f-testing-01a02e19-f1c6-7142-bcb1-2806083bd725",
		};
		const parsed = parseSupersessions(formatSupersession(entry));
		expect(parsed.byClaim.get(entry.claim)).toEqual(entry);
	});
});
