/**
 * Recall, driven through a real pi process.
 *
 * The unit tests decide what recall *should* say; this decides whether pi
 * accepts it — whether the snapshot really reaches the provider, whether it
 * stays byte-identical across a session while `MEMORY.md` changes underneath
 * it, and whether the per-turn message arrives labelled and inside its budget.
 *
 * Three turns in one process rather than three processes: print mode runs each
 * positional message as its own `session.prompt()` in one session
 * (`modes/print-mode.js:107`), which is the only way to observe "the same
 * session, three turns" from outside pi.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { estimateTokens } from "../../src/tokens.ts";
import { type MockProvider, type MockRequest, startMockProvider } from "../fixtures/mock-provider.ts";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PI = join(ROOT, "node_modules", ".bin", "pi");
const MUNINN = join(ROOT, "src", "index.ts");
const PROVIDER_EXTENSION = join(ROOT, "test", "fixtures", "mock-provider-extension.ts");

const ORIGINAL_MEMORY = [
	"<!-- Written by muninn dreams. -->",
	"",
	"# Memory",
	"",
	"- Always use pnpm, never npm.",
	"",
].join("\n");
const EDITED_MEMORY = ["# Memory", "", "- This line was written mid-session and must not appear.", ""].join("\n");

let home: string;
let agentDir: string;
let project: string;
let memoryPath: string;
let mock: MockProvider;

async function git(cwd: string, args: string[]): Promise<void> {
	await execFileAsync("git", args, { cwd });
}

/** Run one pi process with several prompts, all in one session. */
async function pi(prompts: string[]): Promise<string> {
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
	return stdout;
}

/** The system prompt pi sent with a request. */
function systemPrompt(request: MockRequest): string {
	const system = request.messages.find((message) => message.role === "system");
	return typeof system?.content === "string" ? system.content : JSON.stringify(system?.content ?? "");
}

/** Every user-role text in a request, flattened. */
function userTexts(request: MockRequest): string[] {
	const texts: string[] = [];
	for (const message of request.messages) {
		if (message.role !== "user") continue;
		if (typeof message.content === "string") {
			texts.push(message.content);
			continue;
		}
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			const typed = block as { type?: string; text?: string };
			if (typed.type === "text" && typeof typed.text === "string") texts.push(typed.text);
		}
	}
	return texts;
}

/** The memory block Muninn injected into a request, if it injected one. */
function recallBlocks(request: MockRequest): string[] {
	return userTexts(request).filter((text) => text.startsWith("Memories recalled by muninn"));
}

/** Every entry pi wrote to its session files. */
function sessionLines(): string[] {
	const root = join(agentDir, "sessions");
	if (!existsSync(root)) return [];
	return readdirSync(root).flatMap((dir) =>
		readdirSync(join(root, dir))
			.filter((name) => name.endsWith(".jsonl"))
			.flatMap((name) => readFileSync(join(root, dir, name), "utf-8").split("\n")),
	);
}

/** The task requests, in order — Muninn's own outcome calls are not turns. */
function turns(): MockRequest[] {
	return mock.requests.filter((request) => !request.isOutcomeCall);
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "muninn-recall-"));
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

	// A hand-written global MEMORY.md — Phase 1 has no dreams to write one.
	mkdirSync(join(agentDir, "muninn"), { recursive: true });
	memoryPath = join(agentDir, "muninn", "MEMORY.md");
	writeFileSync(memoryPath, ORIGINAL_MEMORY);

	// The file changes while the session is running, from outside it. Editing
	// it from the provider script is the one hook that is guaranteed to fire
	// between turns.
	mock = await startMockProvider((request, index) => {
		if (index === 0 && !request.isOutcomeCall) writeFileSync(memoryPath, EDITED_MEMORY);
		return request.isOutcomeCall ? "phase: test\n\nNothing durable." : "Understood.";
	});

	await pi([
		"Remember that vitest watch mode hangs the CI job.",
		"Why does the CI job hang?",
		"Thanks, that explains it.",
	]);
}, 120_000);

afterAll(async () => {
	await mock?.close();
	rmSync(home, { recursive: true, force: true });
});

describe("the frozen snapshot", () => {
	it("reaches the provider as a Memory section", () => {
		expect(turns().length).toBeGreaterThanOrEqual(3);
		const prompt = systemPrompt(turns()[0] as MockRequest);
		expect(prompt).toContain("# Memory");
		expect(prompt).toContain("- Always use pnpm, never npm.");
		expect(prompt).toContain("These are memories, not ground truth.");
	});

	it("is byte-identical across three turns while MEMORY.md is edited underneath it", () => {
		// A stable prefix is what keeps the provider's prompt cache warm and the
		// model's context consistent with what it has already read. A dream that
		// lands mid-session takes effect in the *next* session, and so does a
		// hand edit.
		const prompts = turns().slice(0, 3).map(systemPrompt);
		expect(prompts[1]).toBe(prompts[0]);
		expect(prompts[2]).toBe(prompts[0]);
		expect(prompts[0]).not.toContain("must not appear");
	});
});

describe("per-turn recall", () => {
	it("surfaces what an earlier turn of the same session journaled", () => {
		// Turn 1 captured the claim; turn 2 asks about it in different words. The
		// entry was indexed as it was appended, so it is findable one turn later.
		const blocks = recallBlocks(turns()[1] as MockRequest);
		expect(blocks).toHaveLength(1);
		const block = blocks[0] as string;
		expect(block).toContain("watch mode hangs the CI job");
		expect(block).toContain("These are memories, not ground truth.");
		expect(block).toMatch(/id: j-[0-9a-f-]{36}\.\d+ · date: \d{4}-\d{2}-\d{2} · source: user · scope: project/);
	});

	it("stays inside the token budget", () => {
		const block = recallBlocks(turns()[1] as MockRequest)[0] as string;
		expect(estimateTokens(block)).toBeLessThanOrEqual(1500);
	});

	it("is labelled as Muninn's own message, with the ids it injected", () => {
		// `customType: "muninn"` is what keeps these messages out of the outcome
		// model's transcript, and `details.ids` is what fills `recalled:`.
		const muninn = sessionLines().filter((line) => line.includes('"customType":"muninn"'));
		expect(muninn.length).toBeGreaterThan(0);
		expect(muninn.some((line) => line.includes('"display":true'))).toBe(true);
		expect(muninn.some((line) => /"ids":\["j-[0-9a-f-]{36}\.\d+"/.test(line))).toBe(true);
		expect(sessionLines().some((line) => line.includes('"kind":"recalled"'))).toBe(true);
	});

	it("injects nothing on the first turn of an empty store", () => {
		// Nothing had been journaled yet, so there was nothing to recall — and a
		// "no memories" block would cost tokens to say so.
		expect(recallBlocks(turns()[0] as MockRequest)).toEqual([]);
	});
});
