import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	branchSlug,
	collectWorktrees,
	createWorktree,
	dreamBranch,
	dreamStamp,
	parseWorktreeList,
	worktreeRoot,
} from "../../src/dream/worktree.ts";
import { git } from "../../src/git.ts";
import type { ActiveScope } from "../../src/store/scopes.ts";

const execFileAsync = promisify(execFile);

let home: string;
let agentDir: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "muninn-worktree-"));
	agentDir = join(home, "agent");
	mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const IDENTITY = { name: "muninn test", email: "muninn@test" };

/** A store Muninn owns: the store directory *is* the repository. */
async function ownedStore(): Promise<ActiveScope> {
	const path = join(home, "store");
	mkdirSync(path, { recursive: true });
	await git(path, { kind: "init" });
	await git(path, { kind: "set-head", branch: "main" });
	writeFileSync(join(path, "MEMORY.md"), "# Memory\n");
	writeFileSync(join(path, "store.md"), "schema: 1\n");
	mkdirSync(join(path, "journal", "h1"), { recursive: true });
	writeFileSync(join(path, "journal", "h1", "2026-08-22.md"), "## 10:00 · j-x\n");
	await git(path, { kind: "add", paths: ["MEMORY.md", "store.md", "journal/"] });
	await git(
		path,
		{ kind: "commit", message: "init", paths: ["MEMORY.md", "store.md", "journal/"] },
		{ identity: IDENTITY },
	);
	return { scope: "global", path, exists: true, inRepo: false };
}

/** An in-repo store: the repository is the user's project, the store a directory in it. */
async function inRepoStore(): Promise<{ scope: ActiveScope; toplevel: string }> {
	const toplevel = join(home, "project");
	const path = join(toplevel, ".pi", "muninn");
	mkdirSync(join(toplevel, "src"), { recursive: true });
	mkdirSync(path, { recursive: true });
	await git(toplevel, { kind: "init" });
	await git(toplevel, { kind: "set-head", branch: "main" });
	writeFileSync(join(toplevel, "README.md"), "# project\n");
	writeFileSync(join(toplevel, "src", "app.ts"), "export const a = 1;\n");
	writeFileSync(join(path, "MEMORY.md"), "# Memory\n");
	writeFileSync(join(path, "store.md"), "schema: 1\n");
	await execFileAsync("git", ["add", "-A"], { cwd: toplevel });
	await execFileAsync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init"], { cwd: toplevel });
	return { scope: { scope: "project", path, exists: true, inRepo: true, slug: "project-x" }, toplevel };
}

async function head(cwd: string): Promise<string> {
	return (await git(cwd, { kind: "rev-parse", target: "HEAD" })).stdout.trim();
}

describe("dream worktrees", () => {
	it("commits on its own branch and never in the store people are using", async () => {
		const scope = await ownedStore();
		const before = await head(scope.path);

		const worktree = await createWorktree({
			scope,
			agentDir,
			storeId: "0198a0b1",
			branch: "dream/mbp/2026-08-23T03-00",
			startPoint: "HEAD",
		});

		// Outside the store, under the agent dir — not inside the repository it
		// commits to, where git would see it as untracked content.
		expect(worktree.root.startsWith(worktreeRoot(agentDir))).toBe(true);
		expect(worktree.root.startsWith(scope.path)).toBe(false);
		expect(worktree.storePath).toBe(worktree.root);

		mkdirSync(join(worktree.storePath, "topics"), { recursive: true });
		writeFileSync(join(worktree.storePath, "topics", "testing.md"), "# Testing\n");
		await git(worktree.storePath, { kind: "add", paths: ["topics/"] });
		await git(
			worktree.storePath,
			{ kind: "commit", message: "dream: 1 fact", paths: ["topics/"] },
			{ identity: IDENTITY },
		);

		// `main` has not moved, and the main worktree has no topic file yet.
		expect(await head(scope.path)).toBe(before);
		expect(existsSync(join(scope.path, "topics", "testing.md"))).toBe(false);

		// Fast-forward: git moves the ref, the index and the worktree together.
		await git(scope.path, { kind: "merge-ff-only", ref: "dream/mbp/2026-08-23T03-00" });
		expect(readFileSync(join(scope.path, "topics", "testing.md"), "utf-8")).toBe("# Testing\n");
		expect((await git(scope.path, { kind: "status-porcelain", paths: [] })).stdout.trim()).toBe("");

		await worktree.remove();
		expect(existsSync(worktree.root)).toBe(false);
	});

	it("narrows an in-repo worktree to the store, so no project source is checked out", async () => {
		const { scope, toplevel } = await inRepoStore();
		const worktree = await createWorktree({
			scope,
			agentDir,
			storeId: "0198a0b2",
			branch: "dream/mbp/2026-08-23T04-00",
			startPoint: "HEAD",
		});

		expect(worktree.storePath).toBe(join(worktree.root, ".pi", "muninn"));
		expect(existsSync(join(worktree.storePath, "store.md"))).toBe(true);
		// The point of the narrowing: the user's tree is not copied — not the
		// sources, and not the root files cone mode would have kept either.
		expect(existsSync(join(worktree.root, "src"))).toBe(false);
		expect(existsSync(join(worktree.root, "README.md"))).toBe(false);

		writeFileSync(join(worktree.storePath, "MEMORY.md"), "# Memory\n\n- a fact\n");
		await git(worktree.storePath, { kind: "add", paths: ["MEMORY.md"] });
		await git(
			worktree.storePath,
			{ kind: "commit", message: "dream: 1 fact", paths: ["MEMORY.md"] },
			{ identity: IDENTITY },
		);

		// The commit landed on the dream branch of the *project's* repository,
		// touching one path inside the store and nothing of the project's own.
		const { stdout } = await execFileAsync("git", ["show", "--name-only", "--format=", "dream/mbp/2026-08-23T04-00"], {
			cwd: toplevel,
		});
		expect(stdout.trim()).toBe(".pi/muninn/MEMORY.md");

		await worktree.remove();
	});

	it("takes over the directory a dead dream left behind", async () => {
		const scope = await ownedStore();
		const first = await createWorktree({
			scope,
			agentDir,
			storeId: "s",
			branch: "dream/mbp/first",
			startPoint: "HEAD",
		});
		// A dream that died mid-write leaves a modified checkout, which is the
		// state `worktree remove` refuses without a force.
		writeFileSync(join(first.storePath, "MEMORY.md"), "half-written\n");

		// git answers with canonical paths, which on macOS is not the string the
		// worktree was created under — and the directory is gone afterwards, so
		// the comparison has to be taken while it is still there.
		const canonical = realpathSync(first.root);
		const removed = await collectWorktrees(scope.path);
		expect(removed).toEqual([canonical]);
		expect(existsSync(first.root)).toBe(false);

		// And the same path is usable again straight away.
		const second = await createWorktree({
			scope,
			agentDir,
			storeId: "s",
			branch: "dream/mbp/second",
			startPoint: "HEAD",
		});
		expect(readFileSync(join(second.storePath, "MEMORY.md"), "utf-8")).toBe("# Memory\n");
		await second.remove();
	});

	it("leaves worktrees that are not dreams' alone", async () => {
		const scope = await ownedStore();
		const other = join(home, "somebody-elses-worktree");
		await git(scope.path, { kind: "worktree-add", path: other, branch: "feature/x", startPoint: "HEAD" });
		expect(await collectWorktrees(scope.path)).toEqual([]);
		expect(existsSync(other)).toBe(true);
	});
});

describe("naming", () => {
	it("keys a branch and its report by the same stamp", () => {
		const stamp = dreamStamp(new Date("2026-08-23T03:04:05.678Z"));
		expect(stamp).toBe("2026-08-23T03-04");
		expect(dreamBranch("mbp", stamp)).toBe("dream/mbp/2026-08-23T03-04");
		expect(dreamBranch("mbp", stamp, true)).toBe("dream/mbp/2026-08-23T03-04-merge");
	});

	it("reduces a host name to something git will accept as a branch", () => {
		// Host names are display strings and may carry anything; a branch may not.
		expect(branchSlug("Martin's MBP.local")).toBe("martin-s-mbp-local");
		expect(branchSlug("...")).toBe("host");
		expect(branchSlug("ops-1")).toBe("ops-1");
	});

	it("reads a worktree listing, skipping the main worktree", () => {
		const listing = [
			"worktree /store",
			"HEAD abc",
			"branch refs/heads/main",
			"",
			"worktree /agent/muninn-worktrees/s/dream-mbp-x",
			"HEAD def",
			"branch refs/heads/dream/mbp/x",
			"",
			"worktree /agent/detached",
			"HEAD 123",
			"detached",
			"",
		].join("\n");
		expect(parseWorktreeList(listing)).toEqual([
			{ path: "/agent/muninn-worktrees/s/dream-mbp-x", branch: "dream/mbp/x" },
			{ path: "/agent/detached", branch: undefined },
		]);
	});
});
