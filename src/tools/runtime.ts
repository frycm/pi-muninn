/**
 * What the tools need from the session they are registered in.
 *
 * The tool modules never reach into pi or into module state: everything they
 * need arrives through this interface, which `index.ts` implements from the
 * closures it already keeps. That is what lets a test drive `memory_search`
 * against a scratch store with no pi process anywhere.
 */
import type { MuninnSessionState } from "../capture/session-state.ts";
import type { SessionIndexes } from "../index/search.ts";
import type { AppendResult, NewJournalEntry } from "../journal/append.ts";
import type { SessionContext } from "../session.ts";
import type { CaptureTarget } from "../store/scopes.ts";

export interface ToolRuntime {
	/**
	 * Wait for pending appends and for the index to be open.
	 *
	 * Every read goes through this first. A tool that answered "no memories"
	 * because an append from the same turn was still queued would be worse than
	 * a tool that took another twenty milliseconds.
	 */
	settle(): Promise<void>;
	session(): SessionContext | undefined;
	indexes(): SessionIndexes | undefined;
	state(): MuninnSessionState | undefined;
	/**
	 * Append an entry to one scope and index it.
	 *
	 * Awaited rather than queued, and never redirected: if the named store
	 * cannot be written, the tool call fails saying so. Silently writing
	 * somewhere else would leave the model believing a memory exists in a place
	 * it does not.
	 */
	append(scope: CaptureTarget, entry: NewJournalEntry): Promise<AppendResult>;
}

/** The session context, or a failure the model can act on. */
export function requireSession(runtime: ToolRuntime): SessionContext {
	const session = runtime.session();
	if (!session) throw new Error("muninn: memory is not available in this session yet");
	return session;
}

/** The scope a write goes to: the one asked for, or this session's capture target. */
export function resolveWriteScope(session: SessionContext, requested?: CaptureTarget): CaptureTarget {
	const target = requested ?? session.scopes.captureTarget;
	if (!target) {
		throw new Error("muninn: no memory store is active in this session, so there is nowhere to write");
	}
	if (!session.scopes.active.some((scope) => scope.scope === target)) {
		throw new Error(`muninn: the ${target} scope is not active in this session (see /muninn scope)`);
	}
	return target;
}
