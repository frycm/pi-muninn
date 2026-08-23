/**
 * Where stores live.
 *
 * Global is one directory under pi's agent dir. A project store is, by default,
 * a *separate* repository keyed by the project's git toplevel — memory is not
 * automatically something you commit into the project everyone clones. The
 * in-repo layout stays available for projects that do want memory in their
 * history, chosen with `scopes.project: "in-repo"`.
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export type ScopeName = "global" | "project" | "team";

/** `~/.pi/agent/muninn/` — `agentDir` comes from pi's `getAgentDir()`, so PI_CODING_AGENT_DIR is honoured. */
export function globalStorePath(agentDir: string): string {
	return join(agentDir, "muninn");
}

/** Where the host identity file lives. One per machine, outside any store. */
export function hostFilePath(agentDir: string): string {
	return join(agentDir, "muninn", "host.json");
}

/**
 * A stable, human-readable directory name for a project's separate store.
 *
 * The slug is for the human reading `ls`; the hash is what makes it unique. Two
 * checkouts of the same repository at different paths are deliberately
 * *different* stores: they may be different worktrees of different branches,
 * and silently sharing memory between them would be a surprise.
 */
export function projectStoreSlug(toplevel: string): string {
	const hash = createHash("sha256").update(toplevel).digest("hex").slice(0, 12);
	const name = basename(toplevel)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	return name === "" ? hash : `${name}-${hash}`;
}

/** The separate project store for a git toplevel. */
export function separateProjectStorePath(agentDir: string, toplevel: string): string {
	return join(agentDir, "muninn-projects", projectStoreSlug(toplevel));
}

/** The in-repo project store for a git toplevel. */
export function inRepoProjectStorePath(toplevel: string, configDirName: string): string {
	return join(toplevel, configDirName, "muninn");
}

/**
 * Whether a store exists at this path.
 *
 * The test is `store.md`, not the directory: the global store's directory also
 * holds `host.json`, which is minted the first time anything asks this machine
 * who it is — so the directory can exist on a machine that has never had a
 * store, and a caller that trusted the directory would try to sync one.
 */
export function storeExistsAt(path: string): boolean {
	return existsSync(join(path, "store.md"));
}

/**
 * The path the filesystem would actually open, or undefined when nothing is
 * there.
 *
 * Every boundary check in Muninn compares canonical paths, not lexical ones:
 * `resolve()` normalises `..` but knows nothing about symlinks, so a link
 * inside a store pointing anywhere on the disk passes a prefix test on the
 * resolved string and is then happily read. Only asking the filesystem catches
 * it.
 */
export function canonicalPath(path: string): string | undefined {
	try {
		return realpathSync(expandTilde(path));
	} catch {
		return undefined;
	}
}

/** `~/x` → `<home>/x`. Journal entries may carry a tilde path a human wrote. */
export function expandTilde(path: string, home: string = homedir()): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return resolve(home, path.slice(2));
	return path;
}

/** True when `target` is `root` itself or something inside it. Canonical paths only. */
export function isInside(root: string, target: string): boolean {
	return target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`);
}
