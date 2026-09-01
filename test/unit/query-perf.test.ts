import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import { journalShardPath } from "../../src/journal/jsonl.ts";
import { JournalQueryService } from "../../src/journal/query.ts";
import { buildJournalRecord, serializeJournalRecord } from "../../src/journal/record.ts";

let store = "";
afterEach(() => {
	if (store) rmSync(store, { recursive: true, force: true });
});

describe("journal performance budgets", () => {
	it("opens and searches a 10,000-record journal within the release budget", () => {
		store = mkdtempSync(join(tmpdir(), "muninn-query-perf-"));
		const project = newProjectId();
		const member = newMemberId();
		const host = newHostId();
		const now = new Date("2026-08-01T00:00:00.000Z");
		const shard = journalShardPath(store, member, host, now);
		mkdirSync(dirname(shard), { recursive: true });
		const lines: string[] = [];
		for (let index = 0; index < 10_000; index++) {
			lines.push(
				serializeJournalRecord(
					buildJournalRecord(
						{
							type: index % 7 === 0 ? "outcome" : "note",
							source: index % 3 === 0 ? "agent" : "user",
							channel: "cli",
							body: `record ${index} deployment database ${index === 9_999 ? "needle-zebra" : "ordinary"}`,
							tags: [`batch-${index % 10}`],
							paths: [`src/part-${index % 100}.ts`],
						},
						{ project, member, host, now },
					),
				),
			);
		}
		writeFileSync(shard, lines.join(""));

		const openAt = performance.now();
		const service = new JournalQueryService({ storePath: store, localMember: member, mode: "index" });
		const openMs = performance.now() - openAt;
		const queryAt = performance.now();
		for (let attempt = 0; attempt < 20; attempt++) {
			expect(service.query({ query: "needle-zebra", limit: 5 }).records).toHaveLength(1);
		}
		const queryMs = performance.now() - queryAt;

		expect(service.size).toBe(10_000);
		expect(openMs).toBeLessThan(8_000);
		expect(queryMs).toBeLessThan(2_000);
	}, 15_000);
});
