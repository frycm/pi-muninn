import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetCommitDebounce } from "../../src/capture/commit.ts";
import { dream } from "../../src/dream/dream.ts";
import { formatReport, parseReport } from "../../src/dream/report.ts";
import { git } from "../../src/git.ts";
import { newHostId, newStoreId } from "../../src/ids.ts";
import { appendEntry } from "../../src/journal/append.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import type { HostIdentity } from "../../src/store/host.ts";
import { ensureStore } from "../../src/store/init.ts";
import { withStoreLock } from "../../src/store/lock.ts";
import type { ActiveScope } from "../../src/store/scopes.ts";

const execFileAsync = promisify(execFile);

let home: string;
let agentDir: string;
let storePath: string;
let host: HostIdentity;
let scope: ActiveScope;
const STORE_ID = newStoreId();

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "muninn-dream-"));
	agentDir = join(home, "agent");
	storePath = join(agentDir, "muninn");
	mkdirSync(agentDir, { recursive: true });
	host = { id: newHostId(), name: "mbp", createdAt: "2026-08-01" };
	await ensureStore(storePath, { host });
	scope = { scope: "global", path: storePath, exists: true, inRepo: false };
	resetCommitDebounce();
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function options(now = new Date("2026-08-23T03:00:00Z")) {
	return { scope, agentDir, host, storeId: STORE_ID, settings: DEFAULT_SETTINGS, now };
}

async function head(): Promise<string> {
	return (await git(storePath, { kind: "rev-parse", target: "HEAD" })).stdout.trim();
}

async function note(text: string): Promise<void> {
	await appendEntry({ source: "user", prose: text, claims: [text] }, { storePath, hostId: host.id });
}

describe("a dream is a branch, and the store is untouched", () => {
	it("records the range it read, commits on its own branch, and leaves main where it was", async () => {
		await note("Run tests with pnpm test --run.");
		const before = await head();

		const phases: string[] = [];
		const result = await dream({ ...options(), progress: (phase) => phases.push(phase) });

		expect(result.ok).toBe(true);
		expect(result.branch).toBe(`dream/${result.stamp}`);
		expect(result.stamp).toMatch(new RegExp(`^mbp-${host.id}/2026-08-23T03-00-00-000Z-[0-9a-f-]{36}$`));
		expect(phases).toEqual(["orient", "gather", "consolidate", "lint", "commit"]);

		// `input_head` names the commit the worktree was cut from — and the
		// pending entry was committed *inside* the lock, so it is in it.
		const after = await head();
		expect(after).not.toBe(before);
		expect(result.report.inputHead).toBe(after);

		// main has the journal commit and nothing else; the dream commit is on
		// the branch, and the store is clean against its own HEAD.
		const { stdout: mainLog } = await execFileAsync("git", ["log", "--format=%s", "-2"], { cwd: storePath });
		expect(mainLog.split("\n")[0]).toMatch(/^journal:/);
		expect(existsSync(join(storePath, "dreams"))).toBe(false);
		expect((await git(storePath, { kind: "status-porcelain", paths: [] })).stdout.trim()).toBe("");

		const { stdout: branchLog } = await execFileAsync(
			"git",
			["show", "--name-only", "--format=%s%n%b", result.branch],
			{
				cwd: storePath,
			},
		);
		expect(branchLog).toContain(`dreams/${result.stamp}.md`);
		expect(branchLog).toContain(`Muninn-Input-Head: ${after}`);
	});

	it("refuses to start while another dream holds the lock, and says who has it", async () => {
		let inner: Awaited<ReturnType<typeof dream>> | undefined;
		await withStoreLock(storePath, "dream", { host: "someone-else" }, async () => {
			inner = await dream({ ...options(), staleMs: 60_000 });
		});
		expect(inner?.ok).toBe(false);
		expect(inner?.problems.join(" ")).toContain("someone-else");
		expect(inner?.problems.join(" ")).toContain("busy");
	});

	it("starts the next range where the last complete dream ended", async () => {
		await note("First.");
		const first = await dream(options());
		expect(first.ok).toBe(true);
		// Remember it, so the report is on main where the next dream's orient reads it.
		await git(storePath, { kind: "merge-ff-only", ref: first.branch });

		await note("Second.");
		const second = await dream(options(new Date("2026-08-24T03:00:00Z")));
		expect(second.ok).toBe(true);
		expect(second.report.previousInputHead).toBe(first.report.inputHead);
		expect(second.report.gathered.join(" ")).toContain(first.report.inputHead.slice(0, 8));
	});

	it("does not resume from a dream that failed", async () => {
		// A failed dream consolidated nothing, so its range was never learned
		// from; resuming after it would silently skip every entry it saw.
		await note("First.");
		const first = await dream(options());
		await git(storePath, { kind: "merge-ff-only", ref: first.branch });
		const path = join(storePath, "dreams", `${first.stamp}.md`);
		writeFileSync(path, readFileSync(path, "utf-8").replace("status: complete", "status: failed"));
		// Committed, because a dream reads its worktree — which is committed
		// state — and not whatever happens to be in the working tree.
		await git(storePath, { kind: "add", paths: ["dreams/"] });
		await git(storePath, { kind: "commit", message: "mark failed", paths: ["dreams/"] });

		const second = await dream(options(new Date("2026-08-24T03:00:00Z")));
		expect(second.report.previousInputHead).toBeUndefined();
	});

	it("collects the worktree a dream that died left behind", async () => {
		const first = await dream(options());
		expect(existsSync(first.worktree as string)).toBe(true);
		// A dream killed mid-phase leaves the checkout and a modified file in it.
		writeFileSync(join(first.worktree as string, "MEMORY.md"), "half-written\n");

		const second = await dream(options(new Date("2026-08-24T03:00:00Z")));
		expect(second.ok).toBe(true);
		expect(second.report.notes.join(" ")).toContain("abandoned worktree");
		expect(existsSync(first.worktree as string)).toBe(false);
	});

	it("reports rather than throws when the store has no commits", async () => {
		const bare = mkdtempSync(join(tmpdir(), "muninn-bare-"));
		try {
			await git(bare, { kind: "init" });
			await git(bare, { kind: "set-head", branch: "main" });
			const result = await dream({
				...options(),
				scope: { scope: "global", path: bare, exists: true, inRepo: false },
			});
			expect(result.ok).toBe(false);
			expect(result.problems.join(" ")).toContain("no commits");
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});
});

describe("the report", () => {
	it("round-trips the fields a command has to act on", () => {
		const text = formatReport({
			stamp: "2026-08-23T03-00",
			scope: "global",
			host: "mbp",
			model: "ollama/qwen3.5:9b",
			status: "lint-blocked",
			inputHead: "abc123",
			previousInputHead: "def456",
			journalThrough: { "0198a0b1": "j-0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01" },
			heldOut: ["task-a", "task-b"],
			started: "2026-08-23T03:00:00Z",
			finished: "2026-08-23T03:04:00Z",
			gathered: ["12 entries"],
			consolidated: [{ topic: "testing", added: 2, superseded: 1, addedIds: ["f-testing-x"] }],
			lint: [{ blocking: true, rule: "unsourced", message: "f-testing-x cites nothing" }],
			skipped: [{ topic: "deploy", reason: "unparsable after one retry" }],
			notes: ["committed pending entries"],
		});

		const read = parseReport(text, "2026-08-23T03-00");
		expect(read?.status).toBe("lint-blocked");
		expect(read?.inputHead).toBe("abc123");
		expect(read?.previousInputHead).toBe("def456");
		expect(read?.heldOut).toEqual(["task-a", "task-b"]);
		expect(read?.journalThrough).toEqual({ "0198a0b1": "j-0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01" });
		expect(read?.model).toBe("ollama/qwen3.5:9b");
		// The body is prose for a human and deliberately not parsed back.
		expect(text).toContain("**blocking** · unsourced");
		expect(text).toContain("- **deploy** — unparsable after one retry");
	});
});
