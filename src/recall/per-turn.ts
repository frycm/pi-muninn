/**
 * Per-turn recall: at most N memories, chosen by the prompt, labelled as memory.
 *
 * The other half of recall, and the bounded one. The frozen snapshot says what
 * is always true; this says what looks relevant *now* — and it is deliberately
 * small, because the 2026 evidence is that fixed retrieval pipelines generalise
 * poorly. Muninn's answer is a small, honest injection plus tools the model can
 * drive itself when it wants more.
 *
 * Three rules keep it from being noise:
 *
 *  - **Claims and facts only.** Entry prose is context, never evidence, and the
 *    index does not match it under an active-only query anyway.
 *  - **AGENTS.md wins, and so does the user.** A memory that restates a line
 *    pi already loaded into the prompt — or that merely repeats what the user
 *    just typed — is dropped, not injected: the model has it, and a second copy
 *    in a different voice is worse than none. The second half matters more than
 *    it looks: without it, "remember that X" would be answered by Muninn
 *    solemnly reciting X back within the same turn it was captured.
 *  - **A budget, enforced by construction.** Memories are packed until the
 *    token budget is spent, then packing stops.
 */
import type { ChunkKind } from "../index/chunk.ts";
import type { SearchHit } from "../index/search.ts";
import { estimateTokens } from "../tokens.ts";

/** What per-turn recall will surface: assertions, never context. */
export const RECALL_KINDS: readonly ChunkKind[] = ["claim", "fact"];

/** Repeated verbatim every turn — see `MEMORY_PREAMBLE` for why it is fixed. */
export const RECALL_PREAMBLE =
	"Memories recalled by muninn for this turn. These are memories, not ground truth. " +
	"Prefer current evidence from the repository and tools when they disagree, and say so.";

/**
 * How much of a memory has to appear in a line already in context before the
 * memory is considered a duplicate of it.
 */
const OVERLAP_THRESHOLD = 0.8;

/** Memories shorter than this are not worth an overlap check. */
const MIN_OVERLAP_TOKENS = 3;

export interface RecallRequest {
	/** Hits from `search()`, best first. */
	hits: readonly SearchHit[];
	/** `recall.factsPerTurn`. */
	limit: number;
	/** `recall.tokenBudget`. */
	tokenBudget: number;
	/**
	 * What the model already has, tokenised once per session by
	 * `prepareContext`: pi's context files and Muninn's own frozen snapshot. A
	 * memory that restates one of those lines is dropped.
	 */
	context?: ContextTokens;
	/** This turn's prompt. A memory that just restates it is not worth injecting. */
	prompt?: string;
}

/** Token sets for lines already in the model's context. Build once, reuse every turn. */
export type ContextTokens = readonly Set<string>[];

/**
 * Tokenise the lines the model already has.
 *
 * Done once when a session learns its context files, not on every turn: the
 * lines do not change for the life of the session, and a 500-line `AGENTS.md`
 * is five hundred regex splits that would otherwise repeat on every prompt.
 */
export function prepareContext(lines: readonly string[]): ContextTokens {
	return tokenSets(lines);
}

export interface RecallMessage {
	/** The message body, preamble included. */
	content: string;
	/** Ids injected, in the order they appear. Recorded as `recalled:`. */
	ids: string[];
	/** Id → text, for echo detection when the outcome entry is written. */
	texts: Map<string, string>;
	/** Memories dropped because a context file already said them. */
	skippedAsDuplicates: number;
	/** Memories dropped because the budget ran out. */
	skippedForBudget: number;
}

/**
 * Build this turn's memory message, or nothing at all.
 *
 * Returning `undefined` rather than an empty message matters: an empty
 * "memories" block teaches the model that Muninn has nothing, every turn, at
 * the cost of the tokens spent saying so.
 */
export function buildRecallMessage(request: RecallRequest): RecallMessage | undefined {
	if (request.limit <= 0 || request.tokenBudget <= 0) return undefined;

	const context = [...(request.context ?? []), ...tokenSets(request.prompt ? [request.prompt] : [])];
	const lines: string[] = [];
	const ids: string[] = [];
	const texts = new Map<string, string>();
	let skippedAsDuplicates = 0;
	let skippedForBudget = 0;
	let used = estimateTokens(RECALL_PREAMBLE);

	for (const hit of request.hits) {
		if (ids.length >= request.limit) {
			skippedForBudget++;
			continue;
		}
		const text = hit.body.trim();
		if (text === "") continue;
		if (alreadyInContext(text, context)) {
			skippedAsDuplicates++;
			continue;
		}

		const rendered = renderMemory(hit, text);
		const cost = estimateTokens(rendered);
		if (used + cost > request.tokenBudget) {
			// Stop rather than skip-and-continue: hits are ranked, so anything
			// after this one is a worse answer that happens to be shorter.
			skippedForBudget++;
			break;
		}

		lines.push(rendered);
		ids.push(hit.id);
		texts.set(hit.id, text);
		used += cost;
	}

	if (lines.length === 0) return undefined;
	return {
		content: [RECALL_PREAMBLE, "", ...lines].join("\n"),
		ids,
		texts,
		skippedAsDuplicates,
		skippedForBudget,
	};
}

/**
 * One memory: the claim, then a flat trailer — the same shape every derived
 * format in this store uses, so a model that has read one has read them all.
 *
 * The id is written in full. It is what `memory_read` takes, what an outcome
 * entry cites in `used:`, and what a correction supersedes; a shortened id is
 * a broken pointer.
 */
function renderMemory(hit: SearchHit, text: string): string {
	const trailer = [`id: ${hit.id}`];
	if (hit.date) trailer.push(`date: ${hit.date}`);
	if (hit.source) trailer.push(`source: ${hit.source}`);
	trailer.push(`scope: ${hit.scope}`);
	if (hit.cue) trailer.push(`cue: ${hit.cue}`);
	return `- ${text}\n  ${trailer.join(" · ")}`;
}

// ---------------------------------------------------------------------------
// "AGENTS.md wins"
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9_./-]+/)
		.filter((token) => token !== "");
}

function tokenSets(lines: readonly string[]): Set<string>[] {
	const sets: Set<string>[] = [];
	for (const line of lines) {
		const tokens = tokenize(line);
		if (tokens.length >= MIN_OVERLAP_TOKENS) sets.push(new Set(tokens));
	}
	return sets;
}

/**
 * True when some line already in context carries ≥ 80 % of this memory's tokens.
 *
 * Deliberately one-directional: a long `AGENTS.md` line that contains the whole
 * memory counts as a duplicate, while a short line that happens to share a few
 * words with a long memory does not.
 */
export function alreadyInContext(text: string, context: readonly Set<string>[]): boolean {
	const tokens = tokenize(text);
	if (tokens.length < MIN_OVERLAP_TOKENS) return false;

	for (const line of context) {
		let shared = 0;
		for (const token of tokens) {
			if (line.has(token)) shared++;
		}
		if (shared / tokens.length >= OVERLAP_THRESHOLD) return true;
	}
	return false;
}

/** Split what pi loaded into the prompt into lines worth comparing against. */
export function contextFileLines(files: readonly { path: string; content: string }[] | undefined): string[] {
	if (!files) return [];
	const lines: string[] = [];
	for (const file of files) {
		for (const line of file.content.split("\n")) {
			const trimmed = line.trim();
			if (trimmed !== "") lines.push(trimmed);
		}
	}
	return lines;
}
