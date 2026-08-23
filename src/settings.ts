/**
 * Muninn settings: read the `muninn` key from pi's own settings files.
 *
 * pi has no extension-settings API at the baseline (v0.84.2), so Muninn reads
 * `settings.json` itself. That is safe in both directions:
 *
 *  - pi's `SettingsManager.save()` re-reads the file and persists only the
 *    fields it has itself modified (core/settings-manager.ts:617), so a foreign
 *    `muninn` key survives pi's writes.
 *  - Muninn never writes `settings.json`.
 *
 * Project settings are **tighten-only**. A `.pi/settings.json` travels with a
 * repository, so a cloned project must not be able to widen what Muninn does on
 * the machine that clones it: it cannot raise a budget, re-enable something the
 * user disabled globally, point recall at a network endpoint, or name the remote
 * that memory is pushed to. It can always ask for *less*.
 */

/** Where a project store lives, or `false` to disable project scope entirely. */
export type ProjectScopeSetting = false | "auto" | "separate" | "in-repo";

/** Retrieval tier. `"auto"` picks the best that loads; `"0"` and `"1"` pin it. */
export type IndexTierSetting = "auto" | "0" | "1";

/** A provider + model pair naming an endpoint in pi's model registry. */
export interface ProviderModelRef {
	provider: string;
	model: string;
}

export interface MuninnSettings {
	scopes: {
		global: boolean;
		project: ProjectScopeSetting;
		team: { remote: string | null; pin: string | null };
	};
	sync: { remote: string | null; onShutdown: boolean };
	capture: {
		corrections: boolean;
		outcomes: boolean;
		toolFacts: boolean;
		externalPerSession: number;
	};
	recall: {
		factsPerTurn: number;
		tokenBudget: number;
		indexTier: IndexTierSetting;
		snapshotLines: { total: number; global: number; project: number; team: number };
		embedding: ProviderModelRef | null;
		rerank: ProviderModelRef | null;
	};
	dream: {
		model: string | null;
		auto: boolean;
		autoRemember: boolean;
		minHours: number;
		minEntries: number;
		maxEntriesBeforeForce: number;
		evalSessions: number;
		canaries: string;
		rulesCap: number;
		retireAfterDays: number;
	};
}

export const DEFAULT_SETTINGS: MuninnSettings = {
	scopes: { global: true, project: "auto", team: { remote: null, pin: null } },
	sync: { remote: null, onShutdown: true },
	// `toolFacts` is off: nothing reads it yet. Tool-derived facts are deferred
	// until the classifier budget is understood, and a setting that defaults to
	// true while no code path honours it tells the operator that environment
	// discoveries are being remembered when they are not.
	capture: { corrections: true, outcomes: true, toolFacts: false, externalPerSession: 10 },
	recall: {
		factsPerTurn: 8,
		tokenBudget: 1500,
		indexTier: "auto",
		snapshotLines: { total: 200, global: 120, project: 60, team: 20 },
		embedding: null,
		rerank: null,
	},
	dream: {
		model: null,
		auto: false,
		autoRemember: false,
		minHours: 24,
		minEntries: 5,
		maxEntriesBeforeForce: 50,
		evalSessions: 5,
		canaries: "eval/canaries.md",
		rulesCap: 60,
		retireAfterDays: 90,
	},
};

export type SettingsScope = "global" | "project";

export type SettingsWarningKind =
	| "parse-error"
	| "not-an-object"
	| "unknown-key"
	| "invalid-type"
	| "invalid-value"
	| "not-tightening";

export interface SettingsWarning {
	/** Dotted path of the offending key, e.g. `recall.factsPerTurn`. */
	path: string;
	scope: SettingsScope;
	kind: SettingsWarningKind;
	message: string;
}

export interface LoadedSettings {
	settings: MuninnSettings;
	warnings: SettingsWarning[];
}

// ---------------------------------------------------------------------------
// Field policy
// ---------------------------------------------------------------------------

/**
 * What a project settings file may do to a field.
 *
 * `lower-only` — the project value must be no *wider* than the global one.
 *   Width is a rank: numbers rank by value, booleans false < true, index tiers
 *   "0" < "1" < "auto". Disabling a capture kind, shrinking a budget and
 *   pinning a lower retrieval tier are all the same operation under this rule.
 *
 * `global-only` — the project file may not set it at all. Used where a project
 *   value would widen behaviour in a way no ranking captures: naming a sync
 *   remote (where memory would be pushed), naming an embedding or rerank
 *   endpoint (where memory would be sent), or choosing the dreamer model (which
 *   model gets to read the whole store).
 */
type FieldPolicy = "lower-only" | "global-only";

type FieldType = "boolean" | "number" | "string" | "string-or-null" | "index-tier" | "project-scope" | "provider-model";

interface FieldSpec {
	type: FieldType;
	policy: FieldPolicy;
	/** Numbers only: inclusive bounds. */
	min?: number;
	max?: number;
}

/**
 * Every settable leaf, by dotted path. A key not listed here is unknown and is
 * reported rather than silently ignored — a typo in `settings.json` should not
 * look like a working setting.
 *
 * `scopes.project` is the one field whose policy is not a rank: where a project
 * store lives is the project's own business, so any location is accepted — but
 * a project may not enable project scope when it is globally off. That is
 * handled in `applyProjectScope`, not by a rank.
 */
const FIELDS: Record<string, FieldSpec> = {
	"scopes.global": { type: "boolean", policy: "lower-only" },
	"scopes.project": { type: "project-scope", policy: "lower-only" },
	"scopes.team.remote": { type: "string-or-null", policy: "global-only" },
	"scopes.team.pin": { type: "string-or-null", policy: "global-only" },

	"sync.remote": { type: "string-or-null", policy: "global-only" },
	"sync.onShutdown": { type: "boolean", policy: "lower-only" },

	"capture.corrections": { type: "boolean", policy: "lower-only" },
	"capture.outcomes": { type: "boolean", policy: "lower-only" },
	"capture.toolFacts": { type: "boolean", policy: "lower-only" },
	"capture.externalPerSession": { type: "number", policy: "lower-only", min: 0, max: 1000 },

	"recall.factsPerTurn": { type: "number", policy: "lower-only", min: 0, max: 100 },
	"recall.tokenBudget": { type: "number", policy: "lower-only", min: 0, max: 100_000 },
	"recall.indexTier": { type: "index-tier", policy: "lower-only" },
	"recall.snapshotLines.total": { type: "number", policy: "lower-only", min: 0, max: 10_000 },
	"recall.snapshotLines.global": { type: "number", policy: "lower-only", min: 0, max: 10_000 },
	"recall.snapshotLines.project": { type: "number", policy: "lower-only", min: 0, max: 10_000 },
	"recall.snapshotLines.team": { type: "number", policy: "lower-only", min: 0, max: 10_000 },
	"recall.embedding": { type: "provider-model", policy: "global-only" },
	"recall.rerank": { type: "provider-model", policy: "global-only" },

	// Phase 1 reads but does not act on `dream`. Every field is global-only for
	// now; per-field tightening semantics are decided in Phase 2, when dreams
	// exist and the fields mean something.
	"dream.model": { type: "string-or-null", policy: "global-only" },
	"dream.auto": { type: "boolean", policy: "global-only" },
	"dream.autoRemember": { type: "boolean", policy: "global-only" },
	"dream.minHours": { type: "number", policy: "global-only", min: 0, max: 8760 },
	"dream.minEntries": { type: "number", policy: "global-only", min: 0, max: 100_000 },
	"dream.maxEntriesBeforeForce": { type: "number", policy: "global-only", min: 0, max: 100_000 },
	"dream.evalSessions": { type: "number", policy: "global-only", min: 0, max: 1000 },
	"dream.canaries": { type: "string", policy: "global-only" },
	"dream.rulesCap": { type: "number", policy: "global-only", min: 0, max: 10_000 },
	"dream.retireAfterDays": { type: "number", policy: "global-only", min: 0, max: 3650 },
};

const INDEX_TIER_RANK: Record<IndexTierSetting, number> = { "0": 0, "1": 1, auto: 2 };
const PROJECT_SCOPE_VALUES: ReadonlyArray<ProjectScopeSetting> = [false, "auto", "separate", "in-repo"];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Flatten the leaves listed in FIELDS out of a nested settings object. */
function collectLeaves(
	raw: Record<string, unknown>,
	scope: SettingsScope,
	warnings: SettingsWarning[],
): Map<string, unknown> {
	const found = new Map<string, unknown>();
	const walk = (node: Record<string, unknown>, prefix: string): void => {
		for (const [key, value] of Object.entries(node)) {
			const path = prefix ? `${prefix}.${key}` : key;
			if (FIELDS[path]) {
				found.set(path, value);
				continue;
			}
			// Not a leaf: recurse if anything below it is one.
			const hasChildren = Object.keys(FIELDS).some((f) => f.startsWith(`${path}.`));
			if (hasChildren && isPlainObject(value)) {
				walk(value, path);
				continue;
			}
			warnings.push({
				path,
				scope,
				kind: "unknown-key",
				message: hasChildren ? `expected an object at "${path}", ignoring` : `unknown setting "${path}", ignoring`,
			});
		}
	};
	walk(raw, "");
	return found;
}

interface Validated {
	ok: boolean;
	value?: unknown;
}

function validate(
	path: string,
	spec: FieldSpec,
	value: unknown,
	scope: SettingsScope,
	warnings: SettingsWarning[],
): Validated {
	const bad = (kind: SettingsWarningKind, message: string): Validated => {
		warnings.push({ path, scope, kind, message });
		return { ok: false };
	};

	switch (spec.type) {
		case "boolean":
			return typeof value === "boolean" ? { ok: true, value } : bad("invalid-type", `"${path}" must be a boolean`);
		case "number": {
			if (typeof value !== "number" || !Number.isFinite(value)) {
				return bad("invalid-type", `"${path}" must be a number`);
			}
			const min = spec.min ?? Number.NEGATIVE_INFINITY;
			const max = spec.max ?? Number.POSITIVE_INFINITY;
			if (value < min || value > max) {
				return bad("invalid-value", `"${path}" must be between ${min} and ${max}`);
			}
			return { ok: true, value };
		}
		case "string":
			return typeof value === "string" ? { ok: true, value } : bad("invalid-type", `"${path}" must be a string`);
		case "string-or-null":
			return typeof value === "string" || value === null
				? { ok: true, value }
				: bad("invalid-type", `"${path}" must be a string or null`);
		case "index-tier":
			return value === "auto" || value === "0" || value === "1"
				? { ok: true, value }
				: bad("invalid-value", `"${path}" must be one of "auto", "0", "1"`);
		case "project-scope":
			return PROJECT_SCOPE_VALUES.includes(value as ProjectScopeSetting)
				? { ok: true, value }
				: bad("invalid-value", `"${path}" must be one of false, "auto", "separate", "in-repo"`);
		case "provider-model": {
			if (value === null) return { ok: true, value };
			if (!isPlainObject(value) || typeof value.provider !== "string" || typeof value.model !== "string") {
				return bad("invalid-type", `"${path}" must be null or { provider, model }`);
			}
			return { ok: true, value: { provider: value.provider, model: value.model } };
		}
	}
}

/** Width rank for the `lower-only` policy. Higher means wider. */
function rank(spec: FieldSpec, value: unknown): number | null {
	switch (spec.type) {
		case "boolean":
			return value === true ? 1 : 0;
		case "number":
			return typeof value === "number" ? value : null;
		case "index-tier":
			return INDEX_TIER_RANK[value as IndexTierSetting] ?? null;
		default:
			return null;
	}
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
	const parts = path.split(".");
	let node = target;
	for (let i = 0; i < parts.length - 1; i++) {
		const key = parts[i] as string;
		const next = node[key];
		if (!isPlainObject(next)) throw new Error(`settings shape mismatch at ${path}`);
		node = next;
	}
	node[parts[parts.length - 1] as string] = value;
}

function getPath(source: Record<string, unknown>, path: string): unknown {
	let node: unknown = source;
	for (const key of path.split(".")) {
		if (!isPlainObject(node)) return undefined;
		node = node[key];
	}
	return node;
}

/**
 * Merge raw `muninn` blocks from global and project settings over the defaults.
 *
 * Pure: no filesystem, no pi. `globalRaw` / `projectRaw` are whatever was found
 * under the `muninn` key, or `undefined` when the file or key is absent.
 */
export function resolveSettings(globalRaw: unknown, projectRaw: unknown): LoadedSettings {
	const warnings: SettingsWarning[] = [];
	const settings = structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;

	// --- global: anything valid wins ---------------------------------------
	if (globalRaw !== undefined) {
		if (!isPlainObject(globalRaw)) {
			warnings.push({ path: "muninn", scope: "global", kind: "not-an-object", message: "`muninn` must be an object" });
		} else {
			for (const [path, value] of collectLeaves(globalRaw, "global", warnings)) {
				const spec = FIELDS[path] as FieldSpec;
				const result = validate(path, spec, value, "global", warnings);
				if (result.ok) setPath(settings, path, result.value);
			}
		}
	}

	// --- project: tighten-only ---------------------------------------------
	if (projectRaw !== undefined) {
		if (!isPlainObject(projectRaw)) {
			warnings.push({
				path: "muninn",
				scope: "project",
				kind: "not-an-object",
				message: "`muninn` must be an object",
			});
		} else {
			for (const [path, value] of collectLeaves(projectRaw, "project", warnings)) {
				const spec = FIELDS[path] as FieldSpec;
				const result = validate(path, spec, value, "project", warnings);
				if (!result.ok) continue;

				if (spec.policy === "global-only") {
					warnings.push({
						path,
						scope: "project",
						kind: "not-tightening",
						message: `"${path}" can only be set in global settings; project value ignored`,
					});
					continue;
				}

				if (path === "scopes.project") {
					applyProjectScope(settings, result.value as ProjectScopeSetting, warnings);
					continue;
				}

				const current = getPath(settings, path);
				const projectRank = rank(spec, result.value);
				const currentRank = rank(spec, current);
				if (projectRank === null || currentRank === null) {
					warnings.push({
						path,
						scope: "project",
						kind: "not-tightening",
						message: `"${path}" cannot be narrowed by a project; project value ignored`,
					});
					continue;
				}
				if (projectRank > currentRank) {
					warnings.push({
						path,
						scope: "project",
						kind: "not-tightening",
						message: `project settings may only lower "${path}" (global ${String(current)}, project ${String(result.value)}); project value ignored`,
					});
					continue;
				}
				setPath(settings, path, result.value);
			}
		}
	}

	return { settings: settings as unknown as MuninnSettings, warnings };
}

/**
 * Where a project store lives is the project's own business, so any location is
 * accepted — but a project may not switch project scope back on when the user
 * turned it off globally.
 */
function applyProjectScope(
	settings: Record<string, unknown>,
	value: ProjectScopeSetting,
	warnings: SettingsWarning[],
): void {
	if (getPath(settings, "scopes.project") === false && value !== false) {
		warnings.push({
			path: "scopes.project",
			scope: "project",
			kind: "not-tightening",
			message: "project scope is disabled globally; project value ignored",
		});
		return;
	}
	setPath(settings, "scopes.project", value);
}

/**
 * Pull the `muninn` block out of a parsed `settings.json`.
 * Returns `undefined` when the file had no `muninn` key.
 */
export function extractMuninnBlock(parsed: unknown): unknown {
	if (!isPlainObject(parsed)) return undefined;
	return parsed.muninn;
}
