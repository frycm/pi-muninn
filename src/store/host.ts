/**
 * This machine's identity.
 *
 * One host id per machine, minted on first run and stored outside any store, so
 * that every store this machine writes to agrees on who is writing. Journal
 * files are per host directory, which is what keeps sync from ever having to
 * merge two machines' writes to one file — so the host id is load-bearing, not
 * decorative.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { isHostId, newHostId } from "../ids.ts";
import { hostFilePath } from "./paths.ts";

export interface HostIdentity {
	id: string;
	name: string;
	createdAt: string;
}

/** `MacBook-Pro.local` → `macbook-pro`. Display only; nothing is keyed on it. */
export function shortHostname(raw: string): string {
	const short = raw.split(".")[0] ?? raw;
	const cleaned = short
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	return cleaned === "" ? "host" : cleaned;
}

/**
 * Read this machine's identity, minting it on first run.
 *
 * Deliberately not under the store lock: the file lives outside every store,
 * and the lock cannot be taken until the host id exists to record in it. Two
 * pi sessions racing on first run is handled by writing atomically and
 * re-reading — the loser adopts the winner's id rather than overwriting it.
 */
export function loadHostIdentity(agentDir: string): HostIdentity {
	const path = hostFilePath(agentDir);

	const existing = readHostFile(path);
	if (existing) return existing;

	const identity: HostIdentity = {
		id: newHostId(),
		name: shortHostname(hostname()),
		createdAt: new Date().toISOString(),
	};

	const root = dirname(path);
	mkdirSync(root, { recursive: true });
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	let fd: number | undefined;
	let published = false;
	try {
		fd = openSync(temporary, "wx", 0o600);
		writeFileSync(fd, `${JSON.stringify(identity, null, "\t")}\n`, "utf-8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		try {
			// Publishing the already-complete inode makes first creation atomic:
			// another process can observe no path or the whole file, never a
			// partially written winner.
			linkSync(temporary, path);
			published = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(temporary, { force: true });
	}
	if (published) fsyncDirectory(root);
	const winner = readHostFile(path);
	if (winner) return winner;
	throw new Error(`muninn: ${path} exists but could not be read`);
}

function fsyncDirectory(path: string): void {
	try {
		const directory = openSync(path, "r");
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
	} catch {
		// Windows and some filesystems do not permit fsync on a directory.
	}
}

function readHostFile(path: string): HostIdentity | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}

	try {
		const parsed = JSON.parse(raw) as Partial<HostIdentity>;
		if (typeof parsed.id !== "string" || !isHostId(parsed.id)) return undefined;
		return {
			id: parsed.id,
			name: typeof parsed.name === "string" && parsed.name !== "" ? parsed.name : shortHostname(hostname()),
			createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
		};
	} catch {
		return undefined;
	}
}
