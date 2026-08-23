/**
 * Which scopes are active here, and which one receives what this session captures.
 *
 * Exactly one scope is the *capture target*. The decision is small but it is
 * the one a user most needs to be able to interrogate — "why did that note go
 * to global?" — so every branch records a reason, and `/muninn scope` prints
 * them.
 *
 * Pure: existence checks are injected, nothing is created here. Deciding and
 * creating are separate so that a decision can be explained without side
 * effects.
 */
import type { MuninnSettings } from "../settings.ts";
import { globalStorePath, inRepoProjectStorePath, separateProjectStorePath } from "./paths.ts";

export type CaptureTarget = "global" | "project";

export interface ActiveScope {
	scope: CaptureTarget;
	path: string;
	/** True when the store directory already exists on disk. */
	exists: boolean;
	/** True when the store lives inside a repository Muninn does not own. */
	inRepo: boolean;
}

export interface ScopeDecision {
	active: ActiveScope[];
	captureTarget: CaptureTarget | null;
	/** One line per decision, in the order they were made. */
	reasons: string[];
}

export interface ResolveScopesInput {
	settings: MuninnSettings;
	agentDir: string;
	configDirName: string;
	/** The git work-tree root containing the session cwd, if any. */
	toplevel: string | undefined;
	/** `ctx.isProjectTrusted()` — pi's own project-trust decision. */
	projectTrusted: boolean;
	storeExists: (path: string) => boolean;
}

export function resolveScopes(input: ResolveScopesInput): ScopeDecision {
	const { settings, agentDir, configDirName, toplevel, projectTrusted, storeExists } = input;
	const active: ActiveScope[] = [];
	const reasons: string[] = [];

	// --- global ------------------------------------------------------------
	if (settings.scopes.global) {
		const path = globalStorePath(agentDir);
		active.push({ scope: "global", path, exists: storeExists(path), inRepo: false });
		reasons.push("global: active");
	} else {
		reasons.push("global: off (scopes.global is false)");
	}

	// --- project -----------------------------------------------------------
	const projectSetting = settings.scopes.project;
	if (projectSetting === false) {
		reasons.push("project: off (scopes.project is false)");
	} else if (toplevel === undefined) {
		reasons.push("project: off (cwd is not inside a git repository)");
	} else if (!projectTrusted) {
		// pi's own trust gate. An untrusted project must not be able to make
		// Muninn write into it, nor to have its memory read into a session.
		reasons.push("project: off (pi does not trust this project)");
	} else {
		const inRepo = projectSetting === "in-repo";
		const path = inRepo
			? inRepoProjectStorePath(toplevel, configDirName)
			: separateProjectStorePath(agentDir, toplevel);
		const exists = storeExists(path);
		active.push({ scope: "project", path, exists, inRepo });
		reasons.push(
			inRepo
				? `project: active, in-repo store at ${path}`
				: `project: active, separate store at ${path} (keyed by ${toplevel})`,
		);
		if (!exists && projectSetting === "auto") {
			reasons.push('project: store will be created on first capture (scopes.project is "auto")');
		}
	}

	// --- capture target ----------------------------------------------------
	// cwd inside a trusted project with an active project store -> project;
	// otherwise -> global.
	const project = active.find((scope) => scope.scope === "project");
	const global = active.find((scope) => scope.scope === "global");

	let captureTarget: CaptureTarget | null = null;
	if (project) {
		captureTarget = "project";
		reasons.push("capture target: project");
	} else if (global) {
		captureTarget = "global";
		reasons.push("capture target: global");
	} else {
		reasons.push("capture target: none — every scope is off, so nothing is captured");
	}

	return { active, captureTarget, reasons };
}
