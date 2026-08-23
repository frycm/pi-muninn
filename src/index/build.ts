/**
 * Building and persisting a store's index.
 *
 * The index is derived, gitignored and disposable by contract: deleting
 * `.index/` costs a rebuild and nothing else. That contract is what makes the
 * incremental path safe to keep simple — every question of the form "is this
 * stale?" is answered by a content hash in `manifest.json`, and the worst
 * outcome of getting one wrong is redundant work.
 *
 * Two files:
 *
 *  - `manifest.json` — the version stamp, and per file its content hash and
 *    the chunk ids it produced. The hash decides what to re-chunk; the ids are
 *    what to discard when a file changes or disappears.
 *  - `tier0.json` — the serialised `minisearch` index and link graph.
 *
 * Writes go through a temporary file and a rename, so a reader never sees half
 * an index, and a crash mid-write leaves the previous one intact. Concurrent
 * writers are *not* excluded: two sessions rebuilding at once produce the same
 * bytes from the same files, and the store lock is reserved for the things
 * where a race would cost data.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { JournalEntryWithContext } from "../journal/read.ts";
import { listJournalFiles, readDailyFile } from "../journal/read.ts";
import { SCHEMA_VERSION } from "../store/store-md.ts";
import { type Chunk, chunkFile, chunkJournalEntry } from "./chunk.ts";
import { type Hit, type QueryOptions, type StoredChunk, type Tier0Data, Tier0Index } from "./tier0.ts";

/**
 * The index format's own version.
 *
 * Bumped whenever chunking, field weights or the serialised shape change —
 * anything that would make an index built by an older Muninn answer
 * differently. A mismatch deletes and rebuilds, which is the one migration
 * that is free.
 */
export const INDEX_VERSION = 1;

export interface ManifestFile {
	hash: string;
	chunks: string[];
}

export interface Manifest {
	version: number;
	/** The store schema this index was built against. */
	schema: number;
	/** Store-relative path → hash and chunk ids. */
	files: Record<string, ManifestFile>;
}

export type RebuildKind = "none" | "incremental" | "full";

export interface RefreshResult {
	kind: RebuildKind;
	/** Files re-chunked, and files whose chunks were dropped. */
	changed: string[];
	removed: string[];
	/** Damaged journal files and unreadable index files, never thrown. */
	problems: string[];
	ms: number;
}

export function indexDir(storePath: string): string {
	return join(storePath, ".index");
}

function hashOf(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function emptyManifest(): Manifest {
	return { version: INDEX_VERSION, schema: SCHEMA_VERSION, files: {} };
}

/**
 * A store's Tier 0 index, with the manifest that says what is in it.
 *
 * Opened per session and kept for its lifetime: recall queries it every turn,
 * and capture adds to it as entries are appended.
 */
export class StoreIndex {
	readonly storePath: string;
	private index: Tier0Index;
	private manifest: Manifest;
	/** In-memory chunks not yet reflected in a persisted file. */
	private dirty = false;

	private constructor(storePath: string, index: Tier0Index, manifest: Manifest) {
		this.storePath = storePath;
		this.index = index;
		this.manifest = manifest;
	}

	/**
	 * Open the index for a store, rebuilding whatever is stale.
	 *
	 * `force` discards what is on disk first — `/muninn reindex`, and the
	 * recovery path for an index that is corrupt in a way the version stamp
	 * cannot see.
	 */
	static open(storePath: string, options: { force?: boolean } = {}): { index: StoreIndex; result: RefreshResult } {
		const started = Date.now();
		const problems: string[] = [];
		let index: Tier0Index | undefined;
		let manifest: Manifest | undefined;

		if (options.force === true) {
			rmSync(indexDir(storePath), { recursive: true, force: true });
		} else {
			const loaded = load(storePath);
			problems.push(...loaded.problems);
			index = loaded.index;
			manifest = loaded.manifest;
		}

		const fresh = index === undefined;
		const store = new StoreIndex(storePath, index ?? Tier0Index.empty(), manifest ?? emptyManifest());
		const result = store.refresh();
		result.problems.unshift(...problems);
		if (fresh && result.changed.length > 0) result.kind = "full";
		result.ms = Date.now() - started;
		return { index: store, result };
	}

	get size(): number {
		return this.index.size;
	}

	get files(): number {
		return Object.keys(this.manifest.files).length;
	}

	search(query: string, options?: QueryOptions): Hit[] {
		return this.index.search(query, options);
	}

	/** One chunk by id — a claim, a fact, a rule, or a slice of a file. */
	get(id: string): StoredChunk | undefined {
		return this.index.get(id);
	}

	linksFrom(id: string): string[] {
		return this.index.linksFrom(id);
	}

	backlinksTo(id: string): string[] {
		return this.index.backlinksTo(id);
	}

	/**
	 * Add one just-appended entry, without re-reading the file it went into.
	 *
	 * The manifest is deliberately left alone: it records what was chunked
	 * *from disk*, so leaving the daily file's hash stale is what makes the next
	 * open re-read it and pick up whatever another session appended meanwhile.
	 * Chunk ids are claim ids, so the re-read replaces these chunks rather than
	 * duplicating them.
	 */
	addEntry(entry: JournalEntryWithContext): void {
		const path = this.relative(entry.path);
		this.index.add(chunkJournalEntry(entry, path));
		this.dirty = true;
	}

	/** Re-chunk every file whose content hash changed, and drop the vanished. */
	refresh(): RefreshResult {
		const started = Date.now();
		const result: RefreshResult = { kind: "none", changed: [], removed: [], problems: [], ms: 0 };

		const seen = new Set<string>();

		for (const file of listJournalFiles(this.storePath)) {
			const path = this.relative(file.path);
			seen.add(path);
			const text = readText(file.path, result.problems);
			if (text === undefined) continue;
			if (this.manifest.files[path]?.hash === hashOf(text)) continue;

			const read = readDailyFile(file.path);
			for (const problem of read.problems) result.problems.push(`${problem.kind}: ${problem.message}`);
			const chunks: Chunk[] = [];
			for (const entry of read.entries) {
				const withContext: JournalEntryWithContext = { ...entry, date: file.date, host: file.host, path: file.path };
				chunks.push(...chunkJournalEntry(withContext, path));
			}
			this.replace(path, hashOf(text), chunks);
			result.changed.push(path);
		}

		for (const path of derivedFiles(this.storePath)) {
			seen.add(path);
			const text = readText(join(this.storePath, path), result.problems);
			if (text === undefined) continue;
			if (this.manifest.files[path]?.hash === hashOf(text)) continue;
			this.replace(path, hashOf(text), chunkFile(path, text));
			result.changed.push(path);
		}

		for (const path of Object.keys(this.manifest.files)) {
			if (seen.has(path)) continue;
			this.index.discard(this.manifest.files[path]?.chunks ?? []);
			delete this.manifest.files[path];
			this.dirty = true;
			result.removed.push(path);
		}

		if (result.changed.length > 0 || result.removed.length > 0) result.kind = "incremental";
		result.ms = Date.now() - started;
		return result;
	}

	/** Refresh, then write the index out. A no-op when nothing has changed. */
	save(): void {
		const result = this.refresh();
		if (!this.dirty && result.kind === "none") return;
		this.write();
	}

	private replace(path: string, hash: string, chunks: Chunk[]): void {
		this.index.discard(this.manifest.files[path]?.chunks ?? []);
		this.index.add(chunks);
		this.manifest.files[path] = { hash, chunks: chunks.map((chunk) => chunk.id) };
		this.dirty = true;
	}

	private relative(path: string): string {
		return relative(this.storePath, path).split("\\").join("/");
	}

	private write(): void {
		const dir = indexDir(this.storePath);
		mkdirSync(dir, { recursive: true });
		writeAtomic(join(dir, "tier0.json"), JSON.stringify(this.index.toJSON()));
		writeAtomic(join(dir, "manifest.json"), `${JSON.stringify(this.manifest, null, "\t")}\n`);
		this.dirty = false;
	}
}

/** `MEMORY.md`, `rules.md` and every topic file that exists. */
function derivedFiles(storePath: string): string[] {
	const paths: string[] = [];
	for (const name of ["MEMORY.md", "rules.md"]) {
		if (existsSync(join(storePath, name))) paths.push(name);
	}
	let topics: string[];
	try {
		topics = readdirSync(join(storePath, "topics"));
	} catch {
		return paths;
	}
	for (const name of topics.sort()) {
		if (name.endsWith(".md")) paths.push(`topics/${name}`);
	}
	return paths;
}

function readText(path: string, problems: string[]): string | undefined {
	try {
		return readFileSync(path, "utf-8");
	} catch (error) {
		problems.push(`unreadable: ${path} (${error instanceof Error ? error.message : String(error)})`);
		return undefined;
	}
}

/**
 * Load a persisted index, or nothing.
 *
 * Every failure — absent, truncated, written by another version, corrupt in a
 * way `minisearch` only discovers while loading — has the same answer: rebuild.
 * The index is derived, so there is never a reason to try to repair one.
 */
function load(storePath: string): { index?: Tier0Index; manifest?: Manifest; problems: string[] } {
	const dir = indexDir(storePath);
	const problems: string[] = [];
	if (!existsSync(join(dir, "manifest.json"))) return { problems };

	try {
		const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8")) as Manifest;
		if (manifest.version !== INDEX_VERSION || manifest.schema !== SCHEMA_VERSION) {
			return {
				problems: [
					`index rebuilt: built for index ${manifest.version}/schema ${manifest.schema}, this Muninn writes ${INDEX_VERSION}/${SCHEMA_VERSION}`,
				],
			};
		}
		const data = JSON.parse(readFileSync(join(dir, "tier0.json"), "utf-8")) as Tier0Data;
		return { index: Tier0Index.load(data), manifest, problems };
	} catch (error) {
		return { problems: [`index rebuilt: ${error instanceof Error ? error.message : String(error)}`] };
	}
}

function writeAtomic(path: string, text: string): void {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, text);
	renameSync(temporary, path);
}
