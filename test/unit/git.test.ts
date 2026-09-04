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
		expect(toArgv({ kind: "clone", url: "ssh://git@example.com/team/journal.git" })).toEqual([
			"clone",
			"--quiet",
			"--no-local",
			"--",
			"ssh://git@example.com/team/journal.git",
			".",
		]);
		expect(toArgv({ kind: "ls-files-stage" })).toEqual(["ls-files", "--stage", "-z"]);
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
		expect(toArgv({ kind: "add", paths: ["journal/"] })).toEqual(["add", "-A", "--", "journal/"]);
		expect(toArgv({ kind: "rev-parse", target: "--show-toplevel" })).toEqual(["rev-parse", "--show-toplevel"]);
	});

	it("always limits a commit to a pathspec", () => {
		// The allow-list and pathspec keep the set of files a Muninn commit may
		// touch explicit and independently testable.
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

	it("refuses executable Git transport helpers during clone", () => {
		expect(() => toArgv({ kind: "clone", url: "ext::sh -c exploit" })).toThrow(/refusing/);
	});

	it("refuses credential-bearing remotes without echoing them", () => {
		const remote = "https://token@example.com/team/journal.git";
		try {
			toArgv({ kind: "clone", url: remote });
			expect.unreachable("credential-bearing remote should be rejected");
		} catch (error) {
			expect(String(error)).toContain("unsafe git remote");
			expect(String(error)).not.toContain("token@");
		}
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
		// a config value is still there.
		const dir = mkdtempSync(join(tmpdir(), "muninn-git-identity-"));
		try {
			await git(dir, { kind: "init" });
			await git(dir, { kind: "set-head", branch: "main" });
			writeFileSync(join(dir, "project.json"), '{"schema":1}\n');
			await git(dir, { kind: "add", paths: ["project.json"] });
			await git(
				dir,
				{ kind: "commit", message: "test", paths: ["project.json"] },
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
