import { describe, expect, it } from "vitest";
import type { ResolvedProject } from "../../src/project/resolver.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import { type ResolveScopesInput, resolveScopes } from "../../src/store/scopes.ts";

const PROJECT_ID = "0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b02";

function project(): ResolvedProject {
	return {
		id: PROJECT_ID,
		name: "app",
		storePath: `/agent/muninn-projects/${PROJECT_ID}`,
		registryPath: "/agent/muninn-projects/registry.json",
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
		agentDir: "/agent",
		project: project(),
		projectTrusted: true,
		storeExists: () => true,
		...overrides,
	};
}

describe("resolveScopes", () => {
	it("activates only the UUID-backed logical project journal", () => {
		const decision = resolveScopes(input());
		expect(decision.active).toEqual([
			{ scope: "project", path: `/agent/muninn-projects/${PROJECT_ID}`, exists: true, projectId: PROJECT_ID },
		]);
		expect(decision.captureTarget).toBe("project");
	});

	it("captures nothing without a trusted linked project", () => {
		expect(resolveScopes(input({ project: undefined })).captureTarget).toBeNull();
		expect(resolveScopes(input({ projectTrusted: false })).active).toEqual([]);
	});

	it("respects the project-scope switch", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.scopes.project = false;
		expect(resolveScopes(input({ settings })).captureTarget).toBeNull();
	});

	it("reports existence without creating the store", () => {
		const seen: string[] = [];
		const decision = resolveScopes(
			input({
				storeExists: (path) => {
					seen.push(path);
					return false;
				},
			}),
		);
		expect(seen).toEqual([`/agent/muninn-projects/${PROJECT_ID}`]);
		expect(decision.active[0]?.exists).toBe(false);
		expect(decision.reasons.join("\n")).toContain("created on first capture");
	});
});
