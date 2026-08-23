/**
 * Appending to the journal.
 *
 * Journal files are per host directory and per day, so sync never has to merge
 * two hosts' writes to one file. Within a host, several pi sessions append to
 * the same daily file; each append takes the store lock for a few
 * milliseconds, writes the whole entry with one `write`, `fsync`s, and
 * releases.
 *
 * The id is minted *before* the lock is taken. The lock protects file
 * integrity only, never the id: a UUIDv7 needs no coordination, so holding the
 * lock across id generation would buy nothing and cost contention. Ids are
 * therefore in creation order per writer, not globally ordered within a file —
 * readers must not assume otherwise.
 */
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { newEntryId } from "../ids.ts";
import { withStoreLock } from "../store/lock.ts";
import { claimsOf, formatDate, formatEntry, formatTime, type JournalEntry } from "./format.ts";

/** Everything about an entry except the parts append itself decides. */
export type NewJournalEntry = Omit<JournalEntry, "id" | "time">;

export interface AppendOptions {
	storePath: string;
	hostId: string;
	/** Overrides the clock. Tests use it; callers should not. */
	now?: Date;
}

export interface AppendResult {
	id: string;
	/** Addresses of the claims just written, in order. */
	claimIds: string[];
	path: string;
}

export function journalDir(storePath: string, hostId: string): string {
	return join(storePath, "journal", hostId);
}

export function dailyFilePath(storePath: string, hostId: string, date: Date): string {
	return join(journalDir(storePath, hostId), `${formatDate(date)}.md`);
}

/**
 * Append one entry to today's file for this host.
 *
 * Returns the id and claim addresses so the caller can record what it wrote
 * without re-reading the file.
 */
export async function appendEntry(entry: NewJournalEntry, options: AppendOptions): Promise<AppendResult> {
	const now = options.now ?? new Date();
	const id = newEntryId();
	const full: JournalEntry = { ...entry, id, time: formatTime(now) };
	const block = formatEntry(full);
	const path = dailyFilePath(options.storePath, options.hostId, now);

	await withStoreLock(options.storePath, "append", { host: options.hostId }, () => {
		const dir = journalDir(options.storePath, options.hostId);
		// Both checks must happen before the write: afterwards the file always
		// exists and the test would never fire.
		const dirExisted = existsSync(dir);
		const fileExisted = dirExisted && existsSync(path);
		if (!dirExisted) mkdirSync(dir, { recursive: true });
		writeBlock(path, block);
		// A newly created file is only durable once its directory entry is too —
		// fsync on the file alone does not put the name in the directory. Only
		// needed on the first append of a day. Best-effort: not every platform
		// permits it, and failing to fsync a directory must not fail the append.
		if (!fileExisted) fsyncDirectory(dir);
	});

	return { id, claimIds: claimsOf(full).map((claim) => claim.id), path };
}

/**
 * One `write` of the whole entry, then `fsync`.
 *
 * If the file does not already end with a newline — the signature of a crash
 * partway through a previous append — a newline is prepended so this entry
 * starts on a fresh line. The damaged entry stays in the file and is reported
 * by the reader; it is never silently repaired, because guessing at what a
 * half-written entry meant is worse than showing it.
 */
function writeBlock(path: string, block: string): void {
	const fd = openSync(path, "a");
	try {
		const size = fstatSync(fd).size;
		const needsNewline = size > 0 && !endsWithNewline(path, size);
		writeSync(fd, needsNewline ? `\n${block}` : block);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function endsWithNewline(path: string, size: number): boolean {
	const fd = openSync(path, "r");
	try {
		const last = Buffer.alloc(1);
		readSync(fd, last, 0, 1, size - 1);
		return last[0] === 0x0a;
	} finally {
		closeSync(fd);
	}
}

function fsyncDirectory(dir: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(dir, "r");
		fsyncSync(fd);
	} catch {
		// Windows cannot fsync a directory, and some filesystems refuse it.
		// Durability of the file's own contents is already assured above.
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Nothing useful to do if the descriptor is already gone.
			}
		}
	}
}
