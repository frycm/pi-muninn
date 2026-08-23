import { describe, expect, it } from "vitest";
import { buildMergePrompt, type MergeJob, mergeDream, mergeTopic } from "../../src/dream/merge.ts";
import type { DreamModel } from "../../src/dream/model.ts";
import { emptyTopic, type Fact, type TopicFile } from "../../src/topics/format.ts";
import { buildJournal, entryIdAt } from "../fixtures/journal-builder.ts";

const BASE_FACT = "f-testing-0198a000-0000-7000-8000-000000000001";
const OURS_FACT = "f-testing-0198b000-0000-7000-8000-000000000002";
const THEIRS_FACT = "f-testing-0198c000-0000-7000-8000-000000000003";
const CLAIM_A = "j-0198e9a4-1c2f-7d33-8e55-aa10b2c3d4e0.1";
const CLAIM_B = "j-0198e9a4-1c2f-7d33-8e55-aa10b2c3d4e0.2";
const CLAIM_C = "j-0198e9a4-1c2f-7d33-8e55-aa10b2c3d4e0.3";

function fact(id: string, claim: string, extra: Partial<Fact> = {}): Fact {
	return { id, claim, validFrom: "2026-08-01", source: "user", evidence: [CLAIM_A], ...extra };
}

function topic(facts: Fact[], superseded: Fact[] = []): TopicFile {
	const file = emptyTopic("testing");
	file.facts.push(...facts);
	file.superseded.push(...superseded);
	return file;
}

describe("layer 1: the merge unit is a fact, not a line", () => {
	it("keeps a fact each side added", () => {
		// Genuinely disjoint: the base fact has its own evidence too, or it would
		// be a residue against both additions — correctly, since a new fact
		// citing what an existing one cites is exactly a pair worth judging.
		const base = topic([fact(BASE_FACT, "Shared history.", { evidence: [CLAIM_C] })]);
		const result = mergeTopic({
			base,
			ours: topic([
				fact(BASE_FACT, "Shared history.", { evidence: [CLAIM_C] }),
				fact(OURS_FACT, "We learned A.", { evidence: [CLAIM_A] }),
			]),
			theirs: topic([
				fact(BASE_FACT, "Shared history.", { evidence: [CLAIM_C] }),
				fact(THEIRS_FACT, "They learned B.", { evidence: [CLAIM_B] }),
			]),
		});
		expect(result.topic.facts.map((f) => f.id).sort()).toEqual([BASE_FACT, OURS_FACT, THEIRS_FACT].sort());
		expect(result.fromOurs).toEqual([OURS_FACT]);
		expect(result.fromTheirs).toEqual([THEIRS_FACT]);
		// Disjoint additions are not a conflict, which is why most cross-host
		// merges need no model at all.
		expect(result.residue).toEqual([]);
	});

	it("supersedes a fact one side retired and the other left alone", () => {
		const base = topic([fact(BASE_FACT, "Old truth.")]);
		const retired = fact(BASE_FACT, "Old truth.", {
			validTo: "2026-08-20",
			supersededBy: OURS_FACT,
			reason: "corrected",
		});
		const result = mergeTopic({
			base,
			ours: topic([fact(OURS_FACT, "New truth.")], [retired]),
			theirs: base,
		});
		expect(result.topic.facts.map((f) => f.id)).toEqual([OURS_FACT]);
		expect(result.topic.superseded.map((f) => f.id)).toEqual([BASE_FACT]);
	});

	it("keeps the earlier valid_to and both reasons when both sides retired it", () => {
		const base = topic([fact(BASE_FACT, "Old truth.")]);
		const result = mergeTopic({
			base,
			ours: topic(
				[],
				[fact(BASE_FACT, "Old truth.", { validTo: "2026-08-22", supersededBy: OURS_FACT, reason: "ours" })],
			),
			theirs: topic(
				[],
				[fact(BASE_FACT, "Old truth.", { validTo: "2026-08-20", supersededBy: THEIRS_FACT, reason: "theirs" })],
			),
		});
		const retired = result.topic.superseded[0];
		expect(retired?.validTo).toBe("2026-08-20");
		expect(retired?.supersededBy).toBe(`${THEIRS_FACT}, ${OURS_FACT}`);
		expect(retired?.reason).toBe("theirs; ours");
	});

	it("keeps a fact somebody deleted by hand, because a dream never deletes one", () => {
		const base = topic([fact(BASE_FACT, "Still true.")]);
		const result = mergeTopic({ base, ours: topic([]), theirs: base });
		expect(result.topic.facts.map((f) => f.id)).toEqual([BASE_FACT]);
		expect(result.notes.join(" ")).toContain("missing on one side");
	});

	it("produces the same bytes whichever side runs it", () => {
		const base = topic([fact(BASE_FACT, "Shared.")]);
		const ours = topic([fact(BASE_FACT, "Shared."), fact(OURS_FACT, "A.")]);
		const theirs = topic([fact(BASE_FACT, "Shared."), fact(THEIRS_FACT, "B.")]);
		const forward = mergeTopic({ base, ours, theirs }).topic.facts.map((f) => f.id);
		const backward = mergeTopic({ base, ours: theirs, theirs: ours }).topic.facts.map((f) => f.id);
		expect(forward).toEqual(backward);
	});
});

describe("layer 2: what is left over is named, not merged", () => {
	it("finds facts that share evidence", () => {
		const base = topic([]);
		const result = mergeTopic({
			base,
			ours: topic([fact(OURS_FACT, "Tests need --run.")]),
			theirs: topic([fact(THEIRS_FACT, "Watch mode hangs CI.")]),
		});
		expect(result.residue).toHaveLength(1);
		expect(result.residue[0]?.why).toBe("shared-evidence");
	});

	it("finds facts answering the same cue", () => {
		const result = mergeTopic({
			base: topic([]),
			ours: topic([fact(OURS_FACT, "Alpha.", { evidence: [CLAIM_A], cue: "running the tests" })]),
			theirs: topic([fact(THEIRS_FACT, "Beta.", { evidence: [CLAIM_B], cue: "running the tests" })]),
		});
		expect(result.residue[0]?.why).toBe("same-cue");
	});

	it("leaves unrelated facts out of the residue", () => {
		const result = mergeTopic({
			base: topic([]),
			ours: topic([fact(OURS_FACT, "Tests need --run.", { evidence: [CLAIM_A] })]),
			theirs: topic([fact(THEIRS_FACT, "Deploys go through the release workflow.", { evidence: [CLAIM_B] })]),
		});
		expect(result.residue).toEqual([]);
	});

	it("pairs a new fact against one the topic already had", () => {
		// The design's residue is "one per side, *or* one new and one existing" —
		// and the second is the common case: a host adds something that
		// contradicts what the topic already said.
		const existing = fact(BASE_FACT, "Tests are run with pnpm test", { evidence: [CLAIM_C] });
		const result = mergeTopic({
			base: topic([existing]),
			ours: topic([existing, fact(OURS_FACT, "Tests are run with pnpm test --run", { evidence: [CLAIM_A] })]),
			theirs: topic([existing]),
		});
		expect(result.residue).toHaveLength(1);
		expect(result.residue[0]?.ours.id).toBe(OURS_FACT);
		expect(result.residue[0]?.theirs.id).toBe(BASE_FACT);
		expect(result.residue[0]?.why).toBe("overlap");
	});

	it("produces the same residue whichever side runs it", () => {
		const existing = fact(BASE_FACT, "Tests are run with pnpm test", { evidence: [CLAIM_C] });
		const ours = topic([existing, fact(OURS_FACT, "Tests are run with pnpm test --run", { evidence: [CLAIM_A] })]);
		const theirs = topic([existing]);
		const forward = mergeTopic({ base: topic([existing]), ours, theirs });
		const backward = mergeTopic({ base: topic([existing]), ours: theirs, theirs: ours });
		expect(backward.residue.map((pair) => [pair.ours.id, pair.theirs.id].sort())).toEqual(
			forward.residue.map((pair) => [pair.ours.id, pair.theirs.id].sort()),
		);
	});
});

describe("layer 3: the merge dream", () => {
	const entries = buildJournal([
		{ at: 0, source: "user", claims: ["Tests need --run."], cue: "running the tests" },
		{ at: 10, source: "user", claims: ["Watch mode hangs CI."], cue: "running the tests" },
	]).entries;
	const ids = [`${entryIdAt(0, 0)}.1`, `${entryIdAt(10, 1)}.1`];

	function job(): MergeJob {
		const merged = topic([
			fact(OURS_FACT, "Tests need --run.", { evidence: [ids[0] as string] }),
			fact(THEIRS_FACT, "Watch mode hangs CI.", { evidence: [ids[1] as string] }),
		]);
		return {
			topic: "testing",
			merged,
			base: topic([]),
			residue: [{ ours: merged.facts[0] as Fact, theirs: merged.facts[1] as Fact, why: "overlap" }],
			entries,
		};
	}

	function scripted(reply: string): DreamModel {
		return { id: "test/mock", complete: async () => reply };
	}

	const OPTIONS = { now: new Date("2026-08-23T09:00:00Z"), sourceOf: () => "user" as const };

	it("shows both sides and the evidence behind them", () => {
		const prompt = buildMergePrompt(job());
		expect(prompt).toContain("A: Tests need --run.");
		expect(prompt).toContain("B: Watch mode hangs CI.");
		expect(prompt).toContain(`[${ids[0]}]`);
		expect(prompt).toContain("(overlap)");
	});

	it("settles a residue into one fact citing both sides", async () => {
		const reply = `\`\`\`json\n${JSON.stringify([
			{
				claim: "Run tests with --run; watch mode hangs CI.",
				evidence: ids,
				supersedes: [OURS_FACT, THEIRS_FACT],
				reason: "one fact, both observations",
			},
		])}\n\`\`\``;
		const { outcome, dropped } = await mergeDream(job(), { ...OPTIONS, model: scripted(reply) });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied.topic.facts).toHaveLength(1);
		expect(outcome.applied.topic.facts[0]?.evidence).toEqual(ids);
		expect(dropped).toEqual([]);
	});

	it("cannot lose a fact from either side, and proves it", async () => {
		// The merge's own extra rule. It turns out to hold by construction —
		// `applyFactList` keeps a fact the job did not mention — so a merge that
		// answers about only one side leaves the other standing rather than
		// dropping it. The check stays because that invariant is worth asserting
		// rather than assuming.
		const reply = `\`\`\`json\n${JSON.stringify([{ id: OURS_FACT }])}\n\`\`\``;
		const { outcome, dropped } = await mergeDream(job(), { ...OPTIONS, model: scripted(reply) });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied.topic.facts.map((fact) => fact.id).sort()).toEqual([OURS_FACT, THEIRS_FACT].sort());
		expect(dropped).toEqual([]);
	});

	it("refuses invented evidence exactly as a plain consolidation would", async () => {
		// A merge that could cite ids a consolidation could not would be a hole
		// shaped like the hardest prompt in the system.
		const reply = `\`\`\`json\n${JSON.stringify([
			{ claim: "From nowhere.", evidence: ["j-01a00000-0000-7000-8000-000000000099.1"] },
		])}\n\`\`\``;
		const { outcome } = await mergeDream(job(), { ...OPTIONS, model: scripted(reply) });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.applied.added).toEqual([]);
		expect(outcome.refusals[0]?.rule).toBe("unsourced");
	});
});
