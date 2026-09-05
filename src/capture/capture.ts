/**
 * Turning a classified user turn into a journal entry.
 *
 * Kept apart from `index.ts` so the decision — what gets written, to which
 * scope, with what provenance — is testable without a pi session.
 */
import type { JournalSessionPointer, NewJournalRecord } from "../journal/record.ts";
import type { MuninnSettings } from "../settings.ts";
import {
	bodyFromUserText,
	type Channel,
	type CueMatch,
	detectCorrection,
	detectExplicit,
	isRememberRequest,
} from "./cues.ts";
import type { MuninnSessionState } from "./session-state.ts";

export type CaptureKind = "explicit" | "correction";

export interface CaptureDecision {
	kind: CaptureKind;
	reason: string;
	entry: NewJournalRecord;
}

export interface CaptureInput {
	text: string;
	/** pi's `InputSource`. Only text the user actually typed is `source: user`. */
	inputSource: string;
	channel: Channel;
	previousAssistantText?: string | undefined;
	state: MuninnSessionState;
	settings: MuninnSettings;
	/** `<session file>#<leaf entry id>`, the evidence pointer. */
	session?: string | undefined;
}

/** How much of the agent's last turn to quote back in a correction entry. */
const QUOTE_LIMIT = 400;

function truncate(text: string, limit: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

/**
 * Decide whether a user turn is journaled, and as what.
 *
 * Returns `undefined` for the overwhelming majority of turns. Capture writes
 * far fewer entries than a transcript has turns, by design.
 */
export function decideCapture(input: CaptureInput): CaptureDecision | undefined {
	// Only text the user actually typed carries `source: user`. Input an
	// extension synthesised is the model's own work arriving by another route,
	// and treating it as the user's assertion would launder provenance — the
	// same rule pi-enclave uses for authorization.
	if (input.inputSource !== "interactive" && input.inputSource !== "rpc") return undefined;

	const text = input.text.trim();
	if (text === "") return undefined;
	// A slash command is handled by its own handler; classifying its text as
	// prose would journal the command line itself.
	if (text.startsWith("/")) return undefined;
	if (isRememberRequest(text)) return undefined;

	const explicit = detectExplicit(text);
	if (explicit.matched) return explicitEntry(text, explicit, input);

	if (!input.settings.capture.corrections) return undefined;
	const correction = detectCorrection({ text, previousAssistantText: input.previousAssistantText });
	if (correction.matched) return correctionEntry(text, correction, input);

	return undefined;
}

function sessionPointer(pointer: string | undefined): JournalSessionPointer | undefined {
	if (!pointer) return undefined;
	const hash = pointer.lastIndexOf("#");
	if (hash === -1) return { file: pointer };
	const last = pointer.slice(hash + 1);
	return { file: pointer.slice(0, hash), ...(last ? { last } : {}) };
}

function baseEntry(input: CaptureInput): NewJournalRecord {
	const entry: NewJournalRecord = {
		type: "note",
		source: "user",
		channel: input.channel,
		task: input.state.task,
		body: "",
		tags: [],
		paths: [],
		relations: [],
	};
	if (input.state.continues) entry.continues = input.state.continues;
	const pointer = sessionPointer(input.session);
	if (pointer) entry.session = pointer;
	return entry;
}

function explicitEntry(text: string, match: CueMatch, input: CaptureInput): CaptureDecision {
	const body = bodyFromUserText(text);
	return {
		kind: "explicit",
		reason: match.reason ?? "explicit",
		entry: {
			...baseEntry(input),
			body: [body.prose, ...body.claims.map((claim) => `- ${claim}`)].filter(Boolean).join("\n"),
		},
	};
}

function correctionEntry(text: string, match: CueMatch, input: CaptureInput): CaptureDecision {
	const body = bodyFromUserText(text);
	// The agent's last turn is quoted as *context*, never as a claim: it is the
	// thing being contradicted, so recording it as evidence would preserve
	// exactly the belief the user just rejected.
	const quoted = input.previousAssistantText ? truncate(input.previousAssistantText, QUOTE_LIMIT) : "";
	const prose = [quoted === "" ? "" : `The agent had said: "${quoted}"`, body.prose]
		.filter((part) => part !== "")
		.join("\n\n");

	return {
		kind: "correction",
		reason: match.reason ?? "correction",
		// Free-form correction cues have no stable target record ID. Preserve them
		// as user notes tagged for retrieval; only explicit correct commands create
		// semantic `corrects` relations.
		entry: {
			...baseEntry(input),
			body: [prose, ...body.claims.map((claim) => `- ${claim}`)].filter(Boolean).join("\n"),
			tags: ["correction"],
		},
	};
}
