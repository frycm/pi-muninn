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
 * Muninn's own injected messages are stripped here rather than downstream. The
 * outcome model must never see them: a fact Muninn recalled, restated by the
 * model, and then journaled as a fresh observation would corroborate itself —
 * recalled, restated, observed again next session, promoted on `use_count`.
 * That loop is designed out at the only point where it could start.
 */

/** The `customType` Muninn injects recalled memories under. */
export const MUNINN_MESSAGE_TYPE = "muninn";

export interface RunMessage {
	role: string;
	text: string;
	/** Names of tools called in this message. */
	toolCalls: string[];
}

export interface RunBuffer {
	messages: RunMessage[];
	/** Ids of Muninn memories that were in the model's context during this run. */
	recalled: string[];
	toolCallCount: number;
	turnCount: number;
}

interface MessageLike {
	role?: unknown;
	customType?: unknown;
	content?: unknown;
	details?: unknown;
	output?: unknown;
	command?: unknown;
	summary?: unknown;
}

function isMuninnMessage(message: MessageLike): boolean {
	return message.role === "custom" && message.customType === MUNINN_MESSAGE_TYPE;
}

/** Ids a Muninn message declares it injected, so they can go to `recalled:`. */
function recalledIdsOf(message: MessageLike): string[] {
	const details = message.details;
	if (typeof details !== "object" || details === null) return [];
	const ids = (details as { ids?: unknown }).ids;
	if (!Array.isArray(ids)) return [];
	return ids.filter((id): id is string => typeof id === "string");
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

function convert(message: unknown): { run?: RunMessage; recalled: string[] } {
	if (typeof message !== "object" || message === null) return { recalled: [] };
	const typed = message as MessageLike;

	if (isMuninnMessage(typed)) return { recalled: recalledIdsOf(typed) };

	const text = messageText(typed).trim();
	const toolCalls = toolCallsOf(typed);
	if (text === "" && toolCalls.length === 0) return { recalled: [] };

	return {
		run: { role: typeof typed.role === "string" ? typed.role : "unknown", text, toolCalls },
		recalled: [],
	};
}

/**
 * Collects one run.
 *
 * Turns accumulate as they finish so that a run cut short — by compaction, or
 * by the process going away — still has everything up to that point.
 */
export class RunAccumulator {
	private messages: RunMessage[] = [];
	private readonly recalled = new Set<string>();
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
			const { run, recalled } = convert(candidate);
			if (run) this.messages.push(run);
			for (const id of recalled) this.recalled.add(id);
		}
	}

	/**
	 * pi's own view of the run. Replaces whatever was accumulated: where the two
	 * disagree, pi is right.
	 */
	onAgentEnd(messages: readonly unknown[]): void {
		const replaced: RunMessage[] = [];
		for (const candidate of messages) {
			const { run, recalled } = convert(candidate);
			if (run) replaced.push(run);
			for (const id of recalled) this.recalled.add(id);
		}
		this.messages = replaced;
		this.turns = Math.max(this.turns, replaced.filter((message) => message.role === "assistant").length);
		this.sealed = true;
	}

	/** The run so far, without clearing it. */
	peek(): RunBuffer {
		return {
			messages: [...this.messages],
			recalled: [...this.recalled],
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
		this.recalled.clear();
		this.turns = 0;
		this.sealed = false;
	}
}

// ---------------------------------------------------------------------------
// Rendering a run for the outcome model
// ---------------------------------------------------------------------------

/** Rough token estimate. Four characters per token is close enough to budget by. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

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
