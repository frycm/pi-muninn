/** Validated, rollback-safe sharing and joining of a project journal. */
import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { git } from "../git.ts";
import { isProjectId } from "../ids.ts";
import { scanJournal } from "../journal/jsonl.ts";
import { parseMigrationManifest } from "../journal/migrate.ts";
import { isUsableRemote } from "../settings.ts";
import type { HostIdentity } from "../store/host.ts";
import { ensureStore } from "../store/init.ts";
import { withStoreLock } from "../store/lock.ts";
import { projectStorePath, projectsRootPath } from "../store/paths.ts";
import { type ProjectManifest, readProjectManifest, setProjectRemote } from "../store/project-manifest.ts";
import { validateTrackedJournalFiles } from "../store/tracked-files.ts";
import { authorizeJournalRemote, readAuthorizedRemote } from "../sync/remote.ts";
import { createProjectRegistry, type ProjectRegistry, parseProjectRegistry, readProjectRegistry } from "./registry.ts";
import { linkLogicalProject, type ResolvedProject } from "./resolver.ts";

const JOIN_RECOVERY_SCHEMA = 1;

interface JoinRecovery {
	schema: typeof JOIN_RECOVERY_SCHEMA;
	project: string;
	remote: string;
	registry: ProjectRegistry;
}

export interface ProjectShare {
	schema: 1;
	project: string;
	name: string;
	remote: string;
}

export async function projectShare(
	project: ResolvedProject,
	manifest: ProjectManifest | undefined,
): Promise<ProjectShare> {
	if (!manifest) throw new Error(`muninn: project journal has no project.json at ${project.storePath}`);
	if (manifest.project !== project.id) {
		throw new Error(`muninn: project registry names ${project.id}, but the journal manifest names ${manifest.project}`);
	}
	const remote = await readAuthorizedRemote(project.storePath);
	if (!remote) throw new Error("muninn: no project journal remote configured; run `muninn project remote URL`");
	return { schema: 1, project: project.id, name: manifest.name, remote };
}

export interface JoinProjectOptions {
	agentDir: string;
	cwd: string;
	host: HostIdentity;
	remote: string;
	force?: boolean;
	signal?: AbortSignal;
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
		cleanupAbandonedJoins(projectsRoot);
		const temporary = mkdtempSync(join(projectsRoot, ".join-"));
		let installed: string | undefined;
		let recoveryCreated = false;
		let recoveryPath: string | undefined;
		let storeCreated = false;
		try {
			await git(temporary, { kind: "clone", url: options.remote }, options.signal ? { signal: options.signal } : {});
			const manifest = await validateJoinedStore(temporary, options.remote, true, true);
			const destination = projectStorePath(options.agentDir, manifest.project);
			recoveryPath = joinRecoveryPath(projectsRoot, manifest.project);
			const currentRegistry = readProjectRegistry(options.agentDir);
			const recovery = readJoinRecovery(projectsRoot, manifest.project, options.remote);
			if (currentRegistry && recovery && currentRegistry.member.id !== recovery.registry.member.id) {
				throw new Error(
					"muninn: local member identity changed since an unfinished join; move its recovery marker aside and retry",
				);
			}
			const initialRegistry = structuredClone(currentRegistry ?? recovery?.registry ?? createProjectRegistry());

			if (existsSync(destination)) {
				const existing = await validateJoinedStore(destination, options.remote, false);
				const registered = initialRegistry.projects.some((candidate) => candidate.id === manifest.project);
				const member = existing.members.some((candidate) => candidate.id === initialRegistry.member.id);
				const host = existing.hosts.some(
					(candidate) => candidate.id === options.host.id && candidate.member === initialRegistry.member.id,
				);
				if (existing.project !== manifest.project || (!registered && !recovery) || !member || !host) {
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
				if (!recovery) {
					writeJoinRecovery(projectsRoot, {
						schema: JOIN_RECOVERY_SCHEMA,
						project: manifest.project,
						remote: options.remote,
						registry: initialRegistry,
					});
					recoveryCreated = true;
				}
				renameSync(temporary, destination);
				fsyncDirectory(projectsRoot);
				installed = destination;
				storeCreated = true;
			}

			await withStoreLock(destination, "onboarding", { host: options.host.id }, () =>
				authorizeJournalRemote(destination, options.remote),
			);
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
			rmSync(recoveryPath, { force: true });
			return {
				schema: 1,
				project,
				remote: options.remote,
				storeCreated,
			};
		} catch (error) {
			if (installed) {
				rmSync(installed, { recursive: true, force: true });
				if (recoveryPath) rmSync(recoveryPath, { force: true });
			} else if (recoveryCreated && recoveryPath) {
				rmSync(recoveryPath, { force: true });
			}
			throw error;
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	});
}

/** The onboarding lock proves that no live join owns these incomplete temporary files. */
function cleanupAbandonedJoins(projectsRoot: string): void {
	for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
		if (entry.name.startsWith(".join-") && entry.isDirectory()) {
			rmSync(join(projectsRoot, entry.name), { recursive: true, force: true });
		} else if (entry.name.startsWith(".join-recovery-") && entry.name.endsWith(".tmp") && entry.isFile()) {
			rmSync(join(projectsRoot, entry.name), { force: true });
		}
	}
}

function joinRecoveryPath(projectsRoot: string, project: string): string {
	return join(projectsRoot, `.join-recovery-${project}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJoinRecovery(projectsRoot: string, project: string, remote: string): JoinRecovery | undefined {
	const path = joinRecoveryPath(projectsRoot, project);
	if (!existsSync(path)) return undefined;
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (!isRecord(raw) || raw.schema !== JOIN_RECOVERY_SCHEMA) throw new Error("unsupported schema");
		if (typeof raw.project !== "string" || !isProjectId(raw.project) || raw.project !== project) {
			throw new Error("project does not match the validated clone");
		}
		if (typeof raw.remote !== "string" || !isUsableRemote(raw.remote) || raw.remote !== remote) {
			throw new Error("remote does not match the requested URL");
		}
		if (!isRecord(raw.registry)) throw new Error("registry is missing");
		const registry = parseProjectRegistry(JSON.stringify(raw.registry), `${path} registry`);
		return { schema: JOIN_RECOVERY_SCHEMA, project, remote, registry };
	} catch (error) {
		throw new Error(`muninn: unfinished join state at ${path} is invalid; move it aside and retry`, {
			cause: error,
		});
	}
}

function writeJoinRecovery(projectsRoot: string, recovery: JoinRecovery): void {
	const path = joinRecoveryPath(projectsRoot, recovery.project);
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", 0o600);
		writeFileSync(fd, `${JSON.stringify(recovery, null, "\t")}\n`, "utf-8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, path);
		fsyncDirectory(projectsRoot);
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(temporary, { force: true });
	}
}

function fsyncDirectory(path: string): void {
	try {
		const directory = openSync(path, "r");
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
	} catch {
		// Windows and some filesystems do not permit fsync on a directory.
	}
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
	await validateTrackedJournalFiles(storePath);
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
