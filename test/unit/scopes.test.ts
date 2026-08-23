import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type MuninnSettings } from "../../src/settings.ts";
import { type ResolveScopesInput, resolveScopes } from "../../src/store/scopes.ts";

function input(overrides: Partial<ResolveScopesInput> = {}): ResolveScopesInput {
	return {
		settings: structuredClone(DEFAULT_SETTINGS),
		agentDir: "/home/u/.pi/agent",
		configDirName: ".pi",
		toplevel: "/src/app",
		projectTrusted: true,
		storeExists: () => true,
		...overrides,
	};
}

function withSettings(mutate: (settings: MuninnSettings) => void, overrides: Partial<ResolveScopesInput> = {}) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	mutate(settings);
	return resolveScopes(input({ settings, ...overrides }));
}

describe("resolveScopes", () => {
	it("activates both scopes in a trusted project and captures to project", () => {
		const decision = resolveScopes(input());
		expect(decision.active.map((s) => s.scope)).toEqual(["global", "project"]);
		expect(decision.captureTarget).toBe("project");
	});

	it("falls back to global outside a git repository", () => {
		const decision = resolveScopes(input({ toplevel: undefined }));
		expect(decision.active.map((s) => s.scope)).toEqual(["global"]);
		expect(decision.captureTarget).toBe("global");
		expect(decision.reasons.join("\n")).toContain("not inside a git repository");
	});

	it("respects pi's project-trust decision", () => {
		// An untrusted project must not be able to make Muninn write into it, nor
		// have its memory read into the session.
		const decision = resolveScopes(input({ projectTrusted: false }));
		expect(decision.active.map((s) => s.scope)).toEqual(["global"]);
		expect(decision.captureTarget).toBe("global");
		expect(decision.reasons.join("\n")).toContain("does not trust this project");
	});

	it("captures nothing when every scope is off, and says so", () => {
		const decision = withSettings((s) => {
			s.scopes.global = false;
			s.scopes.project = false;
		});
		expect(decision.active).toEqual([]);
		expect(decision.captureTarget).toBeNull();
		expect(decision.reasons.join("\n")).toContain("nothing is captured");
	});

	it("uses a separate store by default, keyed by the toplevel", () => {
		const decision = resolveScopes(input());
		const project = decision.active.find((s) => s.scope === "project");
		expect(project?.inRepo).toBe(false);
		expect(project?.path).toContain("/muninn-projects/");
		expect(project?.path).not.toContain("/src/app/");
	});

	it("uses an in-repo store when the project opted in", () => {
		const decision = withSettings((s) => {
			s.scopes.project = "in-repo";
		});
		const project = decision.active.find((s) => s.scope === "project");
		expect(project?.inRepo).toBe(true);
		expect(project?.path).toBe("/src/app/.pi/muninn");
	});

	it("explains every decision it made", () => {
		// `/muninn scope` exists so a user can ask "why did that note go there?"
		// and get an answer, so a reason for each scope is part of the contract.
		const decision = resolveScopes(input());
		expect(decision.reasons.some((r) => r.startsWith("global:"))).toBe(true);
		expect(decision.reasons.some((r) => r.startsWith("project:"))).toBe(true);
		expect(decision.reasons.some((r) => r.startsWith("capture target:"))).toBe(true);
	});

	it("notes that an auto project store has not been created yet", () => {
		const decision = resolveScopes(input({ storeExists: () => false }));
		expect(decision.reasons.join("\n")).toContain("will be created on first capture");
		expect(decision.active.find((s) => s.scope === "project")?.exists).toBe(false);
	});

	it("reports store existence without creating anything", () => {
		const seen: string[] = [];
		resolveScopes(
			input({
				storeExists: (path) => {
					seen.push(path);
					return false;
				},
			}),
		);
		expect(seen).toHaveLength(2);
	});
});
