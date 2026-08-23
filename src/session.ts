/**
 * What Muninn knows about the session it is attached to.
 *
 * One place resolves host identity, settings, scopes and stores, so the command
 * handlers and (from step 5) the capture path all see the same answer, and so
 * the expensive parts happen once per session rather than once per turn.
 */
import { existsSync } from "node:fs";
import { gitToplevel } from "./git.ts";
import { type LoadedSettingsWithSources, loadSettings } from "./settings-io.ts";
import { type HostIdentity, loadHostIdentity } from "./store/host.ts";
import { ensureStore } from "./store/init.ts";
import { resolveScopes, type ScopeDecision } from "./store/scopes.ts";

export interface SessionContext {
	host: HostIdentity;
	loaded: LoadedSettingsWithSources;
	scopes: ScopeDecision;
	/** Non-fatal problems worth telling the user about, beyond settings warnings. */
	problems: string[];
}

export interface BuildSessionContextOptions {
	agentDir: string;
	cwd: string;
	configDirName: string;
	projectTrusted: boolean;
	/**
	 * Create any store that is active but missing. False for read-only paths
	 * such as `/muninn scope`, which must be able to explain the situation
	 * without changing it.
	 */
	createStores: boolean;
}

export async function buildSessionContext(options: BuildSessionContextOptions): Promise<SessionContext> {
	const problems: string[] = [];
	const host = loadHostIdentity(options.agentDir);
	const loaded = loadSettings({
		agentDir: options.agentDir,
		cwd: options.cwd,
		configDirName: options.configDirName,
	});

	const toplevel = await gitToplevel(options.cwd);
	const scopes = resolveScopes({
		settings: loaded.settings,
		agentDir: options.agentDir,
		configDirName: options.configDirName,
		toplevel,
		projectTrusted: options.projectTrusted,
		storeExists: (path) => existsSync(path),
	});

	if (options.createStores) {
		for (const scope of scopes.active) {
			try {
				const result = await ensureStore(scope.path, { host, inRepo: scope.inRepo });
				scope.exists = true;
				problems.push(...result.problems.map((problem) => `${scope.scope} store: ${problem}`));
			} catch (error) {
				// A store that cannot be opened means memory is not working for that
				// scope. Report it and carry on with the scopes that do work rather
				// than taking the session down.
				problems.push(
					`${scope.scope} store at ${scope.path}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	return { host, loaded, scopes, problems };
}
