import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendSnapshot,
	buildSnapshot,
	contentLines,
	MEMORY_PREAMBLE,
	readSnapshot,
	type SnapshotBudget,
	type SnapshotSource,
} from "../../src/recall/snapshot.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import type { ActiveScope } from "../../src/store/scopes.ts";

const BUDGET: SnapshotBudget = DEFAULT_SETTINGS.recall.snapshotLines;

function sources(...entries: SnapshotSource[]): SnapshotSource[] {
	return entries;
}

describe("contentLines", () => {
	it("drops the header comment and the file's own H1", () => {
		const text = "<!-- Written by muninn dreams. -->\n\n# Memory\n\n- Testing: use `pnpm test --run`.\n";
		expect(contentLines(text)).toEqual(["- Testing: use `pnpm test --run`."]);
	});

	it("keeps headings below the first one", () => {
		const text = "# Memory\n\n## Testing\n\n- Use --run.\n";
		expect(contentLines(text)).toEqual(["## Testing", "", "- Use --run."]);
	});

	it("collapses blank runs and drops leading and trailing blanks", () => {
		expect(contentLines("\n\n- one\n\n\n\n- two\n\n\n")).toEqual(["- one", "", "- two"]);
	});

	it("returns nothing for a store whose MEMORY.md is only the header", () => {
		expect(contentLines("<!-- Written by muninn dreams. -->\n\n# Memory\n\n")).toEqual([]);
	});
});

describe("buildSnapshot", () => {
	it("merges global before project, each under its own heading", () => {
		const snapshot = buildSnapshot(
			sources(
				{ scope: "project", text: "# Memory\n\n- This repo pins node 22.\n" },
				{ scope: "global", text: "# Memory\n\n- Always use pnpm.\n" },
			),
			BUDGET,
		);

		expect(snapshot?.text).toBe(
			[
				"# Memory",
				"",
				MEMORY_PREAMBLE,
				"",
				"## global",
				"",
				"- Always use pnpm.",
				"",
				"## project",
				"",
				"- This repo pins node 22.",
			].join("\n"),
		);
		expect(snapshot?.lines).toBe(2);
	});

	it("carries the fixed 'memories, not ground truth' framing", () => {
		const snapshot = buildSnapshot(sources({ scope: "global", text: "- A memory.\n" }), BUDGET);
		expect(snapshot?.text).toContain("These are memories, not ground truth.");
	});

	it("returns nothing when every MEMORY.md is empty — no empty Memory section", () => {
		expect(buildSnapshot(sources({ scope: "global", text: "# Memory\n\n" }), BUDGET)).toBeUndefined();
		expect(buildSnapshot([], BUDGET)).toBeUndefined();
	});

	it("trims to the per-scope budget and says how much it left out", () => {
		const text = Array.from({ length: 10 }, (_value, index) => `- line ${index}`).join("\n");
		const snapshot = buildSnapshot(sources({ scope: "global", text }), { ...BUDGET, global: 3 });

		expect(snapshot?.scopes).toEqual([{ scope: "global", lines: 3, dropped: 7 }]);
		expect(snapshot?.text).toContain("… 7 more line(s) trimmed by recall.snapshotLines");
		expect(snapshot?.text).not.toContain("- line 3");
	});

	it("spends the total budget in scope order", () => {
		const global = Array.from({ length: 5 }, (_value, index) => `- global ${index}`).join("\n");
		const project = Array.from({ length: 5 }, (_value, index) => `- project ${index}`).join("\n");
		const snapshot = buildSnapshot(sources({ scope: "global", text: global }, { scope: "project", text: project }), {
			total: 6,
			global: 5,
			project: 5,
			team: 0,
		});

		expect(snapshot?.scopes).toEqual([
			{ scope: "global", lines: 5, dropped: 0 },
			{ scope: "project", lines: 1, dropped: 4 },
		]);
	});

	it("injects nothing when the budget is zero", () => {
		const snapshot = buildSnapshot(sources({ scope: "global", text: "- A memory.\n" }), {
			total: 0,
			global: 0,
			project: 0,
			team: 0,
		});
		expect(snapshot).toBeUndefined();
	});
});

describe("appendSnapshot", () => {
	it("appends after pi's own prompt, leaving it untouched", () => {
		const snapshot = buildSnapshot(sources({ scope: "global", text: "- A memory.\n" }), BUDGET);
		if (!snapshot) throw new Error("expected a snapshot");
		const prompt = appendSnapshot("pi's system prompt", snapshot);
		expect(prompt.startsWith("pi's system prompt")).toBe(true);
		expect(prompt.endsWith(snapshot.text)).toBe(true);
	});
});

describe("readSnapshot", () => {
	let global: string;
	let project: string;

	beforeEach(() => {
		global = mkdtempSync(join(tmpdir(), "muninn-snap-global-"));
		project = mkdtempSync(join(tmpdir(), "muninn-snap-project-"));
	});

	afterEach(() => {
		for (const path of [global, project]) rmSync(path, { recursive: true, force: true });
	});

	function scopes(): ActiveScope[] {
		return [
			{ scope: "global", path: global, exists: true, inRepo: false },
			{ scope: "project", path: project, exists: true, inRepo: false },
		];
	}

	it("reads each active scope's MEMORY.md", () => {
		writeFileSync(join(global, "MEMORY.md"), "# Memory\n\n- Always use pnpm.\n");
		writeFileSync(join(project, "MEMORY.md"), "# Memory\n\n- This repo pins node 22.\n");

		const snapshot = readSnapshot(scopes(), BUDGET);
		expect(snapshot?.text).toContain("Always use pnpm");
		expect(snapshot?.text).toContain("node 22");
	});

	it("treats a store with no MEMORY.md as contributing nothing", () => {
		writeFileSync(join(global, "MEMORY.md"), "# Memory\n\n- Always use pnpm.\n");
		const snapshot = readSnapshot(scopes(), BUDGET);
		expect(snapshot?.scopes.map((scope) => scope.scope)).toEqual(["global"]);
	});

	it("skips a scope whose store does not exist yet", () => {
		mkdirSync(join(project, "nested"), { recursive: true });
		const snapshot = readSnapshot([{ scope: "project", path: project, exists: false, inRepo: false }], BUDGET);
		expect(snapshot).toBeUndefined();
	});
});
