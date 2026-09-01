/**
 * The three tools, called by a real model loop.
 *
 * The unit tests drive `execute` directly; this checks the part they cannot —
 * that pi accepts the registrations, hands the model the schemas, runs the
 * calls, and that a note written by `memory_note` is findable by
 * `memory_search` in the same run.
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
import { type MockProvider, type MockRequest, startMockProvider } from "../fixtures/mock-provider.ts";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PI = join(ROOT, "node_modules", ".bin", "pi");
const MUNINN = join(ROOT, "src", "index.ts");
const PROVIDER_EXTENSION = join(ROOT, "test", "fixtures", "mock-provider-extension.ts");

let home: string;
let agentDir: string;
let project: string;
let mock: MockProvider;
let store: string;

async function git(cwd: string, args: string[]): Promise<void> {
	await execFileAsync("git", args, { cwd });
}

async function pi(prompt: string): Promise<string> {
	const args = ["-p", prompt, "--model", "muninn-test/mock", "-e", PROVIDER_EXTENSION, "-e", MUNINN];
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
	return stdout;
}

function projectStore(): string {
	const registry = readProjectRegistry(agentDir);
	return projectStorePath(agentDir, registry?.projects[0]?.id as string);
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "muninn-tools-e2e-"));
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

	// note → search → answer, in one run.
	let step = 0;
	mock = await startMockProvider((request) => {
		if (request.isOutcomeCall) return "phase: test\n\nNothing durable.";
		step++;
		if (step === 1) {
			return {
				toolCall: {
					name: "memory_note",
					arguments: {
						text: "Deploys need the VPN; the staging host is unreachable without it.",
						cue: "when a deploy cannot reach staging",
						phase: "ops",
					},
				},
			};
		}
		if (step === 2) return { toolCall: { name: "memory_search", arguments: { query: "deploy VPN staging" } } };
		return "Noted and confirmed.";
	});

	await pi("Remember how deploys reach staging, then check that it stuck.");
	store = projectStore();
}, 120_000);

afterAll(async () => {
	await mock?.close();
	rmSync(home, { recursive: true, force: true });
});

describe("memory_note through pi", () => {
	it("writes one entry attributed to the agent", () => {
		const journal = readStoreJournal(store);
		expect(journal.problems).toEqual([]);
		const notes = journal.entries.filter((entry) => entry.source === "agent");
		expect(notes).toHaveLength(1);
		expect(notes[0]?.claims).toEqual(["Deploys need the VPN; the staging host is unreachable without it."]);
		expect(notes[0]?.cue).toBe("when a deploy cannot reach staging");
		expect(notes[0]?.phase).toBe("ops");
		// Print mode is a headless run, which is what `sdk` means.
		expect(notes[0]?.channel).toBe("sdk");
		expect(notes[0]?.session).toContain(".jsonl#");
	});
});

describe("memory_search through pi", () => {
	it("finds, in the same run, what memory_note just wrote", () => {
		const note = readStoreJournal(store).entries.find((entry) => entry.source === "agent");
		const claimId = `${note?.id}.1`;

		// The tool result goes back to the model in the next request.
		const afterSearch = mock.requests.filter((request: MockRequest) => request.raw.includes(claimId));
		expect(afterSearch.length).toBeGreaterThan(0);
		expect(afterSearch.some((request) => request.raw.includes("scope: project"))).toBe(true);
	});
});
