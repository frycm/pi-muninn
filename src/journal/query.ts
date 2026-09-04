/** Canonical journal scan, filters, relation-aware ranking and stable DTOs. */
import { createHash } from "node:crypto";
import { readProjectTrust } from "../governance/trust.ts";
import { VERIFICATION_STATES, VerificationProjection, type VerificationState } from "../governance/verification.ts";
import { locateTranscript } from "../integrations/transcript.ts";
import { readProjectManifest } from "../store/project-manifest.ts";
import { lifecycleWarnings, projectTeamRoster } from "../team/lifecycle.ts";
import { type JournalScanProblem, scanJournal } from "./jsonl.ts";
import {
	JournalLexicalIndex,
	type JournalTokenMatchKind,
	journalTokenMatch,
	normalizeJournalText,
	tokenizeJournalText,
} from "./query-index.ts";
import {
	type JournalRecord,
	type JournalRecordType,
	type JournalRelationType,
	type JournalSource,
	type JournalStatus,
	RECORD_SOURCES,
	RECORD_STATUSES,
	RECORD_TYPES,
} from "./record.ts";
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
	integration?: string[];
	trust?: JournalTrust[];
	label?: RelationLabel[];
	verification?: VerificationState[];
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
	integration?: Pick<NonNullable<JournalRecord["integration"]>, "provider" | "kind" | "event">;
	trust: string;
	labels: string[];
	verification: VerificationState;
	score: number;
	snippet: string;
	expanded: boolean;
	explanation?: JournalScoreExplanation;
}

export type VerifiedJournalRecord = JournalRecord & { verification: VerificationState };

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
	records: VerifiedJournalRecord[];
	transcripts: Array<{
		record: string;
		file: string;
		available: boolean;
		availability: "original" | "exchange" | "missing";
		local_file?: string;
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
	/** User-owned root containing local imported transcript exchange copies. */
	agentDir?: string;
	currentGit?: { branch?: string | null; head?: string | null; paths?: string[] };
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_MAX_CHARS = 128 * 1024;
const DEFAULT_SNIPPET_CHARS = 280;
const MAX_FILTER_VALUES = 50;
const MAX_FILTER_CHARS = 512;
const MAX_QUERY_SHAPE_CHARS = 32 * 1024;
const MAX_QUERY_TERMS = 64;

export class JournalQueryService {
	private readonly options: JournalQueryServiceOptions;
	private records: JournalRecord[];
	private problems: JournalScanProblem[];
	private projection: RelationProjection;
	private index?: JournalLexicalIndex;
	private readonly indexWarnings: string[];
	private readonly mode: "scan" | "index";
	private teamWarnings: string[];
	private verification: VerificationProjection;

	constructor(options: JournalQueryServiceOptions) {
		this.options = options;
		const scan = scanJournal(options.storePath);
		this.records = scan.records.map((item) => item.record);
		this.problems = scan.problems;
		const lifecycle = loadLifecycle(options.storePath, this.records, options.localMember);
		this.projection = projectRelations(this.records, options.localMember, lifecycle);
		this.teamWarnings = lifecycle.warnings;
		this.verification = loadVerification(options);
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
		this.verification = loadVerification(this.options);
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
		this.verification = loadVerification(this.options);
		if (this.mode === "index")
			this.index = JournalLexicalIndex.open(this.options.storePath, this.records, forceReindex).index;
	}

	query(input: JournalQuery = {}): JournalQueryResult {
		const query = normalizeQuery(input);
		const limit = query.limit ?? DEFAULT_LIMIT;
		if (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 4096))
			throw new JournalQueryError("cursor must be a string of at most 4096 characters");
		const offset = decodeCursor(input.cursor, query);
		const textual = query.query?.trim() ?? "";
		const candidates = this.mode === "index" && textual !== "" ? this.index?.candidates(textual) : undefined;
		const eligible = this.records.filter((record) =>
			matchesFilters(record, query, this.projection, this.verification.record(record)),
		);
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
		const maxChars = Math.max(1024, this.options.maxChars ?? DEFAULT_MAX_CHARS);
		const response: JournalQueryResult = {
			schema: 1,
			query,
			records: [],
			warnings: [],
			conflicts: [],
			truncated: false,
			mode: this.mode,
		};
		let recordTruncated = false;
		for (const candidate of page) {
			const dto = searchDto(
				candidate,
				this.projection,
				textual,
				this.options.snippetChars ?? DEFAULT_SNIPPET_CHARS,
				query.explain === true,
				this.verification.record(candidate.record),
			);
			const nextRecords = [...response.records, dto];
			const nextConsumed = offset + nextRecords.length;
			const nextHasMore = nextConsumed < ranked.length;
			const candidateResponse: JournalQueryResult = {
				...response,
				records: nextRecords,
				truncated: nextHasMore,
				...(nextHasMore ? { next_cursor: encodeCursor(nextConsumed, query) } : {}),
			};
			if (!queryResultFits(candidateResponse, maxChars)) {
				recordTruncated = true;
				break;
			}
			response.records.push(dto);
		}
		const consumed = offset + response.records.length;
		const hasMore = consumed < ranked.length;
		response.truncated = recordTruncated || hasMore;
		if (hasMore && response.records.length > 0) response.next_cursor = encodeCursor(consumed, query);
		for (const conflict of this.projection.conflicts) {
			if (!queryResultFits({ ...response, conflicts: [...response.conflicts, conflict] }, maxChars)) {
				response.truncated = true;
				break;
			}
			response.conflicts.push(conflict);
		}
		if (response.conflicts.length < this.projection.conflicts.length) response.truncated = true;
		const warnings = this.warnings();
		for (const warning of warnings) {
			if (!queryResultFits({ ...response, warnings: [...response.warnings, warning] }, maxChars)) {
				response.truncated = true;
				break;
			}
			response.warnings.push(warning);
		}
		if (response.warnings.length < warnings.length) response.truncated = true;
		return response;
	}

	read(id: string, relationDepth = 0, limit = 50): JournalReadResult | undefined {
		const neighborhood = relationNeighborhood(this.projection, id, { depth: relationDepth, limit });
		if (!neighborhood) return undefined;
		const records = neighborhood.records.map((view) => ({
			...view.record,
			verification: this.verification.record(view.record),
		}));
		return {
			records,
			transcripts: records.flatMap((record) => {
				if (!record.session) return [];
				const location = locateTranscript(record, this.options.transcriptRoots ?? [], this.options.agentDir);
				return [
					{
						record: record.id,
						file: record.session.file,
						...location,
						...(record.session.first ? { first: record.session.first } : {}),
						...(record.session.last ? { last: record.session.last } : {}),
					},
				];
			}),
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
				target_record: searchDto(
					{ record: target, score: 0, expanded: false },
					this.projection,
					"",
					160,
					false,
					this.verification.record(target),
				),
				branches: conflict.records.flatMap((id) => {
					const record = this.projection.views.get(id)?.record;
					return record
						? [
								searchDto(
									{ record, score: 0, expanded: false },
									this.projection,
									"",
									160,
									false,
									this.verification.record(record),
								),
							]
						: [];
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
			...this.verification.warnings,
			...verificationWarnings(this.verification, this.records),
			...this.projection.cycles.map((cycle) => `relation cycle: ${cycle.join(" -> ")}`),
		];
	}
}

function loadVerification(options: JournalQueryServiceOptions): VerificationProjection {
	const manifest = readProjectManifest(options.storePath);
	const trust = manifest && options.agentDir ? readProjectTrust(options.agentDir, manifest.project) : undefined;
	return new VerificationProjection(manifest, trust);
}

function verificationWarnings(projection: VerificationProjection, records: readonly JournalRecord[]): string[] {
	const summary = projection.summarize(records);
	const concerning = VERIFICATION_STATES.filter(
		(state) => state !== "unsigned" && state !== "verified" && summary.states[state] > 0,
	);
	return concerning.length === 0
		? []
		: [`record verification: ${concerning.map((state) => `${summary.states[state]} ${state}`).join(", ")}`];
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
	if (typeof input !== "object" || input === null || Array.isArray(input))
		throw new JournalQueryError("query must be an object");
	const allowed = new Set([
		"query",
		"ids",
		"type",
		"source",
		"member",
		"host",
		"branch",
		"path",
		"tag",
		"status",
		"integration",
		"trust",
		"label",
		"verification",
		"since",
		"until",
		"relatedTo",
		"explain",
		"limit",
		"cursor",
	]);
	const unknown = Object.keys(input).find((key) => !allowed.has(key));
	if (unknown) throw new JournalQueryError(`unsupported field ${unknown}`);
	const query: Omit<JournalQuery, "cursor"> = {};
	if (input.query !== undefined) {
		if (typeof input.query !== "string") throw new JournalQueryError("query text must be a string");
		if (input.query.length > 4096) throw new JournalQueryError("query text exceeds 4096 characters");
		if (tokenizeJournalText(input.query).length > MAX_QUERY_TERMS)
			throw new JournalQueryError(`query text exceeds ${MAX_QUERY_TERMS} distinct terms`);
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
		"integration",
		"trust",
		"label",
		"verification",
	] as const) {
		const values = input[key];
		if (values === undefined) continue;
		const max = key === "ids" ? 100 : MAX_FILTER_VALUES;
		if (!Array.isArray(values) || values.length < 1 || values.length > max)
			throw new JournalQueryError(`${key} must contain 1 to ${max} values`);
		const invalid = values.find(
			(value) => typeof value !== "string" || value.length < 1 || value.length > MAX_FILTER_CHARS,
		);
		if (invalid !== undefined)
			throw new JournalQueryError(`${key} values must be non-empty strings of at most ${MAX_FILTER_CHARS} characters`);
		(query as Record<string, unknown>)[key] = [...new Set(values)].sort();
	}
	if (query.type?.some((value) => !RECORD_TYPES.includes(value)))
		throw new JournalQueryError("type contains an unsupported value");
	if (query.source?.some((value) => !RECORD_SOURCES.includes(value)))
		throw new JournalQueryError("source contains an unsupported value");
	if (query.status?.some((value) => !RECORD_STATUSES.includes(value)))
		throw new JournalQueryError("status contains an unsupported value");
	if (query.trust?.some((value) => !JOURNAL_TRUST_LABELS.includes(value)))
		throw new JournalQueryError("trust contains an unsupported value");
	if (query.label?.some((value) => !RELATION_LABELS.includes(value)))
		throw new JournalQueryError("label contains an unsupported value");
	if (query.verification?.some((value) => !VERIFICATION_STATES.includes(value))) {
		throw new JournalQueryError("verification contains an unsupported value");
	}
	for (const key of ["since", "until"] as const) {
		const value = input[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || value.length > 100)
			throw new JournalQueryError(`${key} must be an RFC 3339 timestamp`);
		const timestamp = Date.parse(value);
		if (Number.isNaN(timestamp)) throw new JournalQueryError(`${key} must be an RFC 3339 timestamp`);
		query[key] = new Date(timestamp).toISOString();
	}
	if (input.relatedTo !== undefined) {
		if (typeof input.relatedTo !== "string" || input.relatedTo.length < 1 || input.relatedTo.length > 100)
			throw new JournalQueryError("relatedTo must be a non-empty journal record ID");
		query.relatedTo = input.relatedTo;
	}
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
	if (JSON.stringify(query).length > MAX_QUERY_SHAPE_CHARS)
		throw new JournalQueryError(`normalized query exceeds ${MAX_QUERY_SHAPE_CHARS} characters`);
	return query;
}

function matchesFilters(
	record: JournalRecord,
	query: Omit<JournalQuery, "cursor">,
	projection: RelationProjection,
	verification: VerificationState,
): boolean {
	const view = projection.views.get(record.id);
	if (query.ids && !query.ids.includes(record.id)) return false;
	if (query.type && !query.type.includes(record.type)) return false;
	if (query.source && !query.source.includes(record.source)) return false;
	if (query.member && !query.member.includes(record.member)) return false;
	if (query.host && !query.host.includes(record.host)) return false;
	if (query.branch && (!record.git?.branch || !query.branch.includes(record.git.branch))) return false;
	if (query.status && (!record.status || !query.status.includes(record.status))) return false;
	if (query.integration && (!record.integration || !query.integration.includes(record.integration.provider)))
		return false;
	if (query.tag && !query.tag.some((tag) => record.tags.includes(tag))) return false;
	if (query.trust && (!view || !query.trust.includes(view.trust))) return false;
	if (query.label && (!view || !query.label.some((label) => view.labels.includes(label)))) return false;
	if (query.verification && !query.verification.includes(verification)) return false;
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
const TERM_WEIGHTS: Record<JournalTokenMatchKind, Record<JournalScoreField, number>> = {
	exact: { cue: 40, body: 35, tags: 30, paths: 25 },
	prefix: { cue: 32, body: 28, tags: 24, paths: 20 },
	fuzzy: { cue: 6, body: 5, tags: 4, paths: 3 },
};
const COVERAGE_WEIGHT = 25;
const SCORE_FIELDS: JournalScoreField[] = ["cue", "body", "tags", "paths"];
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
	const query = normalizeJournalText(rawQuery.trim()).replace(/^"|"$/g, "");
	const queryTerms = tokenizeJournalText(query);
	const empty = { matched: 0, total: queryTerms.length, score: 0 };
	if (query === "")
		return { score: 0, exactId: false, phrases: [], terms: [], coverage: empty, evidenceTruncated: false };
	if (normalizeJournalText(record.id) === query)
		return { score: 10_000, exactId: true, phrases: [], terms: [], coverage: empty, evidenceTruncated: false };
	const fields: Record<JournalScoreField, string> = {
		body: normalizeJournalText(record.body),
		cue: normalizeJournalText(record.cue ?? ""),
		paths: normalizeJournalText(record.paths.join(" ")),
		tags: normalizeJournalText(record.tags.join(" ")),
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
			const termScore = TERM_WEIGHTS[matched.kind][field];
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
	const coverageScore = matchedTerms.size * COVERAGE_WEIGHT;
	score += coverageScore;
	return {
		score,
		exactId: false,
		phrases,
		terms: evidence,
		coverage: { matched: matchedTerms.size, total: queryTerms.length, score: coverageScore },
		evidenceTruncated: evidenceCount > evidence.length,
	};
}

function strongestToken(
	tokens: readonly string[],
	term: string,
): { token: string; kind: JournalTokenMatchKind } | undefined {
	for (const kind of ["exact", "prefix", "fuzzy"] as const) {
		const matched = tokens
			.filter((token) => journalTokenMatch(term, token) === kind)
			.sort((left, right) => [...left].length - [...right].length || (left < right ? -1 : left > right ? 1 : 0))[0];
		if (matched) return { token: matched, kind };
	}
	return undefined;
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
	verification: VerificationState = "unsigned",
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
		...(record.integration
			? {
					integration: {
						provider: record.integration.provider,
						kind: record.integration.kind,
						event: record.integration.event,
					},
				}
			: {}),
		trust: view?.trust ?? "unknown",
		labels: view?.labels ?? [],
		verification,
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

function queryResultFits(result: JournalQueryResult, maxChars: number): boolean {
	return JSON.stringify(result).length <= maxChars;
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
