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
import { scanJournal } from "../../src/journal/jsonl.ts";
import { JournalQueryService } from "../../src/journal/query.ts";
import { journalIndexPath } from "../../src/journal/query-index.ts";
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
	const registry = readProjectRegistry(agentDir);
	expect(registry?.projects).toHaveLength(1);
	return projectStorePath(agentDir, registry?.projects[0]?.id as string);
}

function records() {
	return scanJournal(projectStore()).records.map((item) => item.record);
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
		const journal = scanJournal(store);
		expect(journal.problems).toEqual([]);
		expect(journal.records).toHaveLength(1);

		const entry = journal.records[0]?.record;
		expect(entry?.source).toBe("user");
		expect(entry?.body).toContain("Always use pnpm in this repo, never npm.");
		expect(entry?.task).toBeDefined();
		expect(entry?.session?.file).toContain(".jsonl");
	}, 60_000);

	it("does not journal an ordinary turn", async () => {
		const before = records().length;
		await pi("Can you check the type errors please?");
		expect(records()).toHaveLength(before);
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
		await pi("Note that the flaky test is checkout.spec.ts.");
		const before = records();
		const priorTask = before[before.length - 1]?.task;
		expect(priorTask).toBeDefined();

		await pi("From now on, deploy only from the release branch.", ["--continue"]);

		const after = records();
		expect(after.length).toBe(before.length + 1);
		const resumed = after[after.length - 1];
		expect(resumed?.body).toContain("release branch");
		expect(resumed?.continues ?? resumed?.task).toBe(priorTask);
	}, 60_000);
});

describe("journal commits", () => {
	it("leaves the store committed and clean after a session", async () => {
		// The plan's first acceptance criterion. The shutdown commit is
		// un-debounced, so a session's entries are durable in git by the time the
		// process exits.
		await pi("Remember that deploys need the VPN.");

		const store = projectStore();
		const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd: store });
		expect(status.trim()).toBe("");

		const { stdout: subject } = await execFileAsync("git", ["log", "-1", "--format=%s"], { cwd: store });
		expect(subject.trim()).toMatch(/^journal: .+ \d+ entr(y|ies)$/);
	}, 60_000);

	it("commits only journal paths", async () => {
		await pi("Remember that rollbacks are one command.");

		const store = projectStore();
		const { stdout } = await execFileAsync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: store });
		const touched = stdout.trim().split("\n").filter(Boolean);
		expect(touched.length).toBeGreaterThan(0);
		for (const path of touched) expect(path.startsWith("journal/")).toBe(true);
	}, 60_000);

	it("leaves the project's own repository untouched", async () => {
		// The plan's second acceptance criterion. A separate project store must
		// not show up as changes in the repository the developer is working in.
		const { stdout: before } = await execFileAsync("git", ["status", "--porcelain"], { cwd: project });
		const { stdout: beforeLog } = await execFileAsync("git", ["log", "--format=%H"], { cwd: project });

		await pi("Remember that the staging database resets nightly.");

		const { stdout: after } = await execFileAsync("git", ["status", "--porcelain"], { cwd: project });
		const { stdout: afterLog } = await execFileAsync("git", ["log", "--format=%H"], { cwd: project });
		expect(after).toBe(before);
		expect(afterLog).toBe(beforeLog);
	}, 60_000);

	it("makes one commit per session, not one per entry", async () => {
		const store = projectStore();
		const { stdout: before } = await execFileAsync("git", ["rev-list", "--count", "HEAD"], { cwd: store });

		await pi("Remember this:\n- deploys need the VPN\n- rollbacks are one command");

		const { stdout: after } = await execFileAsync("git", ["rev-list", "--count", "HEAD"], { cwd: store });
		expect(Number.parseInt(after.trim(), 10)).toBe(Number.parseInt(before.trim(), 10) + 1);
	}, 60_000);
});

describe("the canonical index, through a real pi session", () => {
	it("is rebuildable and finds what the session journaled", async () => {
		await pi("Remember that vitest watch mode hangs the CI job.");

		const store = projectStore();
		const member = readProjectRegistry(agentDir)?.member.id as string;
		const service = new JournalQueryService({ storePath: store, localMember: member, mode: "index" });
		expect(existsSync(journalIndexPath(store))).toBe(true);
		expect(service.query({ query: "vitest watch" }).records[0]?.snippet).toContain("watch mode hangs");
	}, 60_000);

	it("is never committed — it is derived and disposable", async () => {
		const store = projectStore();
		const { stdout } = await execFileAsync("git", ["ls-files", "--", ".index"], { cwd: store });
		expect(stdout.trim()).toBe("");
	}, 60_000);
});
