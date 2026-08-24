import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetCommitDebounce } from "../../src/capture/commit.ts";
import { dream } from "../../src/dream/dream.ts";
import { forget, listDreams, rememberedDreams } from "../../src/dream/dreams.ts";
import type { DreamModel } from "../../src/dream/model.ts";
import { markerPath, readMarker, recoverRemember, remember } from "../../src/dream/remember.ts";
import { collectWorktrees, worktreeRoot } from "../../src/dream/worktree.ts";
import { git } from "../../src/git.ts";
import { newHostId, newStoreId } from "../../src/ids.ts";
import { appendEntry } from "../../src/journal/append.ts";
import { readStoreJournal } from "../../src/journal/read.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import type { HostIdentity } from "../../src/store/host.ts";
import { ensureStore } from "../../src/store/init.ts";
import type { ActiveScope } from "../../src/store/scopes.ts";

const execFileAsync = promisify(execFile);

let home: string;
let agentDir: string;
let storePath: string;
let host: HostIdentity;
let scope: ActiveScope;

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "muninn-remember-"));
	agentDir = join(home, "agent");
	storePath = join(agentDir, "muninn");
	mkdirSync(agentDir, { recursive: true });
	host = { id: newHostId(), name: "mbp", createdAt: "2026-08-01" };
	await ensureStore(storePath, { host });
	scope = { scope: "global", path: storePath, exists: true, inRepo: false };
	resetCommitDebounce();
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function model(claim: string): DreamModel {
	return {
		id: "test/mock",
		async complete(request) {
			const ids = [...request.prompt.matchAll(/\[(j-[0-9a-f-]+\.\d+)\]/g)].map((match) => match[1]);
			return `\`\`\`json\n${JSON.stringify([{ claim, evidence: ids, cue: "the tests" }])}\n\`\`\``;
		},
	};
}

async function note(text: string): Promise<void> {
	await appendEntry({ source: "user", prose: text, claims: [text], cue: "the tests" }, { storePath, hostId: host.id });
	resetCommitDebounce();
}

async function head(): Promise<string> {
	return (await git(storePath, { kind: "rev-parse", target: "HEAD" })).stdout.trim();
}

function options(now: Date, claim = "Run tests with `pnpm test --run`.") {
	return { scope, agentDir, host, storeId: newStoreId(), settings: DEFAULT_SETTINGS, now, model: model(claim) };
}

describe("remember", () => {
	it("lands a dream while capture kept committing — the third acceptance criterion", async () => {
		await note("Run tests with pnpm test --run.");
		const dreamed = await dream(options(new Date("2026-08-23T03:00:00Z")));
		expect(dreamed.ok).toBe(true);

		// Ten entries captured and committed while the branch existed, exactly
		// as a session would while a dream ran.
		for (let i = 0; i < 10; i++) await note(`Something else happened, number ${i}.`);
		const before = await head();

		const result = await remember({ scope, agentDir, host, branch: dreamed.branch });
		expect(result.problems).toEqual([]);
		expect(result.ok).toBe(true);
		expect(result.rebased).toBe(true);

		// The derived files are on disk and the store is clean against its HEAD:
		// `--ff-only` moves the ref, the index and the worktree together.
		expect(existsSync(join(storePath, "MEMORY.md"))).toBe(true);
		expect(readFileSync(join(storePath, "MEMORY.md"), "utf-8")).toContain("topics/");
		expect((await git(storePath, { kind: "status-porcelain", paths: [] })).stdout.trim()).toBe("");

		// Nothing was lost from the journal, and the dream commit sits on top.
		expect(readStoreJournal(storePath).entries).toHaveLength(11);
		const { stdout } = await execFileAsync("git", ["log", "--format=%s", "-1"], { cwd: storePath });
		expect(stdout.trim()).toMatch(/^dream:/);
		expect(await head()).not.toBe(before);
		expect(existsSync(markerPath(storePath))).toBe(false);
	});

	it("fast-forwards without a rebase when main did not move", async () => {
		await note("A note.");
		const dreamed = await dream(options(new Date("2026-08-23T03:00:00Z")));
		const result = await remember({ scope, agentDir, host, branch: dreamed.branch });
		expect(result.ok).toBe(true);
		expect(result.rebased).toBe(false);
	});

	it("deletes the branch it remembered, so it is not listed as pending", async () => {
		await note("A note.");
		const dreamed = await dream(options(new Date("2026-08-23T03:00:00Z")));
		await remember({ scope, agentDir, host, branch: dreamed.branch });

		const listed = await listDreams(storePath);
		expect(listed).toHaveLength(1);
		expect(listed[0]?.remembered).toBe(true);
		expect(listed[0]?.branch).toBeUndefined();
		expect((await rememberedDreams(storePath)).get(dreamed.stamp)).toBe(await head());
	});

	it("reports a branch that is not there rather than inventing one", async () => {
		const result = await remember({ scope, agentDir, host, branch: "dream/mbp/never-happened" });
		expect(result.ok).toBe(false);
		expect(result.problems.join(" ")).toContain("no such dream branch");
	});
});

describe("a dream fetched from another host", () => {
	it("is listed from its remote-tracking ref and remembered via a materialised local branch", async () => {
		// The recommended deployment: the server dreams overnight, the branch
		// travels on sync, the laptop remembers it. A worktree added from
		// `origin/dream/…` is a *detached* checkout — the rebase would move the
		// detached HEAD while the ref stayed put, and the rebased work would be
		// lost — so remember materialises a local branch first.
		await note("Run tests with pnpm test --run.");
		const dreamed = await dream(options(new Date("2026-08-23T03:00:00Z")));
		expect(dreamed.ok).toBe(true);

		// Push the dream branch to a bare remote, then delete the local branch —
		// which is exactly what this store looks like after the *other* host
		// dreamed and this one fetched.
		const remote = mkdtempSync(join(tmpdir(), "muninn-remote-"));
		try {
			await execFileAsync("git", ["init", "--bare", remote]);
			await git(storePath, { kind: "remote-add", name: "origin", url: remote });
			await git(storePath, { kind: "push-ref", remote: "origin", ref: dreamed.branch });
			// The finished dream's worktree still holds the branch; collect it
			// first, as the other host never had it at all.
			await collectWorktrees(storePath, { ownedRoot: worktreeRoot(agentDir) });
			await git(storePath, { kind: "branch-delete", name: dreamed.branch, force: true });

			const listed = await listDreams(storePath);
			expect(listed).toHaveLength(1);
			expect(listed[0]?.branch).toBe(`origin/${dreamed.branch}`);

			// Capture keeps writing, so the fetched dream needs the rebase path.
			await note("Committed after the other host dreamed.");
			const result = await remember({ scope, agentDir, host, branch: `origin/${dreamed.branch}` });
			expect(result.problems).toEqual([]);
			expect(result.ok).toBe(true);
			expect(result.notes.join(" ")).toContain("materialised");
			expect(readFileSync(join(storePath, "MEMORY.md"), "utf-8")).toContain("topics/");
		} finally {
			rmSync(remote, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("recovery", () => {
	it("clears a marker left by a remember that died before it applied", async () => {
		const sha = await head();
		writeFileSync(markerPath(storePath), JSON.stringify({ branch: "dream/mbp/x", mainSha: sha, at: "now" }));
		const recovery = await recoverRemember(storePath);
		expect(recovery.recovered).toBe(true);
		expect(recovery.message).toContain("nothing was changed");
		expect(existsSync(markerPath(storePath))).toBe(false);
	});

	it("restores the derived files when the ref moved but the worktree did not", async () => {
		await note("A note.");
		const dreamed = await dream(options(new Date("2026-08-23T03:00:00Z")));
		const before = await head();
		await remember({ scope, agentDir, host, branch: dreamed.branch });

		// The state a remember killed between the ref moving and the marker
		// being deleted leaves behind: HEAD is ahead of the marker's sha, and a
		// derived file on disk may be from before.
		writeFileSync(markerPath(storePath), JSON.stringify({ branch: dreamed.branch, mainSha: before, at: "now" }));
		writeFileSync(join(storePath, "MEMORY.md"), "torn half-write\n");

		const recovery = await recoverRemember(storePath);
		expect(recovery.recovered).toBe(true);
		expect(recovery.message).toContain("restored from HEAD");
		expect(readFileSync(join(storePath, "MEMORY.md"), "utf-8")).not.toContain("torn half-write");
		expect((await git(storePath, { kind: "status-porcelain", paths: [] })).stdout.trim()).toBe("");
	});

	it("never loses a journal entry while recovering", async () => {
		// The whole safety argument: a fast-forward from a dream branch changes
		// only derived paths, and `checkout-paths` is not allowed to name a
		// journal file — so recovery cannot reach one.
		await note("A note that must survive.");
		const dreamed = await dream(options(new Date("2026-08-23T03:00:00Z")));
		await remember({ scope, agentDir, host, branch: dreamed.branch });
		await note("An uncommitted note that must also survive.");

		writeFileSync(
			markerPath(storePath),
			JSON.stringify({ branch: dreamed.branch, mainSha: "0".repeat(40), at: "now" }),
		);
		await recoverRemember(storePath);
		expect(readStoreJournal(storePath).entries).toHaveLength(2);
	});

	it("runs at every store open, and says nothing when there is nothing to say", async () => {
		const result = await ensureStore(storePath, { host });
		expect(result.problems).toEqual([]);

		writeFileSync(markerPath(storePath), JSON.stringify({ branch: "dream/mbp/x", mainSha: await head(), at: "now" }));
		const second = await ensureStore(storePath, { host });
		expect(second.problems.join(" ")).toContain("died before it applied");
		expect(existsSync(markerPath(storePath))).toBe(false);
	});

	it("treats an unreadable marker as a marker", async () => {
		// The safe reading of "something is there but I cannot parse it" is that
		// a remember died, not that everything is fine.
		writeFileSync(markerPath(storePath), "{ not json");
		expect(readMarker(storePath)).toBeUndefined();
		const recovery = await recoverRemember(storePath);
		expect(recovery.recovered).toBe(true);
		expect(existsSync(markerPath(storePath))).toBe(false);
	});
});

describe("forget", () => {
	it("reverts a remembered dream, keeps the report, and leaves the journal alone", async () => {
		await note("A note.");
		const dreamed = await dream(options(new Date("2026-08-23T03:00:00Z")));
		await remember({ scope, agentDir, host, branch: dreamed.branch });
		const slug = dreamed.report.consolidated[0]?.topic as string;
		expect(existsSync(join(storePath, "topics", `${slug}.md`))).toBe(true);

		const result = await forget({ scope, host, stamp: dreamed.stamp, now: new Date("2026-08-25T09:00:00Z") });
		expect(result.problems).toEqual([]);
		expect(result.ok).toBe(true);

		// The derived work is gone; the report of why is not.
		expect(existsSync(join(storePath, "topics", `${slug}.md`))).toBe(false);
		const report = readFileSync(join(storePath, "dreams", `${dreamed.stamp}.md`), "utf-8");
		expect(report).toContain("forgotten: 2026-08-25");
		expect(readStoreJournal(storePath).entries).toHaveLength(1);

		const listed = await listDreams(storePath);
		expect(listed[0]?.forgotten).toBe(true);
	});

	it("leaves nothing half-applied when a revert conflicts", async () => {
		// The normal case once a later dream has been remembered: both rewrote
		// `MEMORY.md` wholesale. Left alone this wedges the store with conflict
		// markers in the one file every new session reads at start.
		await note("A note.");
		const first = await dream(options(new Date("2026-08-23T03:00:00Z"), "First fact."));
		await remember({ scope, agentDir, host, branch: first.branch });

		await note("A second note.");
		const second = await dream(options(new Date("2026-08-24T03:00:00Z"), "Second fact."));
		await remember({ scope, agentDir, host, branch: second.branch });

		const result = await forget({ scope, host, stamp: first.stamp, now: new Date("2026-08-25T09:00:00Z") });
		if (!result.ok) {
			expect(result.problems.join(" ")).toContain("forget that one first");
		}
		// Whatever happened, the store is usable: no conflict markers, no
		// unmerged index, and `MEMORY.md` is readable.
		expect((await git(storePath, { kind: "status-porcelain", paths: [] })).stdout.trim()).toBe("");
		expect(readFileSync(join(storePath, "MEMORY.md"), "utf-8")).not.toContain("<<<<<<<");
	});

	it("refuses to forget something that was never remembered", async () => {
		const result = await forget({ scope, host, stamp: "2026-01-01T00-00", now: new Date() });
		expect(result.ok).toBe(false);
		expect(result.problems.join(" ")).toContain("no remembered dream");
	});
});
