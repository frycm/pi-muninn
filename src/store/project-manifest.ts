/** Durable identity, writer ownership and team metadata for a project journal. */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isHostId, isMemberId, isProjectId } from "../ids.ts";
import { isUsableRemote } from "../settings.ts";

export const PROJECT_MANIFEST_SCHEMA = 1 as const;
const RFC3339_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface ProjectManifestMember {
	id: string;
	name: string;
}

export interface ProjectManifestHost {
	id: string;
	name: string;
	member: string;
}

export interface ProjectManifest {
	schema: typeof PROJECT_MANIFEST_SCHEMA;
	project: string;
	name: string;
	created_at: string;
	remote: string | null;
	members: ProjectManifestMember[];
	hosts: ProjectManifestHost[];
}

export function projectManifestPath(storePath: string): string {
	return join(storePath, "project.json");
}

function nonempty(value: unknown, at: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${at} must be a non-empty string`);
	return value;
}

function members(value: unknown): ProjectManifestMember[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("members must be an array");
	return value.map((candidate, index) => {
		if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
			throw new Error(`members[${index}] must be an object`);
		}
		const member = candidate as Record<string, unknown>;
		const id = nonempty(member.id, `members[${index}].id`);
		if (!isMemberId(id)) throw new Error(`members[${index}].id must be a member UUIDv7`);
		return { id, name: nonempty(member.name, `members[${index}].name`) };
	});
}

function hosts(value: unknown): ProjectManifestHost[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("hosts must be an array");
	return value.map((candidate, index) => {
		if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
			throw new Error(`hosts[${index}] must be an object`);
		}
		const host = candidate as Record<string, unknown>;
		const id = nonempty(host.id, `hosts[${index}].id`);
		const member = nonempty(host.member, `hosts[${index}].member`);
		if (!isHostId(id)) throw new Error(`hosts[${index}].id must be a host UUIDv7`);
		if (!isMemberId(member)) throw new Error(`hosts[${index}].member must be a member UUIDv7`);
		return { id, name: nonempty(host.name, `hosts[${index}].name`), member };
	});
}

function uniqueById<T extends { id: string }>(items: T[], kind: string): T[] {
	const found = new Map<string, T>();
	for (const item of items) {
		const prior = found.get(item.id);
		if (prior && JSON.stringify(prior) !== JSON.stringify(item)) {
			throw new Error(`${kind} id collision for ${item.id}`);
		}
		found.set(item.id, item);
	}
	return [...found.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function parseProjectManifest(text: string, path = "project.json"): ProjectManifest {
	try {
		const raw = JSON.parse(text) as Record<string, unknown>;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("root must be an object");
		if (raw.schema !== PROJECT_MANIFEST_SCHEMA) throw new Error(`schema must be ${PROJECT_MANIFEST_SCHEMA}`);
		const project = nonempty(raw.project, "project");
		if (!isProjectId(project)) throw new Error("project must be a full UUIDv7");
		const createdAt = nonempty(raw.created_at, "created_at");
		if (!RFC3339_MILLIS.test(createdAt) || Number.isNaN(Date.parse(createdAt))) {
			throw new Error("created_at must be an RFC 3339 UTC timestamp with milliseconds");
		}
		if (raw.remote !== null && typeof raw.remote !== "string") throw new Error("remote must be a string or null");
		if (typeof raw.remote === "string" && !isUsableRemote(raw.remote)) throw new Error("remote is not a safe Git URL");
		const parsedMembers = uniqueById(members(raw.members), "member");
		const parsedHosts = uniqueById(hosts(raw.hosts), "host");
		for (const host of parsedHosts) {
			if (!parsedMembers.some((member) => member.id === host.member)) {
				throw new Error(`host ${host.id} names unknown member ${host.member}`);
			}
		}
		return {
			schema: PROJECT_MANIFEST_SCHEMA,
			project,
			name: nonempty(raw.name, "name"),
			created_at: createdAt,
			remote: raw.remote as string | null,
			members: parsedMembers,
			hosts: parsedHosts,
		};
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

export interface ProjectManifestIdentity {
	id: string;
	name: string;
	createdAt?: string;
	member?: ProjectManifestMember;
	host?: { id: string; name: string };
}

/** Create or register this member/host; the project UUID may never change. */
export function ensureProjectManifest(
	storePath: string,
	project: ProjectManifestIdentity,
): { manifest: ProjectManifest; created: boolean; changed: boolean } {
	const path = projectManifestPath(storePath);
	const existing = readProjectManifest(storePath);
	if (existing && existing.project !== project.id) {
		throw new Error(`muninn: ${path} belongs to project ${existing.project}, not ${project.id}`);
	}
	const manifest: ProjectManifest = existing ?? {
		schema: PROJECT_MANIFEST_SCHEMA,
		project: project.id,
		name: project.name,
		created_at: project.createdAt ?? new Date().toISOString(),
		remote: null,
		members: [],
		hosts: [],
	};
	const before = formatProjectManifest(manifest);
	if (project.member) manifest.members = uniqueById([...manifest.members, project.member], "member");
	if (project.host && project.member) {
		manifest.hosts = uniqueById(
			[...manifest.hosts, { id: project.host.id, name: project.host.name, member: project.member.id }],
			"host",
		);
	}
	const after = formatProjectManifest(manifest);
	if (!existing || before !== after) writeAtomic(path, after);
	return { manifest, created: !existing, changed: !existing || before !== after };
}

export function mergeProjectManifests(left: ProjectManifest, right: ProjectManifest): ProjectManifest {
	if (left.project !== right.project) {
		throw new Error(`project mismatch: ${right.project}, not ${left.project}`);
	}
	if (left.remote && right.remote && left.remote !== right.remote) {
		throw new Error(`remote conflict: ${left.remote} versus ${right.remote}`);
	}
	return parseProjectManifest(
		JSON.stringify({
			schema: PROJECT_MANIFEST_SCHEMA,
			project: left.project,
			name: left.name === right.name ? left.name : [left.name, right.name].sort()[0],
			created_at: [left.created_at, right.created_at].sort()[0],
			remote: left.remote ?? right.remote,
			members: [...left.members, ...right.members],
			hosts: [...left.hosts, ...right.hosts],
		}),
	);
}

export function setProjectRemote(storePath: string, remote: string | null): ProjectManifest {
	const manifest = readProjectManifest(storePath);
	if (!manifest) throw new Error(`muninn: no project.json at ${storePath}`);
	if (remote !== null && !isUsableRemote(remote)) throw new Error(`muninn: refusing unsafe journal remote ${remote}`);
	const updated = { ...manifest, remote };
	writeAtomic(projectManifestPath(storePath), formatProjectManifest(updated));
	return updated;
}

function writeAtomic(path: string, text: string): void {
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, text, { mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}
