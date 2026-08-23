import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claimsOf } from "../../src/journal/format.ts";
import { readDailyFile } from "../../src/journal/read.ts";

/**
 * A realistic day's journal, ending in a deliberate mid-append crash. It exists
 * as a file rather than a string so the format stays readable to a human, and
 * so a change to the grammar has to be made against something that looks like
 * what Muninn actually writes.
 */
const FIXTURE = fileURLToPath(new URL("../fixtures/journal/2026-08-22.md", import.meta.url));

describe("a real day's journal", () => {
	it("reads the three complete entries and reports exactly one truncation", () => {
		const read = readDailyFile(FIXTURE);

		expect(read.entries).toHaveLength(3);
		expect(read.problems).toHaveLength(1);
		expect(read.problems[0]?.kind).toBe("truncated");
	});

	it("keeps provenance, task grouping and derivation", () => {
		const [first, second, third] = readDailyFile(FIXTURE).entries;

		expect(first?.source).toBe("user");
		expect(first?.channel).toBe("tui");
		expect(first?.phase).toBe("test");
		expect(first?.cue).toBe("when vitest hangs in CI");

		expect(second?.source).toBe("tool");
		expect(second?.task).toBe(first?.task);
		expect(second?.recalled).toEqual([`${first?.id}.1`]);
		expect(second?.used).toEqual([`${first?.id}.1`]);

		expect(third?.redacted).toBe(true);
	});

	it("addresses every claim in the file", () => {
		const entries = readDailyFile(FIXTURE).entries;
		const claims = entries.flatMap((entry) => claimsOf(entry));

		expect(claims.map((claim) => claim.id)).toEqual([
			`${entries[0]?.id}.1`,
			`${entries[0]?.id}.2`,
			`${entries[1]?.id}.1`,
			`${entries[2]?.id}.1`,
		]);
		expect(claims.every((claim) => !claim.implicit)).toBe(true);
	});

	it("excludes the half-written entry from what anything downstream can see", () => {
		// It is in the file and a human can read it. It is not evidence.
		const read = readDailyFile(FIXTURE);
		expect(read.entries.some((entry) => entry.id.includes("01a02e1c"))).toBe(false);
	});
});
