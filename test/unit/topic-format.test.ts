import { describe, expect, it } from "vitest";
import {
	allFacts,
	emptyTopic,
	type Fact,
	formatFactLine,
	formatTopic,
	parseFactLine,
	parseTopic,
	sanitiseClaim,
	titleFromSlug,
} from "../../src/topics/format.ts";

const FACT = "f-testing-0198f2c2-0a1b-7c2d-8e3f-405162738495";
const OLD_FACT = "f-testing-0198e9a5-2d3e-7f40-9152-63748596a7b8";
const CLAIM = "j-0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01.1";
const OLD_CLAIM = "j-0198e9a4-1c2f-7d33-8e55-aa10b2c3d4e0.1";

const SAMPLE = `---
topic: testing
updated: 2026-08-22
---

# Testing

How this project is tested.

## Facts

- **Run tests with \`pnpm test --run\`, never watch mode.** id: ${FACT} · valid_from: 2026-08-22 · source: user · evidence: ${CLAIM} · cue: CI hangs on vitest

## Superseded

- ~~Tests run with \`pnpm test\`.~~ id: ${OLD_FACT} · valid_from: 2026-08-01 · source: agent · evidence: ${OLD_CLAIM} · valid_to: 2026-08-22 · superseded_by: ${FACT} · reason: user correction — watch mode hangs CI
`;

describe("the topic grammar", () => {
	it("reads the design's own example", () => {
		const topic = parseTopic(SAMPLE, "testing");
		expect(topic.problems).toEqual([]);
		expect(topic.topic).toBe("testing");
		expect(topic.updated).toBe("2026-08-22");
		expect(topic.title).toBe("Testing");
		expect(topic.prose).toBe("How this project is tested.");

		expect(topic.facts).toHaveLength(1);
		const fact = topic.facts[0] as Fact;
		expect(fact.id).toBe(FACT);
		expect(fact.claim).toBe("Run tests with `pnpm test --run`, never watch mode.");
		expect(fact.source).toBe("user");
		expect(fact.evidence).toEqual([CLAIM]);
		expect(fact.cue).toBe("CI hangs on vitest");

		const retired = topic.superseded[0] as Fact;
		// The audit row: the id it always had, the evidence it always cited, and
		// three fields saying when and why it stopped being true.
		expect(retired.id).toBe(OLD_FACT);
		expect(retired.evidence).toEqual([OLD_CLAIM]);
		expect(retired.validFrom).toBe("2026-08-01");
		expect(retired.validTo).toBe("2026-08-22");
		expect(retired.supersededBy).toBe(FACT);
		expect(retired.reason).toBe("user correction — watch mode hangs CI");
	});

	it("round-trips: parse ∘ format = identity", () => {
		const once = formatTopic(parseTopic(SAMPLE, "testing"));
		const twice = formatTopic(parseTopic(once, "testing"));
		expect(twice).toBe(once);
		// And the sample itself is already in the canonical form the writer emits,
		// so the documented example and the code cannot drift.
		expect(once).toBe(SAMPLE);
	});

	it("keeps trailer fields it does not know", () => {
		const line = `- **A claim.** id: ${FACT} · valid_from: 2026-08-22 · source: agent · evidence: ${CLAIM} · confidence: 0.7`;
		const fact = parseFactLine(line) as Fact;
		expect(fact.extra).toEqual({ confidence: "0.7" });
		expect(formatFactLine(fact, "facts")).toContain("confidence: 0.7");
	});

	it("keeps a bullet it cannot read rather than deleting it", () => {
		const text = `# Testing\n\n## Facts\n\n- somebody's hand-written note\n`;
		const topic = parseTopic(text, "testing");
		expect(topic.facts).toEqual([]);
		expect(topic.stray).toEqual([{ section: "facts", text: "- somebody's hand-written note" }]);
		expect(formatTopic(topic)).toContain("- somebody's hand-written note");
	});

	it("does not read a fact out of a fenced block", () => {
		const text = [
			"# Testing",
			"",
			"## Facts",
			"",
			"```markdown",
			`- **Not a fact, an example.** id: ${FACT} · valid_from: 2026-08-22 · source: user · evidence: ${CLAIM}`,
			"```",
			"",
		].join("\n");
		expect(parseTopic(text, "testing").facts).toEqual([]);
	});

	it("quarantines external facts in their own section", () => {
		const topic = emptyTopic("deploy");
		topic.external.push({
			id: "f-deploy-0198f2c2-0a1b-7c2d-8e3f-405162738495",
			claim: "The vendor's docs say the deploy hook retries three times.",
			validFrom: "2026-08-22",
			source: "external",
			evidence: [CLAIM],
		});
		const written = formatTopic(topic);
		expect(written).toContain("## External");
		expect(parseTopic(written, "deploy").external).toHaveLength(1);
		expect(parseTopic(written, "deploy").facts).toEqual([]);
	});

	it("bends a claim that would split its own line", () => {
		// ` · ` separates trailer fields and ` id: ` starts the trailer; a claim
		// carrying either would be read back as something else entirely.
		expect(sanitiseClaim("a · b")).toBe("a - b");
		expect(sanitiseClaim("the id: field")).toBe("the id- field");
		expect(sanitiseClaim("two\nlines")).toBe("two lines");

		const fact: Fact = {
			id: FACT,
			claim: "Set the id: field · carefully",
			validFrom: "2026-08-22",
			source: "user",
			evidence: [CLAIM],
		};
		const read = parseFactLine(formatFactLine(fact, "facts")) as Fact;
		expect(read.id).toBe(FACT);
		expect(read.evidence).toEqual([CLAIM]);
		expect(read.claim).toBe("Set the id- field - carefully");
	});

	it("refuses a bullet whose id is not a fact id", () => {
		expect(parseFactLine(`- **A claim.** id: ${CLAIM} · source: user`)).toBeUndefined();
		expect(parseFactLine("- **A claim.** id: nonsense")).toBeUndefined();
		expect(parseFactLine("just a line")).toBeUndefined();
	});

	it("names a topic from its slug", () => {
		expect(titleFromSlug("deploy-pipeline")).toBe("Deploy pipeline");
		expect(allFacts(parseTopic(SAMPLE, "testing"))).toHaveLength(2);
	});
});
