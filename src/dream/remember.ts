/**
 * Remember: move a dream's work onto `main`, atomically enough.
 *
 * Capture keeps writing while a dream runs, so remember is the one moment the
 * two meet. The transaction the design specifies, and the reason each step is
 * where it is:
 *
 *   1. write `.remember` — the marker that says a remember is in progress, and
 *      the only thing that lets the *next* run tell "died before" from "died
 *      after";
 *   2. commit any pending journal appends, so the worktree is clean and the ref
 *      can move without carrying uncommitted work along;
 *   3. rebase the dream branch onto `main` — conflict-free by construction when
 *      `main` moved only by journal commits, because capture touches only
 *      `journal/` and a dream only the derived paths;
 *   4. `merge --ff-only` — git advances the ref, the index *and* the worktree in
 *      one operation, so a reader never sees a store dirty against its own
 *      HEAD, and `--ff-only` doubles as the compare-and-swap if `main` moved
 *      again;
 *   5. delete the marker.
 *
 * The rebase happens in a worktree of its own rather than in the store: the
 * store must stay on `main` throughout, and `git rebase` works on whatever is
 * checked out.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitJournalLocked } from "../capture/commit.ts";
import { currentBranch, DERIVED_PATHS, GitError, type GitIdentity, git } from "../git.ts";
import type { HostIdentity } from "../store/host.ts";
import { STORE_BRANCH, storeIdentity } from "../store/init.ts";
import { LockBusyError, withStoreLock } from "../store/lock.ts";
import type { ActiveScope } from "../store/scopes.ts";
import { collectWorktrees, repositoryFor, worktreeRoot } from "./worktree.ts";

/**
 * A rebase that met a genuine derived-file conflict.
 *
 * Carried as its own error because the answer is specific and is not "try
 * again": the named topics need a merge dream, which is the consolidate phase
 * with two candidates.
 */
export class RebaseConflict extends Error {
	readonly branch: string;
	readonly paths: string[];
	constructor(branch: string, paths: string[], detail: string) {
		super(
			`${branch} does not rebase onto main cleanly (${detail}); ` +
				`${paths.length > 0 ? `${paths.join(", ")} ` : ""}must go through a merge dream, not a git merge`,
		);
		this.name = "RebaseConflict";
		this.branch = branch;
		this.paths = paths;
	}
}

/** `UU topics/testing.md` -> `topics/testing.md`. */
async function conflictedPaths(cwd: string): Promise<string[]> {
	try {
		const { stdout } = await git(cwd, { kind: "status-porcelain", paths: [] });
		return stdout
			.split("\n")
			.filter((line) => line.trim() !== "" && (line[0] === "U" || line[1] === "U" || line.slice(0, 2) === "AA"))
			.map((line) => line.slice(3).trim());
	} catch {
		return [];
	}
}

/** The in-progress marker. Gitignored: it is machine-local by nature. */
export const REMEMBER_MARKER = ".remember";

export interface RememberMarker {
	branch: string;
	/** Where `main` was when the transaction started. */
	mainSha: string;
	at: string;
}

export interface RememberOptions {
	scope: ActiveScope;
	agentDir: string;
	host: HostIdentity;
	branch: string;
	staleMs?: number;
}

export interface RememberResult {
	ok: boolean;
	/** The commit `main` now points at, when it moved. */
	sha?: string;
	rebased: boolean;
	problems: string[];
	notes: string[];
}

export function markerPath(storePath: string): string {
	return join(storePath, REMEMBER_MARKER);
}

export function readMarker(storePath: string): RememberMarker | undefined {
	try {
		const parsed = JSON.parse(readFileSync(markerPath(storePath), "utf-8")) as Partial<RememberMarker>;
		if (typeof parsed.branch !== "string" || typeof parsed.mainSha !== "string") return undefined;
		return parsed as RememberMarker;
	} catch {
		return undefined;
	}
}

/** Fast-forward `main` to a dream branch, under the store lock. */
export async function remember(options: RememberOptions): Promise<RememberResult> {
	const { scope, host } = options;
	const result: RememberResult = { ok: false, rebased: false, problems: [], notes: [] };
	const identity = scope.inRepo ? undefined : storeIdentity(host);

	try {
		return await withStoreLock(
			scope.path,
			"remember",
			{ host: host.id, ...(options.staleMs !== undefined ? { staleMs: options.staleMs } : {}) },
			async () => applyRemember(options, identity, result),
		);
	} catch (error) {
		if (error instanceof LockBusyError || error instanceof GitError) {
			result.problems.push(error.message);
			return result;
		}
		result.problems.push(error instanceof Error ? error.message : String(error));
		return result;
	}
}

async function applyRemember(
	options: RememberOptions,
	identity: GitIdentity | undefined,
	result: RememberResult,
): Promise<RememberResult> {
	const { scope, host, branch } = options;

	if ((await git(scope.path, { kind: "verify-ref", ref: branch }).catch(() => ({ stdout: "" }))).stdout.trim() === "") {
		result.problems.push(`no such dream branch: ${branch}`);
		return result;
	}

	let mainSha = (await git(scope.path, { kind: "rev-parse", target: "HEAD" })).stdout.trim();
	writeFileSync(
		markerPath(scope.path),
		`${JSON.stringify({ branch, mainSha, at: new Date().toISOString() }, null, "\t")}\n`,
	);

	try {
		const pending = await commitJournalLocked({
			storePath: scope.path,
			hostId: host.id,
			hostName: host.name,
			entries: 0,
			force: true,
			...(identity ? { identity } : {}),
		});
		if (pending.committed) {
			result.notes.push("committed pending journal entries first");
			mainSha = (await git(scope.path, { kind: "rev-parse", target: "HEAD" })).stdout.trim();
			writeFileSync(
				markerPath(scope.path),
				`${JSON.stringify({ branch, mainSha, at: new Date().toISOString() }, null, "\t")}\n`,
			);
		}

		// One retry, and only one: a `main` that keeps moving under us is a busy
		// store, not a broken one, and the answer is to come back rather than to
		// spin holding the lock.
		for (let attempt = 0; attempt < 2; attempt++) {
			if (!(await isDescendant(scope.path, branch, mainSha))) {
				await rebaseOnto(options, branch, identity, result);
				result.rebased = true;
			}
			try {
				await git(scope.path, { kind: "merge-ff-only", ref: branch }, identity ? { identity } : {});
			} catch (error) {
				if (!(error instanceof GitError) || attempt === 1) throw error;
				mainSha = (await git(scope.path, { kind: "rev-parse", target: "HEAD" })).stdout.trim();
				result.notes.push("main moved during remember; retried once");
				continue;
			}
			break;
		}

		result.sha = (await git(scope.path, { kind: "rev-parse", target: "HEAD" })).stdout.trim();
		result.ok = true;
		// The branch has served its purpose: its commit is on `main` and the
		// report is the record. Leaving it would make `/muninn dreams` list
		// dreams that are already remembered as if they were pending.
		await deleteBranch(options, branch, result);
		return result;
	} catch (error) {
		result.problems.push(error instanceof GitError ? error.message : String(error));
		return result;
	} finally {
		rmSync(markerPath(scope.path), { force: true });
	}
}

/** Whether `branch` already contains `sha`, in which case no rebase is needed. */
async function isDescendant(storePath: string, branch: string, sha: string): Promise<boolean> {
	try {
		const base = (await git(storePath, { kind: "merge-base", a: branch, b: sha })).stdout.trim();
		return base === sha;
	} catch {
		return false;
	}
}

/**
 * Rebase the dream branch onto `main`, in a worktree of its own.
 *
 * A genuine derived-file conflict is not resolved here and never by `git
 * merge`: two dreams that rewrote the same topic go through the merge dream,
 * which is the consolidate phase with two candidates. This reports and stops.
 */
async function rebaseOnto(
	options: RememberOptions,
	branch: string,
	identity: GitIdentity | undefined,
	result: RememberResult,
): Promise<void> {
	const repo = await repositoryFor(options.scope);
	// The dream's own worktree may still hold this branch, and git will not
	// check a branch out twice.
	await collectWorktrees(repo);

	// The store's own branch, not the literal "main": an in-repo store is on
	// whatever branch the project is on, and rebasing onto a branch that is not
	// there fails in a way nobody would connect to their checkout.
	const onto = (await currentBranch(options.scope.path)) ?? STORE_BRANCH;

	const path = join(worktreeRoot(options.agentDir), "remember", branch.replace(/\//g, "-"));
	rmSync(path, { recursive: true, force: true });
	await git(repo, { kind: "worktree-add-existing", path, branch });
	try {
		await git(path, { kind: "rebase", onto }, identity ? { identity } : {});
		result.notes.push(`rebased ${branch} onto main`);
	} catch (error) {
		// Which derived files disagreed, read before the abort throws it away.
		const conflicts = await conflictedPaths(path);
		await git(path, { kind: "rebase-abort" }).catch(() => undefined);
		const detail = (error instanceof GitError ? error.stderr.trim().split("\n")[0] : String(error)) ?? "";
		// Not resolved by `git merge`, ever. Two dreams that rewrote the same
		// topic replaced the same bullets with different wording, which merges
		// cleanly line-by-line and produces nonsense. `merge.ts` is the answer,
		// and the caller is told which topics need it.
		const failure = new RebaseConflict(branch, conflicts, detail);
		result.problems.push(failure.message);
		throw failure;
	} finally {
		await git(repo, { kind: "worktree-remove", path, force: true }).catch(() => undefined);
		await git(repo, { kind: "worktree-prune" }).catch(() => undefined);
	}
}

async function deleteBranch(options: RememberOptions, branch: string, result: RememberResult): Promise<void> {
	try {
		const repo = await repositoryFor(options.scope);
		await collectWorktrees(repo);
		await git(repo, { kind: "branch-delete", name: branch, force: true });
	} catch {
		result.notes.push(`could not delete ${branch}; it is remembered either way`);
	}
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export interface RecoveryResult {
	recovered: boolean;
	message?: string;
}

/**
 * Repair a remember that died mid-transaction.
 *
 * Two states, told apart by the marker's recorded sha:
 *
 *  - `main` is where the marker says: nothing was applied. Delete the marker.
 *  - `main` moved: the ref advanced but the worktree may not have. Restoring
 *    the derived paths from `HEAD` makes the checkout agree with the ref again
 *    — and it *cannot* lose a journal entry, because `checkout-paths` is not
 *    allowed to name one and a fast-forward from a dream branch changes only
 *    derived paths.
 *
 * Runs on every store open, because the process that would have cleaned up is
 * by definition not running.
 */
export async function recoverRemember(storePath: string): Promise<RecoveryResult> {
	const marker = readMarker(storePath);
	if (marker === undefined) {
		// A marker file that exists but cannot be read is still a marker: the
		// safe reading is "a remember died", and the safe action is to leave the
		// derived files agreeing with HEAD.
		if (!existsSync(markerPath(storePath))) return { recovered: false };
	}

	let head = "";
	try {
		head = (await git(storePath, { kind: "rev-parse", target: "HEAD" })).stdout.trim();
	} catch {
		rmSync(markerPath(storePath), { force: true });
		return { recovered: true, message: "cleared a stale remember marker" };
	}

	if (marker !== undefined && head === marker.mainSha) {
		rmSync(markerPath(storePath), { force: true });
		return { recovered: true, message: `a remember of ${marker.branch} died before it applied; nothing was changed` };
	}

	const paths = DERIVED_PATHS.filter((path) => existsSync(join(storePath, path.replace(/\/$/, ""))));
	if (paths.length > 0) {
		await git(storePath, { kind: "checkout-paths", ref: "HEAD", paths: [...paths] }).catch(() => undefined);
	}
	rmSync(markerPath(storePath), { force: true });
	return {
		recovered: true,
		message: `a remember${marker ? ` of ${marker.branch}` : ""} died after the ref moved; the derived files were restored from HEAD`,
	};
}
