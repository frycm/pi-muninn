import { describe, expect, it } from "vitest";
import { CONTRADICTION_THRESHOLD, type LintInput, lint } from "../../src/dream/lint.ts";
import { emptyTopic, type Fact, type TopicFile } from "../../src/topics/format.ts";
import { activeRules, parseRules } from "../../src/topics/rules.ts";

const CLAIM_A = "j-0198e9a4-1c2f-7d33-8e55-aa10b2c3d4e0.1";
const CLAIM_B = "j-0198e9a4-1c2f-7d33-8e55-aa10b2c3d4e0.2";
const ENTRY_A = "j-0198e9a4-1c2f-7d33-8e55-aa10b2c3d4e0";
const FACT = "f-testing-0198f2c2-0a1b-7c2d-8e3f-405162738495";

function fact(overrides: Partial<Fact> = {}): Fact {
	return {
		id: FACT,
		claim: "Run tests with pnpm test --run",
		validFrom: "2026-08-22",
		source: "user",
		evidence: [CLAIM_A],
		...overrides,
	};
}

function topicWith(...facts: Fact[]): Map<string, TopicFile> {
	const topic = emptyTopic("testing");
	topic.facts.push(...facts);
	return new Map([["testing", topic]]);
}

function input(overrides: Partial<LintInput> = {}): LintInput {
	return {
		topics: topicWith(fact()),
		claims: new Set([CLAIM_A, CLAIM_B]),
		superseded: new Set(),
		erased: new Set(),
		echoes: new Set(),
		rules: "",
		memory: "",
		usage: new Map(),
		rulesCap: 60,
		retireAfterDays: 90,
		now: new Date("2026-08-23T00:00:00Z"),
		...overrides,
	};
}

function rules(result: ReturnType<typeof lint>, rule: string) {
	return result.findings.filter((finding) => finding.rule === rule);
}

describe("a fact must be traceable to live evidence", () => {
	it("passes a fact that cites a claim which exists and is current", () => {
		const result = lint(input());
		expect(result.blocking).toBe(0);
	});

	it("blocks a fact citing nothing", () => {
		const result = lint(input({ topics: topicWith(fact({ evidence: [] })) }));
		expect(rules(result, "unsourced")[0]?.blocking).toBe(true);
	});

	it("blocks a fact citing an id that does not exist", () => {
		const result = lint(input({ topics: topicWith(fact({ evidence: ["j-01a00000-0000-7000-8000-000000000099.1"] })) }));
		expect(rules(result, "unsourced")[0]?.blocking).toBe(true);
	});

	it("blocks a fact whose evidence is all superseded, but only when all of it is", () => {
		const stale = lint(input({ superseded: new Set([CLAIM_A]) }));
		expect(rules(stale, "stale-evidence")[0]?.blocking).toBe(true);

		const partly = lint(
			input({ topics: topicWith(fact({ evidence: [CLAIM_A, CLAIM_B] })), superseded: new Set([CLAIM_A]) }),
		);
		expect(partly.blocking).toBe(0);
	});

	it("blocks a fact whose evidence was erased", () => {
		// The claim id is not the entry id; erasure is recorded per entry.
		const result = lint(input({ erased: new Set([ENTRY_A]) }));
		expect(rules(result, "stale-evidence")[0]?.blocking).toBe(true);
	});

	it("blocks a fact that rests only on the model agreeing with itself", () => {
		const result = lint(input({ echoes: new Set([CLAIM_A]) }));
		expect(rules(result, "echo-only")[0]?.blocking).toBe(true);
	});

	it("blocks a derived file that would carry a secret, without quoting it", () => {
		const result = lint(input({ topics: topicWith(fact({ claim: "The key is AKIAIOSFODNN7EXAMPLE." })) }));
		const finding = rules(result, "secret")[0];
		expect(finding?.blocking).toBe(true);
		expect(finding?.message).not.toContain("AKIA");
	});

	it("notes a supersession pointing at a fact that is not there", () => {
		const topic = emptyTopic("testing");
		topic.superseded.push(
			fact({ validTo: "2026-08-22", supersededBy: "f-testing-0198aaaa-0a1b-7c2d-8e3f-405162738495" }),
		);
		const result = lint(input({ topics: new Map([["testing", topic]]) }));
		expect(rules(result, "dangling-supersession")).toHaveLength(1);
		expect(result.blocking).toBe(0);
	});
});

describe("contradictions are found by code and judged by somebody else", () => {
	it("offers overlapping facts as candidates rather than calling them contradictions", () => {
		// "with --run" and "with --run in CI" overlap heavily and agree. That is
		// exactly why this is a candidate and not a finding.
		const result = lint(
			input({
				topics: topicWith(
					fact(),
					fact({ id: "f-testing-0198f2c3-0a1b-7c2d-8e3f-405162738495", claim: "Run tests with pnpm test --run in CI" }),
				),
			}),
		);
		expect(result.candidates).toHaveLength(1);
		expect(result.blocking).toBe(0);
	});

	it("leaves unrelated facts alone", () => {
		const result = lint(
			input({
				topics: topicWith(
					fact(),
					fact({
						id: "f-testing-0198f2c3-0a1b-7c2d-8e3f-405162738495",
						claim: "The deploy hook lives in the release workflow.",
					}),
				),
			}),
		);
		expect(result.candidates).toEqual([]);
		expect(CONTRADICTION_THRESHOLD).toBeGreaterThan(0);
	});
});

describe("rules are read, checked and reported on", () => {
	const RULES = [
		"# Rules",
		"",
		"- R-014 · phase: test · scope: project · source: user · since: 2026-01-02",
		"  Run `pnpm test --run`; never start watch mode in a non-interactive session.",
		"",
		"- R-015 · phase: ops · scope: global · source: user · since: 2026-08-20",
		"  Deploys go out through the release workflow.",
		"",
		"## Retired",
		"",
		"- R-001 · reason: superseded by R-014 · since: 2025-01-01",
		"  The old way.",
		"",
	].join("\n");

	it("reads the grammar, retired section included", () => {
		const parsed = parseRules(RULES);
		expect(parsed.rules).toHaveLength(3);
		expect(activeRules(parsed).map((rule) => rule.id)).toEqual(["R-014", "R-015"]);
		expect(activeRules(parsed)[0]?.scope).toBe("project");
		expect(activeRules(parsed)[0]?.text).toContain("never start watch mode");
		expect(parsed.rules[2]?.retired).toBe(true);
	});

	it("does not end a rule at a comment inside its own fenced block", () => {
		const parsed = parseRules(
			["- R-020 · source: user", "  Run this:", "  ```bash", "  # not a heading", "  make test", "  ```", ""].join(
				"\n",
			),
		);
		expect(parsed.rules).toHaveLength(1);
		expect(parsed.rules[0]?.text).toContain("make test");
	});

	it("blocks when the cap is exceeded, because a cap that does not bite is not a cap", () => {
		const result = lint(input({ rules: RULES, rulesCap: 1 }));
		expect(rules(result, "rules-cap")[0]?.blocking).toBe(true);
	});

	it("proposes retiring a rule nothing has used", () => {
		const result = lint(input({ rules: RULES }));
		const unused = rules(result, "unused-rule");
		expect(unused.map((finding) => finding.message.slice(0, 5))).toEqual(["R-014"]);
		expect(unused[0]?.blocking).toBe(false);
	});

	it("counts a rule as used when the journal says a session used it", () => {
		const result = lint(input({ rules: RULES, usage: new Map([["R-014", { count: 3, lastUsed: "2026-08-22" }]]) }));
		expect(rules(result, "unused-rule")).toEqual([]);
	});

	it("surfaces a project rule that overlaps a global one, and does not resolve it", () => {
		const result = lint(
			input({
				rules: ["- R-014 · scope: project · source: user", "  Run `pnpm test --run`; never start watch mode.", ""].join(
					"\n",
				),
				globalRules: [
					"- R-002 · scope: global · source: user",
					"  Run `pnpm test --run`; never start watch mode here.",
					"",
				].join("\n"),
			}),
		);
		const finding = rules(result, "project-vs-global-rule")[0];
		expect(finding?.blocking).toBe(false);
		expect(finding?.message).toContain("cannot override");
	});
});

describe("MEMORY.md", () => {
	it("names lines pointing at things that are not there", () => {
		const result = lint(
			input({
				memory: [
					`- **Testing** — run with --run · topics/testing.md · ${FACT}`,
					"- **Deploy** — topics/deploy.md",
					"- **Ghost** — f-ghost-0198f2c2-0a1b-7c2d-8e3f-405162738495",
				].join("\n"),
			}),
		);
		const orphans = rules(result, "orphan").map((finding) => finding.message);
		expect(orphans).toHaveLength(2);
		expect(orphans.join(" ")).toContain("topics/deploy.md");
		expect(orphans.join(" ")).toContain("f-ghost");
	});
});
