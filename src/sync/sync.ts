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
import { GitError, type GitIdentity, GitMissingError, git, isGitRepository } from "../git.ts";
import { LockBusyError, withStoreLock } from "../store/lock.ts";
import { formatStoreMd, mergeStoreMd, parseStoreMd, type StoreMd } from "../store/store-md.ts";

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
	/** The identity commits and the rebase run under. Absent for an in-repo store. */
	identity?: GitIdentity;
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

	try {
		if (!(await isGitRepository(options.storePath))) {
			result.problem = `${options.storePath} is not a git repository`;
			result.stoppedAt = "commit";
			return result;
		}
	} catch (error) {
		// Without git there is nothing sync can do, and saying so is the whole
		// remedy: install git, run it again.
		return stop(result, "commit", error instanceof GitMissingError ? error.message : describe(error));
	}

	// Every failure inside the transaction becomes a result, never a throw: a
	// detached HEAD, a malformed remote URL, an unborn branch — each is a
	// message the operator can act on, and a rejection would reach them as a
	// stack trace from cron or as "capture failed" at shutdown, which is the
	// wrong diagnosis in the wrong place.
	try {
		return await withStoreLock(options.storePath, "sync", { host: options.hostId }, () => transaction(options, result));
	} catch (error) {
		if (error instanceof LockBusyError) {
			return stop(result, "commit", `the store is busy (${error.message}); sync not started`);
		}
		return stop(result, result.stoppedAt ?? "commit", describe(error));
	}
}

async function transaction(options: SyncOptions, result: SyncResult): Promise<SyncResult> {
	{
		// --- commit --------------------------------------------------------
		const committed = await commitJournalLocked({
			storePath: options.storePath,
			hostId: options.hostId,
			hostName: options.hostName,
			entries: options.entries ?? 0,
			force: true,
			...(options.identity ? { identity: options.identity } : {}),
		});
		result.committed = committed.committed;
		result.notes.push(committed.committed ? "committed pending journal entries" : `commit: ${committed.reason}`);

		const remote = await resolveRemote(options, result);
		if (!remote) {
			result.stoppedAt = "fetch";
			return result;
		}
		// Anything past here that throws is a stopped transaction, and the step
		// it stopped at is the one it was about to run.
		result.stoppedAt = "fetch";
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
			result.stoppedAt = "fetch";
			result.problem = `could not reach ${remote}: ${describe(error)}`;
			// Only a transient network failure is "offline". An authentication
			// failure, a remote that does not exist, a malformed URL: those do not
			// fix themselves overnight, and reporting them as offline is how a
			// cron job fails silently for a month while exiting 0.
			if (isTransient(error)) {
				result.offline = true;
				result.notes.push("offline — journal committed locally, nothing pushed");
			} else {
				result.notes.push(`fetch failed, and will keep failing until it is fixed: ${describe(error)}`);
			}
			return result;
		}

		// --- rebase --------------------------------------------------------
		const remoteRef = `${REMOTE_NAME}/${branch}`;
		if (await refExists(options.storePath, remoteRef)) {
			// Whose store is that? A mistyped remote is otherwise resolved by
			// rebasing one store's history onto another's and pushing the result:
			// two unrelated memories, merged, on a remote neither of them owns.
			const mismatch = await storeMismatch(options.storePath, remoteRef);
			if (mismatch) return stop(result, "rebase", mismatch);
			if (options.signal?.aborted) return stop(result, "rebase", "sync ran out of time before rebasing");
			result.stoppedAt = "rebase";
			const rebased = await rebaseOnto(options.storePath, remoteRef, result, options.identity);
			if (!rebased) return result;
		} else {
			result.notes.push(`${remoteRef} does not exist yet — this is the first push`);
		}

		// --- push ----------------------------------------------------------
		if (options.noPush) {
			delete result.stoppedAt;
			result.notes.push("push skipped");
			return result;
		}
		if (options.signal?.aborted) return stop(result, "push", "sync ran out of time before pushing");
		result.stoppedAt = "push";
		try {
			await git(
				options.storePath,
				{ kind: "push", remote: REMOTE_NAME, branch },
				options.signal ? { signal: options.signal } : {},
			);
			result.pushed = true;
			delete result.stoppedAt;
			result.notes.push(`pushed to ${REMOTE_NAME}/${branch}`);
		} catch (error) {
			result.stoppedAt = "push";
			// A rejected push means another host pushed between our fetch and
			// now. Re-running is the whole fix, and it is safe.
			result.problem = `push rejected: ${describe(error)}`;
			result.notes.push("push rejected — run sync again to pick up the other host's commits");
		}

		return result;
	}
}

function stop(result: SyncResult, step: SyncStep, problem: string): SyncResult {
	result.stoppedAt = step;
	result.problem = problem;
	result.notes.push(problem);
	return result;
}

/**
 * Network conditions that mean "try again later", named narrowly.
 *
 * Anything not on this list is treated as a fault that needs a person, which
 * is the safe direction to be wrong in: a transient failure reported as an
 * error costs one confusing line, and a permanent failure reported as
 * transient costs every sync until someone notices.
 */
const TRANSIENT = [
	/could not resolve host/i,
	/temporary failure in name resolution/i,
	/connection refused/i,
	/connection timed out/i,
	/operation timed out/i,
	/network is unreachable/i,
	/no route to host/i,
	/connection reset by peer/i,
];

function isTransient(error: unknown): boolean {
	const text = error instanceof GitError ? error.stderr : error instanceof Error ? error.message : String(error);
	return TRANSIENT.some((pattern) => pattern.test(text));
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
	if (!options.remote && options.useExistingRemote === false) {
		result.notes.push("in-repo store — committed locally, never pushed by muninn");
		return undefined;
	}

	let current: string | undefined;
	try {
		current = (await git(options.storePath, { kind: "remote-get-url", name: REMOTE_NAME })).stdout.trim() || undefined;
	} catch {
		current = undefined;
	}

	if (!options.remote) {
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
	// `symbolic-ref` answers on an unborn branch too; it fails only when HEAD
	// is detached, which is someone looking at history — refused, not guessed.
	try {
		const branch = (await git(storePath, { kind: "current-branch" })).stdout.trim();
		if (branch !== "") return branch;
	} catch {
		// Fall through to the one message.
	}
	throw new Error("the store is not on a branch (detached HEAD); check out its branch and run sync again");
}

/**
 * A message when the remote is not this store's, or nothing.
 *
 * The store id is the identity guard the format already has, and this is the
 * one place to check it: after the fetch, before anything is written. The
 * check is *positive* — the remote must prove it is the same store — because
 * every way of failing to prove it is a way of pushing memory somewhere it
 * does not belong:
 *
 *  - no `store.md` at all: an existing branch that is not a muninn store, and
 *    rebasing onto it would graft the store into an unrelated history;
 *  - an unreadable one: a store this Muninn cannot reason about;
 *  - a different id: two stores, one remote, a typo.
 *
 * The genuine first push has no `origin/<branch>` ref at all and never reaches
 * this function.
 */
async function storeMismatch(storePath: string, remoteRef: string): Promise<string | undefined> {
	let ours: StoreMd | undefined;
	try {
		ours = parseStoreMd(readFileSync(join(storePath, "store.md"), "utf-8")).store;
	} catch {
		ours = undefined;
	}
	if (!ours) return `${storePath} has no readable store.md; refusing to sync a store this Muninn cannot identify`;

	let text: string;
	try {
		text = (await git(storePath, { kind: "show-file", ref: remoteRef, path: "store.md" })).stdout;
	} catch {
		return `${remoteRef} exists but has no store.md; it is not this store's remote, and syncing would graft ${ours.store} into an unrelated history`;
	}

	const theirs = parseStoreMd(text).store;
	if (!theirs)
		return `store.md on ${remoteRef} is unreadable; refusing to rebase onto a store that cannot be identified`;
	if (theirs.store !== ours.store) {
		return `${remoteRef} holds a different store (${theirs.store}, not ${ours.store}); refusing to merge two stores' histories`;
	}
	return undefined;
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
async function rebaseOnto(
	storePath: string,
	remoteRef: string,
	result: SyncResult,
	identity?: GitIdentity,
): Promise<boolean> {
	const withIdentity = identity ? { identity } : {};
	try {
		// A rebase rewrites this host's commits, so the committer is set here
		// as it is for a commit.
		await git(storePath, { kind: "rebase", onto: remoteRef }, withIdentity);
		result.rebased = true;
		result.notes.push(`rebased onto ${remoteRef}`);
		return true;
	} catch (error) {
		const conflicts = await conflictedPaths(storePath);
		if (conflicts.length === 1 && conflicts[0] === "store.md") {
			const merged = await mergeRegistry(storePath, result, identity);
			if (merged) return true;
		}

		await abort(storePath);
		stop(
			result,
			"rebase",
			conflicts.length > 0
				? `rebase onto ${remoteRef} conflicts in ${conflicts.join(", ")}; the store is unchanged`
				: `rebase onto ${remoteRef} failed: ${describe(error)}`,
		);
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

async function mergeRegistry(storePath: string, result: SyncResult, identity?: GitIdentity): Promise<boolean> {
	const withIdentity = identity ? { identity } : {};
	try {
		const ours = parseStoreMd((await git(storePath, { kind: "show-stage", stage: 2, path: "store.md" })).stdout);
		const theirs = parseStoreMd((await git(storePath, { kind: "show-stage", stage: 3, path: "store.md" })).stdout);
		if (!ours.store || !theirs.store) return false;
		// Belt and braces: the pre-rebase check should already have stopped this,
		// but a union merge is exactly the wrong answer for two different stores
		// and it must not be reachable by any route.
		if (ours.store.store !== theirs.store.store) {
			result.notes.push(`store.md belongs to a different store (${theirs.store.store}); refusing to merge`);
			return false;
		}

		writeFileSync(join(storePath, "store.md"), formatStoreMd(mergeStoreMd(ours.store, theirs.store)));
		await git(storePath, { kind: "add", paths: ["store.md"] });
		await git(storePath, { kind: "rebase-continue" }, withIdentity);

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
