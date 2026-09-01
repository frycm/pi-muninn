/** Minimal runtime shared by all model-facing project-journal tools. */
import type { MuninnSessionState } from "../capture/session-state.ts";
import type { AppendJournalResult } from "../journal/jsonl.ts";
import type { JournalQueryService } from "../journal/query.ts";
import type { NewJournalRecord } from "../journal/record.ts";
import type { SessionContext } from "../session.ts";

export interface JournalToolContext {
	mode: string;
	cwd?: string;
	sessionManager: {
		getSessionFile(): string | undefined;
		getLeafId(): string | null;
	};
}

export interface JournalToolRuntime {
	/** Wait for sequential appends, commits, and initial index work. */
	settle(): Promise<void>;
	session(): SessionContext | undefined;
	state(): MuninnSessionState | undefined;
	query(): JournalQueryService;
	append(record: NewJournalRecord, context: JournalToolContext): Promise<AppendJournalResult>;
}

export function requireJournalSession(runtime: JournalToolRuntime): SessionContext {
	const session = runtime.session();
	if (!session?.project) throw new Error("muninn: no logical project journal is active in this session");
	return session;
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("muninn: journal tool call cancelled");
}

export function jsonToolResult(value: unknown, details: unknown = value) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details };
}
