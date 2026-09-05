import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateSigningIdentity } from "../../src/governance/identity.ts";
import { createSigningKeyDescriptor } from "../../src/governance/keys.ts";
import { pinProjectSigningKey } from "../../src/governance/trust.ts";
import { newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import { appendJournalRecord, journalShardPath } from "../../src/journal/jsonl.ts";
import { JournalQueryService } from "../../src/journal/query.ts";
import { buildJournalRecord, serializeJournalRecord } from "../../src/journal/record.ts";
import { ensureStore } from "../../src/store/init.ts";
import { readProjectManifest, withProjectSigningKey, writeProjectManifest } from "../../src/store/project-manifest.ts";

let store = "";
afterEach(() => {
	if (store) rmSync(store, { recursive: true, force: true });
});

describe("journal performance budgets", () => {
	it("opens and searches a 50,000-record journal within the release budget", () => {
		store = mkdtempSync(join(tmpdir(), "muninn-query-perf-"));
		const project = newProjectId();
		const member = newMemberId();
		const host = newHostId();
		const now = new Date("2026-08-01T00:00:00.000Z");
		const shard = journalShardPath(store, member, host, now);
		mkdirSync(dirname(shard), { recursive: true });
		const lines: string[] = [];
		for (let index = 0; index < 50_000; index++) {
			lines.push(
				serializeJournalRecord(
					buildJournalRecord(
						{
							type: index % 7 === 0 ? "outcome" : "note",
							source: index % 3 === 0 ? "agent" : "user",
							channel: "cli",
							body: `record ${index} deployment database ${index === 49_999 ? "needle-zebra" : "ordinary"}`,
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
		const queries = ["needle-zebra", "needle-zebrb", "zebra"];
		for (let attempt = 0; attempt < 50; attempt++) {
			expect(service.query({ query: queries[attempt % queries.length] as string, limit: 5 }).records).toHaveLength(1);
		}
		const queryMs = performance.now() - queryAt;
		const browseAt = performance.now();
		expect(service.query({ limit: 5 }).records).toHaveLength(5);
		const browseMs = performance.now() - browseAt;
		console.info(JSON.stringify({ benchmark: "unsigned-50000", openMs, query50Ms: queryMs, browseMs }));

		expect(service.size).toBe(50_000);
		expect(openMs).toBeLessThan(20_000);
		expect(queryMs).toBeLessThan(3_000);
		expect(browseMs).toBeLessThan(3_000);
	}, 30_000);
});

it("budgets cold, warm and append refresh for 10,000 signed records with relations", async () => {
	store = mkdtempSync(join(tmpdir(), "muninn-signed-perf-"));
	const agentDir = join(store, "local-agent");
	const project = newProjectId(),
		member = newMemberId(),
		host = newHostId();
	const now = new Date("2026-08-01T00:00:00.000Z");
	const signing = generateSigningIdentity(member, now);
	await ensureStore(store, {
		host: { id: host, name: "perf", createdAt: now.toISOString() },
		project: { id: project, name: "perf", member: { id: member, name: "perf", createdAt: now.toISOString() } },
	});
	const initial = readProjectManifest(store);
	if (!initial) throw new Error("missing manifest");
	const manifest = writeProjectManifest(store, withProjectSigningKey(initial, createSigningKeyDescriptor(signing)));
	await pinProjectSigningKey({ agentDir, manifest, member, key: signing.id, host });
	const shard = journalShardPath(store, member, host, now);
	mkdirSync(dirname(shard), { recursive: true });
	const records: ReturnType<typeof buildJournalRecord>[] = [];
	for (let n = 0; n < 10_000; n++) {
		const prior = records.at(-1);
		records.push(
			buildJournalRecord(
				{
					type: "note",
					source: n % 3 === 0 ? "agent" : "user",
					channel: "cli",
					body: `signed deployment ${n === 9999 ? "needle-zebra" : "ordinary"} ${n}`,
					...(prior && n % 5 === 0 ? { relations: [{ type: "annotates" as const, target: prior.id }] } : {}),
				},
				{ project, member, host, now, signing },
			),
		);
	}
	writeFileSync(shard, records.map(serializeJournalRecord).join(""));
	const coldAt = performance.now();
	const reader = new JournalQueryService({ storePath: store, agentDir, localMember: member });
	expect(reader.query({ query: "needle-zebra", verification: ["verified"] }).records).toHaveLength(1);
	const coldMs = performance.now() - coldAt;
	const warmAt = performance.now();
	for (let n = 0; n < 50; n++)
		expect(reader.query({ query: "needle-zebrb", verification: ["verified"] }).records).toHaveLength(1);
	const warmMs = performance.now() - warmAt;
	const appendAt = performance.now();
	const added = await appendJournalRecord(
		{ type: "note", source: "user", channel: "cli", body: "needle-zebra appended" },
		{ storePath: store, project, member, host, signing },
	);
	reader.add(added.record);
	expect(reader.query({ query: "needle-zebra", verification: ["verified"] }).records).toHaveLength(2);
	const appendMs = performance.now() - appendAt;
	console.info(JSON.stringify({ benchmark: "signed-10000", coldMs, warm50Ms: warmMs, appendRefreshMs: appendMs }));
	expect(coldMs).toBeLessThan(15_000);
	expect(warmMs).toBeLessThan(3_000);
	expect(appendMs).toBeLessThan(15_000);
}, 60_000);
