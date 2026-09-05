/** Reproducible metrics for the authored retrieval fixture; never reads user journals. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newHostId, newMemberId, newProjectId } from "../dist/ids.js";
import { evaluateJournal, readJournalEvaluation } from "../dist/journal/evaluate.js";
import { journalShardPath } from "../dist/journal/jsonl.js";
import { JournalQueryService } from "../dist/journal/query.js";
import { buildJournalRecord, serializeJournalRecord } from "../dist/journal/record.js";

const store = mkdtempSync(join(tmpdir(), "muninn-evaluation-"));
try {
	const project = newProjectId(),
		member = newMemberId(),
		host = newHostId();
	const corpus = JSON.parse(readFileSync(new URL("../test/fixtures/retrieval/corpus.json", import.meta.url), "utf8"));
	const shards = new Map();
	for (const { id, at, ...input } of corpus) {
		const now = new Date(at);
		const path = journalShardPath(store, member, host, now);
		shards.set(
			path,
			(shards.get(path) ?? "") + serializeJournalRecord(buildJournalRecord(input, { id, now, project, member, host })),
		);
	}
	for (const [path, text] of shards) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	}
	const judgments = readJournalEvaluation(new URL("../test/fixtures/retrieval/judgments.jsonl", import.meta.url));
	const report = evaluateJournal(
		new JournalQueryService({ storePath: store, localMember: member, mode: "scan" }),
		judgments,
	);
	console.log(JSON.stringify({ fixture: "crafted-60-v1", ...report }, null, 2));
} finally {
	rmSync(store, { recursive: true, force: true });
}
