import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeSigningIdentity, readSigningIdentity } from "../../src/governance/identity.ts";
import {
	declareProjectKeyEvent,
	recoverProjectSigningKey,
	rotateProjectSigningKey,
} from "../../src/governance/operations.ts";
import { enrollProjectSigningKey } from "../../src/governance/registry.ts";
import {
	distrustProjectSigningKey,
	pinProjectSigningKey,
	readProjectTrust,
	setVerificationPolicy,
} from "../../src/governance/trust.ts";
import { VerificationProjection } from "../../src/governance/verification.ts";
import { newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import { scanJournal } from "../../src/journal/jsonl.ts";
import { buildJournalRecord } from "../../src/journal/record.ts";
import { appendAuthorizedJournalRecord } from "../../src/journal/writer.ts";
import { ensureStore } from "../../src/store/init.ts";
import { readProjectManifest } from "../../src/store/project-manifest.ts";
import { declareTeamEvent, locallyGovernedTeamRoster, projectTeamRoster } from "../../src/team/lifecycle.ts";

const roots: string[] = [];

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "muninn-governance-"));
	roots.push(path);
	return path;
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function fixture() {
	const base = root();
	const agentDir = join(base, "agent-one");
	const storePath = join(base, "store");
	const project = newProjectId();
	const member = newMemberId();
	const host = { id: newHostId(), name: "laptop", createdAt: "2026-09-04T00:00:00.000Z" };
	await ensureStore(storePath, {
		host,
		project: {
			id: project,
			name: "demo",
			member: { id: member, name: "member", createdAt: host.createdAt },
		},
	});
	const signing = initializeSigningIdentity(agentDir, member, new Date("2026-09-04T09:00:00.000Z")).identity;
	await enrollProjectSigningKey({ storePath, project, member, host, identity: signing });
	const manifest = readProjectManifest(storePath);
	if (!manifest) throw new Error("fixture manifest is missing");
	await pinProjectSigningKey({ agentDir, manifest, member, key: signing.id, host: host.id });
	return { base, agentDir, storePath, project, member, host, signing };
}

function note(body: string) {
	return {
		authority: "headless-user" as const,
		record: { type: "note" as const, source: "user" as const, channel: "cli" as const, body },
	};
}

describe("cryptographic governance operations", () => {
	it("rotates through a signed transition and revokes the predecessor prospectively", async () => {
		const setup = await fixture();
		const before = buildJournalRecord(note("before").record, {
			project: setup.project,
			member: setup.member,
			host: setup.host.id,
			now: new Date("2026-09-04T10:00:00.000Z"),
			signing: setup.signing,
		});
		const rotated = await rotateProjectSigningKey({ ...setup, now: new Date("2026-09-04T11:00:00.000Z") });
		const successor = readSigningIdentity(setup.agentDir, setup.member);
		const manifest = readProjectManifest(setup.storePath);
		if (!successor || !manifest) throw new Error("rotation fixture is incomplete");
		expect(successor.id).toBe(rotated.key.key);
		expect(successor.id).not.toBe(setup.signing.id);
		expect(manifest.signing_keys.find((key) => key.id === successor.id)?.previous).toBe(setup.signing.id);
		expect(manifest.key_events).toEqual([
			expect.objectContaining({ kind: "key-revoked", key: setup.signing.id, actor_key: successor.id }),
		]);
		expect(readFileSync(join(setup.storePath, "project.json"), "utf-8")).not.toContain(setup.signing.private_key);

		const afterOld = buildJournalRecord(note("old after rotation").record, {
			project: setup.project,
			member: setup.member,
			host: setup.host.id,
			now: new Date("2026-09-04T12:00:00.000Z"),
			signing: setup.signing,
		});
		const afterNew = buildJournalRecord(note("new after rotation").record, {
			project: setup.project,
			member: setup.member,
			host: setup.host.id,
			now: new Date("2026-09-04T12:00:00.000Z"),
			signing: successor,
		});
		const projection = new VerificationProjection(manifest, readProjectTrust(setup.agentDir, setup.project));
		expect(projection.record(before)).toBe("verified");
		expect(projection.record(afterOld)).toBe("revoked");
		expect(projection.record(afterNew)).toBe("verified");
	});

	it("makes an unchained recovery local until every clone pins it explicitly", async () => {
		const setup = await fixture();
		const agentTwo = join(setup.base, "agent-two");
		const recovered = await recoverProjectSigningKey({
			...setup,
			agentDir: agentTwo,
			now: new Date("2026-09-04T11:00:00.000Z"),
		});
		const manifest = readProjectManifest(setup.storePath);
		if (!manifest) throw new Error("recovery manifest is missing");
		expect(manifest.signing_keys.find((key) => key.id === recovered.key.key)?.previous).toBeUndefined();
		expect(
			new VerificationProjection(manifest, readProjectTrust(agentTwo, setup.project)).key(
				recovered.key.key,
				recovered.key.created_at,
			),
		).toBe("verified");
		expect(
			new VerificationProjection(manifest, readProjectTrust(setup.agentDir, setup.project)).key(
				recovered.key.key,
				recovered.key.created_at,
			),
		).toBe("untrusted");
		await expect(recoverProjectSigningKey({ ...setup, agentDir: agentTwo })).rejects.toThrow(/requires.*absent/);

		await distrustProjectSigningKey({
			agentDir: agentTwo,
			manifest,
			key: recovered.key.key,
			host: setup.host.id,
		});
		expect(
			new VerificationProjection(manifest, readProjectTrust(agentTwo, setup.project)).key(
				recovered.key.key,
				recovered.key.created_at,
			),
		).toBe("untrusted");
		await pinProjectSigningKey({
			agentDir: agentTwo,
			manifest,
			member: setup.member,
			key: recovered.key.key,
			host: setup.host.id,
		});
		expect(readProjectTrust(agentTwo, setup.project).distrust).toEqual([]);
	});

	it("enforces only the local prospective cutoff and ignores refused lifecycle effects", async () => {
		const setup = await fixture();
		const cutoff = "2026-09-04T12:00:00.000Z";
		await setVerificationPolicy({
			agentDir: setup.agentDir,
			project: setup.project,
			host: setup.host.id,
			mode: "require",
			requiredAfter: cutoff,
		});
		await appendAuthorizedJournalRecord(note("legacy unsigned"), {
			storePath: setup.storePath,
			agentDir: setup.agentDir,
			project: setup.project,
			member: setup.member,
			host: setup.host.id,
			now: new Date("2026-09-04T11:00:00.000Z"),
		});
		const count = scanJournal(setup.storePath).records.length;
		await expect(
			appendAuthorizedJournalRecord(note("refused unsigned"), {
				storePath: setup.storePath,
				agentDir: setup.agentDir,
				project: setup.project,
				member: setup.member,
				host: setup.host.id,
				now: new Date("2026-09-04T13:00:00.000Z"),
			}),
		).rejects.toThrow(/policy refused.*unsigned/);
		expect(scanJournal(setup.storePath).records).toHaveLength(count);
		await appendAuthorizedJournalRecord(note("verified"), {
			storePath: setup.storePath,
			agentDir: setup.agentDir,
			project: setup.project,
			member: setup.member,
			host: setup.host.id,
			now: new Date("2026-09-04T13:00:00.000Z"),
			signing: setup.signing,
		});
		await expect(
			declareTeamEvent({
				storePath: setup.storePath,
				agentDir: setup.agentDir,
				project: setup.project,
				actorMember: setup.member,
				actorHost: setup.host.id,
				actorHostName: setup.host.name,
				kind: "member-renamed",
				name: "Refused",
				at: "2026-09-04T13:00:00.000Z",
			}),
		).rejects.toThrow(/policy refused/);
		await declareTeamEvent({
			storePath: setup.storePath,
			project: setup.project,
			actorMember: setup.member,
			actorHost: setup.host.id,
			actorHostName: setup.host.name,
			kind: "member-renamed",
			name: "Unverified",
			at: "2026-09-04T13:00:00.000Z",
		});
		const manifest = readProjectManifest(setup.storePath);
		if (!manifest) throw new Error("policy manifest is missing");
		expect(projectTeamRoster(manifest).members[0]?.name).toBe("Unverified");
		expect(locallyGovernedTeamRoster(manifest, setup.agentDir).members[0]?.name).toBe("member");
	});

	it("applies compromise effective time and the conservative history switch", async () => {
		const setup = await fixture();
		await rotateProjectSigningKey({ ...setup, now: new Date("2026-09-04T12:00:00.000Z") });
		const successor = readSigningIdentity(setup.agentDir, setup.member);
		if (!successor) throw new Error("successor is missing");
		await declareProjectKeyEvent({
			...setup,
			kind: "key-compromised",
			key: setup.signing.id,
			effectiveAt: "2026-09-04T11:00:00.000Z",
			now: new Date("2026-09-04T13:00:00.000Z"),
		});
		const manifest = readProjectManifest(setup.storePath);
		if (!manifest) throw new Error("compromise manifest is missing");
		const oldBefore = buildJournalRecord(note("old before").record, {
			project: setup.project,
			member: setup.member,
			host: setup.host.id,
			now: new Date("2026-09-04T10:00:00.000Z"),
			signing: setup.signing,
		});
		const oldAfter = buildJournalRecord(note("old after").record, {
			project: setup.project,
			member: setup.member,
			host: setup.host.id,
			now: new Date("2026-09-04T11:30:00.000Z"),
			signing: setup.signing,
		});
		let projection = new VerificationProjection(manifest, readProjectTrust(setup.agentDir, setup.project));
		expect(projection.record(oldBefore)).toBe("verified");
		expect(projection.record(oldAfter)).toBe("compromised");
		await setVerificationPolicy({
			agentDir: setup.agentDir,
			project: setup.project,
			host: setup.host.id,
			mode: "observe",
			compromisedHistory: "reject",
		});
		projection = new VerificationProjection(manifest, readProjectTrust(setup.agentDir, setup.project));
		expect(projection.record(oldBefore)).toBe("compromised");
		expect(projection.key(successor.id, successor.created_at)).toBe("verified");
	});
});
