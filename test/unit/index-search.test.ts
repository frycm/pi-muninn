import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newHostId } from "../../src/ids.ts";
import { StoreIndex } from "../../src/index/build.ts";
import { type ScopeIndex, SessionIndexes, search } from "../../src/index/search.ts";
import type { ActiveScope } from "../../src/store/scopes.ts";

const ENTRY_A = "j-01a02e19-f1c6-7142-bcb1-2806083bd725";
const ENTRY_B = "j-01a02e1b-655b-7317-bf15-3bba2f63f9c1";

let global: string;
let project: string;
let host: string;

beforeEach(() => {
	global = mkdtempSync(join(tmpdir(), "muninn-global-"));
	project = mkdtempSync(join(tmpdir(), "muninn-project-"));
	host = newHostId();
});

afterEach(() => {
	rmSync(global, { recursive: true, force: true });
	rmSync(project, { recursive: true, force: true });
});

function writeEntry(store: string, id: string, claim: string, date = "2026-08-22"): void {
	mkdirSync(join(store, "journal", host), { recursive: true });
	writeFileSync(
		join(store, "journal", host, `${date}.md`),
		[`## 14:32 · ${id}`, "source: user", "phase: test", "", "Context.", "", `- ${claim}`, "", ""].join("\n"),
	);
}

function scopes(): ScopeIndex[] {
	return [
		{ scope: "global", storePath: global, index: StoreIndex.open(global).index },
		{ scope: "project", storePath: project, index: StoreIndex.open(project).index },
	];
}

describe("search across scopes", () => {
	it("queries every active scope and labels each hit with the one it came from", () => {
		writeEntry(global, ENTRY_A, "vitest watch mode hangs the CI job.");
		writeEntry(project, ENTRY_B, "vitest needs DATABASE_URL in this repository.");

		const hits = search(scopes(), { query: "vitest" });
		expect(hits.map((hit) => hit.scope).sort()).toEqual(["global", "project"]);
		expect(hits.every((hit) => hit.storePath !== "")).toBe(true);
	});

	it("restricts to one scope when asked", () => {
		writeEntry(global, ENTRY_A, "vitest watch mode hangs the CI job.");
		writeEntry(project, ENTRY_B, "vitest needs DATABASE_URL in this repository.");

		const hits = search(scopes(), { query: "vitest", scope: "project" });
		expect(hits.map((hit) => hit.id)).toEqual([`${ENTRY_B}.1`]);
	});

	it("honours the overall limit after merging", () => {
		writeEntry(global, ENTRY_A, "vitest watch mode hangs the CI job.");
		writeEntry(project, ENTRY_B, "vitest hangs here too.");
		expect(search(scopes(), { query: "vitest", limit: 1 })).toHaveLength(1);
	});
});

describe("SessionIndexes", () => {
	function active(): ActiveScope[] {
		return [
			{ scope: "global", path: global, exists: true },
			{ scope: "project", path: project, exists: true },
		];
	}

	it("opens one index per active scope and reports what it built", () => {
		writeEntry(global, ENTRY_A, "vitest watch mode hangs the CI job.");
		const opened = SessionIndexes.open(active());

		expect(opened.problems).toEqual([]);
		expect(opened.notes).toHaveLength(2);
		expect(opened.notes[0]).toMatch(/^global: /);
		expect(opened.indexes.search({ query: "vitest" }).map((hit) => hit.scope)).toEqual(["global"]);
	});

	it("skips a scope whose store has not been created", () => {
		const opened = SessionIndexes.open([{ scope: "global", path: global, exists: false }]);
		expect(opened.indexes.scopes).toHaveLength(0);
	});

	it("indexes an appended entry into the store it was written to", () => {
		const opened = SessionIndexes.open(active());
		opened.indexes.addEntry(project, {
			id: ENTRY_B,
			time: "15:00",
			source: "user",
			prose: "",
			claims: ["Deploys go through staging first."],
			date: "2026-08-22",
			host,
			path: join(project, "journal", host, "2026-08-22.md"),
		});

		const hits = opened.indexes.search({ query: "staging" });
		expect(hits.map((hit) => hit.scope)).toEqual(["project"]);
		expect(opened.indexes.save()).toEqual([]);
	});
});

describe("SessionIndexes.refresh", () => {
	it("picks up entries that arrived in the store from outside the session", () => {
		// What a sync does: another host's daily file is rebased into the store
		// while this session holds its index open. Without a refresh the memory
		// that just arrived is invisible until the next session.
		const opened = SessionIndexes.open([{ scope: "global", path: global, exists: true }]);
		expect(opened.indexes.search({ query: "elsewhere" })).toEqual([]);

		writeEntry(global, ENTRY_A, "A claim written elsewhere and synced in.");
		expect(opened.indexes.search({ query: "elsewhere" })).toEqual([]);

		opened.indexes.refresh(global);
		expect(opened.indexes.search({ query: "elsewhere" })[0]?.id).toBe(`${ENTRY_A}.1`);
	});

	it("is cheap and harmless when nothing changed", () => {
		writeEntry(global, ENTRY_A, "Already indexed.");
		const opened = SessionIndexes.open([{ scope: "global", path: global, exists: true }]);
		const before = opened.indexes.size;

		opened.indexes.refresh(global);
		opened.indexes.refresh("/some/store/this/session/never/opened");

		expect(opened.indexes.size).toBe(before);
	});
});
