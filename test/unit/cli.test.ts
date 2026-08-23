import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_DIR_ENV, CONFIG_DIR, resolveAgentDir } from "../../src/agent-dir.ts";
import { resetCommitDebounce } from "../../src/capture/commit.ts";
import { runCli } from "../../src/cli.ts";
import { appendEntry } from "../../src/journal/append.ts";
import { loadHostIdentity } from "../../src/store/host.ts";
import { ensureStore } from "../../src/store/init.ts";
import { globalStorePath } from "../../src/store/paths.ts";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

let root: string;
let agentDir: string;
let remote: string;
let cwd: string;
let previousAgentDir: string | undefined;

async function git(dir: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
	return stdout;
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "muninn-cli-"));
	agentDir = join(root, "agent");
	remote = join(root, "remote.git");
	cwd = join(root, "elsewhere");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(remote, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	await git(remote, ["init", "--bare", "--quiet", "--initial-branch=main"]);

	previousAgentDir = process.env[AGENT_DIR_ENV];
	process.env[AGENT_DIR_ENV] = agentDir;
	resetCommitDebounce();
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

function settings(muninn: Record<string, unknown>): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ muninn }, null, "\t"));
}

async function seedGlobalStore(): Promise<string> {
	const host = loadHostIdentity(agentDir);
	const store = globalStorePath(agentDir);
	await ensureStore(store, { host });
	await git(store, ["branch", "-M", "main"]);
	await appendEntry(
		{ source: "user", prose: "", claims: ["Deploys need the VPN."] },
		{ storePath: store, hostId: host.id },
	);
	return store;
}

describe("resolveAgentDir", () => {
	it("honours the variable pi reads", () => {
		// Pinned deliberately: pi's own `getAgentDir` reads this name, and a
		// drift would leave the CLI looking at a store nobody else uses.
		expect(AGENT_DIR_ENV).toBe("PI_CODING_AGENT_DIR");
		expect(resolveAgentDir({ [AGENT_DIR_ENV]: "/tmp/elsewhere" }, "/home/u")).toBe("/tmp/elsewhere");
	});

	it("expands a leading tilde, as pi does", () => {
		expect(resolveAgentDir({ [AGENT_DIR_ENV]: "~/memories" }, "/home/u")).toBe("/home/u/memories");
	});

	it("falls back to pi's default location", () => {
		expect(resolveAgentDir({}, "/home/u")).toBe(join("/home/u", CONFIG_DIR, "agent"));
	});
});

describe("muninn (cli)", () => {
	it("prints usage and exits cleanly", async () => {
		const result = await runCli(["help"], cwd);
		expect(result.code).toBe(0);
		expect(result.out.join("\n")).toContain("muninn sync [--scope global|project]");
	});

	it("reports an unknown command with usage", async () => {
		const result = await runCli(["dream"], cwd);
		expect(result.code).toBe(2);
		expect(result.err.join("\n")).toContain('unknown command "dream"');
	});

	it("says when there is no store to work with", async () => {
		const result = await runCli(["status"], cwd);
		expect(result.code).toBe(1);
		expect(result.err.join("\n")).toContain("no memory store exists here");
	});

	it("reports what is in the store, and where it syncs to", async () => {
		await seedGlobalStore();
		settings({ sync: { remote } });

		const result = await runCli(["status"], cwd);
		expect(result.code).toBe(0);
		const text = result.out.join("\n");
		expect(text).toContain("global:");
		expect(text).toContain("1 entries, 1 claims");
		expect(text).toContain(`remote: ${remote}`);
	});

	it("says plainly when no remote is configured", async () => {
		await seedGlobalStore();
		const result = await runCli(["status"], cwd);
		expect(result.out.join("\n")).toContain("none configured (sync.remote)");
	});

	it("syncs the global store to the configured remote", async () => {
		await seedGlobalStore();
		settings({ sync: { remote } });

		const result = await runCli(["sync"], cwd);
		expect(result.code).toBe(0);
		expect(result.out.join("\n")).toContain("sync: committed, fetched, pushed");
		expect(await git(remote, ["log", "-1", "--format=%s", "main"])).toContain("journal:");
	});

	it("skips the push when asked", async () => {
		await seedGlobalStore();
		settings({ sync: { remote } });

		const result = await runCli(["sync", "--no-push"], cwd);
		expect(result.out.join("\n")).toContain("push skipped");
		await expect(git(remote, ["log", "-1", "--format=%s", "main"])).rejects.toThrow();
	});

	it("reports an unreachable remote as a warning, not a failure", async () => {
		// A laptop that syncs from cron while offline must not fill a mailbox
		// with failures: the journal is committed, and the next run carries it.
		await seedGlobalStore();
		settings({ sync: { remote: join(root, "gone.git") } });

		const result = await runCli(["sync"], cwd);
		expect(result.code).toBe(0);
		expect(result.out.join("\n")).toContain("offline");
	});

	it("rejects a scope it does not know", async () => {
		const result = await runCli(["sync", "--scope", "team"], cwd);
		expect(result.code).toBe(2);
		expect(result.err.join("\n")).toContain('--scope takes "global" or "project"');
	});

	it("says when the named scope has no store here", async () => {
		await seedGlobalStore();
		const result = await runCli(["status", "--scope", "project"], cwd);
		expect(result.code).toBe(1);
		expect(result.err.join("\n")).toContain("no project store exists here");
	});
});

describe("muninn (cli), as a program", () => {
	it("runs from source on this node, with no build step", async () => {
		// The bin entry points at the TypeScript directly; node ≥ 22.19 strips
		// the types, which is also how pi loads the extension.
		const { stdout } = await execFileAsync(process.execPath, [CLI, "--version"], {
			env: { ...process.env, [AGENT_DIR_ENV]: agentDir },
		});
		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
	}, 30_000);
});
