import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newEntryId, newHostId } from "../../src/ids.ts";
import { StoreIndex } from "../../src/index/build.ts";
import type { JournalEntryWithContext } from "../../src/journal/read.ts";

/**
 * The plan's budget for step 8: a 10 k-entry journal rebuilds in under 3 s, and
 * an incremental append costs under 50 ms.
 *
 * The thresholds are generous against the measured numbers (a laptop builds
 * this corpus in a few hundred milliseconds) because a CI runner under load is
 * not a laptop. They are here to catch an order-of-magnitude regression — a
 * quadratic chunker, a re-read per entry, a full serialise per append — not to
 * measure a machine.
 */
const ENTRIES = 10_000;
const DAYS = 100;
const WORDS =
	"vitest watch mode hangs the CI job because the runner has no TTY docker compose database url staging deploy".split(
		" ",
	);

let store: string;
let host: string;

beforeEach(() => {
	store = mkdtempSync(join(tmpdir(), "muninn-perf-"));
	host = newHostId();
	writeSyntheticJournal();
});

afterEach(() => {
	rmSync(store, { recursive: true, force: true });
});

function writeSyntheticJournal(): void {
	mkdirSync(join(store, "journal", host), { recursive: true });
	const perDay = ENTRIES / DAYS;
	let n = 0;
	for (let day = 0; day < DAYS; day++) {
		const lines: string[] = [];
		for (let i = 0; i < perDay; i++) {
			n++;
			lines.push(
				`## 14:${String(i % 60).padStart(2, "0")} · ${newEntryId()}`,
				"source: user",
				"phase: test",
				`cue: when ${WORDS[n % WORDS.length]} appears`,
				"",
				`Context paragraph ${n} about ${WORDS[(n + 3) % WORDS.length]}.`,
				"",
				`- Claim ${n}: ${WORDS[n % WORDS.length]} ${WORDS[(n + 7) % WORDS.length]} matters here.`,
				`- Second claim ${n} about ${WORDS[(n + 2) % WORDS.length]}.`,
				"",
			);
		}
		const date = `2026-${String(1 + Math.floor(day / 28)).padStart(2, "0")}-${String(1 + (day % 28)).padStart(2, "0")}`;
		writeFileSync(join(store, "journal", host, `${date}.md`), `${lines.join("\n")}\n`);
	}
}

describe(`index performance (${ENTRIES} entries)`, () => {
	it("builds from scratch within the budget", () => {
		const started = Date.now();
		const { index, result } = StoreIndex.open(store);
		const ms = Date.now() - started;

		expect(result.kind).toBe("full");
		expect(index.size).toBe(ENTRIES * 3);
		expect(ms).toBeLessThan(3_000);
	});

	it("adds an appended entry in well under the per-append budget", () => {
		const { index } = StoreIndex.open(store);
		const entry: JournalEntryWithContext = {
			id: newEntryId(),
			time: "15:00",
			source: "user",
			prose: "",
			claims: ["Deploys go through staging first."],
			date: "2026-08-22",
			host,
			path: join(store, "journal", host, "2026-08-22.md"),
		};

		const started = Date.now();
		index.addEntry(entry);
		expect(Date.now() - started).toBeLessThan(50);
	});

	it("reopens a saved index without re-chunking anything", () => {
		StoreIndex.open(store).index.save();

		const started = Date.now();
		const reopened = StoreIndex.open(store);
		const ms = Date.now() - started;

		expect(reopened.result.kind).toBe("none");
		expect(reopened.index.size).toBe(ENTRIES * 3);
		expect(ms).toBeLessThan(3_000);
	});
});
