/**
 * Capture, driven through a real pi process.
 *
 * The unit tests decide what *should* be captured; this decides whether pi
 * actually delivers the events Muninn hangs off, in the order it expects, and
 * whether state survives a resume. A scripted HTTP provider stands in for the
 * model, so the whole loop runs without credentials.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

/**
 * Run one pi turn to completion.
 *
 * `spawn` rather than `execFile` because stdin must be closed: pi waits on it
 * otherwise, and the run never returns.
 */
async function pi(prompt: string, extra: string[] = []): Promise<string> {
	const args = ["-p", prompt, "--model", "muninn-test/mock", "-e", PROVIDER_EXTENSION, "-e", MUNINN, ...extra];
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
		}, 60_000);
		child.on("error", reject);
		child.on("close", (exitCode) => {
			clearTimeout(timer);
			resolve(exitCode);
		});
	});

	if (code !== 0) throw new Error(`pi exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`);
	return stdout;
}

function projectStore(): string {
	const projects = join(agentDir, "muninn-projects");
	const entries = existsSync(projects) ? readdirSync(projects) : [];
	expect(entries).toHaveLength(1);
	return join(projects, entries[0] as string);
}

function sessionFiles(): string[] {
	const root = join(agentDir, "sessions");
	if (!existsSync(root)) return [];
	return readdirSync(root).flatMap((dir) =>
		readdirSync(join(root, dir))
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => join(root, dir, name)),
	);
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "muninn-e2e-"));
	agentDir = join(home, "agent");
	project = join(home, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });

	await git(project, ["init", "--quiet"]);
	await git(project, ["config", "user.email", "dev@example.com"]);
	await git(project, ["config", "user.name", "Dev"]);
	await execFileAsync("touch", ["README.md"], { cwd: project });
	await git(project, ["add", "README.md"]);
	await git(project, ["commit", "--quiet", "-m", "initial"]);

	mock = await startMockProvider(["I'll run npm install to add the dependency."]);
}, 60_000);

afterAll(async () => {
	await mock?.close();
	rmSync(home, { recursive: true, force: true });
});

describe("capture through a real pi session", () => {
	it("journals an explicit request, into the capture target", async () => {
		const output = await pi("Always use pnpm in this repo, never npm.");
		expect(output).toContain("npm install"); // the scripted model replied

		const store = projectStore();
		const journal = readStoreJournal(store);
		expect(journal.problems).toEqual([]);
		expect(journal.entries).toHaveLength(1);

		const entry = journal.entries[0];
		expect(entry?.source).toBe("user");
		expect(entry?.claims).toEqual(["Always use pnpm in this repo, never npm."]);
		expect(entry?.task).toBeDefined();
		expect(entry?.session).toContain(".jsonl#");

		// Global scope is active but is not the capture target.
		expect(readStoreJournal(join(agentDir, "muninn")).entries).toEqual([]);
	}, 60_000);

	it("does not journal an ordinary turn", async () => {
		const before = readStoreJournal(projectStore()).entries.length;
		await pi("Can you check the type errors please?");
		expect(readStoreJournal(projectStore()).entries).toHaveLength(before);
	}, 60_000);

	it("persists its state into pi's own session file", async () => {
		// State lives in the session rather than a sidecar file, so it cannot
		// drift out of step with the session it describes.
		const deltas = sessionFiles()
			.flatMap((file) => readFileSync(file, "utf-8").split("\n"))
			.filter((line) => line.includes("muninn-state"));
		expect(deltas.length).toBeGreaterThan(0);
		expect(deltas.some((line) => line.includes('"kind":"start"'))).toBe(true);
		expect(deltas.some((line) => line.includes('"kind":"written"'))).toBe(true);
	}, 60_000);

	it("keeps a resumed session in the same task group", async () => {
		// The plan's second acceptance criterion, end to end. Whether pi carries
		// the same session id forward or starts a new one and points back at the
		// old, the two halves must end up in one task group — that group is what
		// the evaluate phase holds out together.
		const store = projectStore();

		await pi("Note that the flaky test is checkout.spec.ts.");
		const before = readStoreJournal(store).entries;
		const priorTask = before[before.length - 1]?.task;
		expect(priorTask).toBeDefined();

		await pi("From now on, deploy only from the release branch.", ["--continue"]);

		const after = readStoreJournal(store).entries;
		expect(after.length).toBe(before.length + 1);
		const resumed = after[after.length - 1];
		expect(resumed?.claims[0]).toContain("release branch");
		expect(resumed?.continues ?? resumed?.task).toBe(priorTask);
	}, 60_000);
});
