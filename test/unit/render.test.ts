import { describe, expect, it } from "vitest";
import type { SearchHit } from "../../src/index/search.ts";
import { parseEntry } from "../../src/journal/format.ts";
import { renderEntry, renderFile, renderHitLine, renderHits, trailer, truncate } from "../../src/tools/render.ts";

const ENTRY = "j-01a02e19-f1c6-7142-bcb1-2806083bd725";

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
	return {
		id: `${ENTRY}.1`,
		kind: "claim",
		path: "journal/host/2026-08-22.md",
		title: "",
		headingPath: "journal › 2026-08-22 › 14:32",
		body: "Run `pnpm test --run`; vitest watch mode hangs the CI job.",
		snippet: "Run `pnpm test --run`; vitest watch mode hangs the CI job.",
		date: "2026-08-22",
		source: "user",
		scope: "project",
		storePath: "/store",
		superseded: false,
		score: 1,
		...overrides,
	};
}

describe("renderHits", () => {
	it("gives the model the full id and provenance of each hit", () => {
		const text = renderHits([hit({ cue: "when CI hangs", phase: "test" })]);
		expect(text).toContain("1 memory:");
		expect(text).toContain("- Run `pnpm test --run`");
		expect(text).toContain(
			`id: ${ENTRY}.1 · date: 2026-08-22 · source: user · scope: project · kind: claim · phase: test · cue: when CI hangs`,
		);
	});

	it("marks a superseded hit, which only history asks for", () => {
		expect(renderHits([hit({ superseded: true })], { history: true })).toContain("superseded: true");
	});

	it("says how to widen an empty active-only search", () => {
		expect(renderHits([])).toContain("history: true");
		expect(renderHits([], { history: true })).toBe("No memories match, including superseded ones.");
	});
});

describe("renderHitLine", () => {
	it("is one compact line, with the id shortened for a terminal", () => {
		// Shortened ids are for looking at. The full id is in the text the model
		// gets, because that is the one that gets passed back to a tool.
		const line = renderHitLine(hit({ cue: "when CI hangs" }));
		expect(line).toBe("2026-08-22 · project · user · j-01a02e19…d725.1 · when CI hangs");
		expect(line).not.toContain("f1c6-7142");
	});

	it("falls back to the heading path when an entry has no cue", () => {
		expect(renderHitLine(hit())).toContain("journal › 2026-08-22 › 14:32");
	});
});

describe("renderEntry", () => {
	const block = [
		`## 14:32 · ${ENTRY}`,
		"source: user",
		"phase: test",
		"cue: when the CI job hangs",
		"",
		"The CI job hung for twenty minutes.",
		"",
		"- vitest watch mode hangs the CI job.",
		"- The runner has no TTY.",
		"",
		"",
	].join("\n");

	it("shows the prose as context and every claim by address", () => {
		const parsed = parseEntry(block);
		if (!parsed.entry) throw new Error(parsed.problems.join("; "));
		const text = renderEntry(parsed.entry, { scope: "project", path: "journal/h/2026-08-22.md", date: "2026-08-22" });

		expect(text).toContain("Context (not evidence on its own):");
		expect(text).toContain("The CI job hung for twenty minutes.");
		expect(text).toContain(`${ENTRY}.1`);
		expect(text).toContain(`${ENTRY}.2`);
		expect(text).toContain("file: journal/h/2026-08-22.md");
	});

	it("marks the claim that was asked for, and any that are superseded", () => {
		const parsed = parseEntry(block);
		if (!parsed.entry) throw new Error(parsed.problems.join("; "));
		const text = renderEntry(parsed.entry, {
			scope: "project",
			path: "journal/h/2026-08-22.md",
			claim: `${ENTRY}.2`,
			superseded: new Set([`${ENTRY}.1`]),
		});

		expect(text).toContain(`→ ${ENTRY}.2`);
		expect(text).toContain(`[superseded] ${ENTRY}.1`);
	});
});

describe("renderFile", () => {
	it("numbers lines so a follow-up range means something", () => {
		const text = renderFile("project:MEMORY.md", "# Memory\n\n- one\n- two\n");
		expect(text).toContain("project:MEMORY.md (4 lines)");
		expect(text).toContain("3  - one");
	});

	it("names the slice it returned", () => {
		const text = renderFile("project:MEMORY.md", "a\nb\nc\nd\n", { from: 2, to: 3 });
		expect(text).toContain("lines 2–3 of 4");
		expect(text).not.toMatch(/^1 {2}a/m);
	});
});

describe("truncate", () => {
	it("cuts with an ellipsis, and leaves short text alone", () => {
		expect(truncate("short", 20)).toBe("short");
		expect(truncate("a".repeat(30), 10)).toBe(`${"a".repeat(9)}…`);
	});
});

describe("trailer", () => {
	it("omits what an entry does not have", () => {
		const text = trailer({
			id: `${ENTRY}.1`,
			kind: "claim",
			path: "journal/h/2026-08-22.md",
			title: "",
			headingPath: "",
			body: "",
			superseded: false,
		});
		expect(text).toBe(`id: ${ENTRY}.1 · kind: claim`);
	});
});
