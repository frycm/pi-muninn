/**
 * `memory_read` — one memory, in full, by the id a search returned.
 *
 * A model can read:
 *
 *  - `j-<uuid>` — a whole journal entry: its metadata, the prose that gives it
 *    a situation, and every claim it carries with its address.
 *  - `j-<uuid>.<n>` — one claim, shown inside its entry, because a claim
 *    without its context is exactly the thing this project refuses to trust.
 *  - a store-relative journal file, with an optional line range.
 *  - a `session:` pointer — pi's own transcript underneath an entry, which is
 *    the evidence the journal deliberately does not copy.
 *
 * Reads are confined to the active stores and to the session files that
 * journal entries actually point at. Both boundaries are enforced on canonical
 * paths, because tool arguments are model-controlled: text the model read
 * somewhere else must not be able to turn `memory_read` into "open any file on
 * this machine".
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { messageText } from "../capture/accumulate.ts";
import { isEntryId, parseClaimId } from "../ids.ts";
import { findEntry, referencedSessionFiles, splitSessionPointer } from "../journal/lookup.ts";
import type { SessionContext } from "../session.ts";
import { canonicalPath, isInside } from "../store/paths.ts";
import { renderEntry, renderFile, TOOL_OUTPUT_CHARS, trailer, truncate } from "./render.ts";
import { requireSession, type ToolRuntime } from "./runtime.ts";

/** Session entries shown before the one a pointer names. */
const SESSION_CONTEXT_ENTRIES = 10;
const SESSION_ENTRY_CHARS = 1_200;

export const MEMORY_READ_PARAMETERS = Type.Object({
	id: Type.Optional(
		Type.String({
			description: "A journal entry (j-…), claim (j-….1), or session pointer taken from an entry.",
		}),
	),
	path: Type.Optional(
		Type.String({
			description: "A path inside an active journal store.",
		}),
	),
	range: Type.Optional(Type.String({ description: "Line range for a path read, as first-last (for example 20-80)." })),
});

export type MemoryReadParams = Static<typeof MEMORY_READ_PARAMETERS>;

export const MEMORY_READ_DESCRIPTION = [
	"Read a journal entry with its context, a single claim inside its entry, a journal file, or the pi session transcript an entry points at.",
	"Takes an id from memory_search, or a path inside an active journal store.",
].join(" ");

export function memoryReadTool(runtime: ToolRuntime) {
	return defineTool({
		name: "memory_read",
		label: "Read memory",
		description: MEMORY_READ_DESCRIPTION,
		promptSnippet: "memory_read: read one memory, or the session behind it, in full",
		parameters: MEMORY_READ_PARAMETERS,
		executionMode: "parallel",
		async execute(_id, params: MemoryReadParams) {
			await runtime.settle();
			const session = requireSession(runtime);

			const text = read(runtime, session, params);
			return { content: [{ type: "text" as const, text }], details: { id: params.id, path: params.path } };
		},
	});
}

function read(runtime: ToolRuntime, session: SessionContext, params: MemoryReadParams): string {
	if (params.id !== undefined && params.id.trim() !== "") {
		const id = params.id.trim();
		if (id.startsWith("session:") || /\.jsonl(#|$)/.test(id)) {
			return readSession(id.replace(/^session:/, ""), session);
		}
		return readById(runtime, id);
	}
	if (params.path !== undefined && params.path.trim() !== "") {
		return readPath(session, params.path.trim(), parseRange(params.range));
	}
	throw new Error("muninn: memory_read needs either an id or a path");
}

// ---------------------------------------------------------------------------
// By id
// ---------------------------------------------------------------------------

function readById(runtime: ToolRuntime, id: string): string {
	const indexes = runtime.indexes();
	if (!indexes) throw new Error("muninn: the memory index is not open in this session");

	const claim = parseClaimId(id);
	const entryId = claim?.entryId ?? (isEntryId(id) ? id : undefined);
	if (entryId) return readEntry(indexes, entryId, claim ? id : undefined);

	const found = indexes.find(id);
	if (!found) throw new Error(`muninn: no journal record has the id ${id}`);
	return truncate(
		[trailer({ ...found.chunk, scope: found.scope.scope }), `file: ${found.chunk.path}`, "", found.chunk.body].join(
			"\n",
		),
		TOOL_OUTPUT_CHARS,
	);
}

function readEntry(indexes: NonNullable<ReturnType<ToolRuntime["indexes"]>>, entryId: string, claim?: string): string {
	const found = findEntry(indexes, entryId);
	return renderEntry(found.entry, {
		scope: found.scope,
		path: found.path,
		...(found.date ? { date: found.date } : {}),
		...(claim ? { claim } : {}),
	});
}

// ---------------------------------------------------------------------------
// By path
// ---------------------------------------------------------------------------

function parseRange(range: string | undefined): { from: number; to: number } | undefined {
	if (!range) return undefined;
	const match = range.match(/^(\d+)\s*[-–:]\s*(\d+)$/);
	if (!match) throw new Error(`muninn: unreadable range "${range}"; use first-last, for example 20-80`);
	const from = Number.parseInt(match[1] as string, 10);
	const to = Number.parseInt(match[2] as string, 10);
	if (to < from) throw new Error(`muninn: range "${range}" ends before it starts`);
	return { from, to };
}

/**
 * Resolve a path inside one of the active stores.
 *
 * The check is on the resolved path, not the string: `../../etc/passwd` and a
 * symlinked absolute path both have to fail, and only comparing what the
 * filesystem would actually open catches them.
 */
function readPath(session: SessionContext, path: string, range?: { from: number; to: number }): string {
	const tried: string[] = [];
	for (const scope of session.scopes.active) {
		const root = canonicalPath(scope.path);
		if (root === undefined) continue;
		const target = canonicalPath(isAbsolute(path) ? path : resolve(scope.path, path));
		// Canonical on both sides: `resolve()` normalises `..` but knows nothing
		// about symlinks, so `<store>/escape.md -> /etc/passwd` would pass a
		// lexical prefix test and then be read.
		if (target === undefined || !isInside(root, target)) {
			tried.push(scope.path);
			continue;
		}
		if (!statSync(target).isFile()) {
			tried.push(scope.path);
			continue;
		}
		const relative =
			target === root
				? ""
				: target
						.slice(root.length + 1)
						.split(sep)
						.join("/");
		return renderFile(`${scope.scope}:${relative}`, readFileSync(target, "utf-8"), range);
	}

	throw new Error(
		`muninn: ${path} is not a readable file in any active memory store (looked in ${tried.join(", ") || "no active store"})`,
	);
}

// ---------------------------------------------------------------------------
// The session behind an entry
// ---------------------------------------------------------------------------

interface SessionLine {
	id?: string;
	type?: string;
	timestamp?: string;
	message?: unknown;
	customType?: string;
	content?: unknown;
}

/**
 * The pi session entries an entry's `session:` pointer names.
 *
 * Muninn never copies transcripts into the journal — they are pi's, they are
 * large, and they are already on disk. The pointer is how an entry stays one
 * hop from its evidence, and this is the hop.
 *
 * Only files the journal *already points at* are opened. The parameter is
 * model-controlled and a model reads text other people wrote, so without this
 * the tool would open any path a prompt-injected sentence asked for. Capture is
 * the only writer of a `session:` field — `memory_note` takes its pointer from
 * the runtime, never from its arguments — so the allow-list is closed by
 * construction.
 */
function readSession(pointer: string, session: SessionContext): string {
	const { file, entry: wanted } = splitSessionPointer(pointer);
	if (!file) throw new Error("muninn: a session pointer needs a file, as session:<file>#<entry id>");

	const target = canonicalPath(file);
	const referenced = referencedSessionFiles(session.scopes.active.map((scope) => scope.path));
	if (target === undefined || !referenced.has(target)) {
		throw new Error(
			`muninn: ${file} is not a session file any memory points at; memory_read only opens transcripts the journal refers to`,
		);
	}

	let text: string;
	try {
		text = readFileSync(target, "utf-8");
	} catch (error) {
		throw new Error(
			`muninn: cannot read the session file ${file} (${error instanceof Error ? error.message : String(error)})`,
		);
	}

	const entries: SessionLine[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			entries.push(JSON.parse(line) as SessionLine);
		} catch {
			// A session file being written while it is read can end mid-line.
		}
	}

	const at = wanted ? entries.findIndex((entry) => entry.id === wanted) : entries.length - 1;
	if (wanted && at < 0) throw new Error(`muninn: ${file} has no entry ${wanted}`);

	const from = Math.max(0, at - SESSION_CONTEXT_ENTRIES);
	const shown = entries.slice(from, at + 1);
	const lines = shown.map((entry, index) => {
		const marker = from + index === at ? "→" : " ";
		const body = entry.type === "message" ? messageText(entry.message as never) : (renderNonMessage(entry) ?? "");
		return `${marker} ${describe(entry)}\n    ${truncate(body.replace(/\n/g, "\n    "), SESSION_ENTRY_CHARS)}`;
	});

	return truncate(
		[`${file}${wanted ? `#${wanted}` : ""} — ${shown.length} entr(y/ies), oldest first:`, "", ...lines].join("\n"),
		TOOL_OUTPUT_CHARS,
	);
}

function describe(entry: SessionLine): string {
	const role =
		entry.type === "message" ? ((entry.message as { role?: string } | undefined)?.role ?? "message") : entry.type;
	return [role, entry.customType, entry.timestamp].filter(Boolean).join(" · ");
}

function renderNonMessage(entry: SessionLine): string | undefined {
	if (typeof entry.content === "string") return entry.content;
	if (Array.isArray(entry.content)) return messageText(entry as never);
	return undefined;
}
