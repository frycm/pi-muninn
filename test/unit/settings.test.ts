import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, resolveSettings } from "../../src/settings.ts";

describe("resolveSettings — defaults", () => {
	it("returns the documented defaults when nothing is configured", () => {
		const { settings, warnings } = resolveSettings(undefined, undefined);
		expect(settings).toEqual(DEFAULT_SETTINGS);
		expect(warnings).toEqual([]);
	});

	it("does not hand out the shared defaults object", () => {
		const first = resolveSettings(undefined, undefined).settings;
		first.recall.factsPerTurn = 99;
		expect(resolveSettings(undefined, undefined).settings.recall.factsPerTurn).toBe(8);
		expect(DEFAULT_SETTINGS.recall.factsPerTurn).toBe(8);
	});
});

describe("resolveSettings — global scope", () => {
	it("applies any valid global value, up or down", () => {
		const { settings, warnings } = resolveSettings(
			{
				recall: { factsPerTurn: 20, tokenBudget: 4000, snapshotLines: { total: 500 } },
				sync: { remote: "git@example.com:me/memory.git" },
				dream: { model: "llama-server/qwen3-4b", auto: true },
			},
			undefined,
		);
		expect(warnings).toEqual([]);
		expect(settings.recall.factsPerTurn).toBe(20);
		expect(settings.recall.tokenBudget).toBe(4000);
		expect(settings.recall.snapshotLines.total).toBe(500);
		expect(settings.recall.snapshotLines.global).toBe(120); // untouched sibling
		expect(settings.sync.remote).toBe("git@example.com:me/memory.git");
		expect(settings.dream.model).toBe("llama-server/qwen3-4b");
		expect(settings.dream.auto).toBe(true);
	});

	it("accepts a provider/model pair for embeddings", () => {
		const { settings, warnings } = resolveSettings(
			{ recall: { embedding: { provider: "llama-server", model: "embeddinggemma-300m" } } },
			undefined,
		);
		expect(warnings).toEqual([]);
		expect(settings.recall.embedding).toEqual({ provider: "llama-server", model: "embeddinggemma-300m" });
	});

	it("reports unknown keys instead of ignoring them silently", () => {
		const { warnings } = resolveSettings({ recall: { factsPerTun: 3 } }, undefined);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({ path: "recall.factsPerTun", scope: "global", kind: "unknown-key" });
	});

	it("rejects wrong types and out-of-range numbers, keeping the default", () => {
		const { settings, warnings } = resolveSettings(
			{ recall: { factsPerTurn: "eight", tokenBudget: -1 }, capture: { outcomes: "yes" } },
			undefined,
		);
		expect(settings.recall.factsPerTurn).toBe(8);
		expect(settings.recall.tokenBudget).toBe(1500);
		expect(settings.capture.outcomes).toBe(true);
		expect(warnings.map((w) => w.kind).sort()).toEqual(["invalid-type", "invalid-type", "invalid-value"]);
	});

	it("rejects a non-object muninn block", () => {
		const { settings, warnings } = resolveSettings("on", undefined);
		expect(settings).toEqual(DEFAULT_SETTINGS);
		expect(warnings[0]).toMatchObject({ kind: "not-an-object", scope: "global" });
	});
});

describe("resolveSettings — project settings may only tighten", () => {
	it("lets a project lower a numeric budget", () => {
		const { settings, warnings } = resolveSettings({ recall: { factsPerTurn: 20 } }, { recall: { factsPerTurn: 4 } });
		expect(settings.recall.factsPerTurn).toBe(4);
		expect(warnings).toEqual([]);
	});

	it("refuses a project raising a numeric budget", () => {
		const { settings, warnings } = resolveSettings({ recall: { factsPerTurn: 8 } }, { recall: { factsPerTurn: 40 } });
		expect(settings.recall.factsPerTurn).toBe(8);
		expect(warnings[0]).toMatchObject({ path: "recall.factsPerTurn", scope: "project", kind: "not-tightening" });
	});

	it("lets a project disable a capture kind but not enable one", () => {
		const off = resolveSettings({ capture: { corrections: false } }, { capture: { outcomes: false } });
		expect(off.settings.capture.outcomes).toBe(false);
		expect(off.warnings).toEqual([]);

		const on = resolveSettings({ capture: { corrections: false } }, { capture: { corrections: true } });
		expect(on.settings.capture.corrections).toBe(false);
		expect(on.warnings[0]).toMatchObject({ path: "capture.corrections", kind: "not-tightening" });
	});

	it("lets a project pin a lower index tier but not a higher one", () => {
		const down = resolveSettings(undefined, { recall: { indexTier: "0" } });
		expect(down.settings.recall.indexTier).toBe("0");
		expect(down.warnings).toEqual([]);

		const up = resolveSettings({ recall: { indexTier: "0" } }, { recall: { indexTier: "1" } });
		expect(up.settings.recall.indexTier).toBe("0");
		expect(up.warnings[0]).toMatchObject({ path: "recall.indexTier", kind: "not-tightening" });
	});

	it("never lets a project name the sync remote", () => {
		// A .pi/settings.json travels with the repository: were this allowed, cloning
		// a project would be enough to redirect where the user's memory is pushed.
		const { settings, warnings } = resolveSettings(undefined, { sync: { remote: "git@evil.example:take/it.git" } });
		expect(settings.sync.remote).toBeNull();
		expect(warnings[0]).toMatchObject({ path: "sync.remote", scope: "project", kind: "not-tightening" });
	});

	it("never lets a project name an embedding or rerank endpoint", () => {
		const { settings, warnings } = resolveSettings(undefined, {
			recall: {
				embedding: { provider: "remote", model: "x" },
				rerank: { provider: "remote", model: "y" },
			},
		});
		expect(settings.recall.embedding).toBeNull();
		expect(settings.recall.rerank).toBeNull();
		expect(warnings).toHaveLength(2);
		expect(warnings.every((w) => w.kind === "not-tightening")).toBe(true);
	});

	it("never lets a project choose the dreamer model", () => {
		const { settings, warnings } = resolveSettings(undefined, { dream: { model: "some/model", auto: true } });
		expect(settings.dream.model).toBeNull();
		expect(settings.dream.auto).toBe(false);
		expect(warnings).toHaveLength(2);
	});

	it("lets a project disable global scope for itself", () => {
		const { settings, warnings } = resolveSettings(undefined, { scopes: { global: false } });
		expect(settings.scopes.global).toBe(false);
		expect(warnings).toEqual([]);
	});

	it("lets a project choose where its own store lives", () => {
		const { settings, warnings } = resolveSettings(undefined, { scopes: { project: "in-repo" } });
		expect(settings.scopes.project).toBe("in-repo");
		expect(warnings).toEqual([]);
	});

	it("refuses a project enabling project scope that is globally off", () => {
		const { settings, warnings } = resolveSettings({ scopes: { project: false } }, { scopes: { project: "in-repo" } });
		expect(settings.scopes.project).toBe(false);
		expect(warnings[0]).toMatchObject({ path: "scopes.project", scope: "project", kind: "not-tightening" });
	});

	it("lets a project turn its own scope off even when global allows it", () => {
		const { settings, warnings } = resolveSettings({ scopes: { project: "auto" } }, { scopes: { project: false } });
		expect(settings.scopes.project).toBe(false);
		expect(warnings).toEqual([]);
	});

	it("validates project values before applying the tighten rule", () => {
		const { settings, warnings } = resolveSettings(undefined, { recall: { indexTier: "2" } });
		expect(settings.recall.indexTier).toBe("auto");
		expect(warnings[0]).toMatchObject({ kind: "invalid-value", scope: "project" });
	});
});

describe("resolveSettings — shape errors", () => {
	it("reports a scalar where an object was expected", () => {
		const { warnings } = resolveSettings({ recall: 8 }, undefined);
		expect(warnings[0]).toMatchObject({ path: "recall", kind: "unknown-key" });
		expect(warnings[0]?.message).toContain("expected an object");
	});
});
