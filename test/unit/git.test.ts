import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitError, git, toArgv } from "../../src/git.ts";

const execFileAsync = promisify(execFile);

describe("toArgv — the allow-list is the promise", () => {
	it("maps each command to a fixed argv", () => {
		expect(toArgv({ kind: "init" })).toEqual(["init", "--quiet"]);
		// The branch is pinned by a symbolic-ref on the unborn HEAD — works on any
		// git, where `--initial-branch` needs ≥ 2.28 — so two machines with
		// different defaults never create stores on different branches.
		expect(toArgv({ kind: "set-head", branch: "main" })).toEqual(["symbolic-ref", "HEAD", "refs/heads/main"]);
		expect(toArgv({ kind: "current-branch" })).toEqual(["symbolic-ref", "--short", "HEAD"]);
		expect(toArgv({ kind: "branch-rename", to: "main" })).toEqual(["branch", "-M", "main"]);
		expect(toArgv({ kind: "config", key: "user.name", value: "muninn mbp" })).toEqual([
			"config",
			"user.name",
			"muninn mbp",
		]);
		expect(toArgv({ kind: "add", paths: ["journal/"] })).toEqual(["add", "--", "journal/"]);
		expect(toArgv({ kind: "rev-parse", target: "--show-toplevel" })).toEqual(["rev-parse", "--show-toplevel"]);
	});

	it("always limits a commit to a pathspec", () => {
		// Without this an in-repo store would commit whatever the user had staged
		// for their own work the moment Muninn wrote a journal entry.
		const argv = toArgv({ kind: "commit", message: "journal: mbp 2 entries", paths: ["journal/"] });
		expect(argv).toEqual(["commit", "--quiet", "--no-gpg-sign", "-m", "journal: mbp 2 entries", "--", "journal/"]);
		expect(argv).toContain("--");
	});

	it("refuses a commit with no pathspec", () => {
		expect(() => toArgv({ kind: "commit", message: "everything", paths: [] })).toThrow(/pathspec/);
	});

	it("refuses a commit with no message", () => {
		expect(() => toArgv({ kind: "commit", message: "  ", paths: ["journal/"] })).toThrow(/message/);
	});

	it("refuses to stage a path outside the store", () => {
		expect(() => toArgv({ kind: "add", paths: ["../../etc/passwd"] })).toThrow(/outside the store/);
		expect(() => toArgv({ kind: "add", paths: ["/etc/passwd"] })).toThrow(/outside the store/);
	});

	it("refuses to stage a path that is not in the allow-list", () => {
		expect(() => toArgv({ kind: "add", paths: ["src/"] })).toThrow(/allow-list/);
		expect(() => toArgv({ kind: "add", paths: ["."] })).toThrow(/allow-list/);
		expect(() => toArgv({ kind: "add", paths: [".index/"] })).toThrow(/allow-list/);
	});

	it("refuses a path that could be read as a flag", () => {
		expect(() => toArgv({ kind: "add", paths: ["--all"] })).toThrow(/outside the store/);
	});

	it("maps every dream verb to a fixed argv", () => {
		expect(
			toArgv({ kind: "worktree-add", path: "/tmp/wt", branch: "dream/mbp/2026-08-23T03-00", startPoint: "abc123" }),
		).toEqual(["worktree", "add", "--quiet", "-b", "dream/mbp/2026-08-23T03-00", "/tmp/wt", "abc123"]);
		expect(
			toArgv({ kind: "worktree-add", path: "/tmp/wt", branch: "dream/mbp/x", startPoint: "HEAD", noCheckout: true }),
		).toEqual(["worktree", "add", "--quiet", "--no-checkout", "-b", "dream/mbp/x", "/tmp/wt", "HEAD"]);
		expect(toArgv({ kind: "worktree-remove", path: "/tmp/wt", force: true })).toEqual([
			"worktree",
			"remove",
			"--force",
			"/tmp/wt",
		]);
		expect(toArgv({ kind: "worktree-prune" })).toEqual(["worktree", "prune"]);
		expect(toArgv({ kind: "worktree-list" })).toEqual(["worktree", "list", "--porcelain"]);
		// `--no-cone`: cone mode keeps every file at the repository root, and the
		// point of narrowing an in-repo worktree is that only the store appears.
		expect(toArgv({ kind: "sparse-checkout-set", paths: ["/.pi/muninn/"] })).toEqual([
			"sparse-checkout",
			"set",
			"--no-cone",
			"/.pi/muninn/",
		]);
		expect(toArgv({ kind: "checkout-head" })).toEqual(["checkout", "--quiet"]);
		expect(toArgv({ kind: "branch-list", prefix: "dream/" })).toEqual([
			"for-each-ref",
			"--sort=-committerdate",
			"--format=%(refname:short)",
			"refs/heads/dream/**",
		]);
		expect(toArgv({ kind: "branch-delete", name: "dream/mbp/x", force: true })).toEqual([
			"branch",
			"-D",
			"dream/mbp/x",
		]);
		expect(toArgv({ kind: "merge-ff-only", ref: "dream/mbp/x" })).toEqual([
			"merge",
			"--ff-only",
			"--quiet",
			"dream/mbp/x",
		]);
		expect(toArgv({ kind: "revert", sha: "abc123" })).toEqual(["revert", "--no-edit", "--no-gpg-sign", "abc123"]);
		expect(toArgv({ kind: "merge-base", a: "main", b: "dream/mbp/x" })).toEqual(["merge-base", "main", "dream/mbp/x"]);
		expect(toArgv({ kind: "log-entries", ref: "main", limit: 5 })).toEqual([
			"log",
			"--max-count=5",
			"--format=%H%x1f%s%x1f%b%x1e",
			"main",
		]);
		expect(toArgv({ kind: "worktree-add-existing", path: "/tmp/wt", branch: "dream/mbp/x" })).toEqual([
			"worktree",
			"add",
			"--quiet",
			"/tmp/wt",
			"dream/mbp/x",
		]);
	});

	it("takes a range only where a range belongs", () => {
		// `..` is an escape attempt everywhere else in this module; it is legal in
		// exactly this position, and still only in the shape of a range.
		expect(toArgv({ kind: "diff-name-only", range: "abc..def", paths: ["journal/"] })).toEqual([
			"diff",
			"--name-only",
			"abc..def",
			"--",
			"journal/",
		]);
		expect(toArgv({ kind: "rev-list-count", range: "abc...def", paths: ["journal/"] })).toEqual([
			"rev-list",
			"--count",
			"abc...def",
			"--",
			"journal/",
		]);
		expect(() => toArgv({ kind: "diff-name-only", range: "../../etc", paths: ["journal/"] })).toThrow(/range/);
		expect(() => toArgv({ kind: "diff-name-only", range: "--all", paths: ["journal/"] })).toThrow(/range/);
		expect(() => toArgv({ kind: "rev-list-count", range: "main", paths: ["src/"] })).toThrow(/allow-list/);
	});

	it("restores derived paths only, so recovery can never lose a journal entry", () => {
		expect(toArgv({ kind: "checkout-paths", ref: "HEAD", paths: ["MEMORY.md", "topics/"] })).toEqual([
			"checkout",
			"HEAD",
			"--",
			"MEMORY.md",
			"topics/",
		]);
		// The whole safety argument for `checkout HEAD -- …` during a half-applied
		// remember is that it cannot name the journal. It has to be enforced.
		expect(() => toArgv({ kind: "checkout-paths", ref: "HEAD", paths: ["journal/"] })).toThrow(/derived/);
		expect(() => toArgv({ kind: "checkout-paths", ref: "HEAD", paths: ["store.md"] })).toThrow(/derived/);
		expect(() => toArgv({ kind: "checkout-paths", ref: "HEAD", paths: [] })).toThrow(/at least one path/);
	});

	it("refuses a worktree path that is not absolute, and a narrowing that climbs out", () => {
		// A relative worktree path is resolved against the repository, which is
		// how a checkout ends up inside the store it was meant to stay out of.
		expect(() => toArgv({ kind: "worktree-add", path: "wt", branch: "dream/a/b", startPoint: "HEAD" })).toThrow(
			/worktree path/,
		);
		expect(() =>
			toArgv({ kind: "worktree-add", path: "/tmp/../etc/wt", branch: "dream/a/b", startPoint: "HEAD" }),
		).toThrow(/worktree path/);
		expect(() => toArgv({ kind: "sparse-checkout-set", paths: ["/../etc/"] })).toThrow(/narrow/);
		// Unanchored would also match a `.pi/muninn/` nested anywhere in the project.
		expect(() => toArgv({ kind: "sparse-checkout-set", paths: [".pi/muninn/"] })).toThrow(/narrow/);
		expect(() => toArgv({ kind: "sparse-checkout-set", paths: ["/.pi/muninn"] })).toThrow(/narrow/);
		expect(() => toArgv({ kind: "sparse-checkout-set", paths: [] })).toThrow(/at least one path/);
	});

	it("refuses an empty add", () => {
		expect(() => toArgv({ kind: "add", paths: [] })).toThrow(/at least one path/);
	});

	it("scopes status to a pathspec when one is given", () => {
		expect(toArgv({ kind: "status-porcelain", paths: ["journal/"] })).toEqual([
			"status",
			"--porcelain",
			"--",
			"journal/",
		]);
	});

	it("passes arguments as argv, never as a shell string", () => {
		// Nothing is quoted or escaped anywhere in this module, which is only safe
		// because execFile receives an array. A message full of shell syntax must
		// survive verbatim.
		const nasty = 'journal: $(rm -rf /) && echo "; drop table"';
		const argv = toArgv({ kind: "commit", message: nasty, paths: ["journal/"] });
		expect(argv).toContain(nasty);
	});
});

describe("git — identity travels in the environment", () => {
	it("sets author and committer for the commands that create commits", async () => {
		// Passed through the environment rather than written to the repository
		// on every open: no subprocess has to run at session start to make sure
		// a config value is still there, and an in-repo store simply passes none
		// and keeps the project's own author.
		const dir = mkdtempSync(join(tmpdir(), "muninn-git-identity-"));
		try {
			await git(dir, { kind: "init" });
			await git(dir, { kind: "set-head", branch: "main" });
			writeFileSync(join(dir, "MEMORY.md"), "# Memory\n");
			await git(dir, { kind: "add", paths: ["MEMORY.md"] });
			await git(
				dir,
				{ kind: "commit", message: "test", paths: ["MEMORY.md"] },
				{ identity: { name: "muninn mbp", email: "muninn@host" } },
			);
			const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%an <%ae> %cn"], { cwd: dir });
			expect(stdout.trim()).toBe("muninn mbp <muninn@host> muninn mbp");
			const { stdout: branch } = await execFileAsync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: dir });
			expect(branch.trim()).toBe("main");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("tells a missing working directory apart from a missing git", async () => {
		// Node reports both as `spawn git ENOENT`; the remedies are opposite.
		const failure = await git("/nonexistent/muninn-store", { kind: "rev-parse", target: "HEAD" }).catch(
			(e: Error) => e,
		);
		expect(failure).toBeInstanceOf(GitError);
		expect((failure as Error).message).toContain("working directory does not exist");
	});
});
