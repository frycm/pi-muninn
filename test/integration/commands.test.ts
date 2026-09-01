/**
 * `/muninn …`, through a real pi process.
 *
 * Print mode executes extension commands rather than prompting the model
 * (`core/agent-session.js:799`), so each subcommand can be driven with
 * `pi -p "/muninn …"`. Its answers are asserted on stderr: `ctx.ui.notify` is
 * a no-op where there is no UI (`core/extensions/runner.ts:92`), and a command
 * that answered nowhere in headless mode would be a command nobody could use
 * from a script.
 */
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStoreJournal } from "../../src/journal/read.ts";
import { readProjectRegistry } from "../../src/project/registry.ts";
import { projectStorePath } from "../../src/store/paths.ts";
import { type MockProvider, startMockProvider } from "../fixtures/mock-provider.ts";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PI = join(ROOT, "node_modules", ".bin", "pi");
const MUNINN = join(ROOT, "src", "index.ts");
const PROVIDER_EXTENSION = join(ROOT, "test", "fixtures", "mock-provider-extension.ts");

let home: string;
let agentDir: string;
let project: string;
let mock: MockProvider;
let remote: string;

async function git(cwd: string, args: string[]): Promise<void> {
	await execFileAsync("git", args, { cwd });
}

/** Run pi with one or more prompts; returns what it wrote to stderr and stdout. */
async function pi(...prompts: string[]): Promise<{ stdout: string; stderr: string }> {
	const args = ["-p", ...prompts, "--model", "muninn-test/mock", "-e", PROVIDER_EXTENSION, "-e", MUNINN];
	const child = spawn(PI, args, {
		cwd: project,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, MUNINN_TEST_PROVIDER_URL: mock.url },
	});

	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	const code = await new Promise<number | null>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`pi timed out.\nstdout: ${stdout}\nstderr: ${stderr}`));
		}, 90_000);
		child.on("error", reject);
		child.on("close", (exitCode) => {
			clearTimeout(timer);
			resolve(exitCode);
		});
	});

	if (code !== 0) throw new Error(`pi exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`);
	return { stdout, stderr };
}

function projectStore(): string {
	const registry = readProjectRegistry(agentDir);
	return projectStorePath(agentDir, registry?.projects[0]?.id as string);
}

function globalStore(): string {
	return join(agentDir, "muninn");
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "muninn-cmd-e2e-"));
	agentDir = join(home, "agent");
	project = join(home, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });

	await git(project, ["init", "--quiet"]);
	await git(project, ["config", "user.email", "dev@example.com"]);
	await git(project, ["config", "user.name", "Dev"]);
	writeFileSync(join(project, "README.md"), "# Project\n");
	await git(project, ["add", "README.md"]);
	await git(project, ["commit", "--quiet", "-m", "initial"]);

	// A bare remote and a `sync.remote` setting, so `/muninn sync` has somewhere
	// to push in the same way an operator's private remote would.
	remote = join(home, "remote.git");
	mkdirSync(remote, { recursive: true });
	await git(remote, ["init", "--bare", "--quiet", "--initial-branch=main"]);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ muninn: { sync: { remote, onShutdown: false } } }, null, "\t"),
	);

	mock = await startMockProvider(["Understood."]);
}, 60_000);

afterAll(async () => {
	await mock?.close();
	rmSync(home, { recursive: true, force: true });
});

describe("/muninn", () => {
	it("reports status", async () => {
		const { stderr } = await pi("/muninn");
		expect(stderr).toContain("⟡ muninn");
		expect(stderr).toContain("host ");
		expect(stderr).toContain("capture ");
		expect(stderr).toContain("index ");
	}, 60_000);

	it("explains the scopes", async () => {
		const { stderr } = await pi("/muninn scope");
		expect(stderr).toContain("scopes here:");
		expect(stderr).toContain("capture target: project");
	}, 60_000);

	it("prints usage for an unknown subcommand", async () => {
		const { stderr } = await pi("/muninn frobnicate");
		expect(stderr).toContain('unknown subcommand "frobnicate"');
		expect(stderr).toContain("/muninn promote <id>");
	}, 60_000);
});

describe("/muninn note, search, promote", () => {
	it("notes, finds and promotes, in one session", async () => {
		const { stderr } = await pi(
			"/muninn note Deploys need the VPN; staging is unreachable without it.",
			"/muninn search deploys VPN",
		);

		expect(stderr).toContain("noted in the project store as j-");
		expect(stderr).toMatch(/1 journal record for "deploys VPN"/);
		expect(stderr).toContain("· project · user ·");

		const entry = readStoreJournal(projectStore()).entries.find((candidate) => candidate.source === "user");
		expect(entry?.claims).toEqual(["Deploys need the VPN; staging is unreachable without it."]);

		// …and promoting it puts a copy in the global journal, naming its origin.
		const promoted = await pi(`/muninn promote ${entry?.id}`);
		expect(promoted.stderr).toContain("into the global journal as j-");

		const global = readStoreJournal(globalStore()).entries;
		expect(global).toHaveLength(1);
		expect(global[0]?.claims).toEqual(["Deploys need the VPN; staging is unreachable without it."]);
		expect(global[0]?.promotedFrom).toBe(`${readProjectRegistry(agentDir)?.projects[0]?.id}/${entry?.id}`);
	}, 90_000);

	it("commits a write to the global store, not only the capture target", async () => {
		// The capture target is the project store, and a commit of it used to
		// leave a `--global` note or a promoted entry sitting uncommitted in the
		// global store until a sync happened to run.
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ muninn: { sync: { remote, onShutdown: false } } }, null, "\t"),
		);
		await pi("/muninn note --global Committed where it was written.");

		const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: globalStore() });
		expect(stdout.trim()).toBe("");
		const { stdout: subject } = await execFileAsync("git", ["log", "-1", "--format=%s"], { cwd: globalStore() });
		expect(subject).toMatch(/^journal:/);
	}, 60_000);

	it("writes to the global store with --global", async () => {
		const before = readStoreJournal(globalStore()).entries.length;
		await pi("/muninn note --global Always use pnpm, never npm.");
		const after = readStoreJournal(globalStore()).entries;
		expect(after).toHaveLength(before + 1);
		expect(after[after.length - 1]?.claims).toEqual(["Always use pnpm, never npm."]);
	}, 60_000);

	it("suggests a different query when a search finds nothing", async () => {
		const { stderr } = await pi("/muninn search kubernetes helm charts");
		expect(stderr).toContain("try different words");
	}, 60_000);
});

describe("/muninn reindex and sync", () => {
	it("rebuilds the index", async () => {
		const { stderr } = await pi("/muninn reindex");
		expect(stderr).toMatch(/index rebuilt — \d+ chunks?/);
	}, 60_000);

	it("commits, fetches and pushes the global store", async () => {
		await pi("/muninn note --global Sync me to the remote.");
		const { stderr } = await pi("/muninn sync");

		expect(stderr).toContain("global: sync:");
		expect(stderr).toContain("pushed to origin/");
		const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%s", "main"], { cwd: remote });
		expect(stdout).toMatch(/^(journal|store):/);

		// The project store has no remote of its own, and says so rather than
		// pushing project memory to the operator's personal remote.
		expect(stderr).toContain("no remote configured — committed locally only");
	}, 90_000);
});

describe("sync at shutdown", () => {
	it("pushes what the session captured, when sync.onShutdown is on", async () => {
		// The laptop case the design is built around: nobody types `/muninn
		// sync`, the session ends, and the journal is on the remote.
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ muninn: { sync: { remote, onShutdown: true } } }, null, "\t"),
		);

		const { stdout: before } = await execFileAsync("git", ["rev-list", "--count", "main"], { cwd: remote });
		await pi("/muninn note --global The shutdown sync carried this.");
		const { stdout: after } = await execFileAsync("git", ["rev-list", "--count", "main"], { cwd: remote });

		expect(Number.parseInt(after.trim(), 10)).toBeGreaterThan(Number.parseInt(before.trim(), 10));
		const { stdout: pushed } = await execFileAsync("git", ["log", "--format=%s", "main"], { cwd: remote });
		expect(pushed).toContain("journal:");
	}, 90_000);
});
