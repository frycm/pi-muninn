import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as signingIdentities from "../../src/governance/identity.ts";
import { initializeSigningIdentity, readSigningIdentity } from "../../src/governance/identity.ts";
import {
	declareProjectKeyEvent,
	recoverProjectSigningKey,
	rotateProjectSigningKey,
} from "../../src/governance/operations.ts";
import { enrollProjectSigningKey } from "../../src/governance/registry.ts";
import { initializeProjectCryptography } from "../../src/governance/setup.ts";
import * as signingTransactions from "../../src/governance/transaction.ts";
import { signingTransactionPath } from "../../src/governance/transaction.ts";
import * as signingTrust from "../../src/governance/trust.ts";
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
	vi.restoreAllMocks();
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

	it("explicitly enrolls the shared current identity into another project after rotation", async () => {
		const setup = await fixture();
		const otherStore = join(setup.base, "other-store");
		const otherProject = newProjectId();
		await ensureStore(otherStore, {
			host: setup.host,
			project: {
				id: otherProject,
				name: "other",
				member: { id: setup.member, name: "member", createdAt: setup.host.createdAt },
			},
		});
		await initializeProjectCryptography({
			agentDir: setup.agentDir,
			storePath: otherStore,
			project: otherProject,
			member: setup.member,
			host: setup.host,
		});
		await rotateProjectSigningKey({ ...setup, now: new Date("2026-09-04T11:00:00.000Z") });
		const current = readSigningIdentity(setup.agentDir, setup.member);
		if (!current) throw new Error("current identity is missing");
		const initialized = await initializeProjectCryptography({
			agentDir: setup.agentDir,
			storePath: otherStore,
			project: otherProject,
			member: setup.member,
			host: setup.host,
		});
		expect(initialized).toMatchObject({ identity_created: false, key_enrolled: true, key_pinned: true });
		expect(initialized.identity.key).toBe(current.id);
		expect(initialized.manifest.signing_keys.find((key) => key.id === current.id)?.previous).toBeUndefined();
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
		expect(projection.key(successor.id, successor.created_at)).toBe("untrusted");
	});
});

describe("durable identity publication", () => {
	it.each(["rotation", "recovery"] as const)("resumes the same %s after a failed commit", async (kind) => {
		const setup = await fixture();
		if (kind === "recovery") rmSync(join(setup.agentDir, "muninn", "signing.json"));
		const hook = join(setup.storePath, ".git", "hooks", "pre-commit");
		writeFileSync(hook, "#!/bin/sh\nexit 1\n");
		chmodSync(hook, 0o700);
		const run = () => (kind === "rotation" ? rotateProjectSigningKey(setup) : recoverProjectSigningKey(setup));
		await expect(run()).rejects.toThrow(/commit/);
		const pendingPath = signingTransactionPath(setup.agentDir);
		expect(statSync(pendingPath).mode & 0o777).toBe(0o600);
		const pending = JSON.parse(readFileSync(pendingPath, "utf-8"));
		const bytes = readFileSync(join(setup.storePath, "project.json"), "utf-8");
		expect(bytes).not.toContain(pending.successor.private_key);
		expect(bytes).toContain(pending.successor.id);
		rmSync(hook);
		await run();
		expect(readSigningIdentity(setup.agentDir, setup.member)?.id).toBe(pending.successor.id);
		expect(existsSync(pendingPath)).toBe(false);
		expect(readProjectManifest(setup.storePath)?.signing_keys).toHaveLength(2);
		if (kind === "rotation") expect(readProjectManifest(setup.storePath)?.key_events).toHaveLength(1);
	});
});

it.each([
	"rotation",
	"recovery",
] as const)("resumes %s after private installation but before pending cleanup", async (kind) => {
	const setup = await fixture();
	if (kind === "recovery") rmSync(join(setup.agentDir, "muninn", "signing.json"));
	const run = () => (kind === "rotation" ? rotateProjectSigningKey(setup) : recoverProjectSigningKey(setup));
	vi.spyOn(signingTransactions, "finishSigningTransaction").mockImplementationOnce(() => {
		throw new Error("simulated interruption before cleanup");
	});
	await expect(run()).rejects.toThrow(/simulated interruption/);
	const installed = readSigningIdentity(setup.agentDir, setup.member);
	const pending = JSON.parse(readFileSync(signingTransactionPath(setup.agentDir), "utf-8"));
	expect(installed?.id).toBe(pending.successor.id);
	const resumed = await run();
	expect(resumed.key.key).toBe(installed?.id);
	expect(readProjectManifest(setup.storePath)?.signing_keys).toHaveLength(2);
	expect(readProjectManifest(setup.storePath)?.key_events).toHaveLength(kind === "rotation" ? 1 : 0);
	expect(existsSync(signingTransactionPath(setup.agentDir))).toBe(false);
});

it.each([
	"rotation",
	"recovery",
] as const)("resumes %s after publication but before private installation", async (kind) => {
	const setup = await fixture();
	if (kind === "recovery") rmSync(join(setup.agentDir, "muninn", "signing.json"));
	vi.spyOn(
		signingIdentities,
		kind === "rotation" ? "replaceSigningIdentity" : "installSigningIdentity",
	).mockImplementationOnce(() => {
		throw new Error("simulated installation failure");
	});
	const run = () => (kind === "rotation" ? rotateProjectSigningKey(setup) : recoverProjectSigningKey(setup));
	await expect(run()).rejects.toThrow(/simulated installation failure/);
	expect(readSigningIdentity(setup.agentDir, setup.member)?.id).toBe(
		kind === "rotation" ? setup.signing.id : undefined,
	);
	const pending = JSON.parse(readFileSync(signingTransactionPath(setup.agentDir), "utf-8"));
	expect(readProjectManifest(setup.storePath)?.signing_keys.map((key) => key.id)).toContain(pending.successor.id);
	const resumed = await run();
	expect(resumed.key.key).toBe(pending.successor.id);
	expect(readSigningIdentity(setup.agentDir, setup.member)?.id).toBe(pending.successor.id);
	expect(readProjectManifest(setup.storePath)?.signing_keys).toHaveLength(2);
	expect(existsSync(signingTransactionPath(setup.agentDir))).toBe(false);
});

it("resumes recovery when local trust pinning fails after private installation", async () => {
	const setup = await fixture();
	rmSync(join(setup.agentDir, "muninn", "signing.json"));
	vi.spyOn(signingTrust, "pinProjectSigningKey").mockRejectedValueOnce(new Error("simulated trust write failure"));
	await expect(recoverProjectSigningKey(setup)).rejects.toThrow(/simulated trust write failure/);
	const installed = readSigningIdentity(setup.agentDir, setup.member);
	if (!installed) throw new Error("installed recovery key missing");
	const manifest = readProjectManifest(setup.storePath);
	expect(
		new VerificationProjection(manifest, readProjectTrust(setup.agentDir, setup.project)).key(
			installed.id,
			installed.created_at,
		),
	).toBe("untrusted");
	await expect(initializeProjectCryptography(setup)).rejects.toThrow(/pending/);
	const resumed = await recoverProjectSigningKey(setup);
	expect(resumed.key.key).toBe(installed.id);
	expect(
		new VerificationProjection(
			readProjectManifest(setup.storePath),
			readProjectTrust(setup.agentDir, setup.project),
		).key(installed.id, installed.created_at),
	).toBe("verified");
	expect(existsSync(signingTransactionPath(setup.agentDir))).toBe(false);
});

it("serializes rotations in different projects sharing one private identity", async () => {
	const first = await fixture();
	const second = { ...first, project: newProjectId(), storePath: join(first.base, "second-store") };
	await ensureStore(second.storePath, {
		host: second.host,
		project: {
			id: second.project,
			name: "second",
			member: { id: second.member, name: "member", createdAt: second.host.createdAt },
		},
	});
	await enrollProjectSigningKey({ ...second, identity: second.signing });
	const manifest = readProjectManifest(second.storePath);
	if (!manifest) throw new Error("fixture manifest missing");
	await pinProjectSigningKey({
		agentDir: second.agentDir,
		manifest,
		member: second.member,
		key: second.signing.id,
		host: second.host.id,
	});
	const results = await Promise.allSettled([rotateProjectSigningKey(first), rotateProjectSigningKey(second)]);
	expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	const winner = results.find((result) => result.status === "fulfilled");
	if (winner?.status !== "fulfilled") throw new Error("rotation winner missing");
	expect(readSigningIdentity(first.agentDir, first.member)?.id).toBe(winner.value.key.key);
	expect(
		[
			readProjectManifest(first.storePath)?.signing_keys.length,
			readProjectManifest(second.storePath)?.signing_keys.length,
		].sort(),
	).toEqual([1, 2]);
});
