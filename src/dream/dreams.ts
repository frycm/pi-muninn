/**
 * Listing dreams, and forgetting one.
 *
 * A dream exists in two places over its life: as a branch before it is
 * remembered, and as a report on `main` afterwards. Listing has to look in both
 * — a dream that was remembered has no branch left, and one that was never
 * remembered has no report on `main` — which is why this is a merge of the two
 * rather than a walk of either.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { commitJournalLocked } from "../capture/commit.ts";
import { currentBranch, GitError, type GitIdentity, git } from "../git.ts";
import type { HostIdentity } from "../store/host.ts";
import { STORE_BRANCH, storeIdentity } from "../store/init.ts";
import { LockBusyError, withStoreLock } from "../store/lock.ts";
import type { ActiveScope } from "../store/scopes.ts";
import { readTopics } from "./orient.ts";
import { type DreamReport, parseReport, reportPath } from "./report.ts";
import { DREAM_BRANCH_PREFIX } from "./worktree.ts";

export interface DreamListing {
	stamp: string;
	/** The branch, while the dream is still pending. */
	branch?: string;
	/** The commit on `main`, once it has been remembered. */
	sha?: string;
	remembered: boolean;
	forgotten: boolean;
	report?: DreamReport;
}

const TRAILER = /^Muninn-Dream:\s*(\S+)\s*$/m;
/** `git log --format=%H%x1f%s%x1f%b%x1e` — unit separators inside, record separator between. */
const UNIT = "\x1f";
const RECORD = "\x1e";

/** Commits on `main` that were dreams, keyed by stamp. */
export async function rememberedDreams(storePath: string, limit = 50): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	// The store's own branch, not the literal "main": an in-repo store lives in
	// the user's project and is on whatever branch they are.
	const branch = (await currentBranch(storePath)) ?? STORE_BRANCH;
	let stdout: string;
	try {
		stdout = (await git(storePath, { kind: "log-entries", ref: branch, limit })).stdout;
	} catch {
		return found;
	}
	for (const record of stdout.split(RECORD)) {
		const [sha, , body] = record.split(UNIT);
		if (sha === undefined || body === undefined) continue;
		const match = TRAILER.exec(body);
		// Newest first, and a stamp is unique, so the first sighting wins.
		if (match && !found.has(match[1] as string)) found.set(match[1] as string, sha.trim());
	}
	return found;
}

/** Every dream this store knows about, newest first. */
export async function listDreams(storePath: string): Promise<DreamListing[]> {
	const listings = new Map<string, DreamListing>();

	let branches: string[] = [];
	try {
		branches = (await git(storePath, { kind: "branch-list", prefix: DREAM_BRANCH_PREFIX })).stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");
	} catch {
		branches = [];
	}
	for (const branch of branches) {
		const stamp = branch.slice(branch.lastIndexOf("/") + 1);
		const report = await reportOn(storePath, branch, stamp);
		listings.set(stamp, { stamp, branch, remembered: false, forgotten: false, ...report });
	}

	for (const [stamp, sha] of await rememberedDreams(storePath)) {
		const existing = listings.get(stamp);
		const report = readReport(storePath, stamp);
		listings.set(stamp, {
			...(existing ?? { stamp }),
			stamp,
			sha,
			remembered: true,
			forgotten: isForgotten(storePath, stamp),
			...(report ? { report } : {}),
		});
	}

	return [...listings.values()].sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
}

/** A dream's report as of its branch, since it is not on `main` until remembered. */
async function reportOn(storePath: string, branch: string, stamp: string): Promise<{ report?: DreamReport }> {
	try {
		const { stdout } = await git(storePath, { kind: "show-file", ref: branch, path: reportPath(stamp) });
		const report = parseReport(stdout, stamp);
		return report ? { report } : {};
	} catch {
		return {};
	}
}

function readReport(storePath: string, stamp: string): DreamReport | undefined {
	try {
		return parseReport(readFileSync(join(storePath, reportPath(stamp)), "utf-8"), stamp);
	} catch {
		return undefined;
	}
}

/** A forgotten dream's report carries a `forgotten:` line on `main`. */
function isForgotten(storePath: string, stamp: string): boolean {
	try {
		return /^forgotten:/m.test(readFileSync(join(storePath, reportPath(stamp)), "utf-8"));
	} catch {
		return false;
	}
}

export interface ForgetOptions {
	scope: ActiveScope;
	host: HostIdentity;
	stamp: string;
	now: Date;
	staleMs?: number;
}

export interface ForgetResult {
	ok: boolean;
	problems: string[];
	notes: string[];
}

/**
 * Undo a remembered dream.
 *
 * A revert commit, never a rewrite of `main`: the dream happened, the store
 * learned from it, and someone decided it was wrong — all three are true and
 * the history should say so. The journal is untouched either way, and the
 * report is kept, because the report of a forgotten dream is the record of why.
 */
export async function forget(options: ForgetOptions): Promise<ForgetResult> {
	const { scope, host } = options;
	const result: ForgetResult = { ok: false, problems: [], notes: [] };
	const identity = scope.inRepo ? undefined : storeIdentity(host);

	try {
		return await withStoreLock(
			scope.path,
			"remember",
			{ host: host.id, ...(options.staleMs !== undefined ? { staleMs: options.staleMs } : {}) },
			async () => applyForget(options, identity, result),
		);
	} catch (error) {
		if (error instanceof LockBusyError || error instanceof GitError) {
			result.problems.push(error.message);
			return result;
		}
		throw error;
	}
}

async function applyForget(
	options: ForgetOptions,
	identity: GitIdentity | undefined,
	result: ForgetResult,
): Promise<ForgetResult> {
	const { scope, host, stamp } = options;
	const sha = (await rememberedDreams(scope.path)).get(stamp);
	if (sha === undefined) {
		result.problems.push(`no remembered dream ${stamp} in this store`);
		return result;
	}

	// The worktree has to be clean or the revert refuses, and a session may have
	// appended since the dream was remembered.
	await commitJournalLocked({
		storePath: scope.path,
		hostId: host.id,
		hostName: host.name,
		entries: 0,
		force: true,
		...(identity ? { identity } : {}),
	});

	// Read the report *before* the revert removes it.
	let report: string | undefined;
	try {
		report = readFileSync(join(scope.path, reportPath(stamp)), "utf-8");
	} catch {
		report = undefined;
	}

	try {
		await git(scope.path, { kind: "revert", sha }, identity ? { identity } : {});
	} catch (error) {
		result.problems.push(
			`could not revert ${stamp} (${error instanceof GitError ? error.stderr.trim().split("\n")[0] : String(error)})`,
		);
		return result;
	}

	if (report !== undefined) await restoreReport(scope.path, stamp, report, options.now, identity, result);
	result.ok = true;
	result.notes.push(`reverted ${stamp}; the journal is untouched`);
	return result;
}

/**
 * Put the report back, marked forgotten.
 *
 * Reverting the dream commit removes the report along with everything else it
 * added, and losing it would leave nobody able to say why the store is the way
 * it is. So it comes back with one extra line.
 */
async function restoreReport(
	storePath: string,
	stamp: string,
	report: string,
	now: Date,
	identity: GitIdentity | undefined,
	result: ForgetResult,
): Promise<void> {
	const forgotten = report.startsWith("---\n")
		? report.replace("---\n", `---\nforgotten: ${now.toISOString().slice(0, 10)}\n`)
		: `<!-- forgotten: ${now.toISOString().slice(0, 10)} -->\n${report}`;
	const path = join(storePath, reportPath(stamp));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, forgotten);
	try {
		await git(storePath, { kind: "add", paths: ["dreams/"] });
		await git(
			storePath,
			{ kind: "commit", message: `dream: forget ${stamp}`, paths: ["dreams/"] },
			identity ? { identity } : {},
		);
	} catch {
		result.notes.push(`the report for ${stamp} could not be kept`);
	}
}

/** How many topics and facts a store holds — for `/muninn` and the dream list. */
export function storeShape(storePath: string): { topics: number; facts: number } {
	const topics = readTopics(storePath);
	let facts = 0;
	for (const topic of topics.values()) facts += topic.facts.length + topic.external.length;
	return { topics: topics.size, facts };
}
