import { describe, expect, it } from "vitest";
import { buildMemory, GENERATED_MARKER, preambleOf, topicUsage } from "../../src/dream/memory-md.ts";
import { emptyTopic, type Fact, type TopicFile } from "../../src/topics/format.ts";
import type { Usage } from "../../src/topics/use-count.ts";

function topic(slug: string, claim: string, factId = `f-${slug}-0198f2c2-0a1b-7c2d-8e3f-405162738495`): TopicFile {
	const file = emptyTopic(slug);
	file.updated = "2026-08-22";
	file.facts.push({ id: factId, claim, validFrom: "2026-08-22", source: "user", evidence: ["j-x.1"] } as Fact);
	return file;
}

const RULES = ["- R-014 · phase: test · source: user · since: 2026-08-01", "  Run `pnpm test --run`.", ""].join("\n");

describe("MEMORY.md is regenerated, not rewritten", () => {
	it("keeps everything a person wrote above the marker", () => {
		// Phase 1 told people to write this file by hand. The first dream over a
		// real store meets months of somebody's notes.
		const current = ["# Memory", "", "Martin's own notes.", "", "- I prefer short commit messages.", ""].join("\n");
		const result = buildMemory({
			topics: new Map([["testing", topic("testing", "Run tests with --run.")]]),
			rules: "",
			usage: new Map(),
			current,
			budget: 120,
		});
		expect(result.text).toContain("Martin's own notes.");
		expect(result.text).toContain("- I prefer short commit messages.");
		expect(result.text).toContain(GENERATED_MARKER);
		expect(result.text.indexOf("Martin's own notes")).toBeLessThan(result.text.indexOf(GENERATED_MARKER));
	});

	it("replaces only the generated region on the second pass", () => {
		const first = buildMemory({
			topics: new Map([["testing", topic("testing", "Run tests with --run.")]]),
			rules: "",
			usage: new Map(),
			current: "# Memory\n\nHand-written.\n",
			budget: 120,
		});
		const second = buildMemory({
			topics: new Map([["deploy", topic("deploy", "Deploys go through the release workflow.")]]),
			rules: "",
			usage: new Map(),
			current: first.text,
			budget: 120,
		});
		expect(second.text).toContain("Hand-written.");
		expect(second.text).toContain("topics/deploy.md");
		expect(second.text).not.toContain("topics/testing.md");
		expect(preambleOf(second.text)).toContain("Hand-written.");
	});

	it("is byte-stable, so an unchanged store produces no diff", () => {
		const input = {
			topics: new Map([["testing", topic("testing", "Run tests with --run.")]]),
			rules: RULES,
			usage: new Map<string, Usage>(),
			current: "# Memory\n",
			budget: 120,
		};
		const once = buildMemory(input).text;
		expect(buildMemory({ ...input, current: once }).text).toBe(once);
	});

	it("carries the claim, not just the topic name", () => {
		// A bare list of topic names tells a session nothing it could act on.
		const result = buildMemory({
			topics: new Map([["testing", topic("testing", "Run tests with `pnpm test --run`.")]]),
			rules: RULES,
			usage: new Map(),
			current: "",
			budget: 120,
		});
		expect(result.text).toContain("- **Testing** — Run tests with `pnpm test --run`. · topics/testing.md");
		expect(result.text).toContain("- R-014 · test — Run `pnpm test --run`. · rules.md");
	});
});

describe("the budget", () => {
	it("drops the least-used topics and says how many, keeping them searchable", () => {
		const topics = new Map<string, TopicFile>();
		const usage = new Map<string, Usage>();
		for (let i = 0; i < 10; i++) {
			const slug = `topic-${String(i).padStart(2, "0")}`;
			const factId = `f-${slug}-0198f2c2-0a1b-7c2d-8e3f-4051627384${String(i).padStart(2, "0")}`;
			topics.set(slug, topic(slug, `Fact for ${slug}.`, factId));
			usage.set(factId, { count: i, lastUsed: "2026-08-20" });
		}

		const result = buildMemory({ topics, rules: "", usage, current: "# Memory\n", budget: 8 });
		// Most-used first, and the tail is what falls off.
		expect(result.text).toContain("topic-09");
		expect(result.text).not.toContain("topic-00");
		expect(result.dropped).toContain("topic-00");
		expect(result.text).toContain("not listed");
		// The note is a comment, so saying it costs no budget.
		expect(result.lines).toBeLessThanOrEqual(8);
	});

	it("counts what a person wrote against the budget", () => {
		const preamble = ["# Memory", "", ...Array.from({ length: 6 }, (_, i) => `- note ${i}`), ""].join("\n");
		const topics = new Map<string, TopicFile>([
			["a", topic("a", "Fact a.")],
			["b", topic("b", "Fact b.")],
			["c", topic("c", "Fact c.")],
		]);
		const result = buildMemory({ topics, rules: "", usage: new Map(), current: preamble, budget: 8 });
		expect(result.lines).toBeLessThanOrEqual(8);
		expect(result.dropped.length).toBeGreaterThan(0);
	});

	it("keeps rules even when topics have to go", () => {
		// A rule is followed, not merely recalled; dropping one silently changes
		// what the agent does, where dropping a topic line only changes what it
		// is reminded of.
		const topics = new Map<string, TopicFile>([
			["a", topic("a", "Fact a.")],
			["b", topic("b", "Fact b.")],
		]);
		const result = buildMemory({ topics, rules: RULES, usage: new Map(), current: "", budget: 3 });
		expect(result.text).toContain("R-014");
	});

	it("adds a topic's fact usage up into the topic's own", () => {
		const file = topic("testing", "One.", "f-testing-a");
		file.facts.push({
			id: "f-testing-b",
			claim: "Two.",
			validFrom: "2026-08-01",
			source: "user",
			evidence: [],
		} as Fact);
		const totals = topicUsage(
			new Map([["testing", file]]),
			new Map([
				["f-testing-a", { count: 2, lastUsed: "2026-08-20" }],
				["f-testing-b", { count: 3, lastUsed: "2026-08-22" }],
			]),
		);
		expect(totals.get("testing")).toEqual({ count: 5, lastUsed: "2026-08-22" });
	});
});
