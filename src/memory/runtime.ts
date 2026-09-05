/** Bounded calls through pi's authenticated model registry, independent of the coding model. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { messageText } from "../capture/accumulate.ts";
import { redact } from "../redact.ts";
import type { MuninnSettings } from "../settings.ts";
import { estimateTokens } from "../tokens.ts";

export type MemoryContext = Pick<ExtensionContext, "model" | "modelRegistry">;
export interface MemoryUsage {
	model: string;
	calls: number;
	input: number;
	output: number;
}

export interface MemoryCaller {
	readonly maxInputTokens: number;
	readonly signal: AbortSignal;
	json<T>(system: string, input: unknown, parse: (value: unknown) => T): Promise<T>;
}

export class MemoryOperation implements MemoryCaller {
	readonly signal: AbortSignal;
	readonly maxInputTokens: number;
	readonly usage: MemoryUsage;
	private readonly controller = new AbortController();
	private readonly model: NonNullable<ExtensionContext["model"]>;
	private readonly timer: ReturnType<typeof setTimeout>;
	private readonly abort: () => void;
	private repairs = 0;
	private readonly maxOutputTokens: number;

	constructor(
		private readonly ctx: MemoryContext,
		settings: MuninnSettings["memory"],
		private readonly parent?: AbortSignal,
	) {
		const selected = settings.model;
		const model = selected === "session" ? ctx.model : ctx.modelRegistry.find(selected.provider, selected.id);
		if (!model) throw new Error("muninn: memory model is unavailable; check memory.model and pi's model registry");
		this.model = model;
		this.usage = { model: `${model.provider}/${model.id}`, calls: 0, input: 0, output: 0 };
		this.maxOutputTokens = Math.min(settings.maxOutputTokens, model.maxTokens);
		this.maxInputTokens = Math.min(settings.maxInputTokens, model.contextWindow - this.maxOutputTokens - 512);
		if (this.maxInputTokens < 1500)
			throw new Error("muninn: memory model context window is too small for these budgets");
		this.signal = this.controller.signal;
		this.abort = () => this.controller.abort();
		parent?.addEventListener("abort", this.abort, { once: true });
		if (parent?.aborted) this.abort();
		this.timer = setTimeout(this.abort, settings.timeoutMs);
		this.timer.unref?.();
	}

	close(): void {
		clearTimeout(this.timer);
		this.parent?.removeEventListener("abort", this.abort);
	}

	async json<T>(system: string, input: unknown, parse: (value: unknown) => T): Promise<T> {
		// Errors intentionally never echo provider responses or model-generated text.
		let repair = "";
		for (;;) {
			if (this.usage.calls >= 8)
				throw new Error("muninn: memory operation reached its eight-call budget; retry remaining work explicitly");
			if (this.signal.aborted) throw new Error("muninn: memory operation cancelled or timed out");
			const prompt = redact(JSON.stringify(input)).text;
			const systemPrompt = `${system}${repair}`;
			if (estimateTokens(systemPrompt) + estimateTokens(prompt) > this.maxInputTokens) {
				throw new Error("muninn: memory input exceeds the selected model's budget");
			}
			let removeAbort: () => void = () => {};
			const abortPromise = new Promise<never>((_, reject) => {
				const onAbort = () => reject(new Error("muninn: memory operation cancelled or timed out"));
				this.signal.addEventListener("abort", onAbort, { once: true });
				removeAbort = () => this.signal.removeEventListener("abort", onAbort);
			});
			let reply: Awaited<ReturnType<ExtensionContext["modelRegistry"]["complete"]>>;
			try {
				this.usage.calls++;
				reply = await Promise.race([
					this.ctx.modelRegistry.complete(
						this.model,
						{
							systemPrompt,
							messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
						},
						{ signal: this.signal, maxTokens: this.maxOutputTokens },
					),
					abortPromise,
				]);
			} catch {
				throw new Error(
					this.signal.aborted
						? "muninn: memory operation cancelled or timed out"
						: "muninn: memory model request failed; check the selected model's authentication and availability",
				);
			} finally {
				removeAbort();
			}
			if (reply.stopReason === "error" || reply.stopReason === "aborted") {
				throw new Error("muninn: memory model request failed; check authentication and availability");
			}
			this.usage.input += reply.usage?.input ?? 0;
			this.usage.output += reply.usage?.output ?? 0;
			const text = messageText(reply).trim();
			try {
				if (text.length > this.maxOutputTokens * 8 || reply.stopReason === "length") throw new Error("oversized reply");
				return parse(JSON.parse(text.replace(/^```(?:json)?\s*\n/i, "").replace(/\n```$/, "")));
			} catch {
				if (this.repairs++ >= 1) throw new Error("muninn: invalid memory response after one format-repair retry");
				repair =
					"\nYour previous reply could not be parsed or contained invalid fields/references. Return only the required JSON, within the limits, with references from the supplied evidence.";
			}
		}
	}
}

export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !keys.includes(key))) throw new Error("unknown field");
	return record;
}

export function string(value: unknown, max = 2000): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("invalid text");
	return value.trim();
}

export function strings(value: unknown, maxItems = 10, maxChars = 2000): string[] {
	if (!Array.isArray(value) || value.length > maxItems) throw new Error("invalid list");
	return [...new Set(value.map((v) => string(v, maxChars)))];
}
