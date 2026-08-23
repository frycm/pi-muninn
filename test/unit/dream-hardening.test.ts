import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetCommitDebounce } from "../../src/capture/commit.ts";
import { dream } from "../../src/dream/dream.ts";
import type { DreamModel } from "../../src/dream/model.ts";
import { remember } from "../../src/dream/remember.ts";
import { createWorktree } from "../../src/dream/worktree.ts";
import { git } from "../../src/git.ts";
import { newHostId, newStoreId } from "../../src/ids.ts";
import { appendEntry } from "../../src/journal/append.ts";
import { readStoreJournal } from "../../src/journal/read.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import type { HostIdentity } from "../../src/store/host.ts";
import { ensureStore } from "../../src/store/init.ts";
import type { ActiveScope } from "../../src/store/scopes.ts";

let home: string;
let agentDir: string;
let storePath: string;
let host: HostIdentity;
let scope: ActiveScope;

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "muninn-harden-"));
	agentDir = join(home, "agent");
	storePath = join(agentDir, "muninn");
	mkdirSync(agentDir, { recursive: true });
	host = { id: newHostId(), name: "mbp", createdAt: "2026-08-01" };
	await ensureStore(storePath, { host });
	scope = { scope: "global", path: storePath, exists: true, inRepo: false };
	resetCommitDebounce();
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function options(now = new Date("2026-08-23T03:00:00Z"), model?: DreamModel) {
	return { scope, agentDir, host, storeId: newStoreId(), settings: DEFAULT_SETTINGS, now, ...(model ? { model } : {}) };
}

async function note(text: string): Promise<void> {
	await appendEntry({ source: "user", prose: text, claims: [text], cue: "a cue" }, { storePath, hostId: host.id });
	resetCommitDebounce();
}

describe("a dream that meets trouble says so and leaves the store alone", () => {
	it("keeps the branch and names the phase when the model endpoint dies mid-dream", async () => {
		await note("Something worth consolidating.");
		const dead: DreamModel = {
			id: "test/dead",
			complete: async () => {
				throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
			},
		};
		const result = await dream(options(new Date("2026-08-23T03:00:00Z"), dead));

		// The dream itself succeeds: the topic is skipped, not the run. A dead
		// endpoint is a reason to consolidate nothing, not to lose the range.
		expect(result.ok).toBe(true);
		expect(result.report.skipped.length).toBeGreaterThan(0);
		expect(result.report.skipped[0]?.reason).toContain("ECONNREFUSED");
		expect(result.report.consolidated).toEqual([]);
		expect((await git(storePath, { kind: "verify-ref", ref: result.branch })).stdout.trim()).not.toBe("");
	});

	it("takes over a worktree directory that is already there", async () => {
		// `worktree add` refuses a path that exists, and a dream that died leaves
		// exactly that. Reusing it would inherit whatever it had written.
		await note("A note.");
		const first = await createWorktree({
			scope,
			agentDir,
			storeId: "s",
			branch: "dream/mbp/2026-08-23T03-00",
			startPoint: "HEAD",
		});
		writeFileSync(join(first.storePath, "MEMORY.md"), "left over\n");

		const result = await dream({ ...options(), storeId: "s" });
		expect(result.ok).toBe(true);
		expect(readFileSync(join(result.worktree as string, "MEMORY.md"), "utf-8")).not.toContain("left over");
	});

	it("does not mind entries appended after the input head", async () => {
		// The point of the worktree: gather reads committed state, so a session
		// writing while the dream runs changes nothing about what it consolidated.
		await note("Before the dream.");
		let duringDream = false;
		const model: DreamModel = {
			id: "test/racing",
			async complete(request) {
				if (!duringDream) {
					duringDream = true;
					await note("Written while the dream was running.");
				}
				const ids = [...request.prompt.matchAll(/\[(j-[0-9a-f-]+\.\d+)\]/g)].map((match) => match[1]);
				return `\`\`\`json\n${JSON.stringify([{ claim: "A consolidated fact.", evidence: ids }])}\n\`\`\``;
			},
		};

		const result = await dream(options(new Date("2026-08-23T03:00:00Z"), model));
		expect(result.ok).toBe(true);
		// The prompt only ever saw the committed entry; the new one waits for the
		// next dream, and the journal has both.
		expect(readStoreJournal(storePath).entries).toHaveLength(2);
		expect(result.report.gathered.join(" ")).toContain("1 entry/entries in range");
	});

	it("reports a store whose directory vanished, rather than throwing", async () => {
		const gone: ActiveScope = { scope: "global", path: join(home, "not-a-store"), exists: true, inRepo: false };
		const result = await dream({ ...options(), scope: gone });
		expect(result.ok).toBe(false);
		expect(result.problems.length).toBeGreaterThan(0);
	});

	it("survives a report directory it cannot write, keeping main untouched", async () => {
		await note("A note.");
		const first = await dream(options());
		expect(first.ok).toBe(true);
		const before = (await git(storePath, { kind: "rev-parse", target: "HEAD" })).stdout.trim();

		// The worktree's `dreams/` made read-only: the report cannot be written.
		const dreams = join(first.worktree as string, "dreams");
		if (process.getuid?.() === 0) return; // root ignores the mode bits
		chmodSync(dreams, 0o500);
		try {
			const second = await dream({ ...options(new Date("2026-08-24T03:00:00Z")), storeId: "same" });
			// Whatever happened, `main` did not move and the store is clean.
			expect((await git(storePath, { kind: "rev-parse", target: "HEAD" })).stdout.trim()).toBe(before);
			expect(second.report.status === "failed" || second.ok).toBe(true);
		} finally {
			chmodSync(dreams, 0o700);
		}
	});
});

describe("remember under stress", () => {
	it("refuses when main moved to something the branch cannot fast-forward over", async () => {
		await note("A note.");
		const first = await dream(options());

		// A hand-written derived file committed on `main`: exactly the conflict
		// the design says must go through a merge dream and never `git merge`.
		mkdirSync(join(storePath, "topics"), { recursive: true });
		writeFileSync(join(storePath, "topics", "a-cue.md"), "# A cue\n\n## Facts\n\n- hand written\n");
		await git(storePath, { kind: "add", paths: ["topics/"] });
		await git(storePath, { kind: "commit", message: "hand edit", paths: ["topics/"] });
		const before = (await git(storePath, { kind: "rev-parse", target: "HEAD" })).stdout.trim();

		const result = await remember({ scope, agentDir, host, branch: first.branch });
		if (!result.ok) {
			expect(result.problems.join(" ")).toMatch(/merge dream|rebase|ff/i);
		}
		// Either it rebased cleanly or it refused; what it must never do is leave
		// the store mid-transaction.
		expect(existsSync(join(storePath, ".remember"))).toBe(false);
		expect((await git(storePath, { kind: "status-porcelain", paths: [] })).stdout.trim()).toBe("");
		if (!result.ok) {
			expect((await git(storePath, { kind: "rev-parse", target: "HEAD" })).stdout.trim()).toBe(before);
		}
	});
});
