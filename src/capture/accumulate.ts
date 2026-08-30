/**
 * The run buffer: what happened between the user's prompt and the agent
 * settling.
 *
 * pi's `agent_settled` carries no payload (`core/extensions/types.ts:724`), so
 * the run has to be assembled from the events that do carry one. `turn_end`
 * gives each turn as it finishes; `agent_end` gives the whole run's messages
 * and is treated as authoritative when it arrives, because it is pi's own view
 * rather than one reconstructed from parts.
 *
 * Journal content is not injected into runs. If the model searches the journal,
 * the resulting tool call and bounded result are ordinary, visible evidence in
 * this buffer.
 */
import { estimateTokens } from "../tokens.ts";

export interface RunMessage {
	role: string;
	text: string;
	/** Names of tools called in this message. */
	toolCalls: string[];
}

export interface RunBuffer {
	messages: RunMessage[];
	toolCallCount: number;
	turnCount: number;
}

interface MessageLike {
	role?: unknown;
	content?: unknown;
	output?: unknown;
	command?: unknown;
	summary?: unknown;
}

/** Flatten a message's visible text. Thinking is excluded; the user never saw it. */
export function messageText(message: MessageLike): string {
	if (typeof message.content === "string") return message.content;

	if (Array.isArray(message.content)) {
		const parts: string[] = [];
		for (const block of message.content) {
			if (typeof block !== "object" || block === null) continue;
			const typed = block as { type?: unknown; text?: unknown };
			if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
		}
		return parts.join("\n");
	}

	// bashExecution and the summary messages carry their text elsewhere.
	if (typeof message.output === "string") {
		const command = typeof message.command === "string" ? `$ ${message.command}\n` : "";
		return `${command}${message.output}`;
	}
	if (typeof message.summary === "string") return message.summary;
	return "";
}

/** How much of one tool argument to show. Enough to identify it, not to reproduce it. */
const MAX_ARG_CHARS = 120;

function renderArguments(args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	const parts: string[] = [];
	for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
		const rendered = typeof value === "string" ? value : JSON.stringify(value);
		if (rendered === undefined) continue;
		const short = rendered.length > MAX_ARG_CHARS ? `${rendered.slice(0, MAX_ARG_CHARS)}…` : rendered;
		parts.push(`${key}: ${short}`);
	}
	return parts.join(", ");
}

/**
 * Tool calls, rendered as `read(path: README.md)`.
 *
 * The arguments matter as much as the name. "The agent called read" tells a
 * future session nothing; "the agent read README.md" — or which command it ran,
 * or which file it edited — is the durable detail an outcome entry is for.
 * Values are truncated because a `write` call carries a whole file.
 */
function toolCallsOf(message: MessageLike): string[] {
	if (!Array.isArray(message.content)) return [];
	const calls: string[] = [];
	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		const typed = block as { type?: unknown; name?: unknown; toolName?: unknown; arguments?: unknown };
		if (typed.type !== "toolCall") continue;
		const rawName = typeof typed.name === "string" ? typed.name : typed.toolName;
		const name = typeof rawName === "string" ? rawName : "tool";
		const args = renderArguments(typed.arguments);
		calls.push(args === "" ? name : `${name}(${args})`);
	}
	return calls;
}

function convert(message: unknown): RunMessage | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const typed = message as MessageLike;

	const text = messageText(typed).trim();
	const toolCalls = toolCallsOf(typed);
	if (text === "" && toolCalls.length === 0) return undefined;
	return { role: typeof typed.role === "string" ? typed.role : "unknown", text, toolCalls };
}

/**
 * Collects one run.
 *
 * Turns accumulate as they finish so that a run cut short — by compaction, or
 * by the process going away — still has everything up to that point.
 */
export class RunAccumulator {
	private messages: RunMessage[] = [];
	private turns = 0;
	/** Set once `agent_end` has spoken, so later turn_ends do not re-append. */
	private sealed = false;

	get isEmpty(): boolean {
		return this.messages.length === 0;
	}

	/**
	 * Whether pi's authoritative `agent_end` payload arrived for this run.
	 *
	 * This is the measurement the plan wants: a run assembled only from
	 * `turn_end` is the fragile path, and how often that happens is what decides
	 * whether a turn-summary payload on `agent_settled` is worth asking pi for.
	 * If this is never false in practice, the accumulation approach is adequate
	 * and the core change is an ergonomics ask, not a gap.
	 */
	get hadAuthoritativeEnd(): boolean {
		return this.sealed;
	}

	/** One finished turn: the assistant's message and the results of its tools. */
	onTurnEnd(message: unknown, toolResults: readonly unknown[]): void {
		if (this.sealed) return;
		this.turns++;
		for (const candidate of [message, ...toolResults]) {
			const run = convert(candidate);
			if (run) this.messages.push(run);
		}
	}

	/**
	 * pi's own view of the run. Replaces whatever was accumulated: where the two
	 * disagree, pi is right.
	 */
	onAgentEnd(messages: readonly unknown[]): void {
		const replaced: RunMessage[] = [];
		for (const candidate of messages) {
			const run = convert(candidate);
			if (run) replaced.push(run);
		}
		this.messages = replaced;
		this.turns = Math.max(this.turns, replaced.filter((message) => message.role === "assistant").length);
		this.sealed = true;
	}

	/** The run so far, without clearing it. */
	peek(): RunBuffer {
		return {
			messages: [...this.messages],
			toolCallCount: this.messages.reduce((total, message) => total + message.toolCalls.length, 0),
			turnCount: this.turns,
		};
	}

	/** The run, and start a fresh one. */
	take(): RunBuffer {
		const buffer = this.peek();
		this.reset();
		return buffer;
	}

	reset(): void {
		this.messages = [];
		this.turns = 0;
		this.sealed = false;
	}
}

// ---------------------------------------------------------------------------
// Rendering a run for the outcome model
// ---------------------------------------------------------------------------

// The same approximation every budget in Muninn uses; re-exported here because
// this is where the run transcript is trimmed to fit one.
export { estimateTokens };

const MAX_MESSAGE_CHARS = 4_000;

function renderMessage(message: RunMessage): string {
	const tools = message.toolCalls.length > 0 ? ` [called: ${message.toolCalls.join(", ")}]` : "";
	const text =
		message.text.length > MAX_MESSAGE_CHARS
			? `${message.text.slice(0, MAX_MESSAGE_CHARS)}\n… (truncated)`
			: message.text;
	return `## ${message.role}${tools}\n${text}`.trim();
}

/**
 * Render the run for the outcome model, newest first under a token budget.
 *
 * The tail of a run is what its outcome is about — what was tried last, what
 * finally worked or failed. Dropping the oldest turns keeps that, and saying
 * how many were dropped keeps the model from treating a partial run as whole.
 */
export function renderRun(buffer: RunBuffer, tokenBudget: number): string {
	const rendered = buffer.messages.map(renderMessage);
	const kept: string[] = [];
	let used = 0;

	for (let index = rendered.length - 1; index >= 0; index--) {
		const block = rendered[index] as string;
		const cost = estimateTokens(block);
		if (used + cost > tokenBudget && kept.length > 0) {
			kept.unshift(`… ${index + 1} earlier message(s) omitted`);
			break;
		}
		kept.unshift(block);
		used += cost;
	}

	return kept.join("\n\n");
}
