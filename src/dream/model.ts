/**
 * The dreamer's model, as a port.
 *
 * The same shape as `OutcomeModel` in `capture/outcome-run.ts`, and for the
 * same reason: everything above this interface is pure and unit-testable, and
 * the one adapter that knows about pi lives where pi's context is. A dream that
 * consolidates nothing never touches it at all.
 *
 * `dream.model` selects the model. Unlike the outcome call — which reuses the
 * session's own model because it is a small job inside a session — a dream is a
 * long job over the whole store, and the design's point is that it can run
 * against a local endpoint while the session talks to something else.
 */
export interface DreamModel {
	/** A display id for the report: `provider/model`. */
	readonly id: string;
	complete(request: { systemPrompt: string; prompt: string }, signal?: AbortSignal): Promise<string>;
}

/** What a caller must supply to reach a model, and what went wrong if it cannot. */
export type ModelResolution = { ok: true; model: DreamModel } | { ok: false; problem: string };

/**
 * Split a `provider/model` setting.
 *
 * A model id may itself contain slashes (`ollama/qwen3.5:9b-instruct` is one
 * provider and one model, but `openrouter/qwen/qwen3-9b` is one provider and
 * `qwen/qwen3-9b`), so the split is on the *first* slash only.
 */
export function splitModelRef(ref: string): { provider: string; model: string } | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}
