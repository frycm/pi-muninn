/**
 * The journal entry grammar.
 *
 * Markdown with a flat `key: value` block — no nesting, no lists-of-maps. The
 * flatness is deliberate: it is what a 4B model emits reliably and what a
 * thirty-line parser reads without a YAML library.
 *
 * The prose is *context*; the bullets are *claims*. Claims are the unit of
 * everything downstream — each is addressed as `<entry id>.<ordinal>`, indexed
 * as its own chunk, cited by facts as evidence, and superseded individually.
 * An entry with no bullets has exactly one implicit claim, its prose, at `.1`.
 *
 * The heading carries a local `HH:MM` for a human reading the file. It is not
 * the authoritative timestamp: the entry id is a UUIDv7, so the exact UTC
 * milliseconds are recoverable from the id itself and need no field of their
 * own — and no field that could disagree with it.
 */
import { isEntryId } from "../ids.ts";

export const SOURCES = ["user", "agent", "tool", "external"] as const;
export const CHANNELS = ["tui", "rpc", "sdk", "hook", "dream"] as const;
export const PHASES = ["locate", "reproduce", "fix", "test", "review", "ops", "other"] as const;

export type Source = (typeof SOURCES)[number];
export type Channel = (typeof CHANNELS)[number];
export type Phase = (typeof PHASES)[number];

export interface JournalEntry {
	id: string;
	/** Local `HH:MM`, for humans. The id is the authoritative timestamp. */
	time: string;
	source: Source;
	channel?: Channel;
	task?: string;
	continues?: string;
	session?: string;
	phase?: Phase;
	cue?: string;
	recalled?: string[];
	used?: string[];
	echo?: string[];
	redacted?: boolean;
	promotedFrom?: string;
	/** Context. Never evidence on its own, never matched by active-only filtering. */
	prose: string;
	/** Evidence, in order. Addressed `<id>.1`, `<id>.2`, … */
	claims: string[];
	/** Fields a newer Muninn wrote that this one does not know. Preserved, never dropped. */
	extra?: Record<string, string>;
}

/** Field order in the written block. Unknown fields follow, in the order they were read. */
const FIELD_ORDER = [
	"source",
	"channel",
	"task",
	"continues",
	"session",
	"phase",
	"cue",
	"recalled",
	"used",
	"echo",
	"promoted_from",
	"redacted",
] as const;

const LIST_SEPARATOR = ", ";

function isSource(value: string): value is Source {
	return (SOURCES as readonly string[]).includes(value);
}

function isChannel(value: string): value is Channel {
	return (CHANNELS as readonly string[]).includes(value);
}

function isPhase(value: string): value is Phase {
	return (PHASES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Serialising
// ---------------------------------------------------------------------------

/**
 * Render one entry as the exact bytes appended to a daily file.
 *
 * The block ends with a blank line. That terminator is what makes a crash
 * mid-append detectable: an entry at end of file with no blank line after it
 * was never finished. Every complete entry has one, so the check is uniform.
 */
export function formatEntry(entry: JournalEntry): string {
	const fields = new Map<string, string>();
	fields.set("source", entry.source);
	if (entry.channel) fields.set("channel", entry.channel);
	if (entry.task) fields.set("task", entry.task);
	if (entry.continues) fields.set("continues", entry.continues);
	if (entry.session) fields.set("session", entry.session);
	if (entry.phase) fields.set("phase", entry.phase);
	if (entry.cue) fields.set("cue", entry.cue);
	if (entry.recalled?.length) fields.set("recalled", entry.recalled.join(LIST_SEPARATOR));
	if (entry.used?.length) fields.set("used", entry.used.join(LIST_SEPARATOR));
	if (entry.echo?.length) fields.set("echo", entry.echo.join(LIST_SEPARATOR));
	if (entry.promotedFrom) fields.set("promoted_from", entry.promotedFrom);
	if (entry.redacted) fields.set("redacted", "true");
	for (const [key, value] of Object.entries(entry.extra ?? {})) {
		if (!fields.has(key)) fields.set(key, value);
	}

	const lines: string[] = [`## ${entry.time} · ${entry.id}`];
	for (const key of FIELD_ORDER) {
		const value = fields.get(key);
		if (value !== undefined) lines.push(`${key}: ${value}`);
	}
	for (const [key, value] of fields) {
		if (!(FIELD_ORDER as readonly string[]).includes(key)) lines.push(`${key}: ${value}`);
	}

	const prose = entry.prose.trim();
	if (prose !== "") {
		lines.push("", guardProse(prose));
	}
	if (entry.claims.length > 0) {
		lines.push("");
		// A claim's continuation lines are indented, which also keeps a `## `
		// inside a claim off column 0; prose gets the same protection below.
		for (const claim of entry.claims) lines.push(`- ${claim.trim().replace(/\n/g, "\n  ")}`);
	}

	// Trailing blank line: the terminator described above.
	return `${lines.join("\n")}\n\n`;
}

/**
 * Lines of prose that would read back as something else.
 *
 * The reader splits a daily file on lines that begin with `## ` and takes
 * lines that begin with `- ` as claims. Prose is what the user or the model
 * wrote, and a note that quotes a markdown heading or a bullet list is
 * ordinary — so those lines are indented by one space on the way out, which
 * the reader strips on the way back in. Without this, a `## Deploy` line in a
 * note would split its own entry in two on the next read, and the claim ids
 * handed out at append time would stop resolving.
 */
const PROSE_GUARD = /^(#{1,6}\s|- )/;

function guardProse(prose: string): string {
	return prose
		.split("\n")
		.map((line) => (PROSE_GUARD.test(line) ? ` ${line}` : line))
		.join("\n");
}

/** Undo `guardProse`: a single leading space before a heading or bullet was ours. */
function unguardProse(line: string): string {
	return line.startsWith(" ") && PROSE_GUARD.test(line.slice(1)) ? line.slice(1) : line;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParseEntryResult {
	entry?: JournalEntry;
	/** Why the block could not be read as an entry. Empty on success. */
	problems: string[];
}

const HEADING = /^##\s+(\d{1,2}:\d{2})\s+·\s+(\S+)\s*$/;

/**
 * Parse one entry block (heading through to the end of its body).
 *
 * Tolerant of missing optional fields and of unknown ones; strict about the id
 * and `source`, because everything downstream addresses entries by id and
 * weighs them by provenance. An entry that fails either is reported and
 * dropped rather than guessed at.
 */
export function parseEntry(block: string): ParseEntryResult {
	const problems: string[] = [];
	const lines = block.split("\n");

	const headingLine = lines[0] ?? "";
	const heading = headingLine.match(HEADING);
	if (!heading) return { problems: [`unreadable heading: ${headingLine.trim() || "(empty)"}`] };

	const time = heading[1] as string;
	const id = heading[2] as string;
	if (!isEntryId(id)) return { problems: [`not a journal entry id: ${id}`] };

	// --- flat metadata block: every line until the first blank one ---------
	const fields = new Map<string, string>();
	let cursor = 1;
	for (; cursor < lines.length; cursor++) {
		const line = lines[cursor] as string;
		if (line.trim() === "") {
			cursor++;
			break;
		}
		const colon = line.indexOf(":");
		if (colon <= 0) {
			problems.push(`unreadable metadata line: ${line.trim()}`);
			continue;
		}
		fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
	}

	const sourceText = fields.get("source") ?? "";
	if (!isSource(sourceText)) {
		return { problems: [`missing or unknown source: ${sourceText || "(absent)"}`] };
	}

	// --- body: bullets are claims, everything else is context -------------
	const proseLines: string[] = [];
	const claims: string[] = [];
	for (; cursor < lines.length; cursor++) {
		const line = lines[cursor] as string;
		if (line.startsWith("- ")) {
			claims.push(line.slice(2).trim());
			continue;
		}
		// A wrapped bullet: an indented continuation belongs to the claim above
		// it, not to the prose. Without this a model's line-wrapped claim would
		// be silently torn in half.
		if (claims.length > 0 && /^\s{2,}\S/.test(line)) {
			claims[claims.length - 1] = `${claims[claims.length - 1]} ${line.trim()}`;
			continue;
		}
		proseLines.push(unguardProse(line));
	}

	const entry: JournalEntry = {
		id,
		time,
		source: sourceText,
		// Lifting bullets out from between paragraphs leaves the blank lines that
		// surrounded them behind, so collapse any run of them back to a single
		// paragraph break. Without this, prose round-trips with growing gaps.
		prose: proseLines
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
		claims,
	};

	const channel = fields.get("channel");
	if (channel !== undefined) {
		if (isChannel(channel)) entry.channel = channel;
		else problems.push(`unknown channel: ${channel}`);
	}
	const phase = fields.get("phase");
	if (phase !== undefined) {
		if (isPhase(phase)) entry.phase = phase;
		else problems.push(`unknown phase: ${phase}`);
	}

	const task = fields.get("task");
	if (task) entry.task = task;
	const continues = fields.get("continues");
	if (continues) entry.continues = continues;
	const session = fields.get("session");
	if (session) entry.session = session;
	const cue = fields.get("cue");
	if (cue) entry.cue = cue;
	const promotedFrom = fields.get("promoted_from");
	if (promotedFrom) entry.promotedFrom = promotedFrom;
	if (fields.get("redacted") === "true") entry.redacted = true;

	const recalled = parseList(fields.get("recalled"));
	if (recalled) entry.recalled = recalled;
	const used = parseList(fields.get("used"));
	if (used) entry.used = used;
	const echo = parseList(fields.get("echo"));
	if (echo) entry.echo = echo;

	const known = new Set<string>([...FIELD_ORDER]);
	const extra: Record<string, string> = {};
	for (const [key, value] of fields) {
		if (!known.has(key)) extra[key] = value;
	}
	if (Object.keys(extra).length > 0) entry.extra = extra;

	return { entry, problems };
}

function parseList(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	const items = value
		.split(",")
		.map((item) => item.trim())
		.filter((item) => item !== "");
	return items.length > 0 ? items : undefined;
}

/**
 * The claims of an entry, with their addresses.
 *
 * An entry with no bullets has exactly one implicit claim: its prose.
 */
export function claimsOf(entry: JournalEntry): Array<{ id: string; text: string; implicit: boolean }> {
	if (entry.claims.length === 0) {
		return entry.prose === "" ? [] : [{ id: `${entry.id}.1`, text: entry.prose, implicit: true }];
	}
	return entry.claims.map((text, index) => ({ id: `${entry.id}.${index + 1}`, text, implicit: false }));
}

/** Local `HH:MM`, as written in a heading. */
export function formatTime(date: Date): string {
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Local `YYYY-MM-DD`, the daily file's name. */
export function formatDate(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
