/**
 * Outcome entries, driven through a real pi process.
 *
 * The unit tests decide what a well-formed outcome entry looks like; this
 * decides whether pi's events actually arrive in the shape Muninn assembles a
 * run from, and whether the model Muninn asks for an outcome sees the right
 * prompt — in particular, one with none of Muninn's own messages in it.
 */
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanJournal } from "../../src/journal/jsonl.ts";
import { readProjectRegistry } from "../../src/project/registry.ts";
import { projectStorePath } from "../../src/store/paths.ts";
import { type MockProvider, type MockScript, startMockProvider } from "../fixtures/mock-provider.ts";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PI = join(ROOT, "node_modules", ".bin", "pi");
const MUNINN = join(ROOT, "src", "index.ts");
const PROVIDER_EXTENSION = join(ROOT, "test", "fixtures", "mock-provider-extension.ts");

const OUTCOME_REPLY = [
	"phase: test",
	"cue: when vitest hangs in CI",
	"",
	"The CI job hung until watch mode was disabled.",
	"",
	"- Run `pnpm test --run`; vitest watch mode hangs the CI job.",
	"- The CI runner has no TTY, which is why watch mode never exits.",
].join("\n");

let home: string;
let agentDir: string;
let project: string;
let mock: MockProvider;

async function pi(prompt: string, extra: string[] = []): Promise<{ stdout: string; stderr: string }> {
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

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`pi timed out\nstdout: ${stdout}\nstderr: ${stderr}`));
		}, 60_000);
		child.on("error", reject);
		child.on("close", () => {
			clearTimeout(timer);
			resolve();
		});
	});
	return { stdout, stderr };
}

function projectStore(): string {
	const registry = readProjectRegistry(agentDir);
	expect(registry?.projects).toHaveLength(1);
	return projectStorePath(agentDir, registry?.projects[0]?.id as string);
}

function records() {
	return scanJournal(projectStore()).records.map((item) => item.record);
}

async function setUp(
	script: string[] | MockScript,
	settings?: Record<string, unknown>,
	promptTokens?: number,
): Promise<void> {
	home = mkdtempSync(join(tmpdir(), "muninn-outcome-"));
	agentDir = join(home, "agent");
	project = join(home, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, "README.md"), "# demo\n\nvitest hangs in CI when watch mode starts.\n");

	await execFileAsync("git", ["init", "--quiet"], { cwd: project });
	await execFileAsync("git", ["config", "user.email", "dev@example.com"], { cwd: project });
	await execFileAsync("git", ["config", "user.name", "Dev"], { cwd: project });
	await execFileAsync("git", ["add", "README.md"], { cwd: project });
	await execFileAsync("git", ["commit", "--quiet", "-m", "initial"], { cwd: project });

	if (settings) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));

	mock = await startMockProvider(script, promptTokens === undefined ? {} : { promptTokens });
}

afterEach(async () => {
	await mock?.close();
	if (home) rmSync(home, { recursive: true, force: true });
});

describe("outcome entries through a real pi session", () => {
	beforeEach(async () => {
		// A task, not a chat: the model reads a file, then reports. Muninn's
		// outcome prompt is answered from the template.
		const script: MockScript = (request) => {
			if (request.isOutcomeCall) return OUTCOME_REPLY;
			const calledTool = request.messages.some((message) => message.role === "tool" || message.role === "toolResult");
			if (calledTool) return "The README says watch mode is the problem.";
			return { toolCall: { name: "read", arguments: { path: "README.md" } } };
		};
		await setUp(script);
	});

	it("writes exactly one outcome entry for a run with a tool call", async () => {
		await pi("Why does CI hang?");

		const entries = records();
		const outcomes = entries.filter((entry) => entry.source === "agent");
		expect(outcomes).toHaveLength(1);

		const outcome = outcomes[0];
		expect(outcome?.tags).toContain("test");
		expect(outcome?.cue).toBe("when vitest hangs in CI");
		expect(outcome?.body).toContain("pnpm test --run");
		expect(outcome?.task).toBeDefined();
		expect(outcome?.channel).toBe("sdk");
		expect(outcome?.session?.file).toContain(".jsonl");
	}, 60_000);

	it("asks for the outcome with a prompt free of Muninn's own messages", async () => {
		await pi("Why does CI hang?");

		const outcomeCalls = mock.requests.filter((request) => request.isOutcomeCall);
		expect(outcomeCalls).toHaveLength(1);

		const prompt = outcomeCalls[0]?.raw ?? "";
		// The run really was in there…
		expect(prompt).toContain("README.md");
		// …and nothing of Muninn's was.
		expect(prompt).not.toContain("muninn-state");
		expect(prompt).not.toContain('"customType":"muninn"');
		expect(prompt).not.toContain("These are memories, not ground truth");
	}, 60_000);

	it("keeps the outcome entry separate from what the user asked to remember", async () => {
		await pi("Always use pnpm here, never npm.");

		const entries = records();
		const explicit = entries.filter((entry) => entry.source === "user");
		const outcomes = entries.filter((entry) => entry.source === "agent");

		expect(explicit).toHaveLength(1);
		expect(explicit[0]?.body).toContain("Always use pnpm here, never npm.");
		expect(outcomes).toHaveLength(1);
		// Same task group: one session, one task, two kinds of evidence.
		expect(outcomes[0]?.task).toBe(explicit[0]?.task);
	}, 60_000);
});

describe("a chat is not a task", () => {
	beforeEach(async () => {
		await setUp((request) => (request.isOutcomeCall ? OUTCOME_REPLY : "It is 3pm."));
	});

	it("writes no outcome entry for a single turn with no tool calls", async () => {
		// Journaling these is how a memory store fills with chit-chat nobody
		// trusts, so the model is never even asked.
		await pi("What time is it?");

		expect(records()).toEqual([]);
		expect(mock.requests.filter((request) => request.isOutcomeCall)).toEqual([]);
	}, 60_000);
});

describe("an unusable reply is dropped, not journaled", () => {
	beforeEach(async () => {
		let outcomeCalls = 0;
		await setUp((request) => {
			if (request.isOutcomeCall) {
				outcomeCalls++;
				return "Sure! The task went great, I think.";
			}
			const calledTool = request.messages.some((message) => message.role === "tool" || message.role === "toolResult");
			return calledTool ? "Done." : { toolCall: { name: "read", arguments: { path: "README.md" } } };
		});
		expect(outcomeCalls).toBe(0);
	});

	it("retries once and then writes nothing", async () => {
		const { stderr } = await pi("Why does CI hang?");

		expect(records().filter((entry) => entry.source === "agent")).toEqual([]);
		// Retried exactly once before giving up.
		expect(mock.requests.filter((request) => request.isOutcomeCall)).toHaveLength(2);
		expect(stderr).toContain("no outcome entry");
	}, 60_000);
});

describe("compaction", () => {
	// The model's context window is 128k, so reserving nearly all of it leaves
	// almost none available and pi compacts after the first exchange. That is
	// the situation `session_before_compact` exists for: the outcome must be
	// written before the context is summarised away. 120k reported against a
	// 128k window with 127.5k reserved leaves pi no room.
	const COMPACT = { compaction: { enabled: true, reserveTokens: 127_500, keepRecentTokens: 1 } };

	function compacted(): boolean {
		return readdirSync(join(agentDir, "sessions"))
			.flatMap((dir) =>
				readdirSync(join(agentDir, "sessions", dir))
					.filter((name) => name.endsWith(".jsonl"))
					.map((name) => readFileSync(join(agentDir, "sessions", dir, name), "utf-8")),
			)
			.join("\n")
			.includes('"type":"compaction"');
	}

	it("does not journal the same work twice", async () => {
		// One tool call, then compaction, then a one-line answer. The
		// pre-compaction entry covers the tool call; the tail after compaction
		// is a single turn with no tools — a question, not a task — and is
		// rightly not an entry of its own.
		const script: MockScript = (request) => {
			if (request.raw.includes("<conversation>"))
				return "Read README.md and diagnosed the CI watch-mode hang. Use pnpm test --run.";
			if (request.isOutcomeCall) return OUTCOME_REPLY;
			const calledTool = request.messages.some((message) => message.role === "tool" || message.role === "toolResult");
			return calledTool
				? "The README says watch mode is the problem."
				: { toolCall: { name: "read", arguments: { path: "README.md" } } };
		};
		await setUp(script, COMPACT, 120_000);
		const result = await pi("Why does CI hang?");

		expect(
			compacted(),
			`pi never compacted, so this test proves nothing: ${result.stderr} ${result.stdout}; calls=${mock.requests.length}`,
		).toBe(true);
		const outcomes = records().filter((entry) => entry.source === "agent");
		expect(outcomes).toHaveLength(1);
	}, 90_000);

	// Not covered here: a run that *continues* after compaction (pi does that on
	// an overflow retry or with queued messages), whose continuation must be its
	// own entry. The scripted provider cannot provoke either; the mechanism —
	// `take()` at compaction unsealing the accumulator so later turns collect
	// again — is pinned in test/unit/outcome.test.ts.
});
