/**
 * Turning memory into text a model reads and a terminal shows.
 *
 * Two audiences, one file. The model gets the flat `key: value` trailer every
 * other Muninn format uses, because a model that has read a journal entry has
 * already learned to read this. The terminal gets one line per hit —
 * `date · scope · source · id · heading` — with the full text one keypress
 * away.
 *
 * Ids are written in full for the model and shortened only for the terminal
 * line. A shortened id is ambiguous by construction: it is a thing to look at,
 * never a thing to pass back into a tool.
 */
import { parseClaimId, shortenId } from "../ids.ts";
import type { SearchHit } from "../index/search.ts";
import type { StoredChunk } from "../index/tier0.ts";
import { claimsOf, type JournalEntry } from "../journal/format.ts";
import { tokenBudgetChars } from "../tokens.ts";

/** How much of one hit's text a search result shows before it is cut. */
const HIT_CHARS = tokenBudgetChars(120);

/** The whole result of one tool call, at most. */
export const TOOL_OUTPUT_CHARS = tokenBudgetChars(4_000);

export function truncate(text: string, chars: number): string {
	if (text.length <= chars) return text;
	return `${text.slice(0, chars - 1).trimEnd()}…`;
}

/** The flat trailer describing where a memory came from. */
export function trailer(chunk: StoredChunk & { scope?: string }): string {
	const parts = [`id: ${chunk.id}`];
	if (chunk.date) parts.push(`date: ${chunk.date}`);
	if (chunk.source) parts.push(`source: ${chunk.source}`);
	if (chunk.scope) parts.push(`scope: ${chunk.scope}`);
	parts.push(`kind: ${chunk.kind}`);
	if (chunk.phase) parts.push(`phase: ${chunk.phase}`);
	if (chunk.cue) parts.push(`cue: ${chunk.cue}`);
	// Superseded results only appear under `history: true`, and when they do the
	// model must be able to see which ones they are.
	if (chunk.superseded) parts.push("superseded: true");
	return parts.join(" · ");
}

/** `memory_search` results, best first. */
export function renderHits(hits: readonly SearchHit[], options: { history?: boolean } = {}): string {
	if (hits.length === 0) {
		return options.history
			? "No memories match, including superseded ones."
			: "No active memories match. Try `history: true` to include superseded ones, or different words.";
	}

	const header = `${hits.length} ${hits.length === 1 ? "memory" : "memories"}${options.history ? " (including superseded)" : ""}:`;
	const blocks = hits.map((hit) => `- ${truncate(hit.snippet || hit.body, HIT_CHARS)}\n  ${trailer(hit)}`);
	return truncate([header, "", ...blocks].join("\n"), TOOL_OUTPUT_CHARS);
}

/**
 * An id elided for a terminal line.
 *
 * A claim's ordinal survives the elision: `.1` and `.2` of one entry are
 * different memories, and a line that hid which one it meant would be useless
 * exactly where two claims of the same entry both match.
 */
export function shortenMemoryId(id: string): string {
	const claim = parseClaimId(id);
	return claim ? `${shortenId(claim.entryId)}.${claim.ordinal}` : shortenId(id);
}

/** One line for a terminal: shortened id, because nothing here is copied into a tool call. */
export function renderHitLine(hit: SearchHit): string {
	const parts = [
		hit.date ?? "",
		hit.scope,
		hit.source ?? hit.kind,
		shortenMemoryId(hit.id),
		hit.cue ?? hit.headingPath,
	];
	return parts.filter((part) => part !== "").join(" · ");
}

export interface EntryContext {
	scope: string;
	/** Store-relative path of the daily file. */
	path: string;
	date?: string;
	/** The claim that was asked for, when the read was addressed to one. */
	claim?: string;
	superseded?: ReadonlySet<string>;
}

/**
 * A whole journal entry: its metadata, its prose, and its claims by address.
 *
 * The prose is included even though recall never matches it. A human or a
 * model reading an entry wants the situation the claims came out of — that is
 * the entire reason `memory_read` exists next to `memory_search`.
 */
export function renderEntry(entry: JournalEntry, context: EntryContext): string {
	const lines: string[] = [];
	const fields = [`id: ${entry.id}`];
	if (context.date) fields.push(`date: ${context.date}`);
	fields.push(`time: ${entry.time}`, `source: ${entry.source}`);
	if (entry.channel) fields.push(`channel: ${entry.channel}`);
	if (entry.phase) fields.push(`phase: ${entry.phase}`);
	fields.push(`scope: ${context.scope}`);
	if (entry.cue) fields.push(`cue: ${entry.cue}`);
	if (entry.task) fields.push(`task: ${entry.task}`);
	if (entry.continues) fields.push(`continues: ${entry.continues}`);
	if (entry.session) fields.push(`session: ${entry.session}`);
	if (entry.recalled?.length) fields.push(`recalled: ${entry.recalled.join(", ")}`);
	if (entry.used?.length) fields.push(`used: ${entry.used.join(", ")}`);
	if (entry.echo?.length) fields.push(`echo: ${entry.echo.join(", ")}`);
	if (entry.redacted) fields.push("redacted: true");
	lines.push(fields.join(" · "), `file: ${context.path}`);

	if (entry.prose !== "") lines.push("", "Context (not evidence on its own):", entry.prose);

	const claims = claimsOf(entry);
	if (claims.length > 0) {
		lines.push("", "Claims:");
		for (const claim of claims) {
			const marks = [context.claim === claim.id ? "→" : " ", context.superseded?.has(claim.id) ? "[superseded]" : ""]
				.filter((mark) => mark !== "")
				.join(" ");
			lines.push(`${marks} ${claim.id}`, `    ${claim.text}`);
		}
	}

	return truncate(lines.join("\n"), TOOL_OUTPUT_CHARS);
}

/** A slice of a file, with line numbers so a follow-up range means something. */
export function renderFile(path: string, text: string, range?: { from: number; to: number }): string {
	const lines = text.split("\n");
	// A file ending in a newline is not a file with a blank last line; counting
	// it as one would make every range the reader asks for one off.
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	const from = Math.max(1, range?.from ?? 1);
	const to = Math.min(lines.length, range?.to ?? lines.length);
	const width = String(to).length;

	const body = lines
		.slice(from - 1, to)
		.map((line, index) => `${String(from + index).padStart(width, " ")}  ${line}`)
		.join("\n");
	const header = range ? `${path} (lines ${from}–${to} of ${lines.length})` : `${path} (${lines.length} lines)`;
	return truncate([header, "", body].join("\n"), TOOL_OUTPUT_CHARS);
}
