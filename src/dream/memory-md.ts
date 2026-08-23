/**
 * Phase 6, first half: regenerate `MEMORY.md`.
 *
 * `MEMORY.md` is the working layer — the index a session reads once at start
 * and carries, unchanged, for its whole life. It is a *budget*, not a summary:
 * a bounded number of lines, ordered so that what falls off the bottom is what
 * has mattered least, and everything that falls off is still searchable.
 *
 * The one rule that is not about budgets: **what a person wrote survives**.
 * Phase 1 shipped with "MEMORY.md is yours to write by hand until a dream
 * writes it for you", so the first dream over a real store meets a file
 * somebody has been maintaining for months. Everything above the generated
 * marker is kept verbatim, and only the marked region is rewritten.
 */
import { contentLines } from "../recall/snapshot.ts";
import type { TopicFile } from "../topics/format.ts";
import type { Rule } from "../topics/rules.ts";
import { activeRules, parseRules } from "../topics/rules.ts";
import { byUsage, type Usage } from "../topics/use-count.ts";

/**
 * The line below which everything is a dream's to rewrite.
 *
 * A marker rather than a heading, because a heading is something a person might
 * reasonably write themselves and then lose.
 */
export const GENERATED_MARKER = "<!-- muninn: generated below. Edits above this line survive; edits below do not. -->";

export const TOPICS_HEADING = "## Topics";
export const RULES_HEADING = "## Rules";

export interface MemoryInput {
	topics: ReadonlyMap<string, TopicFile>;
	rules: string;
	usage: ReadonlyMap<string, Usage>;
	/** The file as it stands, for its hand-written part. */
	current: string;
	/** `recall.snapshotLines` for *this* scope. */
	budget: number;
}

export interface MemoryResult {
	text: string;
	/** Content lines written, preamble included. */
	lines: number;
	/** Topic slugs left out for want of room. They stay searchable. */
	dropped: string[];
}

/** Everything a person wrote: the file up to the marker, or all of it. */
export function preambleOf(current: string): string {
	const at = current.indexOf(GENERATED_MARKER);
	if (at < 0) return current.trimEnd();
	return current.slice(0, at).trimEnd();
}

/**
 * Rebuild the generated region.
 *
 * Byte-stable for unchanged input, ties broken on the id, so that two hosts
 * regenerating from the same journal produce the same file — anything less and
 * every sync would carry a spurious `MEMORY.md` diff.
 */
export function buildMemory(input: MemoryInput): MemoryResult {
	const preamble = preambleOf(input.current);

	const rules = activeRules(parseRules(input.rules));
	const ruleLines = rules
		.slice()
		.sort((a, b) => (a.id < b.id ? -1 : 1))
		.map(ruleLine);

	// Ordered by how much each topic's facts have actually been used, then by
	// recency. `byUsage` breaks the final tie on the id for determinism.
	const order = byUsage(topicUsage(input.topics, input.usage), (slug) => input.topics.get(slug)?.updated ?? "");
	const slugs = [...input.topics.entries()]
		.filter(([, topic]) => topic.facts.length > 0)
		.map(([slug]) => slug)
		.sort(order);

	// Rendered and *measured*, not estimated, then trimmed until it fits. The
	// budget is a promise about what a session will read, and the thing that
	// reads it is `contentLines` — so that is what counts here too. An estimate
	// would be one blank-line rule away from being wrong, and wrong quietly.
	let kept = slugs.length;
	let text = render(preamble, slugs, kept, ruleLines, input);
	while (kept > 0 && contentLines(text).length > input.budget) {
		kept--;
		text = render(preamble, slugs, kept, ruleLines, input);
	}

	return { text, lines: contentLines(text).length, dropped: slugs.slice(kept) };
}

function render(
	preamble: string,
	slugs: readonly string[],
	kept: number,
	ruleLines: readonly string[],
	input: MemoryInput,
): string {
	const dropped = slugs.length - kept;
	const out: string[] = [];
	if (preamble !== "") out.push(preamble, "");
	out.push(GENERATED_MARKER, "");

	if (kept > 0) {
		out.push(TOPICS_HEADING, "");
		for (const slug of slugs.slice(0, kept)) out.push(topicLine(slug, input.topics.get(slug) as TopicFile));
		out.push("");
	}
	if (ruleLines.length > 0) {
		// Rules keep their room: a rule is *followed*, not merely recalled, so
		// dropping one changes what the agent does, where dropping a topic line
		// only changes what it is reminded of.
		out.push(RULES_HEADING, "");
		out.push(...ruleLines);
		out.push("");
	}
	if (dropped > 0) {
		// A comment, so it costs no budget — and said out loud, because a silent
		// truncation reads as "this is everything" when it is not.
		out.push(`<!-- ${dropped} more topic(s) not listed: over the ${input.budget}-line budget, still searchable. -->`);
	}

	return `${out.join("\n").trimEnd()}\n`;
}

/**
 * A topic's line: its title, its most-used fact, and where to read the rest.
 *
 * The claim is the *point* of the line — a bare list of topic names tells a
 * session nothing it could act on — and it is the topic's own first active
 * fact, not a summary, because summarising is a model call and this is code.
 */
export function topicLine(slug: string, topic: TopicFile): string {
	const first = topic.facts[0];
	const claim = first === undefined ? "" : ` — ${first.claim}`;
	return `- **${topic.title}**${claim} · topics/${slug}.md`;
}

export function ruleLine(rule: Rule): string {
	const phase = rule.phase === undefined ? "" : ` · ${rule.phase}`;
	return `- ${rule.id}${phase} — ${rule.text.split("\n")[0]?.trim() ?? ""} · rules.md`;
}

/**
 * Usage per topic: the sum of its facts' use counts.
 *
 * A topic is as useful as the facts in it have been, and `use_count` is per
 * fact, so ordering topics means adding them up. The most recent use of any of
 * its facts is the topic's recency.
 */
export function topicUsage(
	topics: ReadonlyMap<string, TopicFile>,
	usage: ReadonlyMap<string, Usage>,
): Map<string, Usage> {
	const totals = new Map<string, Usage>();
	for (const [slug, topic] of topics) {
		let count = 0;
		let lastUsed = "";
		for (const fact of topic.facts) {
			const factUsage = usage.get(fact.id);
			if (factUsage === undefined) continue;
			count += factUsage.count;
			if (factUsage.lastUsed > lastUsed) lastUsed = factUsage.lastUsed;
		}
		totals.set(slug, { count, lastUsed: lastUsed === "" ? (topic.updated ?? "") : lastUsed });
	}
	return totals;
}
