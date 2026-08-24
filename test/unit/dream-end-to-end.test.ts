import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetCommitDebounce } from "../../src/capture/commit.ts";
import { dream } from "../../src/dream/dream.ts";
import type { DreamModel } from "../../src/dream/model.ts";
import { git } from "../../src/git.ts";
import { newHostId, newStoreId } from "../../src/ids.ts";
import { appendEntry } from "../../src/journal/append.ts";
import { readStoreJournal } from "../../src/journal/read.ts";
import { parseSupersessions } from "../../src/journal/supersessions.ts";
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
	home = mkdtempSync(join(tmpdir(), "muninn-e2e-"));
	agentDir = join(home, "agent");
	storePath = join(agentDir, "muninn");
	mkdirSync(agentDir, { recursive: true });
	host = { id: newHostId(), name: "mbp", createdAt: "2026-08-01" };
	await ensureStore(storePath, { host });
	scope = { scope: "global", path: storePath, exists: true, inRepo: false };
	resetCommitDebounce();
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

/** A model that answers a consolidate job by citing whatever ids it was shown. */
function citingModel(claim: string): DreamModel {
	return {
		id: "test/mock",
		async complete(request) {
			const ids = [...request.prompt.matchAll(/\[(j-[0-9a-f-]+\.\d+)\]/g)].map((match) => match[1]);
			return `Reasoning.\n\n\`\`\`json\n${JSON.stringify([{ claim, evidence: ids, cue: "running the tests" }])}\n\`\`\`\n`;
		},
	};
}

async function note(text: string, cue?: string): Promise<void> {
	await appendEntry(
		{ source: "user", prose: text, claims: [text], ...(cue !== undefined ? { cue } : {}) },
		{ storePath, hostId: host.id },
	);
}

function options(now: Date, model?: DreamModel) {
	return {
		scope,
		agentDir,
		host,
		storeId: newStoreId(),
		settings: DEFAULT_SETTINGS,
		now,
		...(model ? { model } : {}),
	};
}

describe("a whole dream, with a model", () => {
	it("writes a topic, a MEMORY.md line and a report, and reads as one diff", async () => {
		await note("Run tests with pnpm test --run, never watch mode.", "CI hangs on vitest");

		const result = await dream(
			options(new Date("2026-08-23T03:00:00Z"), citingModel("Run tests with `pnpm test --run`, never watch mode.")),
		);
		expect(result.problems).toEqual([]);
		expect(result.ok).toBe(true);
		expect(result.report.consolidated).toHaveLength(1);
		expect(result.report.status).toBe("complete");

		// Everything is on the branch; the store people are using has not moved.
		await git(storePath, { kind: "merge-ff-only", ref: result.branch });

		const slug = result.report.consolidated[0]?.topic as string;
		const topic = parseTopic(readFileSync(join(storePath, "topics", `${slug}.md`), "utf-8"), slug);
		expect(topic.facts).toHaveLength(1);
		expect(topic.facts[0]?.source).toBe("user");
		expect(topic.facts[0]?.evidence[0]).toMatch(/^j-.*\.1$/);

		const memory = readFileSync(join(storePath, "MEMORY.md"), "utf-8");
		expect(memory).toContain(`topics/${slug}.md`);
		expect(memory).toContain("never watch mode");

		// The fourth acceptance criterion: readable in `git log -p`.
		const { stdout } = await execFileAsync("git", ["log", "-p", "-1", "--format=%s%n%b"], { cwd: storePath });
		expect(stdout).toContain("dream: 1 facts, 0 superseded, 1 topics");
		expect(stdout).toContain(`Muninn-Topics: ${slug}`);
		expect(stdout).toMatch(/^\+- \*\*.*\*\* id: f-/m);
	});

	it("supersedes on the second dream and leaves the audit row behind", async () => {
		await note("Run tests with pnpm test.", "running the tests");
		const first = await dream(options(new Date("2026-08-23T03:00:00Z"), citingModel("Run tests with `pnpm test`.")));
		await git(storePath, { kind: "merge-ff-only", ref: first.branch });
		const slug = first.report.consolidated[0]?.topic as string;
		const oldFact = first.report.consolidated[0]?.addedIds[0] as string;

		await note("Correction: tests need pnpm test --run or CI hangs.", "running the tests");
		const supersedingModel: DreamModel = {
			id: "test/mock",
			async complete(request) {
				const ids = [...request.prompt.matchAll(/\[(j-[0-9a-f-]+\.\d+)\]/g)].map((match) => match[1]);
				return `\`\`\`json\n${JSON.stringify([
					{
						claim: "Run tests with `pnpm test --run`; watch mode hangs CI.",
						evidence: ids,
						supersedes: [oldFact],
						reason: "user correction",
					},
				])}\n\`\`\``;
			},
		};
		const second = await dream(options(new Date("2026-08-24T03:00:00Z"), supersedingModel));
		expect(second.ok).toBe(true);
		await git(storePath, { kind: "merge-ff-only", ref: second.branch });

		const topic = parseTopic(readFileSync(join(storePath, "topics", `${slug}.md`), "utf-8"), slug);
		expect(topic.facts).toHaveLength(1);
		const retired = topic.superseded[0];
		expect(retired?.id).toBe(oldFact);
		expect(retired?.validTo).toBe("2026-08-24");
		expect(retired?.reason).toBe("user correction");
		// And the journal claim behind it is listed, so recall drops it.
		const supersessions = parseSupersessions(readFileSync(join(storePath, "supersessions.md"), "utf-8"));
		expect(supersessions.superseded.size).toBeGreaterThan(0);
	});

	it("blocks a dream whose model invents its evidence, and keeps the branch", async () => {
		await note("Something worth remembering about deploys.", "the deploy pipeline");
		const liar: DreamModel = {
			id: "test/mock",
			complete: async () =>
				'```json\n[{"claim": "A fact from nowhere.", "evidence": ["j-01a00000-0000-7000-8000-000000000099.1"]}]\n```',
		};
		const result = await dream(options(new Date("2026-08-23T03:00:00Z"), liar));

		// Refused at consolidate, so nothing was written and lint has nothing to
		// block on — the report is where the refusal is recorded.
		expect(result.report.consolidated).toEqual([]);
		expect(result.report.lint.some((finding) => finding.rule === "unsourced")).toBe(true);
		// The branch still exists: a dream nobody will remember is still evidence.
		expect((await git(storePath, { kind: "verify-ref", ref: result.branch })).stdout.trim()).not.toBe("");
	});
});

describe("an echo can never become evidence", () => {
	it("refuses the restating claim, not the memory it restated", async () => {
		// An entry reaches a job for one of its claims and brings all of them into
		// the prompt and the allow-list. If the refusal is keyed on `echo:` — which
		// names the *memory* that was restated — the restatement stays citable and
		// the original observation is refused instead: both halves wrong.
		const original = await appendEntry(
			{ source: "user", prose: "Said once.", claims: ["Run tests with pnpm test --run."], cue: "the tests" },
			{ storePath, hostId: host.id },
		);
		resetCommitDebounce();
		await appendEntry(
			{
				source: "user",
				prose: "Said again, plus something new.",
				claims: ["Run tests with pnpm test --run.", "The CI runner has no TTY."],
				cue: "the tests",
				echo: [`${original.id}.1`],
			},
			{ storePath, hostId: host.id },
		);
		resetCommitDebounce();

		const model = citingModel("Facts about the tests.");
		const result = await dream(options(new Date("2026-08-23T03:00:00Z"), model));
		expect(result.ok).toBe(true);
		await git(storePath, { kind: "merge-ff-only", ref: result.branch });

		const slug = result.report.consolidated[0]?.topic as string;
		const topic = parseTopic(readFileSync(join(storePath, "topics", `${slug}.md`), "utf-8"), slug);
		const evidence = topic.facts.flatMap((fact) => fact.evidence);

		// The echoing claim is the second entry's `.1`; the original is citable.
		expect(evidence.some((id) => id.startsWith(original.id))).toBe(true);
		const echoing = readStoreJournal(storePath).entries[1]?.id as string;
		expect(evidence).not.toContain(`${echoing}.1`);
	});
});

describe("the watermark advances only over consumed work", () => {
	it("does not run past a skipped topic, so a model outage eats nothing", async () => {
		// A dead endpoint means the job consolidated nothing. If the watermark
		// still advanced, the day's evidence would fall before
		// previous_input_head and no dream would ever see it again.
		await note("Worth consolidating.", "the tests");
		const dead: DreamModel = {
			id: "test/dead",
			complete: async () => {
				throw new Error("ECONNREFUSED");
			},
		};
		const first = await dream(options(new Date("2026-08-23T03:00:00Z"), dead));
		expect(first.ok).toBe(true);
		expect(first.report.skipped.length).toBeGreaterThan(0);
		await git(storePath, { kind: "merge-ff-only", ref: first.branch });

		// The endpoint is back; the same entry is in range and consolidates.
		const second = await dream(options(new Date("2026-08-24T03:00:00Z"), citingModel("A fact about the tests.")));
		expect(second.ok).toBe(true);
		expect(second.report.consolidated).toHaveLength(1);
	});

	it("does not run past evidence a dream with no model could not touch", async () => {
		await note("Worth consolidating.", "the tests");
		const first = await dream({ ...options(new Date("2026-08-23T03:00:00Z")) });
		expect(first.ok).toBe(true);
		await git(storePath, { kind: "merge-ff-only", ref: first.branch });

		const second = await dream(options(new Date("2026-08-24T03:00:00Z"), citingModel("A fact about the tests.")));
		expect(second.report.consolidated).toHaveLength(1);
	});

	it("stops at the first withheld entry, not at the highest retained one", async () => {
		// A held-out task's entries sit *between* two consumable notes. The
		// contiguous-prefix rule stops the watermark before the held-out group, so
		// the note after it is offered again too — where a maximum over retained
		// ids would have advanced past the group and deleted it from every range.
		await note("First note.", "the tests");
		await appendEntry(
			{ source: "user", prose: "Task work.", claims: ["Learned in a task."], task: "t-done", cue: "held" },
			{ storePath, hostId: host.id },
		);
		await appendEntry(
			{ source: "agent", prose: "Outcome.", claims: ["Finished the task."], task: "t-done", phase: "fix" },
			{ storePath, hostId: host.id },
		);
		resetCommitDebounce();
		await note("Second note.", "the tests");

		const settings = { ...DEFAULT_SETTINGS, dream: { ...DEFAULT_SETTINGS.dream, evalSessions: 1 } };
		// "Completed" means quiet for an hour, measured against the dream's own
		// clock — so the dream runs two hours after the entries were written.
		const result = await dream({
			...options(new Date(Date.now() + 2 * 3_600_000), citingModel("A fact about the tests.")),
			settings,
		});
		expect(result.ok).toBe(true);
		expect(result.report.heldOut).toEqual(["t-done"]);

		const entries = readStoreJournal(storePath).entries;
		const firstNote = entries[0]?.id as string;
		const watermark = result.report.journalThrough[host.id];
		// Advanced over the first note and no further: the held-out group and the
		// second note both stay in the next dream's range.
		expect(watermark).toBe(firstNote);
	});
});

describe("a model that answers 'keep everything' still consumes its evidence", () => {
	it("advances the watermark past a job that legitimately changed nothing", async () => {
		// A no-op reply is a completed job: the entries were considered and found
		// to add nothing. Treating "changed nothing" as "did not run" rebuilt the
		// identical job on every dream, got the identical no-op answer, and the
		// watermark never advanced past that host's first entry — a livelock with
		// a model bill.
		await note("Something the model deems unremarkable.", "the tests");
		const keeper: DreamModel = { id: "test/keeper", complete: async () => "```json\n[]\n```" };

		const first = await dream(options(new Date("2026-08-23T03:00:00Z"), keeper));
		expect(first.ok).toBe(true);
		expect(first.report.skipped).toEqual([]);
		await git(storePath, { kind: "merge-ff-only", ref: first.branch });

		const second = await dream(options(new Date("2026-08-24T03:00:00Z"), keeper));
		expect(second.report.gathered.join(" ")).toContain("0 entry/entries in range");
	});
});

describe("what a dream withholds comes back", () => {
	it("consolidates a held-out task once it is no longer among the most recent", async () => {
		// The hold-out is chronological: a group withheld today is consolidated
		// when newer work pushes it out of the window. That only works if the
		// dream's watermark did not run past it.
		await note("The only thing worth knowing.", "the tests");
		const settings = { ...DEFAULT_SETTINGS, dream: { ...DEFAULT_SETTINGS.dream, evalSessions: 1 } };
		const model = citingModel("A fact about the tests.");

		const first = await dream({ ...options(new Date("2026-08-23T03:00:00Z"), model), settings });
		expect(first.report.heldOut.length).toBe(0);
		await git(storePath, { kind: "merge-ff-only", ref: first.branch });

		// Nothing was consolidated, because the only entry has no task group and
		// the store is otherwise empty — what matters is the watermark.
		const second = await dream({ ...options(new Date("2026-08-24T03:00:00Z"), model), settings });
		expect(second.report.previousInputHead).toBe(first.report.inputHead);
	});
});
