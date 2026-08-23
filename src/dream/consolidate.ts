/**
 * Phase 3 of a dream: one bounded job per topic, and the only place a model
 * decides anything.
 *
 * The job is deliberately small and flat, because the design's whole bet is
 * that a 4–9B model run locally is enough for this and nothing larger is
 * needed. So: one topic, at most 40 facts and 30 evidence entries, reasoning
 * first and then a fenced JSON block, an array of objects with no nesting
 * beyond one list of ids. Hard schema-constrained decoding is not used — it
 * measurably lowers accuracy on small models — and the parser retries once with
 * its own error quoted instead.
 *
 * Everything the model emits is then checked by code, and the checks are the
 * point. A model that cites an id it was never shown, restates a memory it was
 * given, supersedes most of a topic, or writes out a secret is not a model
 * having a bad day: it is the failure mode that makes derived memory
 * untrustworthy, and each one has a named refusal here.
 */

import { claimsOf } from "../journal/format.ts";
import type { JournalEntryWithContext } from "../journal/read.ts";
import type { Supersession } from "../journal/supersessions.ts";
import { containsSecret } from "../redact.ts";
import { allFacts, type Fact, type TopicFile } from "../topics/format.ts";
import {
	type ApplyOptions,
	type ApplyResult,
	applyFactList,
	type FactItem,
	MAX_LOSS_RATIO,
	withinLossBound,
} from "../topics/write.ts";
import type { GatheredClaim } from "./gather.ts";
import type { DreamModel } from "./model.ts";

/** Facts one job may be shown. Beyond this the topic is sliced. */
export const MAX_FACTS = 40;

/**
 * The marker the test harness recognises a consolidate call by.
 *
 * A scripted provider has to tell Muninn's jobs apart from pi's own turns and
 * from the outcome call, and matching on a sentence of the system prompt is the
 * one signal that travels with the request.
 */
export const CONSOLIDATE_MARKER = "You are consolidating one topic of a memory store";

export const CONSOLIDATE_SYSTEM_PROMPT = `${CONSOLIDATE_MARKER}.

You are given the topic's current facts and new evidence from a journal. Emit the
replacement list of facts for this topic.

Rules:
- Every fact must cite evidence: one or more of the journal claim ids you were shown.
- Never invent an id. Only ids that appear in this prompt exist.
- A fact that is still true and unchanged: emit {"id": "<its id>"} and nothing else.
- A fact that replaces an older one: emit the new claim and list the old fact's id in "supersedes", with a short "reason".
- Say nothing about a fact you have no evidence about. Silence leaves it alone; it is not deleted.
- Write each claim as one self-contained sentence someone could act on months later.
- Never write a secret, a token or a password into a claim.

Reply with your reasoning, then a single fenced block:

\`\`\`json
[
  {"claim": "...", "evidence": ["j-....1"], "cue": "when would I need this", "phase": "test"},
  {"claim": "...", "evidence": ["j-....2"], "supersedes": ["f-topic-..."], "reason": "..."},
  {"id": "f-topic-..."}
]
\`\`\`

The block must be a flat JSON array of objects. No nesting beyond the lists of ids.`;

export interface ConsolidateJob {
	topic: string;
	isNew: boolean;
	/** The topic as it stands; an empty one when `isNew`. */
	file: TopicFile;
	claims: readonly GatheredClaim[];
	entries: readonly JournalEntryWithContext[];
}

export interface ConsolidateOptions extends ApplyOptions {
	model: DreamModel;
	signal?: AbortSignal;
	/**
	 * Ids a fact may never rest on, whatever the model says: echoes, superseded
	 * claims, erased entries. Held-out claims are absent from the prompt and
	 * from the topic, so they are refused by the allow-list rather than by name.
	 */
	refused?: ReadonlySet<string>;
}

export interface Refusal {
	claim: string;
	rule: string;
}

export type ConsolidateOutcome =
	| { ok: true; applied: ApplyResult; supersessions: Supersession[]; retries: number; refusals: Refusal[] }
	| { ok: false; reason: string; retries: number; refusals: Refusal[] };

/**
 * Run one topic's job.
 *
 * Two attempts at most: the second quotes the parser's own complaint, which is
 * the one piece of feedback that reliably fixes a small model's JSON. A third
 * would be a way of pretending a model can do something it cannot.
 */
export async function consolidate(job: ConsolidateJob, options: ConsolidateOptions): Promise<ConsolidateOutcome> {
	const prompt = buildConsolidatePrompt(job);
	let retries = 0;
	let problem = "";

	for (let attempt = 0; attempt < 2; attempt++) {
		let reply: string;
		try {
			reply = await options.model.complete(
				{
					systemPrompt: CONSOLIDATE_SYSTEM_PROMPT,
					prompt:
						attempt === 0
							? prompt
							: `${prompt}\n\nYour previous reply could not be used: ${problem}\nReply again, with the fenced JSON block exactly as described.`,
				},
				options.signal,
			);
		} catch (error) {
			return { ok: false, reason: `model call failed: ${describe(error)}`, retries, refusals: [] };
		}

		const parsed = parseFactList(reply);
		if (!parsed.ok) {
			problem = parsed.problem;
			retries = attempt + 1;
			continue;
		}
		return checkFactList(job, parsed.items, options, attempt);
	}

	return { ok: false, reason: `unparsable after one retry: ${problem}`, retries, refusals: [] };
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

export function buildConsolidatePrompt(job: ConsolidateJob): string {
	const out: string[] = [`# Topic: ${job.topic}`, ""];

	const shown = shownFacts(job.file);
	if (shown.facts.length === 0) {
		out.push("This topic has no facts yet.", "");
	} else {
		out.push("## Current facts", "");
		for (const fact of shown.facts) {
			out.push(`- ${fact.claim} [id: ${fact.id}${fact.cue ? `, cue: ${fact.cue}` : ""}]`);
		}
		if (shown.omitted > 0) {
			out.push("", `(${shown.omitted} older fact(s) of this topic are not shown and are out of scope for this job.)`);
		}
		out.push("");
	}

	out.push("## New evidence", "");
	for (const entry of job.entries) {
		const header = [
			`### ${entry.date} · ${entry.source}`,
			entry.cue ? `cue: ${entry.cue}` : "",
			entry.phase ? `phase: ${entry.phase}` : "",
		]
			.filter((part) => part !== "")
			.join(" · ");
		out.push(header);
		if (entry.prose.trim() !== "") out.push(entry.prose.trim());
		for (const claim of claimsOf(entry)) out.push(`- ${claim.text} [${claim.id}]`);
		out.push("");
	}

	return out.join("\n").trimEnd();
}

/**
 * The slice of a topic one job may see.
 *
 * Newest first, because a job's evidence is new and the facts it is most likely
 * to supersede are the recent ones. The rest are named as out of scope rather
 * than hidden, so the model does not read their absence as "this topic is
 * small" and start rewriting it wholesale.
 */
export function shownFacts(file: TopicFile): { facts: Fact[]; omitted: number } {
	const active = [...file.facts, ...file.external].sort((a, b) =>
		a.validFrom === b.validFrom ? (a.id < b.id ? 1 : -1) : a.validFrom < b.validFrom ? 1 : -1,
	);
	return { facts: active.slice(0, MAX_FACTS), omitted: Math.max(0, active.length - MAX_FACTS) };
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

export type ParseResult = { ok: true; items: FactItem[] } | { ok: false; problem: string };

const FENCE = /```(?:json)?\s*\n([\s\S]*?)\n?```/g;

/**
 * The last fenced block in a reply, parsed as a flat array.
 *
 * The *last*, because the prompt asks for reasoning first and a small model
 * will happily illustrate its reasoning with a fenced example on the way. The
 * block it ends with is the answer.
 *
 * Not shared with `capture/outcome.ts`'s parser despite the family
 * resemblance: that one reads a line-oriented template and merely strips a
 * fence a model wrapped it in, which is a different job from finding one block
 * among several.
 */
export function parseFactList(reply: string): ParseResult {
	const blocks = [...reply.matchAll(FENCE)].map((match) => match[1] as string);
	const text = blocks.at(-1) ?? reply.trim();

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { ok: false, problem: `the fenced block is not valid JSON (${describe(error)})` };
	}
	if (!Array.isArray(parsed)) return { ok: false, problem: "the fenced block must be a JSON array" };

	const items: FactItem[] = [];
	for (const [index, raw] of parsed.entries()) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return { ok: false, problem: `item ${index} is not an object` };
		}
		const record = raw as Record<string, unknown>;
		const item: FactItem = {};
		if (typeof record.id === "string") item.id = record.id;
		if (typeof record.claim === "string") item.claim = record.claim;
		if (typeof record.cue === "string") item.cue = record.cue;
		if (typeof record.reason === "string") item.reason = record.reason;
		if (typeof record.phase === "string") item.phase = record.phase as FactItem["phase"];
		const evidence = stringList(record.evidence);
		if (evidence !== undefined) item.evidence = evidence;
		const supersedes = stringList(record.supersedes);
		if (supersedes !== undefined) item.supersedes = supersedes;

		if (item.id === undefined && item.claim === undefined) {
			return { ok: false, problem: `item ${index} has neither "claim" nor "id"` };
		}
		items.push(item);
	}
	return { ok: true, items };
}

function stringList(value: unknown): string[] | undefined {
	if (typeof value === "string") return value === "" ? [] : [value];
	if (!Array.isArray(value)) return undefined;
	return value.filter((part): part is string => typeof part === "string");
}

// ---------------------------------------------------------------------------
// The guards
// ---------------------------------------------------------------------------

/**
 * Everything a fact of this job is allowed to cite.
 *
 * The claims in this job's evidence, plus the evidence the topic's own facts
 * already stand on — a consolidation may legitimately re-cite what it is
 * merging. Nothing else exists as far as this job is concerned, which is what
 * makes a held-out task unreachable without naming it.
 */
export function allowedEvidence(job: ConsolidateJob): Set<string> {
	const allowed = new Set<string>();
	for (const entry of job.entries) for (const claim of claimsOf(entry)) allowed.add(claim.id);
	for (const fact of allFacts(job.file)) for (const id of fact.evidence) allowed.add(id);
	return allowed;
}

/**
 * Check a fact list and apply it, or say why not.
 *
 * Exported because the merge dream runs the same guards over a different
 * prompt. A merge that could cite ids a plain consolidation could not would be
 * a hole in the allow-list shaped exactly like the hardest prompt in the system.
 */
export function checkFactList(
	job: ConsolidateJob,
	items: readonly FactItem[],
	options: ConsolidateOptions,
	attempt: number,
): ConsolidateOutcome {
	const allowed = allowedEvidence(job);
	const refused = options.refused ?? new Set<string>();
	const known = new Set(allFacts(job.file).map((fact) => fact.id));
	const refusals: Refusal[] = [];

	const kept: FactItem[] = [];
	for (const item of items) {
		if (item.claim === undefined || item.claim.trim() === "") {
			// A bare `{"id": …}` is "leave this alone"; an id for a fact this
			// topic does not have is a hallucination, and saying so is cheap.
			if (item.id !== undefined && !known.has(item.id)) {
				refusals.push({ claim: item.id, rule: "unknown-fact-id" });
			}
			continue;
		}

		const evidence = (item.evidence ?? []).filter((id) => allowed.has(id) && !refused.has(id));
		if (evidence.length === 0) {
			// The single most important refusal in the system: a fact nobody can
			// trace to a journal claim is exactly what the design exists to make
			// impossible.
			refusals.push({ claim: item.claim, rule: "unsourced" });
			continue;
		}
		if (containsSecret(item.claim) || (item.cue !== undefined && containsSecret(item.cue))) {
			// Redaction runs at capture; it runs again here because a model can
			// assemble a secret out of fragments that were each innocent.
			refusals.push({ claim: "(refused: would carry a secret)", rule: "secret" });
			continue;
		}
		// `{id, claim}` together: the prompt asks for `{id}` alone to mean "leave
		// this one", but the premise is a 4B model and every other way of not
		// complying has a named refusal. Read as "replace that fact with this
		// claim" — the likely intent, and safe, because supersession keeps the
		// original. Taken as an addition it silently doubled the topic on every
		// dream that did it.
		const named = item.id !== undefined && known.has(item.id) ? [item.id] : [];
		const supersedes = [...new Set([...named, ...(item.supersedes ?? [])])].filter((id) => known.has(id));
		kept.push({
			...item,
			evidence,
			...(supersedes.length > 0 ? { supersedes } : {}),
			...(named.length > 0 && item.reason === undefined ? { reason: "restated by a later dream" } : {}),
		});
	}

	const applied = applyFactList(job.file, kept, options);
	const activeBefore = job.file.facts.length + job.file.external.length;
	const activeAfter = applied.topic.facts.length + applied.topic.external.length;
	if (!withinLossBound(activeBefore, activeAfter)) {
		return {
			ok: false,
			reason: `would leave ${activeAfter} of ${activeBefore} facts, over the ${Math.round(MAX_LOSS_RATIO * 100)}% bound`,
			retries: attempt,
			refusals,
		};
	}
	for (const unknown of applied.unknownSupersedes) refusals.push({ claim: unknown, rule: "unknown-fact-id" });

	return { ok: true, applied, supersessions: applied.supersessions, retries: attempt, refusals };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
