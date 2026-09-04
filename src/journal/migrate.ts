/** Restartable migration from the Phase 1 Markdown journal into project JSONL. */
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { uuidv7Timestamp } from "../ids.ts";
import { parseStoreMd } from "../store/store-md.ts";
import type { JournalEntry } from "./format.ts";
import { appendJournalRecord, scanJournal } from "./jsonl.ts";
import { listJournalFiles, readDailyFile } from "./read.ts";
import { buildJournalRecord, type JournalRecord, type NewJournalRecord, serializeJournalRecord } from "./record.ts";

export const MIGRATION_SCHEMA = 1 as const;

export interface LegacyStoreInventory {
	path: string;
	store: string;
	aliases: string[];
	files: string[];
	fingerprint: string;
}

export interface MigrationSource {
	store: string;
	path: string;
	fingerprint: string;
	entries: number;
	imported: number;
	skipped: number;
	problems: number;
}

export interface MigrationManifest {
	schema: typeof MIGRATION_SCHEMA;
	project: string;
	completed_at: string;
	records: number;
	sources: MigrationSource[];
}

export interface MigrationProblem {
	path: string;
	message: string;
}

export interface MigrationResult {
	dryRun: boolean;
	considered: number;
	imported: number;
	skipped: number;
	bytes: number;
	sources: MigrationSource[];
	problems: MigrationProblem[];
	manifest?: MigrationManifest;
}

export function migrationManifestPath(storePath: string): string {
	return join(storePath, "migration.json");
}

/** Canonicalize, identify, fingerprint and de-duplicate candidate Markdown stores. */
export function inventoryLegacyStores(candidates: readonly string[]): LegacyStoreInventory[] {
	const byStore = new Map<string, LegacyStoreInventory>();
	for (const candidate of candidates) {
		let path: string;
		try {
			path = realpathSync(candidate);
		} catch {
			continue;
		}
		const files = listJournalFiles(path).map((file) => file.path);
		if (files.length === 0) continue;
		const parsed = existsSync(join(path, "store.md"))
			? parseStoreMd(readFileSync(join(path, "store.md"), "utf-8")).store
			: undefined;
		const id = parsed?.store ?? `path:${path}`;
		const prior = byStore.get(id);
		if (prior) {
			if (!prior.aliases.includes(path)) prior.aliases.push(path);
			continue;
		}
		byStore.set(id, {
			path,
			store: id,
			aliases: [path],
			files,
			fingerprint: fingerprintFiles(path, files),
		});
	}
	return [...byStore.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function fingerprintFiles(root: string, files: readonly string[]): string {
	const hash = createHash("sha256");
	for (const file of [...files].sort()) {
		hash.update(relative(root, file).split("\\").join("/"));
		hash.update("\0");
		hash.update(readFileSync(file));
		hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

/**
 * Discover the old checkout-slug and in-repository locations for registry roots.
 * A bounded one-level scan also finds stores created by older builds after a
 * checkout was renamed; only directories carrying store.md are admitted.
 */
export function discoverLegacyStoreCandidates(
	agentDir: string,
	locations: readonly { root: string }[],
	targetStore: string,
	configDirName = ".pi",
): string[] {
	const candidates = new Set<string>([targetStore]);
	const projectsRoot = join(agentDir, "muninn-projects");
	for (const location of locations) {
		candidates.add(join(projectsRoot, legacyProjectSlug(location.root)));
		candidates.add(join(location.root, configDirName, "muninn"));
	}
	try {
		for (const name of readdirSync(projectsRoot)) {
			const path = join(projectsRoot, name);
			if (path === targetStore || !existsSync(join(path, "store.md"))) continue;
			try {
				if (statSync(path).isDirectory()) candidates.add(path);
			} catch {
				// A disappearing unrelated directory is not a migration failure.
			}
		}
	} catch {
		// No legacy project root yet.
	}
	return [...candidates];
}

function legacyProjectSlug(root: string): string {
	const hash = createHash("sha256").update(root).digest("hex").slice(0, 12);
	const name = basename(root)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	return name === "" ? hash : `${name}-${hash}`;
}

export interface RunMarkdownMigrationOptions {
	targetStore: string;
	project: string;
	member: string;
	host: string;
	sources: readonly LegacyStoreInventory[];
	dryRun?: boolean;
	now?: Date;
	/** Failure injection: throw after this many successful appends. */
	failAfter?: number;
}

interface Candidate {
	source: LegacyStoreInventory;
	path: string;
	record: NewJournalRecord;
	id: string;
	at: Date;
}

export async function migrateMarkdownStores(options: RunMarkdownMigrationOptions): Promise<MigrationResult> {
	const existing = new Map(scanJournal(options.targetStore).records.map((item) => [item.record.id, item.record]));
	const candidates: Candidate[] = [];
	const problems: MigrationProblem[] = [];
	const sourceResults = new Map<string, MigrationSource>();

	for (const source of options.sources) {
		const summary: MigrationSource = {
			store: source.store,
			path: source.path,
			fingerprint: source.fingerprint,
			entries: 0,
			imported: 0,
			skipped: 0,
			problems: 0,
		};
		sourceResults.set(source.store, summary);
		for (const file of source.files) {
			const read = readDailyFile(file);
			for (const problem of read.problems) {
				problems.push({ path: problem.path, message: `${problem.kind}: ${problem.message}` });
				summary.problems++;
			}
			const fingerprint = `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
			for (const entry of read.entries) {
				summary.entries++;
				const timestamp = uuidv7Timestamp(entry.id.slice(2));
				if (timestamp === null) {
					problems.push({ path: file, message: `${entry.id}: UUIDv7 timestamp is unreadable` });
					summary.problems++;
					continue;
				}
				candidates.push({
					source,
					path: file,
					id: entry.id,
					at: new Date(timestamp),
					record: legacyRecord(entry, source, relative(source.path, file).split("\\").join("/"), fingerprint),
				});
			}
		}
	}

	candidates.sort((left, right) => left.at.getTime() - right.at.getTime() || left.id.localeCompare(right.id));
	let imported = 0;
	let skipped = 0;
	let bytes = 0;
	for (const candidate of candidates) {
		const summary = sourceResults.get(candidate.source.store) as MigrationSource;
		const prior = existing.get(candidate.id);
		if (prior) {
			const expected = materialize(candidate, options);
			if (serializeJournalRecord(prior) !== serializeJournalRecord(expected)) {
				problems.push({ path: candidate.path, message: `${candidate.id}: target contains different record bytes` });
				summary.problems++;
			} else {
				skipped++;
				summary.skipped++;
			}
			continue;
		}
		if (options.dryRun) {
			imported++;
			summary.imported++;
			continue;
		}
		const result = await appendJournalRecord(candidate.record, {
			storePath: options.targetStore,
			project: options.project,
			member: options.member,
			host: options.host,
			id: candidate.id,
			now: candidate.at,
		});
		existing.set(result.id, result.record);
		imported++;
		bytes += result.bytes;
		summary.imported++;
		if (options.failAfter !== undefined && imported >= options.failAfter) {
			throw new Error(`injected migration interruption after ${imported} records`);
		}
	}

	const sources = [...sourceResults.values()].sort((left, right) => left.path.localeCompare(right.path));
	const result: MigrationResult = {
		dryRun: options.dryRun === true,
		considered: candidates.length,
		imported,
		skipped,
		bytes,
		sources,
		problems,
	};
	if (options.dryRun) return result;

	const manifest: MigrationManifest = {
		schema: MIGRATION_SCHEMA,
		project: options.project,
		completed_at: (options.now ?? new Date()).toISOString(),
		records: scanJournal(options.targetStore).records.filter((item) => item.record.type === "import").length,
		sources,
	};
	writeMigrationManifest(options.targetStore, manifest);
	result.manifest = manifest;
	return result;
}

function materialize(candidate: Candidate, options: RunMarkdownMigrationOptions): JournalRecord {
	return buildJournalRecord(candidate.record, {
		project: options.project,
		member: options.member,
		host: options.host,
		id: candidate.id,
		now: candidate.at,
	});
}

function legacyRecord(
	entry: JournalEntry,
	source: LegacyStoreInventory,
	path: string,
	fingerprint: string,
): NewJournalRecord {
	const body =
		[entry.prose, ...entry.claims.map((claim) => `- ${claim}`)].filter(Boolean).join("\n\n") || "(empty legacy record)";
	const fields: Record<string, unknown> = {
		time: entry.time,
		prose: entry.prose,
		claims: entry.claims,
		...(entry.phase ? { phase: entry.phase } : {}),
		...(entry.promotedFrom ? { promoted_from: entry.promotedFrom } : {}),
		...(entry.extra ? { extra: entry.extra } : {}),
	};
	const session = entry.session ? splitPointer(entry.session) : undefined;
	return {
		type: "import",
		source: entry.source,
		channel: entry.channel ?? "unknown",
		...(entry.task ? { task: entry.task } : {}),
		...(entry.continues ? { continues: entry.continues } : {}),
		body,
		...(entry.cue ? { cue: entry.cue } : {}),
		tags: entry.phase ? [entry.phase] : [],
		paths: [],
		relations: [],
		...(session ? { session } : {}),
		legacy: { store: source.store, path, fingerprint, fields },
		...(entry.redacted ? { redacted: true } : {}),
	};
}

function splitPointer(pointer: string): { file: string; last?: string } {
	const hash = pointer.lastIndexOf("#");
	if (hash === -1) return { file: pointer };
	const last = pointer.slice(hash + 1);
	return { file: pointer.slice(0, hash), ...(last ? { last } : {}) };
}

export function parseMigrationManifest(text: string, path = "migration.json"): MigrationManifest {
	try {
		const raw = JSON.parse(text) as MigrationManifest;
		if (raw.schema !== MIGRATION_SCHEMA || typeof raw.project !== "string" || !Array.isArray(raw.sources)) {
			throw new Error("unsupported shape");
		}
		return raw;
	} catch (error) {
		throw new Error(
			`muninn: migration manifest at ${path} is invalid (${error instanceof Error ? error.message : String(error)})`,
		);
	}
}

function writeMigrationManifest(storePath: string, manifest: MigrationManifest): void {
	const path = migrationManifestPath(storePath);
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", 0o600);
		writeFileSync(fd, `${JSON.stringify(manifest, null, "\t")}\n`);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, path);
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(temporary, { force: true });
	}
}
