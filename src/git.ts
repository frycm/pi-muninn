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
	| { kind: "rev-parse"; target: "--show-toplevel" | "--is-inside-work-tree" | "HEAD" }
	| { kind: "log-count" };

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
			return ["init", "--quiet"];
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
			return ["rev-parse", command.target];
		case "log-count":
			return ["rev-list", "--count", "HEAD"];
	}
}

export interface GitResult {
	stdout: string;
	stderr: string;
}

/**
 * Run one allow-listed git command in `cwd`.
 *
 * The environment is trimmed so a store commit cannot inherit an ambient
 * identity or a hook path from the shell that happened to start pi.
 */
export async function git(cwd: string, command: GitCommand): Promise<GitResult> {
	const argv = toArgv(command);
	try {
		const { stdout, stderr } = await execFileAsync("git", argv, {
			cwd,
			env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
			maxBuffer: 8 * 1024 * 1024,
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
