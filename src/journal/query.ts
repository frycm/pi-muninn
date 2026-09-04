/** Canonical journal scan, filters, relation-aware ranking and stable DTOs. */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readProjectManifest } from "../store/project-manifest.ts";
import { lifecycleWarnings, projectTeamRoster } from "../team/lifecycle.ts";
import { type JournalScanProblem, scanJournal } from "./jsonl.ts";
import { JournalLexicalIndex, tokenizeJournalText } from "./query-index.ts";
import type { JournalRecord, JournalRecordType, JournalSource, JournalStatus } from "./record.ts";
import { correctionRank, projectRelations, type RelationProjection, relationNeighborhood } from "./relations.ts";

export interface JournalQuery {
	query?: string;
	ids?: string[];
	type?: JournalRecordType[];
	source?: JournalSource[];
	member?: string[];
	host?: string[];
	branch?: string[];
	path?: string[];
	tag?: string[];
	status?: JournalStatus[];
	since?: string;
	until?: string;
	relatedTo?: string;
	limit?: number;
	cursor?: string;
}

export interface JournalSearchRecord {
	id: string;
	at: string;
	type: JournalRecordType;
	source: JournalSource;
	member: string;
	host: string;
	status?: JournalStatus;
	cue?: string;
	tags: string[];
	paths: string[];
	relations: JournalRecord["relations"];
	trust: string;
	labels: string[];
	score: number;
	snippet: string;
	expanded: boolean;
}

export interface JournalQueryResult {
	schema: 1;
	query: Omit<JournalQuery, "cursor">;
	records: JournalSearchRecord[];
	warnings: string[];
	conflicts: Array<{ target: string; records: string[] }>;
	next_cursor?: string;
	truncated: boolean;
	mode: "scan" | "index";
}

export interface JournalReadResult {
	records: JournalRecord[];
	transcripts: Array<{
		record: string;
		file: string;
		available: boolean;
		first?: string;
		last?: string;
	}>;
	warnings: string[];
	truncated: boolean;
}

export interface JournalConflict {
	target: string;
	target_record: JournalSearchRecord;
	branches: JournalSearchRecord[];
}

export interface JournalConflictsResult {
	schema: 1;
	conflicts: JournalConflict[];
	warnings: string[];
	truncated: boolean;
}

export class JournalQueryError extends Error {
	constructor(message: string) {
		super(`muninn: invalid journal query: ${message}`);
		this.name = "JournalQueryError";
	}
}

interface Ranked {
	record: JournalRecord;
	score: number;
	expanded: boolean;
}

export interface JournalQueryServiceOptions {
	storePath: string;
	localMember: string;
	mode?: "scan" | "index";
	forceReindex?: boolean;
	maxChars?: number;
	snippetChars?: number;
	/** Canonical local directories in which transcript pointers may be checked. */
	transcriptRoots?: string[];
	currentGit?: { branch?: string | null; head?: string | null; paths?: string[] };
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_MAX_CHARS = 128 * 1024;
const DEFAULT_SNIPPET_CHARS = 280;

function inside(root: string, path: string): boolean {
	const fromRoot = relative(root, path);
	return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function transcriptAvailable(file: string, roots: readonly string[]): boolean {
	if (!isAbsolute(file)) return false;
	const candidate = resolve(file);
	for (const configuredRoot of roots) {
		const root = resolve(configuredRoot);
		// Do not probe arbitrary paths from synchronized teammate records.
		if (!inside(root, candidate) || !existsSync(candidate)) continue;
		try {
			const canonicalRoot = existsSync(root) ? realpathSync(root) : root;
			if (inside(canonicalRoot, realpathSync(candidate))) return true;
		} catch {
			// A disappearing or unreadable transcript is simply unavailable locally.
		}
	}
	return false;
}

export class JournalQueryService {
	private readonly options: JournalQueryServiceOptions;
	private records: JournalRecord[];
	private problems: JournalScanProblem[];
	private projection: RelationProjection;
	private index?: JournalLexicalIndex;
	private readonly indexWarnings: string[];
	private readonly mode: "scan" | "index";
	private teamWarnings: string[];

	constructor(options: JournalQueryServiceOptions) {
		this.options = options;
		const scan = scanJournal(options.storePath);
		this.records = scan.records.map((item) => item.record);
		this.problems = scan.problems;
		const lifecycle = loadLifecycle(options.storePath, this.records, options.localMember);
		this.projection = projectRelations(this.records, options.localMember, lifecycle);
		this.teamWarnings = lifecycle.warnings;
		this.mode = options.mode ?? "index";
		this.indexWarnings = [];
		if (this.mode === "index") {
			const opened = JournalLexicalIndex.open(options.storePath, this.records, options.forceReindex);
			this.index = opened.index;
			this.indexWarnings.push(...opened.warnings);
		}
	}

	get size(): number {
		return this.records.length;
	}

	/** Add a just-appended record without waiting for a filesystem rescan. */
	add(record: JournalRecord): void {
		const at = this.records.findIndex((candidate) => candidate.id === record.id);
		if (at >= 0) this.records[at] = record;
		else this.records.push(record);
		this.records.sort(byTimeThenId);
		const lifecycle = loadLifecycle(this.options.storePath, this.records, this.options.localMember);
		this.projection = projectRelations(this.records, this.options.localMember, lifecycle);
		this.teamWarnings = lifecycle.warnings;
		this.index?.add(record);
		this.index?.save(this.options.storePath);
	}

	refresh(forceReindex = false): void {
		const scan = scanJournal(this.options.storePath);
		this.records = scan.records.map((item) => item.record);
		this.problems = scan.problems;
		const lifecycle = loadLifecycle(this.options.storePath, this.records, this.options.localMember);
		this.projection = projectRelations(this.records, this.options.localMember, lifecycle);
		this.teamWarnings = lifecycle.warnings;
		if (this.mode === "index")
			this.index = JournalLexicalIndex.open(this.options.storePath, this.records, forceReindex).index;
	}

	query(input: JournalQuery = {}): JournalQueryResult {
		const query = normalizeQuery(input);
		const limit = query.limit ?? DEFAULT_LIMIT;
		const offset = decodeCursor(input.cursor, query);
		const textual = query.query?.trim() ?? "";
		const candidates = this.mode === "index" && textual !== "" ? this.index?.candidates(textual) : undefined;
		const eligible = this.records.filter((record) => matchesFilters(record, query, this.projection));
		const lexicalCandidates = candidates ? eligible.filter((record) => candidates.has(record.id)) : eligible;
		const ranked = rankRecords(
			lexicalCandidates,
			eligible,
			textual,
			this.projection,
			this.records,
			this.options.currentGit,
		);
		const page = ranked.slice(offset, offset + limit);
		const records: JournalSearchRecord[] = [];
		const maxChars = Math.max(1024, this.options.maxChars ?? DEFAULT_MAX_CHARS);
		let truncated = false;
		for (const candidate of page) {
			const dto = searchDto(candidate, this.projection, textual, this.options.snippetChars ?? DEFAULT_SNIPPET_CHARS);
			if (JSON.stringify(records).length + JSON.stringify(dto).length > maxChars) {
				truncated = true;
				break;
			}
			records.push(dto);
		}
		const consumed = offset + records.length;
		const hasMore = consumed < ranked.length;
		const response: JournalQueryResult = {
			schema: 1,
			query,
			records,
			warnings: this.warnings(),
			conflicts: this.projection.conflicts,
			truncated: truncated || hasMore,
			mode: this.mode,
		};
		if (hasMore) response.next_cursor = encodeCursor(consumed, query);
		return response;
	}

	read(id: string, relationDepth = 0, limit = 50): JournalReadResult | undefined {
		const neighborhood = relationNeighborhood(this.projection, id, { depth: relationDepth, limit });
		if (!neighborhood) return undefined;
		const records = neighborhood.records.map((view) => view.record);
		return {
			records,
			transcripts: records.flatMap((record) =>
				record.session
					? [
							{
								record: record.id,
								file: record.session.file,
								available: transcriptAvailable(record.session.file, this.options.transcriptRoots ?? []),
								...(record.session.first ? { first: record.session.first } : {}),
								...(record.session.last ? { last: record.session.last } : {}),
							},
						]
					: [],
			),
			warnings: this.warnings(),
			truncated: neighborhood.truncated,
		};
	}

	/** The complete active conflict inbox, independently of search ranking or filters. */
	conflictInbox(limit = 100): JournalConflictsResult {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new JournalQueryError("conflict limit must be 1 to 100");
		const conflicts: JournalConflict[] = [];
		const warnings: string[] = [];
		const maxChars = Math.max(1024, this.options.maxChars ?? DEFAULT_MAX_CHARS);
		let truncated = false;
		const fits = (nextConflicts: JournalConflict[], nextWarnings: string[]) =>
			JSON.stringify({ schema: 1, conflicts: nextConflicts, warnings: nextWarnings, truncated: false }).length <=
			maxChars;
		for (const conflict of this.projection.conflicts.slice(0, limit)) {
			const target = this.projection.views.get(conflict.target)?.record;
			if (!target) continue;
			const dto: JournalConflict = {
				target: target.id,
				target_record: searchDto({ record: target, score: 0, expanded: false }, this.projection, "", 160),
				branches: conflict.records.flatMap((id) => {
					const record = this.projection.views.get(id)?.record;
					return record ? [searchDto({ record, score: 0, expanded: false }, this.projection, "", 160)] : [];
				}),
			};
			if (!fits([...conflicts, dto], warnings)) {
				truncated = true;
				break;
			}
			conflicts.push(dto);
		}
		if (this.projection.conflicts.length > conflicts.length) truncated = true;
		const sourceWarnings = this.warnings();
		for (const warning of sourceWarnings) {
			if (!fits(conflicts, [...warnings, warning])) {
				truncated = true;
				break;
			}
			warnings.push(warning);
		}
		if (sourceWarnings.length > warnings.length) truncated = true;
		return { schema: 1, conflicts, warnings, truncated };
	}

	private warnings(): string[] {
		return [
			...this.problems.map(
				(problem) => `${problem.kind}: ${problem.path}${problem.line ? `:${problem.line}` : ""}: ${problem.message}`,
			),
			...this.indexWarnings,
			...this.teamWarnings,
			...this.projection.cycles.map((cycle) => `relation cycle: ${cycle.join(" -> ")}`),
		];
	}
}

function loadLifecycle(storePath: string, records: readonly JournalRecord[], localMember: string) {
	const manifest = readProjectManifest(storePath);
	if (!manifest)
		return { retiredMembers: new Set<string>(), retiredHosts: new Set<string>(), warnings: [] as string[] };
	const roster = projectTeamRoster(manifest, localMember);
	return {
		retiredMembers: new Set(roster.members.filter((member) => member.state === "retired").map((member) => member.id)),
		retiredHosts: new Set(roster.hosts.filter((host) => host.state === "retired").map((host) => host.id)),
		warnings: lifecycleWarnings(manifest, records),
	};
}

function normalizeQuery(input: JournalQuery): Omit<JournalQuery, "cursor"> {
	const query: Omit<JournalQuery, "cursor"> = {};
	if (input.query !== undefined) {
		if (input.query.length > 4096) throw new JournalQueryError("query text exceeds 4096 characters");
		query.query = input.query;
	}
	for (const key of ["ids", "type", "source", "member", "host", "branch", "path", "tag", "status"] as const) {
		const values = input[key];
		if (values !== undefined) (query as Record<string, unknown>)[key] = [...new Set(values)].sort();
	}
	for (const key of ["since", "until"] as const) {
		const value = input[key];
		if (value === undefined) continue;
		const timestamp = Date.parse(value);
		if (Number.isNaN(timestamp)) throw new JournalQueryError(`${key} must be an RFC 3339 timestamp`);
		query[key] = new Date(timestamp).toISOString();
	}
	if (input.relatedTo !== undefined) query.relatedTo = input.relatedTo;
	if (input.limit !== undefined) {
		if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_LIMIT) {
			throw new JournalQueryError(`limit must be an integer from 1 to ${MAX_LIMIT}`);
		}
		query.limit = input.limit;
	}
	return query;
}

function matchesFilters(
	record: JournalRecord,
	query: Omit<JournalQuery, "cursor">,
	projection: RelationProjection,
): boolean {
	if (query.ids && !query.ids.includes(record.id)) return false;
	if (query.type && !query.type.includes(record.type)) return false;
	if (query.source && !query.source.includes(record.source)) return false;
	if (query.member && !query.member.includes(record.member)) return false;
	if (query.host && !query.host.includes(record.host)) return false;
	if (query.branch && (!record.git?.branch || !query.branch.includes(record.git.branch))) return false;
	if (query.status && (!record.status || !query.status.includes(record.status))) return false;
	if (query.tag && !query.tag.some((tag) => record.tags.includes(tag))) return false;
	if (
		query.path &&
		!query.path.some((path) => record.paths.some((candidate) => candidate === path || candidate.startsWith(`${path}/`)))
	)
		return false;
	if (query.since && record.at < query.since) return false;
	if (query.until && record.at > query.until) return false;
	if (query.relatedTo) {
		const view = projection.views.get(record.id);
		if (
			record.id !== query.relatedTo &&
			!view?.incoming.some((edge) => edge.from === query.relatedTo) &&
			!view?.outgoing.some((edge) => edge.to === query.relatedTo)
		) {
			return false;
		}
	}
	return true;
}

function rankRecords(
	lexicalCandidates: readonly JournalRecord[],
	filtered: readonly JournalRecord[],
	query: string,
	projection: RelationProjection,
	all: readonly JournalRecord[],
	currentGit?: JournalQueryServiceOptions["currentGit"],
): Ranked[] {
	const eligible = new Map(filtered.map((record) => [record.id, record]));
	const base = new Map<string, Ranked>();
	for (const record of lexicalCandidates) {
		const score = lexicalScore(record, query);
		if (query !== "" && score <= 0) continue;
		base.set(record.id, {
			record,
			score: score + gitScore(record, currentGit) + recencyScore(record, all),
			expanded: false,
		});
	}

	for (const matched of [...base.values()]) {
		const view = projection.views.get(matched.record.id);
		if (!view) continue;
		for (const edge of view.incoming) {
			const correction = eligible.get(edge.from);
			if (!correction || correction.source !== "user" || (edge.type !== "corrects" && edge.type !== "supersedes"))
				continue;
			const score =
				matched.score >= 10_000 ? matched.score - 1 : matched.score + correctionRank(correction, projection);
			const prior = base.get(correction.id);
			if (!prior || score > prior.score) base.set(correction.id, { record: correction, score, expanded: true });
		}
		for (const edge of view.outgoing) {
			const target = eligible.get(edge.to);
			if (!target) continue;
			const score = matched.score - 1;
			const prior = base.get(target.id);
			if (!prior || score > prior.score) base.set(target.id, { record: target, score, expanded: true });
		}
	}

	return [...base.values()].sort(
		(left, right) =>
			right.score - left.score ||
			right.record.at.localeCompare(left.record.at) ||
			left.record.id.localeCompare(right.record.id),
	);
}

function lexicalScore(record: JournalRecord, rawQuery: string): number {
	const query = rawQuery.trim().toLowerCase().replace(/^"|"$/g, "");
	if (query === "") return correctionRank(record, projectRelations([record], record.member));
	if (record.id.toLowerCase() === query) return 10_000;
	const terms = tokenizeJournalText(query);
	const fields = {
		body: record.body.toLowerCase(),
		cue: (record.cue ?? "").toLowerCase(),
		paths: record.paths.join(" ").toLowerCase(),
		tags: record.tags.join(" ").toLowerCase(),
	};
	let score = 0;
	if (fields.cue.includes(query)) score += 300;
	if (fields.body.includes(query)) score += 200;
	if (fields.tags.includes(query)) score += 180;
	if (fields.paths.includes(query)) score += 160;
	for (const term of terms) {
		if (tokenizeJournalText(fields.cue).some((token) => token === term || (term.length >= 3 && token.startsWith(term))))
			score += 40;
		if (
			tokenizeJournalText(fields.tags).some((token) => token === term || (term.length >= 3 && token.startsWith(term)))
		)
			score += 35;
		if (
			tokenizeJournalText(fields.paths).some((token) => token === term || (term.length >= 3 && token.startsWith(term)))
		)
			score += 30;
		if (
			tokenizeJournalText(fields.body).some((token) => token === term || (term.length >= 3 && token.startsWith(term)))
		)
			score += 20;
	}
	return score;
}

function gitScore(record: JournalRecord, current?: JournalQueryServiceOptions["currentGit"]): number {
	if (!current || !record.git) return 0;
	let score = 0;
	if (current.head && record.git.head === current.head) score += 5;
	if (current.branch && record.git.branch === current.branch) score += 4;
	if (current.paths?.some((path) => record.paths.includes(path))) score += 3;
	return score;
}

function recencyScore(record: JournalRecord, all: readonly JournalRecord[]): number {
	const newest = all.reduce((value, candidate) => Math.max(value, Date.parse(candidate.at)), 0);
	const days = Math.max(0, newest - Date.parse(record.at)) / 86_400_000;
	return Math.max(0, 5 - days / 30);
}

function searchDto(
	ranked: Ranked,
	projection: RelationProjection,
	query: string,
	snippetChars: number,
): JournalSearchRecord {
	const record = ranked.record;
	const view = projection.views.get(record.id);
	const dto: JournalSearchRecord = {
		id: record.id,
		at: record.at,
		type: record.type,
		source: record.source,
		member: record.member,
		host: record.host,
		...(record.status ? { status: record.status } : {}),
		...(record.cue ? { cue: record.cue } : {}),
		tags: record.tags,
		paths: record.paths,
		relations: record.relations,
		trust: view?.trust ?? "unknown",
		labels: view?.labels ?? [],
		score: Number(ranked.score.toFixed(3)),
		snippet: snippet(record.body, query, snippetChars),
		expanded: ranked.expanded,
	};
	return dto;
}

function snippet(body: string, query: string, chars: number): string {
	const flat = body.replace(/\s+/g, " ").trim();
	const limit = Math.max(40, Math.min(chars, 2000));
	if (flat.length <= limit) return flat;
	const terms = tokenizeJournalText(query);
	const lower = flat.toLowerCase();
	let match = terms.reduce((best, term) => {
		const found = lower.indexOf(term);
		return found >= 0 && (best < 0 || found < best) ? found : best;
	}, -1);
	if (match < 0) match = 0;
	const from = Math.max(0, match - Math.floor(limit / 3));
	return `${from > 0 ? "…" : ""}${flat.slice(from, from + limit).trim()}${from + limit < flat.length ? "…" : ""}`;
}

function queryHash(query: Omit<JournalQuery, "cursor">): string {
	return createHash("sha256").update(JSON.stringify(query)).digest("base64url").slice(0, 20);
}

function encodeCursor(offset: number, query: Omit<JournalQuery, "cursor">): string {
	return Buffer.from(JSON.stringify({ v: 1, h: queryHash(query), o: offset })).toString("base64url");
}

function decodeCursor(cursor: string | undefined, query: Omit<JournalQuery, "cursor">): number {
	if (!cursor) return 0;
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as {
			v?: unknown;
			h?: unknown;
			o?: unknown;
		};
		if (parsed.v !== 1 || parsed.h !== queryHash(query) || !Number.isInteger(parsed.o) || (parsed.o as number) < 0) {
			throw new Error("mismatch");
		}
		return parsed.o as number;
	} catch {
		throw new JournalQueryError("cursor is invalid or belongs to a different query");
	}
}

function byTimeThenId(left: JournalRecord, right: JournalRecord): number {
	return left.at.localeCompare(right.at) || left.id.localeCompare(right.id);
}
