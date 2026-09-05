/** Filesystem boundary below an owned store root (the root itself may have a local alias). */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { isHostId, isMemberId } from "../ids.ts";

export class UnsafeJournalPathError extends Error {
	constructor(path: string) {
		super(`unsafe journal path ${path}: symbolic links and non-regular data paths are forbidden`);
		this.name = "UnsafeJournalPathError";
	}
}

/** Check each component before traversing or creating descendants; never follow links below the store. */
export function journalDirectoryExists(path: string): boolean {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (!stat) return false;
	if (!stat.isDirectory()) throw new UnsafeJournalPathError(path);
	return true;
}

export function ensureJournalDirectory(storePath: string, member: string, host: string): string {
	if (!isMemberId(member) || !isHostId(host)) throw new Error("invalid journal member/host identity");
	let path = storePath;
	for (const component of ["journal", member, host]) {
		path = join(path, component);
		if (!journalDirectoryExists(path)) {
			mkdirSync(path, { mode: 0o700 });
			journalDirectoryExists(path);
		}
	}
	return path;
}

/** The final component is checked atomically at open; nonblocking open also rejects FIFOs without hanging. */
export function openJournalFile(path: string, append = false): number {
	const access = append ? constants.O_RDWR | constants.O_CREAT | constants.O_APPEND : constants.O_RDONLY;
	let fd: number;
	try {
		fd = openSync(path, access | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new UnsafeJournalPathError(path);
		throw error;
	}
	try {
		if (!fstatSync(fd).isFile()) throw new UnsafeJournalPathError(path);
		return fd;
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}
