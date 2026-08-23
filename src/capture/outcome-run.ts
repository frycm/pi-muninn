/**
 * Calling the model for an outcome entry.
 *
 * Separated from `outcome.ts` so the template, the parse and the echo rules
 * stay testable without a model, and so this file holds only the part that
 * talks to one.
 */
import type { NewJournalEntry } from "../journal/append.ts";
import type { Channel } from "./cues.ts";
import {
	buildOutcomePrompt,
	OUTCOME_SYSTEM_PROMPT,
	type OutcomeRequest,
	outcomeEntry,
	parseOutcome,
} from "./outcome.ts";

/** The slice of pi's model registry this needs, so tests can supply their own. */
export interface OutcomeModel {
	complete(context: { systemPrompt?: string; messages: unknown[] }, signal?: AbortSignal): Promise<string>;
}

export interface RunOutcomeOptions {
	request: OutcomeRequest;
	model: OutcomeModel;
	channel: Channel;
	session?: string | undefined;
	signal?: AbortSignal | undefined;
}

export type OutcomeResult = { ok: true; entry: NewJournalEntry } | { ok: false; problem: string };

/**
 * Ask the model for an outcome entry, once, with one retry on a bad parse.
 *
 * The retry appends the parse error, which is far more likely to help than
 * asking the same question again. After that the reply is dropped: an
 * unreadable entry in an append-only journal is a burden on every reader
 * forever, and the run is still in pi's session file if a human wants it.
 */
export async function runOutcome(options: RunOutcomeOptions): Promise<OutcomeResult> {
	const prompt = buildOutcomePrompt(options.request);

	let lastProblem = "";
	for (let attempt = 0; attempt < 2; attempt++) {
		const messages =
			attempt === 0
				? [{ role: "user", content: prompt }]
				: [
						{ role: "user", content: prompt },
						{
							role: "user",
							content: `Your previous reply could not be parsed: ${lastProblem}. Reply again in exactly the required format, and nothing else.`,
						},
					];

		let reply: string;
		try {
			reply = await options.model.complete({ systemPrompt: OUTCOME_SYSTEM_PROMPT, messages }, options.signal);
		} catch (error) {
			// An aborted call is the session ending, not a failure worth reporting
			// as broken memory.
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, problem: `model call failed: ${message}` };
		}

		const parsed = parseOutcome(reply);
		if (parsed.ok) {
			// A run where nothing durable was learned is a legitimate outcome, and
			// the template says so. An entry with no claims carries no evidence, so
			// there is nothing to write.
			if (parsed.outcome.claims.length === 0) {
				return { ok: false, problem: "the model reported nothing durable to remember" };
			}
			return {
				ok: true,
				entry: outcomeEntry(parsed.outcome, options.request, {
					channel: options.channel,
					session: options.session,
				}),
			};
		}
		lastProblem = parsed.error.problem;
	}

	return { ok: false, problem: `unparsable after one retry: ${lastProblem}` };
}
