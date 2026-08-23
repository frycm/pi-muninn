/**
 * Committing the journal.
 *
 * Capture commits `journal/` on this host's behalf — at `agent_settled`, at
 * `session_shutdown`, and immediately before a sync or a dream. One commit per
 * batch, never one per entry: a session that journals a correction and an
 * outcome should leave one commit, not two.
 *
 * Nothing here touches any path but `journal/`. That is enforced by `git.ts`'s
 * allow-list rather than by convention, and the commit carries a pathspec, so
 * an in-repo store cannot sweep up work the developer had staged for
 * themselves.
 */
import { GitError, type GitIdentity, GitMissingError, git, hasChanges, isGitRepository } from "../git.ts";
import { withStoreLock } from "../store/lock.ts";

/** Journal paths, and the only paths this module will ever stage. */
const JOURNAL_PATHS = ["journal/"];

/** At most one commit per store in this window, unless forced. */
export const DEBOUNCE_MS = 30_000;

export interface CommitOptions {
	storePath: string;
	/** Recorded in the lock file, and the name the commit message carries. */
	hostId: string;
	hostName: string;
	/**
	 * Entries appended since the last commit. Used for the message only.
	 *
	 * A backlog left by a crashed session is committed too, so the number can
	 * understate what the commit contains. It is a description, not a count that
	 * anything depends on.
	 */
	entries: number;
	/** Skip the debounce. The shutdown path does; the per-run path does not. */
	force?: boolean;
	/** The identity to commit under. Absent for an in-repo store, which keeps the project's. */
	identity?: GitIdentity;
	/** Overrides the clock. Tests use it. */
	now?: number;
}

export interface CommitResult {
	committed: boolean;
	/** Why not, when `committed` is false. */
	reason?: string;
}

const lastCommitAt = new Map<string, number>();

/** Forget debounce state. Tests use it; nothing else should need to. */
export function resetCommitDebounce(): void {
	lastCommitAt.clear();
}

function message(options: CommitOptions): string {
	const count = options.entries;
	const noun = count === 1 ? "entry" : "entries";
	return count > 0 ? `journal: ${options.hostName} ${count} ${noun}` : `journal: ${options.hostName}`;
}

/**
 * Commit pending journal entries, if there are any.
 *
 * Held under the store lock for its whole duration: git reads the daily files
 * while an append could be writing one, and the lock is what makes "one
 * complete entry per write" true for readers as well as writers.
 */
export async function commitJournal(options: CommitOptions): Promise<CommitResult> {
	const now = options.now ?? Date.now();

	if (!options.force) {
		const last = lastCommitAt.get(options.storePath);
		if (last !== undefined && now - last < DEBOUNCE_MS) {
			// Not an error: the entries are on disk, and the next commit takes them.
			return { committed: false, reason: "debounced" };
		}
	}

	try {
		if (!(await isGitRepository(options.storePath))) {
			return { committed: false, reason: "store is not a git repository" };
		}
	} catch (error) {
		if (error instanceof GitMissingError) return { committed: false, reason: error.message };
		throw error;
	}

	return withStoreLock(options.storePath, "commit", { host: options.hostId }, () => commitJournalLocked(options, now));
}

/**
 * The commit itself, with the lock already held.
 *
 * Sync needs this: it holds the store lock for its whole transaction, and
 * `proper-lockfile` is not reentrant — calling `commitJournal` from inside a
 * sync would deadlock the store against itself.
 */
export async function commitJournalLocked(options: CommitOptions, at?: number): Promise<CommitResult> {
	const now = at ?? options.now ?? Date.now();
	if (!(await hasChanges(options.storePath, JOURNAL_PATHS))) {
		// Record the check so an idle session does not re-run git every turn.
		lastCommitAt.set(options.storePath, now);
		return { committed: false, reason: "nothing to commit" };
	}

	await git(options.storePath, { kind: "add", paths: JOURNAL_PATHS });
	try {
		await git(
			options.storePath,
			{ kind: "commit", message: message(options), paths: JOURNAL_PATHS },
			options.identity ? { identity: options.identity } : {},
		);
	} catch (error) {
		// Another process may have committed the same entries between the
		// change check and here. An empty commit is not a failure.
		if (error instanceof GitError && /nothing to commit|no changes added/i.test(error.stderr)) {
			lastCommitAt.set(options.storePath, now);
			return { committed: false, reason: "already committed by another session" };
		}
		throw error;
	}

	lastCommitAt.set(options.storePath, now);
	return { committed: true };
}
