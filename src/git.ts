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
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Paths Muninn is allowed to stage, relative to a store root.
 *
 * Anything derived (`.index/`) is gitignored, and anything outside the store is
 * unreachable: `add` refuses an absolute path or one that climbs out.
 */
const STAGEABLE = new Set([
	".gitignore",
	"MEMORY.md",
	"store.md",
	"supersessions.md",
	"journal/",
	"topics/",
	"rules.md",
	"dreams/",
	"skills/",
]);

export type GitCommand =
	| { kind: "init" }
	| { kind: "config"; key: "user.name" | "user.email"; value: string }
	| { kind: "add"; paths: string[] }
	| { kind: "commit"; message: string; paths: string[] }
	| { kind: "status-porcelain"; paths: string[] }
	| { kind: "rev-parse"; target: "--show-toplevel" | "--is-inside-work-tree" | "HEAD" | "--abbrev-ref" }
	| { kind: "log-count" }
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
	/** Whether `ref` exists, for telling a first push from a rebase. */
	| { kind: "verify-ref"; ref: string };

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
 * with `-` is a flag. Both are refused: `sync.remote` is a setting, and a
 * setting must not be a way to run a program.
 */
function assertRemoteUrl(url: string): void {
	if (url.trim() === "" || url.startsWith("-") || /^ext::/i.test(url)) {
		throw new Error(`refusing to use "${url}" as a git remote`);
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
			// The branch name is pinned rather than inherited from
			// `init.defaultBranch`: a store is Muninn's own repository, and two
			// machines whose git defaults differ would otherwise create stores on
			// different branches and push two of them to one remote.
			return ["init", "--quiet", "--initial-branch=main"];
		case "config":
			// Setter only — there is no read form, so an empty value here would
			// silently blank the identity a store commits under.
			if (command.value.trim() === "") throw new Error(`git config ${command.key} needs a non-empty value`);
			return ["config", command.key, command.value];
		case "add":
			for (const path of command.paths) assertStageable(path);
			if (command.paths.length === 0) throw new Error("git add needs at least one path");
			return ["add", "--", ...command.paths];
		case "commit": {
			if (command.message.trim() === "") throw new Error("git commit needs a message");
			for (const path of command.paths) assertStageable(path);
			if (command.paths.length === 0) throw new Error("git commit needs a pathspec");
			// The pathspec is not decoration. An in-repo store lives inside the
			// user's own repository, where a bare `git commit` would sweep up
			// whatever they had staged for their own work. Limiting the commit to
			// Muninn's paths makes that impossible.
			return ["commit", "--quiet", "--no-gpg-sign", "-m", command.message, "--", ...command.paths];
		}
		case "status-porcelain":
			for (const path of command.paths) assertStageable(path);
			return command.paths.length === 0 ? ["status", "--porcelain"] : ["status", "--porcelain", "--", ...command.paths];
		case "rev-parse":
			return command.target === "--abbrev-ref" ? ["rev-parse", "--abbrev-ref", "HEAD"] : ["rev-parse", command.target];
		case "log-count":
			return ["rev-list", "--count", "HEAD"];

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
			// Every branch, not just ours: dream branches from other hosts travel
			// on the same fetch, and a bare remote with no branches yet — the
			// first sync of a new store — answers this happily where a named
			// refspec would fail.
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
			if (command.path.startsWith("-") || command.path.includes("..")) {
				throw new Error(`refusing to read "${command.path}" from the index`);
			}
			return ["show", `:${command.stage}:${command.path}`];
		case "verify-ref":
			assertName("ref", command.ref);
			return ["rev-parse", "--verify", "--quiet", command.ref];
	}
}

export interface GitResult {
	stdout: string;
	stderr: string;
}

export interface GitOptions {
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
	try {
		const { stdout, stderr } = await execFileAsync("git", argv, {
			cwd,
			env: {
				...process.env,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_TERMINAL_PROMPT: "0",
				// A rebase that stops to ask for a commit message would hang a
				// session shutdown forever; there is no terminal to answer it on.
				GIT_EDITOR: "true",
				GIT_SEQUENCE_EDITOR: "true",
			},
			maxBuffer: 8 * 1024 * 1024,
			...(options.signal ? { signal: options.signal } : {}),
		});
		return { stdout, stderr };
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr ?? "";
		throw new GitError(command, stderr, error);
	}
}

/** True when `path` is inside a git work tree. Never throws. */
export async function isGitRepository(path: string): Promise<boolean> {
	try {
		const { stdout } = await git(path, { kind: "rev-parse", target: "--is-inside-work-tree" });
		return stdout.trim() === "true";
	} catch {
		return false;
	}
}

/** The work-tree root containing `cwd`, or undefined when there is none. */
export async function gitToplevel(cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await git(cwd, { kind: "rev-parse", target: "--show-toplevel" });
		const toplevel = stdout.trim();
		return toplevel === "" ? undefined : toplevel;
	} catch {
		return undefined;
	}
}

/**
 * True when any of `paths` has staged or unstaged changes.
 *
 * Always pass a pathspec for a store that might be in-repo: an unscoped status
 * there reports the user's own work as if it were Muninn's.
 */
export async function hasChanges(cwd: string, paths: string[]): Promise<boolean> {
	const { stdout } = await git(cwd, { kind: "status-porcelain", paths });
	return stdout.trim() !== "";
}
