import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type SettingsWarning } from "../../src/settings.ts";
import type { LoadedSettingsWithSources } from "../../src/settings-io.ts";
import { formatStatus, formatStatusLine } from "../../src/status.ts";

function loaded(overrides: Partial<LoadedSettingsWithSources> = {}): LoadedSettingsWithSources {
	return {
		settings: structuredClone(DEFAULT_SETTINGS),
		warnings: [],
		sources: {
			global: { path: "/home/u/.pi/agent/settings.json", present: true, hasMuninnBlock: true },
			project: { path: "/src/app/.pi/settings.json", present: false, hasMuninnBlock: false },
		},
		...overrides,
	};
}

function status(overrides: Partial<Parameters<typeof formatStatus>[0]> = {}): string {
	return formatStatus({
		muninnVersion: "0.1.0",
		piVersion: "0.84.2",
		runtime: "node v22.19.0",
		cwd: "/src/app",
		loaded: loaded(),
		stores: [],
		projectTrusted: true,
		...overrides,
	});
}

describe("formatStatus", () => {
	it("names both versions and the runtime", () => {
		expect(status()).toContain("⟡ muninn 0.1.0 · pi 0.84.2 · node v22.19.0");
	});

	it("says plainly that no store exists yet rather than implying memory works", () => {
		const report = status();
		expect(report).toContain("none yet");
		expect(report).not.toContain("entries)");
	});

	it("shows which settings files were read", () => {
		const report = status();
		expect(report).toContain("/home/u/.pi/agent/settings.json (muninn block)");
		expect(report).toContain("/src/app/.pi/settings.json (absent)");
	});

	it("flags an untrusted project next to the project scope", () => {
		expect(status({ projectTrusted: false })).toContain("project not trusted");
	});

	it("lists settings warnings", () => {
		const warnings: SettingsWarning[] = [
			{ path: "sync.remote", scope: "project", kind: "not-tightening", message: 'ignored "sync.remote"' },
		];
		const report = status({ loaded: loaded({ warnings }) });
		expect(report).toContain("1 settings warning:");
		expect(report).toContain('[project] ignored "sync.remote"');
	});

	it("says so when every capture kind is off", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.capture.corrections = false;
		settings.capture.outcomes = false;
		settings.capture.toolFacts = false;
		expect(status({ loaded: loaded({ settings }) })).toContain("nothing (all kinds disabled)");
	});
});

describe("formatStatusLine", () => {
	it("reports no store", () => {
		expect(formatStatusLine({ loaded: loaded(), stores: [] })).toBe("⟡ muninn · no store");
	});

	it("counts warnings", () => {
		const warnings: SettingsWarning[] = [
			{ path: "a", scope: "project", kind: "unknown-key", message: "x" },
			{ path: "b", scope: "global", kind: "unknown-key", message: "y" },
		];
		expect(formatStatusLine({ loaded: loaded({ warnings }), stores: [] })).toBe("⟡ muninn · no store · 2⚠");
	});

	it("names the active scopes once stores exist", () => {
		const stores = [
			{ scope: "global", path: "/g", entries: 3 },
			{ scope: "project", path: "/p", entries: 1 },
		];
		expect(formatStatusLine({ loaded: loaded(), stores })).toBe("⟡ muninn · global+project");
	});
});
