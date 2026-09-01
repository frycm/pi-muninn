import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_DIR_ENV, CONFIG_DIR, resolveAgentDir } from "../../src/agent-dir.ts";
import { runCli } from "../../src/cli.ts";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

let root: string;
let agentDir: string;
let cwd: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "muninn-cli-"));
	agentDir = join(root, "agent");
	cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	previousAgentDir = process.env[AGENT_DIR_ENV];
	process.env[AGENT_DIR_ENV] = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env[AGENT_DIR_ENV];
	else process.env[AGENT_DIR_ENV] = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

async function note(text: string): Promise<string> {
	const result = await runCli(["note", text, "--json"], cwd);
	expect(result.code).toBe(0);
	return (JSON.parse(result.out[0] as string) as { id: string }).id;
}

describe("resolveAgentDir", () => {
	it("honours pi's variable, expands tilde, and has the same fallback", () => {
		expect(AGENT_DIR_ENV).toBe("PI_CODING_AGENT_DIR");
		expect(resolveAgentDir({ [AGENT_DIR_ENV]: "/tmp/elsewhere" }, "/home/u")).toBe("/tmp/elsewhere");
		expect(resolveAgentDir({ [AGENT_DIR_ENV]: "~/memories" }, "/home/u")).toBe("/home/u/memories");
		expect(resolveAgentDir({}, "/home/u")).toBe(join("/home/u", CONFIG_DIR, "agent"));
	});
});

describe("muninn project-journal CLI", () => {
	it("prints the new surface and rejects unknown commands", async () => {
		const help = await runCli(["help"], cwd);
		expect(help.code).toBe(0);
		expect(help.out.join("\n")).toContain("muninn search QUERY");
		expect(help.out.join("\n")).toContain("muninn correct ID TEXT");
		const unknown = await runCli(["frobnicate"], cwd);
		expect(unknown.code).toBe(2);
		expect(unknown.err.join("\n")).toContain('unknown command "frobnicate"');
	});

	it("links, shows, and unlinks a logical project", async () => {
		expect((await runCli(["project", "link", "--name", "operations"], cwd)).code).toBe(0);
		expect((await runCli(["project", "show"], cwd)).out.join("\n")).toContain("operations");
		expect((await runCli(["project", "unlink"], cwd)).code).toBe(0);
		expect((await runCli(["project", "show"], cwd)).code).toBe(1);
	});

	it("writes, finds, and shows the same stable record ID", async () => {
		const id = await note("Deploys need the VPN to reach staging.");
		const searched = await runCli(["search", "deploy", "VPN", "--json"], cwd);
		expect(searched.code).toBe(0);
		const json = JSON.parse(searched.out[0] as string) as { schema: number; records: Array<{ id: string }> };
		expect(json.schema).toBe(1);
		expect(json.records.map((record) => record.id)).toEqual([id]);
		const shown = await runCli(["show", id, "--json"], cwd);
		expect(JSON.parse(shown.out[0] as string).records[0].body).toContain("staging");
	});

	it("emits one independently parseable object per JSONL record", async () => {
		const first = await note("First deployment fact.");
		const second = await note("Second deployment fact.");
		const result = await runCli(["search", "deployment", "--jsonl"], cwd);
		const records = result.out.map((line) => JSON.parse(line) as { schema: number; kind: string; id: string });
		expect(new Set(records.map((record) => record.id))).toEqual(new Set([first, second]));
		expect(records.every((record) => record.schema === 1 && record.kind === "record")).toBe(true);
	});

	it("uses distinct no-match and invalid-input exit codes with clean stdout", async () => {
		await note("Known journal evidence.");
		const missing = await runCli(["search", "definitely-absent"], cwd);
		expect(missing.code).toBe(1);
		expect(missing.err).toEqual([]);
		const invalid = await runCli(["search", "known", "--limit", "zero"], cwd);
		expect(invalid.code).toBe(2);
		expect(invalid.out).toEqual([]);
		expect(invalid.err.join("\n")).toContain("--limit");
	});

	it("appends a correction without modifying its target and reads the relation chain", async () => {
		const target = await note("The service uses PostgreSQL 16.");
		const correction = await runCli(["correct", target, "It now uses PostgreSQL 17.", "--json"], cwd);
		expect(correction.code).toBe(0);
		const correctionId = JSON.parse(correction.out[0] as string).id as string;
		const shown = await runCli(["show", target, "--relations", "--json"], cwd);
		const records = JSON.parse(shown.out[0] as string).records as Array<{
			id: string;
			body: string;
			relations: Array<{ type: string; target: string }>;
		}>;
		expect(records.find((record) => record.id === target)?.body).toContain("16");
		expect(records.find((record) => record.id === correctionId)?.relations).toEqual([{ type: "corrects", target }]);
	});

	it("lists sessions and tails records in stable machine formats", async () => {
		await note("One operational fact.");
		await note("Another operational fact.");
		const sessionResult = await runCli(["sessions", "--json"], cwd);
		expect(JSON.parse(sessionResult.out[0] as string)).toMatchObject({ schema: 1 });
		const tailResult = await runCli(["tail", "--limit", "1", "--jsonl"], cwd);
		expect(tailResult.out).toHaveLength(1);
		expect(JSON.parse(tailResult.out[0] as string).kind).toBe("record");
	});

	it("prints the store path for rg/jq and rebuilds a disposable index", async () => {
		await note("Searchable evidence.");
		const path = await runCli(["path"], cwd);
		expect(path.code).toBe(0);
		expect(path.out[0]).toMatch(/muninn-projects[/\\][0-9a-f-]+$/);
		const rebuilt = await runCli(["reindex", "--json"], cwd);
		expect(JSON.parse(rebuilt.out[0] as string)).toMatchObject({ schema: 1, kind: "reindex", records: 1 });
	});

	it("supports restartable migration dry runs", async () => {
		const result = await runCli(["migrate", "--dry-run", "--json"], cwd);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.out[0] as string)).toMatchObject({
			schema: 1,
			kind: "migration",
			dryRun: true,
			imported: 0,
		});
	});

	it("cancels follow promptly", async () => {
		await note("Initial event.");
		const controller = new AbortController();
		const running = runCli(["tail", "--follow", "--jsonl"], cwd, {
			signal: controller.signal,
			pollMs: 5,
		});
		setTimeout(() => controller.abort(), 15);
		const result = await running;
		expect(result.code).toBe(0);
		expect(result.out.length).toBeGreaterThan(0);
	});
});

describe("muninn CLI program", () => {
	it("runs from TypeScript source and writes ordinary output once", async () => {
		const { stdout } = await execFileAsync(process.execPath, [CLI, "--version"], {
			env: { ...process.env, [AGENT_DIR_ENV]: agentDir },
		});
		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
