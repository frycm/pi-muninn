import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, resolveSettings } from "../../src/settings.ts";

describe("resolveSettings — defaults", () => {
	it("returns an independent copy of the documented defaults", () => {
		const first = resolveSettings(undefined, undefined);
		expect(first.settings).toEqual(DEFAULT_SETTINGS);
		expect(first.warnings).toEqual([]);

		first.settings.capture.outcomes = false;
		expect(resolveSettings(undefined, undefined).settings.capture.outcomes).toBe(true);
	});
});

describe("resolveSettings — global settings", () => {
	it("applies valid capture, scope and sync values", () => {
		const { settings, warnings } = resolveSettings(
			{
				scopes: { project: "separate" },
				capture: { corrections: false },
				sync: { remote: "git@example.com:team/journal.git", onShutdown: false },
			},
			undefined,
		);

		expect(settings.scopes.project).toBe("separate");
		expect(settings.capture.corrections).toBe(false);
		expect(settings.sync).toEqual({ remote: "git@example.com:team/journal.git", onShutdown: false });
		expect(warnings).toEqual([]);
	});

	it("reports removed and misspelled settings instead of silently accepting them", () => {
		const { warnings } = resolveSettings({ retrieval: { budget: 3 }, capture: { outcome: false } }, undefined);
		expect(warnings.map((warning) => warning.path).sort()).toEqual(["capture.outcome", "retrieval"]);
		expect(warnings.every((warning) => warning.kind === "unknown-key")).toBe(true);
	});

	it("rejects invalid values and unsafe remotes", () => {
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

describe("resolveSettings — project settings tighten only", () => {
	it("lets a project disable capture but not enable a globally disabled kind", () => {
		const off = resolveSettings(undefined, { capture: { outcomes: false } });
		expect(off.settings.capture.outcomes).toBe(false);
		expect(off.warnings).toEqual([]);

		const on = resolveSettings({ capture: { corrections: false } }, { capture: { corrections: true } });
		expect(on.settings.capture.corrections).toBe(false);
		expect(on.warnings[0]).toMatchObject({ path: "capture.corrections", kind: "not-tightening" });
	});

	it("never lets a project choose the sync remote", () => {
		const { settings, warnings } = resolveSettings(undefined, {
			sync: { remote: "git@evil.example:take/it.git" },
		});
		expect(settings.sync.remote).toBeNull();
		expect(warnings[0]).toMatchObject({ path: "sync.remote", scope: "project", kind: "not-tightening" });
	});

	it("lets a project choose or disable its own store", () => {
		expect(resolveSettings(undefined, { scopes: { project: "in-repo" } }).settings.scopes.project).toBe("in-repo");
		expect(resolveSettings(undefined, { scopes: { project: false } }).settings.scopes.project).toBe(false);
	});

	it("does not let a project re-enable project scope", () => {
		const { settings, warnings } = resolveSettings({ scopes: { project: false } }, { scopes: { project: "in-repo" } });
		expect(settings.scopes.project).toBe(false);
		expect(warnings[0]).toMatchObject({ path: "scopes.project", kind: "not-tightening" });
	});
});
