#!/usr/bin/env node
/** `muninn` — direct human and Unix access to one logical project journal. */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveAgentDir } from "./agent-dir.ts";
import {
	collectSearchRecords,
	JournalArgumentError,
	type JournalOutputMode,
	parseJournalQueryArgs,
	renderAppend,
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
import { appendAuthorizedJournalRecord, appendUserRelation } from "./journal/writer.ts";
import { runProjectCommand } from "./project/command.ts";
import { type ResolvedProject, resolveLogicalProject } from "./project/resolver.ts";
import { type HostIdentity, loadHostIdentity } from "./store/host.ts";
import { ensureStore, storeIdentity } from "./store/init.ts";
import { storeExistsAt } from "./store/paths.ts";
import { ensureProjectManifest } from "./store/project-manifest.ts";
import { describeSync, sync } from "./sync/sync.ts";
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
	"  muninn path",
	"  muninn project link|show|unlink",
	"  muninn migrate [--dry-run] [--json]",
	"  muninn reindex [--json]",
	"  muninn status [--json]",
	"  muninn sync [--no-push]",
	"",
	"Filters: --id --type --source --member --host --branch --path --tag --status",
	"         --since --until --related-to --limit --cursor",
	"",
	"Exit 0: success; 1: no match/store or operation failure; 2: invalid input.",
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
		await ensureStore(project.storePath, { host });
		ensureProjectManifest(project.storePath, {
			id: project.id,
			name: project.name,
			...(project.locations[0]?.linkedAt ? { createdAt: project.locations[0].linkedAt } : {}),
		});
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
		if (command === "search") {
			const parsed = parseJournalQueryArgs(args, { positionalQuery: true });
			if (!parsed.query.query && !hasFilters(parsed.query)) {
				throw new JournalArgumentError("search needs a query or at least one filter");
			}
			const context = await projectContext(cwd, false);
			const result = context.service.query(parsed.query);
			return { code: result.records.length === 0 ? 1 : 0, out: renderSearch(result, parsed.mode), err };
		}
		if (command === "show") {
			const id = args.shift();
			if (!id) throw new JournalArgumentError("show needs a journal record ID");
			const parsed = parseJournalQueryArgs(args, { allowRelations: true });
			const context = await projectContext(cwd, false);
			const result = context.service.read(id, parsed.relations ? 5 : 0);
			if (!result) return { code: 1, out, err: [`muninn: no journal record has id ${id}`] };
			return { code: 0, out: renderRead(id, result, parsed.mode), err };
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
			const result = {
				schema: 1,
				kind: "status",
				project: {
					id: context.project.id,
					name: context.project.name,
					store: context.project.storePath,
					member: context.project.member,
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
				remote: null,
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
	command: "correct" | "annotate",
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
