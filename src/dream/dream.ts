/**
 * A dream: read the journal, write the derived layers on a branch, report.
 *
 * The whole job runs under the store's `dream` lock and inside a worktree, and
 * the working store is never touched until *remember*. What makes the two safe
 * to overlap is one recorded fact: `input_head`, the commit the worktree was
 * cut from. Everything the dream consolidated is at or before it, sessions keep
 * appending past it, and the next dream picks those entries up.
 *
 * The sequence is deliberately boring:
 *
 *   lock → commit this host's pending journal → record input_head → worktree →
 *   orient → gather → consolidate → lint → MEMORY.md → report → commit → unlock
 *
 * Committing the pending journal happens *inside* the lock, through
 * `commitJournalLocked`: the lock is not reentrant, and the alternative — commit
 * first, then lock — leaves a window in which another session's append lands
 * between the commit and the `rev-parse`, so `input_head` would name a commit
 * that is not what the worktree contains.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { commitJournalLocked } from "../capture/commit.ts";
import { DERIVED_PATHS, GitError, type GitIdentity, git } from "../git.ts";
import { type JournalEntryWithContext, readStoreJournal } from "../journal/read.ts";
import type { MuninnSettings } from "../settings.ts";
import type { HostIdentity } from "../store/host.ts";
import { storeIdentity } from "../store/init.ts";
import { LockBusyError, withStoreLock } from "../store/lock.ts";
import type { ActiveScope } from "../store/scopes.ts";
import { gather } from "./gather.ts";
import type { DreamModel } from "./model.ts";
import { type Orientation, orient } from "./orient.ts";
import { type DreamReport, emptyReport, formatReport, reportPath, reportTotals } from "./report.ts";
import { collectWorktrees, createWorktree, dreamBranch, dreamStamp, repositoryFor } from "./worktree.ts";

export interface DreamOptions {
	scope: ActiveScope;
	agentDir: string;
	host: HostIdentity;
	storeId: string;
	settings: MuninnSettings;
	now: Date;
	/** Absent until a phase needs one; a dream that consolidates nothing never does. */
	model?: DreamModel;
	signal?: AbortSignal;
	/** Called as each phase starts, for the status line and for `--print`. */
	progress?: (phase: string) => void;
	/** Test seam: the lock's staleness window. */
	staleMs?: number;
}

export interface DreamResult {
	ok: boolean;
	stamp: string;
	branch: string;
	report: DreamReport;
	/** Path of the worktree, while it existed. For diagnostics only. */
	worktree?: string;
	problems: string[];
}

/** The phases, in order, as the progress callback names them. */
export const PHASES = ["orient", "gather", "consolidate", "lint", "commit"] as const;

/**
 * Run one dream against one scope.
 *
 * Never throws for anything a caller could be expected to handle: a busy lock, a
 * store that is not a repository, a model that will not answer. Those come back
 * as `ok: false` with problems, because a dream is started from a keystroke and
 * a stack trace is not an answer. A programming error still throws.
 */
export async function dream(options: DreamOptions): Promise<DreamResult> {
	const { scope, host, now } = options;
	const stamp = dreamStamp(now);
	const branch = dreamBranch(host.name, stamp);
	const report = emptyReport({ stamp, scope: scope.scope, host: host.name, started: now.toISOString() });
	const problems: string[] = [];
	const fail = (problem: string): DreamResult => {
		problems.push(problem);
		report.status = "failed";
		return { ok: false, stamp, branch, report, problems };
	};

	const identity = scope.inRepo ? undefined : storeIdentity(host);

	try {
		return await withStoreLock(
			scope.path,
			"dream",
			{ host: host.id, ...(options.staleMs !== undefined ? { staleMs: options.staleMs } : {}) },
			async () => runLocked(options, { stamp, branch, report, problems, identity }),
		);
	} catch (error) {
		if (error instanceof LockBusyError) return fail(error.message);
		if (error instanceof GitError) return fail(error.message);
		return fail(error instanceof Error ? error.message : String(error));
	}
}

interface LockedContext {
	stamp: string;
	branch: string;
	report: DreamReport;
	problems: string[];
	identity: GitIdentity | undefined;
}

async function runLocked(options: DreamOptions, context: LockedContext): Promise<DreamResult> {
	const { scope, host, now, progress } = options;
	const { stamp, branch, report, problems, identity } = context;
	const repo = await repositoryFor(scope);

	// A dream that died leaves a worktree and a lock. The lock is held right
	// now, so no other dream on this host is alive, which makes this the one
	// moment at which every dream worktree registered here is provably garbage.
	const collected = await collectWorktrees(repo);
	if (collected.length > 0) report.notes.push(`removed ${collected.length} abandoned worktree(s)`);

	// Everything this host has observed and not yet committed, committed now, so
	// that `input_head` names a commit containing it.
	const pending = await commitJournalLocked(
		{
			storePath: scope.path,
			hostId: host.id,
			hostName: host.name,
			entries: 0,
			force: true,
			...(identity ? { identity } : {}),
		},
		now.getTime(),
	);
	if (pending.committed) report.notes.push("committed this host's pending journal entries");

	let inputHead: string;
	try {
		inputHead = (await git(scope.path, { kind: "rev-parse", target: "HEAD" })).stdout.trim();
	} catch (error) {
		problems.push(
			error instanceof GitError
				? `the store has no commits to dream from (${error.stderr.trim().split("\n")[0]})`
				: String(error),
		);
		report.status = "failed";
		return { ok: false, stamp, branch, report, problems };
	}
	report.inputHead = inputHead;

	const worktree = await createWorktree({
		scope,
		agentDir: options.agentDir,
		storeId: options.storeId,
		branch,
		startPoint: inputHead,
	});

	try {
		progress?.("orient");
		const orientation = orient(worktree.storePath);
		problems.push(...orientation.problems);
		if (orientation.previousInputHead) report.previousInputHead = orientation.previousInputHead;
		report.journalThrough = journalThrough(worktree.storePath);

		progress?.("gather");
		const inRange = entriesInRange(worktree.storePath, orientation);
		const gathered = gather({
			orientation,
			entries: inRange,
			holdOut: options.settings.dream.evalSessions,
			now,
		});
		report.heldOut = gathered.heldOut;
		report.gathered.push(...describeRange(orientation, report));
		report.gathered.push(`${inRange.length} entry/entries in range, ${gathered.jobs.length} topic(s) affected`);
		report.gathered.push(...gathered.notes);
		for (const quarantined of gathered.quarantined) {
			report.lint.push({
				blocking: false,
				rule: "poisoning-budget",
				message: `${quarantined.topic}: ${quarantined.reason}`,
			});
		}

		progress?.("commit");
		report.model = options.model?.id ?? "none";
		report.finished = new Date(now.getTime()).toISOString();
		await writeReport(worktree.storePath, report);
		await commitDream(worktree.storePath, report, identity);

		return { ok: true, stamp, branch, report, worktree: worktree.root, problems };
	} catch (error) {
		report.status = "failed";
		problems.push(error instanceof Error ? error.message : String(error));
		// The worktree is deliberately *not* removed on failure: the branch and
		// whatever the dream managed to write are the evidence for why it failed,
		// and the next dream collects it once the lock goes stale.
		return { ok: false, stamp, branch, report, worktree: worktree.root, problems };
	}
}

/** Write the report into the worktree, creating `dreams/` on first use. */
async function writeReport(storePath: string, report: DreamReport): Promise<void> {
	const path = join(storePath, reportPath(report.stamp));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, formatReport(report));
}

/**
 * Commit everything derived, on the dream's branch.
 *
 * The pathspec is every derived path, not just the ones that changed: git stages
 * what differs and ignores what does not, and naming the set explicitly is what
 * keeps a dream commit from ever picking up a journal file.
 */
async function commitDream(storePath: string, report: DreamReport, identity: GitIdentity | undefined): Promise<void> {
	const paths = DERIVED_PATHS.filter((path) => existsSync(join(storePath, path.replace(/\/$/, ""))));
	if (paths.length === 0) return;
	await git(storePath, { kind: "add", paths: [...paths] });

	const totals = reportTotals(report);
	const message = [
		`dream: ${totals.added} facts, ${totals.superseded} superseded, ${totals.topics} topics`,
		"",
		`Muninn-Dream: ${report.stamp}`,
		`Muninn-Input-Head: ${report.inputHead}`,
		...(report.consolidated.length > 0
			? [`Muninn-Topics: ${report.consolidated.map((change) => change.topic).join(", ")}`]
			: []),
	].join("\n");
	await git(storePath, { kind: "commit", message, paths: [...paths] }, identity ? { identity } : {});
}

/**
 * The entries a dream may learn from.
 *
 * The range is "since the last complete dream", expressed per host as an id
 * comparison rather than as a git diff over daily files. A daily file grows
 * across dreams — the same file is touched again tomorrow — so "which files
 * changed" answers a coarser question than "which entries are new", and the
 * coarser answer would re-consolidate everything written earlier the same day.
 * Ids are UUIDv7, so `>` is chronological, per host, without a clock.
 */
function entriesInRange(storePath: string, orientation: Orientation): JournalEntryWithContext[] {
	const through = orientation.previousJournalThrough;
	return readStoreJournal(storePath).entries.filter((entry) => {
		const last = through[entry.host];
		return last === undefined || entry.id > last;
	});
}

/** The last entry id per host in the store, which is where the next dream starts. */
function journalThrough(storePath: string): Record<string, string> {
	const through: Record<string, string> = {};
	for (const entry of readStoreJournal(storePath).entries) {
		const current = through[entry.host];
		if (current === undefined || current < entry.id) through[entry.host] = entry.id;
	}
	return through;
}

function describeRange(orientation: Orientation, report: DreamReport): string[] {
	const range = report.previousInputHead
		? `${report.previousInputHead.slice(0, 8)}..${report.inputHead.slice(0, 8)}`
		: `up to ${report.inputHead.slice(0, 8)}`;
	return [
		`range ${range}`,
		`${orientation.topics.size} topic(s), ${orientation.factsById.size} fact(s), ${orientation.superseded.size} superseded claim(s)`,
	];
}
