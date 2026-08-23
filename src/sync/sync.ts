/**
 * `muninn sync` — one store, many hosts, over ordinary git.
 *
 * Commit this host's journal → fetch → rebase onto the remote head → push.
 * That is the whole transaction, and it is conflict-free by construction:
 * journal files are per host directory, so no two machines ever write the same
 * file, and the derived layers change only through a remembered dream.
 *
 * Two consequences the code is shaped around:
 *
 *  - **The one conflict Phase 1 can resolve is `store.md`.** Two hosts
 *    registering themselves at the same time write the same registry file. That
 *    is a union of additions, so it is merged and the rebase continues. Any
 *    other conflict — a hand-edited topic file, two remembered dreams — aborts
 *    the rebase, leaves the store exactly where it was, and reports. Sync never
 *    force-pushes and never resolves a disagreement it does not understand.
 *  - **Offline is a normal outcome, not a failure.** A fetch that cannot reach
 *    the remote leaves the journal committed locally and says so once. The
 *    entries are durable either way; the next sync takes them.
 *
 * The whole transaction runs under the store lock, so a capture append on this
 * host cannot land between the commit and the push.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitJournalLocked } from "../capture/commit.ts";
import { GitError, git, isGitRepository } from "../git.ts";
import { withStoreLock } from "../store/lock.ts";
import { formatStoreMd, mergeStoreMd, parseStoreMd } from "../store/store-md.ts";

/** The remote Muninn keeps pointed at `sync.remote`. */
export const REMOTE_NAME = "origin";

export interface SyncOptions {
	storePath: string;
	hostId: string;
	hostName: string;
	/**
	 * The remote this store is configured to sync with, or null.
	 *
	 * `sync.remote` names the **global** store's remote. A project store has no
	 * setting of its own — a project `settings.json` may not name a remote, since
	 * it travels with a repository anyone can clone — so it syncs with whatever
	 * `origin` its own repository already has, and otherwise commits locally.
	 */
	remote: string | null;
	/**
	 * Whether an `origin` the store already has may be used when `remote` is
	 * null. False for an in-repo store: that repository belongs to the project,
	 * and pushing it would push the user's own code.
	 */
	useExistingRemote?: boolean;
	/** Entries appended since the last commit; used for the commit message. */
	entries?: number;
	/** Stop before the network steps. The shutdown path passes a 10 s deadline. */
	signal?: AbortSignal;
	/** Skip the push — for a run that only wants the store up to date locally. */
	noPush?: boolean;
}

export type SyncStep = "commit" | "fetch" | "rebase" | "push";

export interface SyncResult {
	committed: boolean;
	fetched: boolean;
	rebased: boolean;
	pushed: boolean;
	/** True when `store.md` was union-merged during the rebase. */
	mergedRegistry: boolean;
	/** One line per step, in order, for `/muninn` and the CLI. */
	notes: string[];
	/** Where it stopped, when it stopped early. */
	stoppedAt?: SyncStep;
	problem?: string;
	/** True when the remote could not be reached — offline, not broken. */
	offline?: boolean;
}

function empty(): SyncResult {
	return { committed: false, fetched: false, rebased: false, pushed: false, mergedRegistry: false, notes: [] };
}

/**
 * Run the sync transaction.
 *
 * Never throws for an ordinary failure: a store with no remote, an unreachable
 * network and a conflicting rebase are all outcomes a caller reports rather
 * than crashes.
 */
export async function sync(options: SyncOptions): Promise<SyncResult> {
	const result = empty();

	if (!(await isGitRepository(options.storePath))) {
		result.problem = `${options.storePath} is not a git repository`;
		result.stoppedAt = "commit";
		return result;
	}

	return withStoreLock(options.storePath, "sync", { host: options.hostId }, async () => {
		// --- commit --------------------------------------------------------
		const committed = await commitJournalLocked({
			storePath: options.storePath,
			hostId: options.hostId,
			hostName: options.hostName,
			entries: options.entries ?? 0,
			force: true,
		});
		result.committed = committed.committed;
		result.notes.push(committed.committed ? "committed pending journal entries" : `commit: ${committed.reason}`);

		const remote = await resolveRemote(options, result);
		if (!remote) {
			result.stoppedAt = "fetch";
			return result;
		}
		const branch = await currentBranch(options.storePath);

		// --- fetch ---------------------------------------------------------
		if (options.signal?.aborted) return stop(result, "fetch", "sync ran out of time before fetching");
		try {
			await git(
				options.storePath,
				{ kind: "fetch", remote: REMOTE_NAME },
				options.signal ? { signal: options.signal } : {},
			);
			result.fetched = true;
			result.notes.push(`fetched ${REMOTE_NAME}`);
		} catch (error) {
			// Offline is the common case and not an error: the entries are
			// committed, and the next sync will carry them.
			result.offline = true;
			result.stoppedAt = "fetch";
			result.problem = `could not reach ${remote}: ${describe(error)}`;
			result.notes.push("offline — journal committed locally, nothing pushed");
			return result;
		}

		// --- rebase --------------------------------------------------------
		const remoteRef = `${REMOTE_NAME}/${branch}`;
		if (await refExists(options.storePath, remoteRef)) {
			if (options.signal?.aborted) return stop(result, "rebase", "sync ran out of time before rebasing");
			const rebased = await rebaseOnto(options.storePath, remoteRef, result);
			if (!rebased) return result;
		} else {
			result.notes.push(`${remoteRef} does not exist yet — this is the first push`);
		}

		// --- push ----------------------------------------------------------
		if (options.noPush) {
			result.notes.push("push skipped");
			return result;
		}
		if (options.signal?.aborted) return stop(result, "push", "sync ran out of time before pushing");
		try {
			await git(
				options.storePath,
				{ kind: "push", remote: REMOTE_NAME, branch },
				options.signal ? { signal: options.signal } : {},
			);
			result.pushed = true;
			result.notes.push(`pushed to ${REMOTE_NAME}/${branch}`);
		} catch (error) {
			result.stoppedAt = "push";
			// A rejected push means another host pushed between our fetch and
			// now. Re-running is the whole fix, and it is safe.
			result.problem = `push rejected: ${describe(error)}`;
			result.notes.push("push rejected — run sync again to pick up the other host's commits");
		}

		return result;
	});
}

function stop(result: SyncResult, step: SyncStep, problem: string): SyncResult {
	result.stoppedAt = step;
	result.problem = problem;
	result.notes.push(problem);
	return result;
}

function describe(error: unknown): string {
	if (error instanceof GitError) return error.stderr.trim().split("\n")[0] || error.message;
	return error instanceof Error ? error.message : String(error);
}

/**
 * Where this store pushes, or nothing.
 *
 * A configured remote is the authority and is written into the store's
 * `origin`, because memory goes where the operator says it goes and a stale
 * remote nobody remembers configuring is worse than a rewritten one. With no
 * setting, an `origin` the store already has is used — that is how a project
 * store, which has no setting of its own, syncs at all.
 */
async function resolveRemote(options: SyncOptions, result: SyncResult): Promise<string | undefined> {
	let current: string | undefined;
	try {
		current = (await git(options.storePath, { kind: "remote-get-url", name: REMOTE_NAME })).stdout.trim() || undefined;
	} catch {
		current = undefined;
	}

	if (!options.remote) {
		if (options.useExistingRemote === false) {
			result.notes.push("in-repo store — committed locally, never pushed by muninn");
			return undefined;
		}
		if (!current) {
			result.notes.push("no remote configured — committed locally only");
			return undefined;
		}
		result.notes.push(`using the store's own remote ${REMOTE_NAME} → ${current}`);
		return current;
	}

	if (current === options.remote) return options.remote;
	if (current === undefined) {
		await git(options.storePath, { kind: "remote-add", name: REMOTE_NAME, url: options.remote });
		result.notes.push(`added remote ${REMOTE_NAME} → ${options.remote}`);
		return options.remote;
	}
	await git(options.storePath, { kind: "remote-set-url", name: REMOTE_NAME, url: options.remote });
	result.notes.push(`remote ${REMOTE_NAME} now points at ${options.remote}`);
	return options.remote;
}

async function currentBranch(storePath: string): Promise<string> {
	const { stdout } = await git(storePath, { kind: "rev-parse", target: "--abbrev-ref" });
	const branch = stdout.trim();
	// A detached HEAD has no branch to push; `main` is a guess that would push
	// the wrong thing, so it is refused rather than guessed at.
	if (branch === "" || branch === "HEAD") throw new Error("muninn: the store is not on a branch");
	return branch;
}

async function refExists(storePath: string, ref: string): Promise<boolean> {
	try {
		await git(storePath, { kind: "verify-ref", ref });
		return true;
	} catch {
		return false;
	}
}

/**
 * Rebase onto the remote head, resolving a `store.md` conflict if that is all
 * there is.
 */
async function rebaseOnto(storePath: string, remoteRef: string, result: SyncResult): Promise<boolean> {
	try {
		await git(storePath, { kind: "rebase", onto: remoteRef });
		result.rebased = true;
		result.notes.push(`rebased onto ${remoteRef}`);
		return true;
	} catch (error) {
		const conflicts = await conflictedPaths(storePath);
		if (conflicts.length === 1 && conflicts[0] === "store.md") {
			const merged = await mergeRegistry(storePath, result);
			if (merged) return true;
		}

		await abort(storePath);
		result.stoppedAt = "rebase";
		result.problem =
			conflicts.length > 0
				? `rebase onto ${remoteRef} conflicts in ${conflicts.join(", ")}; the store is unchanged`
				: `rebase onto ${remoteRef} failed: ${describe(error)}`;
		result.notes.push(result.problem);
		return false;
	}
}

/** `UU store.md` → `store.md`. */
async function conflictedPaths(storePath: string): Promise<string[]> {
	const { stdout } = await git(storePath, { kind: "status-porcelain", paths: [] });
	const paths: string[] = [];
	for (const line of stdout.split("\n")) {
		if (line.trim() === "") continue;
		const code = line.slice(0, 2);
		if (code === "UU" || code === "AA" || code[0] === "U" || code[1] === "U") paths.push(line.slice(3).trim());
	}
	return paths;
}

async function mergeRegistry(storePath: string, result: SyncResult): Promise<boolean> {
	try {
		const ours = parseStoreMd((await git(storePath, { kind: "show-stage", stage: 2, path: "store.md" })).stdout);
		const theirs = parseStoreMd((await git(storePath, { kind: "show-stage", stage: 3, path: "store.md" })).stdout);
		if (!ours.store || !theirs.store) return false;

		writeFileSync(join(storePath, "store.md"), formatStoreMd(mergeStoreMd(ours.store, theirs.store)));
		await git(storePath, { kind: "add", paths: ["store.md"] });
		await git(storePath, { kind: "rebase-continue" });

		result.rebased = true;
		result.mergedRegistry = true;
		result.notes.push("merged store.md host registries and continued the rebase");
		return true;
	} catch (error) {
		result.notes.push(`could not merge store.md: ${describe(error)}`);
		return false;
	}
}

async function abort(storePath: string): Promise<void> {
	try {
		await git(storePath, { kind: "rebase-abort" });
	} catch {
		// Nothing to abort, or git already cleaned up: either way the caller is
		// about to report a conflict, and this must not replace that report.
	}
}

/** Read a store's `store.md` — used by the CLI to name the store it is syncing. */
export function readStoreId(storePath: string): string | undefined {
	try {
		return parseStoreMd(readFileSync(join(storePath, "store.md"), "utf-8")).store?.store;
	} catch {
		return undefined;
	}
}

/** One line describing a finished sync, for a status report or a terminal. */
export function describeSync(result: SyncResult): string {
	if (result.problem) return `sync stopped at ${result.stoppedAt ?? "start"}: ${result.problem}`;
	const did = [
		result.committed ? "committed" : null,
		result.fetched ? "fetched" : null,
		result.rebased ? "rebased" : null,
		result.pushed ? "pushed" : null,
	].filter((part): part is string => part !== null);
	return did.length > 0 ? `sync: ${did.join(", ")}` : "sync: nothing to do";
}
