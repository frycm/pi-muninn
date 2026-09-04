/** Schema and canonical serialization for Phase 3 project-journal records. */
import { isEntryId, isHostId, isMemberId, isProjectId, newEntryId } from "../ids.ts";
import { redact } from "../redact.ts";

export const JOURNAL_SCHEMA = 1 as const;
export const MAX_RECORD_BYTES = 64 * 1024;

export const RECORD_TYPES = ["outcome", "checkpoint", "note", "correction", "import"] as const;
export const RECORD_SOURCES = ["user", "agent", "tool", "external", "mixed"] as const;
export const RECORD_CHANNELS = ["tui", "rpc", "sdk", "hook", "cli", "unknown"] as const;
export const RECORD_STATUSES = ["completed", "partial", "failed", "cancelled", "unknown"] as const;
export const RELATION_TYPES = ["corrects", "supersedes", "annotates"] as const;

export type JournalRecordType = (typeof RECORD_TYPES)[number];
export type JournalSource = (typeof RECORD_SOURCES)[number];
export type JournalChannel = (typeof RECORD_CHANNELS)[number];
export type JournalStatus = (typeof RECORD_STATUSES)[number];
export type JournalRelationType = (typeof RELATION_TYPES)[number];

export interface JournalRelation {
	type: JournalRelationType;
	target: string;
}

export interface JournalSessionPointer {
	file: string;
	first?: string;
	last?: string;
}

export interface JournalGitProvenance {
	worktree?: string;
	cwd: string;
	branch: string | null;
	head: string | null;
	dirty: boolean;
}

export interface JournalLegacyOrigin {
	store: string;
	path: string;
	fingerprint: string;
	fields?: Record<string, unknown>;
}

export interface JournalRecord {
	schema: typeof JOURNAL_SCHEMA;
	id: string;
	at: string;
	type: JournalRecordType;
	project: string;
	member: string;
	host: string;
	source: JournalSource;
	channel: JournalChannel;
	task?: string;
	continues?: string;
	status?: JournalStatus;
	body: string;
	cue?: string;
	tags: string[];
	paths: string[];
	relations: JournalRelation[];
	session?: JournalSessionPointer;
	git?: JournalGitProvenance;
	legacy?: JournalLegacyOrigin;
	redacted?: true;
}

export interface NewJournalRecord {
	type: JournalRecordType;
	source: JournalSource;
	channel: JournalChannel;
	task?: string;
	continues?: string;
	status?: JournalStatus;
	body: string;
	cue?: string;
	tags?: string[];
	paths?: string[];
	relations?: JournalRelation[];
	session?: JournalSessionPointer;
	git?: JournalGitProvenance;
	legacy?: JournalLegacyOrigin;
	/** Preserved only by trusted import paths; ordinary writers cannot choose it. */
	redacted?: true;
}

export interface JournalRecordIdentity {
	project: string;
	member: string;
	host: string;
}

const RFC3339_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const GIT_HEAD = /^[0-9a-f]{40,64}$/i;
const KNOWN_KEYS = new Set([
	"schema",
	"id",
	"at",
	"type",
	"project",
	"member",
	"host",
	"source",
	"channel",
	"task",
	"continues",
	"status",
	"body",
	"cue",
	"tags",
	"paths",
	"relations",
	"session",
	"git",
	"legacy",
	"redacted",
]);

function object(value: unknown, at: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${at} must be an object`);
	return value as Record<string, unknown>;
}

function string(value: unknown, at: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
		throw new Error(`${at} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
	}
	return value;
}

function optionalString(value: unknown, at: string): string | undefined {
	return value === undefined ? undefined : string(value, at);
}

function member<T extends readonly string[]>(value: unknown, values: T, at: string): T[number] {
	if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
		throw new Error(`${at} must be one of ${values.join(", ")}`);
	}
	return value as T[number];
}

function stringArray(value: unknown, at: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${at} must be an array`);
	return value.map((item, index) => string(item, `${at}[${index}]`));
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function projectPath(value: string, at: string): string {
	const normalized = value.replaceAll("\\", "/");
	if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) throw new Error(`${at} must be project-relative`);
	if (normalized.split("/").some((part) => part === "..")) throw new Error(`${at} must not escape the project`);
	return normalized.replace(/^\.\//, "");
}

function parseRelations(value: unknown): JournalRelation[] {
	if (!Array.isArray(value)) throw new Error("relations must be an array");
	return value.map((candidate, index) => {
		const relation = object(candidate, `relations[${index}]`);
		const keys = Object.keys(relation);
		if (keys.some((key) => key !== "type" && key !== "target")) {
			throw new Error(`relations[${index}] has unknown fields`);
		}
		const target = string(relation.target, `relations[${index}].target`);
		if (!isEntryId(target)) throw new Error(`relations[${index}].target must be a journal record id`);
		return { type: member(relation.type, RELATION_TYPES, `relations[${index}].type`), target };
	});
}

function parseSession(value: unknown): JournalSessionPointer {
	const session = object(value, "session");
	return {
		file: string(session.file, "session.file"),
		...(optionalString(session.first, "session.first") ? { first: session.first as string } : {}),
		...(optionalString(session.last, "session.last") ? { last: session.last as string } : {}),
	};
}

function parseGit(value: unknown): JournalGitProvenance {
	const provenance = object(value, "git");
	const cwd = string(provenance.cwd, "git.cwd");
	if (typeof provenance.dirty !== "boolean") throw new Error("git.dirty must be a boolean");
	if (provenance.branch !== null && provenance.branch !== undefined && typeof provenance.branch !== "string") {
		throw new Error("git.branch must be a string or null");
	}
	if (provenance.head !== null && provenance.head !== undefined) {
		const head = string(provenance.head, "git.head");
		if (!GIT_HEAD.test(head)) throw new Error("git.head must be a full hexadecimal object id or null");
	}
	return {
		...(optionalString(provenance.worktree, "git.worktree") ? { worktree: provenance.worktree as string } : {}),
		cwd,
		branch: provenance.branch === undefined ? null : (provenance.branch as string | null),
		head: provenance.head === undefined ? null : (provenance.head as string | null),
		dirty: provenance.dirty,
	};
}

function jsonSafe(value: unknown, at: string): unknown {
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		throw new Error(`${at} must be JSON-serializable`);
	}
}

function parseLegacy(value: unknown): JournalLegacyOrigin {
	const legacy = object(value, "legacy");
	const parsed: JournalLegacyOrigin = {
		store: string(legacy.store, "legacy.store"),
		path: string(legacy.path, "legacy.path"),
		fingerprint: string(legacy.fingerprint, "legacy.fingerprint"),
	};
	if (legacy.fields !== undefined) parsed.fields = object(jsonSafe(legacy.fields, "legacy.fields"), "legacy.fields");
	return parsed;
}

export interface ParsedJournalRecord {
	record: JournalRecord;
	/** Unknown top-level fields from a newer compatible writer. */
	extensions: Record<string, unknown>;
}

/** Parse and validate a record without trusting its claimed schema or identity. */
export function parseJournalRecord(value: unknown): ParsedJournalRecord {
	const raw = object(value, "record");
	if (raw.schema !== JOURNAL_SCHEMA) throw new Error(`schema must be ${JOURNAL_SCHEMA}, found ${String(raw.schema)}`);
	const id = string(raw.id, "id");
	if (!isEntryId(id)) throw new Error("id must be j- followed by a full UUIDv7");
	const at = string(raw.at, "at");
	if (!RFC3339_MILLIS.test(at) || Number.isNaN(Date.parse(at))) {
		throw new Error("at must be a UTC RFC 3339 timestamp with millisecond precision");
	}
	const project = string(raw.project, "project");
	if (!isProjectId(project)) throw new Error("project must be a full UUIDv7");
	const memberId = string(raw.member, "member");
	if (!isMemberId(memberId)) throw new Error("member must be a full UUIDv7");
	const host = string(raw.host, "host");
	if (!isHostId(host)) throw new Error("host must be a full UUIDv7");
	const tags = unique(stringArray(raw.tags, "tags"));
	const paths = unique(stringArray(raw.paths, "paths").map((path, index) => projectPath(path, `paths[${index}]`)));
	const record: JournalRecord = {
		schema: JOURNAL_SCHEMA,
		id,
		at,
		type: member(raw.type, RECORD_TYPES, "type"),
		project,
		member: memberId,
		host,
		source: member(raw.source, RECORD_SOURCES, "source"),
		channel: member(raw.channel, RECORD_CHANNELS, "channel"),
		body: string(raw.body, "body"),
		tags,
		paths,
		relations: parseRelations(raw.relations),
	};
	const task = optionalString(raw.task, "task");
	if (task) record.task = task;
	const continues = optionalString(raw.continues, "continues");
	if (continues) record.continues = continues;
	if (raw.status !== undefined) record.status = member(raw.status, RECORD_STATUSES, "status");
	const cue = optionalString(raw.cue, "cue");
	if (cue) record.cue = cue;
	if (raw.session !== undefined) record.session = parseSession(raw.session);
	if (raw.git !== undefined) record.git = parseGit(raw.git);
	if (raw.legacy !== undefined) record.legacy = parseLegacy(raw.legacy);
	if (raw.redacted !== undefined) {
		if (raw.redacted !== true) throw new Error("redacted must be true when present");
		record.redacted = true;
	}
	const extensions: Record<string, unknown> = {};
	for (const [key, extension] of Object.entries(raw)) {
		if (!KNOWN_KEYS.has(key)) extensions[key] = jsonSafe(extension, `extension ${key}`);
	}
	return { record, extensions };
}

/** Validate a canonical writer record, returning a normalized copy. */
export function validateJournalRecord(record: JournalRecord): JournalRecord {
	return parseJournalRecord(record).record;
}

function scrub(input: NewJournalRecord): NewJournalRecord & { redacted?: true } {
	const body = redact(input.body);
	const cue = input.cue === undefined ? undefined : redact(input.cue);
	const tags = (input.tags ?? []).map((tag) => redact(tag));
	const hits = body.hits.length + (cue?.hits.length ?? 0) + tags.reduce((sum, tag) => sum + tag.hits.length, 0);
	return {
		...input,
		body: body.text,
		...(cue ? { cue: cue.text } : {}),
		tags: tags.map((tag) => tag.text),
		...(hits > 0 || input.redacted ? { redacted: true } : {}),
	};
}

export interface BuildJournalRecordOptions extends JournalRecordIdentity {
	now?: Date;
	id?: string;
}

/** Fill deterministic identity/time fields, redact free text, and validate. */
export function buildJournalRecord(input: NewJournalRecord, options: BuildJournalRecordOptions): JournalRecord {
	const clean = scrub(input);
	return validateJournalRecord({
		schema: JOURNAL_SCHEMA,
		id: options.id ?? newEntryId(),
		at: (options.now ?? new Date()).toISOString(),
		type: clean.type,
		project: options.project,
		member: options.member,
		host: options.host,
		source: clean.source,
		channel: clean.channel,
		...(clean.task ? { task: clean.task } : {}),
		...(clean.continues ? { continues: clean.continues } : {}),
		...(clean.status ? { status: clean.status } : {}),
		body: clean.body,
		...(clean.cue ? { cue: clean.cue } : {}),
		tags: clean.tags ?? [],
		paths: clean.paths ?? [],
		relations: clean.relations ?? [],
		...(clean.session ? { session: clean.session } : {}),
		...(clean.git ? { git: clean.git } : {}),
		...(clean.legacy ? { legacy: clean.legacy } : {}),
		...(clean.redacted ? { redacted: true } : {}),
	});
}

/** Stable key order, no insignificant whitespace, exactly one trailing newline. */
export function serializeJournalRecord(record: JournalRecord): string {
	const valid = validateJournalRecord(record);
	const ordered: JournalRecord = {
		schema: valid.schema,
		id: valid.id,
		at: valid.at,
		type: valid.type,
		project: valid.project,
		member: valid.member,
		host: valid.host,
		source: valid.source,
		channel: valid.channel,
		...(valid.task ? { task: valid.task } : {}),
		...(valid.continues ? { continues: valid.continues } : {}),
		...(valid.status ? { status: valid.status } : {}),
		body: valid.body,
		...(valid.cue ? { cue: valid.cue } : {}),
		tags: valid.tags,
		paths: valid.paths,
		relations: valid.relations,
		...(valid.session ? { session: valid.session } : {}),
		...(valid.git ? { git: valid.git } : {}),
		...(valid.legacy ? { legacy: valid.legacy } : {}),
		...(valid.redacted ? { redacted: true } : {}),
	};
	const line = `${JSON.stringify(ordered)}\n`;
	const bytes = Buffer.byteLength(line, "utf-8");
	if (bytes > MAX_RECORD_BYTES) throw new Error(`journal record is ${bytes} bytes; maximum is ${MAX_RECORD_BYTES}`);
	return line;
}

export function parseJournalLine(line: string): ParsedJournalRecord {
	if (Buffer.byteLength(line, "utf-8") + 1 > MAX_RECORD_BYTES) {
		throw new Error(`journal line exceeds ${MAX_RECORD_BYTES} bytes`);
	}
	return parseJournalRecord(JSON.parse(line) as unknown);
}
