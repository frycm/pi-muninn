/** Deterministic Git/worktree provenance captured by code, never by a model. */
import { realpathSync } from "node:fs";
import { git, gitProjectContext } from "../git.ts";
import type { JournalGitProvenance } from "./record.ts";

export async function collectGitProvenance(cwd: string): Promise<JournalGitProvenance | undefined> {
	let canonicalCwd: string;
	try {
		canonicalCwd = realpathSync(cwd);
	} catch {
		return undefined;
	}
	const context = await gitProjectContext(canonicalCwd);
	if (!context) return undefined;

	let branch: string | null = null;
	let head: string | null = null;
	let dirty = false;
	try {
		branch = (await git(canonicalCwd, { kind: "current-branch" })).stdout.trim() || null;
	} catch {
		// Detached HEAD or bare repository.
	}
	try {
		head = (await git(canonicalCwd, { kind: "rev-parse", target: "HEAD" })).stdout.trim() || null;
	} catch {
		// Unborn repository.
	}
	try {
		dirty = (await git(canonicalCwd, { kind: "status-porcelain", paths: [] })).stdout.trim() !== "";
	} catch {
		// Bare repositories have no worktree status.
	}

	return {
		...(context.worktreeRoot ? { worktree: context.worktreeRoot } : {}),
		cwd: canonicalCwd,
		branch,
		head,
		dirty,
	};
}
