import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatQualify, type QualifyResult, qualify } from "../../src/dream/qualify.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import { flaky, hostile, perfect, silent } from "../fixtures/qualify/dreamers.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/qualify", import.meta.url));
const NOW = new Date("2026-09-01T03:00:00Z");

async function run(model: Parameters<typeof qualify>[0]["model"]): Promise<QualifyResult> {
	return qualify({ fixture: FIXTURE, model, settings: DEFAULT_SETTINGS, now: NOW });
}

function scoreOf(result: QualifyResult, name: string) {
	return result.scores.find((score) => score.name === name);
}

describe("the qualification run scores the model", () => {
	it("passes a dreamer that only ever cites what it was shown", async () => {
		const result = await run(perfect);
		expect(result.notes.filter((note) => note.includes("fail"))).toEqual([]);
		// Zero *attempted*, not merely zero written: the guards would make the
		// second true for any model.
		expect(scoreOf(result, "unsourced facts")?.value).toBe(0);
		expect(scoreOf(result, "echo and held-out leakage")?.value).toBe(0);
		expect(scoreOf(result, "secrets in derived files")?.value).toBe(0);
		expect(scoreOf(result, "facts written")?.value).toBeGreaterThanOrEqual(3);
		expect(result.passed).toBe(true);
	}, 60_000);

	it("fails every hard gate for a dreamer that fabricates", async () => {
		// Each item in the hostile script is refused by a different rule, so a
		// hostile run that starts passing says which guard stopped working.
		const result = await run(hostile);
		expect(result.passed).toBe(false);
		// It fails the unsourced gate because it *tried*. Scoring only what
		// reached a file would have measured the guard rather than the model —
		// `checkFactList` refuses an unsourced fact before it is ever written, so
		// that number is zero for every model, honest or not.
		expect(scoreOf(result, "unsourced facts")?.passed).toBe(false);
		expect(scoreOf(result, "unsourced facts")?.detail).toContain("0 reached a file");
		// And it fails on content: it never reproduces a labelled claim, because
		// it is not reading the evidence, it is inventing.
		expect(scoreOf(result, "expected claims kept")?.passed).toBe(false);
		expect(scoreOf(result, "secrets in derived files")?.value).toBe(0);
		expect(scoreOf(result, "echo and held-out leakage")?.value).toBe(0);
	}, 60_000);

	it("survives a model whose JSON is broken once", async () => {
		const result = await run(flaky());
		expect(scoreOf(result, "unsourced facts")?.value).toBe(0);
		expect(scoreOf(result, "facts written")?.value).toBeGreaterThan(0);
	}, 60_000);

	it("does not let a model score by writing nothing", async () => {
		const result = await run(silent);
		expect(result.passed).toBe(false);
		expect(scoreOf(result, "facts written")?.passed).toBe(false);
		expect(scoreOf(result, "expected claims kept")?.value).toBe(0);
	}, 60_000);

	it("prints a table an operator can read", async () => {
		const text = formatQualify(await run(perfect));
		expect(text).toContain("muninn dream --qualify");
		expect(text).toContain("unsourced facts");
		expect(text).toContain("clears the bar");
	}, 60_000);
});

describe("what the fixture holds out is genuinely unreachable", () => {
	it("never cites an echo, a held-out task, or a single agent sighting", async () => {
		// The perfect dreamer cites everything it is shown, so anything forbidden
		// that reaches a fact was shown to it — which is gather's failure, not
		// the model's.
		const result = await run(perfect);
		expect(scoreOf(result, "echo and held-out leakage")?.value).toBe(0);
	}, 60_000);
});
