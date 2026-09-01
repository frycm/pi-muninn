import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newHostId, newMemberId, newProjectId, newStoreId } from "../../src/ids.ts";
import { appendEntry } from "../../src/journal/append.ts";
import { appendJournalRecord, scanJournal } from "../../src/journal/jsonl.ts";
import {
	inventoryLegacyStores,
	migrateMarkdownStores,
	migrationManifestPath,
	parseMigrationManifest,
} from "../../src/journal/migrate.ts";
import { formatStoreMd } from "../../src/store/store-md.ts";

const roots: string[] = [];

function root(name: string): string {
	const path = mkdtempSync(join(tmpdir(), `muninn-${name}-`));
	roots.push(path);
	return path;
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function legacyStore(): Promise<{ path: string; host: string; ids: string[] }> {
	const path = root("legacy");
	const host = newHostId();
	writeFileSync(
		join(path, "store.md"),
		formatStoreMd({
			schema: 1,
			store: newStoreId(),
			created: "2026-08-01",
			hosts: [{ id: host, name: "old", registered: "2026-08-01" }],
		}),
	);
	const full = await appendEntry(
		{
			source: "user",
			channel: "tui",
			task: "task-one",
			continues: "task-zero",
			session: "/sessions/one.jsonl#e-9",
			phase: "test",
			cue: "when CI hangs",
			promotedFrom: "old-project/record",
			prose: "Context paragraph.",
			claims: ["First claim.", "Second claim."],
			extra: { future_field: "kept" },
		},
		{ storePath: path, hostId: host, now: new Date("2026-08-22T09:14:00.000Z") },
	);
	const minimal = await appendEntry(
		{ source: "external", prose: "", claims: [] },
		{ storePath: path, hostId: host, now: new Date("2026-08-22T10:00:00.000Z") },
	);
	const file = join(path, "journal", host, "2026-08-22.md");
	writeFileSync(
		file,
		`${readFileSync(file, "utf-8")}## 11:00 · j-01a02e1c-7777-7888-8999-aaabbbcccddd\nsource: user\n\nhalf`,
	);
	return { path, host, ids: [full.id, minimal.id] };
}

function targetIdentity() {
	return { project: newProjectId(), member: newMemberId(), host: newHostId() };
}

describe("Markdown migration", () => {
	it("preserves stable IDs and all legacy fields while leaving source bytes untouched", async () => {
		const source = await legacyStore();
		const before = readFileSync(join(source.path, "journal", source.host, "2026-08-22.md"));
		const target = root("target");
		const ids = targetIdentity();
		const inventory = inventoryLegacyStores([source.path]);
		const result = await migrateMarkdownStores({ targetStore: target, ...ids, sources: inventory });

		expect(result.imported).toBe(2);
		expect(result.problems).toEqual([expect.objectContaining({ message: expect.stringContaining("truncated") })]);
		const records = scanJournal(target).records.map((item) => item.record);
		expect(records.map((record) => record.id)).toEqual(source.ids);
		const full = records[0];
		expect(full).toMatchObject({
			type: "import",
			source: "user",
			channel: "tui",
			task: "task-one",
			continues: "task-zero",
			cue: "when CI hangs",
			tags: ["test"],
			session: { file: "/sessions/one.jsonl", last: "e-9" },
		});
		expect(full?.body).toContain("First claim.");
		expect(full?.legacy?.fields).toMatchObject({
			phase: "test",
			promoted_from: "old-project/record",
			extra: { future_field: "kept" },
			claims: ["First claim.", "Second claim."],
		});
		expect(records[1]?.body).toBe("(empty legacy record)");
		expect(readFileSync(join(source.path, "journal", source.host, "2026-08-22.md"))).toEqual(before);
		expect(parseMigrationManifest(readFileSync(migrationManifestPath(target), "utf-8")).records).toBe(2);
	});

	it("dry-runs without writing, then reruns without appending a byte", async () => {
		const source = await legacyStore();
		const target = root("target");
		const ids = targetIdentity();
		const sources = inventoryLegacyStores([source.path]);
		const dry = await migrateMarkdownStores({ targetStore: target, ...ids, sources, dryRun: true });
		expect(dry.imported).toBe(2);
		expect(scanJournal(target).records).toEqual([]);
		expect(existsSync(migrationManifestPath(target))).toBe(false);

		const now = new Date("2026-09-01T12:00:00.000Z");
		const first = await migrateMarkdownStores({ targetStore: target, ...ids, sources, now });
		const shard = scanJournal(target).records[0]?.path as string;
		const bytes = readFileSync(shard);
		const second = await migrateMarkdownStores({ targetStore: target, ...ids, sources, now });
		expect(first.considered).toBe(second.considered);
		expect(second).toMatchObject({ imported: 0, skipped: 2, bytes: 0 });
		expect(readFileSync(shard)).toEqual(bytes);
	});

	it("resumes after an interrupted append without duplicates", async () => {
		const source = await legacyStore();
		const target = root("target");
		const ids = targetIdentity();
		const sources = inventoryLegacyStores([source.path]);
		await expect(migrateMarkdownStores({ targetStore: target, ...ids, sources, failAfter: 1 })).rejects.toThrow(
			/injected migration interruption/,
		);
		expect(scanJournal(target).records).toHaveLength(1);
		expect(existsSync(migrationManifestPath(target))).toBe(false);
		const resumed = await migrateMarkdownStores({ targetStore: target, ...ids, sources });
		expect(resumed).toMatchObject({ imported: 1, skipped: 1 });
		expect(scanJournal(target).records).toHaveLength(2);
	});

	it("de-duplicates copied source stores by durable store id", async () => {
		const source = await legacyStore();
		const copy = root("legacy-copy");
		cpSync(source.path, copy, { recursive: true });
		const inventory = inventoryLegacyStores([source.path, copy]);
		expect(inventory).toHaveLength(1);
		expect(new Set(inventory[0]?.aliases)).toEqual(new Set([source.path, copy]));
	});

	it("reports a different target record with the same ID instead of overwriting it", async () => {
		const source = await legacyStore();
		const target = root("target");
		const ids = targetIdentity();
		await appendJournalRecord(
			{ type: "note", source: "agent", channel: "sdk", body: "different" },
			{
				storePath: target,
				...ids,
				id: source.ids[0] as string,
				now: new Date("2026-08-22T09:14:00.000Z"),
			},
		);
		const result = await migrateMarkdownStores({
			targetStore: target,
			...ids,
			sources: inventoryLegacyStores([source.path]),
		});
		expect(result.problems.some((problem) => problem.message.includes("different record bytes"))).toBe(true);
		expect(scanJournal(target).records.find((item) => item.record.id === source.ids[0])?.record.body).toBe("different");
	});
});
