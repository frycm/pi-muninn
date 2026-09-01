/** Durable identity and team metadata for a logical project journal store. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isProjectId } from "../ids.ts";

export const PROJECT_MANIFEST_SCHEMA = 1 as const;

export interface ProjectManifestMember {
	id: string;
	name: string;
}

export interface ProjectManifest {
	schema: typeof PROJECT_MANIFEST_SCHEMA;
	project: string;
	name: string;
	created_at: string;
	remote: string | null;
	members?: ProjectManifestMember[];
}

export function projectManifestPath(storePath: string): string {
	return join(storePath, "project.json");
}

function nonempty(value: unknown, at: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${at} must be a non-empty string`);
	return value;
}

export function parseProjectManifest(text: string, path = "project.json"): ProjectManifest {
	try {
		const raw = JSON.parse(text) as Record<string, unknown>;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("root must be an object");
		if (raw.schema !== PROJECT_MANIFEST_SCHEMA) throw new Error(`schema must be ${PROJECT_MANIFEST_SCHEMA}`);
		const project = nonempty(raw.project, "project");
		if (!isProjectId(project)) throw new Error("project must be a full UUIDv7");
		if (raw.remote !== null && typeof raw.remote !== "string") throw new Error("remote must be a string or null");
		const manifest: ProjectManifest = {
			schema: PROJECT_MANIFEST_SCHEMA,
			project,
			name: nonempty(raw.name, "name"),
			created_at: nonempty(raw.created_at, "created_at"),
			remote: raw.remote,
		};
		if (raw.members !== undefined) {
			if (!Array.isArray(raw.members)) throw new Error("members must be an array");
			manifest.members = raw.members.map((candidate, index) => {
				if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
					throw new Error(`members[${index}] must be an object`);
				}
				const member = candidate as Record<string, unknown>;
				return {
					id: nonempty(member.id, `members[${index}].id`),
					name: nonempty(member.name, `members[${index}].name`),
				};
			});
		}
		return manifest;
	} catch (error) {
		throw new Error(
			`muninn: project manifest at ${path} is invalid (${error instanceof Error ? error.message : String(error)})`,
		);
	}
}

export function formatProjectManifest(manifest: ProjectManifest): string {
	return `${JSON.stringify(parseProjectManifest(JSON.stringify(manifest)), null, "\t")}\n`;
}

export function readProjectManifest(storePath: string): ProjectManifest | undefined {
	const path = projectManifestPath(storePath);
	if (!existsSync(path)) return undefined;
	return parseProjectManifest(readFileSync(path, "utf-8"), path);
}

/** Create once; an existing manifest must identify the same project. */
export function ensureProjectManifest(
	storePath: string,
	project: { id: string; name: string; createdAt?: string },
): { manifest: ProjectManifest; created: boolean } {
	const path = projectManifestPath(storePath);
	const existing = readProjectManifest(storePath);
	if (existing) {
		if (existing.project !== project.id) {
			throw new Error(`muninn: ${path} belongs to project ${existing.project}, not ${project.id}`);
		}
		return { manifest: existing, created: false };
	}
	const manifest: ProjectManifest = {
		schema: PROJECT_MANIFEST_SCHEMA,
		project: project.id,
		name: project.name,
		created_at: project.createdAt ?? new Date().toISOString(),
		remote: null,
	};
	writeFileSync(path, formatProjectManifest(manifest), { flag: "wx", mode: 0o600 });
	return { manifest, created: true };
}
