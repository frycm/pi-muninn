/**
 * A dream: read the journal, write the derived layers on a branch, report.
 *
 * The job runs inside a worktree and the working store is never touched until
 * *remember*. What makes the two safe to overlap is one recorded fact:
 * `input_head`, the commit the worktree was cut from. Everything the dream
 * consolidated is at or before it, sessions keep appending past it, and the
 * next dream picks those entries up.
 *
 * The sequence:
 *
 *   [lock] commit this host's pending journal → record input_head → worktree [unlock]
 *   → orient → gather → consolidate → lint → MEMORY.md → report → commit on the branch
 *
 * **The store lock is held for the setup only.** A dream is minutes of work,
 * and the design's promise is that capture keeps writing throughout — so
 * holding `.lock` for the whole run would block every append on this machine
 * for the duration, and a queued append that times out waiting is an entry lost
 * for good. What the lock is genuinely needed for is one atomic moment: commit
 * the pending journal and read `HEAD`, with nothing landing in between, or
 * `input_head` would name a commit that is not what the worktree contains.
 * Everything after that happens in a checkout nothing else can see.
 *
 * Two dreams on one host are excluded by a separate marker, `.dreaming`, which
 * outlives the lock and goes stale after two hours. It has to be separate: a
 * lock that excludes other dreams *and* excludes capture is one that cannot do
 * the first job without doing the second.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { commitJournalLocked } from "../capture/commit.ts";
import { jaccard } from "../capture/outcome.ts";
import { DERIVED_PATHS, GitError, type GitIdentity, git } from "../git.ts";
import { uuidv7 } from "../ids.ts";
import { claimsOf, type Source } from "../journal/format.ts";
import { type JournalEntryWithContext, readStoreJournal } from "../journal/read.ts";
import { appendSupersessions, readSupersessions } from "../journal/supersessions.ts";
import type { MuninnSettings } from "../settings.ts";
import type { HostIdentity } from "../store/host.ts";
import { storeIdentity } from "../store/init.ts";
import { LockBusyError, withStoreLock } from "../store/lock.ts";
import type { ActiveScope } from "../store/scopes.ts";
import { allFacts, emptyTopic, formatTopic } from "../topics/format.ts";
import { type ConsolidateJob, consolidate } from "./consolidate.ts";
import { ECHO_THRESHOLD, type GatherResult, gather } from "./gather.ts";
import { lint } from "./lint.ts";
import { buildMemory } from "./memory-md.ts";
import type { DreamModel } from "./model.ts";
import { type Orientation, orient, readTopics } from "./orient.ts";
import { type DreamReport, emptyReport, formatReport, reportPath, reportTotals } from "./report.ts";
import {
	collectWorktrees,
	createWorktree,
	type DreamWorktree,
	dreamBranch,
	dreamStamp,
	repositoryFor,
	worktreeRoot,
} from "./worktree.ts";

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
	/** The global store's `rules.md`, when dreaming a project scope. */
	globalRules?: string;
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
	const stamp = dreamStamp(now, host);
	const branch = dreamBranch(stamp);
	const report = emptyReport({ stamp, scope: scope.scope, host: host.name, started: now.toISOString() });
	const problems: string[] = [];
	const fail = (problem: string): DreamResult => {
		problems.push(problem);
		report.status = "failed";
		return { ok: false, stamp, branch, report, problems };
	};

	const identity = scope.inRepo ? undefined : storeIdentity(host);
	const context: LockedContext = { stamp, branch, report, problems, identity };

	let prepared: Prepared;
	try {
		prepared = await withStoreLock(
			scope.path,
			"dream",
			{ host: host.id, ...(options.staleMs !== undefined ? { staleMs: options.staleMs } : {}) },
			async () => prepare(options, context),
		);
	} catch (error) {
		if (error instanceof LockBusyError) return fail(error.message);
		if (error instanceof GitError) return fail(error.message);
		return fail(error instanceof Error ? error.message : String(error));
	}

	if (!prepared.ok) return { ok: false, stamp, branch, report, problems };

	try {
		// Unlocked from here: everything is written into the worktree, which
		// nothing else on this machine can see, and capture is free to append.
		return await runPhases(options, context, prepared);
	} finally {
		clearDreamMarker(scope.path, prepared.token ?? "");
	}
}

/**
 * The marker that excludes another dream on this host.
 *
 * Separate from the store lock because it has to outlive it: the lock is
 * released after setup so capture can keep writing, and something still has to
 * say "a dream is running here". Stale after two hours, matching what the lock
 * would have used, so a dream killed with `SIGKILL` does not wedge the store.
 */
const DREAM_MARKER = ".dreaming";
const DREAM_STALE_MS = 7_200_000;

interface DreamMarker {
	pid: number;
	host: string;
	stamp: string;
	at: string;
	/**
	 * This run's claim on the marker.
	 *
	 * A dream that outlives the two-hour staleness window can be superseded by a
	 * second one; when the first finally exits, an unconditional removal would
	 * delete the *second* run's live marker and let a third dream in beside it.
	 * The token makes clearing conditional: a run removes the marker only while
	 * the marker is still its own.
	 */
	token: string;
}

export function dreamMarkerPath(storePath: string): string {
	return join(storePath, DREAM_MARKER);
}

export function readDreamMarker(storePath: string): DreamMarker | undefined {
	try {
		const parsed = JSON.parse(readFileSync(dreamMarkerPath(storePath), "utf-8")) as Partial<DreamMarker>;
		if (typeof parsed.pid !== "number" || typeof parsed.at !== "string") return undefined;
		return parsed as DreamMarker;
	} catch {
		return undefined;
	}
}

function clearDreamMarker(storePath: string, token: string): void {
	const marker = readDreamMarker(storePath);
	if (marker !== undefined && marker.token !== token) return;
	rmSync(dreamMarkerPath(storePath), { force: true });
}

/**
 * Whether a dream is running here, and not merely one that died.
 *
 * Exported because remember, forget and erase all have to ask: each of them
 * touches worktrees or rewrites refs, and since a dream releases the store lock
 * after its setup, the lock no longer answers the question.
 */
export function runningDream(storePath: string, now: Date, staleMs: number = DREAM_STALE_MS): DreamMarker | undefined {
	return dreamInProgress(storePath, now, staleMs);
}

/** Whether another dream is running here, and not merely one that died. */
function dreamInProgress(storePath: string, now: Date, staleMs: number): DreamMarker | undefined {
	const marker = readDreamMarker(storePath);
	if (marker === undefined) return undefined;
	const age = now.getTime() - Date.parse(marker.at);
	if (Number.isNaN(age) || age > staleMs) return undefined;
	return marker;
}

interface LockedContext {
	stamp: string;
	branch: string;
	report: DreamReport;
	problems: string[];
	identity: GitIdentity | undefined;
}

interface Prepared {
	ok: boolean;
	worktree?: DreamWorktree;
	token?: string;
}

/**
 * The part that needs the store lock: commit, read `HEAD`, cut the worktree.
 *
 * Milliseconds of work, which is all capture ever has to wait for.
 */
async function prepare(options: DreamOptions, context: LockedContext): Promise<Prepared> {
	const { scope, host, now } = options;
	const { branch, report, problems, identity } = context;
	const repo = await repositoryFor(scope);

	const running = dreamInProgress(scope.path, now, options.staleMs ?? DREAM_STALE_MS);
	if (running !== undefined) {
		problems.push(
			`muninn: a dream is already running here (pid ${running.pid} on host ${running.host}, started ${running.at})`,
		);
		report.status = "failed";
		return { ok: false };
	}

	// A dream that died leaves a worktree behind. The lock is held and no
	// unexpired marker exists, so no other dream on this host is alive — which
	// makes this the one moment at which every dream worktree registered here is
	// provably garbage.
	const collected = await collectWorktrees(repo, { keep: context.branch, ownedRoot: worktreeRoot(options.agentDir) });
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
		return { ok: false };
	}
	report.inputHead = inputHead;

	const worktree = await createWorktree({
		scope,
		agentDir: options.agentDir,
		storeId: options.storeId,
		branch,
		startPoint: inputHead,
	});

	const token = uuidv7();
	writeFileSync(
		dreamMarkerPath(scope.path),
		`${JSON.stringify(
			{ pid: process.pid, host: host.id, stamp: context.stamp, at: now.toISOString(), token },
			null,
			"\t",
		)}\n`,
	);

	return { ok: true, worktree, token };
}

/** Everything after the lock is released: reading, consolidating, committing the branch. */
async function runPhases(options: DreamOptions, context: LockedContext, prepared: Prepared): Promise<DreamResult> {
	const { scope, now, progress } = options;
	const { stamp, branch, report, problems, identity } = context;
	const worktree = prepared.worktree as DreamWorktree;

	try {
		progress?.("orient");
		const orientation = orient(worktree.storePath);
		problems.push(...orientation.problems);
		if (orientation.previousInputHead) report.previousInputHead = orientation.previousInputHead;

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

		progress?.("consolidate");
		report.model = options.model?.id ?? "none";
		let ran = new Set<string>();
		if (options.model !== undefined) {
			ran = await consolidateAll(worktree.storePath, gathered, orientation, options, report);
		} else if (gathered.jobs.length > 0) {
			report.notes.push(`${gathered.jobs.length} topic(s) had new evidence but no dreamer model was configured`);
		}

		// The watermark is where the *next* dream starts, and it is computed
		// *after* consolidation because only then is it known what was actually
		// consumed. Withheld entries — held-out groups, deferred claims, the
		// quarantine — were never offered; a job that was skipped, failed, or had
		// no model to run against consumed nothing either. Recording any of them
		// as seen would drop them out of every future range: a hold-out would
		// become a deletion, and a model outage would quietly eat a day's
		// evidence.
		report.journalThrough = journalThrough(inRange, notConsumed(gathered, ran), orientation.previousJournalThrough);

		progress?.("lint");
		const linted = lint({
			topics: readTopics(worktree.storePath),
			claims: allClaimIds(worktree.storePath),
			superseded: readSupersessions(worktree.storePath).superseded,
			erased: orientation.erased,
			echoes: echoClaims(worktree.storePath, orientation),
			rules: orientation.rules,
			memory: orientation.memory,
			usage: orientation.usage,
			rulesCap: options.settings.dream.rulesCap,
			retireAfterDays: options.settings.dream.retireAfterDays,
			now,
			...(options.globalRules !== undefined ? { globalRules: options.globalRules } : {}),
		});
		report.lint.push(...linted.findings);
		for (const pair of linted.candidates) {
			report.lint.push({
				blocking: false,
				rule: "contradiction-candidate",
				message: `${pair.topic}: ${pair.a.id} and ${pair.b.id} say nearly the same thing`,
			});
		}
		if (linted.blocking > 0) {
			// The branch and the report are kept: a blocked dream is evidence,
			// and deleting it would leave nobody able to see what it did wrong.
			report.status = "lint-blocked";
			problems.push(`${linted.blocking} blocking lint finding(s); this dream will not be offered for remember`);
		}

		progress?.("commit");
		// Regenerated even when no topic changed: use counts move with every
		// session, so the ordering can be stale while the facts are not. It is
		// byte-stable, so an unchanged ordering still produces no diff.
		const memory = buildMemory({
			topics: readTopics(worktree.storePath),
			rules: orientation.rules,
			usage: orientation.usage,
			current: orientation.memory,
			budget: options.settings.recall.snapshotLines[scope.scope],
		});
		writeFileSync(join(worktree.storePath, "MEMORY.md"), memory.text);
		if (memory.dropped.length > 0) {
			report.notes.push(`MEMORY.md: ${memory.dropped.length} topic(s) over the line budget, still searchable`);
		}

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

/**
 * Run every topic's job, writing each result as it lands.
 *
 * One topic at a time and written as it goes, rather than collected and applied
 * at the end: a dream that dies halfway has still produced a branch with real
 * work on it and a report saying where it stopped, which is reviewable. The
 * alternative loses everything to the last failure.
 */
async function consolidateAll(
	storePath: string,
	gathered: GatherResult,
	orientation: Orientation,
	options: DreamOptions,
	report: DreamReport,
): Promise<Set<string>> {
	const ran = new Set<string>();
	const model = options.model;
	if (model === undefined) return ran;

	// Source and date per journal claim, for the fact's own source and for
	// turning "yesterday" into a date. Built once: every job asks about the
	// same claims.
	const sources = new Map<string, Source>();
	const dates = new Map<string, string>();
	for (const job of gathered.jobs) {
		for (const entry of job.entries) {
			for (const claim of claimsOf(entry)) {
				sources.set(claim.id, entry.source);
				dates.set(claim.id, entry.date);
			}
		}
	}
	// The allow-list also admits the evidence the topic's own facts stand on,
	// and those claims are not in any job's entries — so without this their
	// source is unknown, `sourceFor` falls back to `agent`, and a fact resting
	// only on fetched content lands in `## Facts` instead of the quarantine. A
	// fact's own `source` is exactly the class its evidence rests on, so it is
	// the right answer to carry forward.
	for (const topic of orientation.topics.values()) {
		for (const fact of allFacts(topic)) {
			for (const id of fact.evidence) if (!sources.has(id)) sources.set(id, fact.source);
		}
	}

	// Echoes are never evidence — and the ids to refuse are the *echoing claims*,
	// not the memories they echo. `echo:` names what was restated, so adding
	// those ids refused the original observation while leaving the restatement
	// citable: both halves wrong, in one line. Gather drops echoing claims from
	// its candidate list, but an entry reaches a job for *one* of its claims and
	// brings all of them into the prompt and the allow-list, so the refusal has
	// to be by claim id.
	const refused = new Set<string>([...orientation.superseded, ...echoClaims(storePath, orientation)]);

	for (const gatheredJob of gathered.jobs) {
		const file = orientation.topics.get(gatheredJob.topic) ?? emptyTopic(gatheredJob.topic);
		const job: ConsolidateJob = {
			topic: gatheredJob.topic,
			isNew: gatheredJob.isNew,
			file,
			claims: gatheredJob.claims,
			entries: gatheredJob.entries,
		};

		const outcome = await consolidate(job, {
			model,
			now: options.now,
			sourceOf: (id) => sources.get(id),
			dateOf: (id) => dates.get(id),
			refused,
			...(options.signal ? { signal: options.signal } : {}),
		});

		for (const refusal of outcome.refusals) {
			report.lint.push({ blocking: false, rule: refusal.rule, message: `${gatheredJob.topic}: ${refusal.claim}` });
		}
		if (!outcome.ok) {
			report.skipped.push({ topic: gatheredJob.topic, reason: outcome.reason });
			continue;
		}
		ran.add(gatheredJob.topic);
		if (outcome.retries > 0) report.notes.push(`${gatheredJob.topic}: ${outcome.retries} retry`);
		if (outcome.applied.added.length === 0 && outcome.applied.superseded.length === 0) continue;

		mkdirSync(join(storePath, "topics"), { recursive: true });
		writeFileSync(join(storePath, "topics", `${gatheredJob.topic}.md`), formatTopic(outcome.applied.topic));
		appendSupersessions(storePath, outcome.supersessions);

		report.consolidated.push({
			topic: gatheredJob.topic,
			added: outcome.applied.added.length,
			superseded: outcome.applied.superseded.length,
			addedIds: outcome.applied.added.map((fact) => fact.id),
		});
	}
	return ran;
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

/** Every journal claim id in the store, for lint's "does this evidence exist" check. */
export function allClaimIds(storePath: string): Set<string> {
	const ids = new Set<string>();
	for (const entry of readStoreJournal(storePath).entries) for (const claim of claimsOf(entry)) ids.add(claim.id);
	return ids;
}

/**
 * Journal claims that merely restate a memory the model was shown.
 *
 * `echo:` on an entry names the *recalled memory* it echoed, not which of its
 * claims did the echoing, so the claim is identified the same way capture
 * identified the echo in the first place: by overlap against that memory's text.
 * Recomputing rather than storing it means the two can never disagree about
 * what an echo is.
 */
export function echoClaims(storePath: string, orientation: Orientation): Set<string> {
	const echoes = new Set<string>();
	for (const entry of readStoreJournal(storePath).entries) {
		if (entry.echo === undefined || entry.echo.length === 0) continue;
		const texts = entry.echo
			.map((id) => orientation.echoedText.get(id))
			.filter((text): text is string => text !== undefined);
		if (texts.length === 0) continue;
		for (const claim of claimsOf(entry)) {
			if (texts.some((text) => jaccard(claim.text, text) >= ECHO_THRESHOLD)) echoes.add(claim.id);
		}
	}
	return echoes;
}

/**
 * Entry ids this dream did not actually learn from, whatever the reason.
 *
 * Gather's own withheld set (held-out, deferred, quarantined), plus the entries
 * of every job that did not produce a consolidation: no model configured, the
 * model unreachable, the reply unusable, the loss guard tripped. The entries
 * are on disk and cited by nothing, so leaving them out of the watermark is
 * what keeps them in the next dream's range.
 */
function notConsumed(gathered: GatherResult, ran: ReadonlySet<string>): Set<string> {
	const excluded = new Set(gathered.withheld);
	for (const job of gathered.jobs) {
		// `ran` is "the job completed", not "the job changed something". A model
		// that legitimately answers "keep everything" has consumed its evidence
		// — the entries were considered and found to add nothing — and using
		// `report.consolidated` as the proxy pinned the watermark at that job's
		// first entry forever: the identical job rebuilt every dream, the
		// identical no-op answer, a livelock with a model bill.
		if (ran.has(job.topic)) continue;
		for (const entry of job.entries) excluded.add(entry.id);
	}
	return excluded;
}

/**
 * The last entry id per host this dream may claim to have seen.
 *
 * The **largest contiguous prefix** per host, not the maximum retained id: with
 * retained and withheld entries interleaved, a maximum would advance past the
 * withheld ones and they would fall before `previous_input_head` forever. The
 * watermark stops at each host's first unconsumed entry, so everything after it
 * — consumed or not — is offered again; what was already consumed is dropped by
 * gather's already-cited rule rather than by the range.
 *
 * Starts from the previous watermark, because "this dream advanced nothing for
 * a host" must not read as "start that host from the beginning of time".
 */
function journalThrough(
	entries: readonly JournalEntryWithContext[],
	excluded: ReadonlySet<string>,
	previous: Readonly<Record<string, string>>,
): Record<string, string> {
	const through: Record<string, string> = { ...previous };
	const byHost = new Map<string, JournalEntryWithContext[]>();
	for (const entry of entries) {
		const bucket = byHost.get(entry.host);
		if (bucket) bucket.push(entry);
		else byHost.set(entry.host, [entry]);
	}
	for (const [host, bucket] of byHost) {
		bucket.sort((a, b) => (a.id < b.id ? -1 : 1));
		for (const entry of bucket) {
			if (excluded.has(entry.id)) break;
			through[host] = entry.id;
		}
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
