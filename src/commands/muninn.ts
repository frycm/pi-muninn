/** Attended `/muninn` commands over the canonical project-journal service. */
import type { MuninnSessionState } from "../capture/session-state.ts";
import {
	parseJournalQueryArgs,
	renderAppend,
	renderRead,
	renderSearch,
	renderSessions,
	sessions,
	tail,
} from "../journal/interface.ts";
import type { AppendJournalResult } from "../journal/jsonl.ts";
import type { JournalQueryService } from "../journal/query.ts";
import type { JournalRelationType, NewJournalRecord } from "../journal/record.ts";
import { formatResolvedProject } from "../project/command.ts";
import type { SessionContext } from "../session.ts";
import { describeSync, type SyncResult } from "../sync/sync.ts";

export type CommandLevel = "info" | "warning" | "error";

export interface CommandOutput {
	text: string;
	level: CommandLevel;
}

export interface CommandRuntime {
	load(options: { createStores: boolean }): Promise<SessionContext>;
	settle(): Promise<void>;
	query(): JournalQueryService;
	state(): MuninnSessionState | undefined;
	appendUser(record: NewJournalRecord): Promise<AppendJournalResult>;
	appendRelation(target: string, text: string, relation: JournalRelationType): Promise<AppendJournalResult>;
	reindex(): Promise<number>;
	sync(options: { noPush?: boolean }): Promise<Array<{ scope: "project"; result: SyncResult }>>;
	statusReport(session: SessionContext): string;
}

export const USAGE = [
	"/muninn — project journal",
	"",
	"  /muninn                              status",
	"  /muninn search QUERY [FILTERS]",
	"  /muninn show ID [--relations]",
	"  /muninn sessions [FILTERS]",
	"  /muninn tail [FILTERS]",
	"  /muninn note TEXT",
	"  /muninn correct ID TEXT",
	"  /muninn annotate ID TEXT",
	"  /muninn project",
	"  /muninn reindex",
	"  /muninn sync [--no-push]",
].join("\n");

export async function runMuninnCommand(args: string, runtime: CommandRuntime): Promise<CommandOutput> {
	const trimmed = args.trim();
	const space = trimmed.indexOf(" ");
	const name = (space === -1 ? trimmed : trimmed.slice(0, space)) || "status";
	const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();

	switch (name) {
		case "status":
			return status(runtime);
		case "project":
			return project(rest, runtime);
		case "search":
			return search(rest, runtime);
		case "show":
			return show(rest, runtime);
		case "sessions":
			return listSessions(rest, runtime);
		case "tail":
			return listTail(rest, runtime);
		case "note":
			return note(rest, runtime);
		case "correct":
			return relation(rest, "corrects", runtime);
		case "annotate":
			return relation(rest, "annotates", runtime);
		case "reindex":
			return reindex(runtime);
		case "sync":
			return runSync(rest, runtime);
		case "help":
		case "--help":
			return { level: "info", text: USAGE };
		default:
			return { level: "warning", text: [`muninn: unknown subcommand "${name}"`, "", USAGE].join("\n") };
	}
}

async function status(runtime: CommandRuntime): Promise<CommandOutput> {
	const session = await runtime.load({ createStores: true });
	await runtime.settle();
	return { level: "info", text: runtime.statusReport(session) };
}

async function project(args: string, runtime: CommandRuntime): Promise<CommandOutput> {
	if (args !== "" && args !== "show") {
		return {
			level: "warning",
			text: "muninn: /muninn project only shows the active mapping; use `muninn project link|unlink` in a shell to change it",
		};
	}
	const session = await runtime.load({ createStores: false });
	if (!session.project) return { level: "warning", text: "muninn: no logical project is linked for this session" };
	return { level: "info", text: formatResolvedProject(session.project).join("\n") };
}

async function service(runtime: CommandRuntime): Promise<JournalQueryService> {
	await runtime.load({ createStores: true });
	await runtime.settle();
	return runtime.query();
}

async function search(args: string, runtime: CommandRuntime): Promise<CommandOutput> {
	const parsed = parseJournalQueryArgs(splitArgs(args), { positionalQuery: true });
	if (!parsed.query.query && Object.keys(parsed.query).length === 0) {
		return { level: "warning", text: "muninn: /muninn search QUERY [FILTERS]" };
	}
	const result = (await service(runtime)).query(parsed.query);
	return { level: "info", text: renderSearch(result, "text").join("\n") };
}

async function show(args: string, runtime: CommandRuntime): Promise<CommandOutput> {
	const words = splitArgs(args);
	const id = words.shift();
	if (!id) return { level: "warning", text: "muninn: /muninn show ID [--relations]" };
	const parsed = parseJournalQueryArgs(words, { allowRelations: true });
	const result = (await service(runtime)).read(id, parsed.relations ? 5 : 0);
	if (!result) return { level: "warning", text: `muninn: no journal record has id ${id}` };
	return { level: "info", text: renderRead(id, result, "text").join("\n") };
}

async function listSessions(args: string, runtime: CommandRuntime): Promise<CommandOutput> {
	const parsed = parseJournalQueryArgs(splitArgs(args));
	const result = sessions(await service(runtime), parsed.query);
	return { level: "info", text: renderSessions(result, "text").join("\n") };
}

async function listTail(args: string, runtime: CommandRuntime): Promise<CommandOutput> {
	const parsed = parseJournalQueryArgs(splitArgs(args));
	return { level: "info", text: renderSearch(tail(await service(runtime), parsed.query), "text").join("\n") };
}

async function note(text: string, runtime: CommandRuntime): Promise<CommandOutput> {
	if (text.trim() === "") return { level: "warning", text: "muninn: /muninn note TEXT" };
	await runtime.load({ createStores: true });
	const state = runtime.state();
	const written = await runtime.appendUser({
		type: "note",
		source: "user",
		channel: "tui",
		body: text,
		tags: [],
		paths: [],
		relations: [],
		...(state ? { task: state.task } : {}),
		...(state?.continues ? { continues: state.continues } : {}),
	});
	return { level: "info", text: renderAppend(written.record, "text").join("\n") };
}

async function relation(
	args: string,
	relationType: "corrects" | "annotates",
	runtime: CommandRuntime,
): Promise<CommandOutput> {
	const match = args.match(/^(\S+)\s+([\s\S]+)$/);
	const verb = relationType === "corrects" ? "correct" : "annotate";
	if (!match) return { level: "warning", text: `muninn: /muninn ${verb} ID TEXT` };
	const target = match[1] as string;
	const text = (match[2] as string).trim();
	const query = await service(runtime);
	if (!query.read(target, 0, 1)) return { level: "warning", text: `muninn: no journal record has id ${target}` };
	const written = await runtime.appendRelation(target, text, relationType);
	return { level: "info", text: renderAppend(written.record, "text").join("\n") };
}

async function reindex(runtime: CommandRuntime): Promise<CommandOutput> {
	await runtime.load({ createStores: true });
	const records = await runtime.reindex();
	return { level: "info", text: `muninn: index rebuilt — ${records} ${records === 1 ? "record" : "records"}` };
}

async function runSync(args: string, runtime: CommandRuntime): Promise<CommandOutput> {
	const words = splitArgs(args);
	const invalid = words.find((word) => word !== "--no-push");
	if (invalid) return { level: "warning", text: `muninn: unknown sync option ${invalid}` };
	await runtime.load({ createStores: true });
	await runtime.settle();
	const outcomes = await runtime.sync(words.includes("--no-push") ? { noPush: true } : {});
	if (outcomes.length === 0) return { level: "warning", text: "muninn: no project journal is active here" };
	const lines: string[] = [];
	let level: CommandLevel = "info";
	for (const { scope, result } of outcomes) {
		lines.push(`${scope}: ${describeSync(result)}`, ...result.notes.map((note) => `  ${note}`));
		if (result.problem) level = result.offline ? "warning" : "error";
	}
	return { level, text: lines.join("\n") };
}

/** Minimal shell-like splitting for filters; direct note/correction text bypasses it. */
export function splitArgs(text: string): string[] {
	const words: string[] = [];
	const pattern = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|(\S+)/g;
	for (const match of text.matchAll(pattern)) {
		const value = match[1] ?? match[2] ?? match[3] ?? "";
		words.push(value.replace(/\\(["'\\])/g, "$1"));
	}
	return words;
}
