import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../../src/git.ts";
import { newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import type { MemberIdentity } from "../../src/project/registry.ts";
import type { HostIdentity } from "../../src/store/host.ts";
import { type EnsureProjectStoreOptions, ensureStore } from "../../src/store/init.ts";
import { parseProjectManifest, readProjectManifest } from "../../src/store/project-manifest.ts";

const execFileAsync = promisify(execFile);
let root: string;
let store: string;
let host: HostIdentity;
let member: MemberIdentity;
let project: string;

function options(actorHost = host, actorMember = member): EnsureProjectStoreOptions {
	return {
		host: actorHost,
		project: { id: project, name: "demo", createdAt: "2026-08-01T00:00:00.000Z", member: actorMember },
	};
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "muninn-init-"));
	store = join(root, "store");
	host = { id: newHostId(), name: "mbp", createdAt: "2026-08-01T00:00:00.000Z" };
	member = { id: newMemberId(), name: "Martin", createdAt: "2026-08-01T00:00:00.000Z" };
	project = newProjectId();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function commits(): Promise<number> {
	return Number((await git(store, { kind: "log-count" })).stdout.trim());
}

describe("ensureStore", () => {
	it("creates a clean, committed project store with member/host writer ownership", async () => {
		const result = await ensureStore(store, options());
		expect(result.created).toBe(true);
		expect(existsSync(join(store, ".git"))).toBe(true);
		expect(existsSync(join(store, "project.json"))).toBe(true);
		expect(existsSync(join(store, "journal", member.id, host.id))).toBe(true);
		expect(result.manifest).toMatchObject({ project, remote: null });
		expect(result.manifest.members).toEqual([{ id: member.id, name: member.name }]);
		expect(result.manifest.hosts).toEqual([{ id: host.id, name: host.name, member: member.id }]);
		expect((await git(store, { kind: "status-porcelain", paths: [] })).stdout.trim()).toBe("");
		expect(await commits()).toBe(1);
	});

	it("is idempotent for the same actor", async () => {
		await ensureStore(store, options());
		const second = await ensureStore(store, options());
		expect(second.created).toBe(false);
		expect(await commits()).toBe(1);
	});

	it("registers another team member and host without changing project identity", async () => {
		await ensureStore(store, options());
		const teammate = { id: newMemberId(), name: "Ada", createdAt: "2026-08-02T00:00:00.000Z" };
		const server = { id: newHostId(), name: "ops", createdAt: "2026-08-02T00:00:00.000Z" };
		await ensureStore(store, options(server, teammate));
		const manifest = readProjectManifest(store);
		expect(manifest?.project).toBe(project);
		expect(manifest?.members.map((item) => item.name).sort()).toEqual(["Ada", "Martin"]);
		expect(manifest?.hosts.map((item) => item.name).sort()).toEqual(["mbp", "ops"]);
		expect(await commits()).toBe(2);
	});

	it("refuses member or host identity collisions", async () => {
		await ensureStore(store, options());
		await expect(
			ensureStore(store, options(host, { id: member.id, name: "Someone else", createdAt: member.createdAt })),
		).rejects.toThrow(/member id collision/);
		const otherMember = { id: newMemberId(), name: "Ada", createdAt: "2026-08-02T00:00:00.000Z" };
		await expect(ensureStore(store, options({ ...host, name: "renamed" }, otherMember))).rejects.toThrow(
			/host id collision/,
		);
	});

	it("refuses to overwrite an unreadable project manifest", async () => {
		mkdirSync(store, { recursive: true });
		writeFileSync(join(store, "project.json"), "{broken");
		await expect(ensureStore(store, options())).rejects.toThrow(/project manifest.*invalid/);
		expect(readFileSync(join(store, "project.json"), "utf-8")).toBe("{broken");
	});

	it("rejects a manifest with a non-canonical creation timestamp", () => {
		expect(() =>
			parseProjectManifest(
				JSON.stringify({
					schema: 1,
					project,
					name: "demo",
					created_at: "yesterday",
					remote: null,
					members: [],
					hosts: [],
				}),
			),
		).toThrow(/created_at.*RFC 3339/);
	});

	it("uses its own repository when nested inside another one", async () => {
		const outer = join(root, "outer");
		mkdirSync(outer);
		await execFileAsync("git", ["init", "--quiet"], { cwd: outer });
		await execFileAsync("git", ["config", "user.email", "dev@example.com"], { cwd: outer });
		await execFileAsync("git", ["config", "user.name", "Dev"], { cwd: outer });
		writeFileSync(join(outer, "README.md"), "# outer\n");
		await execFileAsync("git", ["add", "README.md"], { cwd: outer });
		await execFileAsync("git", ["commit", "--quiet", "-m", "initial"], { cwd: outer });
		store = join(outer, "agent", "journal");
		await ensureStore(store, options());
		const top = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: store });
		expect(realpathSync(top.stdout.trim())).toBe(realpathSync(store));
		expect((await execFileAsync("git", ["log", "-1", "--format=%s"], { cwd: outer })).stdout.trim()).toBe("initial");
	});

	it("uses main and a store-owned commit identity", async () => {
		await ensureStore(store, options());
		expect((await git(store, { kind: "current-branch" })).stdout.trim()).toBe("main");
		const config = readFileSync(join(store, ".git", "config"), "utf-8");
		expect(config).toContain(`muninn@${host.id}`);
		expect(config).toContain("muninn mbp");
	});
});
