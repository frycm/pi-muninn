/**
 * Chunking: markdown in, retrievable units out.
 *
 * A chunk is what BM25 scores and what a search result names, so the unit
 * matters more than the tokeniser does. Muninn's unit is the *claim*: each
 * journal bullet is its own chunk, carrying its entry's `cue` and header as
 * breadcrumb, because a claim is also the unit that evidence cites and that
 * supersession invalidates. Applying validity at one granularity everywhere is
 * what keeps "active-only" from meaning three different things in three
 * places.
 *
 * Entry prose is chunked too, but as *context*: it is never evidence on its
 * own, so an ordinary (active-only) query does not match it. `history: true`
 * brings it back, and `memory_read` returns it regardless — a human or a model
 * looking at an entry wants the situation, not just the bullets.
 *
 * File chunking follows qmd's rules: split at heading boundaries, carry the
 * `H1 › H2 › H3` breadcrumb, cap at ~700 tokens, never split a fenced block.
 * `topics/` and `rules.md` are read-only here — dreams write them in Phase 2 —
 * but their formats are fixed, so a store synced from a machine running a
 * later Muninn indexes correctly rather than as anonymous prose.
 */
import { basename } from "node:path";
import { isFactId } from "../ids.ts";
import { claimsOf } from "../journal/format.ts";
import type { JournalEntryWithContext } from "../journal/read.ts";
import { parseTrailer } from "../journal/trailer.ts";
import { tokenBudgetChars } from "../tokens.ts";

export const CHUNK_KINDS = ["claim", "prose", "memory", "fact", "topic", "rule"] as const;
export type ChunkKind = (typeof CHUNK_KINDS)[number];

/**
 * Kinds that carry an assertion someone stands behind. The rest are context:
 * matched only when a query asks for history, never returned as evidence.
 */
export const EVIDENCE_KINDS: readonly ChunkKind[] = ["claim", "fact", "rule", "memory"];

export interface Chunk {
	/** Claim id, fact id, rule id, or `<path>#<ordinal>` for a slice of a file. */
	id: string;
	kind: ChunkKind;
	/** Store-relative path of the file this came from. */
	path: string;
	title: string;
	/** `H1 › H2 › H3`, or `journal › <date> › <time>` for a journal chunk. */
	headingPath: string;
	cue?: string;
	body: string;
	/** Space-joined keywords — source, phase, kind — indexed as one field. */
	tags: string;
	/** `YYYY-MM-DD`. The day the file belongs to, or a fact's `valid_from`. */
	date?: string;
	source?: string;
	phase?: string;
	/** The journal entry a claim or prose chunk belongs to. */
	entry?: string;
	/** Superseded as the file itself says so — a fact with `valid_to`. */
	superseded?: boolean;
	/** Wikilink targets and ids mentioned in the text, for the link graph. */
	links: string[];
}

/** The README's ~700-token chunk cap, in characters. */
const MAX_CHUNK_CHARS = tokenBudgetChars(700);

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(```+|~~~+)/;

/**
 * Advance the fenced-block state by one line.
 *
 * `fence` is the marker that opened the current block, or undefined outside
 * one. A block closes on a marker of the same character at least as long as
 * the opener — CommonMark's rule, and the one the README's "never split a
 * fenced block" promise depends on. One implementation, because every chunker
 * has to agree on where a fence ends.
 */
function trackFence(line: string, fence: string | undefined): string | undefined {
	const match = line.match(FENCE);
	if (!match) return fence;
	const marker = match[1] as string;
	if (fence === undefined) return marker;
	return marker.startsWith(fence[0] as string) && marker.length >= fence.length ? undefined : fence;
}
const BREADCRUMB = " › ";

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const WIKILINK = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ENTRY_OR_CLAIM = new RegExp(`\\bj-${UUID}(?:\\.\\d+)?`, "g");
const FACT = new RegExp(`\\bf-[a-z0-9-]+-${UUID}`, "g");
const RULE = /\bR-\d{2,}\b/g;

/**
 * Everything this text points at: wikilink targets and bare ids.
 *
 * Bare ids count because Muninn's own writing cites them that way — an entry's
 * prose says "see j-…1", a fact's trailer lists `evidence: j-…2` — and a graph
 * that only saw `[[…]]` would miss every edge that matters.
 */
export function extractLinks(text: string): string[] {
	const found = new Set<string>();
	for (const pattern of [WIKILINK, ENTRY_OR_CLAIM, FACT, RULE]) {
		pattern.lastIndex = 0;
		for (const match of text.matchAll(pattern)) {
			const target = (match[1] ?? match[0]).trim();
			if (target !== "") found.add(target);
		}
	}
	return [...found];
}

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

/**
 * One chunk per claim, plus a context chunk for the prose.
 *
 * An entry with no bullets has exactly one implicit claim — its prose — so it
 * yields a claim chunk and *no* prose chunk. Emitting both would put the same
 * sentence in the index twice and let it match itself.
 */
export function chunkJournalEntry(entry: JournalEntryWithContext, path: string): Chunk[] {
	const headingPath = ["journal", entry.date, entry.time].join(BREADCRUMB);
	const tags = [entry.source, entry.phase, entry.channel].filter(Boolean).join(" ");
	const chunks: Chunk[] = [];

	for (const claim of claimsOf(entry)) {
		chunks.push(
			trim({
				id: claim.id,
				kind: "claim",
				path,
				title: "",
				headingPath,
				cue: entry.cue,
				body: claim.text,
				tags: `claim ${tags}`,
				date: entry.date,
				source: entry.source,
				phase: entry.phase,
				entry: entry.id,
				links: extractLinks(claim.text).filter((link) => link !== claim.id),
			}),
		);
	}

	if (entry.claims.length > 0 && entry.prose !== "") {
		chunks.push(
			trim({
				id: `${entry.id}#prose`,
				kind: "prose",
				path,
				title: "",
				headingPath,
				cue: entry.cue,
				body: entry.prose,
				tags: `prose ${tags}`,
				date: entry.date,
				source: entry.source,
				phase: entry.phase,
				entry: entry.id,
				links: extractLinks(entry.prose),
			}),
		);
	}

	return chunks;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Chunk a store file by its path. Unknown paths are chunked as plain markdown. */
export function chunkFile(path: string, text: string): Chunk[] {
	if (path === "MEMORY.md") return chunkMarkdown(path, text, "memory");
	if (path === "rules.md") return chunkRules(path, text);
	if (path.startsWith("topics/")) return chunkTopic(path, text);
	return chunkMarkdown(path, text, "topic");
}

interface FrontMatter {
	fields: Map<string, string>;
	/** Line index the body starts at. */
	from: number;
}

/** A `---` fenced block at the top of a file, as topic files carry. */
function readFrontMatter(lines: string[]): FrontMatter {
	const fields = new Map<string, string>();
	if ((lines[0] ?? "").trim() !== "---") return { fields, from: 0 };
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i] as string;
		if (line.trim() === "---") return { fields, from: i + 1 };
		const colon = line.indexOf(":");
		if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
	}
	// No closing delimiter: not front matter after all, so index the lot.
	return { fields: new Map(), from: 0 };
}

/**
 * Heading-path chunking.
 *
 * Sections are split at headings and then, if still over the cap, at blank
 * lines — but never inside a fenced block, because half a code block is worse
 * than a chunk over budget.
 */
export function chunkMarkdown(
	path: string,
	text: string,
	kind: ChunkKind,
	options: { date?: string; skip?: (line: string, index: number) => boolean } = {},
): Chunk[] {
	const lines = text.split("\n");
	const front = readFrontMatter(lines);
	const date = options.date ?? front.fields.get("updated");

	const chunks: Chunk[] = [];
	let ordinal = 0;
	let title = "";
	const stack: string[] = [];
	let section: string[] = [];
	let sectionPath = "";
	let fence: string | undefined;
	let comment = false;

	const flush = (): void => {
		for (const body of splitSection(section)) {
			chunks.push(
				trim({
					id: `${path}#${++ordinal}`,
					kind,
					path,
					title,
					headingPath: sectionPath,
					body,
					tags: kind,
					date,
					links: extractLinks(body),
				}),
			);
		}
		section = [];
	};

	for (let i = front.from; i < lines.length; i++) {
		const line = lines[i] as string;
		fence = trackFence(line, fence);

		// HTML comments are instructions to whoever edits the file — the header
		// every `MEMORY.md` carries, say. Indexing them would let a query match
		// Muninn's own boilerplate instead of the memory under it.
		if (fence === undefined) {
			if (comment) {
				if (line.includes("-->")) comment = false;
				continue;
			}
			const trimmed = line.trim();
			if (trimmed.startsWith("<!--")) {
				if (!trimmed.includes("-->")) comment = true;
				continue;
			}
		}

		if (fence === undefined && options.skip?.(line, i)) continue;

		const heading = fence === undefined ? line.match(HEADING) : null;
		if (heading) {
			flush();
			const level = (heading[1] as string).length;
			const headingTitle = (heading[2] as string).trim();
			stack.length = Math.min(stack.length, level - 1);
			while (stack.length < level - 1) stack.push("");
			stack[level - 1] = headingTitle;
			if (title === "" && level === 1) title = headingTitle;
			sectionPath = stack.filter((part) => part !== "").join(BREADCRUMB);
			continue;
		}

		section.push(line);
	}
	flush();

	// A file with no H1 still needs a name a result can show.
	const fallback = basename(path, ".md");
	return chunks.map((chunk) => (chunk.title === "" ? { ...chunk, title: fallback } : chunk));
}

/** Split a section's lines into pieces within the cap, never breaking a fence. */
function splitSection(lines: string[]): string[] {
	const text = lines.join("\n").trim();
	if (text === "") return [];
	if (text.length <= MAX_CHUNK_CHARS) return [text];

	const pieces: string[] = [];
	let current: string[] = [];
	let length = 0;
	let fence: string | undefined;

	for (const line of lines) {
		fence = trackFence(line, fence);

		// Only a blank line outside a fence is a legal break, and only once the
		// piece is actually over budget.
		if (fence === undefined && line.trim() === "" && length >= MAX_CHUNK_CHARS) {
			const piece = current.join("\n").trim();
			if (piece !== "") pieces.push(piece);
			current = [];
			length = 0;
			continue;
		}

		current.push(line);
		length += line.length + 1;
	}

	const last = current.join("\n").trim();
	if (last !== "") pieces.push(last);
	return pieces;
}

// ---------------------------------------------------------------------------
// Topic files and rules — written by dreams in Phase 2, read from the start
// ---------------------------------------------------------------------------

/**
 * A topic file: one chunk per fact, plus its prose as context.
 *
 * A fact line is a bullet — bolded claim, then a flat trailer carrying its id,
 * validity and evidence. The fact's own id is the chunk id, so a superseded
 * fact is dropped by exactly the same rule that drops a superseded claim.
 */
export function chunkTopic(path: string, text: string): Chunk[] {
	const lines = text.split("\n");
	const factLines = new Set<number>();
	const facts: Chunk[] = [];

	let superseded = false;
	let fence: string | undefined;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		const wasInside = fence !== undefined;
		fence = trackFence(line, fence);
		// Inside a fence, and the lines that open or close one, are code.
		if (wasInside || fence !== undefined) continue;

		const heading = line.match(HEADING);
		if (heading) {
			superseded = /superseded/i.test(heading[2] as string);
			continue;
		}

		const fact = parseFactLine(line, path, superseded);
		if (fact) {
			facts.push(fact);
			factLines.add(i);
		}
	}

	// Fact bullets are lifted out of the prose pass; leaving them in would index
	// the same sentence twice and let a topic chunk shadow the fact it repeats.
	const prose = chunkMarkdown(path, text, "topic", { skip: (_line, index) => factLines.has(index) });
	return [...facts, ...prose];
}

function parseFactLine(line: string, path: string, superseded: boolean): Chunk | undefined {
	if (!line.trimStart().startsWith("- ")) return undefined;
	const marker = line.indexOf(" id: ");
	if (marker < 0) return undefined;

	const trailer = parseTrailer(line.slice(marker));
	const id = trailer.get("id");
	if (id === undefined || !isFactId(id)) return undefined;

	// The claim itself: the bullet, minus the trailer, minus bold and strike
	// markers — `~~…~~` marks a superseded fact, which the trailer already says.
	const body = line
		.slice(line.indexOf("- ") + 2, marker)
		.replace(/\*\*/g, "")
		.replace(/~~/g, "")
		.trim();

	const chunk: Chunk = {
		id,
		kind: "fact",
		path,
		title: basename(path, ".md"),
		headingPath: superseded ? "Superseded" : "Facts",
		body,
		tags: ["fact", trailer.get("source"), trailer.get("phase")].filter(Boolean).join(" "),
		links: [...new Set([...extractLinks(line.slice(marker)), ...extractLinks(body)])].filter((link) => link !== id),
	};
	const cue = trailer.get("cue");
	if (cue !== undefined) chunk.cue = cue;
	const source = trailer.get("source");
	if (source !== undefined) chunk.source = source;
	const phase = trailer.get("phase");
	if (phase !== undefined) chunk.phase = phase;
	const date = trailer.get("valid_from");
	if (date !== undefined) chunk.date = date;
	if (superseded || trailer.has("valid_to")) chunk.superseded = true;
	return trim(chunk);
}

const RULE_LINE = /^-\s+(R-\d+)\s*(?:·(.*))?$/;

/**
 * `rules.md`: one chunk per rule.
 *
 * A rule is a bullet naming its id and a flat trailer, with the rule's text on
 * the indented lines below it. Rules have identities so a dream can retire one
 * rather than silently drop it; the id is the chunk id for the same reason.
 */
export function chunkRules(path: string, text: string): Chunk[] {
	const lines = text.split("\n");
	const chunks: Chunk[] = [];
	let retired = false;
	let current: { chunk: Chunk; body: string[] } | undefined;

	const flush = (): void => {
		if (!current) return;
		const body = current.body.join("\n").trim();
		chunks.push(trim({ ...current.chunk, body, links: extractLinks(body) }));
		current = undefined;
	};

	let fence: string | undefined;
	for (const line of lines) {
		// A `# comment` inside a fenced shell block in a rule's body is not a
		// heading; without this it would flush the rule and could flip `retired`.
		const wasInside = fence !== undefined;
		fence = trackFence(line, fence);
		if (wasInside || fence !== undefined) {
			if (current) current.body.push(line);
			continue;
		}

		const heading = line.match(HEADING);
		if (heading) {
			flush();
			retired = /retired/i.test(heading[2] as string);
			continue;
		}

		const rule = line.match(RULE_LINE);
		if (rule) {
			flush();
			const trailer = parseTrailer(rule[2] ?? "");
			const chunk: Chunk = {
				id: rule[1] as string,
				kind: "rule",
				path,
				title: "rules",
				headingPath: retired ? "Retired" : "Rules",
				body: "",
				tags: ["rule", trailer.get("phase"), trailer.get("source"), trailer.get("scope")].filter(Boolean).join(" "),
				links: [],
			};
			const phase = trailer.get("phase");
			if (phase !== undefined) chunk.phase = phase;
			const source = trailer.get("source");
			if (source !== undefined) chunk.source = source;
			const since = trailer.get("since");
			if (since !== undefined) chunk.date = since;
			// A retired rule is no longer procedure; it is dropped by the same
			// active-only rule that drops a superseded fact.
			if (retired) chunk.superseded = true;
			current = { chunk, body: [] };
			continue;
		}

		if (current) current.body.push(line);
	}
	flush();

	return chunks.filter((chunk) => chunk.body !== "");
}

/** A chunk under construction, before the absent fields are dropped. */
type ChunkDraft = Omit<Chunk, "cue" | "date" | "source" | "phase" | "entry" | "superseded"> & {
	cue?: string | undefined;
	date?: string | undefined;
	source?: string | undefined;
	phase?: string | undefined;
	entry?: string | undefined;
	superseded?: boolean | undefined;
};

/** Drop the optional keys that came through undefined, so JSON stays small. */
function trim(chunk: ChunkDraft): Chunk {
	const result: Chunk = {
		id: chunk.id,
		kind: chunk.kind,
		path: chunk.path,
		title: chunk.title,
		headingPath: chunk.headingPath,
		body: chunk.body,
		tags: chunk.tags,
		links: chunk.links,
	};
	if (chunk.cue !== undefined && chunk.cue !== "") result.cue = chunk.cue;
	if (chunk.date !== undefined) result.date = chunk.date;
	if (chunk.source !== undefined) result.source = chunk.source;
	if (chunk.phase !== undefined) result.phase = chunk.phase;
	if (chunk.entry !== undefined) result.entry = chunk.entry;
	if (chunk.superseded) result.superseded = true;
	return result;
}
