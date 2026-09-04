/**
 * The only place Muninn runs git.
 *
 * The design promises that capture "never runs `git` with anything but
 * `add journal/` and `commit`". That promise is only worth something if it is
 * enforced somewhere, so every invocation goes through a discriminated union:
 * there is no way to hand this module an arbitrary argument list, and the set
 * of commands is readable in one screen.
 *
 * Arguments are passed as an array to `execFile` — never a shell string — so a
 * commit message or a path can never be interpreted as a flag or a command.
 * The allow-list is the second layer, not the first.
 *
 * (The plan schedules this module for step 7, with the journal commits it was
 * written for. Store initialisation in step 2 needs `init`, `config`, `add` and
 * `commit`, so it arrives early rather than letting step 2 shell out
 * unguarded.)
 */
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Paths Muninn is allowed to stage, relative to a store root.
 *
 * Anything derived (`.index/`) is gitignored, and anything outside the store is
 * unreachable: `add` refuses an absolute path or one that climbs out.
 */
const STAGEABLE = new Set([".gitignore", "project.json", "migration.json", "journal/"]);

export type GitCommand =
	| { kind: "init" }
	/** Clone one explicit journal URL into the empty working directory. */
	| { kind: "clone"; url: string }
	| { kind: "config"; key: "user.name" | "user.email"; value: string }
	| { kind: "add"; paths: string[] }
	| { kind: "commit"; message: string; paths: string[] }
	| { kind: "status-porcelain"; paths: string[] }
	| {
			kind: "rev-parse";
			target: "--show-toplevel" | "--git-common-dir" | "--is-inside-work-tree" | "HEAD";
	  }
	| { kind: "log-count" }
	/** NUL-delimited mode/object/stage/path rows for validating an untrusted clone. */
	| { kind: "ls-files-stage" }
	/** The branch HEAD points at — works on an unborn branch, fails when detached. */
	| { kind: "current-branch" }
	/** Point an unborn HEAD at a branch: `git init` on any git version, without `--initial-branch`. */
	| { kind: "set-head"; branch: string }
	/** Rename the current branch. */
	| { kind: "branch-rename"; to: string }
	// --- sync -------------------------------------------------------------
	| { kind: "remote-get-url"; name: string }
	| { kind: "remote-add"; name: string; url: string }
	| { kind: "remote-set-url"; name: string; url: string }
	| { kind: "fetch"; remote: string }
	| { kind: "rebase"; onto: string }
	| { kind: "rebase-continue" }
	| { kind: "rebase-abort" }
	| { kind: "push"; remote: string; branch: string }
	/** Read one side of a conflicted file: 2 is ours, 3 is theirs. */
	| { kind: "show-stage"; stage: 2 | 3; path: string }
	/** Read a file as of a ref, without checking anything out. */
	| { kind: "show-file"; ref: string; path: string }
	/** Whether `ref` exists, for telling a first push from a rebase. */
	| { kind: "verify-ref"; ref: string };

/**
 * git itself is not on the PATH.
 *
 * Distinguished from every other git failure because the answer is different:
 * nothing about a store works without git, and reporting it as "not a git
 * repository" — which is what a swallowed ENOENT looks like — would send
 * whoever reads it looking in exactly the wrong place.
 */
export class GitMissingError extends Error {
	constructor(cause?: unknown) {
		super("git is not installed or not on PATH; muninn stores are git repositories and cannot be used without it");
		this.name = "GitMissingError";
		this.cause = cause;
	}
}

export class GitError extends Error {
	readonly stderr: string;
	readonly command: GitCommand;
	constructor(command: GitCommand, stderr: string, cause?: unknown) {
		super(`git ${command.kind} failed: ${stderr.trim() || String(cause)}`);
		this.name = "GitError";
		this.stderr = stderr;
		this.command = command;
	}
}

/**
 * A remote name or a branch name, as git will accept it.
 *
 * Neither may look like a flag or carry a shell-significant character. The
 * argv array already makes injection impossible; this is the second layer, and
 * the one that turns a typo into an error instead of a strange git invocation.
 */
const GIT_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function assertName(kind: string, value: string): void {
	if (!GIT_NAME.test(value)) throw new Error(`refusing to run git ${kind} with the name "${value}"`);
}

/**
 * A remote URL Muninn is willing to hand git.
 *
 * `ext::` and other transport helpers execute a command; a URL that starts
 * with `-` is a flag. Both are refused: project remote metadata must not be a
 * way to run a program.
 */
function assertRemoteUrl(url: string): void {
	if (url.trim() === "" || url.startsWith("-") || /^ext::/i.test(url)) {
		throw new Error(`refusing to use "${url}" as a git remote`);
	}
}

function assertReadablePath(path: string): void {
	if (path.startsWith("-") || path.startsWith("/") || path.includes("..")) {
		throw new Error(`refusing to read "${path}" out of the repository`);
	}
}

function assertStageable(path: string): void {
	if (path.startsWith("/") || path.startsWith("-") || path.includes("..")) {
		throw new Error(`refusing to stage path outside the store: ${path}`);
	}
	if (!STAGEABLE.has(path)) {
		throw new Error(`refusing to stage "${path}": not in the allow-list`);
	}
}

/** Translate a command into an argv. Exported so a test can assert the mapping. */
export function toArgv(command: GitCommand): string[] {
	switch (command.kind) {
		case "init":
			// The branch is pinned by a `set-head` right after, not by
			// `--initial-branch`: that flag needs git ≥ 2.28, and a symbolic-ref
			// on the unborn HEAD does the same on any version.
			return ["init", "--quiet"];
		case "clone":
			assertRemoteUrl(command.url);
			return ["clone", "--quiet", "--no-local", "--", command.url, "."];
		case "config":
			// Setter only — there is no read form, so an empty value here would
			// silently blank the identity a store commits under.
			if (command.value.trim() === "") throw new Error(`git config ${command.key} needs a non-empty value`);
			return ["config", command.key, command.value];
		case "add":
			for (const path of command.paths) assertStageable(path);
			if (command.paths.length === 0) throw new Error("git add needs at least one path");
			return ["add", "-A", "--", ...command.paths];
		case "commit": {
			if (command.message.trim() === "") throw new Error("git commit needs a message");
			for (const path of command.paths) assertStageable(path);
			if (command.paths.length === 0) throw new Error("git commit needs a pathspec");
			// The pathspec is not decoration: limiting the commit to Muninn's
			// allowlisted files makes the boundary independently enforceable.
			return ["commit", "--quiet", "--no-gpg-sign", "-m", command.message, "--", ...command.paths];
		}
		case "status-porcelain":
			for (const path of command.paths) assertStageable(path);
			return command.paths.length === 0 ? ["status", "--porcelain"] : ["status", "--porcelain", "--", ...command.paths];
		case "rev-parse":
			return ["rev-parse", command.target];
		case "log-count":
			return ["rev-list", "--count", "HEAD"];
		case "ls-files-stage":
			return ["ls-files", "--stage", "-z"];
		case "current-branch":
			return ["symbolic-ref", "--short", "HEAD"];
		case "set-head":
			assertName("branch", command.branch);
			return ["symbolic-ref", "HEAD", `refs/heads/${command.branch}`];
		case "branch-rename":
			assertName("branch", command.to);
			return ["branch", "-M", command.to];

		case "remote-get-url":
			assertName("remote", command.name);
			return ["remote", "get-url", command.name];
		case "remote-add":
			assertName("remote", command.name);
			assertRemoteUrl(command.url);
			return ["remote", "add", command.name, command.url];
		case "remote-set-url":
			assertName("remote", command.name);
			assertRemoteUrl(command.url);
			return ["remote", "set-url", command.name, command.url];
		case "fetch":
			assertName("remote", command.remote);
			// A bare remote with no branches yet — the first sync of a new store —
			// answers this happily where a named refspec would fail.
			return ["fetch", "--quiet", command.remote];
		case "rebase":
			assertName("ref", command.onto);
			return ["rebase", command.onto];
		case "rebase-continue":
			return ["rebase", "--continue"];
		case "rebase-abort":
			return ["rebase", "--abort"];
		case "push":
			assertName("remote", command.remote);
			assertName("branch", command.branch);
			// `HEAD:<branch>` and never `--force`: sync fast-forwards the remote or
			// it reports. Losing another host's commits is not a thing Muninn does.
			return ["push", "--quiet", command.remote, `HEAD:${command.branch}`];
		case "show-stage":
			assertReadablePath(command.path);
			return ["show", `:${command.stage}:${command.path}`];
		case "show-file":
			assertName("ref", command.ref);
			assertReadablePath(command.path);
			return ["show", `${command.ref}:${command.path}`];
		case "verify-ref":
			assertName("ref", command.ref);
			return ["rev-parse", "--verify", "--quiet", command.ref];
	}
}

export interface GitResult {
	stdout: string;
	stderr: string;
}

/** Who a commit is attributed to, for the stores Muninn owns. */
export interface GitIdentity {
	name: string;
	email: string;
}

export interface GitOptions {
	/**
	 * The identity commits and rebases are made under.
	 *
	 * Passed through the environment rather than written to the repository's
	 * config: it is needed only by the commands that create commits, and
	 * supplying it there means no subprocess has to run on every session start
	 * to make sure a config value is still set.
	 */
	identity?: GitIdentity;
	/**
	 * Abort signal for the network operations.
	 *
	 * Only `fetch` and `push` are ever killed this way: they touch the network
	 * and leave nothing half-applied in the working tree. A `rebase` is never
	 * interrupted mid-flight — a killed rebase leaves a repository in a state
	 * the next run has to clean up, which is exactly what the 10 s shutdown cap
	 * is trying to avoid.
	 */
	signal?: AbortSignal;
}

/**
 * Run one allow-listed git command in `cwd`.
 *
 * The environment is trimmed so a store commit cannot inherit an ambient
 * identity or a hook path from the shell that happened to start pi.
 */
export async function git(cwd: string, command: GitCommand, options: GitOptions = {}): Promise<GitResult> {
	const argv = toArgv(command);
	const identity = options.identity
		? {
				GIT_AUTHOR_NAME: options.identity.name,
				GIT_AUTHOR_EMAIL: options.identity.email,
				GIT_COMMITTER_NAME: options.identity.name,
				GIT_COMMITTER_EMAIL: options.identity.email,
			}
		: {};
	try {
		const { stdout, stderr } = await execFileAsync("git", argv, {
			cwd,
			env: {
				...process.env,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_TERMINAL_PROMPT: "0",
				GIT_ALLOW_PROTOCOL: "file:ssh:https:http:git",
				// A rebase that stops to ask for a commit message would hang a
				// session shutdown forever; there is no terminal to answer it on.
				GIT_EDITOR: "true",
				GIT_SEQUENCE_EDITOR: "true",
				...identity,
			},
			maxBuffer: 8 * 1024 * 1024,
			...(options.signal ? { signal: options.signal } : {}),
		});
		return { stdout, stderr };
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr ?? "";
		if (
			(error as NodeJS.ErrnoException).code === "ENOENT" &&
			(error as { syscall?: string }).syscall?.includes("spawn")
		) {
			// Node reports a missing *working directory* with the same ENOENT as
			// a missing binary. The two have opposite remedies, so look.
			if (!existsSync(cwd)) throw new GitError(command, `working directory does not exist: ${cwd}`, error);
			throw new GitMissingError(error);
		}
		throw new GitError(command, stderr, error);
	}
}

/**
 * True when `path` is inside a git work tree.
 *
 * Never throws — except when git itself is missing, which is not an answer to
 * the question that was asked and must not be reported as "no".
 */
export async function isGitRepository(path: string): Promise<boolean> {
	try {
		const { stdout } = await git(path, { kind: "rev-parse", target: "--is-inside-work-tree" });
		return stdout.trim() === "true";
	} catch (error) {
		if (error instanceof GitMissingError) throw error;
		return false;
	}
}

/**
 * The work-tree root containing `cwd`, or undefined when there is none.
 *
 * This one *does* swallow a missing git: it runs at session start to decide
 * whether a project scope exists, and a machine without git should get a
 * clear problem from the store it tries to open, not a session that refuses
 * to start.
 */
export async function gitToplevel(cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await git(cwd, { kind: "rev-parse", target: "--show-toplevel" });
		const toplevel = stdout.trim();
		return toplevel === "" ? undefined : toplevel;
	} catch {
		return undefined;
	}
}

export interface GitProjectContext {
	/** Canonical worktree root. Absent for a bare repository. */
	worktreeRoot?: string;
	/** Canonical directory shared by every linked worktree. */
	commonDir: string;
}

/**
 * The Git identity inputs for a logical project.
 *
 * `--show-toplevel` changes between linked worktrees; `--git-common-dir` does
 * not. Both outputs are canonicalized before they cross the registry boundary,
 * including a relative common-dir result and symlinked session paths.
 */
export async function gitProjectContext(cwd: string): Promise<GitProjectContext | undefined> {
	let commonText: string;
	try {
		commonText = (await git(cwd, { kind: "rev-parse", target: "--git-common-dir" })).stdout.trim();
	} catch (error) {
		if (error instanceof GitMissingError) throw error;
		return undefined;
	}
	if (commonText === "") return undefined;

	const commonCandidate = isAbsolute(commonText) ? commonText : resolve(cwd, commonText);
	let commonDir: string;
	try {
		commonDir = realpathSync(commonCandidate);
	} catch {
		return undefined;
	}

	let worktreeRoot: string | undefined;
	try {
		const text = (await git(cwd, { kind: "rev-parse", target: "--show-toplevel" })).stdout.trim();
		if (text !== "") worktreeRoot = realpathSync(text);
	} catch {
		// A bare repository has a common directory but no worktree root.
	}

	return { commonDir, ...(worktreeRoot ? { worktreeRoot } : {}) };
}

/**
 * True when any of `paths` has staged or unstaged changes.
 *
 * Always pass a pathspec so a status check stays inside Muninn-owned files.
 */
export async function hasChanges(cwd: string, paths: string[]): Promise<boolean> {
	const { stdout } = await git(cwd, { kind: "status-porcelain", paths });
	return stdout.trim() !== "";
}
