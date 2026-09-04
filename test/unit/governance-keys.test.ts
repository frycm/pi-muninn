import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	generateSigningIdentity,
	initializeSigningIdentity,
	parseSigningIdentity,
	publicSigningIdentity,
	readSigningIdentity,
} from "../../src/governance/identity.ts";
import {
	createSigningKeyDescriptor,
	createSigningKeyEvent,
	parseSigningKeyDescriptors,
	parseSigningKeyEvents,
} from "../../src/governance/keys.ts";
import { enrollProjectSigningKey } from "../../src/governance/registry.ts";
import { newHostId, newKeyEventId, newMemberId, newProjectId } from "../../src/ids.ts";
import { ensureStore } from "../../src/store/init.ts";
import { signingIdentityPath } from "../../src/store/paths.ts";
import {
	formatProjectManifest,
	mergeProjectManifests,
	parseProjectManifest,
	SIGNED_PROJECT_MANIFEST_SCHEMA,
	withProjectSigningKey,
} from "../../src/store/project-manifest.ts";

const roots: string[] = [];

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "muninn-signing-"));
	roots.push(path);
	return path;
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function baseManifest(member: string) {
	return parseProjectManifest(
		JSON.stringify({
			schema: 1,
			project: "019c0000-0000-7000-8000-000000000001",
			name: "demo",
			created_at: "2026-09-04T00:00:00.000Z",
			remote: null,
			members: [{ id: member, name: "member" }],
			hosts: [],
			team_events: [],
		}),
	);
}

describe("member signing identity", () => {
	it("is created only explicitly, privately, and idempotently", () => {
		const agentDir = root();
		const member = newMemberId();
		expect(readSigningIdentity(agentDir, member)).toBeUndefined();
		const first = initializeSigningIdentity(agentDir, member, new Date("2026-09-04T12:00:00.000Z"));
		expect(first.created).toBe(true);
		expect(statSync(signingIdentityPath(agentDir)).mode & 0o777).toBe(0o600);
		const second = initializeSigningIdentity(agentDir, member);
		expect(second).toMatchObject({ created: false, identity: { id: first.identity.id, member } });
		const publicView = publicSigningIdentity(first.identity);
		expect(JSON.stringify(publicView)).not.toContain(first.identity.private_key);
		expect(publicView).toMatchObject({ key: first.identity.id, member, algorithm: "ed25519" });
	});

	it("refuses permissive files, a different member, and mismatched private material", () => {
		const agentDir = root();
		const member = newMemberId();
		const other = newMemberId();
		const identity = initializeSigningIdentity(agentDir, member).identity;
		expect(() => readSigningIdentity(agentDir, other)).toThrow(/belongs to member/);
		chmodSync(signingIdentityPath(agentDir), 0o644);
		expect(() => readSigningIdentity(agentDir, member)).toThrow(/group or other/);
		chmodSync(signingIdentityPath(agentDir), 0o600);
		const replacement = generateSigningIdentity(member);
		expect(() => parseSigningIdentity(JSON.stringify({ ...identity, private_key: replacement.private_key }))).toThrow(
			/does not match/,
		);
	});
});

describe("synchronized signing keys", () => {
	it("enrolls keys under the store lock, commits them, and safely replays", async () => {
		const storePath = join(root(), "store");
		const project = newProjectId();
		const member = newMemberId();
		const host = { id: newHostId(), name: "laptop", createdAt: "2026-09-04T00:00:00.000Z" };
		await ensureStore(storePath, {
			host,
			project: {
				id: project,
				name: "demo",
				member: { id: member, name: "member", createdAt: "2026-09-04T00:00:00.000Z" },
			},
		});
		const identity = generateSigningIdentity(member, new Date("2026-09-04T12:00:00.000Z"));
		const options = { storePath, project, member, host, identity };
		const enrolled = await enrollProjectSigningKey(options);
		expect(enrolled).toMatchObject({ replayed: false, committed: true, key: { id: identity.id } });
		expect(enrolled.manifest).toMatchObject({ schema: 2, signing_keys: [{ id: identity.id, member }] });
		const serialized = readFileSync(join(storePath, "project.json"), "utf-8");
		expect(serialized).not.toContain(identity.private_key);
		expect(await enrollProjectSigningKey(options)).toMatchObject({ replayed: true, committed: false });

		const unknownPrevious = generateSigningIdentity(member, new Date("2026-09-04T13:00:00.000Z"));
		const successor = generateSigningIdentity(member, new Date("2026-09-04T14:00:00.000Z"));
		await expect(
			enrollProjectSigningKey({ ...options, identity: successor, previous: unknownPrevious }),
		).rejects.toThrow(/previous signing key.*not enrolled/);
	});

	it("validates self proof, transition proof, event signatures, and manifest merging", () => {
		const member = newMemberId();
		const first = generateSigningIdentity(member, new Date("2026-09-04T12:00:00.000Z"));
		const second = generateSigningIdentity(member, new Date("2026-09-04T13:00:00.000Z"));
		const initial = createSigningKeyDescriptor(first);
		const rotated = createSigningKeyDescriptor(second, first);
		const keys = parseSigningKeyDescriptors([rotated, initial]);
		expect(keys.map((key) => key.id)).toEqual([first.id, second.id].sort((left, right) => left.localeCompare(right)));

		const event = createSigningKeyEvent(
			{
				id: newKeyEventId(),
				at: "2026-09-04T13:00:00.000Z",
				kind: "key-revoked",
				member,
				key: first.id,
				actor_key: second.id,
				effective_at: "2026-09-04T13:00:00.000Z",
			},
			second,
		);
		expect(parseSigningKeyEvents([event], keys)).toEqual([event]);
		expect(() => parseSigningKeyEvents([{ ...event, effective_at: "2020-01-01T00:00:00.000Z" }], keys)).toThrow(
			/signature is invalid/,
		);

		const upgraded = withProjectSigningKey(withProjectSigningKey(baseManifest(member), initial), rotated);
		expect(upgraded.schema).toBe(SIGNED_PROJECT_MANIFEST_SCHEMA);
		expect(JSON.parse(formatProjectManifest(upgraded)).signing_keys).toHaveLength(2);
		const left = { ...upgraded, signing_keys: [initial] };
		const right = { ...upgraded, signing_keys: [rotated] };
		expect(mergeProjectManifests(left, right)).toEqual(mergeProjectManifests(right, left));
	});

	it("refuses key, proof, transition, member, and duplicate collisions", () => {
		const member = newMemberId();
		const first = generateSigningIdentity(member, new Date("2026-09-04T12:00:00.000Z"));
		const second = generateSigningIdentity(member, new Date("2026-09-04T13:00:00.000Z"));
		const initial = createSigningKeyDescriptor(first);
		const rotated = createSigningKeyDescriptor(second, first);
		expect(() => parseSigningKeyDescriptors([{ ...initial, id: second.id }])).toThrow(/does not match/);
		expect(() => parseSigningKeyDescriptors([{ ...initial, proof: rotated.proof }])).toThrow(/proof is invalid/);
		expect(() => parseSigningKeyDescriptors([initial, { ...rotated, transition: initial.proof }])).toThrow(
			/invalid transition/,
		);
		expect(() => parseSigningKeyDescriptors([initial, { ...rotated, member: newMemberId() }])).toThrow(
			/proof is invalid|crosses member/,
		);
		expect(() => parseSigningKeyDescriptors([initial, { ...initial, created_at: rotated.created_at }])).toThrow(
			/proof is invalid|collision/,
		);
		const selfPredecessor = createSigningKeyDescriptor(first, first);
		expect(() => parseSigningKeyDescriptors([selfPredecessor])).toThrow(/itself as predecessor/);
	});

	it("keeps schema-1 formatting free of empty cryptographic fields", () => {
		const manifest = baseManifest(newMemberId());
		const formatted = formatProjectManifest(manifest);
		expect(formatted).not.toContain("signing_keys");
		expect(formatted).not.toContain("key_events");
		expect(() => parseProjectManifest(JSON.stringify({ ...JSON.parse(formatted), signing_keys: [{}] }))).toThrow(
			/cryptographic fields require schema 2/,
		);
	});
});
