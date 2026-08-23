import { describe, expect, it } from "vitest";
import { newEntryId } from "../../src/ids.ts";
import {
	claimsOf,
	formatDate,
	formatEntry,
	formatTime,
	type JournalEntry,
	parseEntry,
} from "../../src/journal/format.ts";
import { parseDailyFile } from "../../src/journal/read.ts";

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
	return {
		id: newEntryId(),
		time: "14:32",
		source: "user",
		prose: "Martin corrected an earlier assumption while the CI job hung.",
		claims: ["Run `pnpm test --run`; vitest watch mode hangs the CI job."],
		...overrides,
	};
}

describe("formatEntry", () => {
	it("writes the heading, flat metadata, prose and bullets in that order", () => {
		const e = entry({ channel: "tui", phase: "test", cue: "when vitest hangs in CI" });
		const text = formatEntry(e);
		const lines = text.split("\n");

		expect(lines[0]).toBe(`## 14:32 · ${e.id}`);
		expect(lines[1]).toBe("source: user");
		expect(lines[2]).toBe("channel: tui");
		expect(text).toContain("phase: test");
		expect(text).toContain("cue: when vitest hangs in CI");
		expect(text).toContain("\n- Run `pnpm test --run`");
	});

	it("ends every entry with a blank line", () => {
		// The terminator is what makes a crash mid-append detectable, so it is
		// not cosmetic and not optional.
		expect(formatEntry(entry())).toMatch(/\n\n$/);
		expect(formatEntry(entry({ prose: "", claims: [] }))).toMatch(/\n\n$/);
	});

	it("joins list fields with commas", () => {
		const text = formatEntry(entry({ recalled: ["j-a.1", "f-t-b"], used: ["j-a.1"] }));
		expect(text).toContain("recalled: j-a.1, f-t-b");
		expect(text).toContain("used: j-a.1");
	});

	it("omits empty optional fields rather than writing blanks", () => {
		const text = formatEntry(entry({ recalled: [], cue: "" }));
		expect(text).not.toContain("recalled:");
		expect(text).not.toContain("cue:");
	});

	it("indents a multi-line claim so it stays one claim", () => {
		const text = formatEntry(entry({ claims: ["first line\nsecond line"] }));
		expect(text).toContain("- first line\n  second line");
	});
});

describe("parseEntry", () => {
	it("round-trips everything it was given", () => {
		const original = entry({
			channel: "rpc",
			task: "0198f2b0-1111-7000-8000-000000000001",
			continues: "0198f2b0-0000-7000-8000-000000000000",
			session: "~/.pi/agent/sessions/--x--/y.jsonl#e5f6",
			phase: "test",
			cue: "when vitest hangs in CI",
			recalled: ["j-a.1", "j-b.2"],
			used: ["j-a.1"],
			echo: ["f-testing-c"],
			redacted: true,
			promotedFrom: "app/j-old",
			claims: ["one", "two", "three"],
		});
		const parsed = parseEntry(formatEntry(original));
		expect(parsed.problems).toEqual([]);
		expect(parsed.entry).toEqual(original);
	});

	it("round-trips a minimal entry", () => {
		const original = entry({ prose: "just a note", claims: [] });
		const parsed = parseEntry(formatEntry(original));
		expect(parsed.entry).toEqual(original);
	});

	it("round-trips an entry with claims and no prose", () => {
		const original = entry({ prose: "", claims: ["only a claim"] });
		const parsed = parseEntry(formatEntry(original));
		expect(parsed.entry).toEqual(original);
	});

	it("keeps fields written by a newer Muninn rather than dropping them", () => {
		const original = entry({ extra: { confidence: "high", flavour: "salty" } });
		const parsed = parseEntry(formatEntry(original));
		expect(parsed.entry?.extra).toEqual({ confidence: "high", flavour: "salty" });
	});

	it("reads the documented example", () => {
		const id = newEntryId();
		const text = [
			`## 14:32 · ${id}`,
			"source: user",
			"channel: tui",
			"phase: test",
			"cue: when vitest hangs in CI",
			"",
			"Martin corrected an earlier assumption while the CI job hung.",
			"",
			"- Run `pnpm test --run`; vitest watch mode hangs the CI job.",
			"- The CI runner has no TTY, which is why watch mode never exits.",
			"",
			"",
		].join("\n");

		const parsed = parseEntry(text);
		expect(parsed.problems).toEqual([]);
		expect(parsed.entry?.claims).toHaveLength(2);
		expect(parsed.entry?.prose).toContain("corrected an earlier assumption");
	});

	it("rejects an entry with no valid id", () => {
		expect(parseEntry("## 14:32 · not-an-id\nsource: user\n\nbody\n\n").entry).toBeUndefined();
	});

	it("rejects an entry with no source", () => {
		// Provenance decides how much weight everything downstream gives a claim,
		// so an entry that does not say where it came from is not usable.
		const parsed = parseEntry(`## 14:32 · ${newEntryId()}\nchannel: tui\n\nbody\n\n`);
		expect(parsed.entry).toBeUndefined();
		expect(parsed.problems.join(" ")).toContain("source");
	});

	it("rejects an unknown source rather than guessing", () => {
		expect(parseEntry(`## 14:32 · ${newEntryId()}\nsource: telepathy\n\nbody\n\n`).entry).toBeUndefined();
	});

	it("keeps the entry but reports an unknown channel or phase", () => {
		const parsed = parseEntry(`## 14:32 · ${newEntryId()}\nsource: user\nphase: yodelling\n\nbody\n\n`);
		expect(parsed.entry).toBeDefined();
		expect(parsed.entry?.phase).toBeUndefined();
		expect(parsed.problems.join(" ")).toContain("yodelling");
	});

	it("treats an indented continuation as part of the claim above it", () => {
		const parsed = parseEntry(
			`## 14:32 · ${newEntryId()}\nsource: user\n\n- a claim that\n  wrapped onto two lines\n\n`,
		);
		expect(parsed.entry?.claims).toEqual(["a claim that wrapped onto two lines"]);
		expect(parsed.entry?.prose).toBe("");
	});

	it("treats every other line as context, wherever it sits", () => {
		const parsed = parseEntry(`## 14:32 · ${newEntryId()}\nsource: user\n\nbefore\n\n- a claim\n\nafter\n\n`);
		expect(parsed.entry?.claims).toEqual(["a claim"]);
		expect(parsed.entry?.prose).toBe("before\n\nafter");
	});
});

describe("claimsOf", () => {
	it("addresses claims from 1", () => {
		const e = entry({ claims: ["one", "two"] });
		expect(claimsOf(e).map((c) => c.id)).toEqual([`${e.id}.1`, `${e.id}.2`]);
	});

	it("gives an entry with no bullets one implicit claim: its prose", () => {
		const e = entry({ prose: "the whole point", claims: [] });
		expect(claimsOf(e)).toEqual([{ id: `${e.id}.1`, text: "the whole point", implicit: true }]);
	});

	it("gives an entry with neither prose nor bullets no claims at all", () => {
		expect(claimsOf(entry({ prose: "", claims: [] }))).toEqual([]);
	});
});

describe("time and date formatting", () => {
	it("pads to HH:MM and YYYY-MM-DD in local time", () => {
		const date = new Date(2026, 7, 3, 9, 5);
		expect(formatTime(date)).toBe("09:05");
		expect(formatDate(date)).toBe("2026-08-03");
	});
});

describe("prose that looks like structure", () => {
	it("round-trips a heading and a bullet inside prose without breaking the entry", () => {
		// A note that quotes a markdown heading is ordinary. Without the guard,
		// `## Deploy` at column 0 splits the entry in two on the next read and
		// the claim ids handed out at append time stop resolving.
		const entry: JournalEntry = {
			id: "j-01a02e19-f1c6-7142-bcb1-2806083bd725",
			time: "14:32",
			source: "user",
			prose: "Notes from the runbook:\n## Deploy\n- not a claim, a quoted list item\nuse blue-green",
			claims: ["Deploys go through staging first.", "Rollback is one command."],
		};

		const text = formatEntry(entry);
		const file = parseDailyFile(text);
		expect(file.problems).toEqual([]);
		expect(file.entries).toHaveLength(1);
		expect(file.entries[0]?.prose).toBe(entry.prose);
		expect(file.entries[0]?.claims).toEqual(entry.claims);
	});

	it("only strips the one space it added", () => {
		// A leading space before anything that is not a heading or bullet was
		// the writer's, and prose is trimmed as a whole anyway.
		const { entry } = parseEntry(
			"## 14:32 · j-01a02e19-f1c6-7142-bcb1-2806083bd725\nsource: user\n\nfirst\n  second, indented\n\n",
		);
		expect(entry?.prose).toBe("first\n  second, indented");
	});
});
