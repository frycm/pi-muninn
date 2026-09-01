/**
 * `memory_search` — the model's own way into the store.
 *
 * Journal content is never injected automatically. This tool is deliberately
 * thin: it does no reasoning, ranks nothing the index did not rank, and returns
 * ids the model can read in full.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { ChunkKind } from "../index/chunk.ts";
import { CHUNK_KINDS } from "../index/chunk.ts";
import type { SearchRequest } from "../index/search.ts";
import { PHASES } from "../journal/format.ts";
import { renderHitLine, renderHits } from "./render.ts";
import { requireSession, type ToolRuntime } from "./runtime.ts";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export const MEMORY_SEARCH_PARAMETERS = Type.Object({
	query: Type.String({
		description: "What to look for. Plain words; the index matches the claim text, its retrieval cue and its heading.",
	}),
	scope: Type.Optional(
		Type.Union([Type.Literal("global"), Type.Literal("project")], {
			description: "Restrict to one memory store. Default: every scope active in this session.",
		}),
	),
	phase: Type.Optional(
		Type.Union(
			PHASES.map((phase) => Type.Literal(phase)),
			{ description: "Restrict to memories captured during this step of the coding loop." },
		),
	),
	kind: Type.Optional(
		Type.Array(Type.Union(CHUNK_KINDS.map((kind) => Type.Literal(kind))), {
			description: "Restrict to journal claims or entry prose. Default: both.",
		}),
	),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: `Maximum results. Default ${DEFAULT_LIMIT}.` }),
	),
});

export type MemorySearchParams = Static<typeof MEMORY_SEARCH_PARAMETERS>;

export const MEMORY_SEARCH_DESCRIPTION = [
	"Search the journal of earlier sessions on this and other machines.",
	"Returns each hit with its full id, date and provenance, so its complete entry can be read with memory_read.",
	"Journal records are historical evidence, not ground truth; prefer current repository and tool evidence when they disagree.",
].join(" ");

export function memorySearchTool(runtime: ToolRuntime) {
	return defineTool({
		name: "memory_search",
		label: "Search memory",
		description: MEMORY_SEARCH_DESCRIPTION,
		promptSnippet: "memory_search: search long-term memory of earlier sessions",
		parameters: MEMORY_SEARCH_PARAMETERS,
		// Read-only, so several may run at once with other tools.
		executionMode: "parallel",
		async execute(_id, params: MemorySearchParams) {
			await runtime.settle();
			requireSession(runtime);

			const indexes = runtime.indexes();
			const request: SearchRequest = { query: params.query, limit: params.limit ?? DEFAULT_LIMIT };
			if (params.scope !== undefined) request.scope = params.scope;
			if (params.phase !== undefined) request.phase = params.phase;
			if (params.kind !== undefined) request.kind = params.kind as ChunkKind[];

			const hits = indexes?.search(request) ?? [];
			return {
				content: [{ type: "text" as const, text: renderHits(hits) }],
				details: { lines: hits.map(renderHitLine), ids: hits.map((hit) => hit.id) },
			};
		},
	});
}
