/**
 * Where stores live.
 *
 * Global is one directory under pi's agent dir. Logical project stores are
 * user-owned repositories named by an opaque project UUID; checkout paths are
 * aliases in the registry, never durable identity or store names.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export type ScopeName = "global" | "project" | "team";

/** `~/.pi/agent/muninn/` — `agentDir` comes from pi's `getAgentDir()`, so PI_CODING_AGENT_DIR is honoured. */
export function globalStorePath(agentDir: string): string {
	return join(agentDir, "muninn");
}

/** Where the host identity file lives. One per machine, outside any store. */
export function hostFilePath(agentDir: string): string {
	return join(agentDir, "muninn", "host.json");
}

/** User-owned registry and project stores. Repository content never selects this root. */
export function projectsRootPath(agentDir: string): string {
	return join(agentDir, "muninn-projects");
}

export function projectRegistryPath(agentDir: string): string {
	return join(projectsRootPath(agentDir), "registry.json");
}

export function projectStorePath(agentDir: string, projectId: string): string {
	return join(projectsRootPath(agentDir), projectId);
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
	// The platform separator, not `/`: `realpathSync` answers with backslashes
	// on Windows, and a test against `/` would refuse every nested file there.
	return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
