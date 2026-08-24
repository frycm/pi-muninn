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
import { dirname, join } from "node:path";
import { commitJournalLocked } from "../capture/commit.ts";
import { currentBranch, DERIVED_PATHS, GitError, type GitIdentity, git, hasChanges } from "../git.ts";
import { claimsOf, type Source } from "../journal/format.ts";
import { readStoreJournal } from "../journal/read.ts";
import { appendSupersessions, parseSupersessions, readSupersessions } from "../journal/supersessions.ts";
import type { MuninnSettings } from "../settings.ts";
import type { HostIdentity } from "../store/host.ts";
import { STORE_BRANCH, storeIdentity } from "../store/init.ts";
import { LockBusyError, withStoreLock } from "../store/lock.ts";
import type { ActiveScope } from "../store/scopes.ts";
import { allFacts, formatTopic, parseTopic } from "../topics/format.ts";
import { allClaimIds, echoClaims, runningDream } from "./dream.ts";
import { lint } from "./lint.ts";
import { buildMemory } from "./memory-md.ts";
import { mergeDream, mergeTopic } from "./merge.ts";
import type { DreamModel } from "./model.ts";
import { orient } from "./orient.ts";
import { emptyReport, formatReport, reportPath } from "./report.ts";
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
	const { scope, host } = options;
	let branch = options.branch;

	const at = (await git(scope.path, { kind: "verify-ref", ref: branch }).catch(() => ({ stdout: "" }))).stdout.trim();
	if (at === "") {
		result.problems.push(`no such dream branch: ${branch}`);
		return result;
	}

	// A dream fetched from another host arrives as `origin/dream/…`, and a
	// worktree added from a remote-tracking name is a *detached* checkout: the
	// rebase would rewrite the detached HEAD while the remote ref stayed put,
	// and the fast-forward that follows would apply the unrebased commit — or
	// fail — with the rebased work lost either way. So the fetched dream is
	// materialised as a local branch at the same commit first, and everything
	// downstream operates on a name a rebase actually moves.
	if (branch.startsWith("origin/")) {
		const local = branch.slice("origin/".length);
		const existing = (
			await git(scope.path, { kind: "verify-ref", ref: local }).catch(() => ({ stdout: "" }))
		).stdout.trim();
		if (existing === "") {
			await git(scope.path, { kind: "branch-create", name: local, startPoint: at });
			result.notes.push(`materialised ${branch} as ${local}`);
		} else if (existing !== at) {
			result.problems.push(`${local} exists and does not match ${branch}; delete or remember the local one first`);
			return result;
		}
		branch = local;
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
	// otherwise — so every dream worktree *under Muninn's own root* is finished
	// work; anything elsewhere is somebody's checkout and is not touched.
	await collectWorktrees(repo, { ownedRoot: worktreeRoot(options.agentDir) });

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
		await collectWorktrees(repo, { ownedRoot: worktreeRoot(options.agentDir) });
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
	settings: MuninnSettings;
	now: Date;
	signal?: AbortSignal;
}

/**
 * Settle a derived-file conflict and hand back a branch to apply instead.
 *
 * The shape is a *rebase*, not a reconstruction. An earlier version started a
 * fresh branch from the store's head and rewrote only the conflicted topics —
 * which quietly dropped everything else the dream had done: its non-conflicting
 * topics, its report, its supersessions. So the resolver now creates
 * `<branch>-merge` *from the dream branch* and rebases it onto the store's own
 * branch, resolving each conflicted file as the rebase stops on it:
 *
 *  - `topics/…` — the three layers: structural per-fact merge from the index
 *    stages (1 = ancestor, 2 = the store's side, 3 = the dream's), residue
 *    detection, and a merge-dream job only for what those could not settle;
 *  - `supersessions.md` — the union, which is always right because the file is
 *    append-only;
 *  - `MEMORY.md` — taken from the store's side during the rebase and
 *    regenerated from the resolved topics afterwards, because it is derived
 *    and is never merged;
 *  - `rules.md` — never resolved by a model: a rule is followed, not just
 *    recalled, so a rules conflict waits for a human;
 *  - `journal/` — impossible by construction, and a bug to report if seen.
 *
 * The merge-dream job's evidence is bounded to the entries the conflicting
 * facts actually cite — not the whole journal — and the finished branch is
 * linted and carries its own report before the transaction may fast-forward to
 * it. A merge that fails lint fails the resolution; the branch is kept for
 * inspection.
 */
export async function resolveConflict(conflict: RebaseConflict, options: ResolveOptions): Promise<MergeResolution> {
	const resolution: MergeResolution = { ok: false, problems: [], notes: [] };
	const { scope } = options;

	// Refused before anything is built: a rule is followed, not just recalled,
	// so a rules conflict waits for a human whatever else is in the pile.
	const untouchable = conflict.paths.filter(
		(path) => path === "rules.md" || path.startsWith("skills/") || path.startsWith("journal/"),
	);
	if (untouchable.length > 0) {
		resolution.problems.push(`${untouchable.join(", ")} must be resolved by hand, not by a merge dream`);
		return resolution;
	}

	// The store's own branch, not the literal "main": an in-repo store is on
	// whatever branch the project is on.
	const onto = (await currentBranch(scope.path)) ?? STORE_BRANCH;
	const mergeBranch = `${conflict.branch}-merge`;
	const repo = await repositoryFor(scope);

	// A leftover from an earlier failed resolution is stale, not state.
	await git(repo, { kind: "branch-delete", name: mergeBranch, force: true }).catch(() => undefined);
	await git(repo, { kind: "branch-create", name: mergeBranch, startPoint: conflict.branch });

	const worktree = await createWorktree({
		scope,
		agentDir: options.agentDir,
		storeId: options.storeId,
		branch: mergeBranch,
		startPoint: conflict.branch,
		existing: true,
	});
	const storeP = worktree.storePath;

	try {
		const settled: Array<{ topic: string; residue: number; added: string[] }> = [];

		try {
			await git(storeP, { kind: "rebase", onto }, scope.inRepo ? {} : { identity: storeIdentity(options.host) });
			resolution.notes.push(`${conflict.branch} rebased cleanly onto ${onto} on the second look`);
		} catch {
			const outcome = await resolveRebaseStops(storeP, options, resolution, settled);
			if (!outcome) {
				await git(storeP, { kind: "rebase-abort" }).catch(() => undefined);
				return resolution;
			}
		}

		// The rebase is done; the dream's whole diff — conflicting or not — is on
		// the branch. Now the derived index over it: MEMORY.md regenerated from
		// the *resolved* topics, and lint over the result, because a merge is a
		// dream and goes through the same gate.
		const orientation = orient(storeP);
		const memory = buildMemory({
			topics: orientation.topics,
			rules: orientation.rules,
			usage: orientation.usage,
			current: orientation.memory,
			budget: options.settings.recall.snapshotLines[scope.scope],
		});
		writeFileSync(join(storeP, "MEMORY.md"), memory.text);

		const linted = lint({
			topics: orientation.topics,
			claims: allClaimIds(storeP),
			superseded: readSupersessions(storeP).superseded,
			erased: orientation.erased,
			echoes: echoClaims(storeP, orientation),
			rules: orientation.rules,
			memory: memory.text,
			usage: orientation.usage,
			rulesCap: options.settings.dream.rulesCap,
			retireAfterDays: options.settings.dream.retireAfterDays,
			now: options.now,
		});

		// The merge's own report: what was settled, by what, and how lint judged
		// it — committed on the branch, so the merge is reviewable and
		// forgettable exactly like the dream it merges.
		const stamp = `${conflict.branch.slice("dream/".length)}-merge`;
		const report = emptyReport({
			stamp,
			scope: scope.scope,
			host: options.host.name,
			started: options.now.toISOString(),
		});
		report.model = options.model.id;
		report.inputHead = (await git(scope.path, { kind: "rev-parse", target: "HEAD" })).stdout.trim();
		report.finished = options.now.toISOString();
		report.notes.push(`merge of ${conflict.branch} onto ${onto}`);
		for (const entry of settled) {
			report.consolidated.push({ topic: entry.topic, added: entry.added.length, superseded: 0, addedIds: entry.added });
			report.notes.push(`${entry.topic}: ${entry.residue} residue pair(s) settled by a merge dream`);
		}
		report.lint.push(...linted.findings);
		if (linted.blocking > 0) report.status = "lint-blocked";

		const reportFile = join(storeP, reportPath(stamp));
		mkdirSync(dirname(reportFile), { recursive: true });
		writeFileSync(reportFile, formatReport(report));

		const paths = DERIVED_PATHS.filter((path) => existsSync(join(storeP, path.replace(/\/$/, ""))));
		await git(storeP, { kind: "add", paths: [...paths] });
		if (await hasChanges(storeP, [...paths])) {
			await git(
				storeP,
				{
					kind: "commit",
					message: [
						`dream: merge ${settled.length} topic(s)`,
						"",
						`Muninn-Dream: ${stamp}`,
						`Muninn-Merge-Of: ${conflict.branch}`,
						`Muninn-Merge-Into: ${onto}`,
					].join("\n"),
					paths: [...paths],
				},
				scope.inRepo ? {} : { identity: storeIdentity(options.host) },
			);
		}

		if (linted.blocking > 0) {
			// A merge is a dream; a dream that fails lint is not remembered. The
			// branch stays, report and all, so someone can see what it did.
			resolution.problems.push(
				`the merge failed lint (${linted.blocking} blocking finding(s)); ${mergeBranch} is kept for inspection`,
			);
			return resolution;
		}

		resolution.ok = true;
		resolution.branch = mergeBranch;
		resolution.notes.push(`merged ${conflict.branch} onto ${onto} as ${mergeBranch}`);
		return resolution;
	} catch (error) {
		resolution.problems.push(error instanceof GitError ? error.message : String(error));
		return resolution;
	} finally {
		await git(repo, { kind: "worktree-remove", path: worktree.root, force: true }).catch(() => undefined);
		await git(repo, { kind: "worktree-prune" }).catch(() => undefined);
	}
}

/**
 * Walk the rebase's stops, resolving what may be resolved.
 *
 * Returns false — with the reason recorded — when a stop holds something no
 * model may decide.
 */
async function resolveRebaseStops(
	storeP: string,
	options: ResolveOptions,
	resolution: MergeResolution,
	settled: Array<{ topic: string; residue: number; added: string[] }>,
): Promise<boolean> {
	for (let round = 0; round < 10; round++) {
		const conflicts = await conflictedPaths(storeP);
		if (conflicts.length === 0) return true;

		for (const path of conflicts) {
			if (path.startsWith("journal/")) {
				// Per-host files make this impossible by construction.
				resolution.problems.push(`a conflict in ${path} is a bug to report, not something to resolve`);
				return false;
			}
			if (path === "rules.md" || path.startsWith("skills/")) {
				resolution.problems.push(`${path} must be resolved by hand: a rule is followed, not just recalled`);
				return false;
			}
			if (path === "MEMORY.md") {
				// Derived; regenerated after the rebase. The store's side stands
				// in so the rebase can continue.
				const ours = await stageOf(storeP, 2, path);
				writeFileSync(join(storeP, path), ours ?? "");
				continue;
			}
			if (path === "supersessions.md") {
				// Append-only, so the union is always right and never a loss.
				const ours = parseSupersessions((await stageOf(storeP, 2, path)) ?? "");
				const theirs = parseSupersessions((await stageOf(storeP, 3, path)) ?? "");
				const rows = [...ours.byClaim.values(), ...theirs.byClaim.values()];
				writeFileSync(join(storeP, path), "");
				appendSupersessions(storeP, rows);
				continue;
			}
			if (path.startsWith("topics/") && path.endsWith(".md")) {
				const settledTopic = await settleTopic(storeP, path, options, resolution);
				if (settledTopic === undefined) return false;
				settled.push(settledTopic);
				continue;
			}
			resolution.problems.push(`${path} is not a file a merge dream may decide`);
			return false;
		}

		const paths = DERIVED_PATHS.filter((path) => existsSync(join(storeP, path.replace(/\/$/, ""))));
		await git(storeP, { kind: "add", paths: [...paths] });
		try {
			await git(
				storeP,
				{ kind: "rebase-continue" },
				options.scope.inRepo ? {} : { identity: storeIdentity(options.host) },
			);
			return true;
		} catch {
			// Another commit of the branch stopped; the loop resolves it too.
		}
	}
	resolution.problems.push("the rebase kept stopping; giving up rather than looping");
	return false;
}

/** One conflicted topic file, through the three layers. */
async function settleTopic(
	storeP: string,
	path: string,
	options: ResolveOptions,
	resolution: MergeResolution,
): Promise<{ topic: string; residue: number; added: string[] } | undefined> {
	const slug = path.slice("topics/".length, -".md".length);
	const base = parseTopic((await stageOf(storeP, 1, path)) ?? "", slug);
	const ours = parseTopic((await stageOf(storeP, 2, path)) ?? "", slug);
	const theirs = parseTopic((await stageOf(storeP, 3, path)) ?? "", slug);

	const merged = mergeTopic({ base, ours, theirs });
	resolution.notes.push(...merged.notes.map((note) => `${slug}: ${note}`));

	let file = merged.topic;
	let added: string[] = [];
	if (merged.residue.length > 0) {
		// The job's evidence is what the conflicting facts actually cite — not
		// the whole journal. The merge prompt exists to settle named residue
		// pairs, and handing it every entry in the store would hand it the
		// held-out tasks with them.
		const cited = new Set(allFacts(merged.topic).flatMap((fact) => fact.evidence));
		const entries = readStoreJournal(storeP).entries.filter((entry) =>
			claimsOf(entry).some((claim) => cited.has(claim.id)),
		);
		const sources = new Map<string, Source>();
		const dates = new Map<string, string>();
		for (const entry of entries) {
			for (const claim of claimsOf(entry)) {
				sources.set(claim.id, entry.source);
				dates.set(claim.id, entry.date);
			}
		}
		for (const fact of allFacts(merged.topic)) {
			for (const id of fact.evidence) if (!sources.has(id)) sources.set(id, fact.source);
		}

		const outcome = await mergeDream(
			{ topic: slug, merged: merged.topic, base, residue: merged.residue, entries },
			{
				model: options.model,
				now: options.now,
				sourceOf: (id) => sources.get(id),
				dateOf: (id) => dates.get(id),
				refused: readSupersessions(storeP).superseded,
				...(options.signal ? { signal: options.signal } : {}),
			},
		);
		if (!outcome.outcome.ok) {
			resolution.problems.push(`${slug}: ${outcome.outcome.reason}`);
			return undefined;
		}
		if (outcome.dropped.length > 0) resolution.notes.push(`${slug}: dropped ${outcome.dropped.join(", ")}`);
		file = outcome.outcome.applied.topic;
		appendSupersessions(storeP, outcome.outcome.supersessions);
		added = outcome.outcome.applied.added.map((fact) => fact.id);
	}

	mkdirSync(join(storeP, "topics"), { recursive: true });
	writeFileSync(join(storeP, path.slice("topics/".length) === "" ? path : `topics/${slug}.md`), formatTopic(file));
	return { topic: slug, residue: merged.residue.length, added };
}

/** A conflicted file's content at an index stage, or nothing when the side lacks it. */
async function stageOf(cwd: string, stage: 1 | 2 | 3, path: string): Promise<string | undefined> {
	try {
		return (await git(cwd, { kind: "show-stage", stage, path })).stdout;
	} catch {
		return undefined;
	}
}
