/**
 * What Muninn remembers about the session it is in.
 *
 * Kept in pi's own session file as custom entries, so it survives a resume, a
 * fork, and a reload without Muninn needing a sidecar file that could drift
 * out of step with the session it describes.
 *
 * Entries are **deltas**, not snapshots, so written ids can be appended without
 * rewriting an ever-growing session-state record.
 */

/** The `customType` under which state deltas are stored in pi's session. */
export const STATE_CUSTOM_TYPE = "muninn-state";

export type StateDelta = { kind: "start"; task: string; continues?: string } | { kind: "written"; ids: string[] };

export interface MuninnSessionState {
	/** pi's session id — the task group every entry of this session shares. */
	task: string;
	/** The task this one continues, when the session was resumed or forked. */
	continues?: string;
	/** Journal entries written this session. */
	written: string[];
}

interface CustomEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

function isDelta(value: unknown): value is StateDelta {
	if (typeof value !== "object" || value === null) return false;
	const kind = (value as { kind?: unknown }).kind;
	return kind === "start" || kind === "written";
}

/**
 * Fold this session's state out of its entries.
 *
 * `fallbackTask` is pi's session id, used when no `start` delta is present —
 * which happens for a session that ran before Muninn was loaded. The task
 * group must never be empty, since it is what the evaluate phase holds out.
 */
export function rebuildState(entries: readonly CustomEntryLike[], fallbackTask: string): MuninnSessionState {
	const state: MuninnSessionState = { task: fallbackTask, written: [] };
	const written = new Set<string>();

	for (const entry of entries) {
		if (entry.customType !== STATE_CUSTOM_TYPE) continue;
		if (!isDelta(entry.data)) continue;
		const delta = entry.data;

		if (delta.kind === "start") {
			state.task = delta.task;
			if (delta.continues) state.continues = delta.continues;
			continue;
		}
		for (const id of delta.ids) written.add(id);
	}

	state.written = [...written];
	return state;
}

/**
 * The session id inside a session file's name.
 *
 * pi names session files `<timestamp>_<uuid>.jsonl` (and older ones
 * `<uuid>.jsonl`), so `continues` can name a task rather than a path. When the
 * name does not yield a uuid the basename is used instead: a slightly coarser
 * grouping key is far better than dropping the link between two halves of one
 * task.
 */
export function taskFromSessionFile(path: string | undefined): string | undefined {
	if (!path) return undefined;
	const base = path.split(/[/\\]/).pop();
	if (!base) return undefined;
	const name = base.replace(/\.jsonl$/, "");
	const candidate = name.includes("_") ? (name.split("_").pop() as string) : name;
	return candidate === "" ? name : candidate;
}

/**
 * `<session file>#<leaf entry id>` — the evidence pointer into pi's session tree.
 *
 * Lives here rather than in the extension entry because two callers need it:
 * capture, which stamps it on every entry, and `memory_note`, which stamps the
 * same pointer on what the model asks to remember.
 */
export function sessionPointer(sessionManager: {
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
}): string | undefined {
	const file = sessionManager.getSessionFile();
	if (!file) return undefined;
	const leaf = sessionManager.getLeafId();
	return leaf ? `${file}#${leaf}` : file;
}

/**
 * Plain text of an assistant message.
 *
 * Thinking blocks and tool calls are excluded: the correction classifier asks
 * "did the user contradict what the agent *said*", and reasoning the user
 * never saw cannot be what they are answering.
 */
export function assistantText(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const record = message as { role?: unknown; content?: unknown };
	if (record.role !== "assistant") return undefined;

	if (typeof record.content === "string") return record.content;
	if (!Array.isArray(record.content)) return undefined;

	const parts: string[] = [];
	for (const block of record.content) {
		if (typeof block !== "object" || block === null) continue;
		const typed = block as { type?: unknown; text?: unknown };
		if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
	}
	const text = parts.join("\n").trim();
	return text === "" ? undefined : text;
}
