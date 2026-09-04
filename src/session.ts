/**
 * What Muninn knows about the session it is attached to.
 *
 * One place resolves host identity, settings, scopes and stores, so the command
 * handlers and (from step 5) the capture path all see the same answer, and so
 * the expensive parts happen once per session rather than once per turn.
 */
import { scanJournal } from "./journal/jsonl.ts";
import { type ResolvedProject, resolveLogicalProject } from "./project/resolver.ts";
import { type LoadedSettingsWithSources, loadSettings } from "./settings-io.ts";
import { type HostIdentity, loadHostIdentity } from "./store/host.ts";
import { ensureStore, projectStoreIdentity } from "./store/init.ts";
import { storeExistsAt } from "./store/paths.ts";
import { resolveScopes, type ScopeDecision } from "./store/scopes.ts";

export interface SessionContext {
	host: HostIdentity;
	loaded: LoadedSettingsWithSources;
	/** Logical project selected from the user registry, if this session has one. */
	project?: ResolvedProject;
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

	let project: ResolvedProject | undefined;
	if (loaded.settings.scopes.project !== false && options.projectTrusted) {
		try {
			project = await resolveLogicalProject({
				agentDir: options.agentDir,
				cwd: options.cwd,
				hostId: host.id,
				create: options.createStores,
			});
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
		}
	}
	const scopes = resolveScopes({
		settings: loaded.settings,
		agentDir: options.agentDir,
		project,
		projectTrusted: options.projectTrusted,
		storeExists: storeExistsAt,
	});

	if (options.createStores && project) {
		// Stores are owned repositories with separate locks, and this is
		// on the path to the first keystroke, so they open side by side.
		await Promise.all(
			scopes.active.map(async (scope) => {
				try {
					const result = await ensureStore(scope.path, projectStoreIdentity(project, host));
					scope.exists = true;
					problems.push(...result.problems.map((problem) => `${scope.scope} store: ${problem}`));
				} catch (error) {
					// A store that cannot be opened means memory is not working for
					// that scope. Report it and carry on with the scopes that do work
					// rather than taking the session down.
					problems.push(
						`${scope.scope} store at ${scope.path}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}),
		);
	}

	return { host, loaded, ...(project ? { project } : {}), scopes, problems };
}

export interface ScopeJournalStats {
	scope: string;
	path: string;
	entries: number;
	problems: string[];
}

/**
 * Record counts per active scope.
 *
 * Computed on demand for `/muninn` only, never at session start: counting means
 * parsing every daily file, and a session must not pay for a number nobody
 * asked to see.
 */
export function journalStats(session: SessionContext): ScopeJournalStats[] {
	return session.scopes.active.map((scope) => {
		const read = scanJournal(scope.path);
		return {
			scope: scope.scope,
			path: scope.path,
			entries: read.records.length,
			problems: read.problems.map((problem) => `${problem.kind}: ${problem.message}`),
		};
	});
}
