#!/usr/bin/env node
/** `muninn` — direct human and Unix access to one logical project journal. */
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentDir } from "./agent-dir.ts";
import { commitJournal } from "./capture/commit.ts";
import {
	collectSearchRecords,
	JournalArgumentError,
	type JournalOutputMode,
	parseJournalQueryArgs,
	renderAppend,
	renderConflicts,
	renderRead,
	renderSearch,
	renderSessions,
	sessions,
	tail,
	withoutPaging,
} from "./journal/interface.ts";
import { scanJournal } from "./journal/jsonl.ts";
import { discoverLegacyStoreCandidates, inventoryLegacyStores, migrateMarkdownStores } from "./journal/migrate.ts";
import { collectGitProvenance } from "./journal/provenance.ts";
import { JournalQueryService } from "./journal/query.ts";
import type { NewJournalRecord } from "./journal/record.ts";
import { appendAuthorizedJournalRecord, appendUserRelation, resolveUserConflict } from "./journal/writer.ts";
import { runProjectCommand } from "./project/command.ts";
import { joinProjectJournal, projectShare } from "./project/onboarding.ts";
import { type ResolvedProject, resolveLogicalProject } from "./project/resolver.ts";
import { type HostIdentity, loadHostIdentity } from "./store/host.ts";
import { ensureStore, projectStoreIdentity, storeIdentity } from "./store/init.ts";
import { storeExistsAt } from "./store/paths.ts";
import { readProjectManifest, setProjectRemote } from "./store/project-manifest.ts";
import { describeSync, sync } from "./sync/sync.ts";
import { declareTeamEvent, projectTeamRoster, renderTeamRoster } from "./team/lifecycle.ts";
import { MUNINN_VERSION } from "./version.ts";

const USAGE = [
	`muninn ${MUNINN_VERSION} — project journal`,
	"",
	"  muninn search QUERY [FILTERS] [--json|--jsonl]",
	"  muninn show ID [--relations] [--json|--jsonl]",
	"  muninn sessions [FILTERS] [--json|--jsonl]",
	"  muninn tail [FILTERS] [--follow] [--jsonl]",
	"  muninn note TEXT [--json]",
	"  muninn correct ID TEXT [--json]",
	"  muninn annotate ID TEXT [--json]",
	"  muninn conflicts [--json|--jsonl]",
	"  muninn resolve TARGET TEXT [--json]",
	"  muninn path",
	"  muninn project link|show|unlink|remote [URL|--remove]",
	"  muninn project share [PATH] [--json]",
	"  muninn project join JOURNAL-URL [PATH] [--force] [--json]",
	"  muninn team list [--json]",
	"  muninn team rename-member NAME [--reason TEXT] [--json]",
	"  muninn team rename-host HOST-ID NAME [--reason TEXT] [--json]",
	"  muninn team retire-host|restore-host HOST-ID [--reason TEXT] [--json]",
	"  muninn team leave|return [--reason TEXT] [--json]",
	"  muninn migrate [--dry-run] [--json]",
	"  muninn reindex [--json]",
	"  muninn status [--json]",
	"  muninn sync [--no-push]",
	"",
	"Filters: --id --type --source --member --host --branch --path --tag --status",
	"         --since --until --related-to --limit --cursor",
	"",
	"Exit 0: success; 1: no match/store or operation failure; 2: invalid input; 3: transcript unavailable.",
].join("\n");

export interface CliResult {
	code: number;
	out: string[];
	err: string[];
}

export interface CliRunOptions {
	signal?: AbortSignal;
	/** Receives lines immediately; useful for `tail --follow`. */
	emit?: (line: string) => void;
	pollMs?: number;
}

interface ProjectContext {
	agentDir: string;
	host: HostIdentity;
	project: ResolvedProject;
	service: JournalQueryService;
}

async function projectContext(cwd: string, create: boolean, forceReindex = false): Promise<ProjectContext> {
	const agentDir = resolveAgentDir();
	const host = loadHostIdentity(agentDir);
	const project = await resolveLogicalProject({ agentDir, cwd, hostId: host.id, create });
	if (!project) throw new Error("muninn: no logical project is linked here; run `muninn project link`");
	if (create) {
		await ensureStore(project.storePath, projectStoreIdentity(project, host));
	} else if (!storeExistsAt(project.storePath)) {
		throw new Error(`muninn: project journal store does not exist at ${project.storePath}`);
	}
	return {
		agentDir,
		host,
		project,
		service: new JournalQueryService({
			storePath: project.storePath,
			localMember: project.member.id,
			mode: "index",
			forceReindex,
			transcriptRoots: [join(agentDir, "sessions")],
		}),
	};
}

/** The CLI as a function so tests and integrations can use the exact production dispatch. */
export async function runCli(
	argv: readonly string[],
	cwd: string = process.cwd(),
	options: CliRunOptions = {},
): Promise<CliResult> {
	const out: string[] = [];
	const err: string[] = [];
	const emit = (line: string) => {
		out.push(line);
		options.emit?.(line);
	};
	const args = [...argv];
	const command = args.shift() ?? "help";

	try {
		if (command === "help" || command === "--help" || command === "-h") return { code: 0, out: [USAGE], err };
		if (command === "version" || command === "--version") return { code: 0, out: [MUNINN_VERSION], err };
		if (command === "project") {
			if (args[0] === "share") {
				const parsed = parseProjectShareArgs(args.slice(1));
				const context = await projectContext(parsed.path ? resolve(cwd, parsed.path) : cwd, false);
				const shared = projectShare(context.project, readProjectManifest(context.project.storePath));
				return {
					code: 0,
					out: parsed.json
						? [JSON.stringify(shared)]
						: [
								`project: ${shared.name} · ${shared.project}`,
								`journal: ${shared.remote}`,
								`join: muninn project join ${shared.remote}`,
							],
					err,
				};
			}
			if (args[0] === "join") {
				const parsed = parseProjectJoinArgs(args.slice(1));
				const agentDir = resolveAgentDir();
				const host = loadHostIdentity(agentDir);
				const joined = await joinProjectJournal({
					agentDir,
					host,
					remote: parsed.remote,
					cwd: parsed.path ? resolve(cwd, parsed.path) : cwd,
					force: parsed.force,
				});
				const result = {
					schema: 1 as const,
					kind: "project-join" as const,
					project: joined.project.id,
					name: joined.project.name,
					member: joined.project.member.id,
					host: host.id,
					store: joined.project.storePath,
					remote: joined.remote,
					store_created: joined.storeCreated,
				};
				return {
					code: 0,
					out: parsed.json
						? [JSON.stringify(result)]
						: [
								`muninn: joined ${joined.project.name} · ${joined.project.id}`,
								`store: ${joined.project.storePath}${joined.storeCreated ? " (installed)" : " (reused)"}`,
								`member: ${joined.project.member.name} · ${joined.project.member.id}`,
								`journal: ${joined.remote}`,
							],
					err,
				};
			}
			if (args[0] === "remote") {
				const values = args.slice(1);
				if (values.length > 1) throw new JournalArgumentError("project remote takes one URL or --remove");
				const context = await projectContext(cwd, values.length > 0);
				const before = readProjectManifest(context.project.storePath);
				if (!before) throw new Error("muninn: project journal has no project.json");
				if (values.length === 0) {
					return { code: before.remote ? 0 : 1, out: [before.remote ?? "no project journal remote configured"], err };
				}
				const remote = values[0] === "--remove" ? null : (values[0] as string);
				const manifest = setProjectRemote(context.project.storePath, remote);
				await commitJournal({
					storePath: context.project.storePath,
					hostId: context.host.id,
					hostName: context.host.name,
					entries: 0,
					force: true,
					identity: storeIdentity(context.host),
				});
				return {
					code: 0,
					out: [manifest.remote ? `project journal remote: ${manifest.remote}` : "project journal remote removed"],
					err,
				};
			}
			const agentDir = resolveAgentDir();
			const host = loadHostIdentity(agentDir);
			const result = await runProjectCommand(args, { agentDir, cwd, hostId: host.id });
			return { code: result.code, out: result.out, err: result.err };
		}
		if (command === "path") {
			if (args.length > 0) throw new JournalArgumentError("path takes no arguments");
			const context = await projectContext(cwd, false);
			return { code: 0, out: [context.project.storePath], err };
		}
		if (command === "team") {
			const parsed = parseTeamArgs(args);
			const context = await projectContext(cwd, false);
			const manifest = readProjectManifest(context.project.storePath);
			if (!manifest) throw new Error("muninn: project journal has no project.json");
			if (parsed.action === "list") {
				const roster = projectTeamRoster(manifest, context.project.member.id, context.host.id);
				return { code: 0, out: parsed.json ? [JSON.stringify(roster)] : renderTeamRoster(roster), err };
			}
			const kind =
				parsed.action === "leave"
					? "member-retired"
					: parsed.action === "return"
						? "member-restored"
						: parsed.action === "rename-member"
							? "member-renamed"
							: parsed.action === "rename-host"
								? "host-renamed"
								: parsed.action === "retire-host"
									? "host-retired"
									: "host-restored";
			const declared = await declareTeamEvent({
				storePath: context.project.storePath,
				project: context.project.id,
				actorMember: context.project.member.id,
				actorHost: context.host.id,
				actorHostName: context.host.name,
				kind,
				...(parsed.host ? { host: parsed.host } : {}),
				...(parsed.name ? { name: parsed.name } : {}),
				...(parsed.reason ? { reason: parsed.reason } : {}),
			});
			return {
				code: 0,
				out: parsed.json
					? [JSON.stringify({ schema: 1, kind: "team-event", event: declared.event, roster: declared.roster })]
					: [`muninn: declared ${declared.event.kind} · ${declared.event.id}`, ...renderTeamRoster(declared.roster)],
				err,
			};
		}
		if (command === "search") {
			const parsed = parseJournalQueryArgs(args, { positionalQuery: true });
			if (!parsed.query.query && !hasFilters(parsed.query)) {
				throw new JournalArgumentError("search needs a query or at least one filter");
			}
			const context = await projectContext(cwd, false);
			const result = context.service.query(parsed.query);
			return { code: result.records.length === 0 ? 1 : 0, out: renderSearch(result, parsed.mode), err };
		}
		if (command === "conflicts") {
			const parsed = parseJournalQueryArgs(args);
			if (Object.keys(parsed.query).length > 0 || parsed.follow || parsed.relations) {
				throw new JournalArgumentError("conflicts accepts only --json or --jsonl");
			}
			const context = await projectContext(cwd, false);
			return { code: 0, out: renderConflicts(context.service.conflictInbox(), parsed.mode), err };
		}
		if (command === "show") {
			const id = args.shift();
			if (!id) throw new JournalArgumentError("show needs a journal record ID");
			const parsed = parseJournalQueryArgs(args, { allowRelations: true });
			const context = await projectContext(cwd, false);
			const result = context.service.read(id, parsed.relations ? 5 : 0);
			if (!result) return { code: 1, out, err: [`muninn: no journal record has id ${id}`] };
			const transcript = result.transcripts.find((candidate) => candidate.record === id);
			return { code: transcript && !transcript.available ? 3 : 0, out: renderRead(id, result, parsed.mode), err };
		}
		if (command === "sessions") {
			const parsed = parseJournalQueryArgs(args);
			const context = await projectContext(cwd, false);
			const result = sessions(context.service, parsed.query);
			return { code: result.sessions.length === 0 ? 1 : 0, out: renderSessions(result, parsed.mode), err };
		}
		if (command === "tail") {
			const parsed = parseJournalQueryArgs(args, { allowFollow: true });
			if (parsed.follow && parsed.mode === "json") throw new JournalArgumentError("--follow requires text or --jsonl");
			const context = await projectContext(cwd, false);
			const initial = tail(context.service, parsed.query);
			for (const line of renderSearch(initial, parsed.mode)) emit(line);
			if (!parsed.follow) return { code: 0, out, err };
			const seen = new Set(initial.records.map((record) => record.id));
			while (!options.signal?.aborted) {
				await wait(options.pollMs ?? 500, options.signal);
				if (options.signal?.aborted) break;
				context.service.refresh();
				const selected = collectSearchRecords(context.service, withoutPaging(parsed.query));
				const fresh = selected.records
					.filter((record) => !seen.has(record.id))
					.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
				for (const record of fresh) {
					seen.add(record.id);
					const result = context.service.query({ ids: [record.id], limit: 1 });
					for (const line of renderSearch(result, parsed.mode === "text" ? "text" : "jsonl")) emit(line);
				}
			}
			return { code: 0, out, err };
		}
		if (command === "note") {
			const parsed = parseWriteArgs(args);
			if (parsed.text === "") throw new JournalArgumentError("note needs text");
			const context = await projectContext(cwd, true);
			const git = await collectGitProvenance(cwd);
			const record: NewJournalRecord = {
				type: "note",
				source: "user",
				channel: "cli",
				body: parsed.text,
				tags: [],
				paths: [],
				relations: [],
				...(git ? { git } : {}),
			};
			const written = await appendAuthorizedJournalRecord(
				{ authority: "headless-user", record },
				{
					storePath: context.project.storePath,
					project: context.project.id,
					member: context.project.member.id,
					host: context.host.id,
				},
			);
			return { code: 0, out: renderAppend(written.record, parsed.mode), err };
		}
		if (command === "correct" || command === "annotate") {
			const parsed = parseRelationArgs(args, command);
			const context = await projectContext(cwd, true);
			if (!context.service.read(parsed.target, 0, 1)) {
				return { code: 1, out, err: [`muninn: no journal record has id ${parsed.target}`] };
			}
			const written = await appendUserRelation({
				authority: "headless-user",
				target: parsed.target,
				text: parsed.text,
				relation: command === "correct" ? "corrects" : "annotates",
				channel: "cli",
				storePath: context.project.storePath,
				project: context.project.id,
				member: context.project.member.id,
				host: context.host.id,
			});
			return { code: 0, out: renderAppend(written.record, parsed.mode), err };
		}
		if (command === "resolve") {
			const parsed = parseRelationArgs(args, command);
			const context = await projectContext(cwd, true);
			const git = await collectGitProvenance(cwd);
			const resolved = await resolveUserConflict({
				authority: "headless-user",
				target: parsed.target,
				text: parsed.text,
				channel: "cli",
				storePath: context.project.storePath,
				project: context.project.id,
				member: context.project.member.id,
				host: context.host.id,
				...(git ? { git } : {}),
			});
			if (resolved.status === "missing") {
				return { code: 1, out, err: [`muninn: no journal record has id ${parsed.target}`] };
			}
			if (resolved.status === "not-conflicted") {
				return { code: 1, out, err: [`muninn: journal record ${parsed.target} is not conflicted; nothing written`] };
			}
			return { code: 0, out: renderAppend(resolved.written.record, parsed.mode), err };
		}
		if (command === "migrate") {
			const parsed = parseSimpleFlags(args, ["dry-run", "json"]);
			const context = await projectContext(cwd, true);
			const candidates = discoverLegacyStoreCandidates(
				context.agentDir,
				context.project.locations,
				context.project.storePath,
			);
			const result = await migrateMarkdownStores({
				targetStore: context.project.storePath,
				project: context.project.id,
				member: context.project.member.id,
				host: context.host.id,
				sources: inventoryLegacyStores(candidates),
				dryRun: parsed.has("dry-run"),
			});
			const lines = parsed.has("json")
				? [JSON.stringify({ schema: 1, kind: "migration", ...result })]
				: [
						`muninn: migration ${result.dryRun ? "dry run" : "complete"} — ${result.imported} imported, ${result.skipped} already present, ${result.problems.length} problems`,
					];
			return { code: result.problems.length > 0 ? 1 : 0, out: lines, err };
		}
		if (command === "reindex") {
			const flags = parseSimpleFlags(args, ["json"]);
			const context = await projectContext(cwd, false, true);
			const result = { schema: 1, kind: "reindex", records: context.service.size };
			return {
				code: 0,
				out: [flags.has("json") ? JSON.stringify(result) : `muninn: index rebuilt — ${result.records} records`],
				err,
			};
		}
		if (command === "status") {
			const flags = parseSimpleFlags(args, ["json"]);
			const context = await projectContext(cwd, false);
			const scanned = scanJournal(context.project.storePath);
			const manifest = readProjectManifest(context.project.storePath);
			const result = {
				schema: 1,
				kind: "status",
				project: {
					id: context.project.id,
					name: context.project.name,
					store: context.project.storePath,
					member: context.project.member,
					remote: manifest?.remote ?? null,
					members: manifest?.members ?? [],
					hosts: manifest?.hosts ?? [],
				},
				records: scanned.records.length,
				problems: scanned.problems,
			};
			return {
				code: scanned.problems.length > 0 ? 1 : 0,
				out: flags.has("json")
					? [JSON.stringify(result)]
					: [
							`${context.project.name} · ${context.project.id}`,
							`store: ${context.project.storePath}`,
							`member: ${context.project.member.name} · ${context.project.member.id}`,
							`remote: ${manifest?.remote ?? "none"}`,
							`team: ${manifest?.members.length ?? 0} member(s) · ${manifest?.hosts.length ?? 0} host(s)`,
							`records: ${result.records} · problems: ${result.problems.length}`,
						],
				err,
			};
		}
		if (command === "sync") {
			const flags = parseSimpleFlags(args, ["no-push"]);
			const context = await projectContext(cwd, false);
			const result = await sync({
				storePath: context.project.storePath,
				hostId: context.host.id,
				hostName: context.host.name,
				remote: readProjectManifest(context.project.storePath)?.remote ?? null,
				identity: storeIdentity(context.host),
				...(flags.has("no-push") ? { noPush: true } : {}),
			});
			return {
				code: result.problem && !result.offline ? 1 : 0,
				out: [describeSync(result), ...result.notes.map((note) => `  ${note}`)],
				err,
			};
		}
		return { code: 2, out, err: [`muninn: unknown command "${command}"`, "", USAGE] };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const code = error instanceof JournalArgumentError ? 2 : 1;
		return { code, out, err: [message.startsWith("muninn:") ? message : `muninn: ${message}`] };
	}
}

function parseProjectShareArgs(args: readonly string[]): { path?: string; json: boolean } {
	let path: string | undefined;
	let json = false;
	for (const arg of args) {
		if (arg === "--json") json = true;
		else if (arg.startsWith("--")) throw new JournalArgumentError(`unknown project share option ${arg}`);
		else if (path) throw new JournalArgumentError("project share takes at most one path");
		else path = arg;
	}
	return { ...(path ? { path } : {}), json };
}

function parseProjectJoinArgs(args: readonly string[]): {
	remote: string;
	path?: string;
	force: boolean;
	json: boolean;
} {
	let remote: string | undefined;
	let path: string | undefined;
	let force = false;
	let json = false;
	for (const arg of args) {
		if (arg === "--force") force = true;
		else if (arg === "--json") json = true;
		else if (arg.startsWith("--")) throw new JournalArgumentError(`unknown project join option ${arg}`);
		else if (!remote) remote = arg;
		else if (!path) path = arg;
		else throw new JournalArgumentError("project join takes one journal URL and at most one project path");
	}
	if (!remote) throw new JournalArgumentError("project join needs a journal URL");
	return { remote, ...(path ? { path } : {}), force, json };
}

type TeamAction = "list" | "rename-member" | "rename-host" | "retire-host" | "restore-host" | "leave" | "return";

function parseTeamArgs(args: readonly string[]): {
	action: TeamAction;
	host?: string;
	name?: string;
	reason?: string;
	json: boolean;
} {
	const action = (args[0] ?? "list") as TeamAction;
	if (!["list", "rename-member", "rename-host", "retire-host", "restore-host", "leave", "return"].includes(action)) {
		throw new JournalArgumentError(`unknown team command ${action}`);
	}
	const positional: string[] = [];
	let reason: string | undefined;
	let json = false;
	for (let index = 1; index < args.length; index++) {
		const arg = args[index] as string;
		if (arg === "--json") json = true;
		else if (arg === "--reason") {
			reason = args[++index];
			if (!reason) throw new JournalArgumentError("--reason needs text");
		} else if (arg.startsWith("--")) throw new JournalArgumentError(`unknown team option ${arg}`);
		else positional.push(arg);
	}
	const expected = action === "rename-host" ? 2 : action === "rename-member" || action.includes("-host") ? 1 : 0;
	if (positional.length !== expected) {
		throw new JournalArgumentError(
			action === "rename-member"
				? "team rename-member needs a name"
				: action === "rename-host"
					? "team rename-host needs a host ID and name"
					: action.includes("-host")
						? `team ${action} needs a host ID`
						: `team ${action} takes no arguments`,
		);
	}
	if (action === "list" && reason) throw new JournalArgumentError("team list does not accept --reason");
	return {
		action,
		...(action.includes("-host") ? { host: positional[0] } : {}),
		...(action === "rename-member" ? { name: positional[0] } : {}),
		...(action === "rename-host" ? { name: positional[1] } : {}),
		...(reason ? { reason } : {}),
		json,
	};
}

function hasFilters(query: object): boolean {
	return Object.entries(query).some(([key, value]) => key !== "query" && value !== undefined);
}

function parseWriteArgs(args: readonly string[]): { text: string; mode: JournalOutputMode } {
	let mode: JournalOutputMode = "text";
	const words: string[] = [];
	let literal = false;
	for (const arg of args) {
		if (!literal && arg === "--") {
			literal = true;
			continue;
		}
		if (!literal && (arg === "--json" || arg === "--jsonl")) {
			mode = arg.slice(2) as JournalOutputMode;
			continue;
		}
		words.push(arg);
	}
	return { text: words.join(" ").trim(), mode };
}

function parseRelationArgs(
	args: readonly string[],
	command: "correct" | "annotate" | "resolve",
): { target: string; text: string; mode: JournalOutputMode } {
	const target = args[0];
	if (!target) throw new JournalArgumentError(`${command} needs a target ID and text`);
	const parsed = parseWriteArgs(args.slice(1));
	if (parsed.text === "") throw new JournalArgumentError(`${command} needs text`);
	return { target, ...parsed };
}

function parseSimpleFlags(args: readonly string[], allowed: readonly string[]): Set<string> {
	const flags = new Set<string>();
	for (const arg of args) {
		if (!arg.startsWith("--") || !allowed.includes(arg.slice(2))) {
			throw new JournalArgumentError(`unexpected argument "${arg}"`);
		}
		flags.add(arg.slice(2));
	}
	return flags;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(resolve, milliseconds);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

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
	const deadline = new AbortController();
	let emitted = 0;
	process.once("SIGINT", () => deadline.abort());
	process.stdout.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EPIPE") process.exit(0);
		throw error;
	});
	const result = await runCli(process.argv.slice(2), process.cwd(), {
		signal: deadline.signal,
		emit: (line) => {
			emitted++;
			process.stdout.write(`${line}\n`);
		},
	});
	if (result.out.length > emitted) process.stdout.write(`${result.out.slice(emitted).join("\n")}\n`);
	if (result.err.length > 0) process.stderr.write(`${result.err.join("\n")}\n`);
	process.exit(result.code);
}
