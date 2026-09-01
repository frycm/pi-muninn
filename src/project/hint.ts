/**
 * A repository may suggest a logical project UUID, but cannot activate it.
 * Only the direct-user `project link` command reads this file.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isProjectId } from "../ids.ts";

export const PROJECT_HINT_PATH = join(".pi", "muninn-project.json");

export interface ProjectHint {
	project: string;
	name?: string;
}

export class ProjectHintError extends Error {
	constructor(path: string, detail: string, cause?: unknown) {
		super(`muninn: project hint at ${path} is invalid (${detail})`);
		this.name = "ProjectHintError";
		this.cause = cause;
	}
}

export function readProjectHint(root: string): ProjectHint | undefined {
	const path = join(root, PROJECT_HINT_PATH);
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("root must be an object");
		}
		const candidate = parsed as Record<string, unknown>;
		if (candidate.schema !== 1) throw new Error(`schema must be 1, found ${String(candidate.schema)}`);
		if (typeof candidate.project !== "string" || !isProjectId(candidate.project)) {
			throw new Error("project must be a full UUIDv7");
		}
		if (candidate.name !== undefined && (typeof candidate.name !== "string" || candidate.name.trim() === "")) {
			throw new Error("name must be a non-empty string when present");
		}
		return {
			project: candidate.project,
			...(typeof candidate.name === "string" ? { name: candidate.name.trim() } : {}),
		};
	} catch (error) {
		if (error instanceof ProjectHintError) throw error;
		throw new ProjectHintError(path, error instanceof Error ? error.message : String(error), error);
	}
}
