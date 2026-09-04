/** Canonical journal scan, filters, relation-aware ranking and stable DTOs. */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readProjectManifest } from "../store/project-manifest.ts";
import { lifecycleWarnings, projectTeamRoster } from "../team/lifecycle.ts";
import { type JournalScanProblem, scanJournal } from "./jsonl.ts";
import { JournalLexicalIndex, tokenizeJournalText } from "./query-index.ts";
import type { JournalRecord, JournalRecordType, JournalRelationType, JournalSource, JournalStatus } from "./record.ts";
import {
	correctionRank,
	JOURNAL_TRUST_LABELS,
	type JournalTrust,
	projectRelations,
	RELATION_LABELS,
	type RelationLabel,
	type RelationProjection,
	relationNeighborhood,
} from "./relations.ts";

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
	trust?: JournalTrust[];
	label?: RelationLabel[];
	since?: string;
	until?: string;
	relatedTo?: string;
	explain?: boolean;
	limit?: number;
	cursor?: string;
}

export type JournalScoreField = "cue" | "body" | "tags" | "paths";

export interface JournalTermEvidence {
	term: string;
	field: JournalScoreField;
	kind: "exact" | "prefix" | "fuzzy";
	matched: string;
	score: number;
}

export interface JournalPhraseEvidence {
	field: JournalScoreField;
	score: number;
}

export interface JournalGitEvidence {
	kind: "head" | "branch" | "path";
	score: number;
}

export interface JournalScoreExplanation {
	match: "direct" | "relation-expanded";
	expanded_from?: string;
	relation_type?: JournalRelationType;
	exact_id: boolean;
	phrases: JournalPhraseEvidence[];
	terms: JournalTermEvidence[];
	coverage: { matched: number; total: number; score: number };
	git: JournalGitEvidence[];
	components: { lexical: number; relation: number; git: number; recency: number };
	total: number;
	evidence_truncated: boolean;
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
	explanation?: JournalScoreExplanation;
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
	explanation?: JournalScoreExplanation;
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

	has(id: string): boolean {
		return this.projection.views.has(id);
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
			const dto = searchDto(
				candidate,
				this.projection,
				textual,
				this.options.snippetChars ?? DEFAULT_SNIPPET_CHARS,
				query.explain === true,
			);
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
	for (const key of [
		"ids",
		"type",
		"source",
		"member",
		"host",
		"branch",
		"path",
		"tag",
		"status",
		"trust",
		"label",
	] as const) {
		const values = input[key];
		if (values !== undefined) (query as Record<string, unknown>)[key] = [...new Set(values)].sort();
	}
	if (query.trust?.some((value) => !JOURNAL_TRUST_LABELS.includes(value)))
		throw new JournalQueryError("trust contains an unsupported value");
	if (query.label?.some((value) => !RELATION_LABELS.includes(value)))
		throw new JournalQueryError("label contains an unsupported value");
	for (const key of ["since", "until"] as const) {
		const value = input[key];
		if (value === undefined) continue;
		const timestamp = Date.parse(value);
		if (Number.isNaN(timestamp)) throw new JournalQueryError(`${key} must be an RFC 3339 timestamp`);
		query[key] = new Date(timestamp).toISOString();
	}
	if (input.relatedTo !== undefined) query.relatedTo = input.relatedTo;
	if (input.explain !== undefined) {
		if (typeof input.explain !== "boolean") throw new JournalQueryError("explain must be a boolean");
		query.explain = input.explain;
	}
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
	const view = projection.views.get(record.id);
	if (query.ids && !query.ids.includes(record.id)) return false;
	if (query.type && !query.type.includes(record.type)) return false;
	if (query.source && !query.source.includes(record.source)) return false;
	if (query.member && !query.member.includes(record.member)) return false;
	if (query.host && !query.host.includes(record.host)) return false;
	if (query.branch && (!record.git?.branch || !query.branch.includes(record.git.branch))) return false;
	if (query.status && (!record.status || !query.status.includes(record.status))) return false;
	if (query.tag && !query.tag.some((tag) => record.tags.includes(tag))) return false;
	if (query.trust && (!view || !query.trust.includes(view.trust))) return false;
	if (query.label && (!view || !query.label.some((label) => view.labels.includes(label)))) return false;
	if (
		query.path &&
		!query.path.some((path) => record.paths.some((candidate) => candidate === path || candidate.startsWith(`${path}/`)))
	)
		return false;
	if (query.since && record.at < query.since) return false;
	if (query.until && record.at > query.until) return false;
	if (query.relatedTo) {
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
		const lexical = lexicalEvidence(record, query);
		if (query !== "" && lexical.score <= 0) continue;
		const relation = query === "" ? correctionRank(record, projection) : 0;
		const git = gitEvidence(record, currentGit);
		const recency = roundScore(recencyScore(record, all));
		const components = {
			lexical: roundScore(lexical.score),
			relation: roundScore(relation),
			git: roundScore(git.reduce((sum, evidence) => sum + evidence.score, 0)),
			recency,
		};
		const total = componentTotal(components);
		base.set(record.id, {
			record,
			score: total,
			expanded: false,
			explanation: {
				match: "direct",
				exact_id: lexical.exactId,
				phrases: lexical.phrases,
				terms: lexical.terms,
				coverage: lexical.coverage,
				git,
				components,
				total,
				evidence_truncated: lexical.evidenceTruncated,
			},
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
			if (!prior || score > prior.score)
				base.set(correction.id, expandedRank(correction, score, matched.record.id, edge.type, query));
		}
		for (const edge of view.outgoing) {
			const target = eligible.get(edge.to);
			if (!target) continue;
			const score = matched.score - 1;
			const prior = base.get(target.id);
			if (!prior || score > prior.score)
				base.set(target.id, expandedRank(target, score, matched.record.id, edge.type, query));
		}
	}

	return [...base.values()].sort(
		(left, right) =>
			right.score - left.score ||
			right.record.at.localeCompare(left.record.at) ||
			left.record.id.localeCompare(right.record.id),
	);
}

const PHRASE_WEIGHTS: Record<JournalScoreField, number> = { cue: 300, body: 200, tags: 180, paths: 160 };
const TERM_WEIGHTS: Record<JournalScoreField, number> = { cue: 40, body: 20, tags: 35, paths: 30 };
const SCORE_FIELDS: JournalScoreField[] = ["cue", "tags", "paths", "body"];
const MAX_TERM_EVIDENCE = 32;

interface LexicalEvidence {
	score: number;
	exactId: boolean;
	phrases: JournalPhraseEvidence[];
	terms: JournalTermEvidence[];
	coverage: JournalScoreExplanation["coverage"];
	evidenceTruncated: boolean;
}

function lexicalEvidence(record: JournalRecord, rawQuery: string): LexicalEvidence {
	const query = rawQuery.trim().toLowerCase().replace(/^"|"$/g, "");
	const queryTerms = tokenizeJournalText(query);
	const empty = { matched: 0, total: queryTerms.length, score: 0 };
	if (query === "")
		return { score: 0, exactId: false, phrases: [], terms: [], coverage: empty, evidenceTruncated: false };
	if (record.id.toLowerCase() === query)
		return { score: 10_000, exactId: true, phrases: [], terms: [], coverage: empty, evidenceTruncated: false };
	const fields: Record<JournalScoreField, string> = {
		body: record.body.toLowerCase(),
		cue: (record.cue ?? "").toLowerCase(),
		paths: record.paths.join(" ").toLowerCase(),
		tags: record.tags.join(" ").toLowerCase(),
	};
	const tokens = Object.fromEntries(SCORE_FIELDS.map((field) => [field, tokenizeJournalText(fields[field])])) as Record<
		JournalScoreField,
		string[]
	>;
	const phrases: JournalPhraseEvidence[] = [];
	let score = 0;
	for (const field of SCORE_FIELDS) {
		if (!fields[field].includes(query)) continue;
		const phraseScore = PHRASE_WEIGHTS[field];
		phrases.push({ field, score: phraseScore });
		score += phraseScore;
	}
	const evidence: JournalTermEvidence[] = [];
	const matchedTerms = new Set<string>();
	let evidenceCount = 0;
	for (const term of queryTerms) {
		for (const field of SCORE_FIELDS) {
			const matched = strongestToken(tokens[field], term);
			if (!matched) continue;
			const termScore = TERM_WEIGHTS[field];
			score += termScore;
			matchedTerms.add(term);
			evidenceCount++;
			if (evidence.length < MAX_TERM_EVIDENCE)
				evidence.push({
					term: boundedEvidence(term),
					field,
					kind: matched.kind,
					matched: boundedEvidence(matched.token),
					score: termScore,
				});
		}
	}
	return {
		score,
		exactId: false,
		phrases,
		terms: evidence,
		coverage: { matched: matchedTerms.size, total: queryTerms.length, score: 0 },
		evidenceTruncated: evidenceCount > evidence.length,
	};
}

function strongestToken(
	tokens: readonly string[],
	term: string,
): { token: string; kind: "exact" | "prefix" } | undefined {
	const exact = tokens.find((token) => token === term);
	if (exact) return { token: exact, kind: "exact" };
	if (term.length < 3) return undefined;
	const prefix = tokens
		.filter((token) => token.startsWith(term))
		.sort((left, right) => left.length - right.length || left.localeCompare(right))[0];
	return prefix ? { token: prefix, kind: "prefix" } : undefined;
}

function boundedEvidence(value: string): string {
	return value.length <= 100 ? value : `${value.slice(0, 99)}…`;
}

function gitEvidence(record: JournalRecord, current?: JournalQueryServiceOptions["currentGit"]): JournalGitEvidence[] {
	if (!current || !record.git) return [];
	const evidence: JournalGitEvidence[] = [];
	if (current.head && record.git.head === current.head) evidence.push({ kind: "head", score: 5 });
	if (current.branch && record.git.branch === current.branch) evidence.push({ kind: "branch", score: 4 });
	if (current.paths?.some((path) => record.paths.includes(path))) evidence.push({ kind: "path", score: 3 });
	return evidence;
}

function expandedRank(
	record: JournalRecord,
	rawScore: number,
	expandedFrom: string,
	relationType: JournalRelationType,
	query: string,
): Ranked {
	const score = roundScore(rawScore);
	const components = { lexical: 0, relation: score, git: 0, recency: 0 };
	return {
		record,
		score,
		expanded: true,
		explanation: {
			match: "relation-expanded",
			expanded_from: expandedFrom,
			relation_type: relationType,
			exact_id: false,
			phrases: [],
			terms: [],
			coverage: { matched: 0, total: tokenizeJournalText(query).length, score: 0 },
			git: [],
			components,
			total: score,
			evidence_truncated: false,
		},
	};
}

function roundScore(value: number): number {
	return Number(value.toFixed(3));
}

function componentTotal(components: JournalScoreExplanation["components"]): number {
	return roundScore(components.lexical + components.relation + components.git + components.recency);
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
	explain = false,
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
		score: roundScore(ranked.score),
		snippet: snippet(record.body, query, snippetChars),
		expanded: ranked.expanded,
		...(explain && ranked.explanation ? { explanation: ranked.explanation } : {}),
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
