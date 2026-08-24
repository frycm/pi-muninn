/**
 * Two hosts, one topic, one merge dream.
 *
 * The plan's step-9 "done when": each laptop dreams and remembers a different
 * rewrite of the same topic, they meet, and one merge dream settles it without
 * losing a fact. Until this existed, `merge.ts` had no caller at all — it was
 * tested in isolation and unreachable from the transaction that needs it.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetCommitDebounce } from "../../src/capture/commit.ts";
import { dream } from "../../src/dream/dream.ts";
import { listDreams } from "../../src/dream/dreams.ts";
import type { DreamModel } from "../../src/dream/model.ts";
import { latestReport } from "../../src/dream/orient.ts";
import { remember, resolveConflict } from "../../src/dream/remember.ts";
import { git } from "../../src/git.ts";
import { newHostId } from "../../src/ids.ts";
import { appendEntry } from "../../src/journal/append.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import type { HostIdentity } from "../../src/store/host.ts";
import { ensureStore } from "../../src/store/init.ts";
import type { ActiveScope } from "../../src/store/scopes.ts";
import { parseTopic } from "../../src/topics/format.ts";

const execFileAsync = promisify(execFile);

let home: string;
let agentDir: string;
let storePath: string;
let host: HostIdentity;
let scope: ActiveScope;

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "muninn-merge-dream-"));
	agentDir = join(home, "agent");
	storePath = join(agentDir, "muninn");
	mkdirSync(agentDir, { recursive: true });
	host = { id: newHostId(), name: "mbp", createdAt: "2026-08-01" };
	await ensureStore(storePath, { host });
	scope = { scope: "global", path: storePath, exists: true, inRepo: false };
	resetCommitDebounce();
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

async function note(text: string): Promise<void> {
	await appendEntry({ source: "user", prose: text, claims: [text], cue: "the tests" }, { storePath, hostId: host.id });
	resetCommitDebounce();
}

function citing(claim: string): DreamModel {
	return {
		id: "test/mock",
		async complete(request) {
			const ids = [...request.prompt.matchAll(/\[(j-[0-9a-f-]+\.\d+)\]/g)].map((match) => match[1]);
			return `\`\`\`json\n${JSON.stringify([{ claim, evidence: ids, cue: "the tests" }])}\n\`\`\``;
		},
	};
}

/** A merge dreamer that folds both sides into one fact citing both. */
const merger: DreamModel = {
	id: "test/merger",
	async complete(request) {
		const ids = [...request.prompt.matchAll(/\[(j-[0-9a-f-]+\.\d+)\]/g)].map((match) => match[1]);
		const facts = [...request.prompt.matchAll(/\[id: (f-[a-z0-9-]+-[0-9a-f-]{36})\]/g)].map((match) => match[1]);
		return `\`\`\`json\n${JSON.stringify([
			{
				claim: "Tests need --run, and watch mode hangs CI.",
				evidence: [...new Set(ids)],
				supersedes: [...new Set(facts)],
				reason: "one fact, both hosts' observations",
			},
		])}\n\`\`\``;
	},
};

function options(now: Date, model: DreamModel) {
	return { scope, agentDir, host, storeId: "s", settings: DEFAULT_SETTINGS, now, model };
}

describe("two dreams that rewrote the same topic", () => {
	it("is settled by a merge dream, and no fact is lost", async () => {
		await note("Tests need pnpm test --run.");

		// Two dreams from the same input head — which is what two hosts dreaming
		// the same store produce once their journals meet at sync.
		const first = await dream(options(new Date("2026-08-23T03:00:00Z"), citing("Tests need --run.")));
		const second = await dream(options(new Date("2026-08-23T04:00:00Z"), citing("Watch mode hangs CI.")));
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);

		// The first lands cleanly.
		expect((await remember({ scope, agentDir, host, branch: first.branch })).ok).toBe(true);
		const slug = first.report.consolidated[0]?.topic as string;
		const beforeMerge = parseTopic(readFileSync(join(storePath, "topics", `${slug}.md`), "utf-8"), slug);
		expect(beforeMerge.facts).toHaveLength(1);

		// The second collides on the same topic file and goes to a merge dream.
		const result = await remember({
			scope,
			agentDir,
			host,
			branch: second.branch,
			resolve: (conflict) =>
				resolveConflict(conflict, {
					scope,
					agentDir,
					host,
					storeId: "s",
					model: merger,
					settings: DEFAULT_SETTINGS,
					now: new Date("2026-08-23T05:00:00Z"),
				}),
		});

		// Staged, not applied: a merge dream goes through the ordinary gate.
		expect(result.problems).toEqual([]);
		expect(result.ok).toBe(false);
		expect(result.pending).toContain("-merge");
		expect(result.notes.join(" ")).toContain("staged, not applied");

		// The report is reviewable before anything moves.
		const staged = (await listDreams(storePath)).find((entry) => entry.stamp.endsWith("-merge"));
		expect(staged?.remembered).toBe(false);
		expect(staged?.report).toBeDefined();

		const applied = await remember({ scope, agentDir, host, branch: result.pending as string });
		expect(applied.problems).toEqual([]);
		expect(applied.ok).toBe(true);

		// One coherent result, both sides' facts accounted for — kept or
		// superseded, never silently dropped.
		const topic = parseTopic(readFileSync(join(storePath, "topics", `${slug}.md`), "utf-8"), slug);
		const accounted = new Set([...topic.facts, ...topic.superseded].map((fact) => fact.id));
		expect(accounted.has(beforeMerge.facts[0]?.id as string)).toBe(true);
		expect(topic.facts.length).toBeGreaterThan(0);
		expect((await git(storePath, { kind: "status-porcelain", paths: [] })).stdout.trim()).toBe("");
		expect(existsSync(join(storePath, ".remember"))).toBe(false);
	}, 60_000);

	it("resolves a MEMORY.md-only conflict by regenerating it", async () => {
		// Two dreams that touched *different* topics still both rewrite
		// MEMORY.md, so the index file is the only conflict. That is the normal
		// case for disjoint work, and rejecting it — as an earlier version did —
		// meant the second of any two dreams could never be remembered.
		await note("Tests need pnpm test --run.");
		await appendEntry(
			{ source: "user", prose: "Deploys.", claims: ["Deploys go through the release workflow."], cue: "deploying" },
			{ storePath, hostId: host.id },
		);
		resetCommitDebounce();

		const first = await dream(options(new Date("2026-08-23T03:00:00Z"), citing("Tests need --run.")));
		const second = await dream(
			options(new Date("2026-08-23T04:00:00Z"), citing("Deploys go through the release workflow.")),
		);
		await remember({ scope, agentDir, host, branch: first.branch });

		const result = await remember({
			scope,
			agentDir,
			host,
			branch: second.branch,
			resolve: (conflict) =>
				resolveConflict(conflict, {
					scope,
					agentDir,
					host,
					storeId: "s",
					model: merger,
					settings: DEFAULT_SETTINGS,
					now: new Date("2026-08-23T05:00:00Z"),
				}),
		});
		expect(result.problems).toEqual([]);
		expect(result.pending).toBeDefined();
		const applied = await remember({ scope, agentDir, host, branch: result.pending as string });
		expect(applied.ok).toBe(true);

		// Both dreams' topics stand, and MEMORY.md lists them both — the whole
		// dream diff survived the merge, not just the conflicted files.
		const memory = readFileSync(join(storePath, "MEMORY.md"), "utf-8");
		const topics = new Set((memory.match(/topics\/[a-z0-9-]+\.md/g) ?? []).map((line) => line));
		expect(topics.size).toBe(2);
	}, 60_000);

	it("carries the dream's watermark onto the merge report", async () => {
		// The merge report is the newest complete one once remembered, so the
		// next dream reads its range from *it*. An empty journal_through there
		// ranged the next dream over the entire journal history — every consumed
		// entry re-offered, every per-host watermark lost.
		await note("Tests need pnpm test --run.");
		const first = await dream(options(new Date("2026-08-23T03:00:00Z"), citing("Tests need --run.")));
		const second = await dream(options(new Date("2026-08-23T04:00:00Z"), citing("Watch mode hangs CI.")));
		expect(Object.keys(second.report.journalThrough)).toHaveLength(1);
		await remember({ scope, agentDir, host, branch: first.branch });

		const result = await remember({
			scope,
			agentDir,
			host,
			branch: second.branch,
			resolve: (conflict) =>
				resolveConflict(conflict, {
					scope,
					agentDir,
					host,
					storeId: "s",
					model: merger,
					settings: DEFAULT_SETTINGS,
					now: new Date("2026-08-23T05:00:00Z"),
				}),
		});
		expect(result.pending).toBeDefined();
		expect((await remember({ scope, agentDir, host, branch: result.pending as string })).ok).toBe(true);

		const latest = latestReport(storePath);
		expect(latest?.stamp).toContain("-merge");
		expect(latest?.journalThrough).toEqual(second.report.journalThrough);

		// And the next dream's range really does start there: nothing to gather.
		const third = await dream(options(new Date("2026-08-23T06:00:00Z"), citing("Anything.")));
		expect(third.report.gathered.join(" ")).toContain("0 entry/entries in range");
	}, 60_000);

	it("joins per-host watermarks instead of letting one side's replace the other's", async () => {
		// Host A's older dream resolves against a main that already remembered
		// host B's newer one. Stamping the merge with A's watermark alone drops
		// B's cursor, and the next dream re-offers everything B consumed.
		await note("Tests need pnpm test --run.");
		const hostB: HostIdentity = { id: newHostId(), name: "ops", createdAt: "2026-08-01" };

		const dreamA = await dream(options(new Date("2026-08-23T03:00:00Z"), citing("Tests need --run.")));
		// B observes something of its own, then dreams and is remembered first.
		await appendEntry(
			{ source: "user", prose: "B's note.", claims: ["Watch mode hangs CI."], cue: "the tests" },
			{ storePath, hostId: hostB.id },
		);
		resetCommitDebounce();
		const dreamB = await dream({
			...options(new Date("2026-08-23T04:00:00Z"), citing("Watch mode hangs CI.")),
			host: hostB,
		});
		expect((await remember({ scope, agentDir, host: hostB, branch: dreamB.branch })).ok).toBe(true);
		expect(dreamB.report.journalThrough[hostB.id]).toBeDefined();

		// Now A's dream — cut before B's entry existed — resolves its conflict.
		const staged = await remember({
			scope,
			agentDir,
			host,
			branch: dreamA.branch,
			resolve: (conflict) =>
				resolveConflict(conflict, {
					scope,
					agentDir,
					host,
					storeId: "s",
					model: merger,
					settings: DEFAULT_SETTINGS,
					now: new Date("2026-08-23T05:00:00Z"),
				}),
		});
		expect(staged.pending).toBeDefined();

		const listed = await listDreams(storePath);
		const merge = listed.find((entry) => entry.stamp.endsWith("-merge"));
		expect(merge?.report?.journalThrough[hostB.id]).toBe(dreamB.report.journalThrough[hostB.id]);
		expect(merge?.report?.journalThrough[host.id]).toBe(dreamA.report.journalThrough[host.id]);
	}, 60_000);

	it("reports the conflict rather than guessing when there is no model to settle it", async () => {
		await note("Tests need pnpm test --run.");
		const first = await dream(options(new Date("2026-08-23T03:00:00Z"), citing("Tests need --run.")));
		const second = await dream(options(new Date("2026-08-23T04:00:00Z"), citing("Watch mode hangs CI.")));
		await remember({ scope, agentDir, host, branch: first.branch });

		const result = await remember({ scope, agentDir, host, branch: second.branch });
		expect(result.ok).toBe(false);
		expect(result.problems.join(" ")).toContain("merge dream");
		// And the store is exactly as it was.
		expect((await git(storePath, { kind: "status-porcelain", paths: [] })).stdout.trim()).toBe("");
		expect(existsSync(join(storePath, ".remember"))).toBe(false);
	}, 60_000);

	it("resolves conflicts in an in-repo store, where paths carry the repository prefix", async () => {
		// `git status` reports repo-root-relative paths, so an in-repo store's
		// conflicts arrive as `.pi/muninn/topics/….md`. Classifying them without
		// stripping the prefix matched nothing, and the resolver could settle
		// nothing at all for exactly the store layout that most needs it.
		const toplevel = join(home, "project");
		const inRepoStore = join(toplevel, ".pi", "muninn");
		mkdirSync(toplevel, { recursive: true });
		await execFileAsync("git", ["init", toplevel]);
		await execFileAsync("git", ["-C", toplevel, "symbolic-ref", "HEAD", "refs/heads/main"]);
		await execFileAsync("git", ["-C", toplevel, "config", "user.email", "a@b"]);
		await execFileAsync("git", ["-C", toplevel, "config", "user.name", "a"]);
		writeFileSync(join(toplevel, "README.md"), "# project\n");
		await execFileAsync("git", ["-C", toplevel, "add", "-A"]);
		await execFileAsync("git", ["-C", toplevel, "commit", "-qm", "init"]);

		await ensureStore(inRepoStore, { host, inRepo: true });
		const inRepo: ActiveScope = { scope: "project", path: inRepoStore, exists: true, inRepo: true, slug: "p" };
		await appendEntry(
			{ source: "user", prose: "Note.", claims: ["Tests need pnpm test --run."], cue: "the tests" },
			{ storePath: inRepoStore, hostId: host.id },
		);
		resetCommitDebounce();

		const opts = (now: Date, model: DreamModel) => ({
			scope: inRepo,
			agentDir,
			host,
			storeId: "in-repo",
			settings: DEFAULT_SETTINGS,
			now,
			model,
		});
		const first = await dream(opts(new Date("2026-08-23T03:00:00Z"), citing("Tests need --run.")));
		const second = await dream(opts(new Date("2026-08-23T04:00:00Z"), citing("Watch mode hangs CI.")));
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect((await remember({ scope: inRepo, agentDir, host, branch: first.branch })).ok).toBe(true);

		const result = await remember({
			scope: inRepo,
			agentDir,
			host,
			branch: second.branch,
			resolve: (conflict) =>
				resolveConflict(conflict, {
					scope: inRepo,
					agentDir,
					host,
					storeId: "in-repo",
					model: merger,
					settings: DEFAULT_SETTINGS,
					now: new Date("2026-08-23T05:00:00Z"),
				}),
		});
		expect(result.problems).toEqual([]);
		expect(result.pending).toBeDefined();
		const applied = await remember({ scope: inRepo, agentDir, host, branch: result.pending as string });
		expect(applied.problems).toEqual([]);
		expect(applied.ok).toBe(true);
		// And the project's own files were never part of it.
		expect(readFileSync(join(toplevel, "README.md"), "utf-8")).toBe("# project\n");
	}, 60_000);

	it("sends a rules.md conflict to a human, never to a model", async () => {
		// A rule is followed, not just recalled; the design says a residue in
		// rules always waits for review.
		const conflict = new (await import("../../src/dream/remember.ts")).RebaseConflict(
			"dream/mbp/x",
			["rules.md"],
			"conflict",
		);
		const result = await resolveConflict(conflict, {
			scope,
			agentDir,
			host,
			storeId: "s",
			model: merger,
			settings: DEFAULT_SETTINGS,
			now: new Date(),
		});
		expect(result.ok).toBe(false);
		expect(result.problems.join(" ")).toContain("by hand");
	});
});
