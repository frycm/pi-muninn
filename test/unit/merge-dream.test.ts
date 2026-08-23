/**
 * Two hosts, one topic, one merge dream.
 *
 * The plan's step-9 "done when": each laptop dreams and remembers a different
 * rewrite of the same topic, they meet, and one merge dream settles it without
 * losing a fact. Until this existed, `merge.ts` had no caller at all — it was
 * tested in isolation and unreachable from the transaction that needs it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetCommitDebounce } from "../../src/capture/commit.ts";
import { dream } from "../../src/dream/dream.ts";
import type { DreamModel } from "../../src/dream/model.ts";
import { remember, resolveConflict } from "../../src/dream/remember.ts";
import { git } from "../../src/git.ts";
import { newHostId } from "../../src/ids.ts";
import { appendEntry } from "../../src/journal/append.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import type { HostIdentity } from "../../src/store/host.ts";
import { ensureStore } from "../../src/store/init.ts";
import type { ActiveScope } from "../../src/store/scopes.ts";
import { parseTopic } from "../../src/topics/format.ts";

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
					now: new Date("2026-08-23T05:00:00Z"),
				}),
		});

		expect(result.problems).toEqual([]);
		expect(result.ok).toBe(true);
		expect(result.merged).toContain("-merge");
		expect(result.notes.join(" ")).toMatch(/residue pair\(s\) settled|merged/);

		// One coherent result, both sides' facts accounted for — kept or
		// superseded, never silently dropped.
		const topic = parseTopic(readFileSync(join(storePath, "topics", `${slug}.md`), "utf-8"), slug);
		const accounted = new Set([...topic.facts, ...topic.superseded].map((fact) => fact.id));
		expect(accounted.has(beforeMerge.facts[0]?.id as string)).toBe(true);
		expect(topic.facts.length).toBeGreaterThan(0);
		expect((await git(storePath, { kind: "status-porcelain", paths: [] })).stdout.trim()).toBe("");
		expect(existsSync(join(storePath, ".remember"))).toBe(false);
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
			now: new Date(),
		});
		expect(result.ok).toBe(false);
		expect(result.problems.join(" ")).toContain("by hand");
	});
});
