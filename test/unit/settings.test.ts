import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, isUsableRemote, resolveSettings } from "../../src/settings.ts";

describe("resolveSettings — defaults", () => {
	it("returns an independent copy of the documented defaults", () => {
		const first = resolveSettings(undefined, undefined);
		expect(first.settings).toEqual(DEFAULT_SETTINGS);
		expect(first.warnings).toEqual([]);

		first.settings.capture.outcomes = false;
		expect(resolveSettings(undefined, undefined).settings.capture.outcomes).toBe(true);
	});
});

describe("journal remote safety", () => {
	it("accepts ordinary Git locations and rejects helpers, flags, controls, and embedded HTTP credentials", () => {
		expect(isUsableRemote("ssh://git@example.com/team/journal.git")).toBe(true);
		expect(isUsableRemote("git@example.com:team/journal.git")).toBe(true);
		expect(isUsableRemote("/srv/git/journal.git")).toBe(true);
		expect(isUsableRemote("ext::sh -c exploit")).toBe(false);
		expect(isUsableRemote("--upload-pack=exploit")).toBe(false);
		expect(isUsableRemote("https://token@example.com/journal.git")).toBe(false);
		expect(isUsableRemote("https://user:secret@example.com/journal.git")).toBe(false);
		expect(isUsableRemote("ssh://git:secret@example.com/journal.git")).toBe(false);
		expect(isUsableRemote("https://example.com/journal.git?access_token=secret-value")).toBe(false);
		expect(isUsableRemote("ssh://git@example.com/journal.git#credential")).toBe(false);
		expect(isUsableRemote("https://example.com/journal.git\nmalice")).toBe(false);
	});
});

describe("resolveSettings — global settings", () => {
	it("applies valid capture, scope and sync timing values", () => {
		const { settings, warnings } = resolveSettings(
			{
				scopes: { project: "auto" },
				capture: { corrections: false },
				sync: { onShutdown: false },
			},
			undefined,
		);

		expect(settings.scopes.project).toBe("auto");
		expect(settings.capture.corrections).toBe(false);
		expect(settings.sync).toEqual({ onShutdown: false });
		expect(warnings).toEqual([]);
	});

	it("reports removed and misspelled settings instead of silently accepting them", () => {
		const { warnings } = resolveSettings({ retrieval: { budget: 3 }, capture: { outcome: false } }, undefined);
		expect(warnings.map((warning) => warning.path).sort()).toEqual(["capture.outcome", "retrieval"]);
		expect(warnings.every((warning) => warning.kind === "unknown-key")).toBe(true);
	});

	it("rejects invalid values and removed remote settings", () => {
		const { settings, warnings } = resolveSettings(
			{ scopes: { project: "nearby" }, capture: { outcomes: "yes" }, sync: { remote: "ext::steal" } },
			undefined,
		);
		expect(settings).toEqual(DEFAULT_SETTINGS);
		expect(warnings).toHaveLength(3);
	});

	it("rejects a non-object muninn block", () => {
		const { settings, warnings } = resolveSettings("on", undefined);
		expect(settings).toEqual(DEFAULT_SETTINGS);
		expect(warnings[0]).toMatchObject({ kind: "not-an-object", scope: "global" });
	});
});

describe("proactive recall requires user opt-in", () => {
	it("defaults to manual even when a dedicated memory model is configured", () => {
		expect(resolveSettings(undefined, undefined).settings.recall.mode).toBe("manual");
		expect(
			resolveSettings({ memory: { model: { provider: "fixture", id: "memory" } } }, undefined).settings.recall.mode,
		).toBe("manual");
	});

	it("accepts an explicit global opt-in and returns to manual when it is removed", () => {
		const optedIn = resolveSettings({ recall: { mode: "assisted" } }, undefined);
		expect(optedIn.settings.recall.mode).toBe("assisted");
		expect(optedIn.warnings).toEqual([]);
		expect(resolveSettings({}, undefined).settings.recall.mode).toBe("manual");
	});

	it.each([undefined, { recall: { mode: "manual" } }])("rejects project-only opt-in over %j", (global) => {
		const resolved = resolveSettings(global, { recall: { mode: "assisted" } });
		expect(resolved.settings.recall.mode).toBe("manual");
		expect(resolved.warnings).toContainEqual(
			expect.objectContaining({ path: "recall.mode", scope: "project", kind: "not-tightening" }),
		);
	});

	it("allows a project to disable a global opt-in", () => {
		const resolved = resolveSettings({ recall: { mode: "assisted" } }, { recall: { mode: "manual" } });
		expect(resolved.settings.recall.mode).toBe("manual");
		expect(resolved.warnings).toEqual([]);
	});

	it.each([true, "true", "auto", null])("does not treat invalid mode %j as opt-in", (mode) => {
		const resolved = resolveSettings({ recall: { mode } }, undefined);
		expect(resolved.settings.recall.mode).toBe("manual");
		expect(resolved.warnings).toContainEqual(
			expect.objectContaining({ path: "recall.mode", scope: "global", kind: "invalid-value" }),
		);
	});
});

describe("resolveSettings — project settings tighten only", () => {
	it("lets a project disable capture but not enable a globally disabled kind", () => {
		const off = resolveSettings(undefined, { capture: { outcomes: false } });
		expect(off.settings.capture.outcomes).toBe(false);
		expect(off.warnings).toEqual([]);

		const on = resolveSettings({ capture: { corrections: false } }, { capture: { corrections: true } });
		expect(on.settings.capture.corrections).toBe(false);
		expect(on.warnings[0]).toMatchObject({ path: "capture.corrections", kind: "not-tightening" });
	});

	it("lets a project disable its journal without choosing a path", () => {
		expect(resolveSettings(undefined, { scopes: { project: false } }).settings.scopes.project).toBe(false);
	});

	it("does not let a project re-enable project scope", () => {
		const { settings, warnings } = resolveSettings({ scopes: { project: false } }, { scopes: { project: "auto" } });
		expect(settings.scopes.project).toBe(false);
		expect(warnings[0]).toMatchObject({ path: "scopes.project", kind: "not-tightening" });
	});
});
