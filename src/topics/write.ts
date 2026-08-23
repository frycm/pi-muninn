/**
 * Applying a dream's fact list to a topic.
 *
 * The consolidate phase emits a *fact list*, not a file: an array of claims,
 * each with its evidence and — where it replaces something — what it
 * supersedes. Turning that into a topic file is code, deliberately: id minting,
 * supersession bookkeeping and date resolution are exactly the parts a small
 * model gets subtly wrong, and none of them need judgement.
 *
 * The rules, in one place:
 *
 *  - **Nothing is deleted.** A superseded fact moves to `## Superseded` and
 *    keeps its id, its evidence and its `valid_from`; it gains `valid_to`,
 *    `superseded_by` and a reason.
 *  - **An unmentioned fact stays.** A job sees a bounded slice of a topic, so
 *    silence about a fact means "not considered", never "drop it".
 *  - **Ids are minted here.** A model may not choose one: ids are UUIDv7 so
 *    that two hosts' dreams cannot collide and a merge never has to renumber.
 *  - **Dates become absolute.** "yesterday" in a claim is meaningless to the
 *    session that reads it in November.
 */
import { newFactId } from "../ids.ts";
import { formatDate } from "../journal/format.ts";
import type { Supersession } from "../journal/supersessions.ts";
import { allFacts, type Fact, type FactSection, type TopicFile } from "./format.ts";

/** One item of the flat list the consolidate job emits. */
export interface FactItem {
	/** An existing fact re-emitted unchanged; mutually exclusive with `claim`. */
	id?: string;
	claim?: string;
	evidence?: string[];
	supersedes?: string[];
	cue?: string;
	phase?: Fact["phase"];
	/** Why the superseded facts stopped being true. */
	reason?: string;
}

export interface ApplyOptions {
	/** Today, as the dream sees it. Injected so a test is not a clock. */
	now: Date;
	/**
	 * Source per evidence claim id, for deciding a new fact's own source and
	 * whether it belongs in quarantine.
	 */
	sourceOf: (claimId: string) => Fact["source"] | undefined;
	/** Text per evidence claim id, used to resolve relative dates. */
	dateOf?: (claimId: string) => string | undefined;
}

export interface ApplyResult {
	topic: TopicFile;
	added: Fact[];
	superseded: Fact[];
	/** Supersession rows for the journal claims behind every superseded fact. */
	supersessions: Supersession[];
	/** Ids named by `supersedes` that this topic does not have. */
	unknownSupersedes: string[];
	/** Fraction of the topic's active facts this list would retire. */
	lossRatio: number;
}

/**
 * How much of a topic a single job may retire.
 *
 * A consolidate job that supersedes most of a topic is far more likely to have
 * misunderstood the topic than to have discovered that most of it is wrong. The
 * caller decides what to do about it; this module only measures.
 */
export const MAX_LOSS_RATIO = 0.25;

/**
 * Whether a job's supersessions are within the bound.
 *
 * The design states the rule as a ratio, and a ratio alone is unusable at small
 * sizes: a topic with three facts could never have one superseded, which
 * forbids the correction the whole mechanism exists for — the design's own
 * worked example is one fact of one being replaced by a user correction. So the
 * bound is the ratio *or one fact*, whichever is larger. That keeps what the
 * rule is for — a single job may not rewrite a topic wholesale — while leaving
 * the ordinary case, one thing turning out to be wrong, possible.
 */
export function withinLossBound(activeBefore: number, retired: number): boolean {
	return retired <= Math.max(1, Math.floor(MAX_LOSS_RATIO * activeBefore));
}

/**
 * Apply a fact list, returning a new topic file.
 *
 * Pure: no clock, no filesystem, no id source but `newFactId`. The caller
 * decides whether to keep the result — `lossRatio` is what the consolidate
 * guard reads.
 */
export function applyFactList(topic: TopicFile, items: readonly FactItem[], options: ApplyOptions): ApplyResult {
	const today = formatDate(options.now);
	const byId = new Map(allFacts(topic).map((fact) => [fact.id, fact]));
	const activeBefore = topic.facts.length + topic.external.length;

	const added: Fact[] = [];
	const supersededNow = new Map<string, { fact: Fact; by: string | undefined; reason: string | undefined }>();
	const unknownSupersedes: string[] = [];

	for (const item of items) {
		// An item that only names an id is "keep this one" — the job's way of
		// saying it considered a fact and left it alone.
		if (item.claim === undefined || item.claim.trim() === "") continue;

		const evidence = [...new Set(item.evidence ?? [])];
		const fact: Fact = {
			id: newFactId(topic.topic),
			claim: resolveDates(item.claim, evidence, options),
			validFrom: today,
			source: sourceFor(evidence, options.sourceOf),
			evidence,
		};
		if (item.cue) fact.cue = item.cue;
		if (item.phase) fact.phase = item.phase;
		added.push(fact);

		for (const target of item.supersedes ?? []) {
			const existing = byId.get(target);
			if (!existing) {
				unknownSupersedes.push(target);
				continue;
			}
			// Already superseded by an earlier dream: leave the earlier row alone
			// rather than rewriting history that is already committed.
			if (existing.validTo !== undefined) continue;
			supersededNow.set(target, { fact: existing, by: fact.id, reason: item.reason });
		}
	}

	const retiredIds = new Set(supersededNow.keys());
	const keep = (fact: Fact): boolean => !retiredIds.has(fact.id);

	const addedById = new Map(added.map((fact) => [fact.id, fact]));
	const moved: Fact[] = [];
	const supersessions: Supersession[] = [];
	for (const { fact, by, reason } of supersededNow.values()) {
		const retired: Fact = { ...fact, validTo: today };
		if (by !== undefined) retired.supersededBy = by;
		if (reason !== undefined && reason.trim() !== "") retired.reason = reason.trim();
		moved.push(retired);

		// One row per invalidated *claim*, never per entry: an outcome entry
		// routinely supports several independent facts, and superseding one of
		// them must not hide the others. `by` names the journal claim that
		// replaced it — the new fact's own first piece of evidence — so the row
		// reads as "this observation was overtaken by that one".
		const replacement = by === undefined ? undefined : addedById.get(by)?.evidence[0];
		for (const claim of fact.evidence) {
			const row: Supersession = { claim, validTo: today, fact: fact.id };
			if (replacement !== undefined && replacement !== claim) row.by = replacement;
			supersessions.push(row);
		}
	}

	// `updated:` moves only when something did. A dream that considered a topic
	// and changed nothing must leave the file byte-identical: otherwise every
	// dream dirties every topic it looked at, and `git log -p` — the whole point
	// of a reviewable branch — fills with one-line date churn.
	const changed = added.length > 0 || moved.length > 0;

	const next: TopicFile = {
		...topic,
		...(changed ? { updated: today } : {}),
		facts: [...topic.facts.filter(keep), ...added.filter((fact) => sectionOf(fact) === "facts")],
		external: [...topic.external.filter(keep), ...added.filter((fact) => sectionOf(fact) === "external")],
		superseded: [...topic.superseded, ...moved],
	};

	return {
		topic: next,
		added,
		superseded: moved,
		supersessions,
		unknownSupersedes,
		lossRatio: activeBefore === 0 ? 0 : moved.length / activeBefore,
	};
}

/** Quarantine is decided by evidence, not by wording. */
function sectionOf(fact: Fact): FactSection {
	return fact.source === "external" ? "external" : "facts";
}

/**
 * A new fact's source: the weakest thing it rests on.
 *
 * A fact standing on one user correction and three tool observations is only as
 * trustworthy as the class that can be wrong, and the trust table keys on the
 * source of the fact. `external` dominates because a fact resting only on
 * fetched content is quarantined; `user` wins only when every citation is one.
 */
function sourceFor(evidence: readonly string[], sourceOf: ApplyOptions["sourceOf"]): Fact["source"] {
	const sources = evidence.map((id) => sourceOf(id)).filter((source): source is Fact["source"] => source !== undefined);
	if (sources.length === 0) return "agent";
	if (sources.every((source) => source === "external")) return "external";
	if (sources.every((source) => source === "user")) return "user";
	if (sources.includes("tool")) return "tool";
	return "agent";
}

/**
 * Relative dates, made absolute against the evidence they come from.
 *
 * A claim that says "yesterday" is true only on the day it was written; the
 * date it means is the date of the journal claim it cites. Resolved in code
 * because the model has no reliable idea what day it is.
 */
const RELATIVE = /\b(yesterday|today|this morning|last night|earlier today|just now)\b/gi;

function resolveDates(claim: string, evidence: readonly string[], options: ApplyOptions): string {
	if (!RELATIVE.test(claim)) return claim.trim();
	RELATIVE.lastIndex = 0;
	const dates = evidence.map((id) => options.dateOf?.(id)).filter((date): date is string => date !== undefined);
	const anchor = dates.sort().at(-1);
	if (anchor === undefined) return claim.trim();
	return claim.replace(RELATIVE, `on ${anchor}`).trim();
}
