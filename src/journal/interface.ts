/** Stable human/Unix projections over the canonical journal query service. */
import type {
	JournalConflictsResult,
	JournalQuery,
	JournalQueryResult,
	JournalQueryService,
	JournalReadResult,
	JournalSearchRecord,
} from "./query.ts";
import { type JournalRecord, type JournalStatus, RECORD_SOURCES, RECORD_STATUSES, RECORD_TYPES } from "./record.ts";

export const JOURNAL_INTERFACE_SCHEMA = 1 as const;
export type JournalOutputMode = "text" | "json" | "jsonl";

export interface ParsedJournalQuery {
	query: JournalQuery;
	mode: JournalOutputMode;
	follow: boolean;
	relations: boolean;
}

export class JournalArgumentError extends Error {
	constructor(message: string) {
		super(`muninn: ${message}`);
		this.name = "JournalArgumentError";
	}
}

const ARRAY_FILTERS = new Map<string, keyof JournalQuery>([
	["id", "ids"],
	["type", "type"],
	["source", "source"],
	["member", "member"],
	["host", "host"],
	["branch", "branch"],
	["path", "path"],
	["tag", "tag"],
	["status", "status"],
]);

function values(value: string): string[] {
	const parsed = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	if (parsed.length === 0) throw new JournalArgumentError("filter values cannot be empty");
	return parsed;
}

function requireValue(args: readonly string[], at: number, flag: string): string {
	const value = args[at + 1];
	if (value === undefined || value.startsWith("--")) throw new JournalArgumentError(`--${flag} requires a value`);
	return value;
}

function enumValues<T extends string>(items: string[], allowed: readonly T[], flag: string): T[] {
	const invalid = items.find((item) => !allowed.includes(item as T));
	if (invalid) throw new JournalArgumentError(`--${flag} does not accept "${invalid}"`);
	return items as T[];
}

/** Parse the same filter vocabulary for CLI and attended commands. */
export function parseJournalQueryArgs(
	args: readonly string[],
	options: { positionalQuery?: boolean; allowFollow?: boolean; allowRelations?: boolean } = {},
): ParsedJournalQuery {
	const query: JournalQuery = {};
	const words: string[] = [];
	let mode: JournalOutputMode = "text";
	let follow = false;
	let relations = false;

	for (let at = 0; at < args.length; at++) {
		const arg = args[at] as string;
		if (!arg.startsWith("--")) {
			if (!options.positionalQuery) throw new JournalArgumentError(`unexpected argument "${arg}"`);
			words.push(arg);
			continue;
		}
		const flag = arg.slice(2);
		if (flag === "json" || flag === "jsonl") {
			const nextMode = flag as JournalOutputMode;
			if (mode !== "text" && mode !== nextMode)
				throw new JournalArgumentError("--json and --jsonl are mutually exclusive");
			mode = nextMode;
			continue;
		}
		if (flag === "follow") {
			if (!options.allowFollow) throw new JournalArgumentError("--follow is only valid for tail");
			follow = true;
			continue;
		}
		if (flag === "relations") {
			if (!options.allowRelations) throw new JournalArgumentError("--relations is only valid for show");
			relations = true;
			continue;
		}
		const arrayKey = ARRAY_FILTERS.get(flag);
		if (arrayKey) {
			const parsed = values(requireValue(args, at, flag));
			at++;
			const checked =
				arrayKey === "type"
					? enumValues(parsed, RECORD_TYPES, flag)
					: arrayKey === "source"
						? enumValues(parsed, RECORD_SOURCES, flag)
						: arrayKey === "status"
							? enumValues(parsed, RECORD_STATUSES, flag)
							: parsed;
			(query as Record<string, unknown>)[arrayKey] = [
				...((query as Record<string, string[]>)[arrayKey] ?? []),
				...checked,
			];
			continue;
		}
		if (flag === "since" || flag === "until" || flag === "cursor" || flag === "related-to") {
			const value = requireValue(args, at, flag);
			at++;
			if (flag === "related-to") query.relatedTo = value;
			else query[flag] = value;
			continue;
		}
		if (flag === "limit") {
			const value = requireValue(args, at, flag);
			at++;
			const limit = Number(value);
			if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
				throw new JournalArgumentError("--limit must be an integer from 1 to 100");
			}
			query.limit = limit;
			continue;
		}
		throw new JournalArgumentError(`unknown option --${flag}`);
	}
	if (words.length > 0) query.query = words.join(" ");
	return { query, mode, follow, relations };
}

export function renderSearch(result: JournalQueryResult, mode: JournalOutputMode): string[] {
	if (mode === "json") return [JSON.stringify(result)];
	if (mode === "jsonl")
		return result.records.map((record) =>
			JSON.stringify({ schema: JOURNAL_INTERFACE_SCHEMA, kind: "record", ...record }),
		);
	if (result.records.length === 0) return ["muninn: no journal records matched"];
	return [
		`${result.records.length} journal ${result.records.length === 1 ? "record" : "records"}:`,
		...result.records.map(formatSearchRecord),
		...(result.next_cursor ? [`next cursor: ${result.next_cursor}`] : []),
		...result.warnings.map((warning) => `! ${warning}`),
	];
}

export function renderRead(id: string, result: JournalReadResult, mode: JournalOutputMode): string[] {
	const envelope = { schema: JOURNAL_INTERFACE_SCHEMA, id, ...result };
	if (mode === "json") return [JSON.stringify(envelope)];
	if (mode === "jsonl") return result.records.map((record) => JSON.stringify({ kind: "record", ...record }));
	const transcripts = new Map(result.transcripts.map((transcript) => [transcript.record, transcript]));
	return [
		...result.records.flatMap((record, index) => [
			...(index > 0 ? [""] : []),
			`${record.id} · ${record.at} · ${record.type}/${record.source}`,
			record.body,
			`member ${record.member} · host ${record.host}`,
			...(record.git?.branch ? [`branch ${record.git.branch}`] : []),
			...(record.session
				? [
						`session ${record.session.file}${record.session.last ? `#${record.session.last}` : ""}${transcripts.get(record.id)?.available ? "" : " (transcript unavailable locally)"}`,
					]
				: []),
			...record.relations.map((relation) => `${relation.type} ${relation.target}`),
		]),
		...result.warnings.map((warning) => `! ${warning}`),
	];
}

export function renderConflicts(result: JournalConflictsResult, mode: JournalOutputMode): string[] {
	if (mode === "json") return [JSON.stringify(result)];
	if (mode === "jsonl") {
		return result.conflicts.map((conflict) =>
			JSON.stringify({ schema: JOURNAL_INTERFACE_SCHEMA, kind: "conflict", ...conflict }),
		);
	}
	if (result.conflicts.length === 0) return ["muninn: no unresolved journal conflicts"];
	return [
		`${result.conflicts.length} unresolved journal ${result.conflicts.length === 1 ? "conflict" : "conflicts"}:`,
		...result.conflicts.flatMap((conflict) => [
			`target ${conflict.target} · ${conflict.target_record.snippet}`,
			...conflict.branches.map(
				(branch) => `  branch ${branch.id} · ${branch.trust} · ${branch.labels.join(",")} · ${branch.snippet}`,
			),
		]),
		...(result.truncated ? ["! conflict output truncated"] : []),
		...result.warnings.map((warning) => `! ${warning}`),
	];
}

function formatSearchRecord(record: JournalSearchRecord): string {
	const labels = record.labels.length > 0 ? ` · ${record.labels.join(",")}` : "";
	return `${record.at} · ${record.id} · ${record.type}/${record.source} · ${record.trust}${labels} · ${record.snippet}`;
}

export interface JournalSessionSummary {
	key: string;
	file?: string;
	task?: string;
	first_at: string;
	last_at: string;
	records: number;
	last_id: string;
	statuses: JournalStatus[];
	branches: string[];
	members: string[];
	hosts: string[];
}

export interface JournalSessionsResult {
	schema: typeof JOURNAL_INTERFACE_SCHEMA;
	query: Omit<JournalQuery, "cursor">;
	sessions: JournalSessionSummary[];
	warnings: string[];
	truncated: boolean;
}

/** Retrieve every canonical page up to a defensive bound. */
export function collectSearchRecords(
	service: JournalQueryService,
	input: JournalQuery,
	maxRecords = 10_000,
): { records: JournalSearchRecord[]; warnings: string[]; truncated: boolean } {
	const records: JournalSearchRecord[] = [];
	const warnings = new Set<string>();
	let cursor = input.cursor;
	let truncated = false;
	do {
		const page = service.query({ ...input, limit: 100, ...(cursor ? { cursor } : {}) });
		records.push(...page.records);
		for (const warning of page.warnings) warnings.add(warning);
		cursor = page.next_cursor;
		if (records.length >= maxRecords && cursor) {
			records.length = maxRecords;
			truncated = true;
			break;
		}
	} while (cursor);
	return { records, warnings: [...warnings], truncated };
}

export function withoutPaging(input: JournalQuery): JournalQuery {
	const query = { ...input };
	delete query.limit;
	delete query.cursor;
	return query;
}

export function sessions(service: JournalQueryService, input: JournalQuery = {}): JournalSessionsResult {
	const requestedLimit = input.limit ?? 20;
	const selected = collectSearchRecords(service, withoutPaging(input));
	const groups = new Map<string, JournalRecord[]>();
	for (const hit of selected.records) {
		const record = service.read(hit.id, 0, 1)?.records[0];
		if (!record) continue;
		const key = record.session?.file ?? record.task ?? `record:${record.id}`;
		const group = groups.get(key) ?? [];
		group.push(record);
		groups.set(key, group);
	}
	const summaries = [...groups.entries()]
		.map(([key, records]) => sessionSummary(key, records))
		.sort((left, right) => right.last_at.localeCompare(left.last_at) || left.key.localeCompare(right.key));
	return {
		schema: JOURNAL_INTERFACE_SCHEMA,
		query: { ...withoutPaging(input), limit: requestedLimit },
		sessions: summaries.slice(0, requestedLimit),
		warnings: selected.warnings,
		truncated: selected.truncated || summaries.length > requestedLimit,
	};
}

function sessionSummary(key: string, records: JournalRecord[]): JournalSessionSummary {
	records.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
	const first = records[0] as JournalRecord;
	const last = records.at(-1) as JournalRecord;
	return {
		key,
		...(first.session?.file ? { file: first.session.file } : {}),
		...(first.task ? { task: first.task } : {}),
		first_at: first.at,
		last_at: last.at,
		records: records.length,
		last_id: last.id,
		statuses: distinct(records.flatMap((record) => (record.status ? [record.status] : []))),
		branches: distinct(records.flatMap((record) => (record.git?.branch ? [record.git.branch] : []))),
		members: distinct(records.map((record) => record.member)),
		hosts: distinct(records.map((record) => record.host)),
	};
}

export function renderSessions(result: JournalSessionsResult, mode: JournalOutputMode): string[] {
	if (mode === "json") return [JSON.stringify(result)];
	if (mode === "jsonl")
		return result.sessions.map((session) => JSON.stringify({ schema: 1, kind: "session", ...session }));
	if (result.sessions.length === 0) return ["muninn: no journal sessions matched"];
	return result.sessions.map(
		(session) =>
			`${session.last_at} · ${session.records} ${session.records === 1 ? "record" : "records"} · ${session.key}${session.statuses.length ? ` · ${session.statuses.join(",")}` : ""}`,
	);
}

export function tail(service: JournalQueryService, input: JournalQuery = {}): JournalQueryResult {
	const result = service.query({ ...input, query: input.query ?? "", limit: input.limit ?? 20 });
	result.records.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
	return result;
}

export function renderAppend(record: JournalRecord, mode: JournalOutputMode): string[] {
	const result = {
		schema: JOURNAL_INTERFACE_SCHEMA,
		id: record.id,
		at: record.at,
		type: record.type,
		source: record.source,
		relations: record.relations,
		redacted: record.redacted === true,
	};
	if (mode === "json" || mode === "jsonl") return [JSON.stringify(result)];
	return [`muninn: appended ${record.type} ${record.id}`];
}

function distinct<T extends string>(items: T[]): T[] {
	return [...new Set(items)].sort();
}
