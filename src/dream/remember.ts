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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitJournalLocked } from "../capture/commit.ts";
import { currentBranch, DERIVED_PATHS, GitError, type GitIdentity, git } from "../git.ts";
import { claimsOf, type Source } from "../journal/format.ts";
import { readStoreJournal } from "../journal/read.ts";
import { appendSupersessions } from "../journal/supersessions.ts";
import type { HostIdentity } from "../store/host.ts";
import { STORE_BRANCH, storeIdentity } from "../store/init.ts";
import { LockBusyError, withStoreLock } from "../store/lock.ts";
import type { ActiveScope } from "../store/scopes.ts";
import { allFacts, emptyTopic, formatTopic, parseTopic, type TopicFile } from "../topics/format.ts";
import { runningDream } from "./dream.ts";
import { mergeDream, mergeTopic } from "./merge.ts";
import type { DreamModel } from "./model.ts";
import { orient } from "./orient.ts";
import { collectWorktrees, createWorktree, repositoryFor, worktreeRoot } from "./worktree.ts";

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
	/**
	 * How to settle a derived-file conflict, when there is one.
	 *
	 * Supplied by the caller rather than reached for here, because settling one
	 * needs a model and this module has no business knowing about models. Absent
	 * — headless with no `dream.model`, say — a conflict is reported and the
	 * store is left alone, which is the honest outcome.
	 */
	resolve?: (conflict: RebaseConflict) => Promise<MergeResolution>;
	staleMs?: number;
}

/** What a merge dream produced, or why it could not. */
export interface MergeResolution {
	ok: boolean;
	/** The branch to fast-forward to instead of the original. */
	branch?: string;
	problems: string[];
	notes: string[];
}

export interface RememberResult {
	ok: boolean;
	/** The commit `main` now points at, when it moved. */
	sha?: string;
	rebased: boolean;
	/** The merge dream's branch, when a conflict had to be settled by one. */
	merged?: string;
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

	// A dream running right now owns a worktree on a `dream/*` branch, and this
	// transaction collects worktrees before it rebases. The store lock does not
	// keep the two apart any more — a dream releases it after setup — so the
	// marker has to be asked. Without this, remembering yesterday's dream while
	// tonight's is running deletes tonight's checkout out from under it, and it
	// dies having done minutes of model work for nothing.
	const dreaming = runningDream(scope.path, new Date());
	if (dreaming !== undefined) {
		result.problems.push(
			`a dream (${dreaming.stamp}) is running here, started ${dreaming.at}; remember it or wait for it to finish`,
		);
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
		// spin holding the lock. A merge dream replaces the branch being applied,
		// so the loop runs over `current` rather than the branch asked for.
		let current = branch;
		for (let attempt = 0; attempt < 3; attempt++) {
			if (!(await isDescendant(scope.path, current, mainSha))) {
				try {
					await rebaseOnto(options, current, identity, result);
					result.rebased = true;
				} catch (error) {
					if (!(error instanceof RebaseConflict) || options.resolve === undefined) throw error;
					// Two dreams rewrote the same topic. This is not something
					// `git merge` may decide — both sides replaced the same
					// bullets with different wording, which merges cleanly and
					// produces nonsense — so it goes to a merge dream, and what
					// comes back is a third branch to fast-forward to instead.
					const merged = await options.resolve(error);
					result.notes.push(...merged.notes);
					if (!merged.ok || merged.branch === undefined) {
						result.problems.push(...merged.problems, error.message);
						return result;
					}
					current = merged.branch;
					result.merged = current;
					result.rebased = true;
					continue;
				}
			}
			try {
				await git(scope.path, { kind: "merge-ff-only", ref: current }, identity ? { identity } : {});
			} catch (error) {
				if (!(error instanceof GitError) || attempt >= 1) throw error;
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
		if (result.merged !== undefined && result.merged !== branch) {
			await deleteBranch(options, result.merged, result);
		}
		return result;
	} catch (error) {
		result.problems.push(error instanceof GitError ? error.message : String(error));
		// `merge --ff-only` writes the index and the working tree *before* it
		// moves the ref, so a failure at the wrong instant leaves the dream's
		// derived files staged against an unmoved HEAD — and every later remember
		// then fails with "local changes would be overwritten" until somebody
		// runs `git checkout` by hand. Putting them back is idempotent and, by
		// `assertDerived`, cannot reach a journal file.
		await restoreDerived(scope.path);
		return result;
	} finally {
		rmSync(markerPath(scope.path), { force: true });
	}
}

/** Put the derived files back to whatever `HEAD` says they are. */
async function restoreDerived(storePath: string): Promise<void> {
	const paths = DERIVED_PATHS.filter((path) => existsSync(join(storePath, path.replace(/\/$/, ""))));
	if (paths.length === 0) return;
	await git(storePath, { kind: "checkout-paths", ref: "HEAD", paths: [...paths] }).catch(() => undefined);
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
	// check a branch out twice. Nothing is running — `applyRemember` refused
	// otherwise — so every dream worktree here is finished work.
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
		// Thrown, not recorded: a conflict is only a *problem* if nothing settles
		// it, and the caller is the one that knows whether a merge dream is
		// available. Recording it here made every successful merge report the
		// conflict it had just resolved.
		throw new RebaseConflict(branch, conflicts, detail);
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

	// The checkout happens either way, and not only when the ref moved. "HEAD is
	// where the marker says" was taken to mean "nothing was applied", which is
	// only sound if the ref moves first — and `merge --ff-only` writes the
	// worktree before the ref, so the one state that reading cannot see is
	// exactly the one it needs to repair. Restoring is idempotent, and
	// `checkout-paths` is not allowed to name a journal file.
	await restoreDerived(storePath);
	const untouched = marker !== undefined && head === marker.mainSha;
	rmSync(markerPath(storePath), { force: true });
	if (untouched) {
		return {
			recovered: true,
			message: `a remember of ${(marker as RememberMarker).branch} died before it applied; nothing was changed`,
		};
	}
	return {
		recovered: true,
		message: `a remember${marker ? ` of ${marker.branch}` : ""} died after the ref moved; the derived files were restored from HEAD`,
	};
}

// ---------------------------------------------------------------------------
// Settling a conflict: the merge dream, wired to the remember transaction
// ---------------------------------------------------------------------------

export interface ResolveOptions {
	scope: ActiveScope;
	agentDir: string;
	host: HostIdentity;
	storeId: string;
	model: DreamModel;
	now: Date;
	signal?: AbortSignal;
}

/**
 * Settle a derived-file conflict and hand back a branch to apply instead.
 *
 * The three layers, in order: the structural per-fact merge resolves most of it
 * without asking anybody; what is left is the semantic residue; and only that
 * goes to a model, in a job bounded exactly like a consolidation. The result is
 * committed as `<branch>-merge` and remembered through the ordinary
 * transaction, so a bad merge is reviewable and forgettable like any dream.
 */
export async function resolveConflict(conflict: RebaseConflict, options: ResolveOptions): Promise<MergeResolution> {
	const resolution: MergeResolution = { ok: false, problems: [], notes: [] };
	const { scope } = options;

	const topics = conflict.paths.filter((path) => path.startsWith("topics/") && path.endsWith(".md"));
	const others = conflict.paths.filter((path) => !topics.includes(path) && path !== "MEMORY.md");
	if (others.length > 0) {
		// `rules.md` residue always waits for a human: a rule is followed, not
		// just recalled. Anything else here is a file this cannot reason about.
		resolution.problems.push(`${others.join(", ")} must be resolved by hand, not by a merge dream`);
		return resolution;
	}
	if (topics.length === 0) {
		// Only `MEMORY.md` conflicted, which is regenerated and never merged.
		resolution.problems.push("nothing but MEMORY.md conflicted; re-run the dream rather than merging");
		return resolution;
	}

	const mergeBranch = `${conflict.branch}-merge`;
	const repo = await repositoryFor(scope);
	const base = (await git(scope.path, { kind: "merge-base", a: conflict.branch, b: STORE_BRANCH })).stdout.trim();

	const worktree = await createWorktree({
		scope,
		agentDir: options.agentDir,
		storeId: options.storeId,
		branch: mergeBranch,
		startPoint: STORE_BRANCH,
	});

	try {
		const orientation = orient(worktree.storePath);
		const entries = readStoreJournal(worktree.storePath).entries;
		const sources = new Map<string, Source>();
		const dates = new Map<string, string>();
		for (const entry of entries) {
			for (const claim of claimsOf(entry)) {
				sources.set(claim.id, entry.source);
				dates.set(claim.id, entry.date);
			}
		}
		// As in `dream.ts`: a fact's own source is the class its evidence rests
		// on, and without it a claim cited only through an existing fact has no
		// known source and escapes the external quarantine.
		for (const topic of orientation.topics.values()) {
			for (const fact of allFacts(topic)) {
				for (const id of fact.evidence) if (!sources.has(id)) sources.set(id, fact.source);
			}
		}

		let changed = 0;
		for (const path of topics) {
			const slug = path.slice("topics/".length, -".md".length);
			const merged = mergeTopic({
				base: await topicAt(scope.path, base, slug),
				ours: await topicAt(scope.path, STORE_BRANCH, slug),
				theirs: await topicAt(scope.path, conflict.branch, slug),
			});
			resolution.notes.push(...merged.notes.map((note) => `${slug}: ${note}`));

			let file = merged.topic;
			if (merged.residue.length > 0) {
				const outcome = await mergeDream(
					{
						topic: slug,
						merged: merged.topic,
						base: await topicAt(scope.path, base, slug),
						residue: merged.residue,
						entries,
					},
					{
						model: options.model,
						now: options.now,
						sourceOf: (id) => sources.get(id),
						dateOf: (id) => dates.get(id),
						refused: orientation.superseded,
						...(options.signal ? { signal: options.signal } : {}),
					},
				);
				if (!outcome.outcome.ok) {
					resolution.problems.push(`${slug}: ${outcome.outcome.reason}`);
					return resolution;
				}
				// A merge may not lose a fact silently. It cannot, structurally —
				// an unmentioned fact is kept — and this says so if it ever can.
				if (outcome.dropped.length > 0) {
					resolution.notes.push(`${slug}: dropped ${outcome.dropped.join(", ")}`);
				}
				file = outcome.outcome.applied.topic;
				appendSupersessions(worktree.storePath, outcome.outcome.supersessions);
				resolution.notes.push(`${slug}: ${merged.residue.length} residue pair(s) settled by a merge dream`);
			}

			mkdirSync(join(worktree.storePath, "topics"), { recursive: true });
			writeFileSync(join(worktree.storePath, "topics", `${slug}.md`), formatTopic(file));
			changed++;
		}

		const paths = DERIVED_PATHS.filter((path) => existsSync(join(worktree.storePath, path.replace(/\/$/, ""))));
		await git(worktree.storePath, { kind: "add", paths: [...paths] });
		await git(
			worktree.storePath,
			{
				kind: "commit",
				message: [
					`dream: merge ${changed} topic(s)`,
					"",
					`Muninn-Merge-Of: ${conflict.branch}`,
					`Muninn-Merge-Into: ${STORE_BRANCH}`,
				].join("\n"),
				paths: [...paths],
			},
			scope.inRepo ? {} : { identity: storeIdentity(options.host) },
		);

		resolution.ok = true;
		resolution.branch = mergeBranch;
		resolution.notes.push(`merged ${conflict.branch} into ${mergeBranch}`);
		return resolution;
	} catch (error) {
		resolution.problems.push(error instanceof GitError ? error.message : String(error));
		return resolution;
	} finally {
		await git(repo, { kind: "worktree-remove", path: worktree.root, force: true }).catch(() => undefined);
		await git(repo, { kind: "worktree-prune" }).catch(() => undefined);
	}
}

/** A topic file as of a ref, or an empty one when that ref does not have it. */
async function topicAt(storePath: string, ref: string, slug: string): Promise<TopicFile> {
	try {
		const { stdout } = await git(storePath, { kind: "show-file", ref, path: `topics/${slug}.md` });
		return parseTopic(stdout, slug);
	} catch {
		return emptyTopic(slug);
	}
}
