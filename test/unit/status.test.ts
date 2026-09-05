import { describe, expect, it } from "vitest";
import type { ResolvedProject } from "../../src/project/resolver.ts";
import type { SessionContext } from "../../src/session.ts";
import { DEFAULT_SETTINGS, type SettingsWarning } from "../../src/settings.ts";
import type { LoadedSettingsWithSources } from "../../src/settings-io.ts";
import { formatScopes, formatStatus, formatStatusLine } from "../../src/status.ts";
import type { ScopeDecision } from "../../src/store/scopes.ts";

const HOST = "0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01";
const PROJECT = "0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b02";
const MEMBER = "0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b03";

function project(): ResolvedProject {
	return {
		id: PROJECT,
		name: "app",
		storePath: `/agent/muninn-projects/${PROJECT}`,
		registryPath: "/agent/muninn-projects/registry.json",
		member: { id: MEMBER, name: "martin", createdAt: "2026-09-01T00:00:00.000Z" },
		root: "/src/app",
		gitCommonDir: "/src/app/.git",
		locations: [{ root: "/src/app", gitCommonDir: "/src/app/.git", linkedAt: "2026-09-01T00:00:00.000Z" }],
		reason: "root",
		reasonDetail: "canonical root mapping /src/app",
	};
}

function loaded(warnings: SettingsWarning[] = []): LoadedSettingsWithSources {
	return {
		settings: structuredClone(DEFAULT_SETTINGS),
		warnings,
		sources: {
			global: { path: "/agent/settings.json", present: true, hasMuninnBlock: true },
			project: { path: "/src/app/.pi/settings.json", present: false, hasMuninnBlock: false },
		},
	};
}

function scopes(overrides: Partial<ScopeDecision> = {}): ScopeDecision {
	return {
		active: [{ scope: "project", path: `/agent/muninn-projects/${PROJECT}`, exists: true, projectId: PROJECT }],
		captureTarget: "project",
		reasons: ["project: active", "capture target: project"],
		...overrides,
	};
}

function session(overrides: Partial<SessionContext> = {}): SessionContext {
	return {
		host: { id: HOST, name: "mbp", createdAt: "2026-08-23T00:00:00.000Z" },
		loaded: loaded(),
		project: project(),
		scopes: scopes(),
		problems: [],
		...overrides,
	};
}

function report(overrides: Partial<Parameters<typeof formatStatus>[0]> = {}): string {
	return formatStatus({
		muninnVersion: "0.1.0",
		piVersion: "0.84.2",
		runtime: "node v22.19.0",
		session: session(),
		...overrides,
	});
}

describe("project journal status", () => {
	it("makes the effective proactive-recall state explicit", () => {
		expect(report()).toContain("recall manual (proactive off)");
		const enabled = loaded();
		enabled.settings.recall.mode = "assisted";
		expect(report({ session: session({ loaded: enabled }) })).toContain("recall assisted (proactive on)");
	});

	it("shows versions, actor identity, mapping, alias, and project store", () => {
		const text = report();
		expect(text).toContain("⟡ muninn 0.1.0 · pi 0.84.2 · node v22.19.0");
		expect(text).toContain(`host      mbp · ${HOST}`);
		expect(text).toContain(`project   app · ${PROJECT}`);
		expect(text).toContain(`member    martin · ${MEMBER}`);
		expect(text).toContain("alias     /src/app");
		expect(text).toMatch(/→ project:/);
	});

	it("reports records, capture failures, pending commits, and sync state", () => {
		const text = report({
			journal: [{ scope: "project", path: "/p", entries: 3, problems: ["malformed: bad line"] }],
			captureFailures: ["capture correction: store lock is busy"],
			uncommitted: 2,
			sync: { remote: "ssh://example/journal.git", last: "project: synced" },
		});
		expect(text).toContain("journal   project: 3 records");
		expect(text).toContain("! malformed: bad line");
		expect(text).toContain("2 entries written, not yet committed");
		expect(text).toContain("! capture correction: store lock is busy");
		expect(text).toContain("ssh://example/journal.git");
	});

	it("surfaces settings and store problems", () => {
		const warning: SettingsWarning = { path: "x", scope: "project", kind: "unknown-key", message: "ignored x" };
		const text = report({ session: session({ loaded: loaded([warning]), problems: ["journal unreadable"] }) });
		expect(text).toContain("1 settings warning");
		expect(text).toContain("ignored x");
		expect(text).toContain("1 store problem");
	});

	it("plainly reports no active project journal", () => {
		const none = scopes({ active: [], captureTarget: null, reasons: ["project: not linked"] });
		const unlinked = session({ scopes: none });
		delete unlinked.project;
		expect(report({ session: unlinked })).toContain("none active");
		expect(formatScopes(session({ scopes: none }))).toContain("Nothing will be captured");
	});
});

describe("footer", () => {
	it("shows the project target, pending count, and warnings compactly", () => {
		expect(formatStatusLine(session(), { uncommitted: 3 })).toBe("⟡ muninn · project · 3 new");
		const warning: SettingsWarning = { path: "x", scope: "project", kind: "unknown-key", message: "ignored" };
		expect(formatStatusLine(session({ loaded: loaded([warning]) }), { uncommitted: 2 })).toBe(
			"⟡ muninn · project · 2 new · 1⚠",
		);
	});
});
