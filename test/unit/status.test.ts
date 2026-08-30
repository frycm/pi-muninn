import { describe, expect, it } from "vitest";
import type { SessionContext } from "../../src/session.ts";
import { DEFAULT_SETTINGS, type SettingsWarning } from "../../src/settings.ts";
import type { LoadedSettingsWithSources } from "../../src/settings-io.ts";
import { formatScopes, formatStatus, formatStatusLine } from "../../src/status.ts";
import type { ScopeDecision } from "../../src/store/scopes.ts";

const HOST_ID = "0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01";

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

function scopes(overrides: Partial<ScopeDecision> = {}): ScopeDecision {
	return {
		active: [
			{ scope: "global", path: "/home/u/.pi/agent/muninn", exists: true, inRepo: false },
			{ scope: "project", path: "/home/u/.pi/agent/muninn-projects/app-abc123", exists: true, inRepo: false },
		],
		captureTarget: "project",
		reasons: ["global: active", "project: active, separate store at /p", "capture target: project"],
		...overrides,
	};
}

function session(overrides: Partial<SessionContext> = {}): SessionContext {
	return {
		host: { id: HOST_ID, name: "mbp", createdAt: "2026-08-23T00:00:00.000Z" },
		loaded: loaded(),
		scopes: scopes(),
		problems: [],
		...overrides,
	};
}

function status(overrides: Partial<SessionContext> = {}): string {
	return formatStatus({
		muninnVersion: "0.1.0",
		piVersion: "0.84.2",
		runtime: "node v22.19.0",
		session: session(overrides),
	});
}

describe("formatStatus", () => {
	it("names both versions and the runtime", () => {
		expect(status()).toContain("⟡ muninn 0.1.0 · pi 0.84.2 · node v22.19.0");
	});

	it("shows the host by name and full id", () => {
		// Ids are never truncated in anything that could be copied into a file or
		// a tool call; only the renderer's own shortening does that.
		expect(status()).toContain(`mbp · ${HOST_ID}`);
	});

	it("marks which store is the capture target", () => {
		const report = status();
		expect(report).toMatch(/→ project:/);
		expect(report).not.toMatch(/→ global:/);
	});

	it("says a store has not been created yet rather than implying it exists", () => {
		const decision = scopes();
		(decision.active[1] as { exists: boolean }).exists = false;
		expect(status({ scopes: decision })).toContain("(not created yet)");
	});

	it("surfaces runs pi never sent an agent_end for", () => {
		// The measurement that decides whether a turn-summary payload is worth
		// asking pi for.
		const report = formatStatus({
			muninnVersion: "0.1.0",
			piVersion: "0.84.2",
			runtime: "node v22.19.0",
			session: session(),
			runsWithoutAgentEnd: 2,
		});
		expect(report).toContain("2 run(s) settled without pi's agent_end payload");
	});

	it("says nothing about agent_end when every run had one", () => {
		expect(status()).not.toContain("agent_end");
	});

	it("surfaces a failed journal write rather than losing it silently", () => {
		const report = formatStatus({
			muninnVersion: "0.1.0",
			piVersion: "0.84.2",
			runtime: "node v22.19.0",
			session: session(),
			captureFailures: ["capture correction: store lock is busy"],
		});
		expect(report).toContain("! capture correction: store lock is busy");
	});

	it("shows journal counts when they were asked for", () => {
		const report = formatStatus({
			muninnVersion: "0.1.0",
			piVersion: "0.84.2",
			runtime: "node v22.19.0",
			session: session(),
			journal: [{ scope: "project", path: "/p", entries: 3, claims: 5, problems: [] }],
		});
		expect(report).toContain("journal   project: 3 entries, 5 claims");
	});

	it("surfaces a damaged journal file rather than quietly reading around it", () => {
		const report = formatStatus({
			muninnVersion: "0.1.0",
			piVersion: "0.84.2",
			runtime: "node v22.19.0",
			session: session(),
			journal: [{ scope: "project", path: "/p", entries: 1, claims: 1, problems: ["truncated: entry at end of file"] }],
		});
		expect(report).toContain("! truncated: entry at end of file");
	});

	it("uses singular wording for one entry", () => {
		const report = formatStatus({
			muninnVersion: "0.1.0",
			piVersion: "0.84.2",
			runtime: "node v22.19.0",
			session: session(),
			journal: [{ scope: "global", path: "/g", entries: 1, claims: 1, problems: [] }],
		});
		expect(report).toContain("1 entry, 1 claim");
	});

	it("shows which settings files were read", () => {
		const report = status();
		expect(report).toContain("/home/u/.pi/agent/settings.json (muninn block)");
		expect(report).toContain("/src/app/.pi/settings.json (absent)");
	});

	it("lists settings warnings", () => {
		const warnings: SettingsWarning[] = [
			{ path: "sync.remote", scope: "project", kind: "not-tightening", message: 'ignored "sync.remote"' },
		];
		const report = status({ loaded: loaded({ warnings }) });
		expect(report).toContain("1 settings warning:");
		expect(report).toContain('[project] ignored "sync.remote"');
	});

	it("lists store problems separately from settings warnings", () => {
		const report = status({ problems: ["global store at /g: permission denied"] });
		expect(report).toContain("1 store problem:");
		expect(report).toContain("permission denied");
	});

	it("says so when every scope is off", () => {
		expect(status({ scopes: scopes({ active: [], captureTarget: null }) })).toContain("none active");
	});

	it("says so when every capture kind is off", () => {
		const l = loaded();
		l.settings.capture.corrections = false;
		l.settings.capture.outcomes = false;
		expect(status({ loaded: l })).toContain("nothing (all kinds disabled)");
	});
});

describe("formatScopes", () => {
	it("prints the reason for every decision", () => {
		const report = formatScopes(session());
		expect(report).toContain("global: active");
		expect(report).toContain("capture target: project");
	});

	it("warns plainly when nothing will be captured", () => {
		const report = formatScopes(session({ scopes: scopes({ active: [], captureTarget: null }) }));
		expect(report).toContain("Nothing will be captured in this session.");
	});
});

describe("formatStatusLine", () => {
	it("names the capture target", () => {
		expect(formatStatusLine(session())).toBe("⟡ muninn · project");
	});

	it("reports no store when every scope is off", () => {
		expect(formatStatusLine(session({ scopes: scopes({ active: [], captureTarget: null }) }))).toBe(
			"⟡ muninn · no store",
		);
	});

	it("counts settings warnings and store problems together", () => {
		const warnings: SettingsWarning[] = [{ path: "a", scope: "project", kind: "unknown-key", message: "x" }];
		expect(formatStatusLine(session({ loaded: loaded({ warnings }), problems: ["broken"] }))).toBe(
			"⟡ muninn · project · 2⚠",
		);
	});
});

describe("formatStatus — the index", () => {
	it("reports chunk and file counts per scope", () => {
		const text = formatStatus({
			muninnVersion: "0.1.0",
			piVersion: "0.84.2",
			runtime: "node v22.19.0",
			session: session(),
			index: [
				{ scope: "global", chunks: 412, files: 9 },
				{ scope: "project", chunks: 1, files: 1 },
			],
		});
		expect(text).toContain("index     global: 412 chunks from 9 files");
		expect(text).toContain("project: 1 chunk from 1 file");
	});

	it("says nothing about the index while it is still opening", () => {
		// Absent means "not asked for yet", not "empty" — the index opens on the
		// queue, so a status printed in the first moments of a session has none.
		expect(status()).not.toContain("index ");
	});
});

describe("formatStatusLine — tier and pending entries", () => {
	it("shows the tier and how much is waiting to be committed", () => {
		expect(formatStatusLine(session(), { tier: "t0", uncommitted: 3 })).toBe("⟡ muninn · project · t0 · 3 new");
	});

	it("leaves out a count of nothing", () => {
		expect(formatStatusLine(session(), { tier: "t0", uncommitted: 0 })).toBe("⟡ muninn · project · t0");
	});

	it("keeps the warning count last, where it is noticed", () => {
		const warnings: SettingsWarning[] = [
			{ path: "capture.outcomes", scope: "project", kind: "not-tightening", message: "ignored" },
		];
		expect(formatStatusLine(session({ loaded: loaded({ warnings }) }), { tier: "t0", uncommitted: 2 })).toBe(
			"⟡ muninn · project · t0 · 2 new · 1⚠",
		);
	});
});

describe("formatStatus — uncommitted entries", () => {
	it("says how many entries are written but not yet in git", () => {
		const text = formatStatus({
			muninnVersion: "0.1.0",
			piVersion: "0.84.2",
			runtime: "node v22.19.0",
			session: session(),
			uncommitted: 2,
		});
		expect(text).toContain("2 entries written, not yet committed");
	});
});
