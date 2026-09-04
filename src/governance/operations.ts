/** Explicit rotation, recovery, revocation and compromise workflows. */
import { commitJournalLocked } from "../capture/commit.ts";
import { newKeyEventId } from "../ids.ts";
import type { HostIdentity } from "../store/host.ts";
import { storeIdentity } from "../store/init.ts";
import { withStoreLock } from "../store/lock.ts";
import {
	type ProjectManifest,
	readProjectManifest,
	withProjectKeyEvent,
	withProjectSigningKey,
	writeProjectManifest,
} from "../store/project-manifest.ts";
import {
	assertSigningIdentityEnrolled,
	generateSigningIdentity,
	installSigningIdentity,
	type LocalSigningIdentity,
	publicSigningIdentity,
	readSigningIdentity,
	replaceSigningIdentity,
} from "./identity.ts";
import { createSigningKeyDescriptor, createSigningKeyEvent, type SigningKeyEventKind } from "./keys.ts";
import { enrollProjectSigningKey } from "./registry.ts";
import { pinProjectSigningKey, readProjectTrust } from "./trust.ts";
import { VerificationProjection } from "./verification.ts";

interface GovernanceContext {
	agentDir: string;
	storePath: string;
	project: string;
	member: string;
	host: HostIdentity;
}

function manifestFor(options: GovernanceContext): ProjectManifest {
	const manifest = readProjectManifest(options.storePath);
	if (!manifest) throw new Error(`muninn: no project.json at ${options.storePath}`);
	if (manifest.project !== options.project) throw new Error(`muninn: project manifest belongs to another project`);
	const host = manifest.hosts.find((candidate) => candidate.id === options.host.id);
	if (!host || host.member !== options.member) {
		throw new Error("muninn: local host is not registered to the local member in this project journal");
	}
	return manifest;
}

function assertTrustedActor(
	options: GovernanceContext,
	manifest: ProjectManifest,
	identity: LocalSigningIdentity,
	at: string,
): void {
	assertSigningIdentityEnrolled(manifest, identity, options.member);
	const trust = readProjectTrust(options.agentDir, options.project);
	const state = new VerificationProjection(manifest, trust).key(identity.id, at);
	if (state !== "verified") throw new Error(`muninn: local signing key is ${state}; refusing governance action`);
}

export interface RotateProjectSigningKeyResult {
	schema: 1;
	kind: "key-rotation";
	previous: string;
	key: ReturnType<typeof publicSigningIdentity>;
	event: string;
	committed: boolean;
}

export async function rotateProjectSigningKey(
	options: GovernanceContext & { now?: Date },
): Promise<RotateProjectSigningKeyResult> {
	const at = (options.now ?? new Date()).toISOString();
	const current = readSigningIdentity(options.agentDir, options.member);
	if (!current) throw new Error("muninn: no signing identity; run `muninn crypto init` or recover it");
	const successor = generateSigningIdentity(options.member, new Date(at));
	const result = await withStoreLock(options.storePath, "governance", { host: options.host.id }, async () => {
		const manifest = manifestFor(options);
		assertTrustedActor(options, manifest, current, at);
		const descriptor = createSigningKeyDescriptor(successor, current);
		const event = createSigningKeyEvent(
			{
				id: newKeyEventId(),
				at,
				kind: "key-revoked",
				member: options.member,
				key: current.id,
				actor_key: successor.id,
				effective_at: at,
				reason: "superseded by signed rotation",
			},
			successor,
		);
		writeProjectManifest(options.storePath, withProjectKeyEvent(withProjectSigningKey(manifest, descriptor), event));
		const committed = await commitJournalLocked({
			storePath: options.storePath,
			hostId: options.host.id,
			hostName: options.host.name,
			entries: 0,
			force: true,
			identity: storeIdentity(options.host),
			message: "crypto: rotate member signing key",
		});
		return { event, committed: committed.committed };
	});
	replaceSigningIdentity(options.agentDir, current.id, successor);
	return {
		schema: 1,
		kind: "key-rotation",
		previous: current.id,
		key: publicSigningIdentity(successor),
		event: result.event.id,
		committed: result.committed,
	};
}

export interface RecoverProjectSigningKeyResult {
	schema: 1;
	kind: "key-recovery";
	key: ReturnType<typeof publicSigningIdentity>;
	key_enrolled: boolean;
	key_pinned: boolean;
}

export async function recoverProjectSigningKey(
	options: GovernanceContext & { now?: Date },
): Promise<RecoverProjectSigningKeyResult> {
	if (readSigningIdentity(options.agentDir, options.member)) {
		throw new Error("muninn: recovery requires the local signing identity to be absent");
	}
	const manifest = manifestFor(options);
	if (!manifest.signing_keys.some((key) => key.member === options.member)) {
		throw new Error("muninn: this member has no signing history; use `muninn crypto init`");
	}
	const recovery = generateSigningIdentity(options.member, options.now ?? new Date());
	const enrollment = await enrollProjectSigningKey({
		storePath: options.storePath,
		project: options.project,
		member: options.member,
		host: options.host,
		identity: recovery,
	});
	installSigningIdentity(options.agentDir, recovery);
	const currentManifest = manifestFor(options);
	const pinned = await pinProjectSigningKey({
		agentDir: options.agentDir,
		manifest: currentManifest,
		member: options.member,
		key: recovery.id,
		host: options.host.id,
		...(options.now ? { now: options.now } : {}),
	});
	return {
		schema: 1,
		kind: "key-recovery",
		key: publicSigningIdentity(recovery),
		key_enrolled: !enrollment.replayed,
		key_pinned: pinned.changed,
	};
}

export interface DeclareProjectKeyEventResult {
	schema: 1;
	kind: "key-governance-event";
	event: ReturnType<typeof createSigningKeyEvent>;
	committed: boolean;
}

export async function declareProjectKeyEvent(
	options: GovernanceContext & {
		kind: SigningKeyEventKind;
		key: string;
		effectiveAt?: string;
		reason?: string;
		now?: Date;
		id?: string;
	},
): Promise<DeclareProjectKeyEventResult> {
	const at = (options.now ?? new Date()).toISOString();
	const identity = readSigningIdentity(options.agentDir, options.member);
	if (!identity) throw new Error("muninn: no local signing identity");
	return withStoreLock(options.storePath, "governance", { host: options.host.id }, async () => {
		const manifest = manifestFor(options);
		assertTrustedActor(options, manifest, identity, at);
		const target = manifest.signing_keys.find((key) => key.id === options.key);
		if (!target || target.member !== options.member) {
			throw new Error(`muninn: key ${options.key} is not owned by the local member`);
		}
		if (options.kind === "key-compromised" && identity.id === target.id) {
			throw new Error("muninn: a compromised key declaration needs a different current key; recover first");
		}
		const event = createSigningKeyEvent(
			{
				id: options.id ?? newKeyEventId(),
				at,
				kind: options.kind,
				member: options.member,
				key: target.id,
				actor_key: identity.id,
				effective_at: options.effectiveAt ?? at,
				...(options.reason ? { reason: options.reason } : {}),
			},
			identity,
		);
		const updated = writeProjectManifest(options.storePath, withProjectKeyEvent(manifest, event));
		const stored = updated.key_events.find((candidate) => candidate.id === event.id);
		if (!stored) throw new Error("muninn: key event was not stored");
		const committed = await commitJournalLocked({
			storePath: options.storePath,
			hostId: options.host.id,
			hostName: options.host.name,
			entries: 0,
			force: true,
			identity: storeIdentity(options.host),
			message: `crypto: ${options.kind}`,
		});
		return { schema: 1, kind: "key-governance-event", event: stored, committed: committed.committed };
	});
}
