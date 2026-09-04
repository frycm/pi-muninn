/** Durable identity, writer ownership and team metadata for a project journal. */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isHostId, isMemberId, isProjectId, isTeamEventId } from "../ids.ts";
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

export type TeamEventKind =
	| "member-renamed"
	| "member-retired"
	| "member-restored"
	| "host-renamed"
	| "host-retired"
	| "host-restored";

export interface ProjectTeamEvent {
	id: string;
	at: string;
	kind: TeamEventKind;
	member: string;
	actor_member: string;
	actor_host: string;
	host?: string;
	name?: string;
	reason?: string;
}

export interface ProjectManifest {
	schema: typeof PROJECT_MANIFEST_SCHEMA;
	project: string;
	name: string;
	created_at: string;
	remote: string | null;
	members: ProjectManifestMember[];
	hosts: ProjectManifestHost[];
	team_events: ProjectTeamEvent[];
}

export function projectManifestPath(storePath: string): string {
	return join(storePath, "project.json");
}

function nonempty(value: unknown, at: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${at} must be a non-empty string`);
	return value;
}

function bounded(value: unknown, at: string, max: number): string {
	const text = nonempty(value, at);
	if (text.length > max) throw new Error(`${at} must be at most ${max} characters`);
	return text;
}

function timestamp(value: unknown, at: string): string {
	const text = nonempty(value, at);
	if (!RFC3339_MILLIS.test(text) || Number.isNaN(Date.parse(text))) {
		throw new Error(`${at} must be an RFC 3339 UTC timestamp with milliseconds`);
	}
	return text;
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

const TEAM_EVENT_KINDS = new Set<TeamEventKind>([
	"member-renamed",
	"member-retired",
	"member-restored",
	"host-renamed",
	"host-retired",
	"host-restored",
]);

function teamEvents(value: unknown): ProjectTeamEvent[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("team_events must be an array");
	const parsed = value.map((candidate, index): ProjectTeamEvent => {
		const at = `team_events[${index}]`;
		if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
			throw new Error(`${at} must be an object`);
		}
		const event = candidate as Record<string, unknown>;
		const kind = nonempty(event.kind, `${at}.kind`) as TeamEventKind;
		if (!TEAM_EVENT_KINDS.has(kind)) throw new Error(`${at}.kind is not supported`);
		const allowed = new Set(["id", "at", "kind", "member", "actor_member", "actor_host", "host", "name", "reason"]);
		for (const key of Object.keys(event)) if (!allowed.has(key)) throw new Error(`${at}.${key} is not supported`);
		const id = nonempty(event.id, `${at}.id`);
		const member = nonempty(event.member, `${at}.member`);
		const actorMember = nonempty(event.actor_member, `${at}.actor_member`);
		const actorHost = nonempty(event.actor_host, `${at}.actor_host`);
		if (!isTeamEventId(id)) throw new Error(`${at}.id must be a team-event UUIDv7`);
		if (!isMemberId(member)) throw new Error(`${at}.member must be a member UUIDv7`);
		if (!isMemberId(actorMember)) throw new Error(`${at}.actor_member must be a member UUIDv7`);
		if (!isHostId(actorHost)) throw new Error(`${at}.actor_host must be a host UUIDv7`);
		const host = event.host === undefined ? undefined : nonempty(event.host, `${at}.host`);
		if (host !== undefined && !isHostId(host)) throw new Error(`${at}.host must be a host UUIDv7`);
		const name = event.name === undefined ? undefined : bounded(event.name, `${at}.name`, 200);
		const reason = event.reason === undefined ? undefined : bounded(event.reason, `${at}.reason`, 2_000);
		const hostEvent = kind.startsWith("host-");
		const rename = kind.endsWith("-renamed");
		if (hostEvent !== (host !== undefined))
			throw new Error(`${at}.host ${hostEvent ? "is required" : "is not allowed"}`);
		if (rename !== (name !== undefined)) throw new Error(`${at}.name ${rename ? "is required" : "is not allowed"}`);
		return {
			id,
			at: timestamp(event.at, `${at}.at`),
			kind,
			member,
			actor_member: actorMember,
			actor_host: actorHost,
			...(host ? { host } : {}),
			...(name ? { name } : {}),
			...(reason ? { reason } : {}),
		};
	});
	const found = new Map<string, ProjectTeamEvent>();
	for (const event of parsed) {
		const prior = found.get(event.id);
		if (prior && JSON.stringify(prior) !== JSON.stringify(event)) {
			throw new Error(`team event id collision for ${event.id}`);
		}
		found.set(event.id, event);
	}
	return [...found.values()].sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
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
		const createdAt = timestamp(raw.created_at, "created_at");
		if (raw.remote !== null && typeof raw.remote !== "string") throw new Error("remote must be a string or null");
		if (typeof raw.remote === "string" && !isUsableRemote(raw.remote)) throw new Error("remote is not a safe Git URL");
		const parsedMembers = uniqueById(members(raw.members), "member");
		const parsedHosts = uniqueById(hosts(raw.hosts), "host");
		const parsedEvents = teamEvents(raw.team_events);
		for (const host of parsedHosts) {
			if (!parsedMembers.some((member) => member.id === host.member)) {
				throw new Error(`host ${host.id} names unknown member ${host.member}`);
			}
		}
		const memberIds = new Set(parsedMembers.map((member) => member.id));
		const hostOwners = new Map(parsedHosts.map((host) => [host.id, host.member]));
		for (const event of parsedEvents) {
			if (!memberIds.has(event.member)) throw new Error(`team event ${event.id} names unknown member ${event.member}`);
			if (event.member !== event.actor_member) throw new Error(`team event ${event.id} is not self-declared`);
			if (hostOwners.get(event.actor_host) !== event.actor_member) {
				throw new Error(`team event ${event.id} actor host is not owned by its actor member`);
			}
			if (event.host && hostOwners.get(event.host) !== event.member) {
				throw new Error(`team event ${event.id} target host is not owned by its member`);
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
			team_events: parsedEvents,
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
		team_events: [],
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
			team_events: [...left.team_events, ...right.team_events],
		}),
	);
}

/** Replace a manifest atomically after full canonical validation. */
export function writeProjectManifest(storePath: string, manifest: ProjectManifest): ProjectManifest {
	const canonical = parseProjectManifest(JSON.stringify(manifest));
	writeAtomic(projectManifestPath(storePath), formatProjectManifest(canonical));
	return canonical;
}

export function setProjectRemote(storePath: string, remote: string | null): ProjectManifest {
	const manifest = readProjectManifest(storePath);
	if (!manifest) throw new Error(`muninn: no project.json at ${storePath}`);
	if (remote !== null && !isUsableRemote(remote)) throw new Error(`muninn: refusing unsafe journal remote ${remote}`);
	const updated = { ...manifest, remote };
	return writeProjectManifest(storePath, updated);
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
