import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSettings } from "../../src/settings-io.ts";

let root: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "muninn-settings-"));
	agentDir = join(root, "agent");
	cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function load() {
	return loadSettings({ agentDir, cwd, configDirName: ".pi" });
}

function writeGlobal(content: string): void {
	writeFileSync(join(agentDir, "settings.json"), content);
}

function writeProject(content: string): void {
	writeFileSync(join(cwd, ".pi", "settings.json"), content);
}

describe("loadSettings", () => {
	it("uses defaults and reports both files absent", () => {
		const result = load();
		expect(result.warnings).toEqual([]);
		expect(result.settings.recall.factsPerTurn).toBe(8);
		expect(result.sources.global.present).toBe(false);
		expect(result.sources.project.present).toBe(false);
	});

	it("ignores settings files that carry no muninn block", () => {
		writeGlobal(JSON.stringify({ defaultModel: "sonnet" }));
		const result = load();
		expect(result.warnings).toEqual([]);
		expect(result.sources.global.present).toBe(true);
		expect(result.sources.global.hasMuninnBlock).toBe(false);
	});

	it("reads the muninn block from both files and tightens", () => {
		writeGlobal(JSON.stringify({ defaultModel: "sonnet", muninn: { recall: { factsPerTurn: 12 } } }));
		writeProject(JSON.stringify({ muninn: { recall: { factsPerTurn: 3 } } }));
		const result = load();
		expect(result.settings.recall.factsPerTurn).toBe(3);
		expect(result.sources.global.hasMuninnBlock).toBe(true);
		expect(result.sources.project.hasMuninnBlock).toBe(true);
		expect(result.warnings).toEqual([]);
	});

	it("reports invalid JSON and falls back to defaults for that scope", () => {
		// pi parses settings.json with plain JSON.parse, so a file with comments
		// is broken for pi too; accepting it here would hide that.
		writeGlobal('{ "muninn": { /* comment */ "recall": { "factsPerTurn": 3 } } }');
		const result = load();
		expect(result.settings.recall.factsPerTurn).toBe(8);
		expect(result.warnings[0]).toMatchObject({ kind: "parse-error", scope: "global" });
		expect(result.warnings[0]?.message).toContain("not valid JSON");
	});

	it("keeps the other scope working when one file is broken", () => {
		writeGlobal("{ broken");
		writeProject(JSON.stringify({ muninn: { capture: { outcomes: false } } }));
		const result = load();
		expect(result.settings.capture.outcomes).toBe(false);
		expect(result.warnings).toHaveLength(1);
	});
});
