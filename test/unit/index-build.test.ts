import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newHostId } from "../../src/ids.ts";
import { INDEX_VERSION, indexDir, type Manifest, StoreIndex } from "../../src/index/build.ts";
import { appendEntry } from "../../src/journal/append.ts";
import type { JournalEntryWithContext } from "../../src/journal/read.ts";

let store: string;
let host: string;

beforeEach(() => {
	store = mkdtempSync(join(tmpdir(), "muninn-index-"));
	host = newHostId();
});

afterEach(() => {
	rmSync(store, { recursive: true, force: true });
});

function writeDaily(date: string, body: string): string {
	mkdirSync(join(store, "journal", host), { recursive: true });
	const path = join(store, "journal", host, `${date}.md`);
	writeFileSync(path, body);
	return path;
}

const ENTRY_A = "j-01a02e19-f1c6-7142-bcb1-2806083bd725";
const ENTRY_B = "j-01a02e1b-655b-7317-bf15-3bba2f63f9c1";

function entryText(id: string, claim: string, cue = "when CI misbehaves"): string {
	return [
		`## 14:32 · ${id}`,
		"source: user",
		"phase: test",
		`cue: ${cue}`,
		"",
		"Some context.",
		"",
		`- ${claim}`,
		"",
		"",
	].join("\n");
}

function manifestOf(): Manifest {
	return JSON.parse(readFileSync(join(indexDir(store), "manifest.json"), "utf-8")) as Manifest;
}

describe("StoreIndex.open", () => {
	it("indexes journal claims and their context", () => {
		writeDaily("2026-08-22", entryText(ENTRY_A, "vitest watch mode hangs the CI job."));

		const { index, result } = StoreIndex.open(store);
		expect(result.kind).toBe("full");
		expect(index.search("vitest watch")[0]?.id).toBe(`${ENTRY_A}.1`);
		expect(index.search("Some context", { kind: ["prose"] })[0]?.id).toBe(`${ENTRY_A}#prose`);
	});

	it("writes a manifest and a serialised index, and reopens without rebuilding", () => {
		writeDaily("2026-08-22", entryText(ENTRY_A, "vitest watch mode hangs the CI job."));
		StoreIndex.open(store).index.save();

		expect(existsSync(join(indexDir(store), "tier0.json"))).toBe(true);
		expect(manifestOf().version).toBe(INDEX_VERSION);

		const reopened = StoreIndex.open(store);
		expect(reopened.result.kind).toBe("none");
		expect(reopened.result.changed).toEqual([]);
		expect(reopened.index.search("vitest").map((hit) => hit.id)).toEqual([`${ENTRY_A}.1`]);
	});

	it("re-chunks only the file whose content hash changed", () => {
		writeDaily("2026-08-21", entryText(ENTRY_A, "vitest watch mode hangs the CI job."));
		writeDaily("2026-08-22", entryText(ENTRY_B, "The runner has no TTY."));
		StoreIndex.open(store).index.save();

		writeDaily(
			"2026-08-22",
			`${entryText(ENTRY_B, "The runner has no TTY.")}${entryText("j-01a02e1c-9999-7111-8222-333344445555", "Docker compose owns the database URL.")}`,
		);
		const { index, result } = StoreIndex.open(store);

		expect(result.changed).toEqual([`journal/${host}/2026-08-22.md`]);
		expect(index.search("docker compose")).toHaveLength(1);
	});

	it("drops the chunks of a file that has gone", () => {
		const path = writeDaily("2026-08-22", entryText(ENTRY_A, "vitest watch mode hangs the CI job."));
		StoreIndex.open(store).index.save();

		rmSync(path);
		const { index, result } = StoreIndex.open(store);
		expect(result.removed).toEqual([`journal/${host}/2026-08-22.md`]);
		expect(index.search("vitest")).toEqual([]);
	});

	it("rebuilds when the index was written by another version", () => {
		writeDaily("2026-08-22", entryText(ENTRY_A, "vitest watch mode hangs the CI job."));
		StoreIndex.open(store).index.save();

		const manifest = manifestOf();
		manifest.version = INDEX_VERSION + 1;
		writeFileSync(join(indexDir(store), "manifest.json"), JSON.stringify(manifest));

		const { index, result } = StoreIndex.open(store);
		expect(result.problems.join(" ")).toMatch(/index rebuilt/);
		expect(result.kind).toBe("full");
		expect(index.search("vitest")).toHaveLength(1);
	});

	it("rebuilds when the serialised index is corrupt, and says so", () => {
		writeDaily("2026-08-22", entryText(ENTRY_A, "vitest watch mode hangs the CI job."));
		StoreIndex.open(store).index.save();
		writeFileSync(join(indexDir(store), "tier0.json"), "{ not json");

		const { index, result } = StoreIndex.open(store);
		expect(result.problems.join(" ")).toMatch(/index rebuilt/);
		expect(index.search("vitest")).toHaveLength(1);
	});

	it("rebuilds unconditionally when forced", () => {
		writeDaily("2026-08-22", entryText(ENTRY_A, "vitest watch mode hangs the CI job."));
		StoreIndex.open(store).index.save();

		const { index, result } = StoreIndex.open(store, { force: true });
		expect(result.kind).toBe("full");
		expect(index.search("vitest")).toHaveLength(1);
	});

	it("reports a truncated entry and indexes everything before it", () => {
		// A crash mid-append leaves at most one unterminated entry at end of file.
		writeDaily(
			"2026-08-22",
			`${entryText(ENTRY_A, "vitest watch mode hangs the CI job.")}## 14:40 · ${ENTRY_B}\nsource: user\n\nhalf`,
		);
		const { index, result } = StoreIndex.open(store);

		expect(result.problems.join(" ")).toMatch(/truncated/);
		expect(index.search("vitest")).toHaveLength(1);
	});

	it("survives a store with nothing in it yet", () => {
		const { index, result } = StoreIndex.open(store);
		expect(result.kind).toBe("none");
		expect(index.size).toBe(0);
		expect(index.search("anything")).toEqual([]);
	});
});

describe("StoreIndex.addEntry", () => {
	it("makes an entry findable the moment it is appended", async () => {
		const { index } = StoreIndex.open(store);
		const written = await appendEntry(
			{ source: "user", prose: "", claims: ["Deploys go through staging first."] },
			{ storePath: store, hostId: host },
		);

		const entry: JournalEntryWithContext = { ...written.entry, date: written.date, host, path: written.path };
		index.addEntry(entry);

		expect(index.search("staging").map((hit) => hit.id)).toEqual([written.claimIds[0]]);
	});

	it("reconciles with the file on save, without duplicating the entry", async () => {
		const { index } = StoreIndex.open(store);
		const written = await appendEntry(
			{ source: "user", prose: "", claims: ["Deploys go through staging first."] },
			{ storePath: store, hostId: host },
		);
		index.addEntry({ ...written.entry, date: written.date, host, path: written.path });
		index.save();

		// The manifest is only written from what was read off disk, so a reopen
		// sees the same one chunk — not a second copy of it.
		const reopened = StoreIndex.open(store);
		expect(reopened.index.search("staging")).toHaveLength(1);
		expect(reopened.index.size).toBe(index.size);
	});
});
