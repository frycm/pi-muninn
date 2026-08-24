/**
 * `topics/<slug>.md` — the semantic layer, and the one format a dream writes.
 *
 * A topic file is a list of facts. Each fact is one bullet: the claim, then a
 * ` · `-separated flat trailer carrying its id, its validity and the journal
 * claims it cites. Flat and one-line-per-fact is not a stylistic choice — it is
 * what makes the merge unit a *fact* rather than a line of text, what lets
 * `git log -p` read as a list of what changed, and what a 4B model can be asked
 * to produce without nested JSON.
 *
 * Nothing is deleted by a dream. A fact that stops being true moves to
 * `## Superseded` with `valid_to`, `superseded_by` and `reason`; the audit row
 * stays, and `memory_read` can still answer "what did I believe in July".
 *
 * `## External` is the quarantine the design asks for: a fact whose evidence is
 * only `external` — fetched pages, repository content someone else wrote — is
 * searchable but is never injected on its own recognisance.
 *
 * This module is the *grammar*. `write.ts` applies a dream's output to it, and
 * `index/chunk.ts` reads a fact line through `parseFactLine` here so that the
 * reader and the writer cannot drift apart.
 */
import { isClaimId, isFactId, parseFactId } from "../ids.ts";
import { PHASES, type Phase, SOURCES, type Source } from "../journal/format.ts";
import { parseTrailer } from "../journal/trailer.ts";

/** Section headings, in the order they are written. */
export const FACTS_HEADING = "## Facts";
export const SUPERSEDED_HEADING = "## Superseded";
export const EXTERNAL_HEADING = "## External";

export type FactSection = "facts" | "superseded" | "external";

export interface Fact {
	/** `f-<topic>-<uuidv7>`, minted once and never reused. */
	id: string;
	/** The claim itself, without the bold or strike markers the section implies. */
	claim: string;
	validFrom: string;
	source: Source;
	/** Journal claim ids. Evidence cites claims, never whole entries. */
	evidence: string[];
	cue?: string;
	phase?: Phase;
	/** A global fact this one shadows inside this project. */
	shadows?: string;
	// --- superseded only ---
	validTo?: string;
	supersededBy?: string;
	reason?: string;
	/** Trailer fields this Muninn does not know, kept so a rewrite never drops them. */
	extra?: Record<string, string>;
}

export interface TopicFile {
	/** The slug, which is also the file's basename and the fact ids' middle part. */
	topic: string;
	title: string;
	updated?: string;
	/** Everything between the title and the first fact section, verbatim. */
	prose: string;
	facts: Fact[];
	superseded: Fact[];
	external: Fact[];
	/**
	 * Bullets in a fact section this grammar could not read.
	 *
	 * Kept, not dropped: a store is Muninn's but a person may still edit one,
	 * and a rewrite that silently deleted a hand-written line would be the
	 * worst possible way to find that out.
	 */
	stray: Array<{ section: FactSection; text: string }>;
	problems: string[];
}

/** The known trailer keys, in write order. Anything else is `extra`. */
const KNOWN = new Set([
	"id",
	"valid_from",
	"source",
	"evidence",
	"cue",
	"phase",
	"shadows",
	"valid_to",
	"superseded_by",
	"reason",
]);

/**
 * The separator between a claim and its trailer.
 *
 * A claim containing this string would split its own line, so the writer
 * normalises it away (see `sanitiseClaim`) rather than leaving the reader to
 * guess which occurrence was meant.
 */
const ID_MARKER = " id: ";

export function emptyTopic(topic: string, title?: string): TopicFile {
	return {
		topic,
		title: title ?? titleFromSlug(topic),
		prose: "",
		facts: [],
		superseded: [],
		external: [],
		stray: [],
		problems: [],
	};
}

/** `deploy-pipeline` → `Deploy pipeline`. Display only; the slug is the identity. */
export function titleFromSlug(slug: string): string {
	const words = slug.replace(/-/g, " ").trim();
	return words === "" ? slug : words.charAt(0).toUpperCase() + words.slice(1);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * One fact bullet.
 *
 * Exported because `index/chunk.ts` reads fact lines with it: the index and the
 * dream must agree about what a fact is, and the way to guarantee that is for
 * there to be one function.
 */
export function parseFactLine(line: string): Fact | undefined {
	const trimmed = line.trimStart();
	if (!trimmed.startsWith("- ")) return undefined;
	const marker = trimmed.indexOf(ID_MARKER);
	if (marker < 0) return undefined;

	const fields = parseTrailer(trimmed.slice(marker));
	const id = fields.get("id");
	if (id === undefined || !isFactId(id)) return undefined;

	const claim = trimmed.slice(2, marker).replace(/\*\*/g, "").replace(/~~/g, "").trim();
	if (claim === "") return undefined;

	const source = fields.get("source");
	const phase = fields.get("phase");
	const fact: Fact = {
		id,
		claim,
		validFrom: fields.get("valid_from") ?? "",
		source: isSource(source) ? source : "agent",
		evidence: splitList(fields.get("evidence")),
	};
	const cue = fields.get("cue");
	if (cue !== undefined && cue !== "") fact.cue = cue;
	if (isPhase(phase)) fact.phase = phase;
	const shadows = fields.get("shadows");
	if (shadows !== undefined && shadows !== "") fact.shadows = shadows;
	const validTo = fields.get("valid_to");
	if (validTo !== undefined && validTo !== "") fact.validTo = validTo;
	const supersededBy = fields.get("superseded_by");
	if (supersededBy !== undefined && supersededBy !== "") fact.supersededBy = supersededBy;
	const reason = fields.get("reason");
	if (reason !== undefined && reason !== "") fact.reason = reason;

	const extra: Record<string, string> = {};
	for (const [key, value] of fields) if (!KNOWN.has(key)) extra[key] = value;
	if (Object.keys(extra).length > 0) fact.extra = extra;

	return fact;
}

function isSource(value: string | undefined): value is Source {
	return value !== undefined && (SOURCES as readonly string[]).includes(value);
}

function isPhase(value: string | undefined): value is Phase {
	return value !== undefined && (PHASES as readonly string[]).includes(value);
}

function splitList(value: string | undefined): string[] {
	if (value === undefined) return [];
	return value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part !== "");
}

const FENCE = /^\s*(```+|~~~+)/;

/** Track whether a line opens or closes a fenced block; a fact is never inside one. */
function trackFence(line: string, fence: string | undefined): string | undefined {
	const match = FENCE.exec(line);
	if (!match) return fence;
	const marker = (match[1] as string).slice(0, 3);
	if (fence === undefined) return marker;
	return line.trim().startsWith(fence) ? undefined : fence;
}

/**
 * Read a topic file.
 *
 * Tolerant everywhere it can afford to be — a missing front matter, a hand
 * written paragraph, an unknown section — and strict about exactly one thing:
 * a bullet inside a fact section either parses as a fact or is recorded as
 * stray. Nothing is discarded.
 */
export function parseTopic(text: string, slug: string): TopicFile {
	const topic = emptyTopic(slug);
	const lines = text.split("\n");
	let index = 0;

	// --- front matter -------------------------------------------------------
	if (lines[0]?.trim() === "---") {
		index = 1;
		while (index < lines.length && lines[index]?.trim() !== "---") {
			const line = lines[index] as string;
			const colon = line.indexOf(":");
			if (colon > 0) {
				const key = line.slice(0, colon).trim();
				const value = line.slice(colon + 1).trim();
				if (key === "topic" && value !== "") topic.topic = value;
				if (key === "updated" && value !== "") topic.updated = value;
			}
			index++;
		}
		index++;
	}

	// --- title --------------------------------------------------------------
	let section: FactSection | "prose" = "prose";
	const prose: string[] = [];
	let fence: string | undefined;
	let seenTitle = false;

	for (; index < lines.length; index++) {
		const line = lines[index] as string;
		const wasInside = fence !== undefined;
		fence = trackFence(line, fence);
		const inFence = wasInside || fence !== undefined;

		if (!inFence) {
			const heading = /^(#{1,6})\s+(.*)$/.exec(line);
			if (heading) {
				const depth = (heading[1] as string).length;
				const label = (heading[2] as string).trim();
				if (depth === 1 && !seenTitle) {
					topic.title = label;
					seenTitle = true;
					continue;
				}
				const named = sectionFor(label);
				if (named !== undefined) {
					section = named;
					continue;
				}
				// An unknown heading ends any fact section: whatever follows is
				// someone's own prose, and facts do not live under it.
				section = "prose";
			}
		}

		if (section === "prose") {
			prose.push(line);
			continue;
		}
		if (line.trim() === "") continue;
		if (!inFence && line.trimStart().startsWith("- ")) {
			const fact = parseFactLine(line);
			if (fact) {
				topic[section === "facts" ? "facts" : section === "superseded" ? "superseded" : "external"].push(fact);
				continue;
			}
			topic.problems.push(`unreadable fact line in ${slug}: ${line.trim()}`);
		}
		topic.stray.push({ section, text: line });
	}

	topic.prose = prose.join("\n").trim();
	return topic;
}

function sectionFor(label: string): FactSection | undefined {
	const lowered = label.toLowerCase();
	if (lowered === "facts") return "facts";
	if (lowered === "superseded") return "superseded";
	if (lowered === "external") return "external";
	return undefined;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Make a claim safe to be the first half of a fact line.
 *
 * Two strings would split the line if a claim carried them: the ` · ` that
 * separates trailer fields and the ` id: ` that starts the trailer. A newline
 * would end the bullet outright. Normalising them here is the same move
 * `format.ts` makes for a prose line that would read back as a heading — the
 * writer bends the text so the reader cannot be wrong.
 */
export function sanitiseClaim(claim: string): string {
	return claim.replace(/\s+/g, " ").replaceAll("·", "-").replaceAll(ID_MARKER, " id- ").trim();
}

/** One fact bullet, in the section's own markers. */
export function formatFactLine(fact: Fact, section: FactSection): string {
	const claim = sanitiseClaim(fact.claim);
	const body = section === "superseded" ? `~~${claim}~~` : `**${claim}**`;
	const parts = [`id: ${fact.id}`, `valid_from: ${fact.validFrom}`, `source: ${fact.source}`];
	if (fact.evidence.length > 0) parts.push(`evidence: ${fact.evidence.join(", ")}`);
	if (fact.cue) parts.push(`cue: ${sanitiseClaim(fact.cue)}`);
	if (fact.phase) parts.push(`phase: ${fact.phase}`);
	if (fact.shadows) parts.push(`shadows: ${fact.shadows}`);
	if (fact.validTo) parts.push(`valid_to: ${fact.validTo}`);
	if (fact.supersededBy) parts.push(`superseded_by: ${fact.supersededBy}`);
	if (fact.reason) parts.push(`reason: ${sanitiseClaim(fact.reason)}`);
	for (const [key, value] of Object.entries(fact.extra ?? {})) parts.push(`${key}: ${value}`);
	return `- ${body} ${parts.join(" · ")}`;
}

/**
 * Serialise a topic file.
 *
 * Byte-stable for an unchanged input: an idle dream that consolidates nothing
 * must produce no diff at all, or every dream would look like it changed
 * something and `git log -p` would stop being readable.
 */
export function formatTopic(topic: TopicFile): string {
	const out: string[] = ["---", `topic: ${topic.topic}`];
	if (topic.updated) out.push(`updated: ${topic.updated}`);
	out.push("---", "", `# ${topic.title}`, "");
	if (topic.prose !== "") out.push(topic.prose, "");

	const sections: Array<[FactSection, string, Fact[]]> = [
		["facts", FACTS_HEADING, topic.facts],
		["external", EXTERNAL_HEADING, topic.external],
		["superseded", SUPERSEDED_HEADING, topic.superseded],
	];
	for (const [name, heading, facts] of sections) {
		const stray = topic.stray.filter((line) => line.section === name);
		if (facts.length === 0 && stray.length === 0) continue;
		out.push(heading, "");
		for (const fact of facts) out.push(formatFactLine(fact, name));
		for (const line of stray) out.push(line.text);
		out.push("");
	}

	return `${out.join("\n").trimEnd()}\n`;
}

/** Every fact in a topic, whatever section it sits in. */
export function allFacts(topic: TopicFile): Fact[] {
	return [...topic.facts, ...topic.external, ...topic.superseded];
}

/** Whether every evidence id a fact cites is a claim id at all. */
export function malformedEvidence(fact: Fact): string[] {
	return fact.evidence.filter((id) => !isClaimId(id));
}

/** The topic a fact id belongs to, or nothing when it is not a fact id. */
export function topicOf(factId: string): string | undefined {
	return parseFactId(factId)?.topic;
}
