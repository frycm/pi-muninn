import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateSigningIdentity } from "../../src/governance/identity.ts";
import { enrollProjectSigningKey } from "../../src/governance/registry.ts";
import { newEntryId, newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import type { JournalRecord, NewJournalRecord } from "../../src/journal/record.ts";
import {
	buildJournalRecord,
	journalRecordSigningPayload,
	MAX_RECORD_BYTES,
	serializeJournalRecord,
	verifyJournalRecordSignature,
} from "../../src/journal/record.ts";
import { appendAuthorizedJournalRecord, appendIntegrationObservation } from "../../src/journal/writer.ts";
import { ensureStore } from "../../src/store/init.ts";

const roots: string[] = [];

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "muninn-record-signing-"));
	roots.push(path);
	return path;
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function identity() {
	const member = newMemberId();
	return {
		project: newProjectId(),
		member,
		host: newHostId(),
		signing: generateSigningIdentity(member, new Date("2026-09-04T10:00:00.000Z")),
	};
}

function richRecord() {
	const actor = identity();
	const input: NewJournalRecord = {
		type: "checkpoint",
		source: "external",
		channel: "hook",
		task: "task-1",
		continues: "task-0",
		status: "completed",
		body: "Deployment passed.",
		cue: "When checking the deployment",
		tags: ["deploy"],
		paths: ["ops/deploy.yaml"],
		relations: [{ type: "annotates", target: newEntryId() }],
		session: { file: "/sessions/one.jsonl", first: "e-1", last: "e-9" },
		git: {
			worktree: "/code/demo",
			cwd: "/code/demo/ops",
			branch: "main",
			head: "0123456789abcdef0123456789abcdef01234567",
			dirty: false,
		},
		integration: {
			provider: "deploy-hook",
			kind: "deployment",
			event: "completed",
			external_id: "deploy-7",
			observed_at: "2026-09-04T11:00:00.000Z",
			metadata: { attempt: 2, region: "eu" },
		},
		legacy: { store: "/old", path: "memory.md", fingerprint: "sha256:old", fields: { section: 3 } },
		redacted: true,
	};
	const record = buildJournalRecord(input, {
		...actor,
		id: newEntryId(),
		now: new Date("2026-09-04T11:00:00.000Z"),
	});
	return { actor, record };
}

describe("signed journal records", () => {
	it("binds every canonical record field and the named signing key", () => {
		const { actor, record } = richRecord();
		expect(record.signature).toMatchObject({ algorithm: "ed25519", key: actor.signing.id });
		expect(verifyJournalRecordSignature(record, actor.signing.public_key)).toBe(true);
		expect(journalRecordSigningPayload(record).toString("utf-8")).toMatch(/^MUNINN-JOURNAL-RECORD-V1\0/);
		if (!record.git || !record.integration || !record.legacy || !record.signature) {
			throw new Error("rich signing fixture is incomplete");
		}
		const { git, integration, legacy, signature } = record;

		const mutations: Array<(value: JournalRecord) => JournalRecord> = [
			(value) => ({ ...value, id: newEntryId() }),
			(value) => ({ ...value, at: "2026-09-04T11:00:01.000Z" }),
			(value) => ({ ...value, type: "note" }),
			(value) => ({ ...value, project: newProjectId() }),
			(value) => ({ ...value, member: newMemberId() }),
			(value) => ({ ...value, host: newHostId() }),
			(value) => ({ ...value, source: "agent" }),
			(value) => ({ ...value, channel: "sdk" }),
			(value) => ({ ...value, task: "task-2" }),
			(value) => ({ ...value, continues: "task-other" }),
			(value) => ({ ...value, status: "failed" }),
			(value) => ({ ...value, body: "Deployment failed." }),
			(value) => ({ ...value, cue: "Another cue" }),
			(value) => ({ ...value, tags: ["other"] }),
			(value) => ({ ...value, paths: ["ops/other.yaml"] }),
			(value) => ({ ...value, relations: [{ type: "annotates", target: newEntryId() }] }),
			(value) => ({ ...value, session: { ...value.session, file: "/sessions/two.jsonl" } }),
			(value) => ({ ...value, git: { ...git, branch: "release" } }),
			(value) => ({
				...value,
				integration: { ...integration, external_id: "deploy-8" },
			}),
			(value) => ({ ...value, legacy: { ...legacy, fingerprint: "sha256:new" } }),
			(value) => {
				const { redacted: _redacted, ...changed } = value;
				return changed;
			},
			(value) => ({ ...value, signature: { ...signature, key: identity().signing.id } }),
		];
		for (const mutate of mutations) {
			expect(verifyJournalRecordSignature(mutate(record), actor.signing.public_key)).toBe(false);
		}
	});

	it("redacts before signing and applies the line-size limit after adding the envelope", () => {
		const actor = identity();
		const { signing: _signing, ...unsignedActor } = actor;
		const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
		const signed = buildJournalRecord(
			{
				type: "note",
				source: "user",
				channel: "cli",
				body: `token ${secret}`,
				cue: secret,
				tags: [secret],
				integration: {
					provider: "test",
					kind: "event",
					event: "seen",
					external_id: "one",
					observed_at: "2026-09-04T11:00:00.000Z",
					metadata: { credential: secret },
				},
			},
			actor,
		);
		const serialized = serializeJournalRecord(signed);
		expect(serialized).not.toContain(secret);
		expect(signed.redacted).toBe(true);
		expect(verifyJournalRecordSignature(signed, actor.signing.public_key)).toBe(true);

		const base = buildJournalRecord({ type: "note", source: "user", channel: "cli", body: "x" }, unsignedActor);
		const overhead = Buffer.byteLength(serializeJournalRecord(base), "utf-8") - 1;
		const body = "x".repeat(MAX_RECORD_BYTES - overhead);
		const unsigned = buildJournalRecord({ type: "note", source: "user", channel: "cli", body }, unsignedActor);
		expect(Buffer.byteLength(serializeJournalRecord(unsigned), "utf-8")).toBe(MAX_RECORD_BYTES);
		const signedAtLimit = buildJournalRecord(
			{ type: "note", source: "user", channel: "cli", body },
			{ ...actor, signing: actor.signing },
		);
		expect(() => serializeJournalRecord(signedAtLimit)).toThrow(/maximum/);
	});

	it("signs only with an enrolled identity and keeps integration replay idempotent", async () => {
		const storePath = join(root(), "store");
		const actor = identity();
		const host = { id: actor.host, name: "laptop", createdAt: "2026-09-04T00:00:00.000Z" };
		await ensureStore(storePath, {
			host,
			project: {
				id: actor.project,
				name: "demo",
				member: { id: actor.member, name: "member", createdAt: "2026-09-04T00:00:00.000Z" },
			},
		});
		const write = {
			authority: "headless-user" as const,
			record: { type: "note" as const, source: "user" as const, channel: "cli" as const, body: "signed" },
		};
		await expect(appendAuthorizedJournalRecord(write, { storePath, ...actor })).rejects.toThrow(/not enrolled/);
		await enrollProjectSigningKey({
			storePath,
			project: actor.project,
			member: actor.member,
			host,
			identity: actor.signing,
		});
		const written = await appendAuthorizedJournalRecord(write, { storePath, ...actor });
		expect(verifyJournalRecordSignature(written.record, actor.signing.public_key)).toBe(true);

		const observation: NewJournalRecord = {
			type: "checkpoint",
			source: "external",
			channel: "hook",
			body: "remote completed",
			integration: {
				provider: "remote",
				kind: "job",
				event: "completed",
				external_id: "job-1",
				observed_at: "2026-09-04T12:00:00.000Z",
				metadata: {},
			},
		};
		const first = await appendIntegrationObservation(observation, { storePath, ...actor });
		const replay = await appendIntegrationObservation(observation, { storePath, ...actor });
		expect(first.replayed).toBe(false);
		expect(replay).toMatchObject({ id: first.id, replayed: true });
		expect(replay.record.signature).toEqual(first.record.signature);
	});
});
