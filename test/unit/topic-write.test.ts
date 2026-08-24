import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isFactId, newHostId } from "../../src/ids.ts";
import { StoreIndex } from "../../src/index/build.ts";
import { resetSupersessionCache, search } from "../../src/index/search.ts";
import { appendSupersessions, readSupersessions } from "../../src/journal/supersessions.ts";
import { type Fact, formatTopic, parseTopic } from "../../src/topics/format.ts";
import { useCounts } from "../../src/topics/use-count.ts";
import { applyFactList, MAX_LOSS_RATIO, withinLossBound } from "../../src/topics/write.ts";

const NOW = new Date("2026-08-23T09:00:00Z");
const OLD_FACT = "f-testing-0198e9a5-2d3e-7f40-9152-63748596a7b8";
const OLD_CLAIM_A = "j-0198e9a4-1c2f-7d33-8e55-aa10b2c3d4e0.1";
const OLD_CLAIM_B = "j-0198e9a4-1c2f-7d33-8e55-aa10b2c3d4e0.2";
const NEW_CLAIM = "j-0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01.1";

function topicWithOneFact() {
	const topic = parseTopic("# Testing\n", "testing");
	topic.facts.push({
		id: OLD_FACT,
		claim: "Tests run with `pnpm test`.",
		validFrom: "2026-08-01",
		source: "agent",
		evidence: [OLD_CLAIM_A],
	});
	return topic;
}

const SOURCES: Record<string, Fact["source"]> = {
	[OLD_CLAIM_A]: "agent",
	[OLD_CLAIM_B]: "agent",
	[NEW_CLAIM]: "user",
};

const OPTIONS = { now: NOW, sourceOf: (id: string) => SOURCES[id] };

describe("applying a fact list", () => {
	it("moves a superseded fact instead of deleting it, and keeps its audit row", () => {
		const result = applyFactList(
			topicWithOneFact(),
			[
				{
					claim: "Run tests with `pnpm test --run`, never watch mode.",
					evidence: [NEW_CLAIM],
					supersedes: [OLD_FACT],
					reason: "user correction — watch mode hangs CI",
					cue: "CI hangs on vitest",
				},
			],
			OPTIONS,
		);

		expect(result.topic.facts).toHaveLength(1);
		const added = result.topic.facts[0] as Fact;
		expect(isFactId(added.id)).toBe(true);
		expect(added.id).not.toBe(OLD_FACT);
		expect(added.validFrom).toBe("2026-08-23");
		// The source is the class the fact rests on, not the model's opinion.
		expect(added.source).toBe("user");

		const retired = result.topic.superseded[0] as Fact;
		expect(retired.id).toBe(OLD_FACT);
		expect(retired.evidence).toEqual([OLD_CLAIM_A]);
		expect(retired.validFrom).toBe("2026-08-01");
		expect(retired.validTo).toBe("2026-08-23");
		expect(retired.supersededBy).toBe(added.id);
		expect(retired.reason).toBe("user correction — watch mode hangs CI");

		// One row per invalidated claim, naming the claim that overtook it.
		expect(result.supersessions).toEqual([
			{ claim: OLD_CLAIM_A, validTo: "2026-08-23", fact: OLD_FACT, by: NEW_CLAIM },
		]);
	});

	it("leaves a fact the job did not mention exactly where it was", () => {
		// A job sees a bounded slice of a topic. Silence about a fact means "not
		// considered", and treating it as "drop it" would lose memory every time
		// a topic grew past one job's bound.
		const result = applyFactList(topicWithOneFact(), [{ claim: "Something new.", evidence: [NEW_CLAIM] }], OPTIONS);
		expect(result.topic.facts.map((fact) => fact.id)).toContain(OLD_FACT);
		expect(result.superseded).toEqual([]);
		expect(result.lossRatio).toBe(0);
	});

	it("measures how much of a topic a job would retire", () => {
		const topic = topicWithOneFact();
		topic.facts.push({
			id: "f-testing-0198e9a6-2d3e-7f40-9152-63748596a7b9",
			claim: "Another.",
			validFrom: "2026-08-01",
			source: "agent",
			evidence: [OLD_CLAIM_B],
		});
		const result = applyFactList(
			topic,
			[{ claim: "Replaces both.", evidence: [NEW_CLAIM], supersedes: [OLD_FACT, topic.facts[1]?.id as string] }],
			OPTIONS,
		);
		expect(result.lossRatio).toBe(1);
		expect(result.lossRatio).toBeGreaterThan(MAX_LOSS_RATIO);
	});

	it("bounds net loss, not supersessions", () => {
		// A pure ratio would forbid the correction the mechanism exists for: a
		// topic with three facts could never have one replaced. And counting
		// supersessions rather than net loss would forbid merging two facts into
		// one better one, which is consolidation working.
		expect(withinLossBound(1, 1)).toBe(true); // replaced one with one
		expect(withinLossBound(2, 1)).toBe(true); // merged two into one
		expect(withinLossBound(1, 0)).toBe(true); // the floor: one fact may go
		expect(withinLossBound(3, 1)).toBe(false); // three down to one is a wipe
		expect(withinLossBound(20, 15)).toBe(true);
		expect(withinLossBound(20, 14)).toBe(false);
	});

	it("reports a supersedes that names a fact the topic does not have", () => {
		const result = applyFactList(
			topicWithOneFact(),
			[{ claim: "New.", evidence: [NEW_CLAIM], supersedes: ["f-testing-0198aaaa-2d3e-7f40-9152-63748596a7b8"] }],
			OPTIONS,
		);
		expect(result.unknownSupersedes).toHaveLength(1);
		expect(result.superseded).toEqual([]);
	});

	it("quarantines a fact that rests only on external evidence", () => {
		const external = "j-0198f2c9-7b3e-7a10-9c44-2d6e0f1a8b01.1";
		const result = applyFactList(
			parseTopic("# Deploy\n", "deploy"),
			[{ claim: "Vendor docs say so.", evidence: [external] }],
			{
				now: NOW,
				sourceOf: (id) => (id === external ? "external" : undefined),
			},
		);
		expect(result.topic.facts).toEqual([]);
		expect(result.topic.external).toHaveLength(1);
		expect(formatTopic(result.topic)).toContain("## External");
	});

	it("makes a relative date absolute against the evidence it came from", () => {
		const result = applyFactList(
			parseTopic("# Testing\n", "testing"),
			[{ claim: "The CI runner lost its cache yesterday.", evidence: [NEW_CLAIM] }],
			{ ...OPTIONS, dateOf: (id) => (id === NEW_CLAIM ? "2026-08-22" : undefined) },
		);
		expect((result.topic.facts[0] as Fact).claim).toBe("The CI runner lost its cache on 2026-08-22.");
	});

	it("produces no diff when a dream consolidates nothing", () => {
		// Byte-identical, `updated:` included: a dream that considered a topic and
		// changed nothing must leave no diff at all, or every dream dirties every
		// topic it looked at and `git log -p` fills with date churn.
		const before = formatTopic(topicWithOneFact());
		const result = applyFactList(parseTopic(before, "testing"), [{ id: OLD_FACT }], OPTIONS);
		expect(formatTopic(result.topic)).toBe(before);
	});
});

describe("the supersession writer", () => {
	let store: string;

	beforeEach(() => {
		store = mkdtempSync(join(tmpdir(), "muninn-supersede-"));
		resetSupersessionCache();
	});

	afterEach(() => rmSync(store, { recursive: true, force: true }));

	it("appends, and never appends the same claim twice", () => {
		const rows = [
			{ claim: OLD_CLAIM_A, validTo: "2026-08-23", fact: OLD_FACT },
			{ claim: OLD_CLAIM_B, validTo: "2026-08-23", fact: OLD_FACT },
		];
		expect(appendSupersessions(store, rows)).toHaveLength(2);
		// A claim can be cited by two facts; a dream retiring both must not write
		// it twice, and a re-run after a failure must be able to repeat its work.
		expect(appendSupersessions(store, rows)).toEqual([]);
		expect(readSupersessions(store).superseded.size).toBe(2);
		expect(
			readFileSync(join(store, "supersessions.md"), "utf-8")
				.split("\n")
				.filter((l) => l.startsWith("- ")),
		).toHaveLength(2);
	});

	it("refuses a row whose key is not a claim id", () => {
		// The key is a claim, never an entry: one entry supports several
		// independent facts, and superseding one must not hide the others.
		expect(appendSupersessions(store, [{ claim: "j-0198e9a4-1c2f-7d33-8e55-aa10b2c3d4e0" }])).toEqual([]);
	});

	it("takes a superseded fact's evidence out of ordinary search but not out of memory", () => {
		// The README's second acceptance criterion, end to end over a real index.
		const host = newHostId();
		mkdirSync(join(store, "journal", host), { recursive: true });
		writeFileSync(
			join(store, "journal", host, "2026-08-01.md"),
			[
				"## 10:00 · j-0198e9a4-1c2f-7d33-8e55-aa10b2c3d4e0",
				"source: agent",
				"",
				"Context.",
				"",
				"- Tests run with pnpm test in watch mode.",
				"",
				"",
			].join("\n"),
		);

		const before = search([{ scope: "global", storePath: store, index: StoreIndex.open(store).index }], {
			query: "watch mode",
		});
		expect(before.map((hit) => hit.id)).toContain(OLD_CLAIM_A);

		appendSupersessions(store, [{ claim: OLD_CLAIM_A, validTo: "2026-08-23", fact: OLD_FACT, by: NEW_CLAIM }]);
		resetSupersessionCache();

		const scope = { scope: "global" as const, storePath: store, index: StoreIndex.open(store).index };
		expect(search([scope], { query: "watch mode" }).map((hit) => hit.id)).not.toContain(OLD_CLAIM_A);
		// Still there for "what did I believe in July".
		expect(search([scope], { query: "watch mode", history: true }).map((hit) => hit.id)).toContain(OLD_CLAIM_A);
	});
});

describe("use counts", () => {
	it("tallies used ids and remembers when each was last useful", () => {
		const counts = useCounts([
			{
				entry: { id: "j-1", time: "10:00", source: "agent", prose: "", claims: [], used: ["f-a", "f-b"] },
				date: "2026-08-20",
			},
			{
				entry: { id: "j-2", time: "11:00", source: "agent", prose: "", claims: [], used: ["f-a"] },
				date: "2026-08-22",
			},
			{ entry: { id: "j-3", time: "12:00", source: "agent", prose: "", claims: [] }, date: "2026-08-23" },
		]);
		expect(counts.get("f-a")).toEqual({ count: 2, lastUsed: "2026-08-22" });
		expect(counts.get("f-b")).toEqual({ count: 1, lastUsed: "2026-08-20" });
		expect(counts.has("f-c")).toBe(false);
	});
});
