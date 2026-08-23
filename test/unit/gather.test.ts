import { describe, expect, it } from "vitest";
import {
	completedGroups,
	type GatherResult,
	gather,
	MAX_EVIDENCE,
	newTopicSlug,
	taskGroups,
} from "../../src/dream/gather.ts";
import type { Orientation } from "../../src/dream/orient.ts";
import { emptyTopic, type Fact, type TopicFile } from "../../src/topics/format.ts";
import { buildJournal, type EntrySpec, entryIdAt, minutes } from "../fixtures/journal-builder.ts";

function orientation(overrides: Partial<Orientation> = {}): Orientation {
	return {
		topics: new Map(),
		factsById: new Map(),
		citedBy: new Map(),
		superseded: new Set(),
		erased: new Set(),
		usage: new Map(),
		memory: "",
		rules: "",
		previousJournalThrough: {},
		problems: [],
		...overrides,
	};
}

function run(specs: readonly EntrySpec[], options: Partial<Parameters<typeof gather>[0]> = {}): GatherResult {
	return gather({
		orientation: orientation(),
		entries: buildJournal(specs).entries,
		holdOut: 0,
		now: minutes(10_000),
		...options,
	});
}

function claimIds(result: GatherResult): string[] {
	return result.jobs.flatMap((job) => job.claims.map((claim) => claim.id)).sort();
}

function droppedFor(result: GatherResult, id: string): string | undefined {
	return result.dropped.find((entry) => entry.id === id)?.reason;
}

/** A finished piece of work: some entries and the outcome that closes it. */
function task(id: string, at: number, claims: string[], extra: Partial<EntrySpec> = {}): EntrySpec[] {
	return [
		{ at, source: "agent", task: id, claims, phase: "fix", ...extra },
		{ at: at + 1, source: "agent", task: id, claims: [`Finished ${id}.`], phase: "fix" },
	];
}

describe("gather selects, and says why it rejected the rest", () => {
	it("always keeps what the user typed", () => {
		const result = run([
			{ at: 0, source: "user", claims: ["Run tests with pnpm test --run."], cue: "CI hangs on vitest" },
		]);
		expect(claimIds(result)).toEqual([`${entryIdAt(0, 0)}.1`]);
		expect(result.jobs[0]?.claims[0]?.reason).toBe("user");
	});

	it("does not promote a single agent observation", () => {
		// One thing the model once believed is not a fact. It stays in the
		// journal, searchable, and waits to be observed again.
		const result = run([{ at: 0, source: "agent", claims: ["The build directory is called out."], phase: "locate" }]);
		expect(result.jobs).toEqual([]);
		expect(droppedFor(result, `${entryIdAt(0, 0)}.1`)).toMatch(/not yet recurrent/);
	});

	it("promotes an observation made in two different pieces of work", () => {
		const claim = "The integration suite needs DATABASE_URL pointing at the compose db.";
		const result = run([
			{ at: 0, source: "agent", task: "task-a", claims: [claim], phase: "locate" },
			{ at: 100, source: "agent", task: "task-b", claims: [claim], phase: "locate" },
		]);
		expect(claimIds(result)).toHaveLength(2);
		expect(result.jobs[0]?.claims[0]?.reason).toBe("recurrence");
	});

	it("does not count the same observation twice inside one task", () => {
		const claim = "The integration suite needs DATABASE_URL pointing at the compose db.";
		const result = run([
			{ at: 0, source: "agent", task: "task-a", claims: [claim], phase: "locate" },
			{ at: 5, source: "agent", task: "task-a", claims: [claim], phase: "locate" },
		]);
		expect(result.jobs).toEqual([]);
	});

	it("does not count two sessions that were shown the same memory", () => {
		// Distinct tasks but an identical `recalled` set: one observation seen
		// twice, which is the self-reinforcement loop arriving by another door.
		const claim = "The integration suite needs DATABASE_URL pointing at the compose db.";
		const result = run([
			{ at: 0, source: "agent", task: "task-a", claims: [claim], recalled: ["f-db-x"], phase: "locate" },
			{ at: 100, source: "agent", task: "task-b", claims: [claim], recalled: ["f-db-x"], phase: "locate" },
		]);
		expect(result.jobs).toEqual([]);
	});

	it("keeps failures and decisions on a single sighting", () => {
		const result = run([
			{
				at: 0,
				source: "agent",
				task: "a",
				claims: ["The CI job hangs because watch mode never exits."],
				phase: "test",
			},
			{ at: 1, source: "agent", task: "b", claims: ["We chose vitest over jest for the ESM support."], phase: "test" },
		]);
		expect(result.jobs.flatMap((job) => job.claims.map((claim) => claim.reason)).sort()).toEqual([
			"decision",
			"failure",
		]);
	});
});

describe("gather refuses what must never become a fact", () => {
	it("drops a claim that echoes a memory the model was just shown", () => {
		const fact: Fact = {
			id: "f-testing-0198f2c2-0a1b-7c2d-8e3f-405162738495",
			claim: "Run tests with pnpm test --run, never watch mode.",
			validFrom: "2026-08-01",
			source: "user",
			evidence: [],
		};
		const result = run(
			[
				{
					at: 0,
					source: "user",
					claims: ["Run tests with pnpm test --run, never watch mode."],
					echo: [fact.id],
				},
			],
			{ orientation: orientation({ factsById: new Map([[fact.id, fact]]) }) },
		);
		expect(result.jobs).toEqual([]);
		expect(droppedFor(result, `${entryIdAt(0, 0)}.1`)).toMatch(/echo/);
	});

	it("drops a superseded claim and an erased entry", () => {
		const superseded = `${entryIdAt(0, 0)}.1`;
		const erased = entryIdAt(10, 1);
		const result = run(
			[
				{ at: 0, source: "user", claims: ["Old and superseded."] },
				{ at: 10, source: "user", claims: ["Erased for privacy."] },
			],
			{ orientation: orientation({ superseded: new Set([superseded]), erased: new Set([erased]) }) },
		);
		expect(result.jobs).toEqual([]);
		expect(droppedFor(result, superseded)).toBe("superseded");
		expect(droppedFor(result, erased)).toBe("erased");
	});

	it("does not gather a claim an active fact already cites", () => {
		const cited = `${entryIdAt(0, 0)}.1`;
		const result = run([{ at: 0, source: "user", claims: ["Already a fact."] }], {
			orientation: orientation({ citedBy: new Map([[cited, "testing"]]) }),
		});
		expect(result.jobs).toEqual([]);
		expect(droppedFor(result, cited)).toContain("testing");
	});

	it("quarantines a topic whose evidence is mostly someone else's writing", () => {
		const result = run([
			{ at: 0, source: "external", claims: ["The vendor docs say the hook retries three times."], cue: "deploy hook" },
			{
				at: 1,
				source: "external",
				claims: ["The vendor docs say the hook retries three times."],
				cue: "deploy hook",
				task: "b",
			},
			{ at: 2, source: "user", claims: ["Our deploy hook is called from the release job."], cue: "deploy hook" },
		]);
		expect(result.jobs).toEqual([]);
		expect(result.quarantined[0]?.reason).toMatch(/poisoning budget/);
	});
});

describe("the hold-out", () => {
	it("withholds whole task groups, closed over continues", () => {
		const specs: EntrySpec[] = [
			...task("task-1", 0, ["First task learned something."]),
			// A resumed session: the same piece of work under a second task id.
			{ at: 10, source: "agent", task: "task-2b", continues: "task-2", claims: ["Resumed half."], phase: "fix" },
			...task("task-2", 5, ["Second task learned something."]),
			...task("task-3", 20, ["Third task learned something."]),
			{ at: 9_999, source: "user", claims: ["Typed just now, still in flight."], task: "task-live" },
		];
		const result = run(specs, { holdOut: 2, now: minutes(10_000) });

		// The two most recent completed groups, and both halves of the resumed one.
		expect(result.heldOut).toContain("task-3");
		expect(result.heldOut).toContain("task-2");
		expect(result.heldOut).toContain("task-2b");
		expect(result.heldOut).not.toContain("task-1");

		// Nothing from a held-out group reaches a job, whatever its source.
		const gatheredText = result.jobs.flatMap((job) => job.claims.map((claim) => claim.text));
		expect(gatheredText.join(" ")).not.toContain("Second task");
		expect(gatheredText.join(" ")).not.toContain("Resumed half");
		expect(gatheredText.join(" ")).not.toContain("Third task");
	});

	it("never holds out work that is still in flight", () => {
		// A task with no outcome, or one still being added to, would be scored
		// against work that has not happened.
		const groups = taskGroups(
			buildJournal([
				{ at: 0, source: "agent", task: "done", claims: ["a"] },
				{ at: 9_999, source: "agent", task: "live", claims: ["b"] },
			]).entries,
		);
		const completed = completedGroups(groups, minutes(10_000), 60 * 60 * 1000);
		expect(completed.map((group) => group.tasks[0])).toEqual(["done"]);
	});
});

describe("topics", () => {
	it("routes a claim to the topic that already talks about it", () => {
		const testing: TopicFile = emptyTopic("testing");
		testing.facts.push({
			id: "f-testing-0198f2c2-0a1b-7c2d-8e3f-405162738495",
			claim: "Tests are run with vitest in this repository.",
			validFrom: "2026-08-01",
			source: "user",
			evidence: [],
			cue: "running the test suite",
		});
		const result = run(
			[{ at: 0, source: "user", claims: ["vitest needs --run in CI or it hangs."], cue: "running the test suite" }],
			{
				orientation: orientation({ topics: new Map([["testing", testing]]) }),
			},
		);
		expect(result.jobs.map((job) => job.topic)).toEqual(["testing"]);
		expect(result.jobs[0]?.isNew).toBe(false);
	});

	it("proposes a new topic from the cue, the same way on every host", () => {
		const claim = {
			id: "j-x.1",
			text: "Deploys go out through the release workflow.",
			entry: buildJournal([{ at: 0, source: "user", claims: ["x"], cue: "the deploy pipeline" }]).entries[0] as never,
			reason: "user" as const,
			occurrences: 1,
		};
		expect(newTopicSlug(claim)).toBe("deploy-pipeline");
	});

	it("defers what will not fit in one job rather than losing it", () => {
		// Nothing cites the deferred claims, so the next dream's range still has
		// them; a job that silently truncated would lose them for good.
		const specs: EntrySpec[] = [];
		for (let i = 0; i < MAX_EVIDENCE + 5; i++) {
			specs.push({ at: i, source: "user", claims: [`Distinct user note number ${i}.`], cue: "one topic" });
		}
		const result = run(specs);
		const job = result.jobs[0];
		expect(job?.entries).toHaveLength(MAX_EVIDENCE);
		expect(job?.deferred).toHaveLength(5);
		expect(result.notes.join(" ")).toMatch(/deferred/);
	});
});
