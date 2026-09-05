/** Append and lock-free scan engine for sharded project-journal JSONL. */
import {
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	writeSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { SigningMaterial } from "../governance/keys.ts";
import { isHostId, isMemberId } from "../ids.ts";
import { withStoreLock } from "../store/lock.ts";
import { ensureJournalDirectory, journalDirectoryExists, openJournalFile, UnsafeJournalPathError } from "./files.ts";
import {
	buildJournalRecord,
	type JournalRecord,
	type JournalRecordIdentity,
	MAX_RECORD_BYTES,
	type NewJournalRecord,
	parseJournalLine,
	serializeJournalRecord,
	validateJournalRecord,
} from "./record.ts";

export interface AppendJournalOptions extends JournalRecordIdentity {
	storePath: string;
	/** Enables this machine's prospective project policy for authorized writers. */
	agentDir?: string;
	now?: Date;
	id?: string;
	lockTimeoutMs?: number;
	/** Optional only so legacy/plain stores retain byte-for-byte behavior. */
	signing?: SigningMaterial;
	/** Authority-layer hook, evaluated after canonical construction and before append. */
	validateRecord?: (record: JournalRecord) => void;
}

export interface AppendJournalResult {
	id: string;
	path: string;
	shard: string;
	record: JournalRecord;
	bytes: number;
}

export interface JournalScanProblem {
	kind:
		| "truncated"
		| "malformed"
		| "unsupported"
		| "oversize"
		| "unreadable"
		| "collision"
		| "ownership"
		| "unsafe-path";
	path: string;
	line?: number;
	message: string;
}

export interface ScannedJournalRecord {
	record: JournalRecord;
	extensions: Record<string, unknown>;
	path: string;
	line: number;
	member: string;
	host: string;
	month: string;
}

export interface ScanJournalResult {
	records: ScannedJournalRecord[];
	problems: JournalScanProblem[];
}

const MONTH_FILE = /^(\d{4}-\d{2})\.jsonl$/;

export function monthOf(date: Date): string {
	return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function journalShardPath(storePath: string, memberId: string, hostId: string, date: Date): string {
	return join(storePath, "journal", memberId, hostId, `${monthOf(date)}.jsonl`);
}

export async function appendJournalRecord(
	input: NewJournalRecord,
	options: AppendJournalOptions,
): Promise<AppendJournalResult> {
	const lock = { host: options.host, ...(options.lockTimeoutMs ? { timeoutMs: options.lockTimeoutMs } : {}) };
	return withStoreLock(options.storePath, "append", lock, () => appendJournalRecordLocked(input, options));
}

/** Append with the store lock already held; used by atomic read-decide-write workflows. */
export function appendJournalRecordLocked(input: NewJournalRecord, options: AppendJournalOptions): AppendJournalResult {
	const now = options.now ?? new Date();
	const record = buildJournalRecord(input, { ...options, now });
	return appendCanonicalRecordLocked(record, options);
}

/** Internal prepared-write path. Caller owns authority validation and the store lock. */
export function appendCanonicalRecordLocked(record: JournalRecord, options: AppendJournalOptions): AppendJournalResult {
	validateJournalRecord(record);
	if (record.project !== options.project || record.member !== options.member || record.host !== options.host) {
		throw new Error("prepared journal record identity mismatch");
	}
	const now = new Date(record.at);
	options.validateRecord?.(record);
	const line = serializeJournalRecord(record);
	const path = journalShardPath(options.storePath, options.member, options.host, now);
	const scan = scanJournal(options.storePath);
	const unsafe = scan.problems.find((problem) => problem.kind === "unsafe-path");
	if (unsafe) throw new UnsafeJournalPathError(unsafe.path);
	const existing = scan.records.find((candidate) => candidate.record.id === record.id);
	if (existing) {
		if (serializeJournalRecord(existing.record) === line) {
			return {
				id: record.id,
				path: existing.path,
				shard: relative(options.storePath, existing.path).split("\\").join("/"),
				record: existing.record,
				bytes: Buffer.byteLength(line, "utf-8"),
			};
		}
		throw new Error(`journal id collision: ${record.id} already has different bytes in ${existing.path}`);
	}
	const dir = ensureJournalDirectory(options.storePath, options.member, options.host);
	const created = !existsSync(path);
	writeLine(path, line);
	if (created) fsyncDirectory(dir);
	return {
		id: record.id,
		path,
		shard: relative(options.storePath, path).split("\\").join("/"),
		record,
		bytes: Buffer.byteLength(line, "utf-8"),
	};
}

function writeLine(path: string, line: string): void {
	const fd = openJournalFile(path, true);
	try {
		const size = fstatSync(fd).size;
		const prefix = size > 0 && !endsWithNewline(fd, size) ? "\n" : "";
		const bytes = Buffer.from(`${prefix}${line}`, "utf-8");
		const written = writeSync(fd, bytes, 0, bytes.length);
		if (written !== bytes.length) throw new Error(`short journal append: wrote ${written} of ${bytes.length} bytes`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function endsWithNewline(fd: number, size: number): boolean {
	const last = Buffer.alloc(1);
	readSync(fd, last, 0, 1, size - 1);
	return last[0] === 0x0a;
}

function fsyncDirectory(path: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		fsyncSync(fd);
	} catch {
		// Windows and some filesystems reject directory fsync.
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

interface JournalShard {
	path: string;
	member: string;
	host: string;
	month: string;
}

export function listJournalShards(storePath: string, problems: JournalScanProblem[] = []): JournalShard[] {
	const shards: JournalShard[] = [];
	const root = join(storePath, "journal");
	for (const member of directoryEntries(root, problems)) {
		if (!isMemberId(member)) continue;
		for (const host of directoryEntries(join(root, member), problems)) {
			if (!isHostId(host)) continue;
			for (const file of directoryEntries(join(root, member, host), problems)) {
				const match = file.match(MONTH_FILE);
				if (!match) continue;
				const path = join(root, member, host, file);
				try {
					if (!lstatSync(path).isFile()) throw new UnsafeJournalPathError(path);
					shards.push({ path, member, host, month: match[1] as string });
				} catch (error) {
					problems.push(scanFileProblem(path, error));
				}
			}
		}
	}
	return shards;
}

function directoryEntries(path: string, problems: JournalScanProblem[]): string[] {
	try {
		return journalDirectoryExists(path) ? readdirSync(path).sort() : [];
	} catch (error) {
		problems.push(scanFileProblem(path, error));
		return [];
	}
}

function scanFileProblem(path: string, error: unknown): JournalScanProblem {
	return {
		kind: error instanceof UnsafeJournalPathError ? "unsafe-path" : "unreadable",
		path,
		message: describe(error),
	};
}

export function scanJournal(storePath: string): ScanJournalResult {
	const records: ScannedJournalRecord[] = [];
	const problems: JournalScanProblem[] = [];
	const ids = new Map<string, ScannedJournalRecord>();
	for (const shard of listJournalShards(storePath, problems)) {
		let bytes: Buffer;
		try {
			const fd = openJournalFile(shard.path);
			try {
				bytes = readFileSync(fd);
			} finally {
				closeSync(fd);
			}
		} catch (error) {
			problems.push(scanFileProblem(shard.path, error));
			continue;
		}
		const terminated = bytes.length === 0 || bytes[bytes.length - 1] === 0x0a;
		const lines = bytes.toString("utf-8").split("\n");
		if (terminated) lines.pop();
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index] as string;
			const lineNumber = index + 1;
			if (!terminated && index === lines.length - 1) {
				problems.push({
					kind: "truncated",
					path: shard.path,
					line: lineNumber,
					message: "final unterminated line ignored",
				});
				continue;
			}
			if (Buffer.byteLength(line, "utf-8") + 1 > MAX_RECORD_BYTES) {
				problems.push({ kind: "oversize", path: shard.path, line: lineNumber, message: "record exceeds 64 KiB" });
				continue;
			}
			if (line.trim() === "") continue;
			try {
				const parsed = parseJournalLine(line);
				if (parsed.record.member !== shard.member || parsed.record.host !== shard.host) {
					problems.push({
						kind: "ownership",
						path: shard.path,
						line: lineNumber,
						message: `record ${parsed.record.id} claims ${parsed.record.member}/${parsed.record.host}`,
					});
					continue;
				}
				const candidate: ScannedJournalRecord = { ...parsed, ...shard, line: lineNumber };
				const prior = ids.get(parsed.record.id);
				if (prior) {
					const same = serializeJournalRecord(prior.record) === serializeJournalRecord(parsed.record);
					if (!same) {
						problems.push({
							kind: "collision",
							path: shard.path,
							line: lineNumber,
							message: `record ${parsed.record.id} differs from ${prior.path}:${prior.line}`,
						});
					}
					continue;
				}
				ids.set(parsed.record.id, candidate);
				records.push(candidate);
			} catch (error) {
				const message = describe(error);
				problems.push({
					kind: message.startsWith("schema must be") ? "unsupported" : "malformed",
					path: shard.path,
					line: lineNumber,
					message,
				});
			}
		}
	}
	records.sort(
		(left, right) => left.record.at.localeCompare(right.record.at) || left.record.id.localeCompare(right.record.id),
	);
	return { records, problems };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
