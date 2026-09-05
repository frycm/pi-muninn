/**
 * Deciding whether a user turn is worth a journal entry.
 *
 * Capture is selective by construction: it writes far fewer entries than a
 * transcript has turns. The research on auto-capture noise is unambiguous that
 * "remember everything" produces a store nobody trusts, so both classifiers
 * here are built for **precision over recall**. A missed correction is caught
 * later by the outcome entry; a false positive is noise in the journal for
 * good, because the journal is append-only.
 *
 * Both are rule-based and run on every user turn, so they must also be cheap —
 * no model call, no allocation worth measuring.
 */

export type Channel = "tui" | "rpc" | "sdk" | "hook";

/**
 * How the turn reached Muninn, from pi's own run mode.
 *
 * The plan suggested inferring this from `ctx.hasUI`, but pi states it
 * directly: `json` and `print` are headless runs, which is what `sdk` means.
 */
export function channelForMode(mode: string): Channel {
	if (mode === "tui") return "tui";
	if (mode === "rpc") return "rpc";
	return "sdk";
}

export interface CueMatch {
	matched: boolean;
	/** Which rule fired, for tests and for `/muninn` diagnostics. */
	reason?: string;
}

const NO_MATCH: CueMatch = { matched: false };

/** A request to distill work, rather than a literal fact to store verbatim. */
export function isRememberRequest(text: string): boolean {
	return /^(?:please\s+)?(?:remember|summari[sz]e|save)\s+(?:(?:what|how)\s+(?:we|you|this session)\b|(?:this|our|the|current)\s+session\b|(?:the\s+)?(?:solution|fix|lessons?)\s+(?:from|for|we)\b)/i.test(
		text.trim(),
	);
}

/**
 * Offsets where a sentence begins. Cues only count at one of these — that
 * anchoring is where most of the precision comes from.
 */
function sentenceStarts(text: string): number[] {
	const starts = [0];
	for (const match of text.matchAll(/(?:[.!?]+\s+|\n+)/g)) {
		starts.push(match.index + match[0].length);
	}
	return starts.filter((start) => start < text.length);
}

function wordCount(text: string): number {
	return text.split(/\s+/).filter((word) => /[a-z0-9]/i.test(word)).length;
}

// ---------------------------------------------------------------------------
// Explicit: the user asking for something to be remembered
// ---------------------------------------------------------------------------

interface ExplicitRule {
	name: string;
	pattern: RegExp;
	/** Minimum words after the cue, so a bare "Always?" is not a directive. */
	minWords?: number;
	/**
	 * Where those words are counted.
	 *
	 * `message` for cues that lead in to content that follows — "Remember this:"
	 * is a directive whose own sentence is two words long, with the substance in
	 * the bullets beneath it.
	 *
	 * `sentence` for cues that are self-contained. It is what separates the
	 * directive "Always run the tests" from the aside "Always fun. Anyway, does
	 * the build still pass?", where the words after the cue belong to a
	 * different thought entirely.
	 */
	scope?: "sentence" | "message";
}

/**
 * Anchored at the start of a sentence, which is most of the precision.
 * "I don't remember", "do you remember", "I remember it differently" all begin
 * with something else and never reach these rules.
 */
const EXPLICIT_RULES: ExplicitRule[] = [
	{ name: "remember", pattern: /^(?:please\s+)?remember\b(?!\s+(?:when|that\s+time))/i, minWords: 2, scope: "message" },
	{ name: "note", pattern: /^(?:please\s+)?(?:note|make\s+a\s+note)\b(?=\s|:)/i, minWords: 2, scope: "message" },
	{ name: "from-now-on", pattern: /^from\s+now\s+on\b/i, minWords: 2 },
	{ name: "going-forward", pattern: /^going\s+forward\b/i, minWords: 2 },
	{ name: "keep-in-mind", pattern: /^(?:please\s+)?keep\s+in\s+mind\b/i, minWords: 2, scope: "message" },
	{ name: "dont-forget", pattern: /^(?:please\s+)?don'?t\s+forget\b/i, minWords: 2 },
	{ name: "for-future-reference", pattern: /^for\s+(?:future|later)\s+reference\b/i, minWords: 2 },
	{ name: "always", pattern: /^always\b/i, minWords: 3 },
	{ name: "never", pattern: /^never\b(?!\s+mind)/i, minWords: 3 },
];

/**
 * True when the user is asking for something to be kept.
 *
 * `/muninn note` does not come through here — a command is an explicit request
 * already and is journaled directly by its handler.
 */
export function detectExplicit(text: string): CueMatch {
	const starts = sentenceStarts(text);
	for (let index = 0; index < starts.length; index++) {
		const start = starts[index] as number;
		const rest = text.slice(start);
		const sentenceEnd = starts[index + 1] ?? text.length;
		const sentence = text.slice(start, sentenceEnd);

		for (const rule of EXPLICIT_RULES) {
			const match = rest.match(rule.pattern);
			if (!match) continue;
			const scoped = rule.scope === "message" ? rest : sentence;
			if (wordCount(scoped.slice(match[0].length)) < (rule.minWords ?? 0)) continue;
			return { matched: true, reason: rule.name };
		}
	}
	return NO_MATCH;
}

// ---------------------------------------------------------------------------
// Corrections: the user contradicting what just happened
// ---------------------------------------------------------------------------

/**
 * A contrast or negation marker, at the start of the turn.
 *
 * Bare leading "not" is deliberately absent: "not sure what's going on" is a
 * question, not a correction, and admitting it would cost more in false
 * positives than the cases it would catch.
 */
const CONTRAST_MARKERS: Array<{ name: string; pattern: RegExp }> = [
	{ name: "no", pattern: /^(?:no|nope|nah)\b/i },
	{ name: "dont", pattern: /^(?:don'?t|do\s+not|stop|please\s+don'?t)\b/i },
	{ name: "actually", pattern: /^actually\b/i },
	{ name: "instead", pattern: /^instead\b/i },
	{ name: "wrong", pattern: /^(?:wrong|that'?s\s+wrong|that'?s\s+not|it'?s\s+not|incorrect|not\s+quite)\b/i },
	{ name: "undo", pattern: /^(?:undo|revert|roll\s+back)\b/i },
	{ name: "wait", pattern: /^wait[,.!\s]/i },
];

/**
 * Words too common to count as evidence that the user meant the last turn.
 *
 * The token floor is three characters, not four, because the words that
 * actually identify a subject in a coding session are often exactly three —
 * `npm`, `git`, `ssh`, `api`, `env`. That admits a lot of ordinary English at
 * the same length, which is what this list is for.
 */
const STOP_WORDS = new Set([
	// three letters
	"the",
	"and",
	"for",
	"you",
	"not",
	"but",
	"can",
	"was",
	"are",
	"its",
	"all",
	"any",
	"has",
	"had",
	"her",
	"him",
	"his",
	"our",
	"out",
	"own",
	"see",
	"she",
	"too",
	"two",
	"way",
	"who",
	"why",
	"yes",
	"yet",
	"run",
	"add",
	"use",
	"get",
	"set",
	"new",
	"one",
	"let",
	"put",
	"now",
	"how",
	"did",
	"***",
	// four and up
	"that",
	"this",
	"they",
	"them",
	"then",
	"with",
	"from",
	"have",
	"here",
	"there",
	"what",
	"when",
	"will",
	"your",
	"just",
	"like",
	"only",
	"some",
	"than",
	"into",
	"file",
	"code",
	"work",
	"need",
	"want",
	"make",
	"does",
	"doesn",
	"should",
	"would",
	"could",
	"were",
	"been",
	"also",
	"back",
	"even",
	"more",
	"most",
	"much",
	"over",
	"same",
	"such",
	"take",
	"them",
	"very",
	"well",
	"went",
	"were",
	"will",
	"with",
	"about",
	"after",
	"again",
	"still",
]);

const REFERENTIAL = /\b(?:that|this|it|its|you|your|those|these)\b/i;

function contentTokens(text: string): Set<string> {
	const tokens = new Set<string>();
	for (const raw of text.toLowerCase().split(/[^a-z0-9_.-]+/)) {
		const token = raw.replace(/^[.-]+|[.-]+$/g, "");
		if (token.length < 3) continue;
		if (STOP_WORDS.has(token)) continue;
		tokens.add(token);
	}
	return tokens;
}

export interface CorrectionInput {
	text: string;
	/**
	 * What the assistant last said, in plain text. Absent on the first turn —
	 * and with nothing to contradict, there is no correction to detect.
	 */
	previousAssistantText?: string | undefined;
}

/**
 * True when the user is contradicting what the agent just did or assumed.
 *
 * Requires **both** a contrast marker and evidence that the turn refers to the
 * previous one: a demonstrative ("no, don't do that") or a content word the
 * assistant just used ("no, use pnpm"). Either alone is too weak — "no" is an
 * ordinary answer to a question, and a turn that merely shares vocabulary with
 * the last one is just the conversation continuing.
 */
export function detectCorrection(input: CorrectionInput): CueMatch {
	const previous = input.previousAssistantText?.trim();
	if (!previous) return NO_MATCH;

	const text = input.text.trim();
	if (text === "") return NO_MATCH;

	const marker = CONTRAST_MARKERS.find((candidate) => candidate.pattern.test(text));
	if (!marker) return NO_MATCH;

	if (REFERENTIAL.test(text)) return { matched: true, reason: `${marker.name}+referential` };

	const previousTokens = contentTokens(previous);
	for (const token of contentTokens(text)) {
		if (previousTokens.has(token)) return { matched: true, reason: `${marker.name}+overlap:${token}` };
	}

	return NO_MATCH;
}

// ---------------------------------------------------------------------------
// Turning a user turn into an entry body
// ---------------------------------------------------------------------------

export interface EntryBody {
	prose: string;
	claims: string[];
}

/**
 * Split user text the way `/muninn note` does: every line starting with `- ` is
 * a claim, everything else is context. Text with no bullets becomes a single
 * claim, since the user's whole point is the claim in that case.
 */
export function bodyFromUserText(text: string): EntryBody {
	const lines = text.split("\n");
	const claims: string[] = [];
	const prose: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("- ")) claims.push(trimmed.slice(2).trim());
		else prose.push(line);
	}

	const proseText = prose
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (claims.length > 0) return { prose: proseText, claims };
	return { prose: "", claims: proseText === "" ? [] : [proseText] };
}
