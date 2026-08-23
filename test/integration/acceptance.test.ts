/**
 * The README's Phase 1 acceptance test, as literally as step 8 can state it:
 *
 * > a correction made on Monday on one laptop is surfaced by `memory_search`
 * > on Tuesday on another laptop in a different project directory.
 *
 * Two scratch agent directories stand in for two laptops, and a bare
 * repository for the remote they share. Two things are still ahead of this
 * step: `muninn sync` (step 12) and the `memory_search` tool (step 10). So the
 * transport here is plain `git push` / `git clone` in the harness, and the
 * query goes through `search()` — the same function the tool will call. Step
 * 12's "done when" is this test again, with `muninn sync` in place of the git
 * calls.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitJournal, resetCommitDebounce } from "../../src/capture/commit.ts";
import { resetSupersessionCache, SessionIndexes } from "../../src/index/search.ts";
import { appendEntry } from "../../src/journal/append.ts";
import { loadHostIdentity } from "../../src/store/host.ts";
import { ensureStore } from "../../src/store/init.ts";
import { globalStorePath } from "../../src/store/paths.ts";
import type { ActiveScope } from "../../src/store/scopes.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
	});
	return stdout;
}

let remote: string;
let laptopOne: string;
let laptopTwo: string;

beforeEach(async () => {
	remote = mkdtempSync(join(tmpdir(), "muninn-remote-"));
	laptopOne = mkdtempSync(join(tmpdir(), "muninn-laptop-1-"));
	laptopTwo = mkdtempSync(join(tmpdir(), "muninn-laptop-2-"));
	await git(remote, ["init", "--bare", "--quiet", "--initial-branch=main"]);
	resetCommitDebounce();
	resetSupersessionCache();
});

afterEach(() => {
	for (const path of [remote, laptopOne, laptopTwo]) rmSync(path, { recursive: true, force: true });
});

function activeGlobal(path: string): ActiveScope[] {
	return [{ scope: "global", path, exists: true, inRepo: false }];
}

describe("cross-laptop acceptance", () => {
	it("surfaces Monday's correction from the other laptop the next day", async () => {
		// --- Monday, laptop one, project A ---------------------------------
		const hostOne = loadHostIdentity(laptopOne);
		const storeOne = globalStorePath(laptopOne);
		await ensureStore(storeOne, { host: hostOne });

		const written = await appendEntry(
			{
				source: "user",
				channel: "tui",
				phase: "test",
				cue: "when the CI job hangs",
				prose: "Martin corrected an earlier assumption while the CI job hung.",
				claims: ["Run `pnpm test --run`; vitest watch mode hangs the CI job.", "The CI runner has no TTY."],
			},
			{ storePath: storeOne, hostId: hostOne.id, now: new Date("2026-08-24T14:32:00") },
		);

		const committed = await commitJournal({
			storePath: storeOne,
			hostId: hostOne.id,
			hostName: hostOne.name,
			entries: 1,
			force: true,
		});
		expect(committed.committed).toBe(true);

		await git(storeOne, ["remote", "add", "origin", remote]);
		await git(storeOne, ["push", "--quiet", "origin", "HEAD:main"]);

		// The commit that carried the correction touched `journal/` and nothing else.
		const touched = await git(storeOne, ["show", "--name-only", "--format=", "HEAD"]);
		expect(
			touched
				.trim()
				.split("\n")
				.every((path) => path.startsWith("journal/")),
		).toBe(true);

		// --- Tuesday, laptop two, project B --------------------------------
		const storeTwo = join(laptopTwo, "muninn");
		await git(laptopTwo, ["clone", "--quiet", remote, storeTwo]);
		const hostTwo = loadHostIdentity(laptopTwo);
		await ensureStore(storeTwo, { host: hostTwo });

		// A second laptop is a second host: its own id, its own journal directory.
		expect(hostTwo.id).not.toBe(hostOne.id);
		expect(readFileSync(join(storeTwo, "store.md"), "utf-8")).toContain(hostOne.id);

		const opened = SessionIndexes.open(activeGlobal(storeTwo));
		expect(opened.problems).toEqual([]);

		const hits = opened.indexes.search({ query: "vitest watch" });
		expect(hits[0]?.id).toBe(written.claimIds[0]);
		expect(hits[0]?.date).toBe("2026-08-24");
		expect(hits[0]?.scope).toBe("global");
		expect(hits[0]?.source).toBe("user");
		expect(hits[0]?.snippet).toContain("watch mode hangs");

		// The cue is what a query about the *situation* matches, not the words
		// of the fix — that is what it is written for.
		expect(opened.indexes.search({ query: "CI job hangs" })[0]?.entry).toBe(written.id);
	});

	it("keeps two hosts' journals in separate files, so a pull never merges one", async () => {
		const hostOne = loadHostIdentity(laptopOne);
		const storeOne = globalStorePath(laptopOne);
		await ensureStore(storeOne, { host: hostOne });
		await appendEntry(
			{ source: "user", prose: "", claims: ["Laptop one saw the CI job hang."] },
			{ storePath: storeOne, hostId: hostOne.id },
		);
		await commitJournal({ storePath: storeOne, hostId: hostOne.id, hostName: hostOne.name, entries: 1, force: true });
		await git(storeOne, ["remote", "add", "origin", remote]);
		await git(storeOne, ["push", "--quiet", "origin", "HEAD:main"]);

		const storeTwo = join(laptopTwo, "muninn");
		await git(laptopTwo, ["clone", "--quiet", remote, storeTwo]);
		const hostTwo = loadHostIdentity(laptopTwo);
		await ensureStore(storeTwo, { host: hostTwo });
		await appendEntry(
			{ source: "user", prose: "", claims: ["Laptop two saw the database URL change."] },
			{ storePath: storeTwo, hostId: hostTwo.id },
		);
		resetCommitDebounce();
		await commitJournal({ storePath: storeTwo, hostId: hostTwo.id, hostName: hostTwo.name, entries: 1, force: true });
		await git(storeTwo, ["push", "--quiet", "origin", "HEAD:main"]);

		// Laptop one pulls: a fast-forward, because the two hosts wrote to
		// different files. Both entries are then in one index.
		await git(storeOne, ["pull", "--quiet", "--ff-only", "origin", "main"]);
		const opened = SessionIndexes.open(activeGlobal(storeOne));
		expect(opened.indexes.search({ query: "database URL" })[0]?.body).toContain("Laptop two");
		expect(opened.indexes.search({ query: "CI job hang" })[0]?.body).toContain("Laptop one");
		expect(opened.indexes.size).toBe(2);
	});
});
