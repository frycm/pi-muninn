/** `journal_note` — sequential agent-authored project-journal append. */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { isEntryId } from "../ids.ts";
import type { NewJournalRecord } from "../journal/record.ts";
import { type JournalToolRuntime, requireJournalSession, throwIfAborted } from "./journal-runtime.ts";

export const JOURNAL_NOTE_PARAMETERS = Type.Object({
	text: Type.String({
		minLength: 1,
		maxLength: 32000,
		description: "A bounded, self-contained observation to append.",
	}),
	cue: Type.Optional(Type.String({ maxLength: 2000, description: "When a future session may need this evidence." })),
	tags: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 20 })),
	paths: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 50 })),
	relations: Type.Optional(
		Type.Array(
			Type.Object({
				type: Type.Literal("annotates"),
				target: Type.String({ description: "A full j-UUIDv7. Models may annotate but cannot correct or supersede." }),
			}),
			{ maxItems: 20 },
		),
	),
});

export type JournalNoteParams = Static<typeof JOURNAL_NOTE_PARAMETERS>;

export const JOURNAL_NOTE_DESCRIPTION = [
	"Append one agent-authored note to this logical project's journal.",
	"Use it for durable evidence useful to later sessions, not conversation recap.",
	"It always writes source: agent and cannot create user corrections or supersede records.",
].join(" ");

export function journalNoteTool(runtime: JournalToolRuntime) {
	return defineTool({
		name: "journal_note",
		label: "Append project journal note",
		description: JOURNAL_NOTE_DESCRIPTION,
		promptSnippet: "journal_note: append an agent-authored observation to project history",
		parameters: JOURNAL_NOTE_PARAMETERS,
		executionMode: "sequential",
		async execute(_id, params: JournalNoteParams, signal, _onUpdate, context) {
			throwIfAborted(signal);
			requireJournalSession(runtime);
			if (params.text.trim() === "") throw new Error("muninn: journal_note needs text");
			for (const relation of params.relations ?? []) {
				if (!isEntryId(relation.target))
					throw new Error(`muninn: journal_note received an invalid relation target: ${relation.target}`);
			}
			const state = runtime.state();
			const record: NewJournalRecord = {
				type: "note",
				source: "agent",
				channel: "sdk",
				body: params.text,
				tags: params.tags ?? [],
				paths: params.paths ?? [],
				relations: params.relations ?? [],
				...(params.cue?.trim() ? { cue: params.cue.trim() } : {}),
				...(state ? { task: state.task } : {}),
				...(state?.continues ? { continues: state.continues } : {}),
			};
			const written = await runtime.append(record, context as never);
			throwIfAborted(signal);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							schema: 1,
							id: written.id,
							shard: written.shard,
							redacted: written.record.redacted === true,
							source: written.record.source,
						}),
					},
				],
				details: { id: written.id, shard: written.shard },
			};
		},
	});
}
