/**
 * Reaching a model without a pi session.
 *
 * `muninn dream` runs from cron, and the design's whole point is that it can
 * run against a local endpoint while the session talks to something else. pi
 * exports `ModelRuntime` — the same runtime `ctx.modelRegistry` wraps — so the
 * headless path uses it directly rather than building an agent it does not
 * need. A local endpoint is an ordinary `models.json` provider, so nothing
 * Muninn-specific is needed to dream offline.
 *
 * pi is imported *lazily*, inside the function. `muninn sync` in cron must keep
 * starting in about a second and must keep working while a pi install is
 * half-upgraded; a top-level import here would put pi's whole module graph on
 * that path for a subcommand that never touches a model.
 */
import { type DreamModel, splitModelRef } from "./model.ts";

export interface HeadlessModelOptions {
	/** `dream.model`, as `provider/model`. */
	ref: string;
	agentDir: string;
}

export type ModelResolution = { ok: true; model: DreamModel } | { ok: false; problem: string };

/**
 * Build a `DreamModel` from pi's model runtime.
 *
 * Never throws: a missing model, an unloadable pi and a provider with no
 * credentials are all things an operator has to be told about in a sentence,
 * not a stack trace from a cron job.
 */
export async function headlessModel(options: HeadlessModelOptions): Promise<ModelResolution> {
	const ref = splitModelRef(options.ref);
	if (ref === undefined) {
		return { ok: false, problem: `dream.model must be "provider/model", not "${options.ref}"` };
	}

	let runtime: { getModel(provider: string, model: string): unknown; complete(...args: never[]): Promise<unknown> };
	try {
		const pi = (await import("@earendil-works/pi-coding-agent")) as {
			ModelRuntime: { create(options: Record<string, unknown>): Promise<typeof runtime> };
		};
		runtime = await pi.ModelRuntime.create({ authPath: `${options.agentDir}/auth.json` });
	} catch (error) {
		return {
			ok: false,
			problem:
				`could not load pi's model runtime (${error instanceof Error ? error.message : String(error)}); ` +
				"muninn dream needs pi installed, unlike muninn sync",
		};
	}

	const model = runtime.getModel(ref.provider, ref.model);
	if (model === undefined) {
		return {
			ok: false,
			problem: `no model "${options.ref}" — add it to models.json, or check the provider id (see pi's docs/models.md)`,
		};
	}

	return {
		ok: true,
		model: {
			id: options.ref,
			async complete(request, signal) {
				const context = {
					systemPrompt: request.systemPrompt,
					messages: [{ role: "user", content: request.prompt }],
				};
				const reply = (await runtime.complete(...([model, context, signal ? { signal } : {}] as never[]))) as {
					content?: unknown;
				};
				return messageText(reply);
			},
		},
	};
}

/**
 * The text of an assistant message, whatever shape it arrived in.
 *
 * The same flattening `capture/accumulate.ts` does, repeated rather than
 * imported because that one takes pi's message type and this one takes whatever
 * `complete` returned — and a cast into a type that then changes shape is how a
 * "flattened" reply silently becomes "[object Object]".
 */
function messageText(reply: { content?: unknown }): string {
	const content = reply.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : "",
		)
		.join("");
}
