import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateSigningIdentity, initializeSigningIdentity } from "../../src/governance/identity.ts";
import { createSigningKeyDescriptor, createSigningKeyEvent } from "../../src/governance/keys.ts";
import { enrollProjectSigningKey } from "../../src/governance/registry.ts";
import {
	formatProjectTrust,
	parseProjectTrust,
	pinProjectSigningKey,
	readProjectTrust,
	setVerificationPolicy,
} from "../../src/governance/trust.ts";
import { VerificationProjection } from "../../src/governance/verification.ts";
import { newHostId, newKeyEventId, newMemberId, newProjectId, newTeamEventId } from "../../src/ids.ts";
import { appendJournalRecord } from "../../src/journal/jsonl.ts";
import { JournalQueryService } from "../../src/journal/query.ts";
import { buildJournalRecord } from "../../src/journal/record.ts";
import { appendAuthorizedJournalRecord } from "../../src/journal/writer.ts";
import { ensureStore } from "../../src/store/init.ts";
import { projectTrustPath } from "../../src/store/paths.ts";
import { parseProjectManifest, readProjectManifest, withProjectSigningKey } from "../../src/store/project-manifest.ts";
import { signTeamEvent } from "../../src/team/lifecycle.ts";

const roots: string[] = [];

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "muninn-verification-"));
	roots.push(path);
	return path;
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function manifest(member: string, host: string, project = newProjectId()) {
	return parseProjectManifest(
		JSON.stringify({
			schema: 1,
			project,
			name: "demo",
			created_at: "2026-09-04T00:00:00.000Z",
			remote: null,
			members: [{ id: member, name: "member" }],
			hosts: [{ id: host, name: "host", member }],
			team_events: [],
		}),
	);
}

function trust(project: string, member: string, keys: string[], compromisedHistory: "retain" | "reject" = "retain") {
	return parseProjectTrust(
		JSON.stringify({
			schema: 1,
			project,
			pins: keys.map((key) => ({ member, key, pinned_at: "2026-09-04T10:00:00.000Z" })),
			distrust: [],
			policy: { mode: "observe", required_after: null, compromised_history: compromisedHistory },
		}),
		project,
	);
}

describe("verification projection", () => {
	it("distinguishes every record state and follows a pinned rotation chain", () => {
		const member = newMemberId();
		const host = newHostId();
		const first = generateSigningIdentity(member, new Date("2026-09-04T09:00:00.000Z"));
		const second = generateSigningIdentity(member, new Date("2026-09-04T10:00:00.000Z"));
		const initial = createSigningKeyDescriptor(first);
		const rotated = createSigningKeyDescriptor(second, first);
		let projectManifest = withProjectSigningKey(withProjectSigningKey(manifest(member, host), initial), rotated);
		const localTrust = trust(projectManifest.project, member, [first.id]);
		const unsigned = buildJournalRecord(
			{ type: "note", source: "user", channel: "cli", body: "unsigned" },
			{ project: projectManifest.project, member, host, now: new Date("2026-09-04T11:00:00.000Z") },
		);
		const verified = buildJournalRecord(
			{ type: "note", source: "user", channel: "cli", body: "verified" },
			{ project: projectManifest.project, member, host, now: new Date("2026-09-04T11:00:00.000Z"), signing: first },
		);
		const successor = buildJournalRecord(
			{ type: "note", source: "user", channel: "cli", body: "rotated" },
			{ project: projectManifest.project, member, host, now: new Date("2026-09-04T11:00:00.000Z"), signing: second },
		);
		const stranger = generateSigningIdentity(member);
		const unknown = buildJournalRecord(
			{ type: "note", source: "user", channel: "cli", body: "unknown" },
			{ project: projectManifest.project, member, host, signing: stranger },
		);
		const invalid = { ...verified, body: "tampered" };
		const projection = new VerificationProjection(projectManifest, localTrust);
		expect(projection.record(unsigned)).toBe("unsigned");
		expect(projection.record(unknown)).toBe("unknown-key");
		expect(projection.record(invalid)).toBe("invalid");
		expect(
			new VerificationProjection(projectManifest, trust(projectManifest.project, member, [])).record(verified),
		).toBe("untrusted");
		expect(projection.record(verified)).toBe("verified");
		expect(projection.record(successor)).toBe("verified");

		const revoked = createSigningKeyEvent(
			{
				id: newKeyEventId(),
				at: "2026-09-04T12:00:00.000Z",
				kind: "key-revoked",
				member,
				key: first.id,
				actor_key: first.id,
				effective_at: "2026-09-04T12:00:00.000Z",
			},
			first,
		);
		projectManifest = parseProjectManifest(JSON.stringify({ ...projectManifest, key_events: [revoked] }));
		const afterRevocation = buildJournalRecord(
			{ type: "note", source: "user", channel: "cli", body: "revoked" },
			{ project: projectManifest.project, member, host, now: new Date("2026-09-04T13:00:00.000Z"), signing: first },
		);
		expect(new VerificationProjection(projectManifest, localTrust).record(afterRevocation)).toBe("revoked");

		const compromised = createSigningKeyEvent(
			{
				id: newKeyEventId(),
				at: "2026-09-04T14:00:00.000Z",
				kind: "key-compromised",
				member,
				key: first.id,
				actor_key: second.id,
				effective_at: "2026-09-04T12:00:00.000Z",
			},
			second,
		);
		projectManifest = parseProjectManifest(JSON.stringify({ ...projectManifest, key_events: [revoked, compromised] }));
		const compromisedProjection = new VerificationProjection(projectManifest, localTrust);
		expect(compromisedProjection.record(verified)).toBe("verified");
		expect(compromisedProjection.record(afterRevocation)).toBe("compromised");
		expect(
			new VerificationProjection(projectManifest, trust(projectManifest.project, member, [first.id], "reject")).record(
				verified,
			),
		).toBe("compromised");
	});

	it("projects lifecycle signatures without treating self-enrollment as trust", () => {
		const member = newMemberId();
		const host = newHostId();
		const signing = generateSigningIdentity(member, new Date("2026-09-04T10:00:00.000Z"));
		const projectManifest = withProjectSigningKey(manifest(member, host), createSigningKeyDescriptor(signing));
		const event = signTeamEvent(
			{
				id: newTeamEventId(),
				at: "2026-09-04T12:00:00.000Z",
				kind: "member-renamed",
				member,
				actor_member: member,
				actor_host: host,
				name: "Marty",
			},
			signing,
		);
		expect(
			new VerificationProjection(projectManifest, trust(projectManifest.project, member, [])).teamEvent(event),
		).toBe("untrusted");
		expect(
			new VerificationProjection(projectManifest, trust(projectManifest.project, member, [signing.id])).teamEvent(
				event,
			),
		).toBe("verified");
		expect(
			new VerificationProjection(projectManifest, trust(projectManifest.project, member, [signing.id])).teamEvent({
				...event,
				name: "Mallory",
			}),
		).toBe("invalid");
	});

	it("bounds diagnostics from stale local pins", () => {
		const member = newMemberId();
		const projectManifest = manifest(member, newHostId());
		const unknownKeys = Array.from({ length: 30 }, (_, index) => `ed25519:${String(index).padStart(43, "0")}`);
		const projection = new VerificationProjection(projectManifest, trust(projectManifest.project, member, unknownKeys));
		expect(projection.warnings).toHaveLength(21);
		expect(projection.warnings.at(-1)).toContain("10 additional");
	});
});

describe("local trust and query interfaces", () => {
	it("writes private local pins atomically and refuses unregistered keys", async () => {
		const agentDir = root();
		const member = newMemberId();
		const host = newHostId();
		const signing = generateSigningIdentity(member);
		const projectManifest = withProjectSigningKey(manifest(member, host), createSigningKeyDescriptor(signing));
		const pinned = await pinProjectSigningKey({
			agentDir,
			manifest: projectManifest,
			member,
			key: signing.id,
			host,
			now: new Date("2026-09-04T12:00:00.000Z"),
		});
		expect(pinned.changed).toBe(true);
		expect(statSync(projectTrustPath(agentDir, projectManifest.project)).mode & 0o777).toBe(0o600);
		expect(readProjectTrust(agentDir, projectManifest.project).pins).toEqual([
			{ member, key: signing.id, pinned_at: "2026-09-04T12:00:00.000Z" },
		]);
		expect(
			await pinProjectSigningKey({ agentDir, manifest: projectManifest, member, key: signing.id, host }),
		).toMatchObject({ changed: false });
		await expect(
			pinProjectSigningKey({
				agentDir,
				manifest: projectManifest,
				member,
				key: generateSigningIdentity(member).id,
				host,
			}),
		).rejects.toThrow(/not enrolled/);
		chmodSync(projectTrustPath(agentDir, projectManifest.project), 0o666);
		expect(() => readProjectTrust(agentDir, projectManifest.project)).toThrow(/writable by group or others/);
		expect(formatProjectTrust(pinned.trust)).not.toContain("private");
	});

	it("refuses to overwrite malformed local trust state", async () => {
		const agentDir = root();
		const member = newMemberId();
		const host = newHostId();
		const signing = generateSigningIdentity(member);
		const projectManifest = withProjectSigningKey(manifest(member, host), createSigningKeyDescriptor(signing));
		await pinProjectSigningKey({
			agentDir,
			manifest: projectManifest,
			member,
			key: signing.id,
			host,
		});
		const path = projectTrustPath(agentDir, projectManifest.project);
		writeFileSync(path, "{broken\n", { mode: 0o600 });
		await expect(
			setVerificationPolicy({ agentDir, project: projectManifest.project, host, mode: "require" }),
		).rejects.toThrow(/trust.*invalid/);
		expect(readFileSync(path, "utf-8")).toBe("{broken\n");
	});

	it("keeps scan/index verification filters equal and does not change ranking", async () => {
		const agentDir = root();
		const storePath = join(agentDir, "store");
		const project = newProjectId();
		const member = newMemberId();
		const host = { id: newHostId(), name: "host", createdAt: "2026-09-04T00:00:00.000Z" };
		await ensureStore(storePath, {
			host,
			project: { id: project, name: "demo", member: { id: member, name: "member", createdAt: host.createdAt } },
		});
		const signing = initializeSigningIdentity(agentDir, member, new Date("2026-09-04T10:00:00.000Z")).identity;
		await enrollProjectSigningKey({ storePath, project, member, host, identity: signing });
		const projectManifest = readProjectManifest(storePath);
		if (!projectManifest) throw new Error("manifest fixture is missing");
		await pinProjectSigningKey({ agentDir, manifest: projectManifest, member, key: signing.id, host: host.id });
		const signed = await appendAuthorizedJournalRecord(
			{ authority: "headless-user", record: { type: "note", source: "user", channel: "cli", body: "same terms" } },
			{
				storePath,
				project,
				member,
				host: host.id,
				now: new Date("2026-09-04T12:00:00.000Z"),
				signing,
			},
		);
		const unsigned = await appendJournalRecord(
			{ type: "note", source: "user", channel: "cli", body: "same terms" },
			{ storePath, project, member, host: host.id, now: new Date("2026-09-04T12:00:00.000Z") },
		);
		const scan = new JournalQueryService({ storePath, localMember: member, agentDir, mode: "scan" });
		const index = new JournalQueryService({ storePath, localMember: member, agentDir, mode: "index" });
		for (const service of [scan, index]) {
			expect(service.query({ verification: ["verified"] }).records.map((record) => record.id)).toEqual([signed.id]);
			expect(service.query({ verification: ["unsigned"] }).records.map((record) => record.id)).toEqual([unsigned.id]);
			expect(service.read(signed.id)?.records[0]?.verification).toBe("verified");
			expect(() => service.query({ verification: ["not-a-state"] as never })).toThrow(/unsupported/);
		}
		const trustedScores = scan.query({ query: "same terms" }).records.map((record) => [record.id, record.score]);
		const untrustedScores = new JournalQueryService({ storePath, localMember: member, mode: "scan" })
			.query({ query: "same terms" })
			.records.map((record) => [record.id, record.score]);
		expect(trustedScores).toEqual(untrustedScores);
	});
});
