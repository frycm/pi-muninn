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
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStoreJournal } from "../../src/journal/read.ts";
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
	const projects = join(agentDir, "muninn-projects");
	return join(projects, readdirSync(projects)[0] as string);
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
		const { stderr } = await pi("/muninn dreamm");
		expect(stderr).toContain('unknown subcommand "dreamm"');
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
		expect(stderr).toMatch(/1 memory for "deploys VPN"/);
		expect(stderr).toContain("· project · user ·");

		const entry = readStoreJournal(projectStore()).entries.find((candidate) => candidate.source === "user");
		expect(entry?.claims).toEqual(["Deploys need the VPN; staging is unreachable without it."]);

		// …and promoting it puts a copy in the global journal, naming its origin.
		const promoted = await pi(`/muninn promote ${entry?.id}`);
		expect(promoted.stderr).toContain("into the global journal as j-");

		const global = readStoreJournal(globalStore()).entries;
		expect(global).toHaveLength(1);
		expect(global[0]?.claims).toEqual(["Deploys need the VPN; staging is unreachable without it."]);
		expect(global[0]?.promotedFrom).toMatch(new RegExp(`^project-[0-9a-f]{12}/${entry?.id}$`));
	}, 90_000);

	it("writes to the global store with --global", async () => {
		const before = readStoreJournal(globalStore()).entries.length;
		await pi("/muninn note --global Always use pnpm, never npm.");
		const after = readStoreJournal(globalStore()).entries;
		expect(after).toHaveLength(before + 1);
		expect(after[after.length - 1]?.claims).toEqual(["Always use pnpm, never npm."]);
	}, 60_000);

	it("says how to widen a search that found nothing", async () => {
		const { stderr } = await pi("/muninn search kubernetes helm charts");
		expect(stderr).toContain("/muninn search --history");
	}, 60_000);
});

describe("/muninn reindex and sync", () => {
	it("rebuilds the index", async () => {
		const { stderr } = await pi("/muninn reindex");
		expect(stderr).toMatch(/index rebuilt — \d+ chunks?/);
	}, 60_000);

	it("says sync has not landed yet rather than failing as a typo", async () => {
		const { stderr } = await pi("/muninn sync");
		expect(stderr).toContain("not implemented yet");
	}, 60_000);
});
