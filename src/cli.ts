#!/usr/bin/env node
/**
 * `muninn` — the headless half.
 *
 * Two commands, no pi session: `muninn sync` for a cron job or a shell, and
 * `muninn status` for looking at a store without starting an agent. Both use
 * the same modules the extension does, so there is one implementation of "what
 * does sync do" and one of "what is in this store".
 *
 * Runnable straight from source: Node ≥ 22.19 strips the types, which is also
 * how pi loads the extension itself.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR, resolveAgentDir } from "./agent-dir.ts";
import { gitToplevel } from "./git.ts";
import { claimsOf } from "./journal/format.ts";
import { readStoreJournal } from "./journal/read.ts";
import { loadSettings } from "./settings-io.ts";
import { loadHostIdentity } from "./store/host.ts";
import { storeIdentity } from "./store/init.ts";
import { storeExistsAt } from "./store/paths.ts";
import { type CaptureTarget, resolveScopes } from "./store/scopes.ts";
import { describeSync, sync } from "./sync/sync.ts";
import { MUNINN_VERSION } from "./version.ts";

const USAGE = [
	`muninn ${MUNINN_VERSION}`,
	"",
	"  muninn sync [--scope global|project] [--no-push]   commit, fetch, rebase, push",
	"  muninn status [--scope global|project]             what is in the store",
	"",
	"Runs without a pi session. The store is chosen the way a session would choose",
	"it: global always, project when the working directory is inside a git",
	"repository that already has one.",
].join("\n");

export interface CliResult {
	code: number;
	out: string[];
	err: string[];
}

/**
 * The CLI as a function, so a test does not have to spawn a process to find out
 * what it prints.
 */
export async function runCli(argv: readonly string[], cwd: string = process.cwd()): Promise<CliResult> {
	const out: string[] = [];
	const err: string[] = [];
	const args = [...argv];
	const command = args.shift() ?? "help";

	if (command === "help" || command === "--help" || command === "-h") return { code: 0, out: [USAGE], err };
	if (command === "version" || command === "--version") return { code: 0, out: [MUNINN_VERSION], err };
	if (command !== "sync" && command !== "status") {
		return { code: 2, out, err: [`muninn: unknown command "${command}"`, "", USAGE] };
	}

	const wanted = scopeFlag(args);
	if (wanted === "invalid") return { code: 2, out, err: ['muninn: --scope takes "global" or "project"'] };
	const noPush = args.includes("--no-push");

	const agentDir = resolveAgentDir();
	const host = loadHostIdentity(agentDir);
	const loaded = loadSettings({ agentDir, cwd, configDirName: CONFIG_DIR });
	const toplevel = await gitToplevel(cwd);
	const scopes = resolveScopes({
		settings: loaded.settings,
		agentDir,
		configDirName: CONFIG_DIR,
		toplevel,
		// There is no session to prompt for trust, so the CLI only ever touches a
		// project store that already exists — which is a store this machine has
		// already decided to have.
		projectTrusted: true,
		storeExists: storeExistsAt,
	});

	const targets = scopes.active.filter((scope) => scope.exists && (wanted === undefined || scope.scope === wanted));
	if (targets.length === 0) {
		err.push(wanted ? `muninn: no ${wanted} store exists here` : "muninn: no memory store exists here");
		return { code: 1, out, err };
	}

	let code = 0;
	for (const scope of targets) {
		out.push(`${scope.scope}: ${scope.path}`);

		if (command === "status") {
			const journal = readStoreJournal(scope.path);
			const claims = journal.entries.reduce((total, entry) => total + claimsOf(entry).length, 0);
			out.push(`  ${journal.entries.length} entries, ${claims} claims`);
			const remote = scope.scope === "global" ? loaded.settings.sync.remote : null;
			out.push(
				`  remote: ${remote ?? (scope.scope === "global" ? "none configured (sync.remote)" : "the store's own origin, if it has one")}`,
			);
			for (const problem of journal.problems) err.push(`  ! ${problem.kind}: ${problem.message}`);
			continue;
		}

		const result = await sync({
			storePath: scope.path,
			hostId: host.id,
			hostName: host.name,
			// See `sync.ts`: the setting is the global store's remote; a project
			// store uses the `origin` it already has, and never an in-repo one.
			remote: scope.scope === "global" ? loaded.settings.sync.remote : null,
			useExistingRemote: !scope.inRepo,
			...(noPush ? { noPush: true } : {}),
			...(scope.inRepo ? {} : { identity: storeIdentity(host) }),
		});
		for (const note of result.notes) out.push(`  ${note}`);
		out.push(`  ${describeSync(result)}`);
		// Offline is a normal outcome for a laptop: the journal is committed and
		// the next run carries it. Anything else that stopped sync is a failure a
		// cron job ought to be able to notice.
		if (result.problem && !result.offline) code = 1;
	}

	for (const warning of loaded.warnings) err.push(`  ! [${warning.scope}] ${warning.message}`);
	return { code, out, err };
}

function scopeFlag(args: string[]): CaptureTarget | undefined | "invalid" {
	const at = args.indexOf("--scope");
	if (at === -1) return undefined;
	const value = args[at + 1];
	if (value === "global" || value === "project") return value;
	return "invalid";
}

/** True when this file is the program being run, rather than an import. */
function isMain(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isMain()) {
	const result = await runCli(process.argv.slice(2));
	if (result.out.length > 0) process.stdout.write(`${result.out.join("\n")}\n`);
	if (result.err.length > 0) process.stderr.write(`${result.err.join("\n")}\n`);
	process.exit(result.code);
}
