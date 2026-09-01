/**
 * The README's Phase 1 acceptance test, as literally as step 8 can state it:
 *
 * > a correction made on Monday on one laptop is surfaced by `memory_search`
 * > on Tuesday on another laptop in a different project directory.
 *
 * Two scratch agent directories stand in for two laptops, and a bare
 * repository in `tmp` for the remote they share — nothing here touches a
 * network. A path is a git remote like any other, and it is a configuration
 * people really use (`sync.remote` pointing at a NAS or a synced folder); what
 * a real ssh remote would add is auth and transport failure, neither of which
 * changes a rebase. The offline case is covered in `test/unit/sync.test.ts` by
 * pointing sync at a path that does not exist.
 *
 * The remote is *bare* because both laptops push: git refuses by default to
 * push into the branch a non-bare repository has checked out. One-directional
 * exchange would need no third repository at all — laptop two could fetch
 * straight from laptop one's store — but "synced on both sides" is what the
 * acceptance criterion asks for.
 *
 * The transport is `sync()` — the same transaction `/muninn sync` and the
 * `muninn` CLI run — and the query goes through `search()`, the function
 * `memory_search` calls. The one git command left in the harness is the
 * `clone` that provisions the second laptop, which is how a machine joins a
 * store that already exists.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetCommitDebounce } from "../../src/capture/commit.ts";
import { SessionIndexes } from "../../src/index/search.ts";
import { appendEntry } from "../../src/journal/append.ts";
import { loadHostIdentity } from "../../src/store/host.ts";
import { ensureStore } from "../../src/store/init.ts";
import { globalStorePath } from "../../src/store/paths.ts";
import type { ActiveScope } from "../../src/store/scopes.ts";
import { sync } from "../../src/sync/sync.ts";

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

		await git(storeOne, ["branch", "-M", "main"]);
		const pushed = await sync({ storePath: storeOne, hostId: hostOne.id, hostName: hostOne.name, remote });
		expect(pushed.problem).toBeUndefined();
		expect(pushed.committed).toBe(true);
		expect(pushed.pushed).toBe(true);

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
		// Registering itself is a change, so laptop two syncs it back.
		resetCommitDebounce();
		const joined = await sync({ storePath: storeTwo, hostId: hostTwo.id, hostName: hostTwo.name, remote });
		expect(joined.problem).toBeUndefined();

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
		await git(storeOne, ["branch", "-M", "main"]);
		await appendEntry(
			{ source: "user", prose: "", claims: ["Laptop one saw the CI job hang."] },
			{ storePath: storeOne, hostId: hostOne.id },
		);
		await sync({ storePath: storeOne, hostId: hostOne.id, hostName: hostOne.name, remote });

		const storeTwo = join(laptopTwo, "muninn");
		await git(laptopTwo, ["clone", "--quiet", remote, storeTwo]);
		const hostTwo = loadHostIdentity(laptopTwo);
		await ensureStore(storeTwo, { host: hostTwo });
		await appendEntry(
			{ source: "user", prose: "", claims: ["Laptop two saw the database URL change."] },
			{ storePath: storeTwo, hostId: hostTwo.id },
		);
		resetCommitDebounce();
		const second = await sync({ storePath: storeTwo, hostId: hostTwo.id, hostName: hostTwo.name, remote });
		expect(second.problem).toBeUndefined();

		// Laptop one syncs again and picks the other host's entry up by rebase —
		// no merge, because the two hosts wrote to different files.
		resetCommitDebounce();
		const back = await sync({ storePath: storeOne, hostId: hostOne.id, hostName: hostOne.name, remote });
		expect(back.rebased).toBe(true);
		expect(back.problem).toBeUndefined();
		const opened = SessionIndexes.open(activeGlobal(storeOne));
		expect(opened.indexes.search({ query: "database URL" })[0]?.body).toContain("Laptop two");
		expect(opened.indexes.search({ query: "CI job hang" })[0]?.body).toContain("Laptop one");
		expect(opened.indexes.size).toBe(2);
	});
});
