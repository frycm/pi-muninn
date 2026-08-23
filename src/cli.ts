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
import { dream } from "./dream/dream.ts";
import { forget, listDreams } from "./dream/dreams.ts";
import { erase, eraseImpact } from "./dream/erase.ts";
import type { DreamModel } from "./dream/model.ts";
import { headlessModel } from "./dream/pi-model.ts";
import { formatQualify, qualify } from "./dream/qualify.ts";
import { remember } from "./dream/remember.ts";
import { reportTotals } from "./dream/report.ts";
import { gitToplevel } from "./git.ts";
import { newStoreId } from "./ids.ts";
import { claimsOf } from "./journal/format.ts";
import { readStoreJournal } from "./journal/read.ts";
import type { MuninnSettings } from "./settings.ts";
import { loadSettings } from "./settings-io.ts";
import type { HostIdentity } from "./store/host.ts";
import { loadHostIdentity } from "./store/host.ts";
import { storeIdentity } from "./store/init.ts";
import { storeExistsAt } from "./store/paths.ts";
import { type ActiveScope, type CaptureTarget, resolveScopes } from "./store/scopes.ts";
import { describeSync, sync } from "./sync/sync.ts";
import { MUNINN_VERSION } from "./version.ts";

const USAGE = [
	`muninn ${MUNINN_VERSION}`,
	"",
	"  muninn sync [--scope global|project] [--no-push]   commit, fetch, rebase, push",
	"  muninn status [--scope global|project]             what is in the store",
	"  muninn dream [--scope s] [--force]                 consolidate the journal onto a branch",
	"  muninn dream --qualify                             score the configured model on the fixture store",
	"  muninn dreams [--scope s]                          list dreams, remembered and pending",
	"  muninn dreams remember <stamp>                     fast-forward main to a dream",
	"  muninn dreams forget <stamp>                       revert a remembered dream",
	"  muninn erase <entry id> --yes --yes [--no-rewrite] privacy erasure (confirms twice)",
	"",
	"Runs without a pi session. The store is chosen the way a session would choose",
	"it: global always, project when the working directory is inside a git",
	"repository that already has one. `dream` needs pi installed for its model;",
	"`sync` does not, and does not load it.",
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
	const KNOWN = new Set(["sync", "status", "dream", "dreams", "erase"]);
	if (!KNOWN.has(command)) {
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

		if (command === "dream") {
			code = Math.max(code, await runDream(scope, { host, settings: loaded.settings, agentDir, args, out, err }));
			continue;
		}
		if (command === "dreams") {
			code = Math.max(code, await runDreams(scope, { host, args, out, err }));
			continue;
		}
		if (command === "erase") {
			code = Math.max(code, await runErase(scope, { host, settings: loaded.settings, args, out, err }));
			continue;
		}

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

// ---------------------------------------------------------------------------
// Dreaming, from the shell
// ---------------------------------------------------------------------------

interface SubcommandContext {
	host: HostIdentity;
	settings: MuninnSettings;
	agentDir: string;
	args: string[];
	out: string[];
	err: string[];
}

/**
 * `muninn dream` — the headless dream, which is the one the design is aimed at.
 *
 * The recommended deployment is a server running `muninn sync && muninn dream
 * --scope global && muninn sync` nightly, so everything here has to be legible
 * from a cron log: one line per phase, the branch name at the end, and an exit
 * code that means something.
 */
async function runDream(
	scope: ActiveScope,
	context: Omit<SubcommandContext, "settings"> & { settings: MuninnSettings },
): Promise<number> {
	const { host, settings, agentDir, args, out, err } = context;
	const ref = settings.dream.model;

	if (args.includes("--qualify")) {
		if (ref === null) {
			err.push("  ! dream.model is not set, so there is no model to qualify");
			return 1;
		}
		const resolved = await headlessModel({ ref, agentDir });
		if (!resolved.ok) {
			err.push(`  ! ${resolved.problem}`);
			return 1;
		}
		const fixture = fileURLToPath(new URL("../test/fixtures/qualify", import.meta.url));
		const result = await qualify({ fixture, model: resolved.model, settings, now: new Date() });
		out.push(formatQualify(result));
		return result.passed ? 0 : 1;
	}

	if (ref === null) {
		// Not an error: a dream with no model still commits the journal, records
		// the range and writes a report. It just consolidates nothing, and says
		// so rather than pretending it had nothing to do.
		err.push("  ! dream.model is not set — this dream will gather but not consolidate");
	}

	let model: DreamModel | undefined;
	if (ref !== null) {
		const resolved = await headlessModel({ ref, agentDir });
		if (!resolved.ok) {
			err.push(`  ! ${resolved.problem}`);
			return 1;
		}
		model = resolved.model;
	}

	const result = await dream({
		scope,
		agentDir,
		host,
		storeId: newStoreId(),
		settings,
		now: new Date(),
		...(model ? { model } : {}),
		progress: (phase) => out.push(`  ${phase}…`),
	});

	for (const line of result.report.gathered) out.push(`  ${line}`);
	for (const change of result.report.consolidated) {
		out.push(`  ${change.topic}: +${change.added} fact(s), ${change.superseded} superseded`);
	}
	for (const finding of result.report.lint) {
		(finding.blocking ? err : out).push(`  ${finding.blocking ? "!" : "-"} ${finding.rule}: ${finding.message}`);
	}
	for (const skip of result.report.skipped) err.push(`  ! skipped ${skip.topic}: ${skip.reason}`);
	for (const problem of result.problems) err.push(`  ! ${problem}`);

	if (!result.ok) return 1;
	out.push(`  ${result.branch} — review with \`muninn dreams\`, apply with \`muninn dreams remember ${result.stamp}\``);
	return result.report.status === "lint-blocked" ? 1 : 0;
}

/** `muninn dreams [remember|forget <stamp>]`. */
async function runDreams(
	scope: ActiveScope,
	context: Pick<SubcommandContext, "host" | "args" | "out" | "err">,
): Promise<number> {
	const { host, args, out, err } = context;
	const action = args.find((arg) => arg === "remember" || arg === "forget");

	if (action === undefined) {
		const listed = await listDreams(scope.path);
		if (listed.length === 0) {
			out.push("  no dreams yet");
			return 0;
		}
		for (const entry of listed) {
			const state = entry.forgotten ? "forgotten" : entry.remembered ? "remembered" : "pending";
			const totals = entry.report ? reportTotals(entry.report) : undefined;
			const shape = totals ? `${totals.added} fact(s), ${totals.superseded} superseded` : "no report";
			const blocking = entry.report?.lint.filter((finding) => finding.blocking).length ?? 0;
			out.push(`  ${entry.stamp}  ${state.padEnd(11)} ${shape}${blocking > 0 ? ` · ${blocking} blocking` : ""}`);
		}
		return 0;
	}

	// The next argument, unless it is a flag: `dreams remember --scope global`
	// would otherwise take "--scope" for a dream stamp and report that no such
	// dream exists, which is true and useless.
	const next = args[args.indexOf(action) + 1];
	const stamp = next === undefined || next.startsWith("-") ? undefined : next;
	if (stamp === undefined) {
		err.push(`  ! ${action} needs a dream stamp; run \`muninn dreams\` to see them`);
		return 2;
	}

	if (action === "forget") {
		const result = await forget({ scope, host, stamp, now: new Date() });
		for (const note of result.notes) out.push(`  ${note}`);
		for (const problem of result.problems) err.push(`  ! ${problem}`);
		return result.ok ? 0 : 1;
	}

	const listing = (await listDreams(scope.path)).find((entry) => entry.stamp === stamp);
	if (listing?.branch === undefined) {
		err.push(`  ! no pending dream ${stamp} in this store`);
		return 1;
	}
	if (listing.report?.status === "lint-blocked") {
		// Blocked at lint means a fact in it cannot be traced to the journal.
		// Remembering it anyway is a decision, and not one a flag should make
		// quietly, so there is no flag.
		err.push(`  ! ${stamp} failed lint; fix or discard it rather than remembering it`);
		return 1;
	}
	const result = await remember({ scope, agentDir: resolveAgentDir(), host, branch: listing.branch });
	for (const note of result.notes) out.push(`  ${note}`);
	for (const problem of result.problems) err.push(`  ! ${problem}`);
	if (result.ok) out.push(`  remembered ${stamp}; the new MEMORY.md is read by the next session`);
	return result.ok ? 0 : 1;
}

/**
 * `muninn erase <id> --yes --yes`.
 *
 * Two confirmations, because there is no undo: the flag has to be given twice.
 * The impact is printed first either way, so the second `--yes` is a decision
 * about something specific.
 */
async function runErase(
	scope: ActiveScope,
	context: Pick<SubcommandContext, "host" | "settings" | "args" | "out" | "err">,
): Promise<number> {
	const { host, settings, args, out, err } = context;
	const entryId = args.find((arg) => arg.startsWith("j-"));
	if (entryId === undefined) {
		err.push("  ! erase needs a journal entry id (j-…)");
		return 2;
	}

	const impact = eraseImpact(scope.path, entryId);
	out.push(`  ${entryId}: ${impact.claims.length} claim(s), ${impact.facts.length} fact(s) resting on them`);

	if (args.filter((arg) => arg === "--yes").length < 2) {
		err.push("  ! erasure rewrites history and cannot be undone; pass --yes twice to confirm");
		return 2;
	}

	const result = await erase({
		scope,
		host,
		entryId,
		now: new Date(),
		...(args.includes("--no-rewrite") ? { noRewrite: true } : {}),
		...(settings.sync.remote ? { remote: settings.sync.remote } : {}),
	});
	for (const note of result.notes) out.push(`  ${note}`);
	for (const problem of result.problems) err.push(`  ! ${problem}`);
	return result.ok ? 0 : 1;
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
