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

import type { JournalSessionPointer, NewJournalRecord } from "../journal/record.ts";
import type { RunBuffer } from "./accumulate.ts";
import { renderRun } from "./accumulate.ts";
import type { MuninnSessionState } from "./session-state.ts";

/** How much of the run the outcome model is shown. */
export const RUN_TOKEN_BUDGET = 12_000;
export const PHASES = ["locate", "reproduce", "fix", "test", "review", "ops", "other"] as const;
export type Phase = (typeof PHASES)[number];

export const OUTCOME_SYSTEM_PROMPT = `You are writing one journal entry recording the outcome of a coding task, for a memory system that a future session will search.

Reply in EXACTLY this format and nothing else — no preamble, no code fences, no closing remarks:

phase: <one of: locate, reproduce, fix, test, review, ops, other>
cue: <when would a future session need this? one short line>

<one paragraph of context: what the task was and what happened>

- <a durable claim>
- <another durable claim>

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
}

export interface ParsedOutcome {
	phase: Phase;
	cue?: string;
	prose: string;
	claims: string[];
}

export interface ParseFailure {
	problem: string;
}

export type ParseResult = { ok: true; outcome: ParsedOutcome } | { ok: false; error: ParseFailure };

/** The prompt shown to the outcome model for one run. */
export function buildOutcomePrompt(request: OutcomeRequest): string {
	return `Transcript:\n\n${renderRun(request.buffer, RUN_TOKEN_BUDGET)}`;
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
	};
	if (cue !== undefined && cue !== "") outcome.cue = cue;
	return { ok: true, outcome };
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
export function shouldWriteOutcome(buffer: RunBuffer, options: { outcomesEnabled: boolean }): SkipReason | undefined {
	if (!options.outcomesEnabled) return { skip: true, reason: "capture.outcomes is off" };
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
	base: { channel: NewJournalRecord["channel"]; session?: string | undefined },
): NewJournalRecord {
	const entry: NewJournalRecord = {
		type: "outcome",
		source: "agent",
		channel: base.channel,
		task: request.state.task,
		body: [outcome.prose, ...outcome.claims.map((claim) => `- ${claim}`)].filter(Boolean).join("\n"),
		tags: [outcome.phase],
		paths: [],
		relations: [],
	};
	const pointer = journalSessionPointer(base.session);
	if (pointer) entry.session = pointer;
	if (request.state.continues) entry.continues = request.state.continues;
	if (outcome.cue) entry.cue = outcome.cue;
	return entry;
}

function journalSessionPointer(pointer: string | undefined): JournalSessionPointer | undefined {
	if (!pointer) return undefined;
	const hash = pointer.lastIndexOf("#");
	if (hash === -1) return { file: pointer };
	const last = pointer.slice(hash + 1);
	return { file: pointer.slice(0, hash), ...(last ? { last } : {}) };
}
