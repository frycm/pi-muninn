/** User-friendly memory operations; context and authority are supplied by the extension. */
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { RememberResult } from "../memory/remember.ts";
import type { RecallInput, RecallResult } from "../recall/recall.ts";
import { jsonToolResult, throwIfAborted } from "./journal-runtime.ts";

export interface MemoryToolRuntime {
	remember(context: ExtensionContext, focus?: string, signal?: AbortSignal): Promise<RememberResult>;
	recall(context: ExtensionContext, input: RecallInput, signal?: AbortSignal): Promise<RecallResult>;
}
const REMEMBER_PARAMETERS = Type.Object({
	focus: Type.Optional(
		Type.String({ maxLength: 2000, description: "Optional issue or lessons to distill from this session branch." }),
	),
});
const RECALL_PARAMETERS = Type.Object({
	query: Type.String({
		minLength: 1,
		maxLength: 4096,
		description: "Current task, symptom or exact error to find prior solutions for.",
	}),
	path: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 20 })),
	branch: Type.Optional(Type.Array(Type.String({ maxLength: 512 }), { maxItems: 20 })),
});

export function journalRememberTool(runtime: MemoryToolRuntime) {
	return defineTool({
		name: "journal_remember",
		label: "Remember session lessons",
		description:
			"Ask the selected memory model to distill supported solutions, failed approaches and durable lessons from the current session branch. Writes agent evidence, never user instructions. Does not accept arbitrary transcript paths.",
		promptSnippet: "journal_remember: distill relevant lessons from this session with the selected memory model",
		promptGuidelines: [
			"When asked to remember what was done in this session or how an issue was solved, use journal_remember with an optional focus. Use journal_note for a specific agent observation.",
		],
		parameters: REMEMBER_PARAMETERS,
		executionMode: "sequential",
		async execute(_id, params: Static<typeof REMEMBER_PARAMETERS>, signal, _update, context) {
			throwIfAborted(signal);
			return jsonToolResult(await runtime.remember(context, params.focus, signal));
		},
	});
}

export function journalRecallTool(runtime: MemoryToolRuntime) {
	return defineTool({
		name: "journal_recall",
		label: "Recall relevant solutions",
		description:
			"Search project history and use the selected memory model to choose relevant evidence for this task/error. Returns canonical records and corrections under a hard budget. History is fallible; verify applicability against current code. An unavailable result is not proof no relevant history exists.",
		promptSnippet: "journal_recall: find and load relevant past solutions and their corrections",
		parameters: RECALL_PARAMETERS,
		executionMode: "parallel",
		async execute(_id, params: Static<typeof RECALL_PARAMETERS>, signal, _update, context) {
			throwIfAborted(signal);
			return jsonToolResult(await runtime.recall(context, params, signal));
		},
	});
}
