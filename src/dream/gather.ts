/**
 * Phase 2 of a dream: decide what is worth consolidating.
 *
 * Deterministic, and the whole design leans on it being so. Gather is *search*,
 * not judgement — the model never sees this decision — and every rule it
 * applies exists to stop one specific way a memory store goes bad:
 *
 *  - **Recurrence gating.** A single `agent` or `tool` observation stays in the
 *    journal. Promoting one to a fact is how a store fills with things the
 *    model once believed.
 *  - **Echo exclusion.** A claim that restates a memory the model was just
 *    shown is not a second observation. Without this a fact corroborates
 *    itself: recalled, restated, observed again, promoted on its own echo.
 *  - **Active-only.** Superseded claims and erased entries are not evidence,
 *    ever, and gather is the phase where "ever" has to be enforced.
 *  - **The hold-out.** The most recent completed task groups are removed
 *    entirely — every entry of every source, not just their outcomes — so that
 *    Phase 3 can score the dream on tasks no part of it ever saw.
 *  - **The poisoning budget.** A topic whose evidence is mostly `external` is
 *    someone else's writing, and it waits for a human.
 */

import { jaccard } from "../capture/outcome.ts";
import { chunkTopic } from "../index/chunk.ts";
import { Tier0Index } from "../index/tier0.ts";
import { claimsOf, type JournalEntry } from "../journal/format.ts";
import type { JournalEntryWithContext } from "../journal/read.ts";
import { formatTopic, type TopicFile } from "../topics/format.ts";
import type { Orientation } from "./orient.ts";

/** Overlap at which two claims are "the same observation again". */
export const RECURRENCE_THRESHOLD = 0.8;
/** Overlap at which a claim is an echo of the memory it cites. */
export const ECHO_THRESHOLD = 0.8;
/** Evidence entries one consolidate job may carry, so the prompt fits 8k. */
export const MAX_EVIDENCE = 30;
/** Above this share of `external` evidence, a topic waits for a human. */
export const MAX_EXTERNAL_SHARE = 0.5;

export type GatherReason = "user" | "decision" | "failure" | "recurrence";

export interface GatheredClaim {
	/** `j-….n` */
	id: string;
	text: string;
	entry: JournalEntryWithContext;
	reason: GatherReason;
	/** How many distinct task groups made this observation. */
	occurrences: number;
}

export interface TopicJob {
	topic: string;
	/** True when no such topic file exists yet. */
	isNew: boolean;
	claims: GatheredClaim[];
	/** The entries behind those claims, deduplicated and bounded. */
	entries: JournalEntryWithContext[];
	/** Claim ids left for the next dream because the job was full. */
	deferred: string[];
}

export interface GatherResult {
	jobs: TopicJob[];
	/** Task ids withheld from everything above. */
	heldOut: string[];
	/** Topics not consolidated, and why. */
	quarantined: Array<{ topic: string; reason: string }>;
	/** Claim ids considered and rejected, with the rule that rejected them. */
	dropped: Array<{ id: string; reason: string }>;
	notes: string[];
}

export interface GatherOptions {
	orientation: Orientation;
	/** Entries in `previous_input_head..input_head`, from the worktree. */
	entries: readonly JournalEntryWithContext[];
	/** `dream.evalSessions` — how many recent task groups to withhold. */
	holdOut: number;
	now: Date;
	/** Entries with no activity for this long count as finished. */
	quietMs?: number;
}

const QUIET_MS = 60 * 60 * 1000;

export function gather(options: GatherOptions): GatherResult {
	const { orientation, entries, now } = options;
	const result: GatherResult = { jobs: [], heldOut: [], quarantined: [], dropped: [], notes: [] };

	// --- 1. hold out the most recent completed task groups -------------------
	const groups = taskGroups(entries);
	const held = completedGroups(groups, now, options.quietMs ?? QUIET_MS).slice(0, Math.max(0, options.holdOut));
	const heldTasks = new Set(held.flatMap((group) => group.tasks));
	result.heldOut = [...heldTasks].sort();
	// Every task id of every held group, so a resumed half of a task cannot leak
	// back in through its other half.
	const visible = entries.filter((entry) => entry.task === undefined || !heldTasks.has(entry.task));
	if (heldTasks.size > 0) {
		result.notes.push(`held out ${held.length} completed task group(s) — ${heldTasks.size} task id(s)`);
	}

	// --- 2. candidate claims -------------------------------------------------
	const candidates: GatheredClaim[] = [];
	for (const entry of visible) {
		if (orientation.erased.has(entry.id)) {
			result.dropped.push({ id: entry.id, reason: "erased" });
			continue;
		}
		const echoed = echoedText(entry, orientation);
		for (const claim of claimsOf(entry)) {
			if (orientation.superseded.has(claim.id)) {
				result.dropped.push({ id: claim.id, reason: "superseded" });
				continue;
			}
			if (orientation.citedBy.has(claim.id)) {
				result.dropped.push({ id: claim.id, reason: `already evidence for ${orientation.citedBy.get(claim.id)}` });
				continue;
			}
			// An echo is journaled as a usage signal and is never evidence: the
			// model restating what it was just shown is not an observation.
			if (echoed.some((text) => jaccard(claim.text, text) >= ECHO_THRESHOLD)) {
				result.dropped.push({ id: claim.id, reason: "echo of a recalled memory" });
				continue;
			}
			candidates.push({ id: claim.id, text: claim.text, entry, reason: "user", occurrences: 1 });
		}
	}

	// --- 3. selection --------------------------------------------------------
	const selected: GatheredClaim[] = [];
	for (const candidate of candidates) {
		const reason = selectionReason(candidate, candidates);
		if (reason === undefined) {
			result.dropped.push({ id: candidate.id, reason: "single agent/tool observation — not yet recurrent" });
			continue;
		}
		selected.push({ ...candidate, reason: reason.reason, occurrences: reason.occurrences });
	}

	// --- 4. topic assignment -------------------------------------------------
	const router = topicRouter(orientation.topics);
	const byTopic = new Map<string, GatheredClaim[]>();
	for (const claim of selected) {
		const topic = router(claim) ?? newTopicSlug(claim);
		const bucket = byTopic.get(topic);
		if (bucket) bucket.push(claim);
		else byTopic.set(topic, [claim]);
	}

	// --- 5. bounds and quarantine -------------------------------------------
	for (const [topic, claims] of [...byTopic.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const external = claims.filter((claim) => claim.entry.source === "external").length;
		if (claims.length > 0 && external / claims.length > MAX_EXTERNAL_SHARE) {
			result.quarantined.push({
				topic,
				reason: `${external} of ${claims.length} claims are external — over the poisoning budget, waiting for review`,
			});
			continue;
		}

		// Newest first, so a full job carries what is most current and the rest
		// is deferred rather than lost: nothing cites them, so the next dream's
		// range still contains them.
		const ordered = [...claims].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
		const kept: GatheredClaim[] = [];
		const seen = new Set<string>();
		const deferred: string[] = [];
		for (const claim of ordered) {
			if (!seen.has(claim.entry.id) && seen.size >= MAX_EVIDENCE) {
				deferred.push(claim.id);
				continue;
			}
			seen.add(claim.entry.id);
			kept.push(claim);
		}

		const entriesById = new Map<string, JournalEntryWithContext>();
		for (const claim of kept) entriesById.set(claim.entry.id, claim.entry);
		result.jobs.push({
			topic,
			isNew: !orientation.topics.has(topic),
			claims: kept,
			entries: [...entriesById.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
			deferred,
		});
		if (deferred.length > 0) {
			result.notes.push(`${topic}: ${deferred.length} claim(s) deferred — the job was full at ${MAX_EVIDENCE} entries`);
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Task groups and the hold-out
// ---------------------------------------------------------------------------

export interface TaskGroup {
	/** Every task id in the group, closed over `continues`. */
	tasks: string[];
	entries: JournalEntryWithContext[];
	/** The newest entry id in the group; UUIDv7, so it orders by time. */
	latest: string;
	hasOutcome: boolean;
}

/**
 * Group entries by task, closing over `continues`.
 *
 * A resumed or forked session is the same piece of work, so the unit the
 * evaluate phase holds out has to be the closure and not the session — holding
 * out half a task would leak the other half into consolidation.
 */
export function taskGroups(entries: readonly JournalEntryWithContext[]): Map<string, TaskGroup> {
	const parent = new Map<string, string>();
	const find = (task: string): string => {
		let root = task;
		while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root) as string;
		return root;
	};
	const union = (a: string, b: string): void => {
		const rootA = find(a);
		const rootB = find(b);
		if (rootA === rootB) return;
		// Smallest id wins, so the group key is stable whatever order the
		// entries arrive in — two hosts must name the same group the same way.
		if (rootA < rootB) parent.set(rootB, rootA);
		else parent.set(rootA, rootB);
	};

	for (const entry of entries) {
		if (entry.task === undefined) continue;
		if (parent.get(entry.task) === undefined) parent.set(entry.task, entry.task);
		if (entry.continues !== undefined) {
			if (parent.get(entry.continues) === undefined) parent.set(entry.continues, entry.continues);
			union(entry.task, entry.continues);
		}
	}

	const groups = new Map<string, TaskGroup>();
	for (const entry of entries) {
		if (entry.task === undefined) continue;
		const key = find(entry.task);
		let group = groups.get(key);
		if (!group) {
			group = { tasks: [], entries: [], latest: "", hasOutcome: false };
			groups.set(key, group);
		}
		group.entries.push(entry);
		if (!group.tasks.includes(entry.task)) group.tasks.push(entry.task);
		if (entry.continues !== undefined && !group.tasks.includes(entry.continues)) group.tasks.push(entry.continues);
		if (entry.id > group.latest) group.latest = entry.id;
		if (isOutcome(entry)) group.hasOutcome = true;
	}
	for (const group of groups.values()) group.tasks.sort();
	return groups;
}

/** An outcome entry is the model's own summary of a finished run. */
function isOutcome(entry: JournalEntry): boolean {
	return entry.source === "agent" && entry.channel !== "dream";
}

/**
 * Completed groups, newest first.
 *
 * "Completed" needs a definition that works on a journal alone, so: the group
 * has an outcome entry, and nothing has been added to it for an hour. A task
 * still in progress must not be held out — it would be scored against work that
 * has not happened.
 */
export function completedGroups(groups: Map<string, TaskGroup>, now: Date, quietMs: number): TaskGroup[] {
	const cutoff = now.getTime() - quietMs;
	return [...groups.values()]
		.filter((group) => group.hasOutcome && entryTime(group.latest) <= cutoff)
		.sort((a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0));
}

/** The instant inside a UUIDv7 entry id, in epoch milliseconds. */
function entryTime(entryId: string): number {
	const hex = entryId.replace(/^j-/, "").replace(/-/g, "").slice(0, 12);
	const parsed = Number.parseInt(hex, 16);
	return Number.isNaN(parsed) ? 0 : parsed;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const DECISION = /\b(decided|decision|chose|chosen|switched to|instead of|we use|settled on|convention)\b/i;
const FAILURE = /\b(failed|failing|fails|broke|broken|error|regression|flaky|timed out|timeout|crash|hangs?)\b/i;

/**
 * Whether a claim is worth promoting, and why.
 *
 * `source: user` is always kept — the user typed it, and there is no stronger
 * signal in the store. Everything the model or a tool produced has to earn its
 * place: by being about a decision or a failure, or by having been observed in
 * two different pieces of work.
 */
function selectionReason(
	claim: GatheredClaim,
	all: readonly GatheredClaim[],
): { reason: GatherReason; occurrences: number } | undefined {
	if (claim.entry.source === "user") return { reason: "user", occurrences: 1 };

	const text = `${claim.text} ${claim.entry.cue ?? ""} ${claim.entry.prose}`;
	if (FAILURE.test(text)) return { reason: "failure", occurrences: 1 };
	if (DECISION.test(text) || isDecisionPhase(claim.entry.phase)) return { reason: "decision", occurrences: 1 };

	const occurrences = countRecurrence(claim, all);
	return occurrences >= 2 ? { reason: "recurrence", occurrences } : undefined;
}

function isDecisionPhase(phase: JournalEntry["phase"]): boolean {
	return phase === "review" || phase === "ops";
}

/**
 * How many *distinct pieces of work* made this observation.
 *
 * Distinct means both a different task and a different `recalled` set: two
 * sessions that were shown the same memory and both restated it are one
 * observation seen twice, not two. Counting them as two is exactly the
 * self-reinforcement loop the echo rule exists to break, arriving by another
 * door.
 */
export function countRecurrence(claim: GatheredClaim, all: readonly GatheredClaim[]): number {
	const occurrences = all.filter(
		(other) => other.id === claim.id || jaccard(claim.text, other.text) >= RECURRENCE_THRESHOLD,
	);

	// Greedy, over a stable order: an occurrence counts only if it brings both a
	// task nobody has counted and a context nobody has counted. An empty
	// `recalled` set never blocks, because a session that recalled nothing was
	// not driven by memory at all and is independent by construction — the rule
	// is about a *shared cause*, and no memory in context is no shared cause.
	const tasks = new Set<string>();
	const contexts = new Set<string>();
	let independent = 0;
	for (const occurrence of [...occurrences].sort((a, b) => (a.id < b.id ? -1 : 1))) {
		const task = occurrence.entry.task ?? occurrence.entry.id;
		const context = [...(occurrence.entry.recalled ?? [])].sort().join(",");
		if (tasks.has(task)) continue;
		if (context !== "" && contexts.has(context)) continue;
		tasks.add(task);
		if (context !== "") contexts.add(context);
		independent++;
	}
	return independent;
}

/** Text of the memories this entry was found to be echoing. */
function echoedText(entry: JournalEntry, orientation: Orientation): string[] {
	const texts: string[] = [];
	for (const id of entry.echo ?? []) {
		const fact = orientation.factsById.get(id);
		if (fact) texts.push(fact.claim);
	}
	return texts;
}

// ---------------------------------------------------------------------------
// Topic assignment
// ---------------------------------------------------------------------------

/**
 * Route a claim to an existing topic, or nowhere.
 *
 * A small in-memory index over the topic files only — not the store's own
 * `.index/`, which covers the journal too and would answer a different
 * question. Building it costs one pass over a few dozen facts, and it reuses
 * the same chunker and the same ranking the rest of Muninn retrieves with, so
 * "which topic is this about" is answered the way every other lookup is.
 */
export function topicRouter(topics: ReadonlyMap<string, TopicFile>): (claim: GatheredClaim) => string | undefined {
	const index = Tier0Index.empty();
	for (const [slug, topic] of topics) index.add(chunkTopic(`topics/${slug}.md`, formatTopic(topic)));
	if (index.size === 0) return () => undefined;

	return (claim) => {
		const query = `${claim.text} ${claim.entry.cue ?? ""}`.trim();
		const hits = index.search(query, { limit: 1 });
		const best = hits[0];
		if (best === undefined || best.score < TOPIC_SCORE_FLOOR) return undefined;
		return best.path.replace(/^topics\//, "").replace(/\.md$/, "");
	};
}

/**
 * How well a claim must match a topic to join it.
 *
 * Too low and every claim lands in whichever topic happens to share a common
 * word; too high and topics fragment into near-duplicates. It is a threshold on
 * a BM25 score, so it is a judgement call, and it is here — in one named
 * constant — rather than spread through the routing code.
 */
export const TOPIC_SCORE_FLOOR = 2;

const STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"but",
	"of",
	"to",
	"in",
	"on",
	"for",
	"with",
	"is",
	"are",
	"was",
	"were",
	"be",
	"when",
	"how",
	"why",
	"that",
	"this",
	"it",
	"its",
	"as",
	"at",
	"by",
	"from",
	"into",
	"we",
	"you",
	"i",
	"our",
	"never",
	"always",
	"must",
	"should",
	"use",
	"using",
	"run",
	"runs",
]);

/**
 * A slug for a topic that does not exist yet.
 *
 * From the `cue` when there is one — a cue is already "when would I need this",
 * which is what a topic is — and from the claim otherwise. Deterministic, so two
 * hosts gathering the same claim propose the same topic and their dreams merge
 * instead of forking.
 */
export function newTopicSlug(claim: GatheredClaim): string {
	const source = claim.entry.cue ?? claim.text;
	const words = source
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, " ")
		.split(/\s+/)
		.filter((word) => word.length > 2 && !STOPWORDS.has(word))
		.slice(0, 3);
	if (words.length === 0) return claim.entry.phase ?? "other";
	return words.join("-");
}
