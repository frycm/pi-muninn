import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetCommitDebounce } from "../../src/capture/commit.ts";
import { runCli } from "../../src/cli.ts";
import { newHostId } from "../../src/ids.ts";
import { appendEntry } from "../../src/journal/append.ts";
import type { HostIdentity } from "../../src/store/host.ts";
import { ensureStore } from "../../src/store/init.ts";
import { hostFilePath } from "../../src/store/paths.ts";

let home: string;
let agentDir: string;
let storePath: string;
let cwd: string;
let host: HostIdentity;
const ENV = process.env.PI_CODING_AGENT_DIR;

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "muninn-cli-dream-"));
	agentDir = join(home, "agent");
	storePath = join(agentDir, "muninn");
	cwd = join(home, "cwd");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	host = { id: newHostId(), name: "mbp", createdAt: "2026-08-01" };
	await ensureStore(storePath, { host });
	// `host.json` lives inside the global store, which is where `loadHostIdentity`
	// looks; writing it beside the store instead mints a fresh identity from the
	// machine's own hostname and the test stops testing what it meant to.
	writeFileSync(hostFilePath(agentDir), JSON.stringify({ id: host.id, name: host.name, createdAt: host.createdAt }));
	resetCommitDebounce();
});

afterEach(() => {
	if (ENV === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = ENV;
	rmSync(home, { recursive: true, force: true });
});

function settings(muninn: Record<string, unknown>): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ muninn }));
}

describe("muninn dream", () => {
	it("dreams without a model, says so, and leaves a branch to review", async () => {
		// Not an error: the journal is still committed, the range recorded and a
		// report written. It just consolidates nothing.
		await appendEntry({ source: "user", prose: "A note.", claims: ["A note."] }, { storePath, hostId: host.id });
		const result = await runCli(["dream", "--scope", "global"], cwd);
		expect(result.code).toBe(0);
		expect(result.err.join("\n")).toContain("dream.model is not set");
		expect(result.out.join("\n")).toContain("dream/mbp-");
		expect(result.out.join("\n")).toContain("muninn dreams remember");
	}, 30_000);

	it("reports a dream.model that does not resolve, rather than a stack trace", async () => {
		settings({ dream: { model: "no-such-provider/no-such-model" } });
		const result = await runCli(["dream", "--scope", "global"], cwd);
		expect(result.code).toBe(1);
		// Either pi is absent or the model is: both are a sentence, not a trace.
		expect(result.err.join("\n")).toMatch(/no model|model runtime/);
	}, 60_000);

	it("refuses --qualify with no model configured", async () => {
		const result = await runCli(["dream", "--qualify"], cwd);
		expect(result.code).toBe(1);
		expect(result.err.join("\n")).toContain("no model to qualify");
	});
});

describe("muninn dreams", () => {
	it("lists nothing, then lists a pending dream, then a remembered one", async () => {
		expect((await runCli(["dreams", "--scope", "global"], cwd)).out.join("\n")).toContain("no dreams yet");

		await appendEntry({ source: "user", prose: "A note.", claims: ["A note."] }, { storePath, hostId: host.id });
		await runCli(["dream", "--scope", "global"], cwd);

		const listed = await runCli(["dreams", "--scope", "global"], cwd);
		expect(listed.out.join("\n")).toContain("pending");
		const stamp = (
			listed.out.join("\n").match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/) as RegExpMatchArray
		)[1] as string;

		const remembered = await runCli(["dreams", "remember", stamp, "--scope", "global"], cwd);
		expect(remembered.code).toBe(0);
		expect(remembered.out.join("\n")).toContain("next session");
		expect((await runCli(["dreams", "--scope", "global"], cwd)).out.join("\n")).toContain("remembered");

		const forgotten = await runCli(["dreams", "forget", stamp, "--scope", "global"], cwd);
		expect(forgotten.code).toBe(0);
		expect((await runCli(["dreams", "--scope", "global"], cwd)).out.join("\n")).toContain("forgotten");
	}, 60_000);

	it("needs a stamp to remember or forget", async () => {
		const result = await runCli(["dreams", "remember", "--scope", "global"], cwd);
		expect(result.code).toBe(2);
		expect(result.err.join("\n")).toContain("needs a dream stamp");
	});
});

describe("muninn erase", () => {
	it("prints the impact and refuses without two confirmations", async () => {
		const entry = await appendEntry(
			{ source: "user", prose: "Context.", claims: ["Something private."] },
			{ storePath, hostId: host.id },
		);
		const once = await runCli(["erase", entry.id, "--yes", "--scope", "global"], cwd);
		expect(once.code).toBe(2);
		expect(once.out.join("\n")).toContain("1 claim(s)");
		expect(once.err.join("\n")).toContain("--yes twice");

		const twice = await runCli(["erase", entry.id, "--yes", "--yes", "--no-rewrite", "--scope", "global"], cwd);
		expect(twice.code).toBe(0);
		expect(twice.out.join("\n")).toContain("tombstoned");
	}, 30_000);

	it("needs an entry id", async () => {
		const result = await runCli(["erase", "--yes", "--yes", "--scope", "global"], cwd);
		expect(result.code).toBe(2);
		expect(result.err.join("\n")).toContain("needs a journal entry id");
	});
});
