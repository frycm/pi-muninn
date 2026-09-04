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
 * the machine that clones it: it cannot re-enable something the user disabled
 * globally. It can always ask for *less*. Journal remotes live in the explicit,
 * user-owned project manifest rather than settings.
 */

/** Automatically use a user-owned logical-project store, or disable it. */
export type ProjectScopeSetting = false | "auto";

export interface MuninnSettings {
	scopes: {
		project: ProjectScopeSetting;
	};
	sync: { onShutdown: boolean };
	capture: {
		corrections: boolean;
		outcomes: boolean;
	};
}

export const DEFAULT_SETTINGS: MuninnSettings = {
	scopes: { project: "auto" },
	sync: { onShutdown: true },
	capture: { corrections: true, outcomes: true },
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
	/** Dotted path of the offending key, e.g. `capture.outcomes`. */
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
 *   Width is a rank: booleans false < true. Disabling a capture kind is a
 *   tightening operation under this rule.
 *
 */
type FieldType = "boolean" | "project-scope";

interface FieldSpec {
	type: FieldType;
}

/**
 * Every settable leaf, by dotted path. A key not listed here is unknown and is
 * reported rather than silently ignored — a typo in `settings.json` should not
 * look like a working setting.
 *
 * A project may disable its journal but cannot select its UUID, filesystem
 * path, or remote. Those are user-owned registry decisions outside the repo.
 */
const FIELDS: Record<string, FieldSpec> = {
	"scopes.project": { type: "project-scope" },
	"sync.onShutdown": { type: "boolean" },

	"capture.corrections": { type: "boolean" },
	"capture.outcomes": { type: "boolean" },
};

const PROJECT_SCOPE_VALUES: ReadonlyArray<ProjectScopeSetting> = [false, "auto"];

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
		case "project-scope":
			return PROJECT_SCOPE_VALUES.includes(value as ProjectScopeSetting)
				? { ok: true, value }
				: bad("invalid-value", `"${path}" must be false or "auto"`);
	}
}

/** The same rule `git.ts` enforces before handing a URL to git. */
export function isUsableRemote(url: string): boolean {
	const trimmed = url.trim();
	return trimmed !== "" && !trimmed.startsWith("-") && !/^ext::/i.test(trimmed);
}

/** Width rank for the `lower-only` policy. Higher means wider. */
function rank(spec: FieldSpec, value: unknown): number | null {
	switch (spec.type) {
		case "boolean":
			return value === true ? 1 : 0;
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
 * A project may switch its own journal off, but may not switch it back on when
 * the user turned it off globally.
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
