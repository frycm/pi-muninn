import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_DIR_ENV, CONFIG_DIR, resolveAgentDir } from "../../src/agent-dir.ts";
import { runCli } from "../../src/cli.ts";
import { appendAuthorizedJournalRecord } from "../../src/journal/writer.ts";
import { readProjectRegistry } from "../../src/project/registry.ts";
import { loadHostIdentity } from "../../src/store/host.ts";

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
		expect(help.out.join("\n")).toContain("muninn team list");
		expect(help.out.join("\n")).toContain("muninn evaluate JUDGMENTS.jsonl");
		const unknown = await runCli(["frobnicate"], cwd);
		expect(unknown.code).toBe(2);
		expect(unknown.err.join("\n")).toContain('unknown command "frobnicate"');
	});

	it("evaluates explicit relevance judgments through scan mode", async () => {
		const id = await note("Canary deployments use a progressive rollout.");
		const judgments = join(root, "judgments.jsonl");
		writeFileSync(judgments, `${JSON.stringify({ id: "canary", query: "progressive rollout", relevant: [id] })}\n`);
		const result = await runCli(["evaluate", judgments, "--json"], cwd);
		expect(result).toMatchObject({ code: 0, err: [] });
		expect(JSON.parse(result.out[0] as string)).toMatchObject({
			schema: 1,
			kind: "journal-evaluation",
			evaluated: 1,
			metrics: { recall_at_10: 1, mrr_at_10: 1, ndcg_at_10: 1 },
		});
		const invalid = join(root, "invalid-judgments.jsonl");
		writeFileSync(invalid, "{bad\n");
		expect(await runCli(["evaluate", invalid], cwd)).toMatchObject({ code: 2, out: [] });
	});

	it("emits a clean machine-readable doctor report without initializing a fresh agent", async () => {
		const fresh = await runCli(["doctor", "--json"], cwd);
		expect(fresh).toMatchObject({ code: 1, err: [] });
		expect(JSON.parse(fresh.out[0] as string)).toMatchObject({ schema: 1, kind: "doctor" });
		expect(existsSync(join(agentDir, "muninn", "host.json"))).toBe(false);
		await note("Create a healthy journal.");
		await runCli(["reindex"], cwd);
		const healthy = await runCli(["doctor", "--json"], cwd);
		expect(healthy.code).toBe(0);
		expect(JSON.parse(healthy.out[0] as string).summary.errors).toBe(0);
	});

	it("links, shows, and unlinks a logical project", async () => {
		expect((await runCli(["project", "link", "--name", "operations"], cwd)).code).toBe(0);
		expect((await runCli(["project", "show"], cwd)).out.join("\n")).toContain("operations");
		expect((await runCli(["project", "unlink"], cwd)).code).toBe(0);
		expect((await runCli(["project", "show"], cwd)).code).toBe(1);
	});

	it("sets, shows, and removes the explicit project journal remote", async () => {
		await runCli(["project", "link", "--name", "operations"], cwd);
		const remote = "ssh://git.example/team/operations-journal.git";
		expect((await runCli(["project", "remote", remote], cwd)).out).toEqual([`project journal remote: ${remote}`]);
		expect(await runCli(["project", "remote"], cwd)).toMatchObject({ code: 0, out: [remote] });
		expect((await runCli(["status", "--json"], cwd)).out[0]).toContain(remote);
		expect((await runCli(["project", "remote", "--remove"], cwd)).out).toEqual(["project journal remote removed"]);
		expect((await runCli(["project", "remote"], cwd)).code).toBe(1);
	});

	it("never echoes credential-bearing remotes and shell-quotes share commands", async () => {
		await note("Create a journal for sharing.");
		const credential = "https://example.test/journal.git?access_token=very-secret-value";
		const rejected = await runCli(["project", "remote", credential], cwd);
		expect(rejected.code).toBe(1);
		expect(rejected.err.join("\n")).not.toContain("very-secret-value");
		const spaced = join(root, "journal remote.git");
		expect((await runCli(["project", "remote", spaced], cwd)).code).toBe(0);
		const shared = await runCli(["project", "share"], cwd);
		expect(shared.out.join("\n")).toContain(`join: muninn project join '${spaced}'`);
	});

	it("declares and lists local member and host lifecycle state", async () => {
		await note("Create a team journal.");
		const host = loadHostIdentity(agentDir);
		const renamed = await runCli(["team", "rename-member", "Marty", "--reason", "preferred name", "--json"], cwd);
		expect(renamed.code).toBe(0);
		expect(JSON.parse(renamed.out[0] as string)).toMatchObject({
			schema: 1,
			kind: "team-event",
			event: { kind: "member-renamed", name: "Marty", reason: "preferred name" },
		});
		expect((await runCli(["team", "rename-host", host.id, "workstation"], cwd)).code).toBe(0);
		expect((await runCli(["team", "retire-host", host.id], cwd)).code).toBe(0);
		let roster = JSON.parse((await runCli(["team", "list", "--json"], cwd)).out[0] as string) as {
			members: Array<{ name: string; state: string }>;
			hosts: Array<{ name: string; state: string }>;
		};
		expect(roster.members[0]).toMatchObject({ name: "Marty", state: "active" });
		expect(roster.hosts[0]).toMatchObject({ name: "workstation", state: "retired" });
		expect((await runCli(["team", "restore-host", host.id], cwd)).code).toBe(0);
		expect((await runCli(["team", "leave"], cwd)).code).toBe(0);
		roster = JSON.parse((await runCli(["team", "list", "--json"], cwd)).out[0] as string);
		expect(roster.members[0]?.state).toBe("retired");
		expect(roster.hosts[0]?.state).toBe("retired");
		expect((await runCli(["team", "return"], cwd)).code).toBe(0);
		const text = await runCli(["team", "list"], cwd);
		expect(text.out.join("\n")).toContain("● Marty");
		expect(text.out.join("\n")).toContain("● workstation");
	});

	it("shares and joins a project journal on a fresh agent with one command", async () => {
		await note("Shared onboarding evidence.");
		const remote = join(root, "shared.git");
		await execFileAsync("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote], { cwd: root });
		expect((await runCli(["project", "remote", remote], cwd)).code).toBe(0);
		expect((await runCli(["sync"], cwd)).code).toBe(0);
		const shared = await runCli(["project", "share", "--json"], cwd);
		const descriptor = JSON.parse(shared.out[0] as string) as { project: string; remote: string };
		expect(descriptor.remote).toBe(remote);

		const targetAgent = join(root, "target-agent");
		const targetCode = join(root, "target-code");
		mkdirSync(targetAgent);
		mkdirSync(targetCode);
		process.env[AGENT_DIR_ENV] = targetAgent;
		try {
			const joined = await runCli(["project", "join", remote, "--json"], targetCode);
			expect(joined.code).toBe(0);
			const result = JSON.parse(joined.out[0] as string) as {
				project: string;
				member: string;
				host: string;
				store_created: boolean;
			};
			expect(result).toMatchObject({ project: descriptor.project, store_created: true });
			expect(result.member).not.toBe(result.host);
			expect((await runCli(["search", "onboarding"], targetCode)).code).toBe(0);
		} finally {
			process.env[AGENT_DIR_ENV] = agentDir;
		}
	});

	it("writes, finds, and shows the same stable record ID", async () => {
		const id = await note("Deploys need the VPN to reach staging.");
		const searched = await runCli(["search", "deploy", "VPN", "--trust", "local-user", "--explain", "--json"], cwd);
		expect(searched.code).toBe(0);
		const json = JSON.parse(searched.out[0] as string) as {
			schema: number;
			records: Array<{ id: string; explanation?: { total: number }; score: number }>;
		};
		expect(json.schema).toBe(1);
		expect(json.records.map((record) => record.id)).toEqual([id]);
		expect(json.records[0]?.explanation?.total).toBe(json.records[0]?.score);
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

	it("returns the record with a distinct code when its transcript is unavailable locally", async () => {
		await note("Create the project journal.");
		const registry = readProjectRegistry(agentDir);
		const project = registry?.projects[0];
		const host = loadHostIdentity(agentDir);
		const written = await appendAuthorizedJournalRecord(
			{
				authority: "headless-user",
				record: {
					type: "note",
					source: "user",
					channel: "cli",
					body: "Evidence lives on another clone.",
					session: { file: join(root, "missing-session.jsonl"), last: "e-9" },
				},
			},
			{
				storePath: join(agentDir, "muninn-projects", project?.id as string),
				project: project?.id as string,
				member: registry?.member.id as string,
				host: host.id,
			},
		);
		const shown = await runCli(["show", written.id, "--json"], cwd);
		expect(shown.code).toBe(3);
		expect(JSON.parse(shown.out[0] as string).transcripts[0]).toMatchObject({ available: false });
	});

	it("appends a correction without modifying its target and reads the relation chain", async () => {
		const target = await note("The service uses PostgreSQL 16.");
		const correction = await runCli(["correct", target, "It now uses PostgreSQL 17.", "--json"], cwd);
		expect(correction.code).toBe(0);
		const correctionId = JSON.parse(correction.out[0] as string).id as string;
		const filtered = JSON.parse(
			(await runCli(["search", "--label", "correction", "--json"], cwd)).out[0] as string,
		) as {
			records: Array<{ id: string }>;
		};
		expect(filtered.records.map((record) => record.id)).toEqual([correctionId]);
		const shown = await runCli(["show", target, "--relations", "--json"], cwd);
		const records = JSON.parse(shown.out[0] as string).records as Array<{
			id: string;
			body: string;
			relations: Array<{ type: string; target: string }>;
		}>;
		expect(records.find((record) => record.id === target)?.body).toContain("16");
		expect(records.find((record) => record.id === correctionId)?.relations).toEqual([{ type: "corrects", target }]);
	});

	it("lists, explicitly resolves, and reopens correction conflicts", async () => {
		const target = await note("The deployment window is Tuesday.");
		const first = await runCli(["correct", target, "Use Wednesday.", "--json"], cwd);
		const second = await runCli(["correct", target, "Use Thursday.", "--json"], cwd);
		const branchIds = [first, second].map((result) => JSON.parse(result.out[0] as string).id as string).sort();
		const before = await runCli(["conflicts", "--json"], cwd);
		const conflict = JSON.parse(before.out[0] as string).conflicts[0] as {
			target: string;
			branches: Array<{ id: string }>;
		};
		expect(conflict.target).toBe(target);
		expect(conflict.branches.map((branch) => branch.id).sort()).toEqual(branchIds);
		const resolved = await runCli(["resolve", target, "Use the approved Friday window.", "--json"], cwd);
		expect(resolved.code).toBe(0);
		const resolution = JSON.parse(resolved.out[0] as string) as {
			id: string;
			relations: Array<{ type: string; target: string }>;
		};
		expect(
			resolution.relations
				.filter((relation) => relation.type === "supersedes")
				.map((item) => item.target)
				.sort(),
		).toEqual(branchIds);
		expect(JSON.parse((await runCli(["conflicts", "--json"], cwd)).out[0] as string).conflicts).toEqual([]);
		expect(JSON.parse((await runCli(["show", target, "--json"], cwd)).out[0] as string).records[0].body).toContain(
			"Tuesday",
		);
		await runCli(["correct", target, "Emergency maintenance is Saturday."], cwd);
		const reopened = JSON.parse((await runCli(["conflicts", "--json"], cwd)).out[0] as string).conflicts[0] as {
			branches: Array<{ id: string }>;
		};
		expect(reopened.branches.map((branch) => branch.id)).toContain(resolution.id);
	});

	it("does not write when resolve targets a record without a conflict", async () => {
		const target = await note("One undisputed fact.");
		const result = await runCli(["resolve", target, "No change."], cwd);
		expect(result).toMatchObject({ code: 1, out: [] });
		expect(result.err.join("\n")).toContain("not conflicted; nothing written");
		expect(JSON.parse((await runCli(["conflicts", "--json"], cwd)).out[0] as string).conflicts).toEqual([]);
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
