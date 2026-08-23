import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../../src/git.ts";
import { newHostId } from "../../src/ids.ts";
import type { HostIdentity } from "../../src/store/host.ts";
import { ensureStore, SchemaTooNewError } from "../../src/store/init.ts";
import { parseStoreMd } from "../../src/store/store-md.ts";

let root: string;
let store: string;
let host: HostIdentity;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "muninn-init-"));
	store = join(root, "store");
	host = { id: newHostId(), name: "mbp", createdAt: new Date().toISOString() };
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

async function log(cwd: string): Promise<string> {
	const { stdout } = await git(cwd, { kind: "log-count" });
	return stdout.trim();
}

describe("ensureStore — creating", () => {
	it("creates a committed store with the documented layout", async () => {
		const result = await ensureStore(store, { host });
		expect(result.created).toBe(true);

		expect(existsSync(join(store, ".git"))).toBe(true);
		expect(existsSync(join(store, "store.md"))).toBe(true);
		expect(existsSync(join(store, "MEMORY.md"))).toBe(true);
		expect(existsSync(join(store, ".gitignore"))).toBe(true);
		expect(existsSync(join(store, "journal", host.id))).toBe(true);
		expect(await log(store)).toBe("1");
	});

	it("registers this host in store.md", async () => {
		const result = await ensureStore(store, { host });
		expect(result.store.hosts).toHaveLength(1);
		expect(result.store.hosts[0]?.id).toBe(host.id);

		const onDisk = parseStoreMd(readFileSync(join(store, "store.md"), "utf-8"));
		expect(onDisk.store?.hosts[0]?.id).toBe(host.id);
		expect(onDisk.problems).toEqual([]);
	});

	it("gitignores everything derived or machine-local", async () => {
		await ensureStore(store, { host });
		const ignored = readFileSync(join(store, ".gitignore"), "utf-8");
		for (const path of [".index/", ".lock", ".lock.json", "host.json"]) expect(ignored).toContain(path);
	});

	it("leaves a clean git status, with nothing untracked", async () => {
		// The host identity file lives inside the global store. If it were not
		// ignored it would sit there untracked forever, and worse, a sync could
		// hand this machine's host id to another one.
		await ensureStore(store, { host });
		writeFileSync(join(store, "host.json"), JSON.stringify(host));

		const { stdout } = await git(store, { kind: "status-porcelain", paths: [] });
		expect(stdout.trim()).toBe("");
	});

	it("commits under a muninn identity, not the developer's", async () => {
		// A memory repository must not inherit whatever identity happened to be
		// configured in the shell that started pi.
		await ensureStore(store, { host });
		const config = readFileSync(join(store, ".git", "config"), "utf-8");
		expect(config).toContain(`muninn@${host.id}`);
		expect(config).toContain("muninn mbp");
	});

	it("refuses to blank a git identity", async () => {
		// `config` is a setter with no read form, so an empty value would quietly
		// leave the store committing with no author.
		await expect(git(store, { kind: "config", key: "user.email", value: "" })).rejects.toThrow(/non-empty/);
	});

	it("leaves no lock behind", async () => {
		await ensureStore(store, { host });
		expect(existsSync(join(store, ".lock"))).toBe(false);
		expect(existsSync(join(store, ".lock.json"))).toBe(false);
	});
});

describe("ensureStore — idempotence", () => {
	it("is a no-op the second time", async () => {
		const first = await ensureStore(store, { host });
		const second = await ensureStore(store, { host });

		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(second.store.store).toBe(first.store.store);
		expect(await log(store)).toBe("1");
	});

	it("registers a second host without disturbing the first", async () => {
		await ensureStore(store, { host });
		const other: HostIdentity = { id: newHostId(), name: "ops1", createdAt: new Date().toISOString() };
		const result = await ensureStore(store, { host: other });

		expect(result.store.hosts.map((h) => h.name).sort()).toEqual(["mbp", "ops1"]);
		expect(await log(store)).toBe("2");
		expect(existsSync(join(store, "journal", other.id))).toBe(true);
	});

	it("keeps a hand-edited MEMORY.md", async () => {
		await ensureStore(store, { host });
		writeFileSync(join(store, "MEMORY.md"), "# Memory\n\n- something I wrote by hand\n");
		await ensureStore(store, { host });
		expect(readFileSync(join(store, "MEMORY.md"), "utf-8")).toContain("by hand");
	});
});

describe("ensureStore — refusing to make things worse", () => {
	it("refuses to overwrite an unreadable store.md", async () => {
		mkdirSync(store, { recursive: true });
		writeFileSync(join(store, "store.md"), "# muninn store\n\nnothing useful here\n");
		await expect(ensureStore(store, { host })).rejects.toThrow(/refusing to overwrite/);
		expect(readFileSync(join(store, "store.md"), "utf-8")).toContain("nothing useful");
	});

	it("refuses a store written by a newer Muninn", async () => {
		await ensureStore(store, { host });
		const text = readFileSync(join(store, "store.md"), "utf-8").replace("schema: 1", "schema: 99");
		writeFileSync(join(store, "store.md"), text);
		await expect(ensureStore(store, { host })).rejects.toBeInstanceOf(SchemaTooNewError);
	});
});

describe("ensureStore — in-repo stores live in someone else's repository", () => {
	async function makeProjectRepo(): Promise<string> {
		const repo = join(root, "project");
		mkdirSync(repo, { recursive: true });
		await git(repo, { kind: "init" });
		await git(repo, { kind: "config", key: "user.name", value: "Real Developer" });
		await git(repo, { kind: "config", key: "user.email", value: "dev@example.com" });
		writeFileSync(join(repo, "MEMORY.md"), "project file that happens to share a name\n");
		await git(repo, { kind: "add", paths: ["MEMORY.md"] });
		await git(repo, { kind: "commit", message: "initial", paths: ["MEMORY.md"] });
		return repo;
	}

	it("does not reconfigure the project's git identity", async () => {
		const repo = await makeProjectRepo();
		await ensureStore(join(repo, ".pi", "muninn"), { host, inRepo: true });
		const config = readFileSync(join(repo, ".git", "config"), "utf-8");
		expect(config).toContain("dev@example.com");
		expect(config).not.toContain("muninn@");
	});

	it("does not sweep up the developer's staged work", async () => {
		// The hazard: `git commit` in a repo Muninn does not own would commit
		// whatever was already in the index. The pathspec on commit prevents it.
		const repo = await makeProjectRepo();
		writeFileSync(join(repo, "feature.txt"), "half-finished work\n");
		await git(repo, { kind: "add", paths: ["MEMORY.md"] });
		writeFileSync(join(repo, "MEMORY.md"), "developer's own edit, staged\n");
		await git(repo, { kind: "add", paths: ["MEMORY.md"] });

		await ensureStore(join(repo, ".pi", "muninn"), { host, inRepo: true });

		const { stdout } = await git(repo, { kind: "status-porcelain", paths: ["MEMORY.md"] });
		expect(stdout).toContain("MEMORY.md"); // still staged, not committed by muninn
		expect(existsSync(join(repo, "feature.txt"))).toBe(true);
	});

	it("does not re-initialise the surrounding repository", async () => {
		const repo = await makeProjectRepo();
		const before = await log(repo);
		await ensureStore(join(repo, ".pi", "muninn"), { host, inRepo: true });
		expect(Number.parseInt(await log(repo), 10)).toBe(Number.parseInt(before, 10) + 1);
	});
});
