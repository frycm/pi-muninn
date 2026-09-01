/**
 * The user-owned logical-project registry.
 *
 * It lives beside project stores under pi's agent directory. Project files are
 * never consulted for a path or automatically activated UUID, so cloning a
 * repository cannot make Muninn read or write another store on this machine.
 * A direct `project link` command may explicitly accept the narrow ID hint.
 */
import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, normalize } from "node:path";
import { isMemberId, isProjectId, newMemberId } from "../ids.ts";
import { withStoreLock } from "../store/lock.ts";
import { projectRegistryPath, projectsRootPath } from "../store/paths.ts";

export const PROJECT_REGISTRY_SCHEMA = 1;

export interface MemberIdentity {
	id: string;
	name: string;
	createdAt: string;
}

export interface ProjectLocation {
	/** Canonical worktree, bare-repository, or non-Git root. */
	root: string;
	/** Canonical Git common directory, shared by linked worktrees. */
	gitCommonDir?: string;
	linkedAt: string;
}

export interface RegisteredProject {
	id: string;
	name: string;
	createdAt: string;
	locations: ProjectLocation[];
}

export interface ProjectRegistry {
	schema: typeof PROJECT_REGISTRY_SCHEMA;
	member: MemberIdentity;
	projects: RegisteredProject[];
}

export class RegistryCorruptError extends Error {
	constructor(path: string, detail: string, cause?: unknown) {
		super(`muninn: project registry at ${path} is invalid (${detail}); refusing to overwrite it`);
		this.name = "RegistryCorruptError";
		this.cause = cause;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, at: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${at} must be a non-empty string`);
	return value;
}

function absolutePath(value: unknown, at: string): string {
	const path = requiredString(value, at);
	if (!isAbsolute(path)) throw new Error(`${at} must be an absolute canonical path`);
	if (normalize(path) !== path) throw new Error(`${at} must not contain redundant path segments`);
	return path;
}

/** Validate the complete file before any caller can use a mapping from it. */
export function parseProjectRegistry(text: string, path = "registry.json"): ProjectRegistry {
	try {
		const raw: unknown = JSON.parse(text);
		if (!isRecord(raw)) throw new Error("root must be an object");
		if (raw.schema !== PROJECT_REGISTRY_SCHEMA) {
			throw new Error(`schema must be ${PROJECT_REGISTRY_SCHEMA}, found ${String(raw.schema)}`);
		}
		if (!isRecord(raw.member)) throw new Error("member must be an object");
		const memberId = requiredString(raw.member.id, "member.id");
		if (!isMemberId(memberId)) throw new Error("member.id must be a full UUIDv7");
		const member: MemberIdentity = {
			id: memberId,
			name: requiredString(raw.member.name, "member.name"),
			createdAt: requiredString(raw.member.createdAt, "member.createdAt"),
		};
		if (!Array.isArray(raw.projects)) throw new Error("projects must be an array");

		const projectIds = new Set<string>();
		const roots = new Map<string, string>();
		const commonDirs = new Map<string, string>();
		const projects: RegisteredProject[] = raw.projects.map((candidate, projectIndex) => {
			const at = `projects[${projectIndex}]`;
			if (!isRecord(candidate)) throw new Error(`${at} must be an object`);
			const id = requiredString(candidate.id, `${at}.id`);
			if (!isProjectId(id)) throw new Error(`${at}.id must be a full UUIDv7`);
			if (projectIds.has(id)) throw new Error(`duplicate project id ${id}`);
			projectIds.add(id);
			if (!Array.isArray(candidate.locations)) throw new Error(`${at}.locations must be an array`);

			const locations: ProjectLocation[] = candidate.locations.map((location, locationIndex) => {
				const locationAt = `${at}.locations[${locationIndex}]`;
				if (!isRecord(location)) throw new Error(`${locationAt} must be an object`);
				const root = absolutePath(location.root, `${locationAt}.root`);
				const rootOwner = roots.get(root);
				if (rootOwner) throw new Error(`root ${root} is mapped more than once (projects ${rootOwner} and ${id})`);
				roots.set(root, id);

				let gitCommonDir: string | undefined;
				if (location.gitCommonDir !== undefined) {
					gitCommonDir = absolutePath(location.gitCommonDir, `${locationAt}.gitCommonDir`);
					const commonOwner = commonDirs.get(gitCommonDir);
					if (commonOwner && commonOwner !== id) {
						throw new Error(`Git common directory ${gitCommonDir} is mapped to projects ${commonOwner} and ${id}`);
					}
					commonDirs.set(gitCommonDir, id);
				}

				return {
					root,
					...(gitCommonDir ? { gitCommonDir } : {}),
					linkedAt: requiredString(location.linkedAt, `${locationAt}.linkedAt`),
				};
			});

			return {
				id,
				name: requiredString(candidate.name, `${at}.name`),
				createdAt: requiredString(candidate.createdAt, `${at}.createdAt`),
				locations,
			};
		});

		return { schema: PROJECT_REGISTRY_SCHEMA, member, projects };
	} catch (error) {
		if (error instanceof RegistryCorruptError) throw error;
		throw new RegistryCorruptError(path, error instanceof Error ? error.message : String(error), error);
	}
}

/** Read atomically replaced registry bytes. Missing is distinct from corrupt. */
export function readProjectRegistry(agentDir: string): ProjectRegistry | undefined {
	const path = projectRegistryPath(agentDir);
	if (!existsSync(path)) return undefined;
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch (error) {
		throw new RegistryCorruptError(path, error instanceof Error ? error.message : String(error), error);
	}
	return parseProjectRegistry(text, path);
}

function defaultMemberName(): string {
	try {
		const name = userInfo().username.trim();
		return name === "" ? "member" : name;
	} catch {
		return "member";
	}
}

function newRegistry(): ProjectRegistry {
	return {
		schema: PROJECT_REGISTRY_SCHEMA,
		member: { id: newMemberId(), name: defaultMemberName(), createdAt: new Date().toISOString() },
		projects: [],
	};
}

function writeRegistryAtomic(agentDir: string, registry: ProjectRegistry): void {
	const root = projectsRootPath(agentDir);
	const path = projectRegistryPath(agentDir);
	const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const bytes = `${JSON.stringify(registry, null, "\t")}\n`;
	let fd: number | undefined;
	try {
		fd = openSync(temp, "wx", 0o600);
		writeFileSync(fd, bytes, "utf-8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temp, path);
		// Make the rename durable where the platform supports directory fsync.
		try {
			const directory = openSync(root, "r");
			try {
				fsyncSync(directory);
			} finally {
				closeSync(directory);
			}
		} catch {
			// Windows and some filesystems do not permit fsync on a directory.
		}
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(temp, { force: true });
	}
}

export interface RegistryEdit<T> {
	value: T;
	changed: boolean;
}

/** Serialize read-modify-write operations across simultaneous pi processes. */
export async function editProjectRegistry<T>(
	agentDir: string,
	hostId: string,
	edit: (registry: ProjectRegistry) => RegistryEdit<T>,
): Promise<T> {
	const root = projectsRootPath(agentDir);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	return withStoreLock(root, "registry", { host: hostId }, () => {
		const existing = readProjectRegistry(agentDir);
		const registry = existing ?? newRegistry();
		const result = edit(registry);
		if (!existing || result.changed) {
			// Validate the exact object about to become authoritative.
			parseProjectRegistry(JSON.stringify(registry), projectRegistryPath(agentDir));
			writeRegistryAtomic(agentDir, registry);
		}
		return result.value;
	});
}
