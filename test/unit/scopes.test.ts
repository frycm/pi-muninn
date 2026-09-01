import { describe, expect, it } from "vitest";
import type { ResolvedProject } from "../../src/project/resolver.ts";
import { DEFAULT_SETTINGS, type MuninnSettings } from "../../src/settings.ts";
import { type ResolveScopesInput, resolveScopes } from "../../src/store/scopes.ts";

const PROJECT_ID = "0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b02";

function project(): ResolvedProject {
	return {
		id: PROJECT_ID,
		name: "app",
		storePath: `/home/u/.pi/agent/muninn-projects/${PROJECT_ID}`,
		registryPath: "/home/u/.pi/agent/muninn-projects/registry.json",
		member: {
			id: "0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b03",
			name: "martin",
			createdAt: "2026-09-01T00:00:00.000Z",
		},
		root: "/src/app",
		gitCommonDir: "/src/app/.git",
		locations: [{ root: "/src/app", gitCommonDir: "/src/app/.git", linkedAt: "2026-09-01T00:00:00.000Z" }],
		reason: "git-common-dir",
		reasonDetail: "canonical Git common directory /src/app/.git",
	};
}

function input(overrides: Partial<ResolveScopesInput> = {}): ResolveScopesInput {
	return {
		settings: structuredClone(DEFAULT_SETTINGS),
		agentDir: "/home/u/.pi/agent",
		project: project(),
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
	it("activates both scopes for a resolved trusted project and captures to its UUID store", () => {
		const decision = resolveScopes(input());
		expect(decision.active.map((scope) => scope.scope)).toEqual(["global", "project"]);
		expect(decision.active[1]).toMatchObject({ projectId: PROJECT_ID });
		expect(decision.captureTarget).toBe("project");
	});

	it("falls back to global when inspection found no registry mapping", () => {
		const decision = resolveScopes(input({ project: undefined }));
		expect(decision.active.map((scope) => scope.scope)).toEqual(["global"]);
		expect(decision.captureTarget).toBe("global");
		expect(decision.reasons.join("\n")).toContain("not linked yet");
	});

	it("respects pi's project-trust decision", () => {
		const decision = resolveScopes(input({ projectTrusted: false }));
		expect(decision.active.map((scope) => scope.scope)).toEqual(["global"]);
		expect(decision.reasons.join("\n")).toContain("does not trust this project");
	});

	it("captures nothing when every scope is off", () => {
		const decision = withSettings((settings) => {
			settings.scopes.global = false;
			settings.scopes.project = false;
		});
		expect(decision.active).toEqual([]);
		expect(decision.captureTarget).toBeNull();
		expect(decision.reasons.join("\n")).toContain("nothing is captured");
	});

	it("uses only the UUID-backed external project path", () => {
		const active = resolveScopes(input()).active[1];
		expect(active?.path).toBe(`/home/u/.pi/agent/muninn-projects/${PROJECT_ID}`);
		expect(active?.path).not.toContain("/src/app/");
	});

	it("explains the selected resolver mapping", () => {
		const reasons = resolveScopes(input()).reasons.join("\n");
		expect(reasons).toContain(PROJECT_ID);
		expect(reasons).toContain("canonical Git common directory");
		expect(reasons).toContain("capture target: project");
	});

	it("notes that a new UUID store has not been created yet", () => {
		const decision = resolveScopes(input({ storeExists: () => false }));
		expect(decision.reasons.join("\n")).toContain("will be created on first capture");
		expect(decision.active.find((scope) => scope.scope === "project")?.exists).toBe(false);
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
