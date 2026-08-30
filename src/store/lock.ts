/**
 * The store lock.
 *
 * One exclusive lock per store. Capture holds it per append for milliseconds;
 * sync and migration hold it for their whole duration. Two operations on one
 * host are excluded by it; two hosts are not, and meet at sync.
 *
 * `proper-lockfile` does the locking — the same library, and so the same
 * semantics, pi uses for `settings.json`. It refreshes the lock's mtime while
 * held, which keeps a long migration from being mistaken for a dead writer.
 *
 * The holder's identity lives in a *sibling* file, `.lock.json`, not inside the
 * lock directory: proper-lockfile removes its lock with a non-recursive
 * `rmdir` (lib/lockfile.js:90), so any file placed inside would make every
 * release and every stale-break fail silently and wedge the store for good.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";

export type LockOperation = "append" | "commit" | "init" | "sync" | "migrate";

/**
 * How long a held lock may go without an mtime refresh before another process
 * treats it as dead. Appends take milliseconds, so 30 s already means "the
 * writer died"; a migration may be a long job and gets a 2 h window.
 */
const STALE_MS: Record<LockOperation, number> = {
	append: 30_000,
	commit: 60_000,
	init: 30_000,
	sync: 120_000,
	migrate: 7_200_000,
};

/** Total time spent retrying before giving up, per the plan's 5 s budget. */
const ACQUIRE_TIMEOUT_MS = 5_000;

export interface LockHolder {
	pid: number;
	host: string;
	operation: LockOperation;
	at: string;
}

export interface WithStoreLockOptions {
	/** Host id recorded in `.lock.json`, so a stuck lock names the machine holding it. */
	host: string;
	/** Overrides the per-operation staleness window. Tests use it; callers should not. */
	staleMs?: number;
	/** Overrides the acquire timeout. Tests use it; callers should not. */
	timeoutMs?: number;
}

export class LockBusyError extends Error {
	readonly holder: LockHolder | undefined;
	constructor(storePath: string, operation: LockOperation, holder: LockHolder | undefined) {
		const held = holder
			? `held by pid ${holder.pid} on host ${holder.host} for "${holder.operation}" since ${holder.at}`
			: "holder unknown";
		super(`muninn: store lock at ${storePath} is busy (${held}); "${operation}" not started`);
		this.name = "LockBusyError";
		this.holder = holder;
	}
}

export function lockPath(storePath: string): string {
	return join(storePath, ".lock");
}

export function lockMetaPath(storePath: string): string {
	return join(storePath, ".lock.json");
}

/** Who holds the lock right now, as far as the metadata file knows. */
export function readLockHolder(storePath: string): LockHolder | undefined {
	try {
		const parsed = JSON.parse(readFileSync(lockMetaPath(storePath), "utf-8")) as Partial<LockHolder>;
		if (typeof parsed.pid !== "number" || typeof parsed.host !== "string") return undefined;
		return parsed as LockHolder;
	} catch {
		return undefined;
	}
}

/**
 * Run `fn` with the store lock held.
 *
 * Failure to acquire throws `LockBusyError` rather than proceeding unlocked —
 * an append that skipped the lock could interleave with another and corrupt a
 * daily file, which is exactly the failure the journal format cannot repair.
 */
export async function withStoreLock<T>(
	storePath: string,
	operation: LockOperation,
	options: WithStoreLockOptions,
	fn: () => Promise<T> | T,
): Promise<T> {
	const stale = options.staleMs ?? STALE_MS[operation];
	const timeout = options.timeoutMs ?? ACQUIRE_TIMEOUT_MS;

	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(storePath, {
			lockfilePath: lockPath(storePath),
			stale,
			// Exponential backoff with jitter, bounded by the acquire budget.
			retries: { retries: 10, factor: 1.6, minTimeout: 20, maxTimeout: 1_000, randomize: true, maxRetryTime: timeout },
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
			throw new LockBusyError(storePath, operation, readLockHolder(storePath));
		}
		throw error;
	}

	const holder: LockHolder = { pid: process.pid, host: options.host, operation, at: new Date().toISOString() };
	try {
		writeFileSync(lockMetaPath(storePath), `${JSON.stringify(holder, null, "\t")}\n`);
	} catch {
		// Diagnostics only: failing to record who holds the lock must not stop
		// the work the lock was taken for.
	}

	try {
		return await fn();
	} finally {
		rmSync(lockMetaPath(storePath), { force: true });
		await release();
	}
}
