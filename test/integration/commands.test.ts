/** Phase 3 attended commands through a real pi process. */
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanJournal } from "../../src/journal/jsonl.ts";
import { readProjectRegistry } from "../../src/project/registry.ts";
import { projectStorePath } from "../../src/store/paths.ts";
import { setProjectRemote } from "../../src/store/project-manifest.ts";
import { authorizeJournalRemote } from "../../src/sync/remote.ts";
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

function store(): string {
	const projectId = readProjectRegistry(agentDir)?.projects[0]?.id;
	return projectStorePath(agentDir, projectId as string);
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

describe("/muninn through pi", () => {
	it("reports status and the logical project mapping", async () => {
		expect((await pi("/muninn")).stderr).toContain("⟡ muninn");
		const shown = await pi("/muninn project");
		expect(shown.stderr).toMatch(/^project\s+/m);
		expect(shown.stderr).toMatch(/^member\s+/m);
		expect(shown.stderr).toContain("git common dir:");
	}, 60_000);

	it("prints the new interface for an unknown subcommand", async () => {
		const { stderr } = await pi("/muninn frobnicate");
		expect(stderr).toContain('unknown subcommand "frobnicate"');
		expect(stderr).toContain("/muninn correct ID TEXT");
		expect(stderr).not.toContain("/muninn promote");
	}, 60_000);

	it("reports local transport approval even when shared metadata advertises another URL", async () => {
		await pi("/muninn");
		const approved = join(home, "approved.git");
		await git(home, ["init", "--bare", "--quiet", "--initial-branch=main", approved]);
		setProjectRemote(store(), "https://example.test/advertised.git");
		try {
			const local = await pi("/muninn");
			expect(local.stderr).toMatch(/^sync\s+no project journal remote configured$/m);
			await authorizeJournalRemote(store(), approved);
			const configured = await pi("/muninn status");
			expect(configured.stderr.split("\n").find((line) => /^sync\s/.test(line))).toBe(`sync      ${approved}`);
		} finally {
			await authorizeJournalRemote(store(), null);
			setProjectRemote(store(), null);
		}
	}, 60_000);

	it("appends and searches direct-user JSONL in the same session", async () => {
		const { stderr } = await pi(
			"/muninn note Deploys need the VPN; staging is unreachable without it.",
			"/muninn search deploys VPN",
		);
		expect(stderr).toContain("appended note j-");
		expect(stderr).toContain("1 journal record:");
		expect(stderr).toContain("note/user · local-user");
		const notes = scanJournal(store())
			.records.map((item) => item.record)
			.filter((record) => record.source === "user");
		expect(notes.some((record) => record.body.includes("staging"))).toBe(true);
	}, 90_000);

	it("corrects a stale record and shows both immutable records", async () => {
		await pi("/muninn note The service uses PostgreSQL 16.");
		const target = scanJournal(store())
			.records.map((item) => item.record)
			.find((record) => record.body.includes("PostgreSQL 16"));
		const corrected = await pi(`/muninn correct ${target?.id} It now uses PostgreSQL 17.`);
		expect(corrected.stderr).toContain("appended correction");
		const shown = await pi(`/muninn show ${target?.id} --relations`);
		expect(shown.stderr).toContain("PostgreSQL 16");
		expect(shown.stderr).toContain("PostgreSQL 17");
		expect(shown.stderr).toContain(`corrects ${target?.id}`);
	}, 90_000);

	it("lists session-backed records, tails, and rebuilds the index", async () => {
		const sessions = await pi("/muninn sessions --limit 5");
		expect(sessions.stderr).toContain(".jsonl");
		const tail = await pi("/muninn tail --limit 1");
		expect(tail.stderr).toContain("journal record:");
		const rebuilt = await pi("/muninn reindex");
		expect(rebuilt.stderr).toMatch(/index rebuilt — \d+ records?/);
	}, 90_000);
});
