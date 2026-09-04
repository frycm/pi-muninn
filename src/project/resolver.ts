/** Resolve a session path to one durable logical-project UUID. */
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { gitProjectContext } from "../git.ts";
import { isProjectId, newProjectId } from "../ids.ts";
import { isInside, projectRegistryPath, projectStorePath } from "../store/paths.ts";
import { readProjectHint } from "./hint.ts";
import {
	editProjectRegistry,
	type MemberIdentity,
	type ProjectLocation,
	type ProjectRegistry,
	type RegisteredProject,
	readProjectRegistry,
} from "./registry.ts";

export type ProjectResolutionReason = "root" | "git-common-dir" | "created" | "linked";

export interface ResolvedProject {
	id: string;
	name: string;
	storePath: string;
	registryPath: string;
	member: MemberIdentity;
	root: string;
	gitCommonDir?: string;
	locations: ProjectLocation[];
	reason: ProjectResolutionReason;
	reasonDetail: string;
}

interface PathProbe {
	root: string;
	cwd: string;
	gitCommonDir?: string;
}

interface Mapping {
	project: RegisteredProject;
	location: ProjectLocation;
	reason: "root" | "git-common-dir";
}

function cloneProject(project: RegisteredProject): RegisteredProject {
	return { ...project, locations: project.locations.map((location) => ({ ...location })) };
}

async function probePath(cwd: string): Promise<PathProbe> {
	let canonicalCwd: string;
	try {
		canonicalCwd = realpathSync(cwd);
	} catch (error) {
		throw new Error(`muninn: project path does not exist or cannot be resolved: ${cwd}`, { cause: error });
	}
	const git = await gitProjectContext(canonicalCwd);
	return {
		cwd: canonicalCwd,
		root: git?.worktreeRoot ?? git?.commonDir ?? canonicalCwd,
		...(git ? { gitCommonDir: git.commonDir } : {}),
	};
}

/** Explicit roots win; the most specific containing root wins among them. */
function findMapping(registry: ProjectRegistry, probe: PathProbe): Mapping | undefined {
	let rootMatch: Mapping | undefined;
	for (const project of registry.projects) {
		for (const location of project.locations) {
			if (!isInside(location.root, probe.cwd)) continue;
			if (!rootMatch || location.root.length > rootMatch.location.root.length) {
				rootMatch = { project, location, reason: "root" };
			}
		}
	}
	if (rootMatch) return rootMatch;
	if (!probe.gitCommonDir) return undefined;
	for (const project of registry.projects) {
		const location = project.locations.find((candidate) => candidate.gitCommonDir === probe.gitCommonDir);
		if (location) return { project, location, reason: "git-common-dir" };
	}
	return undefined;
}

function sameLocation(location: ProjectLocation, probe: PathProbe): boolean {
	return location.root === probe.root && location.gitCommonDir === probe.gitCommonDir;
}

function addLocation(project: RegisteredProject, probe: PathProbe): boolean {
	if (project.locations.some((location) => sameLocation(location, probe))) return false;
	project.locations.push({
		root: probe.root,
		...(probe.gitCommonDir ? { gitCommonDir: probe.gitCommonDir } : {}),
		linkedAt: new Date().toISOString(),
	});
	project.locations.sort((left, right) => left.root.localeCompare(right.root));
	return true;
}

function defaultProjectName(root: string): string {
	const name = basename(root).trim();
	return name === "" ? "project" : name;
}

function resolved(
	agentDir: string,
	registry: ProjectRegistry,
	project: RegisteredProject,
	probe: PathProbe,
	reason: ProjectResolutionReason,
	detail: string,
): ResolvedProject {
	return {
		id: project.id,
		name: project.name,
		storePath: projectStorePath(agentDir, project.id),
		registryPath: projectRegistryPath(agentDir),
		member: { ...registry.member },
		root: probe.root,
		...(probe.gitCommonDir ? { gitCommonDir: probe.gitCommonDir } : {}),
		locations: project.locations.map((location) => ({ ...location })),
		reason,
		reasonDetail: detail,
	};
}

export interface ResolveLogicalProjectOptions {
	agentDir: string;
	cwd: string;
	hostId: string;
	/** Mint and persist a project when no mapping exists. */
	create: boolean;
}

export async function resolveLogicalProject(
	options: ResolveLogicalProjectOptions,
): Promise<ResolvedProject | undefined> {
	const probe = await probePath(options.cwd);
	if (!options.create) {
		const registry = readProjectRegistry(options.agentDir);
		if (!registry) return undefined;
		const mapping = findMapping(registry, probe);
		if (!mapping) return undefined;
		const detail =
			mapping.reason === "root"
				? `canonical root mapping ${mapping.location.root}`
				: `canonical Git common directory ${probe.gitCommonDir}`;
		return resolved(options.agentDir, registry, mapping.project, probe, mapping.reason, detail);
	}

	return editProjectRegistry(options.agentDir, options.hostId, (registry) => {
		const mapping = findMapping(registry, probe);
		if (mapping) {
			const changed = addLocation(mapping.project, probe);
			const detail =
				mapping.reason === "root"
					? `canonical root mapping ${mapping.location.root}`
					: `canonical Git common directory ${probe.gitCommonDir}`;
			return {
				value: resolved(options.agentDir, registry, mapping.project, probe, mapping.reason, detail),
				changed,
			};
		}

		const project: RegisteredProject = {
			id: newProjectId(),
			name: defaultProjectName(probe.root),
			createdAt: new Date().toISOString(),
			locations: [],
		};
		addLocation(project, probe);
		registry.projects.push(project);
		registry.projects.sort((left, right) => left.id.localeCompare(right.id));
		const detail = probe.gitCommonDir
			? `new project for canonical Git common directory ${probe.gitCommonDir}`
			: `new project for canonical non-Git root ${probe.root}`;
		return { value: resolved(options.agentDir, registry, project, probe, "created", detail), changed: true };
	});
}

export interface LinkProjectOptions {
	agentDir: string;
	cwd: string;
	hostId: string;
	projectId?: string;
	name?: string;
	force?: boolean;
	/** Prepared only by the join transaction; used iff no registry exists yet. */
	initialRegistry?: ProjectRegistry;
	/** Detect another process creating a different member identity during join staging. */
	expectedMemberId?: string;
}

export async function linkLogicalProject(options: LinkProjectOptions): Promise<ResolvedProject> {
	if (options.projectId && !isProjectId(options.projectId)) {
		throw new Error(`muninn: project id must be a full UUIDv7: ${options.projectId}`);
	}
	if (options.name !== undefined && options.name.trim() === "") throw new Error("muninn: project name cannot be empty");
	const probe = await probePath(options.cwd);
	const hint = options.projectId ? undefined : readProjectHint(probe.root);
	const requestedId = options.projectId ?? hint?.project;
	const requestedName = options.name?.trim() ?? hint?.name;

	return editProjectRegistry(
		options.agentDir,
		options.hostId,
		(registry) => {
			if (options.expectedMemberId && registry.member.id !== options.expectedMemberId) {
				throw new Error("muninn: local member identity changed while joining; retry the join");
			}
			const existing = findMapping(registry, probe);
			let target = requestedId ? registry.projects.find((project) => project.id === requestedId) : existing?.project;

			if (existing && target && existing.project.id !== target.id && !options.force) {
				throw new Error(
					`muninn: ${probe.root} is already linked to project ${existing.project.id}; pass --force to relink it`,
				);
			}
			if (existing && requestedId && existing.project.id !== requestedId && !target && !options.force) {
				throw new Error(
					`muninn: ${probe.root} is already linked to project ${existing.project.id}; pass --force to relink it`,
				);
			}

			let changed = false;
			if (options.force) {
				for (const project of registry.projects) {
					if (project.id === target?.id) continue;
					const before = project.locations.length;
					project.locations = project.locations.filter(
						(location) =>
							location.root !== probe.root && (!probe.gitCommonDir || location.gitCommonDir !== probe.gitCommonDir),
					);
					changed ||= project.locations.length !== before;
				}
			}

			if (!target) {
				target = {
					id: requestedId ?? newProjectId(),
					name: requestedName || defaultProjectName(probe.root),
					createdAt: new Date().toISOString(),
					locations: [],
				};
				registry.projects.push(target);
				registry.projects.sort((left, right) => left.id.localeCompare(right.id));
				changed = true;
			}
			if (requestedName !== undefined && target.name !== requestedName) {
				target.name = requestedName;
				changed = true;
			}
			changed = addLocation(target, probe) || changed;
			return {
				value: resolved(
					options.agentDir,
					registry,
					target,
					probe,
					"linked",
					hint && !options.projectId
						? `explicit link accepting repository hint ${hint.project}`
						: `explicit link for ${probe.root}`,
				),
				changed,
			};
		},
		options.initialRegistry ? { initial: options.initialRegistry } : {},
	);
}

export interface UnlinkProjectResult {
	project: RegisteredProject;
	removed: ProjectLocation[];
}

export async function unlinkLogicalProject(options: {
	agentDir: string;
	cwd: string;
	hostId: string;
}): Promise<UnlinkProjectResult | undefined> {
	const probe = await probePath(options.cwd);
	// An unlink with nothing registered must not mint a member or an empty file.
	if (!readProjectRegistry(options.agentDir)) return undefined;
	return editProjectRegistry(options.agentDir, options.hostId, (registry) => {
		const mapping = findMapping(registry, probe);
		if (!mapping) return { value: undefined, changed: false };
		const removed = mapping.project.locations.filter((location) =>
			probe.gitCommonDir ? location.gitCommonDir === probe.gitCommonDir : location === mapping.location,
		);
		mapping.project.locations = mapping.project.locations.filter((location) => !removed.includes(location));
		return {
			value: { project: cloneProject(mapping.project), removed: removed.map((location) => ({ ...location })) },
			changed: removed.length > 0,
		};
	});
}
