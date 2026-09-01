/** Append and lock-free scan engine for sharded project-journal JSONL. */
import {
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
	writeSync,
} from "node:fs";
import { join, relative } from "node:path";
import { isHostId, isMemberId } from "../ids.ts";
import { withStoreLock } from "../store/lock.ts";
import {
	buildJournalRecord,
	type JournalRecord,
	type JournalRecordIdentity,
	MAX_RECORD_BYTES,
	type NewJournalRecord,
	parseJournalLine,
	serializeJournalRecord,
} from "./record.ts";

export interface AppendJournalOptions extends JournalRecordIdentity {
	storePath: string;
	now?: Date;
	id?: string;
	lockTimeoutMs?: number;
}

export interface AppendJournalResult {
	id: string;
	path: string;
	shard: string;
	record: JournalRecord;
	bytes: number;
}

export interface JournalScanProblem {
	kind: "truncated" | "malformed" | "unsupported" | "oversize" | "unreadable" | "collision" | "ownership";
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
	const now = options.now ?? new Date();
	const record = buildJournalRecord(input, { ...options, now });
	const line = serializeJournalRecord(record);
	const path = journalShardPath(options.storePath, options.member, options.host, now);
	const lock = { host: options.host, ...(options.lockTimeoutMs ? { timeoutMs: options.lockTimeoutMs } : {}) };

	await withStoreLock(options.storePath, "append", lock, () => {
		const existing = scanJournal(options.storePath).records.find((candidate) => candidate.record.id === record.id);
		if (existing) {
			if (serializeJournalRecord(existing.record) === line) return;
			throw new Error(`journal id collision: ${record.id} already has different bytes in ${existing.path}`);
		}
		const dir = join(options.storePath, "journal", options.member, options.host);
		const created = !existsSync(path);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeLine(path, line);
		if (created) fsyncDirectory(dir);
	});

	return {
		id: record.id,
		path,
		shard: relative(options.storePath, path).split("\\").join("/"),
		record,
		bytes: Buffer.byteLength(line, "utf-8"),
	};
}

function writeLine(path: string, line: string): void {
	const fd = openSync(path, "a+", 0o600);
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

export function listJournalShards(storePath: string): JournalShard[] {
	const shards: JournalShard[] = [];
	const root = join(storePath, "journal");
	for (const member of directories(root)) {
		if (!isMemberId(member)) continue;
		for (const host of directories(join(root, member))) {
			if (!isHostId(host)) continue;
			let files: string[];
			try {
				files = readdirSync(join(root, member, host)).sort();
			} catch {
				continue;
			}
			for (const file of files) {
				const match = file.match(MONTH_FILE);
				if (match) shards.push({ path: join(root, member, host, file), member, host, month: match[1] as string });
			}
		}
	}
	return shards;
}

function directories(path: string): string[] {
	let names: string[];
	try {
		names = readdirSync(path).sort();
	} catch {
		return [];
	}
	return names.filter((name) => {
		try {
			return statSync(join(path, name)).isDirectory();
		} catch {
			return false;
		}
	});
}

export function scanJournal(storePath: string): ScanJournalResult {
	const records: ScannedJournalRecord[] = [];
	const problems: JournalScanProblem[] = [];
	const ids = new Map<string, ScannedJournalRecord>();
	for (const shard of listJournalShards(storePath)) {
		let bytes: Buffer;
		try {
			bytes = readFileSync(shard.path);
		} catch (error) {
			problems.push({ kind: "unreadable", path: shard.path, message: describe(error) });
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
