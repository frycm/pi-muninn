/**
 * `memory_note` — the only tool that writes.
 *
 * It appends one journal entry and nothing else. It cannot touch `topics/`,
 * `rules.md` or `MEMORY.md`: those are derived, a dream rewrites them from
 * evidence, and a model editing them directly would be writing conclusions
 * with no journal entry underneath. Everything this tool writes carries
 * `source: agent`, so a later dream can weigh it — or discount the whole class
 * — knowing it was the model's own inference rather than something the user
 * said.
 *
 * A failed write fails the tool call, loudly and by name. Falling back to
 * another scope would leave the model believing a memory exists somewhere it
 * does not.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { bodyFromUserText, channelForMode } from "../capture/cues.ts";
import { sessionPointer } from "../capture/session-state.ts";
import type { NewJournalEntry } from "../journal/append.ts";
import { PHASES } from "../journal/format.ts";
import { requireSession, resolveWriteScope, type ToolRuntime } from "./runtime.ts";

export const MEMORY_NOTE_PARAMETERS = Type.Object({
	text: Type.String({
		description:
			"What to remember. Every line starting with '- ' becomes its own claim; anything else is context around them. Text with no bullets is taken as one claim.",
	}),
	phase: Type.Optional(
		Type.Union(
			PHASES.map((phase) => Type.Literal(phase)),
			{ description: "The step of the coding loop this belongs to. Retrieval filters by it." },
		),
	),
	cue: Type.Optional(
		Type.String({
			description:
				"When would a future session need this? A short situation, such as 'when vitest hangs in CI'. Indexed heavily — it is how memory is found by situation rather than by keyword.",
		}),
	),
	scope: Type.Optional(
		Type.Union([Type.Literal("global"), Type.Literal("project")], {
			description:
				"Which store to write to. Default: this session's capture target — the project store when one is active, otherwise global.",
		}),
	),
});

export type MemoryNoteParams = Static<typeof MEMORY_NOTE_PARAMETERS>;

export const MEMORY_NOTE_DESCRIPTION = [
	"Record something durable in long-term memory, as a journal entry attributed to you.",
	"Write what a future session would need to know — commands, constraints, causes, dead ends — not what happened in this conversation.",
	"One entry per call. It cannot edit or delete anything: the journal is append-only, and consolidation happens later.",
].join(" ");

export function memoryNoteTool(runtime: ToolRuntime) {
	return defineTool({
		name: "memory_note",
		label: "Note to memory",
		description: MEMORY_NOTE_DESCRIPTION,
		promptSnippet: "memory_note: record something durable in long-term memory",
		parameters: MEMORY_NOTE_PARAMETERS,
		// The append takes the store lock, so two of these would serialise
		// anyway; saying so keeps them in the order the model asked for.
		executionMode: "sequential",
		async execute(_id, params: MemoryNoteParams, _signal, _onUpdate, ctx) {
			const session = requireSession(runtime);
			const scope = resolveWriteScope(session, params.scope);

			const body = bodyFromUserText(params.text);
			if (body.claims.length === 0 && body.prose === "") throw new Error("muninn: memory_note needs some text");

			const state = runtime.state();
			const entry: NewJournalEntry = {
				source: "agent",
				channel: channelForMode(ctx.mode),
				phase: params.phase ?? "other",
				prose: body.prose,
				claims: body.claims,
			};
			if (params.cue !== undefined && params.cue.trim() !== "") entry.cue = params.cue.trim();
			if (state) {
				entry.task = state.task;
				if (state.continues) entry.continues = state.continues;
				// What Muninn had already put in the model's context when this note
				// was written. A claim that restates one of them is an echo, and the
				// dream that reads this entry needs to be able to tell.
				if (state.recalled.length > 0) entry.recalled = [...state.recalled];
			}
			const pointer = sessionPointer(ctx.sessionManager);
			if (pointer) entry.session = pointer;

			const written = await runtime.append(scope, entry);
			const claims = written.claimIds.map((id) => `  ${id}`);
			return {
				content: [
					{
						type: "text" as const,
						text: [
							`Remembered in the ${scope} store as ${written.id}${entry.redacted ? " (secrets redacted)" : ""}.`,
							...(claims.length > 0 ? ["", "Claims:", ...claims] : []),
						].join("\n"),
					},
				],
				details: { id: written.id, claimIds: written.claimIds, scope },
			};
		},
	});
}
