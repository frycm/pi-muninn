import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newEntryId, newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import {
	evaluateJournal,
	JournalEvaluationError,
	parseJournalEvaluation,
	readJournalEvaluation,
} from "../../src/journal/evaluate.ts";
import { journalShardPath } from "../../src/journal/jsonl.ts";
import { JournalQueryService } from "../../src/journal/query.ts";
import { journalIndexPath } from "../../src/journal/query-index.ts";
import { buildJournalRecord, type NewJournalRecord, serializeJournalRecord } from "../../src/journal/record.ts";

const CORPUS = fileURLToPath(new URL("../fixtures/retrieval/corpus.json", import.meta.url));
const JUDGMENTS = fileURLToPath(new URL("../fixtures/retrieval/judgments.jsonl", import.meta.url));

interface CorpusRecord extends NewJournalRecord {
	id: string;
	at: string;
}

let store: string;
let service: JournalQueryService;
let shard: string;
let localMember: string;

beforeEach(() => {
	store = mkdtempSync(join(tmpdir(), "muninn-evaluate-"));
	const project = newProjectId();
	localMember = newMemberId();
	const host = newHostId();
	const corpus = JSON.parse(readFileSync(CORPUS, "utf-8")) as CorpusRecord[];
	shard = journalShardPath(store, localMember, host, new Date(corpus[0]?.at as string));
	mkdirSync(dirname(shard), { recursive: true });
	writeFileSync(
		shard,
		corpus
			.map(({ id, at, ...record }) =>
				serializeJournalRecord(
					buildJournalRecord(record, { project, member: localMember, host, id, now: new Date(at) }),
				),
			)
			.join(""),
	);
	service = new JournalQueryService({ storePath: store, localMember, mode: "scan" });
});

afterEach(() => rmSync(store, { recursive: true, force: true }));

describe("journal relevance evaluation", () => {
	it("measures the checked-in lexical baseline with standard metrics", () => {
		const judgments = readJournalEvaluation(JUDGMENTS);
		const before = readFileSync(shard);
		const report = evaluateJournal(service, judgments);
		expect(report).toMatchObject({
			schema: 1,
			kind: "journal-evaluation",
			k: 10,
			judgments: 60,
			evaluated: 60,
			problems: [],
			truncated: false,
		});
		expect(report.metrics.recall_at_10).toBeGreaterThanOrEqual(0.9);
		expect(report.metrics.mrr_at_10).toBeGreaterThanOrEqual(0.8);
		expect(report.metrics.ndcg_at_10).toBeGreaterThanOrEqual(0.85);
		expect(readFileSync(shard)).toEqual(before);
		expect(existsSync(journalIndexPath(store))).toBe(false);
	});

	it("produces the same corpus rankings and metrics in scan and index modes", () => {
		const judgments = readJournalEvaluation(JUDGMENTS);
		const indexed = new JournalQueryService({
			storePath: store,
			localMember,
			mode: "index",
		});
		const indexBefore = readFileSync(journalIndexPath(store));
		const scanReport = evaluateJournal(service, judgments);
		const indexReport = evaluateJournal(indexed, judgments);
		expect(indexReport.metrics).toEqual(scanReport.metrics);
		expect(indexReport.results).toEqual(scanReport.results);
		for (const judgment of judgments) {
			expect(indexed.query({ ...judgment.query, explain: true, limit: 10 }).records).toEqual(
				service.query({ ...judgment.query, explain: true, limit: 10 }).records,
			);
		}
		expect(readFileSync(journalIndexPath(store))).toEqual(indexBefore);
	});

	it("reports missing relevant records without including them in aggregate metrics", () => {
		const missing = newEntryId();
		const report = evaluateJournal(service, [{ id: "missing", query: { query: "anything" }, relevant: [missing] }]);
		expect(report).toMatchObject({
			judgments: 1,
			evaluated: 0,
			metrics: { recall_at_10: 0, mrr_at_10: 0, ndcg_at_10: 0 },
			problems: [{ judgment: "missing", missing_relevant: [missing] }],
		});
	});

	it("rejects malformed, duplicate, unknown, and unbounded judgments", () => {
		expect(() => parseJournalEvaluation("{bad\n")).toThrow(JournalEvaluationError);
		const valid = { id: "one", query: "database", relevant: ["j-019c1000-0001-7000-8000-000000000001"] };
		expect(() => parseJournalEvaluation(`${JSON.stringify(valid)}\n${JSON.stringify(valid)}\n`)).toThrow(/duplicates/);
		expect(() => parseJournalEvaluation(`${JSON.stringify({ ...valid, surprise: true })}\n`)).toThrow(/not supported/);
		expect(() => parseJournalEvaluation(`${JSON.stringify({ ...valid, trust: ["untrusted"] })}\n`)).toThrow(
			/does not accept/,
		);
		expect(
			parseJournalEvaluation(`${JSON.stringify({ ...valid, trust: ["local-user"], label: ["conflict"] })}\n`)[0]?.query,
		).toMatchObject({
			trust: ["local-user"],
			label: ["conflict"],
		});
		expect(() => parseJournalEvaluation("x".repeat(1024 * 1024 + 1))).toThrow(/exceeds/);
	});

	it("bounds per-query output while retaining full aggregate metrics", () => {
		const target = "j-019c1000-0001-7000-8000-000000000001";
		const judgments = Array.from({ length: 100 }, (_, index) => ({
			id: `database-${index}`,
			query: { query: "database" },
			relevant: [target],
		}));
		const report = evaluateJournal(service, judgments, { maxChars: 1024 });
		expect(report.metrics.recall_at_10).toBe(1);
		expect(report.truncated).toBe(true);
		expect(report.results.length).toBeLessThan(100);
		expect(JSON.stringify(report).length).toBeLessThanOrEqual(1024);
	});
});
