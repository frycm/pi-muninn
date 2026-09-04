/** Read-only, structured diagnostics for a logical project journal. */
import { existsSync } from "node:fs";
import { GitError, git, gitToplevel, isGitRepository } from "./git.ts";
import { scanJournal } from "./journal/jsonl.ts";
import { inspectJournalIndex } from "./journal/query-index.ts";
import { projectRelations } from "./journal/relations.ts";
import { readProjectRegistry } from "./project/registry.ts";
import { type ResolvedProject, resolveLogicalProject } from "./project/resolver.ts";
import { canonicalPath } from "./store/paths.ts";
import { type ProjectManifest, readProjectManifest } from "./store/project-manifest.ts";
import { lifecycleWarnings } from "./team/lifecycle.ts";

export type DoctorStatus = "ok" | "warning" | "error";

export interface DoctorCheck {
	code: string;
	status: DoctorStatus;
	message: string;
	remedy?: string;
}

export interface DoctorResult {
	schema: 1;
	kind: "doctor";
	project?: { id: string; name: string; store: string };
	checks: DoctorCheck[];
	summary: { ok: number; warnings: number; errors: number };
}

const READ_ONLY_HOST = "00000000-0000-7000-8000-000000000000";

export async function diagnoseProject(options: { agentDir: string; cwd: string }): Promise<DoctorResult> {
	const checks: DoctorCheck[] = [];
	const add = (code: string, status: DoctorStatus, message: string, remedy?: string) =>
		checks.push({ code, status, message, ...(remedy ? { remedy } : {}) });

	let registry: ReturnType<typeof readProjectRegistry>;
	try {
		registry = readProjectRegistry(options.agentDir);
		if (registry) add("registry.valid", "ok", `registry is valid with ${registry.projects.length} project(s)`);
		else
			add(
				"registry.valid",
				"error",
				"project registry is missing",
				"run `muninn project link` or `muninn project join`",
			);
	} catch (error) {
		add("registry.valid", "error", describe(error), "repair or replace the registry before using project journals");
	}

	let project: ResolvedProject | undefined;
	if (registry) {
		try {
			project = await resolveLogicalProject({
				agentDir: options.agentDir,
				cwd: options.cwd,
				hostId: READ_ONLY_HOST,
				create: false,
			});
			if (project) add("project.mapping", "ok", project.reasonDetail);
			else
				add("project.mapping", "error", "this directory has no logical-project mapping", "run `muninn project link`");
		} catch (error) {
			add("project.mapping", "error", describe(error), "repair the selected registry location or Git checkout");
		}
	} else {
		add(
			"project.mapping",
			"error",
			"mapping could not be checked without a valid registry",
			"repair the registry first",
		);
	}

	if (!project) return finish(checks);
	if (!existsSync(project.storePath)) {
		add(
			"store.path",
			"error",
			`journal store is missing at ${project.storePath}`,
			"run `muninn project join` or restore the store",
		);
		return finish(checks, project);
	}
	add("store.path", "ok", `journal store exists at ${project.storePath}`);

	let repository = false;
	try {
		repository = await isGitRepository(project.storePath);
		const toplevel = repository ? await gitToplevel(project.storePath) : undefined;
		if (!repository || !toplevel || canonicalPath(toplevel) !== canonicalPath(project.storePath)) {
			add(
				"store.git",
				"error",
				"journal store is not the root of its own Git worktree",
				"restore or rejoin the project journal",
			);
			repository = false;
		} else {
			const branch = (await git(project.storePath, { kind: "current-branch" })).stdout.trim();
			if (branch === "main") add("store.git", "ok", "journal store is its own Git repository on main");
			else add("store.git", "warning", `journal store is on branch ${branch}`, "switch the journal store back to main");
		}
	} catch (error) {
		add("store.git", "error", describe(error), "install Git or repair the journal repository");
	}

	let manifest: ProjectManifest | undefined;
	try {
		manifest = readProjectManifest(project.storePath);
		if (manifest) {
			add(
				"manifest.valid",
				"ok",
				`project manifest is valid (${manifest.members.length} members, ${manifest.hosts.length} hosts, ${manifest.team_events.length} events)`,
			);
		} else add("manifest.valid", "error", "project.json is missing", "restore or rejoin the project journal");
	} catch (error) {
		add("manifest.valid", "error", describe(error), "repair the manifest collision or restore a valid revision");
	}

	if (manifest) {
		const memberPresent = manifest.members.some((member) => member.id === project?.member.id);
		if (manifest.project === project.id && memberPresent) {
			add("project.identity", "ok", "registry, manifest, and local member identities agree");
		} else {
			add(
				"project.identity",
				"error",
				manifest.project !== project.id
					? `manifest project ${manifest.project} does not match registry project ${project.id}`
					: `local member ${project.member.id} is not registered in project.json`,
				"do not sync; relink or rejoin the intended journal",
			);
		}
	}

	if (manifest && repository) await checkRemote(project.storePath, manifest, add);

	const scan = scanJournal(project.storePath);
	const records = scan.records.map((item) => item.record);
	const ownership = manifest
		? records.flatMap((record) => {
				const owner = manifest.hosts.find((host) => host.id === record.host)?.member;
				if (record.project !== manifest.project) return [`record ${record.id} names project ${record.project}`];
				if (!owner) return [`record ${record.id} uses unregistered host ${record.host}`];
				if (owner !== record.member) return [`record ${record.id} does not match host ${record.host} ownership`];
				return [];
			})
		: [];
	if (scan.problems.length === 0 && ownership.length === 0) {
		add("journal.valid", "ok", `${records.length} canonical record(s); shard ownership is valid`);
	} else {
		add(
			"journal.valid",
			"error",
			`${scan.problems.length + ownership.length} journal validity or ownership problem(s): ${scan.problems[0]?.message ?? ownership[0]}`,
			"inspect the reported shard before syncing or resolving conflicts",
		);
	}

	if (manifest) {
		const warnings = lifecycleWarnings(manifest, records);
		if (warnings.length === 0) add("lifecycle.consistent", "ok", "no records were written during a retired interval");
		else {
			add(
				"lifecycle.consistent",
				"warning",
				`${warnings.length} record(s) were written during a retired interval`,
				"review the lifecycle declaration and append a correction if the journal is stale",
			);
		}
	}

	const relations = projectRelations(records, project.member.id);
	const relationProblems = relations.cycles.length + relations.missing.length + relations.conflicts.length;
	if (relationProblems === 0)
		add("relations.consistent", "ok", "relations have no cycles, missing targets, or active conflicts");
	else {
		add(
			"relations.consistent",
			"warning",
			`${relations.cycles.length} cycle(s), ${relations.missing.length} missing target(s), ${relations.conflicts.length} active conflict(s)`,
			"run `muninn conflicts` and inspect missing or cyclic relation targets",
		);
	}

	const index = inspectJournalIndex(project.storePath, records);
	if (index.exact) add("index.valid", "ok", "disposable index is readable and matches the canonical journal");
	else add("index.valid", "warning", index.problem ?? "disposable index is not current", "run `muninn reindex`");

	return finish(checks, project);
}

async function checkRemote(
	storePath: string,
	manifest: ProjectManifest,
	add: (code: string, status: DoctorStatus, message: string, remedy?: string) => void,
): Promise<void> {
	let origin: string | undefined;
	try {
		origin = (await git(storePath, { kind: "remote-get-url", name: "origin" })).stdout.trim();
	} catch (error) {
		if (!(error instanceof GitError) || !/no such remote/i.test(error.stderr)) {
			add("remote.consistent", "error", describe(error), "repair the Git origin configuration");
			return;
		}
	}
	if (manifest.remote === null && !origin) add("remote.consistent", "ok", "no project journal remote is configured");
	else if (manifest.remote === null) {
		add(
			"remote.consistent",
			"warning",
			"Git origin is ignored because the manifest remote is unset",
			"set it with `muninn project remote URL` or remove origin",
		);
	} else if (!origin) {
		add(
			"remote.consistent",
			"warning",
			"manifest remote is set but Git origin is missing",
			"run `muninn sync` to configure origin",
		);
	} else if (origin !== manifest.remote) {
		add(
			"remote.consistent",
			"error",
			"manifest remote differs from Git origin",
			"verify the intended journal before syncing",
		);
	} else add("remote.consistent", "ok", "manifest remote and Git origin agree");
}

function finish(checks: DoctorCheck[], project?: ResolvedProject): DoctorResult {
	return {
		schema: 1,
		kind: "doctor",
		...(project ? { project: { id: project.id, name: project.name, store: project.storePath } } : {}),
		checks,
		summary: {
			ok: checks.filter((check) => check.status === "ok").length,
			warnings: checks.filter((check) => check.status === "warning").length,
			errors: checks.filter((check) => check.status === "error").length,
		},
	};
}

export function renderDoctor(result: DoctorResult): string[] {
	const lines = [result.project ? `doctor: ${result.project.name} · ${result.project.id}` : "doctor: no project"];
	for (const check of result.checks) {
		lines.push(
			`${check.status === "ok" ? "ok" : check.status === "warning" ? "warn" : "error"} ${check.code}: ${check.message}`,
		);
		if (check.remedy && check.status !== "ok") lines.push(`  remedy: ${check.remedy}`);
	}
	lines.push(
		`summary: ${result.summary.ok} ok · ${result.summary.warnings} warning(s) · ${result.summary.errors} error(s)`,
	);
	return lines;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
