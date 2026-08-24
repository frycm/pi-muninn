/**
 * Two dreams that rewrote the same topic.
 *
 * The normal case for a store with more than one dreaming host, and *not*
 * resolvable by line-level merge: both sides replaced the same bullet with
 * different wording, or each added a fact the other contradicts. So a
 * derived-file conflict is handled in three layers, cheapest first, and the
 * model is only asked about what the first two could not settle.
 *
 *  1. **Structural, per fact.** A topic file is a list of id'd bullets, so the
 *     merge unit is a fact and not a line. Ids are UUIDv7, so they cannot
 *     collide and a merge never has to renumber.
 *  2. **Residue detection.** What survives layer 1 is the semantic residue:
 *     pairs of active facts, one from each side, that overlap or share
 *     evidence. Code finds them; code does not merge them.
 *  3. **The merge dream.** One bounded job per topic with a residue - the same
 *     flat schema, the same bound, the same guards - with one extra rule: every
 *     active fact from either side is present, superseded with a reason, or
 *     listed in the report as dropped. A merge may not lose a fact silently.
 *
 * Layer 1 resolves the large majority without a model call, because most dreams
 * touch disjoint topics or add disjoint facts.
 */
import { jaccard } from "../capture/outcome.ts";
import { claimsOf } from "../journal/format.ts";
import type { JournalEntryWithContext } from "../journal/read.ts";
import { allFacts, type Fact, type TopicFile } from "../topics/format.ts";
import type { FactItem } from "../topics/write.ts";
import {
	type ConsolidateJob,
	type ConsolidateOptions,
	type ConsolidateOutcome,
	checkFactList,
	parseFactList,
} from "./consolidate.ts";
import { CONTRADICTION_THRESHOLD } from "./lint.ts";

export interface MergeInput {
	/** The common ancestor on `main`. */
	base: TopicFile;
	/** This host's version. */
	ours: TopicFile;
	/** The other host's. */
	theirs: TopicFile;
}

export interface ResiduePair {
	ours: Fact;
	theirs: Fact;
	why: "shared-evidence" | "same-cue" | "overlap";
}

export interface MergeResult {
	topic: TopicFile;
	residue: ResiduePair[];
	/** Facts contributed by each side, for the report. */
	fromOurs: string[];
	fromTheirs: string[];
	notes: string[];
}

/**
 * Layer 1 and 2: merge structurally, then find what is left over.
 *
 * Pure. Never asks anything; never loses a fact.
 */
export function mergeTopic(input: MergeInput): MergeResult {
	const { base, ours, theirs } = input;
	const baseById = new Map(allFacts(base).map((fact) => [fact.id, fact]));
	const oursById = new Map(allFacts(ours).map((fact) => [fact.id, fact]));
	const theirsById = new Map(allFacts(theirs).map((fact) => [fact.id, fact]));

	const active: Fact[] = [];
	const external: Fact[] = [];
	const superseded: Fact[] = [];
	const fromOurs: string[] = [];
	const fromTheirs: string[] = [];
	const notes: string[] = [];

	for (const id of new Set([...oursById.keys(), ...theirsById.keys()])) {
		const inBase = baseById.get(id);
		const mine = oursById.get(id);
		const yours = theirsById.get(id);

		if (inBase === undefined) {
			// Added on one side only - ids cannot collide, so "on both" cannot
			// happen and a fact added anywhere is kept.
			const added = (mine ?? yours) as Fact;
			(mine === undefined ? fromTheirs : fromOurs).push(id);
			place(added, active, external, superseded);
			continue;
		}

		if (mine === undefined || yours === undefined) {
			// Deleted on one side. A dream never deletes a fact, so this is a
			// hand edit; keeping it is the direction that cannot lose memory.
			const kept = (mine ?? yours) as Fact;
			notes.push(`${id} is missing on one side; kept`);
			place(kept, active, external, superseded);
			continue;
		}

		const retiredHere = mine.validTo !== undefined;
		const retiredThere = yours.validTo !== undefined;
		if (retiredHere && retiredThere) {
			// Superseded on both sides, for possibly different reasons. The
			// earlier `valid_to` is the truth about when it stopped being true;
			// both `superseded_by` values are kept, because both are real.
			superseded.push(mergeRetired(mine, yours));
			continue;
		}
		if (retiredHere || retiredThere) {
			superseded.push(retiredHere ? mine : yours);
			continue;
		}
		place(mine, active, external, superseded);
	}

	// Every field is chosen deterministically rather than inherited from `ours`:
	// a merge has to produce the same bytes whichever side runs it, and
	// `...ours` would have carried that host's `title`, `prose` and `updated`
	// into the result — the one thing the sorting below was careful to avoid.
	const updated = later(ours.updated, theirs.updated);
	const topic: TopicFile = {
		topic: ours.topic,
		title: ours.title === theirs.title ? ours.title : pick(ours.title, theirs.title),
		...(updated !== undefined ? { updated } : {}),
		prose:
			ours.prose === theirs.prose ? ours.prose : [ours.prose, theirs.prose].filter((text) => text !== "").join("\n\n"),
		stray: dedupeStray([...ours.stray, ...theirs.stray]),
		facts: sortById(active),
		external: sortById(external),
		superseded: sortById(superseded),
		problems: [...ours.problems, ...theirs.problems],
	};

	return { topic, residue: findResidue(topic, fromOurs, fromTheirs), fromOurs, fromTheirs, notes };
}

function place(fact: Fact, active: Fact[], external: Fact[], superseded: Fact[]): void {
	if (fact.validTo !== undefined) superseded.push(fact);
	else if (fact.source === "external") external.push(fact);
	else active.push(fact);
}

function mergeRetired(mine: Fact, yours: Fact): Fact {
	const earlier = (mine.validTo as string) <= (yours.validTo as string) ? mine : yours;
	const other = earlier === mine ? yours : mine;
	const by = [earlier.supersededBy, other.supersededBy].filter((id): id is string => id !== undefined);
	const merged: Fact = { ...earlier };
	if (by.length > 0) merged.supersededBy = [...new Set(by)].join(", ");
	const reasons = [earlier.reason, other.reason].filter((text): text is string => text !== undefined);
	if (reasons.length > 0) merged.reason = [...new Set(reasons)].join("; ");
	return merged;
}

/** The lexicographically smaller of two strings — an arbitrary but identical choice on both hosts. */
function pick(a: string, b: string): string {
	return a < b ? a : b;
}

function later(a: string | undefined, b: string | undefined): string | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return a > b ? a : b;
}

function sortById(facts: readonly Fact[]): Fact[] {
	// Deterministic on both hosts: the merge must produce the same bytes
	// whichever side runs it, or the next sync conflicts on the merge itself.
	return [...facts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function dedupeStray(lines: TopicFile["stray"]): TopicFile["stray"] {
	const seen = new Set<string>();
	return lines.filter((line) => {
		const key = `${line.section} ${line.text}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * Pairs the structural merge could not settle.
 *
 * One fact from each side that overlaps, shares evidence or answers the same
 * cue. These are candidates for a semantic conflict, not proof of one - the
 * same distinction lint makes, and for the same reason: two facts can restate
 * each other and agree.
 */
export function findResidue(
	topic: TopicFile,
	fromOurs: readonly string[],
	fromTheirs: readonly string[],
): ResiduePair[] {
	const ourIds = new Set(fromOurs);
	const theirIds = new Set(fromTheirs);
	const pairs: ResiduePair[] = [];

	// A fact new on one side against *anything* active on the other, including
	// facts that were already there. The design's residue is "one per side, or
	// one new and one existing"; pairing only new-against-new missed the second
	// case entirely, which is the common one — a host adds a fact that
	// contradicts something the topic already said.
	for (const fresh of topic.facts) {
		const mine = ourIds.has(fresh.id);
		const yours = theirIds.has(fresh.id);
		if (!mine && !yours) continue;
		for (const other of topic.facts) {
			if (other.id === fresh.id) continue;
			// Skip the mirror of a pair already made, and pairs from one side.
			if (mine && ourIds.has(other.id)) continue;
			if (yours && theirIds.has(other.id)) continue;
			if (yours && !theirIds.has(other.id) && ourIds.has(other.id) && other.id < fresh.id) continue;
			const why = residueReason(fresh, other);
			if (why === undefined) continue;
			const pair: ResiduePair = mine ? { ours: fresh, theirs: other, why } : { ours: other, theirs: fresh, why };
			if (!pairs.some((seen) => seen.ours.id === pair.ours.id && seen.theirs.id === pair.theirs.id)) {
				pairs.push(pair);
			}
		}
	}
	return pairs;
}

function residueReason(a: Fact, b: Fact): ResiduePair["why"] | undefined {
	if (a.evidence.some((id) => b.evidence.includes(id))) return "shared-evidence";
	if (a.cue !== undefined && a.cue === b.cue) return "same-cue";
	if (jaccard(a.claim, b.claim) >= CONTRADICTION_THRESHOLD) return "overlap";
	return undefined;
}

// ---------------------------------------------------------------------------
// Layer 3: the merge dream
// ---------------------------------------------------------------------------

export const MERGE_MARKER = "You are merging two versions of one topic";

export const MERGE_SYSTEM_PROMPT = `${MERGE_MARKER} of a memory store.

Two machines dreamed from different journals and produced different facts for the same
topic. You are given the common ancestor, both candidate lists, and the evidence behind
them. Emit one replacement list of facts.

Rules:
- Every fact must cite evidence: journal claim ids from this prompt.
- Never invent an id.
- Every fact from either side must survive in some form: keep it, or supersede it with a
  reason. Do not drop one silently.
- Where the two sides say the same thing differently, emit one fact citing both sides' evidence.
- Where they genuinely disagree, prefer the one with stronger evidence and supersede the
  other, saying why.

Reply with your reasoning, then a single fenced block:

\`\`\`json
[
  {"claim": "...", "evidence": ["j-....1"], "supersedes": ["f-topic-..."], "reason": "..."},
  {"id": "f-topic-..."}
]
\`\`\`

The block must be a flat JSON array of objects.`;

export interface MergeJob {
	topic: string;
	merged: TopicFile;
	base: TopicFile;
	residue: readonly ResiduePair[];
	/** The union of both sides' evidence - synced first, so this host has it all. */
	entries: readonly JournalEntryWithContext[];
}

export function buildMergePrompt(job: MergeJob): string {
	const out: string[] = [`# Topic: ${job.topic}`, "", "## Common ancestor", ""];
	if (job.base.facts.length === 0) out.push("(the topic did not exist)");
	for (const fact of job.base.facts) out.push(`- ${fact.claim} [id: ${fact.id}]`);

	out.push("", "## What the two sides disagree about", "");
	for (const pair of job.residue) {
		out.push(`- A: ${pair.ours.claim} [id: ${pair.ours.id}]`);
		out.push(`  B: ${pair.theirs.claim} [id: ${pair.theirs.id}]`);
		out.push(`  (${pair.why})`);
	}

	out.push("", "## Evidence", "");
	for (const entry of job.entries) {
		out.push(`### ${entry.date} - ${entry.source}${entry.cue ? ` - cue: ${entry.cue}` : ""}`);
		for (const claim of claimsOf(entry)) out.push(`- ${claim.text} [${claim.id}]`);
		out.push("");
	}
	return out.join("\n").trimEnd();
}

export interface MergeDreamOutcome {
	outcome: ConsolidateOutcome;
	/** Facts from either side that the merge neither kept nor superseded. */
	dropped: string[];
}

/**
 * Ask a model to settle the residue.
 *
 * Bounded exactly like a consolidation and checked by exactly the same guards -
 * a merge that could cite ids a plain consolidation could not would be a hole
 * shaped like the hardest prompt in the system. The one extra check is the
 * merge's own: nothing from either side may vanish without a word.
 */
export async function mergeDream(job: MergeJob, options: ConsolidateOptions): Promise<MergeDreamOutcome> {
	const consolidateJob: ConsolidateJob = {
		topic: job.topic,
		isNew: false,
		file: job.merged,
		claims: [],
		entries: job.entries,
	};

	let problem = "";
	for (let attempt = 0; attempt < 2; attempt++) {
		let reply: string;
		try {
			reply = await options.model.complete(
				{
					systemPrompt: MERGE_SYSTEM_PROMPT,
					prompt:
						attempt === 0
							? buildMergePrompt(job)
							: `${buildMergePrompt(job)}\n\nYour previous reply could not be used: ${problem}\nReply again, with the fenced JSON block exactly as described.`,
				},
				options.signal,
			);
		} catch (error) {
			const reason = `model call failed: ${error instanceof Error ? error.message : String(error)}`;
			return { outcome: { ok: false, reason, retries: attempt, refusals: [] }, dropped: [] };
		}

		const parsed = parseFactList(reply);
		if (!parsed.ok) {
			problem = parsed.problem;
			continue;
		}
		const outcome = checkFactList(consolidateJob, parsed.items, options, attempt);
		return { outcome, dropped: outcome.ok ? droppedFacts(job, parsed.items, outcome) : [] };
	}

	return {
		outcome: { ok: false, reason: `unparsable after one retry: ${problem}`, retries: 1, refusals: [] },
		dropped: [],
	};
}

/**
 * Facts from either side the merge neither kept nor superseded.
 *
 * A merge may not lose a fact silently; this is what makes "silently"
 * impossible. Anything here goes in the report.
 */
function droppedFacts(job: MergeJob, items: readonly FactItem[], outcome: ConsolidateOutcome): string[] {
	if (!outcome.ok) return [];
	const kept = new Set(outcome.applied.topic.facts.concat(outcome.applied.topic.external).map((fact) => fact.id));
	const retired = new Set(outcome.applied.topic.superseded.map((fact) => fact.id));
	const mentioned = new Set(items.flatMap((item) => [item.id, ...(item.supersedes ?? [])]));

	return job.merged.facts
		.concat(job.merged.external)
		.map((fact) => fact.id)
		.filter((id) => !kept.has(id) && !retired.has(id) && !mentioned.has(id));
}
