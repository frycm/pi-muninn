/**
 * Dreaming, through a real pi process.
 *
 * The unit tests drive `dream()` directly; this one drives `/muninn dream` the
 * way a person does, so the wiring in the extension entry — the model adapter,
 * the append queue, the status line — is exercised rather than assumed.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

async function pi(...prompts: string[]): Promise<{ stdout: string; stderr: string }> {
	const args = ["-p", ...prompts, "--model", "muninn-test/mock", "-e", PROVIDER_EXTENSION, "-e", MUNINN];
	const child = spawn(PI, args, {
		cwd: project,
		// pi blocks on stdin; a child that inherits it never returns.
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, MUNINN_TEST_PROVIDER_URL: mock.url },
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	return await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`pi timed out\n${stdout}\n${stderr}`));
		}, 90_000);
		child.on("exit", () => {
			clearTimeout(timer);
			resolve({ stdout, stderr });
		});
	});
}

function projectStore(): string {
	const projects = join(agentDir, "muninn-projects");
	return join(projects, readdirSync(projects)[0] as string);
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "muninn-dream-int-"));
	agentDir = join(home, "agent");
	project = join(home, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
	await execFileAsync("git", ["init"], { cwd: project });
	await execFileAsync("git", ["config", "user.email", "a@b"], { cwd: project });
	await execFileAsync("git", ["config", "user.name", "a"], { cwd: project });
	await execFileAsync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: project });

	// The dreamer is the session's model here, so the same script answers both
	// the outcome call and the consolidate job — told apart by their markers.
	mock = await startMockProvider((request) => {
		if (request.isConsolidateCall) {
			const ids = [...request.raw.matchAll(/\[(j-[0-9a-f-]+\.\d+)\]/g)].map((match) => match[1]);
			return `\`\`\`json\n${JSON.stringify(
				ids.length > 0 ? [{ claim: "Tests are run with --run in this project.", evidence: ids }] : [],
			)}\n\`\`\``;
		}
		if (request.isOutcomeCall) {
			return ["phase: test", "cue: running the tests", "", "A run happened.", "", "- Something was learned."].join(
				"\n",
			);
		}
		return "Done.";
	});
});

afterAll(async () => {
	await mock.close();
	rmSync(home, { recursive: true, force: true });
});

describe("/muninn dream through pi", () => {
	it("dreams, lists, remembers and forgets", async () => {
		await pi("/muninn note Run tests with pnpm test --run, never watch mode.");

		const dreamt = await pi("/muninn dream");
		expect(dreamt.stderr).toContain("dream/");
		expect(dreamt.stderr).toMatch(/review with \/muninn dreams/);

		const store = projectStore();
		// The full host-qualified stamp, from the branch line:
		// `dream/<host>-<host UUID>/<time>-<dream UUID>`.
		const fullStamp = (
			dreamt.stderr.match(
				/dream\/([a-z0-9-]+-[0-9a-f-]{36}\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f-]{36})/,
			) as RegExpMatchArray
		)[1] as string;
		const stamp = fullStamp.slice(fullStamp.indexOf("/") + 1);

		const listed = await pi("/muninn dreams");
		expect(listed.stderr).toContain(stamp);
		expect(listed.stderr).toContain("pending");

		// Nothing has been applied yet: that is the whole point of a branch.
		expect(existsSync(join(store, "topics"))).toBe(false);

		const remembered = await pi(`/muninn dreams remember ${stamp}`);
		expect(remembered.stderr).toContain("remembered");
		expect(remembered.stderr).toContain("next one reads the new MEMORY.md");
		expect(readdirSync(join(store, "topics")).length).toBeGreaterThan(0);
		expect(readFileSync(join(store, "MEMORY.md"), "utf-8")).toContain("topics/");

		const browsed = await pi("/muninn topics");
		expect(browsed.stderr).toContain("fact(s)");

		const forgotten = await pi(`/muninn dreams forget ${stamp}`);
		expect(forgotten.stderr).toContain("forgot");
		expect(existsSync(join(store, "topics"))).toBe(false);
		// The report of a forgotten dream is the record of why.
		expect(readFileSync(join(store, "dreams", `${fullStamp}.md`), "utf-8")).toContain("forgotten:");
	}, 120_000);

	it("says rules are written by hand", async () => {
		const output = await pi("/muninn rules");
		expect(output.stderr).toContain("written by hand");
	}, 60_000);

	it("asks twice before erasing", async () => {
		const output = await pi("/muninn erase j-0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01 --yes");
		expect(output.stderr).toContain("cannot be undone");
	}, 60_000);
});
