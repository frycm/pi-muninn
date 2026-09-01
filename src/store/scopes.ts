/**
 * Which scopes are active here, and which one receives this session's writes.
 *
 * Pure: project identity is resolved before this function. It only applies
 * settings and pi's trust gate, records the decision, and selects a target.
 */
import type { ResolvedProject } from "../project/resolver.ts";
import type { MuninnSettings } from "../settings.ts";
import { globalStorePath } from "./paths.ts";

export type CaptureTarget = "global" | "project";

export interface ActiveScope {
	scope: CaptureTarget;
	path: string;
	/** True when the store directory already exists on disk. */
	exists: boolean;
	/** Durable identity, present only for the logical-project scope. */
	projectId?: string;
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
	project: ResolvedProject | undefined;
	projectTrusted: boolean;
	storeExists: (path: string) => boolean;
}

export function resolveScopes(input: ResolveScopesInput): ScopeDecision {
	const { settings, agentDir, project, projectTrusted, storeExists } = input;
	const active: ActiveScope[] = [];
	const reasons: string[] = [];

	if (settings.scopes.global) {
		const path = globalStorePath(agentDir);
		active.push({ scope: "global", path, exists: storeExists(path) });
		reasons.push("global: active");
	} else {
		reasons.push("global: off (scopes.global is false)");
	}

	if (settings.scopes.project === false) {
		reasons.push("project: off (scopes.project is false)");
	} else if (!projectTrusted) {
		reasons.push("project: off (pi does not trust this project)");
	} else if (!project) {
		reasons.push("project: not linked yet (inspection did not create a registry mapping)");
	} else {
		const exists = storeExists(project.storePath);
		active.push({ scope: "project", path: project.storePath, exists, projectId: project.id });
		reasons.push(`project: active as ${project.id} (${project.reasonDetail})`);
		if (!exists) reasons.push("project: UUID store will be created on first capture");
	}

	const projectScope = active.find((scope) => scope.scope === "project");
	const global = active.find((scope) => scope.scope === "global");
	let captureTarget: CaptureTarget | null = null;
	if (projectScope) {
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
