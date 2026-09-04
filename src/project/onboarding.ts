/** Validated, rollback-safe sharing and joining of a project journal. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git } from "../git.ts";
import { isHostId, isMemberId } from "../ids.ts";
import { scanJournal } from "../journal/jsonl.ts";
import { parseMigrationManifest } from "../journal/migrate.ts";
import { isUsableRemote } from "../settings.ts";
import type { HostIdentity } from "../store/host.ts";
import { ensureStore } from "../store/init.ts";
import { withStoreLock } from "../store/lock.ts";
import { projectStorePath, projectsRootPath } from "../store/paths.ts";
import { type ProjectManifest, readProjectManifest, setProjectRemote } from "../store/project-manifest.ts";
import { createProjectRegistry, readProjectRegistry } from "./registry.ts";
import { linkLogicalProject, type ResolvedProject } from "./resolver.ts";

const ROOT_FILES = new Set([".gitignore", "project.json", "migration.json"]);
const SHARD = /^(journal)\/([^/]+)\/([^/]+)\/(\d{4}-\d{2}\.jsonl)$/;

export interface ProjectShare {
	schema: 1;
	project: string;
	name: string;
	remote: string;
}

export function projectShare(project: ResolvedProject, manifest: ProjectManifest | undefined): ProjectShare {
	if (!manifest) throw new Error(`muninn: project journal has no project.json at ${project.storePath}`);
	if (manifest.project !== project.id) {
		throw new Error(`muninn: project registry names ${project.id}, but the journal manifest names ${manifest.project}`);
	}
	if (!manifest.remote)
		throw new Error("muninn: no project journal remote configured; run `muninn project remote URL`");
	return { schema: 1, project: project.id, name: manifest.name, remote: manifest.remote };
}

export interface JoinProjectOptions {
	agentDir: string;
	cwd: string;
	host: HostIdentity;
	remote: string;
	force?: boolean;
}

export interface JoinProjectResult {
	schema: 1;
	project: ResolvedProject;
	remote: string;
	storeCreated: boolean;
}

/** Clone, validate and install a shared journal before making its registry mapping visible. */
export async function joinProjectJournal(options: JoinProjectOptions): Promise<JoinProjectResult> {
	if (!isUsableRemote(options.remote)) throw new Error("muninn: journal URL is empty, unsafe, or embeds credentials");
	const projectsRoot = projectsRootPath(options.agentDir);
	const onboardingLock = join(projectsRoot, ".onboarding");
	mkdirSync(onboardingLock, { recursive: true, mode: 0o700 });

	return withStoreLock(onboardingLock, "onboarding", { host: options.host.id }, async () => {
		const initialRegistry = structuredClone(readProjectRegistry(options.agentDir) ?? createProjectRegistry());
		const temporary = mkdtempSync(join(projectsRoot, ".join-"));
		let installed: string | undefined;
		let storeCreated = false;
		try {
			await git(temporary, { kind: "clone", url: options.remote });
			const manifest = await validateJoinedStore(temporary, options.remote, true, true);
			const destination = projectStorePath(options.agentDir, manifest.project);

			if (existsSync(destination)) {
				const existing = await validateJoinedStore(destination, options.remote, false);
				const registered = initialRegistry.projects.some((candidate) => candidate.id === manifest.project);
				const member = existing.members.some((candidate) => candidate.id === initialRegistry.member.id);
				const host = existing.hosts.some(
					(candidate) => candidate.id === options.host.id && candidate.member === initialRegistry.member.id,
				);
				if (existing.project !== manifest.project || !registered || !member || !host) {
					throw new Error(
						`muninn: destination ${destination} already exists but is not this registered local journal; move it aside and retry`,
					);
				}
			} else {
				if (manifest.remote === null) setProjectRemote(temporary, options.remote);
				await ensureStore(temporary, {
					host: options.host,
					project: {
						id: manifest.project,
						name: manifest.name,
						createdAt: manifest.created_at,
						member: initialRegistry.member,
					},
				});
				await validateJoinedStore(temporary, options.remote, true);
				renameSync(temporary, destination);
				installed = destination;
				storeCreated = true;
			}

			try {
				const project = await linkLogicalProject({
					agentDir: options.agentDir,
					cwd: options.cwd,
					hostId: options.host.id,
					projectId: manifest.project,
					name: manifest.name,
					...(options.force ? { force: true } : {}),
					initialRegistry,
					expectedMemberId: initialRegistry.member.id,
				});
				installed = undefined;
				return {
					schema: 1,
					project,
					remote: options.remote,
					storeCreated,
				};
			} catch (error) {
				if (installed) rmSync(installed, { recursive: true, force: true });
				throw error;
			}
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	});
}

/** Validate only committed canonical store data; never execute content from the clone. */
async function validateJoinedStore(
	storePath: string,
	requestedRemote: string,
	requireClean: boolean,
	allowUnsetRemote = false,
): Promise<ProjectManifest> {
	const branch = (await git(storePath, { kind: "current-branch" })).stdout.trim();
	if (branch !== "main")
		throw new Error(`muninn: shared journal must use branch main, found ${branch || "detached HEAD"}`);
	const tracked = trackedFiles((await git(storePath, { kind: "ls-files-stage" })).stdout);
	if (!tracked.some((file) => file.path === "project.json")) {
		throw new Error("muninn: shared repository has no tracked project.json");
	}
	for (const file of tracked) validateTrackedFile(file);
	if (requireClean && (await git(storePath, { kind: "status-porcelain", paths: [] })).stdout.trim() !== "") {
		throw new Error("muninn: shared journal clone is not clean after checkout");
	}

	const manifest = readProjectManifest(storePath);
	if (!manifest) throw new Error("muninn: shared repository has no readable project.json");
	if (manifest.remote !== requestedRemote && !(allowUnsetRemote && manifest.remote === null)) {
		throw new Error("muninn: shared journal manifest names a different remote than the requested URL");
	}
	if (existsSync(join(storePath, "migration.json"))) {
		parseMigrationManifest(readFileSync(join(storePath, "migration.json"), "utf-8"));
	}
	const scan = scanJournal(storePath);
	if (scan.problems.length > 0) {
		const first = scan.problems[0];
		throw new Error(`muninn: shared journal is invalid at ${first?.path}:${first?.line ?? "?"}: ${first?.message}`);
	}
	const owners = new Map(manifest.hosts.map((host) => [host.id, host.member]));
	for (const item of scan.records) {
		if (item.record.project !== manifest.project) {
			throw new Error(
				`muninn: record ${item.record.id} belongs to project ${item.record.project}, not ${manifest.project}`,
			);
		}
		const owner = owners.get(item.record.host);
		if (!owner || owner !== item.record.member) {
			throw new Error(`muninn: record ${item.record.id} has no matching member/host ownership in project.json`);
		}
	}
	return manifest;
}

interface TrackedFile {
	mode: string;
	path: string;
}

function trackedFiles(output: string): TrackedFile[] {
	return output
		.split("\0")
		.filter((row) => row !== "")
		.map((row) => {
			const match = row.match(/^(\d{6}) [0-9a-f]+ \d\t([\s\S]+)$/i);
			if (!match) throw new Error("muninn: shared repository returned an unreadable tracked-file entry");
			return { mode: match[1] as string, path: match[2] as string };
		});
}

function validateTrackedFile(file: TrackedFile): void {
	if (file.mode !== "100644") throw new Error(`muninn: shared journal path ${file.path} is not a regular data file`);
	if (ROOT_FILES.has(file.path)) return;
	const shard = file.path.match(SHARD);
	if (!shard || !isMemberId(shard[2] as string) || !isHostId(shard[3] as string)) {
		throw new Error(`muninn: shared repository tracks unexpected path ${file.path}`);
	}
}
