/**
 * Erasure: this must not exist anywhere.
 *
 * The one mutation of the journal, and the only thing in Muninn that destroys
 * information on purpose. A secret that slipped past scanning, a person's data
 * that should never have been written down: not "superseded" (which means the
 * world changed) and not "forgotten" (which means a dream was wrong), but gone.
 *
 * Always a human action, never automatic, and it does five things that must all
 * happen or the erasure is a lie:
 *
 *  1. the entry's body becomes a tombstone in its daily file, keeping the id so
 *     that references to it resolve to "this was erased" rather than to nothing;
 *  2. the id is listed in `journal/erasures.md`, so a host that still has the
 *     entry in its clone drops it at the next sync instead of resurrecting it,
 *     and so a dream can prove it did not cite it;
 *  3. every fact citing any of its claims is superseded with `reason: erased`;
 *  4. the index is rebuilt, since it holds a copy of the text;
 *  5. history is rewritten, because git keeps every version of every file and
 *     steps 1-4 leave all of them in `.git`.
 *
 * Step 5 needs `git-filter-repo`, which is a separate program and is not
 * installed with git. Without it the erasure is refused rather than done
 * halfway, unless the caller explicitly asks for the partial form and is told
 * plainly what remains.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitJournalLocked } from "../capture/commit.ts";
import { GitError, git, hasChanges } from "../git.ts";
import { indexDir } from "../index/build.ts";
import { resetSupersessionCache } from "../index/search.ts";
import { appendErasure, readErasures } from "../journal/erasures.ts";
import { claimsOf, formatEntry, type JournalEntry } from "../journal/format.ts";
import { parseDailyFile, readStoreJournal } from "../journal/read.ts";
import { appendSupersessions } from "../journal/supersessions.ts";
import type { HostIdentity } from "../store/host.ts";
import { storeIdentity } from "../store/init.ts";
import { LockBusyError, withStoreLock } from "../store/lock.ts";
import type { ActiveScope } from "../store/scopes.ts";
import { allFacts, formatTopic } from "../topics/format.ts";
import { readTopics } from "./orient.ts";

export interface EraseOptions {
	scope: ActiveScope;
	host: HostIdentity;
	/** The journal entry id to erase. */
	entryId: string;
	now: Date;
	reason?: string;
	/**
	 * Proceed without `git-filter-repo`, leaving the old bytes in `.git`.
	 *
	 * Loud by design: the result says exactly what was and was not removed, and
	 * the caller has to have asked for it.
	 */
	noRewrite?: boolean;
	/** Where the store pushes, when history has to be rewritten there too. */
	remote?: string;
	staleMs?: number;
}

export interface EraseResult {
	ok: boolean;
	/** Facts superseded because their evidence is gone. */
	supersededFacts: string[];
	rewroteHistory: boolean;
	problems: string[];
	notes: string[];
}

/** Whether `git-filter-repo` is on the PATH. */
export async function hasFilterRepo(cwd: string): Promise<boolean> {
	try {
		await git(cwd, { kind: "filter-repo-version" });
		return true;
	} catch {
		return false;
	}
}

export async function erase(options: EraseOptions): Promise<EraseResult> {
	const { scope, host } = options;
	const result: EraseResult = { ok: false, supersededFacts: [], rewroteHistory: false, problems: [], notes: [] };

	if (scope.inRepo) {
		// Rewriting the product's history is not Muninn's call to make. The
		// migration to a separate store is Phase 5; until then, say so.
		result.problems.push(
			"refusing to erase in an in-repo store: the rewrite would rewrite the project's own history. " +
				'Move this store out of the repository first (set scopes.project to "separate" and copy the store aside).',
		);
		return result;
	}

	try {
		return await withStoreLock(
			scope.path,
			"erase",
			{ host: host.id, ...(options.staleMs !== undefined ? { staleMs: options.staleMs } : {}) },
			async () => applyErase(options, result),
		);
	} catch (error) {
		if (error instanceof LockBusyError || error instanceof GitError) {
			result.problems.push(error.message);
			return result;
		}
		result.problems.push(error instanceof Error ? error.message : String(error));
		return result;
	}
}

async function applyErase(options: EraseOptions, result: EraseResult): Promise<EraseResult> {
	const { scope, host, entryId, now } = options;
	const identity = scope.inRepo ? undefined : storeIdentity(host);
	const withIdentity = identity ? { identity } : {};

	// The erasure list is asked first, and not as a fallback: a tombstoned entry
	// still parses as an entry — that is the whole point of leaving the id
	// behind — so "can I find it?" answers yes for something already erased, and
	// erasing it again would rewrite history over nothing.
	if (readErasures(scope.path).ids.has(entryId)) {
		result.problems.push(`${entryId} is already erased`);
		return result;
	}

	const found = readStoreJournal(scope.path).entries.find((entry) => entry.id === entryId);
	if (found === undefined) {
		result.problems.push(`no journal entry ${entryId} in this store`);
		return result;
	}

	const rewriting = options.noRewrite !== true;
	if (rewriting && !(await hasFilterRepo(scope.path))) {
		result.problems.push(
			"git-filter-repo is not installed, so the old bytes cannot be removed from git history. " +
				"Install it (`brew install git-filter-repo` or `pip install git-filter-repo`) and run this again, " +
				"or pass --no-rewrite to tombstone the entry and leave its history in .git.",
		);
		return result;
	}

	// Everything that has to disappear, collected before the file is rewritten.
	const secrets = [found.prose, ...found.claims, found.cue ?? ""]
		.map((text) => text.trim())
		.filter((text) => text !== "");

	await commitJournalLocked({
		storePath: scope.path,
		hostId: host.id,
		hostName: host.name,
		entries: 0,
		force: true,
		...withIdentity,
	});

	// --- 1. the tombstone ---------------------------------------------------
	tombstone(found.path, found, now);

	// --- 2. the list --------------------------------------------------------
	appendErasure(scope.path, {
		entry: entryId,
		erased: now.toISOString().slice(0, 10),
		...(options.reason !== undefined ? { reason: options.reason } : {}),
	});

	// --- 3. facts that rested on it ----------------------------------------
	const claims = new Set(claimsOf(found).map((claim) => claim.id));
	result.supersededFacts = supersedeCiting(scope.path, claims, now);

	const paths = ["journal/", "supersessions.md", "topics/"].filter((path) =>
		existsSync(join(scope.path, path.replace(/\/$/, ""))),
	);
	await git(scope.path, { kind: "add", paths });
	// Guarded, because "nothing to commit" is a git failure and an erasure that
	// changed nothing is a bug worth not masking with a stack trace.
	if (await hasChanges(scope.path, paths)) {
		await git(scope.path, { kind: "commit", message: `erase: ${entryId}`, paths }, withIdentity);
	}

	// --- 4. the index holds a copy of the text ------------------------------
	rmSync(indexDir(scope.path), { recursive: true, force: true });
	resetSupersessionCache();

	// --- 5. history ---------------------------------------------------------
	if (rewriting) {
		await rewriteHistory(scope.path, secrets, result);
		if (result.rewroteHistory && options.remote !== undefined) {
			try {
				await git(scope.path, { kind: "push-force", remote: "origin", branch: "main" });
				result.notes.push("force-pushed the rewritten history to origin");
			} catch (error) {
				result.notes.push(
					`the rewritten history was not pushed: ${error instanceof GitError ? error.stderr.trim().split("\n")[0] : String(error)}. ` +
						"Other clones still hold the erased bytes until it is.",
				);
			}
		}
	} else {
		result.notes.push(
			"history was NOT rewritten: the erased text is still reachable in .git and in every existing clone.",
		);
	}

	result.ok = true;
	result.notes.push(`${entryId} is tombstoned and listed in journal/erasures.md`);
	return result;
}

/**
 * Replace an entry's body in its daily file, keeping its heading.
 *
 * The id stays so that a reference to it resolves to "this was erased" rather
 * than to nothing at all — a dangling id is indistinguishable from a bug, and
 * this is not a bug.
 */
export function tombstone(path: string, entry: JournalEntry, now: Date): void {
	const text = readFileSync(path, "utf-8");
	const parsed = parseDailyFile(text, path);
	const rewritten = parsed.entries.map((existing) => {
		if (existing.id !== entry.id) return formatEntry(existing);
		const stone: JournalEntry = {
			id: existing.id,
			time: existing.time,
			source: existing.source,
			prose: "(erased)",
			claims: [],
			extra: { erased: now.toISOString().slice(0, 10) },
		};
		return formatEntry(stone);
	});

	// Anything before the first entry is a hand-written preamble and is kept.
	const firstHeading = text.indexOf("\n## ");
	const preamble = firstHeading < 0 ? "" : text.slice(0, firstHeading + 1);
	writeFileSync(path, `${preamble}${rewritten.join("")}`);
}

/** Supersede every active fact that rested on one of these claims. */
function supersedeCiting(storePath: string, claims: ReadonlySet<string>, now: Date): string[] {
	const today = now.toISOString().slice(0, 10);
	const superseded: string[] = [];

	for (const [slug, topic] of readTopics(storePath)) {
		let changed = false;
		const keep = [];
		for (const fact of topic.facts.concat(topic.external)) {
			if (!fact.evidence.some((id) => claims.has(id))) {
				keep.push(fact);
				continue;
			}
			topic.superseded.push({ ...fact, validTo: today, reason: "erased" });
			superseded.push(fact.id);
			changed = true;
		}
		if (!changed) continue;

		topic.facts = keep.filter((fact) => fact.source !== "external");
		topic.external = keep.filter((fact) => fact.source === "external");
		topic.updated = today;
		writeFileSync(join(storePath, "topics", `${slug}.md`), formatTopic(topic));
	}

	// The erased claims are superseded too, so nothing surfaces them again.
	appendSupersessions(
		storePath,
		[...claims].map((claim) => ({ claim, validTo: today })),
	);
	return superseded;
}

/**
 * Remove the erased text from every version of every file git holds.
 *
 * `--replace-text` matches literally, so the replacement list is the entry's own
 * text. A line that appears in another entry too would be replaced there as
 * well, which is the correct direction to be wrong in: erasure is about text
 * that must not exist, not about one entry's copy of it.
 */
async function rewriteHistory(storePath: string, secrets: readonly string[], result: EraseResult): Promise<void> {
	const file = join(storePath, ".git", "muninn-erase-replacements.txt");
	writeFileSync(file, `${secrets.map((text) => `${text}==>[erased]`).join("\n")}\n`);
	try {
		await git(storePath, { kind: "filter-repo", replacements: file });
		result.rewroteHistory = true;
		result.notes.push("rewrote git history; the erased text is gone from every commit");
	} catch (error) {
		result.notes.push(
			`history was not rewritten: ${error instanceof GitError ? error.stderr.trim().split("\n")[0] : String(error)}`,
		);
	} finally {
		rmSync(file, { force: true });
	}
}

/** Facts that would be superseded by erasing this entry — for the confirmation. */
export function eraseImpact(storePath: string, entryId: string): { claims: string[]; facts: string[] } {
	const entry = readStoreJournal(storePath).entries.find((candidate) => candidate.id === entryId);
	if (entry === undefined) return { claims: [], facts: [] };
	const claims = claimsOf(entry).map((claim) => claim.id);
	const facts: string[] = [];
	for (const topic of readTopics(storePath).values()) {
		for (const fact of allFacts(topic)) {
			if (fact.validTo === undefined && fact.evidence.some((id) => claims.includes(id))) facts.push(fact.id);
		}
	}
	return { claims, facts };
}
