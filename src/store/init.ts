/** Create and validate one Git-backed logical-project journal store. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GitIdentity, git, gitToplevel } from "../git.ts";
import type { MemberIdentity } from "../project/registry.ts";
import type { ResolvedProject } from "../project/resolver.ts";
import type { HostIdentity } from "./host.ts";
import { withStoreLock } from "./lock.ts";
import { canonicalPath } from "./paths.ts";
import {
	ensureProjectManifest,
	type ProjectManifest,
	type ProjectManifestIdentity,
	projectManifestPath,
} from "./project-manifest.ts";

const GITIGNORE = [
	"# Derived, rebuildable, or machine-local. Never committed.",
	".index/",
	".lock",
	".lock.json",
	"",
].join("\n");

export interface EnsureStoreResult {
	path: string;
	created: boolean;
	manifest: ProjectManifest;
	problems: string[];
}

export const STORE_BRANCH = "main";

export function storeIdentity(host: HostIdentity): GitIdentity {
	return { name: `muninn ${host.name}`, email: `muninn@${host.id}` };
}

export interface EnsureProjectStoreOptions {
	host: HostIdentity;
	project: {
		id: string;
		name: string;
		createdAt?: string;
		member: MemberIdentity;
	};
}

export function projectStoreIdentity(project: ResolvedProject, host: HostIdentity): EnsureProjectStoreOptions {
	return {
		host,
		project: {
			id: project.id,
			name: project.name,
			member: project.member,
			...(project.locations[0]?.linkedAt ? { createdAt: project.locations[0].linkedAt } : {}),
		},
	};
}

/** Idempotently create the owned repository and register this member/host. */
export async function ensureStore(storePath: string, options: EnsureProjectStoreOptions): Promise<EnsureStoreResult> {
	mkdirSync(storePath, { recursive: true });
	return withStoreLock(storePath, "init", { host: options.host.id }, async () => {
		const manifestPath = projectManifestPath(storePath);
		const existed = existsSync(manifestPath);
		const staged = new Set<string>();
		const identity = storeIdentity(options.host);
		let fresh = false;
		const toplevel = await gitToplevel(storePath);
		const canonical = canonicalPath(storePath);
		if (toplevel === undefined || canonicalPath(toplevel) !== canonical) {
			await git(storePath, { kind: "init" });
			await git(storePath, { kind: "set-head", branch: STORE_BRANCH });
			await git(storePath, { kind: "config", key: "user.name", value: identity.name });
			await git(storePath, { kind: "config", key: "user.email", value: identity.email });
			fresh = true;
		} else {
			await ensureBranch(storePath);
			if (!hasConfiguredIdentity(storePath)) {
				await git(storePath, { kind: "config", key: "user.name", value: identity.name });
				await git(storePath, { kind: "config", key: "user.email", value: identity.email });
			}
		}

		if (!existsSync(join(storePath, ".gitignore"))) {
			writeFileSync(join(storePath, ".gitignore"), GITIGNORE);
			staged.add(".gitignore");
		}
		const manifestIdentity: ProjectManifestIdentity = {
			id: options.project.id,
			name: options.project.name,
			member: { id: options.project.member.id, name: options.project.member.name },
			host: { id: options.host.id, name: options.host.name },
			...(options.project.createdAt ? { createdAt: options.project.createdAt } : {}),
		};
		const ensured = ensureProjectManifest(storePath, manifestIdentity);
		if (ensured.changed) staged.add("project.json");
		if (fresh) {
			for (const name of [".gitignore", "project.json", "migration.json"]) {
				if (existsSync(join(storePath, name))) staged.add(name);
			}
		}
		mkdirSync(join(storePath, "journal", options.project.member.id, options.host.id), { recursive: true });

		if (staged.size > 0) {
			const paths = [...staged];
			await git(storePath, { kind: "add", paths });
			await git(
				storePath,
				{
					kind: "commit",
					message:
						existed && !fresh
							? `project: register ${options.project.member.name}/${options.host.name}`
							: "project: initialise journal",
					paths,
				},
				{ identity },
			);
		}
		return { path: storePath, created: !existed, manifest: ensured.manifest, problems: [] };
	});
}

async function ensureBranch(storePath: string): Promise<void> {
	let branch: string;
	try {
		branch = (await git(storePath, { kind: "current-branch" })).stdout.trim();
	} catch {
		return;
	}
	if (branch === "" || branch === STORE_BRANCH) return;
	await git(storePath, { kind: "branch-rename", to: STORE_BRANCH });
}

function hasConfiguredIdentity(storePath: string): boolean {
	try {
		return /^\[user\]/m.test(readFileSync(join(storePath, ".git", "config"), "utf-8"));
	} catch {
		return false;
	}
}
