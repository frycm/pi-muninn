import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import { joinProjectJournal } from "../../src/project/onboarding.ts";
import { readProjectRegistry } from "../../src/project/registry.ts";
import { linkLogicalProject } from "../../src/project/resolver.ts";
import { ensureStore } from "../../src/store/init.ts";
import { projectRegistryPath, projectStorePath } from "../../src/store/paths.ts";
import { readProjectManifest, setProjectRemote } from "../../src/store/project-manifest.ts";
import { sync } from "../../src/sync/sync.ts";

const execFileAsync = promisify(execFile);
let root: string;
let remote: string;
let source: string;
let project: string;

function actor(name: string) {
	return {
		host: { id: newHostId(), name: `${name}-host`, createdAt: "2026-09-04T00:00:00.000Z" },
		member: { id: newMemberId(), name, createdAt: "2026-09-04T00:00:00.000Z" },
	};
}

async function rawGit(cwd: string, args: string[]): Promise<string> {
	return (await execFileAsync("git", args, { cwd })).stdout;
}

async function sharedJournal(): Promise<void> {
	const owner = actor("owner");
	await rawGit(root, ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
	await ensureStore(source, {
		host: owner.host,
		project: { id: project, name: "shared", member: owner.member, createdAt: "2026-09-04T00:00:00.000Z" },
	});
	setProjectRemote(source, remote);
	const pushed = await sync({
		storePath: source,
		hostId: owner.host.id,
		hostName: owner.host.name,
		remote,
	});
	expect(pushed.problem).toBeUndefined();
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "muninn-onboarding-"));
	remote = join(root, "shared.git");
	source = join(root, "source");
	project = newProjectId();
	await sharedJournal();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("project journal onboarding", () => {
	it("joins with the URL alone and reuses the validated store for another local clone", async () => {
		const agentDir = join(root, "target-agent");
		const firstCode = join(root, "first-code");
		const secondCode = join(root, "second-code");
		mkdirSync(firstCode);
		mkdirSync(secondCode);
		const local = actor("local");

		const first = await joinProjectJournal({ agentDir, cwd: firstCode, host: local.host, remote });
		expect(first).toMatchObject({ schema: 1, remote, storeCreated: true });
		expect(first.project.id).toBe(project);
		const destination = projectStorePath(agentDir, project);
		expect(existsSync(destination)).toBe(true);
		expect(readProjectManifest(destination)?.members.map((member) => member.id)).toContain(first.project.member.id);
		expect(readProjectRegistry(agentDir)?.member.id).toBe(first.project.member.id);

		const second = await joinProjectJournal({ agentDir, cwd: secondCode, host: local.host, remote });
		expect(second.storeCreated).toBe(false);
		expect(readProjectRegistry(agentDir)?.projects.find((item) => item.id === project)?.locations).toHaveLength(2);
	});

	it("removes the staged store and preserves registry bytes when a mapping needs --force", async () => {
		const agentDir = join(root, "target-agent");
		const code = join(root, "code");
		mkdirSync(code);
		const local = actor("local");
		await linkLogicalProject({ agentDir, cwd: code, hostId: local.host.id, name: "other" });
		const before = readFileSync(projectRegistryPath(agentDir));

		await expect(joinProjectJournal({ agentDir, cwd: code, host: local.host, remote })).rejects.toThrow(/--force/);
		expect(readFileSync(projectRegistryPath(agentDir))).toEqual(before);
		expect(existsSync(projectStorePath(agentDir, project))).toBe(false);

		const joined = await joinProjectJournal({ agentDir, cwd: code, host: local.host, remote, force: true });
		expect(joined.project.id).toBe(project);
	});

	it("rejects unexpected tracked content before creating a registry or destination", async () => {
		writeFileSync(join(source, "payload.sh"), "echo no\n");
		await rawGit(source, ["add", "payload.sh"]);
		await rawGit(source, ["commit", "--quiet", "-m", "unexpected"]);
		await rawGit(source, ["push", "--quiet", "origin", "main"]);
		const agentDir = join(root, "target-agent");
		const code = join(root, "code");
		mkdirSync(code);
		const local = actor("local");

		await expect(joinProjectJournal({ agentDir, cwd: code, host: local.host, remote })).rejects.toThrow(
			/unexpected path payload\.sh/,
		);
		expect(existsSync(projectRegistryPath(agentDir))).toBe(false);
		expect(existsSync(projectStorePath(agentDir, project))).toBe(false);
	});

	it("rejects unsafe URLs before invoking Git", async () => {
		const local = actor("local");
		await expect(
			joinProjectJournal({
				agentDir: join(root, "target-agent"),
				cwd: root,
				host: local.host,
				remote: "https://token@example.com/team/journal.git",
			}),
		).rejects.toThrow(/unsafe|credentials/);
	});
});
