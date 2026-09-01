import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newHostId } from "../../src/ids.ts";
import { runProjectCommand } from "../../src/project/command.ts";
import { RegistryCorruptError, readProjectRegistry } from "../../src/project/registry.ts";
import { linkLogicalProject, resolveLogicalProject } from "../../src/project/resolver.ts";
import { buildSessionContext } from "../../src/session.ts";
import { projectRegistryPath } from "../../src/store/paths.ts";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

let root: string;
let agentDir: string;
let hostId: string;

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
	});
	return stdout;
}

async function makeRepository(name: string): Promise<string> {
	const repo = join(root, name);
	mkdirSync(repo, { recursive: true });
	await git(repo, ["init", "--quiet", "--initial-branch=main"]);
	await git(repo, ["config", "user.name", "Muninn Test"]);
	await git(repo, ["config", "user.email", "muninn@example.test"]);
	writeFileSync(join(repo, "README.md"), `# ${name}\n`);
	await git(repo, ["add", "README.md"]);
	await git(repo, ["commit", "--quiet", "-m", "initial"]);
	return repo;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "muninn-project-resolver-"));
	agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	hostId = newHostId();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("logical project resolution", () => {
	it("maps linked worktrees to one UUID store through their Git common directory", async () => {
		const repository = await makeRepository("app");
		const first = await resolveLogicalProject({ agentDir, cwd: repository, hostId, create: true });
		const worktree = join(root, "app-feature");
		await git(repository, ["worktree", "add", "--quiet", "-b", "feature", worktree]);

		const second = await resolveLogicalProject({ agentDir, cwd: worktree, hostId, create: true });
		expect(second?.id).toBe(first?.id);
		expect(second?.storePath).toBe(first?.storePath);
		expect(second?.reason).toBe("git-common-dir");
		expect(second?.locations.map((location) => location.root).sort()).toEqual(
			[realpathSync(repository), realpathSync(worktree)].sort(),
		);
	});

	it("canonicalizes symlinked roots before looking in the registry", async () => {
		const repository = await makeRepository("symlinked");
		const link = join(root, "alias");
		symlinkSync(repository, link, "dir");
		const direct = await resolveLogicalProject({ agentDir, cwd: repository, hostId, create: true });
		const throughLink = await resolveLogicalProject({ agentDir, cwd: link, hostId, create: false });
		expect(throughLink?.id).toBe(direct?.id);
		expect(throughLink?.root).toBe(realpathSync(repository));
	});

	it("keeps the same project while HEAD is detached", async () => {
		const repository = await makeRepository("detached");
		const attached = await resolveLogicalProject({ agentDir, cwd: repository, hostId, create: true });
		await git(repository, ["checkout", "--quiet", "--detach"]);
		const detached = await resolveLogicalProject({ agentDir, cwd: repository, hostId, create: false });
		expect(detached?.id).toBe(attached?.id);
	});

	it("supports bare repositories and explicit non-Git roots", async () => {
		const bare = join(root, "archive.git");
		mkdirSync(bare);
		await git(bare, ["init", "--bare", "--quiet"]);
		const bareProject = await resolveLogicalProject({ agentDir, cwd: bare, hostId, create: true });
		expect(bareProject?.root).toBe(realpathSync(bare));
		expect(bareProject?.gitCommonDir).toBe(realpathSync(bare));

		const plain = join(root, "runbooks");
		mkdirSync(plain);
		const plainProject = await linkLogicalProject({ agentDir, cwd: plain, hostId, name: "runbooks" });
		expect(plainProject.gitCommonDir).toBeUndefined();
		expect(plainProject.id).not.toBe(bareProject?.id);
	});

	it("reconnects a renamed repository only when the user explicitly links its old UUID", async () => {
		const repository = await makeRepository("before");
		const original = await resolveLogicalProject({ agentDir, cwd: repository, hostId, create: true });
		const renamed = join(root, "after");
		renameSync(repository, renamed);

		expect(await resolveLogicalProject({ agentDir, cwd: renamed, hostId, create: false })).toBeUndefined();
		const linked = await linkLogicalProject({
			agentDir,
			cwd: renamed,
			hostId,
			projectId: original?.id as string,
		});
		expect(linked.id).toBe(original?.id);
		expect(linked.locations.map((location) => location.root)).toContain(realpathSync(renamed));
	});

	it("does not group independent repositories by the same code remote URL", async () => {
		const firstRepo = await makeRepository("fork-one");
		const secondRepo = await makeRepository("fork-two");
		for (const repository of [firstRepo, secondRepo]) {
			await git(repository, ["remote", "add", "origin", "https://example.test/team/app.git"]);
		}
		const first = await resolveLogicalProject({ agentDir, cwd: firstRepo, hostId, create: true });
		const second = await resolveLogicalProject({ agentDir, cwd: secondRepo, hostId, create: true });
		expect(second?.id).not.toBe(first?.id);
	});

	it("prefers the most specific explicit root mapping", async () => {
		const outer = join(root, "operations");
		const inner = join(outer, "service");
		mkdirSync(inner, { recursive: true });
		const outerProject = await linkLogicalProject({ agentDir, cwd: outer, hostId, name: "operations" });
		const innerProject = await linkLogicalProject({ agentDir, cwd: inner, hostId, name: "service" });
		expect(innerProject.id).toBe(outerProject.id);

		const otherId = "0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b09";
		await linkLogicalProject({ agentDir, cwd: inner, hostId, projectId: otherId, force: true });
		const selected = await resolveLogicalProject({ agentDir, cwd: inner, hostId, create: false });
		expect(selected?.id).toBe(otherId);
		expect(selected?.reason).toBe("root");
	});
});

describe("project registry safety", () => {
	it("does not accept a repository project hint during automatic resolution", async () => {
		const repository = await makeRepository("hinted");
		const hintedId = "0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b08";
		mkdirSync(join(repository, ".pi"));
		writeFileSync(
			join(repository, ".pi", "muninn-project.json"),
			JSON.stringify({ schema: 1, project: hintedId, name: "team-project" }),
		);

		const automatic = await resolveLogicalProject({ agentDir, cwd: repository, hostId, create: true });
		expect(automatic?.id).not.toBe(hintedId);
		await runProjectCommand(["unlink"], { agentDir, cwd: repository, hostId });
		const explicit = await runProjectCommand(["link"], { agentDir, cwd: repository, hostId });
		expect(explicit.out.join("\n")).toContain(hintedId);
		expect(explicit.out.join("\n")).toContain("accepting repository hint");
	});

	it("does not read or activate a repository hint for an untrusted project session", async () => {
		const repository = await makeRepository("untrusted");
		mkdirSync(join(repository, ".pi"));
		const hintPath = join(repository, ".pi", "muninn-project.json");
		writeFileSync(hintPath, JSON.stringify({ schema: 1, project: "0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b08" }));

		const session = await buildSessionContext({
			agentDir,
			cwd: repository,
			configDirName: ".pi",
			projectTrusted: false,
			createStores: false,
		});
		expect(session.project).toBeUndefined();
		expect(session.problems).toEqual([]);
		expect(existsSync(projectRegistryPath(agentDir))).toBe(false);
		expect(readFileSync(hintPath, "utf-8")).toContain("0198f2c1-7b3e");
	});

	it("fails loudly on a corrupted registry and preserves its bytes", async () => {
		const repository = await makeRepository("corrupt");
		const path = projectRegistryPath(agentDir);
		mkdirSync(join(agentDir, "muninn-projects"));
		writeFileSync(path, "{ not json\n");

		await expect(resolveLogicalProject({ agentDir, cwd: repository, hostId, create: true })).rejects.toBeInstanceOf(
			RegistryCorruptError,
		);
		expect(readFileSync(path, "utf-8")).toBe("{ not json\n");
	});

	it("serializes concurrent updates without losing projects or minting two IDs for one root", async () => {
		const one = join(root, "one");
		const two = join(root, "two");
		mkdirSync(one);
		mkdirSync(two);
		const [oneA, oneB, second] = await Promise.all([
			resolveLogicalProject({ agentDir, cwd: one, hostId, create: true }),
			resolveLogicalProject({ agentDir, cwd: one, hostId, create: true }),
			resolveLogicalProject({ agentDir, cwd: two, hostId, create: true }),
		]);
		expect(oneA?.id).toBe(oneB?.id);
		expect(second?.id).not.toBe(oneA?.id);
		const registry = readProjectRegistry(agentDir);
		expect(registry?.projects).toHaveLength(2);
		expect(registry?.member.id).toBe(oneA?.member.id);
		expect(readdirSync(join(agentDir, "muninn-projects")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("preserves both mappings when separate CLI processes update the registry together", async () => {
		const one = join(root, "process-one");
		const two = join(root, "process-two");
		mkdirSync(one);
		mkdirSync(two);
		const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
		await Promise.all(
			[one, two].map((cwd) =>
				execFileAsync(process.execPath, [CLI, "project", "link"], {
					cwd,
					env,
				}),
			),
		);
		const registry = readProjectRegistry(agentDir);
		expect(registry?.projects).toHaveLength(2);
		expect(registry?.projects.flatMap((project) => project.locations.map((location) => location.root)).sort()).toEqual(
			[realpathSync(one), realpathSync(two)].sort(),
		);
	});
});

describe("project commands", () => {
	it("links, shows, and unlinks without deleting the logical project record", async () => {
		const repository = await makeRepository("commands");
		const context = { agentDir, cwd: repository, hostId };
		const missing = await runProjectCommand(["show"], context);
		expect(missing.code).toBe(1);
		expect(existsSync(projectRegistryPath(agentDir))).toBe(false);

		const linked = await runProjectCommand(["link", "--name", "logical-commands"], context);
		expect(linked.code).toBe(0);
		expect(linked.out.join("\n")).toContain("logical-commands");
		const shown = await runProjectCommand(["show"], context);
		expect(shown.out.join("\n")).toContain("canonical root mapping");
		expect(shown.out.join("\n")).toContain("aliases");

		const unlinked = await runProjectCommand(["unlink"], context);
		expect(unlinked.code).toBe(0);
		expect((await runProjectCommand(["show"], context)).code).toBe(1);
		expect(readProjectRegistry(agentDir)?.projects).toHaveLength(1);
	});
});
