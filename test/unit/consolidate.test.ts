import { describe, expect, it } from "vitest";
import {
	allowedEvidence,
	buildConsolidatePrompt,
	type ConsolidateJob,
	consolidate,
	MAX_FACTS,
	parseFactList,
	shownFacts,
} from "../../src/dream/consolidate.ts";
import type { DreamModel } from "../../src/dream/model.ts";
import { emptyTopic, type Fact, type TopicFile } from "../../src/topics/format.ts";
import { buildJournal, entryIdAt } from "../fixtures/journal-builder.ts";

const NOW = new Date("2026-08-23T09:00:00Z");
const EXISTING = "f-testing-0198e9a5-2d3e-7f40-9152-63748596a7b8";

function topicWithOneFact(): TopicFile {
	const topic = emptyTopic("testing");
	topic.facts.push({
		id: EXISTING,
		claim: "Tests run with pnpm test.",
		validFrom: "2026-08-01",
		source: "agent",
		evidence: ["j-0198e9a4-1c2f-7d33-8e55-aa10b2c3d4e0.1"],
	});
	return topic;
}

function job(overrides: Partial<ConsolidateJob> = {}): ConsolidateJob {
	const entries = buildJournal([
		{
			at: 0,
			source: "user",
			claims: ["Run tests with pnpm test --run, never watch mode."],
			cue: "CI hangs on vitest",
			prose: "Corrected while the CI job hung.",
		},
	]).entries;
	return { topic: "testing", isNew: false, file: topicWithOneFact(), claims: [], entries, ...overrides };
}

const NEW_CLAIM = `${entryIdAt(0, 0)}.1`;

/** A model that replies with whatever the script says, in order. */
function scripted(...replies: string[]): DreamModel & { prompts: string[] } {
	const prompts: string[] = [];
	let index = 0;
	return {
		id: "test/mock",
		prompts,
		async complete(request) {
			prompts.push(request.prompt);
			return replies[Math.min(index++, replies.length - 1)] as string;
		},
	};
}

function block(items: unknown): string {
	return `Reasoning about the topic.\n\n\`\`\`json\n${JSON.stringify(items, null, 2)}\n\`\`\`\n`;
}

const OPTIONS = { now: NOW, sourceOf: () => "user" as const };

describe("the flat schema parser", () => {
	it("takes the last fenced block, not the first", async () => {
		// The prompt asks for reasoning first, and a small model will happily
		// illustrate its reasoning with an example block on the way there.
		const reply = [
			"Here is the shape I will use:",
			"```json",
			'[{"claim": "an example"}]',
			"```",
			"",
			"Now the answer:",
			"```json",
			`[{"claim": "the real one", "evidence": ["${NEW_CLAIM}"]}]`,
			"```",
		].join("\n");
		const parsed = parseFactList(reply);
		expect(parsed.ok && parsed.items).toEqual([{ claim: "the real one", evidence: [NEW_CLAIM] }]);
	});

	it("accepts a bare array with no fence at all", () => {
		expect(parseFactList('[{"id": "f-testing-x"}]').ok).toBe(true);
	});

	it("names what is wrong, so the retry can quote it", () => {
		expect(parseFactList("```json\n{not json\n```")).toMatchObject({ ok: false });
		expect(parseFactList('```json\n{"claim": "x"}\n```')).toMatchObject({
			ok: false,
			problem: expect.stringContaining("array"),
		});
		expect(parseFactList('```json\n[{"cue": "x"}]\n```')).toMatchObject({
			ok: false,
			problem: expect.stringContaining("neither"),
		});
	});

	it("takes a single evidence id written as a string", () => {
		// Small models produce this constantly and it is unambiguous.
		const parsed = parseFactList(`[{"claim": "x", "evidence": "${NEW_CLAIM}"}]`);
		expect(parsed.ok && parsed.items[0]?.evidence).toEqual([NEW_CLAIM]);
	});
});

describe("a job that goes well", () => {
	it("supersedes the old fact and writes the new one", async () => {
		const model = scripted(
			block([
				{
					claim: "Run tests with `pnpm test --run`, never watch mode.",
					evidence: [NEW_CLAIM],
					supersedes: [EXISTING],
					reason: "user correction — watch mode hangs CI",
					cue: "CI hangs on vitest",
				},
			]),
		);
		const outcome = await consolidate(job(), { ...OPTIONS, model });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied.added).toHaveLength(1);
		expect(outcome.applied.superseded[0]?.id).toBe(EXISTING);
		expect(outcome.supersessions[0]?.claim).toBe("j-0198e9a4-1c2f-7d33-8e55-aa10b2c3d4e0.1");
		expect(outcome.retries).toBe(0);
	});

	it("retries once with the parser's own complaint, and succeeds", async () => {
		const model = scripted("no json here at all", block([{ claim: "A fact.", evidence: [NEW_CLAIM] }]));
		const outcome = await consolidate(job(), { ...OPTIONS, model });
		expect(outcome.ok).toBe(true);
		expect(outcome.retries).toBe(1);
		expect(model.prompts[1]).toContain("could not be used");
	});

	it("gives up after one retry rather than pretending", async () => {
		const outcome = await consolidate(job(), { ...OPTIONS, model: scripted("nope", "still nope") });
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.reason).toContain("unparsable after one retry");
	});

	it("reports a model that will not answer, rather than throwing", async () => {
		const model: DreamModel = {
			id: "test/mock",
			complete: async () => {
				throw new Error("connection refused");
			},
		};
		const outcome = await consolidate(job(), { ...OPTIONS, model });
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.reason).toContain("connection refused");
	});
});

describe("a job that goes badly is refused by code, not by hope", () => {
	it("refuses a fact citing an id it was never shown", async () => {
		// A held-out task's claims are not in the prompt and not in the topic, so
		// they are unreachable by construction — this is the same rule, named.
		const outcome = await consolidate(job(), {
			...OPTIONS,
			model: scripted(block([{ claim: "Held out.", evidence: ["j-01a00000-0000-7000-8000-000000000099.1"] }])),
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied.added).toEqual([]);
		expect(outcome.refusals).toEqual([{ claim: "Held out.", rule: "unsourced" }]);
	});

	it("refuses a fact with no evidence at all", async () => {
		const outcome = await consolidate(job(), { ...OPTIONS, model: scripted(block([{ claim: "Just trust me." }])) });
		expect(outcome.ok && outcome.refusals[0]?.rule).toBe("unsourced");
	});

	it("refuses a claim that would carry a secret", async () => {
		const outcome = await consolidate(job(), {
			...OPTIONS,
			model: scripted(block([{ claim: "Deploy with AKIAIOSFODNN7EXAMPLE as the key.", evidence: [NEW_CLAIM] }])),
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied.added).toEqual([]);
		expect(outcome.refusals[0]?.rule).toBe("secret");
		// And the refusal itself does not repeat the secret into the report.
		expect(outcome.refusals[0]?.claim).not.toContain("AKIA");
	});

	it("refuses evidence that is an echo, even when it is a real id", async () => {
		const outcome = await consolidate(job(), {
			...OPTIONS,
			model: scripted(block([{ claim: "An echo.", evidence: [NEW_CLAIM] }])),
			refused: new Set([NEW_CLAIM]),
		});
		expect(outcome.ok && outcome.refusals[0]?.rule).toBe("unsourced");
	});

	it("rejects the whole job when it would leave the topic emptier than it found it", async () => {
		const file = topicWithOneFact();
		for (let i = 0; i < 7; i++) {
			file.facts.push({
				id: `f-testing-0198e9a6-2d3e-7f40-9152-6374859${String(i).padStart(5, "0")}`,
				claim: `And another, ${i}.`,
				validFrom: "2026-08-01",
				source: "agent",
				evidence: [],
			});
		}
		const outcome = await consolidate(job({ file }), {
			...OPTIONS,
			model: scripted(
				block([
					{
						claim: "One fact to replace them all.",
						evidence: [NEW_CLAIM],
						supersedes: [EXISTING, ...file.facts.slice(1, 6).map((fact) => fact.id)],
					},
				]),
			),
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.reason).toContain("over the 25% bound");
		expect(outcome.ok === false && outcome.reason).toContain("3 of 8 facts");
	});

	it("leaves a fact alone when the model only names its id", async () => {
		const outcome = await consolidate(job(), { ...OPTIONS, model: scripted(block([{ id: EXISTING }])) });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied.topic.facts.map((fact) => fact.id)).toEqual([EXISTING]);
		expect(outcome.applied.added).toEqual([]);
	});
});

describe("the prompt", () => {
	it("shows the topic, its facts and the new evidence with citable ids", () => {
		const prompt = buildConsolidatePrompt(job());
		expect(prompt).toContain("# Topic: testing");
		expect(prompt).toContain(`[id: ${EXISTING}`);
		expect(prompt).toContain(`[${NEW_CLAIM}]`);
		expect(prompt).toContain("cue: CI hangs on vitest");
	});

	it("slices a large topic and says the rest is out of scope", () => {
		// Not hidden: a model reading their absence as "this topic is small"
		// would start rewriting it wholesale.
		const file = emptyTopic("testing");
		for (let i = 0; i < MAX_FACTS + 3; i++) {
			file.facts.push({
				id: `f-testing-0198e9a5-2d3e-7f40-9152-6374859${String(i).padStart(5, "0")}`,
				claim: `Fact ${i}.`,
				validFrom: `2026-07-${String((i % 28) + 1).padStart(2, "0")}`,
				source: "agent",
				evidence: [],
			} as Fact);
		}
		expect(shownFacts(file).facts).toHaveLength(MAX_FACTS);
		expect(shownFacts(file).omitted).toBe(3);
		expect(buildConsolidatePrompt(job({ file }))).toContain("out of scope for this job");
	});

	it("allows only what the job actually contains", () => {
		const allowed = allowedEvidence(job());
		expect(allowed.has(NEW_CLAIM)).toBe(true);
		expect(allowed.has("j-0198e9a4-1c2f-7d33-8e55-aa10b2c3d4e0.1")).toBe(true);
		expect(allowed.has("j-01a00000-0000-7000-8000-000000000099.1")).toBe(false);
	});
});
