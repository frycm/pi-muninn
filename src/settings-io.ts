/**
 * Reading Muninn settings off disk.
 *
 * Kept apart from `settings.ts` so the merge rules stay pure and testable, and
 * so nothing here needs pi: the caller supplies the agent directory and cwd,
 * which `index.ts` takes from pi's `getAgentDir()` and `CONFIG_DIR_NAME`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	extractMuninnBlock,
	type LoadedSettings,
	resolveSettings,
	type SettingsScope,
	type SettingsWarning,
} from "./settings.ts";

export interface SettingsSource {
	path: string;
	/** false when the file does not exist — the common case, not an error. */
	present: boolean;
	/** true when the file exists and carries a `muninn` key. */
	hasMuninnBlock: boolean;
}

export interface LoadedSettingsWithSources extends LoadedSettings {
	sources: { global: SettingsSource; project: SettingsSource };
}

interface ReadResult {
	block: unknown;
	source: SettingsSource;
}

/**
 * pi parses `settings.json` with plain `JSON.parse`
 * (core/settings-manager.ts:372), so comments are not allowed and Muninn must
 * not accept what pi would reject — a file that loads here but breaks pi would
 * be worse than a clear error.
 */
function readSettingsFile(path: string, scope: SettingsScope, warnings: SettingsWarning[]): ReadResult {
	let content: string;
	try {
		content = readFileSync(path, "utf-8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") {
			warnings.push({
				path: "muninn",
				scope,
				kind: "parse-error",
				message: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
		return { block: undefined, source: { path, present: false, hasMuninnBlock: false } };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		warnings.push({
			path: "muninn",
			scope,
			kind: "parse-error",
			message: `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}); using defaults for this scope`,
		});
		return { block: undefined, source: { path, present: true, hasMuninnBlock: false } };
	}

	const block = extractMuninnBlock(parsed);
	return { block, source: { path, present: true, hasMuninnBlock: block !== undefined } };
}

export interface LoadSettingsOptions {
	/** pi's agent directory, e.g. `~/.pi/agent` (from `getAgentDir()`). */
	agentDir: string;
	/** Session cwd — the project settings file is `<cwd>/<configDirName>/settings.json`, matching pi. */
	cwd: string;
	/** pi's config directory name, e.g. `.pi` (from `CONFIG_DIR_NAME`). */
	configDirName: string;
}

/** Read both settings files and resolve them into effective Muninn settings. */
export function loadSettings(options: LoadSettingsOptions): LoadedSettingsWithSources {
	const warnings: SettingsWarning[] = [];
	const globalRead = readSettingsFile(join(options.agentDir, "settings.json"), "global", warnings);
	const projectRead = readSettingsFile(join(options.cwd, options.configDirName, "settings.json"), "project", warnings);

	const resolved = resolveSettings(globalRead.block, projectRead.block);
	return {
		settings: resolved.settings,
		warnings: [...warnings, ...resolved.warnings],
		sources: { global: globalRead.source, project: projectRead.source },
	};
}
