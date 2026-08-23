import { describe, expect, it } from "vitest";
import type { SearchHit } from "../../src/index/search.ts";
import {
	alreadyInContext,
	buildRecallMessage,
	contextFileLines,
	RECALL_KINDS,
	RECALL_PREAMBLE,
} from "../../src/recall/per-turn.ts";
import { estimateTokens } from "../../src/tokens.ts";

const ENTRY = "j-01a02e19-f1c6-7142-bcb1-2806083bd725";
const FACT = "f-testing-01a02e1c-1234-7abc-8def-1234567890ab";

function hit(overrides: Partial<SearchHit> & { id: string; body: string }): SearchHit {
	return {
		kind: "claim",
		path: "journal/host/2026-08-22.md",
		title: "",
		headingPath: "journal › 2026-08-22 › 14:32",
		snippet: overrides.body,
		superseded: false,
		score: 1,
		scope: "project",
		storePath: "/store",
		date: "2026-08-22",
		source: "user",
		...overrides,
	};
}

describe("buildRecallMessage", () => {
	it("labels the memories and carries the fixed framing verbatim", () => {
		const message = buildRecallMessage({
			hits: [hit({ id: `${ENTRY}.1`, body: "Run `pnpm test --run`; watch mode hangs CI." })],
			limit: 8,
			tokenBudget: 1500,
		});

		expect(message?.content.startsWith(RECALL_PREAMBLE)).toBe(true);
		expect(message?.content).toContain("These are memories, not ground truth.");
		expect(message?.content).toContain("- Run `pnpm test --run`; watch mode hangs CI.");
	});

	it("writes each memory's id in full, with its date, source and scope", () => {
		const message = buildRecallMessage({
			hits: [hit({ id: `${ENTRY}.1`, body: "A claim.", cue: "when CI hangs" })],
			limit: 8,
			tokenBudget: 1500,
		});

		expect(message?.content).toContain(
			`id: ${ENTRY}.1 · date: 2026-08-22 · source: user · scope: project · cue: when CI hangs`,
		);
		expect(message?.ids).toEqual([`${ENTRY}.1`]);
	});

	it("returns the texts it injected, for echo detection at outcome time", () => {
		const message = buildRecallMessage({
			hits: [hit({ id: FACT, kind: "fact", body: "Never watch mode." })],
			limit: 8,
			tokenBudget: 1500,
		});
		expect(message?.texts.get(FACT)).toBe("Never watch mode.");
	});

	it("injects nothing at all when there are no hits", () => {
		expect(buildRecallMessage({ hits: [], limit: 8, tokenBudget: 1500 })).toBeUndefined();
	});

	it("injects nothing when the settings turn it off", () => {
		const hits = [hit({ id: `${ENTRY}.1`, body: "A claim." })];
		expect(buildRecallMessage({ hits, limit: 0, tokenBudget: 1500 })).toBeUndefined();
		expect(buildRecallMessage({ hits, limit: 8, tokenBudget: 0 })).toBeUndefined();
	});

	it("stops at the fact limit", () => {
		const hits = Array.from({ length: 10 }, (_value, index) =>
			hit({ id: `${ENTRY}.${index + 1}`, body: `Claim number ${index}.` }),
		);
		const message = buildRecallMessage({ hits, limit: 3, tokenBudget: 1500 });
		expect(message?.ids).toHaveLength(3);
		expect(message?.skippedForBudget).toBe(7);
	});

	it("stays inside the token budget", () => {
		const hits = Array.from({ length: 20 }, (_value, index) =>
			hit({
				id: `${ENTRY}.${index + 1}`,
				body: `A fairly wordy claim number ${index} about the CI runner and its TTY.`,
			}),
		);
		const message = buildRecallMessage({ hits, limit: 20, tokenBudget: 120 });

		expect(message).toBeDefined();
		expect(estimateTokens(message?.content ?? "")).toBeLessThanOrEqual(120);
		expect(message?.skippedForBudget).toBeGreaterThan(0);
	});

	it("drops a memory that a context file already states — AGENTS.md wins", () => {
		const message = buildRecallMessage({
			hits: [
				hit({ id: `${ENTRY}.1`, body: "Run pnpm test --run; watch mode hangs CI." }),
				hit({ id: `${ENTRY}.2`, body: "The database URL points at docker compose." }),
			],
			limit: 8,
			tokenBudget: 1500,
			contextLines: ["Run pnpm test --run; watch mode hangs CI in this repository."],
		});

		expect(message?.ids).toEqual([`${ENTRY}.2`]);
		expect(message?.skippedAsDuplicates).toBe(1);
	});

	it("keeps a memory that merely shares a few words with a context line", () => {
		const message = buildRecallMessage({
			hits: [hit({ id: `${ENTRY}.1`, body: "The CI runner has no TTY, which is why watch mode never exits." })],
			limit: 8,
			tokenBudget: 1500,
			contextLines: ["This project uses CI."],
		});
		expect(message?.ids).toEqual([`${ENTRY}.1`]);
	});
});

describe("alreadyInContext", () => {
	it("is one-directional: a long line containing the memory counts, the reverse does not", () => {
		const context = [new Set("run pnpm test --run in ci never watch mode".split(" "))];
		expect(alreadyInContext("run pnpm test --run", context)).toBe(true);
		expect(alreadyInContext("run pnpm test --run because the ci runner has no tty at all", context)).toBe(false);
	});

	it("ignores memories too short to judge", () => {
		expect(alreadyInContext("pnpm", [new Set(["pnpm"])])).toBe(false);
	});
});

describe("contextFileLines", () => {
	it("flattens pi's loaded context files into comparable lines", () => {
		expect(contextFileLines([{ path: "AGENTS.md", content: "# Guide\n\n- Use pnpm.\n" }])).toEqual([
			"# Guide",
			"- Use pnpm.",
		]);
	});

	it("copes with a session that loaded none", () => {
		expect(contextFileLines(undefined)).toEqual([]);
	});
});

describe("RECALL_KINDS", () => {
	it("is assertions only — entry prose is context and is never recalled", () => {
		expect([...RECALL_KINDS]).toEqual(["claim", "fact"]);
	});
});

describe("buildRecallMessage — the user just said it", () => {
	it("does not recite back the very thing this prompt asked to be remembered", () => {
		// Without this, "remember that X" is answered in the same turn by Muninn
		// injecting X — the entry it captured moments earlier.
		const message = buildRecallMessage({
			hits: [hit({ id: `${ENTRY}.1`, body: "vitest watch mode hangs the CI job" })],
			limit: 8,
			tokenBudget: 1500,
			prompt: "Remember that vitest watch mode hangs the CI job.",
		});
		expect(message).toBeUndefined();
	});

	it("still recalls it when a later prompt is about the same subject in other words", () => {
		const message = buildRecallMessage({
			hits: [hit({ id: `${ENTRY}.1`, body: "vitest watch mode hangs the CI job" })],
			limit: 8,
			tokenBudget: 1500,
			prompt: "Why does the CI job hang?",
		});
		expect(message?.ids).toEqual([`${ENTRY}.1`]);
	});
});
