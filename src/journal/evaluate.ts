/** Read-only relevance judgments and metrics for the canonical journal query service. */
import { readFileSync, statSync } from "node:fs";
import { isEntryId } from "../ids.ts";
import type { JournalQuery, JournalQueryService } from "./query.ts";
import { RECORD_SOURCES, RECORD_STATUSES, RECORD_TYPES } from "./record.ts";

const EVALUATION_SCHEMA = 1 as const;
const EVALUATION_K = 10;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_JUDGMENTS = 100;
const MAX_RELEVANT = 20;
const MAX_FILTER_VALUES = 50;
const DEFAULT_MAX_CHARS = 128 * 1024;

const QUERY_KEYS = [
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
	"since",
	"until",
	"relatedTo",
] as const;
const ARRAY_KEYS = ["ids", "type", "source", "member", "host", "branch", "path", "tag", "status"] as const;

export interface JournalEvaluationJudgment {
	id: string;
	query: Omit<JournalQuery, "cursor" | "limit">;
	relevant: string[];
}

export interface JournalEvaluationMetrics {
	recall_at_10: number;
	mrr_at_10: number;
	ndcg_at_10: number;
}

export interface JournalEvaluationResult extends JournalEvaluationMetrics {
	id: string;
	relevant: number;
	returned: string[];
	hits: string[];
}

export interface JournalEvaluationProblem {
	judgment: string;
	missing_relevant: string[];
}

export interface JournalEvaluationReport {
	schema: typeof EVALUATION_SCHEMA;
	kind: "journal-evaluation";
	k: typeof EVALUATION_K;
	judgments: number;
	evaluated: number;
	metrics: JournalEvaluationMetrics;
	results: JournalEvaluationResult[];
	problems: JournalEvaluationProblem[];
	warnings: string[];
	truncated: boolean;
}

export class JournalEvaluationError extends Error {
	constructor(message: string) {
		super(`muninn: invalid journal evaluation: ${message}`);
		this.name = "JournalEvaluationError";
	}
}

function object(value: unknown, at: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new JournalEvaluationError(`${at} must be an object`);
	}
	return value as Record<string, unknown>;
}

function boundedString(value: unknown, at: string, max: number): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new JournalEvaluationError(`${at} must be a non-empty string`);
	}
	if (value.length > max) throw new JournalEvaluationError(`${at} must be at most ${max} characters`);
	return value;
}

function stringArray(value: unknown, at: string, max = MAX_FILTER_VALUES): string[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > max) {
		throw new JournalEvaluationError(`${at} must contain 1 to ${max} strings`);
	}
	const values = value.map((item, index) => boundedString(item, `${at}[${index}]`, 512));
	return [...new Set(values)].sort();
}

function enumArray(value: unknown, at: string, allowed: readonly string[]): string[] {
	const values = stringArray(value, at);
	const invalid = values.find((item) => !allowed.includes(item));
	if (invalid) throw new JournalEvaluationError(`${at} does not accept "${invalid}"`);
	return values;
}

function parseQuery(raw: Record<string, unknown>, at: string): Omit<JournalQuery, "cursor" | "limit"> {
	const query: Omit<JournalQuery, "cursor" | "limit"> = {};
	if (raw.query !== undefined) query.query = boundedString(raw.query, `${at}.query`, 4096);
	for (const key of ARRAY_KEYS) {
		if (raw[key] === undefined) continue;
		const values =
			key === "type"
				? enumArray(raw[key], `${at}.${key}`, RECORD_TYPES)
				: key === "source"
					? enumArray(raw[key], `${at}.${key}`, RECORD_SOURCES)
					: key === "status"
						? enumArray(raw[key], `${at}.${key}`, RECORD_STATUSES)
						: stringArray(raw[key], `${at}.${key}`);
		(query as Record<string, unknown>)[key] = values;
	}
	for (const key of ["since", "until"] as const) {
		if (raw[key] === undefined) continue;
		const value = boundedString(raw[key], `${at}.${key}`, 100);
		if (Number.isNaN(Date.parse(value))) throw new JournalEvaluationError(`${at}.${key} must be an RFC 3339 timestamp`);
		query[key] = value;
	}
	if (raw.relatedTo !== undefined) {
		const target = boundedString(raw.relatedTo, `${at}.relatedTo`, 50);
		if (!isEntryId(target)) throw new JournalEvaluationError(`${at}.relatedTo must be a journal record ID`);
		query.relatedTo = target;
	}
	if (Object.keys(query).length === 0) throw new JournalEvaluationError(`${at} needs a query or filter`);
	return query;
}

/** Parse the complete judgment file before running any query. */
export function parseJournalEvaluation(text: string, path = "judgments.jsonl"): JournalEvaluationJudgment[] {
	if (Buffer.byteLength(text, "utf-8") > MAX_FILE_BYTES) {
		throw new JournalEvaluationError(`${path} exceeds ${MAX_FILE_BYTES} bytes`);
	}
	const lines = text.split(/\r?\n/).flatMap((line, index) => (line.trim() === "" ? [] : [{ line, number: index + 1 }]));
	if (lines.length < 1 || lines.length > MAX_JUDGMENTS) {
		throw new JournalEvaluationError(`${path} must contain 1 to ${MAX_JUDGMENTS} judgments`);
	}
	const ids = new Set<string>();
	return lines.map(({ line, number }) => {
		const at = `${path}:${number}`;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new JournalEvaluationError(`${at} is not valid JSON`);
		}
		const raw = object(parsed, at);
		const allowed = new Set(["id", "relevant", ...QUERY_KEYS]);
		const unknown = Object.keys(raw).find((key) => !allowed.has(key));
		if (unknown) throw new JournalEvaluationError(`${at}.${unknown} is not supported`);
		const id = boundedString(raw.id, `${at}.id`, 100);
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
			throw new JournalEvaluationError(`${at}.id must use letters, numbers, dot, underscore, or dash`);
		}
		if (ids.has(id)) throw new JournalEvaluationError(`${at}.id duplicates judgment ${id}`);
		ids.add(id);
		const relevant = stringArray(raw.relevant, `${at}.relevant`, MAX_RELEVANT);
		const invalidRelevant = relevant.find((candidate) => !isEntryId(candidate));
		if (invalidRelevant) throw new JournalEvaluationError(`${at}.relevant contains a non-journal record ID`);
		return { id, query: parseQuery(raw, at), relevant };
	});
}

export function readJournalEvaluation(path: string): JournalEvaluationJudgment[] {
	let size: number;
	try {
		size = statSync(path).size;
	} catch (error) {
		throw new JournalEvaluationError(`cannot read ${path} (${error instanceof Error ? error.message : String(error)})`);
	}
	if (size > MAX_FILE_BYTES) throw new JournalEvaluationError(`${path} exceeds ${MAX_FILE_BYTES} bytes`);
	try {
		return parseJournalEvaluation(readFileSync(path, "utf-8"), path);
	} catch (error) {
		if (error instanceof JournalEvaluationError) throw error;
		throw new JournalEvaluationError(`cannot read ${path} (${error instanceof Error ? error.message : String(error)})`);
	}
}

/** Evaluate canonical results at a fixed cutoff without touching transcripts or index state. */
export function evaluateJournal(
	service: JournalQueryService,
	judgments: readonly JournalEvaluationJudgment[],
	options: { maxChars?: number } = {},
): JournalEvaluationReport {
	const results: JournalEvaluationResult[] = [];
	const problems: JournalEvaluationProblem[] = [];
	const warnings = new Set<string>();
	for (const judgment of judgments) {
		const missing = judgment.relevant.filter((id) => !service.has(id));
		if (missing.length > 0) {
			problems.push({ judgment: judgment.id, missing_relevant: missing });
			continue;
		}
		const selected = service.query({ ...judgment.query, limit: EVALUATION_K });
		for (const warning of selected.warnings) warnings.add(warning);
		const returned = selected.records.map((record) => record.id);
		const relevant = new Set(judgment.relevant);
		const hits = returned.filter((id) => relevant.has(id));
		const first = returned.findIndex((id) => relevant.has(id));
		const dcg = returned.reduce((sum, id, index) => sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
		const ideal = Array.from(
			{ length: Math.min(EVALUATION_K, relevant.size) },
			(_, index) => 1 / Math.log2(index + 2),
		).reduce((sum, value) => sum + value, 0);
		results.push({
			id: judgment.id,
			relevant: relevant.size,
			returned,
			hits,
			recall_at_10: rounded(hits.length / relevant.size),
			mrr_at_10: rounded(first < 0 ? 0 : 1 / (first + 1)),
			ndcg_at_10: rounded(ideal === 0 ? 0 : dcg / ideal),
		});
	}

	const metrics = averageMetrics(results);
	const report: JournalEvaluationReport = {
		schema: EVALUATION_SCHEMA,
		kind: "journal-evaluation",
		k: EVALUATION_K,
		judgments: judgments.length,
		evaluated: results.length,
		metrics,
		results: [],
		problems: [],
		warnings: [],
		truncated: false,
	};
	const maxChars = Math.max(1024, options.maxChars ?? DEFAULT_MAX_CHARS);
	for (const problem of problems) {
		if (!fits(report, { problems: [...report.problems, problem] }, maxChars)) {
			report.truncated = true;
			break;
		}
		report.problems.push(problem);
	}
	if (report.problems.length < problems.length) report.truncated = true;
	for (const result of results) {
		if (!fits(report, { results: [...report.results, result] }, maxChars)) {
			report.truncated = true;
			break;
		}
		report.results.push(result);
	}
	if (report.results.length < results.length) report.truncated = true;
	for (const warning of warnings) {
		if (!fits(report, { warnings: [...report.warnings, warning] }, maxChars)) {
			report.truncated = true;
			break;
		}
		report.warnings.push(warning);
	}
	if (report.warnings.length < warnings.size) report.truncated = true;
	return report;
}

export function renderJournalEvaluation(report: JournalEvaluationReport): string[] {
	const lines = [
		`evaluation: ${report.evaluated}/${report.judgments} judgments at ${report.k}`,
		`recall@10 ${fixed(report.metrics.recall_at_10)} · MRR@10 ${fixed(report.metrics.mrr_at_10)} · nDCG@10 ${fixed(report.metrics.ndcg_at_10)}`,
	];
	for (const result of report.results) {
		lines.push(
			`${result.hits.length === result.relevant ? "pass" : "miss"} ${result.id}: recall ${fixed(result.recall_at_10)} · first ${result.mrr_at_10 > 0 ? Math.round(1 / result.mrr_at_10) : "none"}`,
		);
	}
	for (const problem of report.problems) {
		lines.push(`error ${problem.judgment}: ${problem.missing_relevant.length} relevant record(s) are missing`);
	}
	for (const warning of report.warnings) lines.push(`! ${warning}`);
	if (report.truncated) lines.push("! evaluation output truncated");
	return lines;
}

function averageMetrics(results: readonly JournalEvaluationResult[]): JournalEvaluationMetrics {
	if (results.length === 0) return { recall_at_10: 0, mrr_at_10: 0, ndcg_at_10: 0 };
	return {
		recall_at_10: rounded(results.reduce((sum, result) => sum + result.recall_at_10, 0) / results.length),
		mrr_at_10: rounded(results.reduce((sum, result) => sum + result.mrr_at_10, 0) / results.length),
		ndcg_at_10: rounded(results.reduce((sum, result) => sum + result.ndcg_at_10, 0) / results.length),
	};
}

function rounded(value: number): number {
	return Number(value.toFixed(6));
}

function fixed(value: number): string {
	return value.toFixed(3);
}

function fits(
	report: JournalEvaluationReport,
	change: Partial<Pick<JournalEvaluationReport, "results" | "problems" | "warnings">>,
	maxChars: number,
): boolean {
	return JSON.stringify({ ...report, ...change, truncated: false }).length <= maxChars;
}
