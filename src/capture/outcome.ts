/**
 * The outcome entry: what the task was, what was tried, what worked, what
 * failed and why.
 *
 * Written by the session's own model against a strict template, because the
 * model that just did the work is the only thing that knows what the work was.
 * Failures are memory too — a run that ended badly is often the more useful
 * entry.
 *
 * The parse is strict and the reply is never journaled raw. A malformed reply
 * is retried once with the parse error appended and then dropped: an entry
 * nobody can read is worse than no entry, because the journal is append-only
 * and every reader downstream must cope with it forever.
 */

import type { NewJournalEntry } from "../journal/append.ts";
import { PHASES, type Phase } from "../journal/format.ts";
import type { RunBuffer } from "./accumulate.ts";
import { renderRun } from "./accumulate.ts";
import type { MuninnSessionState } from "./session-state.ts";

/** How much of the run the outcome model is shown. */
export const RUN_TOKEN_BUDGET = 12_000;

export const OUTCOME_SYSTEM_PROMPT = `You are writing one journal entry recording the outcome of a coding task, for a memory system that a future session will search.

Reply in EXACTLY this format and nothing else — no preamble, no code fences, no closing remarks:

phase: <one of: locate, reproduce, fix, test, review, ops, other>
cue: <when would a future session need this? one short line>

<one paragraph of context: what the task was and what happened>

- <a durable claim>
- <another durable claim>

used: <comma-separated ids from "Memories in context", or omit this line entirely>

Rules for the claims, which are the part that gets remembered:
- Write what a future session would need to KNOW, not what happened chronologically.
- Prefer specifics that will still be true next week: commands, flags, file paths, constraints, causes.
- Record failures and dead ends too. "X does not work because Y" is worth as much as a fix.
- Do not write claims about this conversation, the user's mood, or your own process.
- If nothing durable was learned, write no bullets at all.
- One sentence per claim. No nesting.`;

export interface OutcomeRequest {
	buffer: RunBuffer;
	state: MuninnSessionState;
	/** Texts of the memories Muninn recalled, by id. Populated once recall exists. */
	recalledTexts?: ReadonlyMap<string, string>;
}

export interface ParsedOutcome {
	phase: Phase;
	cue?: string;
	prose: string;
	claims: string[];
	used: string[];
}

export interface ParseFailure {
	problem: string;
}

export type ParseResult = { ok: true; outcome: ParsedOutcome } | { ok: false; error: ParseFailure };

/** The prompt shown to the outcome model for one run. */
export function buildOutcomePrompt(request: OutcomeRequest): string {
	const parts: string[] = [];

	if (request.state.recalled.length > 0) {
		const lines = request.state.recalled.map((id) => {
			const text = request.recalledTexts?.get(id);
			return text ? `- ${id}: ${text}` : `- ${id}`;
		});
		parts.push(`Memories in context (cite in "used:" only those that actually mattered):\n${lines.join("\n")}`);
	}

	parts.push(`Transcript:\n\n${renderRun(request.buffer, RUN_TOKEN_BUDGET)}`);
	return parts.join("\n\n");
}

function isPhase(value: string): value is Phase {
	return (PHASES as readonly string[]).includes(value);
}

/**
 * Parse a reply into an entry body.
 *
 * Deliberately unforgiving about `phase`, which retrieval filters on: a made-up
 * phase would quietly exclude the entry from every future search that filtered
 * by step, which is worse than not writing it.
 */
export function parseOutcome(reply: string): ParseResult {
	// Models like to wrap things in fences however firmly they are told not to.
	const text = reply
		.trim()
		.replace(/^```[a-z]*\n/i, "")
		.replace(/\n```$/, "")
		.trim();
	if (text === "") return { ok: false, error: { problem: "empty reply" } };

	const lines = text.split("\n");
	let phase: Phase | undefined;
	let cue: string | undefined;
	let used: string[] = [];
	const body: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		const lower = trimmed.toLowerCase();

		if (phase === undefined && lower.startsWith("phase:")) {
			const value = trimmed.slice("phase:".length).trim().toLowerCase();
			if (!isPhase(value)) return { ok: false, error: { problem: `"${value}" is not a known phase` } };
			phase = value;
			continue;
		}
		if (cue === undefined && lower.startsWith("cue:")) {
			cue = trimmed.slice("cue:".length).trim();
			continue;
		}
		if (lower.startsWith("used:")) {
			used = trimmed
				.slice("used:".length)
				.split(",")
				.map((id) => id.trim())
				.filter((id) => id !== "" && id.toLowerCase() !== "none");
			continue;
		}
		body.push(line);
	}

	if (phase === undefined) return { ok: false, error: { problem: "missing `phase:` line" } };

	const claims: string[] = [];
	const prose: string[] = [];
	for (const line of body) {
		const trimmed = line.trim();
		if (trimmed.startsWith("- ")) claims.push(trimmed.slice(2).trim());
		else if (claims.length > 0 && /^\s{2,}\S/.test(line)) {
			claims[claims.length - 1] = `${claims[claims.length - 1]} ${trimmed}`;
		} else prose.push(line);
	}

	const outcome: ParsedOutcome = {
		phase,
		prose: prose
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
		claims: claims.filter((claim) => claim !== ""),
		used,
	};
	if (cue !== undefined && cue !== "") outcome.cue = cue;
	return { ok: true, outcome };
}

// ---------------------------------------------------------------------------
// Echoes
// ---------------------------------------------------------------------------

const ECHO_THRESHOLD = 0.8;

function tokenSet(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9_.-]+/)
			.filter((token) => token !== ""),
	);
}

export function jaccard(a: string, b: string): number {
	const left = tokenSet(a);
	const right = tokenSet(b);
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	for (const token of left) if (right.has(token)) shared++;
	return shared / (left.size + right.size - shared);
}

/**
 * Ids of recalled memories that a claim merely restates.
 *
 * An echo is journaled — it is useful as a usage signal — but the gather phase
 * never counts it toward recurrence, and it can never be the sole evidence for
 * a fact. Without this a fact would corroborate itself: recalled, restated in
 * the outcome, observed again next session, promoted on `use_count`.
 */
export function findEchoes(claims: readonly string[], recalledTexts: ReadonlyMap<string, string>): string[] {
	const echoes = new Set<string>();
	for (const claim of claims) {
		for (const [id, text] of recalledTexts) {
			if (jaccard(claim, text) >= ECHO_THRESHOLD) echoes.add(id);
		}
	}
	return [...echoes];
}

// ---------------------------------------------------------------------------
// Deciding whether to write one at all
// ---------------------------------------------------------------------------

export interface SkipReason {
	skip: true;
	reason: string;
}

/**
 * Whether this run is worth an outcome entry.
 *
 * A run with no tool calls and one turn is a question answered, not a task
 * performed. Journaling those is how a memory store fills with chit-chat
 * nobody trusts.
 */
export function shouldWriteOutcome(
	buffer: RunBuffer,
	options: { outcomesEnabled: boolean; alreadyJournaled: boolean },
): SkipReason | undefined {
	if (!options.outcomesEnabled) return { skip: true, reason: "capture.outcomes is off" };
	if (options.alreadyJournaled) return { skip: true, reason: "this run was already journaled before compaction" };
	if (buffer.messages.length === 0) return { skip: true, reason: "nothing happened in this run" };
	if (buffer.toolCallCount === 0 && buffer.turnCount < 2) {
		return { skip: true, reason: "no tool calls and a single turn — a question, not a task" };
	}
	return undefined;
}

/** Assemble the journal entry from a parsed reply. */
export function outcomeEntry(
	outcome: ParsedOutcome,
	request: OutcomeRequest,
	base: { channel: NewJournalEntry["channel"]; session?: string | undefined },
): NewJournalEntry {
	const recalled = [...new Set([...request.state.recalled, ...request.buffer.recalled])];
	// `used` is the only input to use_count, so it is filtered to ids that were
	// really in context — a model naming something it never saw must not inflate
	// that count.
	const used = outcome.used.filter((id) => recalled.includes(id));
	const echoes = findEchoes(outcome.claims, request.recalledTexts ?? new Map());

	const entry: NewJournalEntry = {
		source: "agent",
		task: request.state.task,
		phase: outcome.phase,
		prose: outcome.prose,
		claims: outcome.claims,
	};
	if (base.channel) entry.channel = base.channel;
	if (base.session) entry.session = base.session;
	if (request.state.continues) entry.continues = request.state.continues;
	if (outcome.cue) entry.cue = outcome.cue;
	if (recalled.length > 0) entry.recalled = recalled;
	if (used.length > 0) entry.used = used;
	if (echoes.length > 0) entry.echo = echoes;
	return entry;
}
