/**
 * A dream's own checkout.
 *
 * A dream reads committed state and writes derived files; it must do both
 * without touching the store people are using. Git already has the primitive —
 * a worktree on its own branch — and the whole of this module is about putting
 * that checkout somewhere safe and taking it away again afterwards.
 *
 * Two decisions are load-bearing:
 *
 *  - **Worktrees live outside every store**, under the agent directory. The
 *    design says `.git/worktrees/`, which is where git keeps its *metadata*;
 *    the checkout itself must be a directory git is not tracking. Inside the
 *    store it would be untracked content in the very repository the dream is
 *    committing to, and inside a project it would be a stray copy of someone's
 *    source tree.
 *  - **An in-repo store's worktree is narrowed to the store.** There the
 *    repository is the user's project, so a full checkout would copy their
 *    whole tree to write one topic file.
 *
 * Nothing here takes the store lock. The lock is the dream's, held across the
 * whole job by `dream.ts`; a worktree is created and removed inside it.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { GitError, git } from "../git.ts";
import { newDreamId } from "../ids.ts";
import { canonicalPath, isInside } from "../store/paths.ts";
import type { ActiveScope } from "../store/scopes.ts";

/** Where every dream worktree for every store lives. */
export function worktreeRoot(agentDir: string): string {
	return join(agentDir, "muninn-worktrees");
}

/**
 * The identity of a dream started now on this host:
 * `<host slug>-<host id>/<ts>-<dream id>`.
 *
 * The timestamp is millisecond resolution, UTC, with `:` and `.` replaced — a
 * branch name may not contain a colon, and neither may a filename on Windows.
 * It is for people and sorting, not uniqueness. The full stable host id and a
 * fresh full UUIDv7 dream id are the identity: two hosts dreaming the same
 * synced store at the same moment, or one host starting twice at the exact same
 * time supplied by a caller, still cannot share a listing key, branch, or report
 * file. Per-host report directories are the same shape as per-host journal
 * directories, and exist for the same reason: two machines never write the
 * same file.
 *
 * A UUIDv7's leading characters are timestamp bits, so truncating the front of
 * a host id is specifically not an identity: hosts registered together share
 * them. Keys retain the complete ids. Shortening belongs only in presentation.
 *
 * The branch is `dream/<stamp>` and the report `dreams/<stamp>.md`, so branch
 * and report share a key and `/muninn dreams` pairs them without an index.
 */
export function dreamStamp(at: Date, host: { id: string; name: string }, dreamId = newDreamId()): string {
	const ts = at.toISOString().replace(/[:.]/g, "-");
	return `${branchSlug(host.name)}-${host.id}/${ts}-${dreamId}`;
}

/**
 * A host name as a branch component.
 *
 * Host names are display strings from `os.hostname()` and may carry anything a
 * machine's owner typed. A branch name may not, so the name is reduced to the
 * characters git and `assertName` both accept; an empty result becomes `host`,
 * because a branch called `dream//2026-…` is not a branch.
 */
export function branchSlug(hostName: string): string {
	const slug = hostName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	return slug === "" ? "host" : slug;
}

/** `dream/<stamp>`, and the merge variant of it. The stamp already carries the host. */
export function dreamBranch(stamp: string, merge = false): string {
	return `dream/${stamp}${merge ? "-merge" : ""}`;
}

/** The branch prefix `/muninn dreams` lists. */
export const DREAM_BRANCH_PREFIX = "dream/";

export interface DreamWorktree {
	/** The checkout root — the repository's root, which for an in-repo store is the project. */
	root: string;
	/** The store *inside* the worktree: where topic files are written and git is run. */
	storePath: string;
	branch: string;
	/** Remove the checkout and its branch registration. Idempotent. */
	remove(): Promise<void>;
}

export interface CreateWorktreeOptions {
	scope: ActiveScope;
	agentDir: string;
	/** Distinguishes one store's worktrees from another's under the shared root. */
	storeId: string;
	branch: string;
	/** The commit the dream reads: everything it consolidates is at or before this. */
	startPoint: string;
	/**
	 * Check out `branch` as it already exists rather than creating it.
	 *
	 * The merge resolver works on a branch it has just created from the dream's
	 * — the branch carries the history being rebased, so `-b` from a start
	 * point would be exactly wrong.
	 */
	existing?: boolean;
}

/**
 * The repository a store's git commands run against.
 *
 * For a store Muninn owns, the store *is* the repository. For an in-repo store
 * the repository is the project and the store is a directory inside it — which
 * is why the worktree has two paths and every caller has to be clear about
 * which one it means.
 */
function repositoryRoot(scope: ActiveScope, toplevel: string | undefined): string {
	return scope.inRepo && toplevel !== undefined ? toplevel : scope.path;
}

/**
 * The repository a store's git commands run against.
 *
 * Exported because worktree collection and the remember transaction both need
 * it, and both would otherwise re-derive it — the kind of duplicated derivation
 * that stays right until an in-repo store meets it.
 */
export async function repositoryFor(scope: ActiveScope): Promise<string> {
	return repositoryRoot(scope, scope.inRepo ? await inRepoToplevel(scope.path) : undefined);
}

/**
 * Create the worktree a dream works in.
 *
 * The directory is removed first if something is there: a worktree left by a
 * dream that died is garbage, not state, and reusing it would mean inheriting
 * whatever it wrote before it fell over.
 */
export async function createWorktree(options: CreateWorktreeOptions): Promise<DreamWorktree> {
	const { scope, agentDir, storeId, branch, startPoint } = options;
	const toplevel = scope.inRepo ? await inRepoToplevel(scope.path) : undefined;
	const repo = repositoryRoot(scope, toplevel);
	const root = join(worktreeRoot(agentDir), storeId, branch.replace(/\//g, "-"));

	await discard(repo, root);
	// Only when this call is about to *create* the branch: an existing branch
	// deliberately created at its start point — the merge resolver's, cut from
	// the dream branch it is about to rebase — has the exact signature of a
	// leftover, and deleting it here would delete the thing being built.
	if (options.existing !== true) await discardEmptyBranch(repo, branch, startPoint);

	const inRepo = scope.inRepo && toplevel !== undefined;
	if (options.existing === true) {
		await git(repo, { kind: "worktree-add-existing", path: root, branch, ...(inRepo ? { noCheckout: true } : {}) });
	} else {
		await git(repo, { kind: "worktree-add", path: root, branch, startPoint, ...(inRepo ? { noCheckout: true } : {}) });
	}

	let storePath = root;
	if (inRepo) {
		// Canonical on both sides. `rev-parse --show-toplevel` answers with the
		// path the filesystem would actually open — on macOS `/private/var/…`
		// where the store's own path says `/var/…` — and a `relative()` between
		// the two forms yields a string of `..` that is not a location at all.
		// The same lexical-versus-canonical gap that let a symlink walk out of a
		// store in Phase 1; the answer is the same one.
		const inner = storeInsideRepo(toplevel as string, scope.path);
		await git(root, { kind: "sparse-checkout-set", paths: [`/${inner}/`] });
		await git(root, { kind: "checkout-head" });
		storePath = join(root, inner);
	}

	return {
		root,
		storePath,
		branch,
		async remove(): Promise<void> {
			await discard(repo, root);
		},
	};
}

/**
 * Delete a leftover branch, but only when deleting it loses nothing.
 *
 * A dream that died after `worktree add` and before its commit leaves a branch
 * with no work on it, and the next dream in the same minute cannot create that
 * branch again. Deleting it is free — but "free" is not "sits on the same
 * commit": the store's `main` will usually have moved on since, because the
 * dream commits the pending journal before cutting its worktree. The question
 * is whether the branch carries anything the new start point does not, so the
 * test is ancestry, not equality.
 *
 * A branch that *is* ahead is a dream that committed. It is left alone, and
 * `worktree add` then fails loudly — the right outcome for "you already have a
 * dream by this name".
 */
async function discardEmptyBranch(repo: string, branch: string, startPoint: string): Promise<void> {
	let at: string;
	try {
		at = (await git(repo, { kind: "verify-ref", ref: branch })).stdout.trim();
	} catch {
		return;
	}
	if (at === "") return;

	try {
		const base = (await git(repo, { kind: "merge-base", a: branch, b: startPoint })).stdout.trim();
		if (base !== at) return;
	} catch {
		return;
	}
	await git(repo, { kind: "branch-delete", name: branch, force: true }).catch(() => undefined);
}

/**
 * Remove a worktree, whatever state it is in.
 *
 * `worktree remove` refuses a checkout with modifications, which is exactly the
 * state a dead dream leaves behind, so the force flag is not optional here. A
 * directory git has never heard of is removed directly — that is the case where
 * `worktree add` failed halfway — and `worktree prune` afterwards clears the
 * registration either way.
 */
async function discard(repo: string, root: string): Promise<void> {
	if (existsSync(root)) {
		try {
			await git(repo, { kind: "worktree-remove", path: root, force: true });
		} catch (error) {
			if (!(error instanceof GitError)) throw error;
			rmSync(root, { recursive: true, force: true });
		}
	}
	await git(repo, { kind: "worktree-prune" });
}

/**
 * The store's location within its repository, as a git path.
 *
 * Both sides are canonicalised before they are compared, and the result is
 * checked rather than assumed: an in-repo store that is not actually inside the
 * repository git reports is a configuration Muninn cannot narrow a worktree
 * for, and saying so is better than emitting a pattern that happens to parse.
 */
function storeInsideRepo(toplevel: string, storePath: string): string {
	const repo = canonicalPath(toplevel);
	const store = canonicalPath(storePath);
	if (repo === undefined || store === undefined || !isInside(repo, store) || repo === store) {
		throw new Error(`muninn: in-repo store ${storePath} is not inside its repository ${toplevel}`);
	}
	return relative(repo, store).split(sep).join("/");
}

/** The project root an in-repo store sits inside. */
async function inRepoToplevel(storePath: string): Promise<string | undefined> {
	try {
		const { stdout } = await git(storePath, { kind: "rev-parse", target: "--show-toplevel" });
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

export interface CollectOptions {
	/** A branch whose worktree must not be touched — the dream running right now. */
	keep?: string;
	/** The directory Muninn's worktrees live in; anything outside it is not Muninn's to remove. */
	ownedRoot?: string;
}

export interface StaleWorktree {
	path: string;
	branch: string | undefined;
}

/**
 * Worktrees registered against this repository that are not its main one.
 *
 * Parsed from `worktree list --porcelain`, whose records are blank-line
 * separated and begin with `worktree <path>`. The first record is always the
 * main worktree and is never a dream's.
 */
export function parseWorktreeList(stdout: string): StaleWorktree[] {
	const found: StaleWorktree[] = [];
	let path: string | undefined;
	let branch: string | undefined;
	const flush = (): void => {
		if (path !== undefined) found.push({ path, ...(branch !== undefined ? { branch } : { branch: undefined }) });
		path = undefined;
		branch = undefined;
	};
	for (const line of stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			flush();
			path = line.slice("worktree ".length).trim();
		} else if (line.startsWith("branch ")) {
			branch = line
				.slice("branch ".length)
				.trim()
				.replace(/^refs\/heads\//, "");
		}
	}
	flush();
	// The first record is the main worktree; a dream never runs in it.
	return found.slice(1);
}

/**
 * Remove dream worktrees left behind by dreams that are no longer running.
 *
 * Called at the start of every dream, which is the only moment at which the
 * answer is knowable without a second lock: the store lock is held, so no other
 * dream on this host is alive, so every dream worktree registered here is
 * abandoned. Returns what it removed, for the report.
 */
export async function collectWorktrees(repo: string, options: CollectOptions = {}): Promise<string[]> {
	let stdout: string;
	try {
		stdout = (await git(repo, { kind: "worktree-list" })).stdout;
	} catch {
		return [];
	}
	let owned: string | undefined;
	if (options.ownedRoot !== undefined) {
		// The root may simply not exist yet — the first dream creates it — and
		// `canonicalPath` answers undefined for what it cannot open. Treating
		// that as "no restriction" inverted the check exactly when it mattered:
		// on a first run, a foreign `dream/*` worktree outside the root was
		// force-removed, uncommitted work and all. Create the root, then
		// canonicalise; if it still cannot be named, remove nothing.
		mkdirSync(options.ownedRoot, { recursive: true });
		owned = canonicalPath(options.ownedRoot);
		if (owned === undefined) return [];
	}
	const removed: string[] = [];
	for (const worktree of parseWorktreeList(stdout)) {
		// Only a worktree that is *on a dream branch*. A detached-HEAD checkout
		// has no `branch` line at all, and the earlier form of this test let one
		// through — so a person reviewing a commit in `git worktree add --detach`
		// beside their project had it force-removed, uncommitted work and all,
		// every time a dream ran against an in-repo store.
		if (worktree.branch === undefined || !worktree.branch.startsWith(DREAM_BRANCH_PREFIX)) continue;
		// And only inside the directory Muninn manages. A branch name is a thing
		// anyone can create — a person with their own checkout of `dream/…`,
		// wherever it is, has not signed it over to be force-removed. Ownership
		// is the path, canonically compared, same as every other boundary here.
		if (owned !== undefined) {
			const canonical = canonicalPath(worktree.path);
			if (canonical === undefined || !isInside(owned, canonical)) continue;
		}
		// A dream running right now owns its checkout. The store lock no longer
		// keeps remember and dream apart — it is released after a dream's setup —
		// so anything that collects worktrees has to say what it must not touch.
		if (options.keep !== undefined && worktree.branch === options.keep) continue;
		try {
			await discard(repo, worktree.path);
			removed.push(worktree.path);
		} catch {
			// A worktree that will not go away is a diagnostic, not a reason to
			// refuse the dream that was about to run.
		}
	}
	return removed;
}
