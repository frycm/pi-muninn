/** Advisory team lifecycle declarations and their deterministic roster projection. */
import { commitJournalLocked } from "../capture/commit.ts";
import { assertTeamEventPolicy, lifecycleEventAllowed } from "../governance/enforcement.ts";
import { assertSigningIdentityEnrolled } from "../governance/identity.ts";
import { type SigningMaterial, signatureEnvelope, signingKeyId, verifyPayload } from "../governance/keys.ts";
import { type ProjectTrust, readProjectTrust } from "../governance/trust.ts";
import { VerificationProjection } from "../governance/verification.ts";
import { newTeamEventId } from "../ids.ts";
import type { JournalRecord } from "../journal/record.ts";
import { storeIdentity } from "../store/init.ts";
import { withStoreLock } from "../store/lock.ts";
import {
	type ProjectManifest,
	type ProjectTeamEvent,
	parseProjectTeamEvent,
	readProjectManifest,
	SIGNED_PROJECT_MANIFEST_SCHEMA,
	type TeamEventKind,
	writeProjectManifest,
} from "../store/project-manifest.ts";

const TEAM_EVENT_SIGNATURE_DOMAIN = "MUNINN-TEAM-EVENT-V1\0";

/** Exact domain-separated bytes covered by a lifecycle declaration. */
export function teamEventSigningPayload(event: ProjectTeamEvent): Buffer {
	const unsigned = { ...event };
	delete unsigned.signature;
	const valid = parseProjectTeamEvent(unsigned);
	return Buffer.from(
		`${TEAM_EVENT_SIGNATURE_DOMAIN}${JSON.stringify({
			id: valid.id,
			at: valid.at,
			kind: valid.kind,
			member: valid.member,
			actor_member: valid.actor_member,
			actor_host: valid.actor_host,
			...(valid.host ? { host: valid.host } : {}),
			...(valid.name ? { name: valid.name } : {}),
			...(valid.reason ? { reason: valid.reason } : {}),
		})}`,
		"utf-8",
	);
}

export function signTeamEvent(event: ProjectTeamEvent, material: SigningMaterial): ProjectTeamEvent {
	if (material.member !== event.actor_member) throw new Error("team event signing key belongs to another member");
	if (event.at < material.created_at) throw new Error("team event predates its signing key");
	const unsigned = { ...event };
	delete unsigned.signature;
	const valid = parseProjectTeamEvent(unsigned);
	return parseProjectTeamEvent({ ...valid, signature: signatureEnvelope(teamEventSigningPayload(valid), material) });
}

export function verifyTeamEventSignature(event: ProjectTeamEvent, publicKey: string): boolean {
	try {
		return Boolean(
			event.signature &&
				event.signature.key === signingKeyId(publicKey) &&
				verifyPayload(teamEventSigningPayload(event), event.signature.value, publicKey),
		);
	} catch {
		return false;
	}
}

export type TeamLifecycleState = "active" | "retired";

export interface TeamMemberView {
	id: string;
	name: string;
	state: TeamLifecycleState;
	local: boolean;
}

export interface TeamHostView {
	id: string;
	name: string;
	member: string;
	state: TeamLifecycleState;
	local: boolean;
}

export interface TeamRoster {
	schema: 1;
	kind: "team-roster";
	project: string;
	name: string;
	members: TeamMemberView[];
	hosts: TeamHostView[];
	events: number;
}

/** Apply canonical `(at, id)` events without treating unsigned lifecycle state as authorization. */
export interface TeamRosterGovernance {
	trust: ProjectTrust;
	projection: VerificationProjection;
}

export function projectTeamRoster(
	manifest: ProjectManifest,
	localMember?: string,
	localHost?: string,
	governance?: TeamRosterGovernance,
): TeamRoster {
	const members = new Map(
		manifest.members.map((member) => [
			member.id,
			{ id: member.id, name: member.name, state: "active" as TeamLifecycleState, local: member.id === localMember },
		]),
	);
	const hosts = new Map(
		manifest.hosts.map((host) => [
			host.id,
			{
				id: host.id,
				name: host.name,
				member: host.member,
				state: "active" as TeamLifecycleState,
				local: host.id === localHost,
			},
		]),
	);
	for (const event of manifest.team_events) {
		if (governance && !lifecycleEventAllowed(event, governance.trust, governance.projection)) continue;
		const member = members.get(event.member);
		const host = event.host ? hosts.get(event.host) : undefined;
		switch (event.kind) {
			case "member-renamed":
				if (member && event.name) member.name = event.name;
				break;
			case "member-retired":
				if (member) member.state = "retired";
				break;
			case "member-restored":
				if (member) member.state = "active";
				break;
			case "host-renamed":
				if (host && event.name) host.name = event.name;
				break;
			case "host-retired":
				if (host) host.state = "retired";
				break;
			case "host-restored":
				if (host) host.state = "active";
				break;
		}
	}
	for (const host of hosts.values()) {
		if (members.get(host.member)?.state === "retired") host.state = "retired";
	}
	return {
		schema: 1,
		kind: "team-roster",
		project: manifest.project,
		name: manifest.name,
		members: [...members.values()].sort((left, right) => left.id.localeCompare(right.id)),
		hosts: [...hosts.values()].sort((left, right) => left.id.localeCompare(right.id)),
		events: manifest.team_events.length,
	};
}

export function locallyGovernedTeamRoster(
	manifest: ProjectManifest,
	agentDir: string,
	localMember?: string,
	localHost?: string,
): TeamRoster {
	const trust = readProjectTrust(agentDir, manifest.project);
	return projectTeamRoster(manifest, localMember, localHost, {
		trust,
		projection: new VerificationProjection(manifest, trust),
	});
}

export interface DeclareTeamEventOptions {
	storePath: string;
	project: string;
	actorMember: string;
	actorHost: string;
	actorHostName: string;
	kind: TeamEventKind;
	/** Defaults to the actor. Exposed so callers and tests cannot accidentally administer a teammate. */
	member?: string;
	host?: string;
	name?: string;
	reason?: string;
	at?: string;
	id?: string;
	signing?: SigningMaterial;
	/** Applies this machine's prospective policy; omitted preserves the plain workflow. */
	agentDir?: string;
}

export interface DeclareTeamEventResult {
	event: ProjectTeamEvent;
	roster: TeamRoster;
	committed: boolean;
}

/** Append and commit one self-declaration while holding the same store lock used by sync. */
export async function declareTeamEvent(options: DeclareTeamEventOptions): Promise<DeclareTeamEventResult> {
	return withStoreLock(options.storePath, "team", { host: options.actorHost }, async () => {
		const manifest = readProjectManifest(options.storePath);
		if (!manifest) throw new Error(`muninn: no project.json at ${options.storePath}`);
		if (manifest.project !== options.project) {
			throw new Error(`muninn: project manifest belongs to ${manifest.project}, not ${options.project}`);
		}
		const targetMember = options.member ?? options.actorMember;
		if (targetMember !== options.actorMember)
			throw new Error("muninn: team lifecycle declarations may only target you");
		const actor = manifest.hosts.find((host) => host.id === options.actorHost);
		if (!actor || actor.member !== options.actorMember) {
			throw new Error("muninn: local host is not registered to the local member in this project journal");
		}
		if (!manifest.members.some((member) => member.id === targetMember)) {
			throw new Error(`muninn: member ${targetMember} is not registered in this project journal`);
		}
		if (options.kind.startsWith("host-")) {
			if (!options.host) throw new Error(`muninn: ${options.kind} needs a host ID`);
			const target = manifest.hosts.find((host) => host.id === options.host);
			if (!target) throw new Error(`muninn: host ${options.host} is not registered in this project journal`);
			if (target.member !== options.actorMember)
				throw new Error(`muninn: host ${options.host} is owned by another member`);
		} else if (options.host) {
			throw new Error(`muninn: ${options.kind} cannot target a host`);
		}
		let event: ProjectTeamEvent = parseProjectTeamEvent({
			id: options.id ?? newTeamEventId(),
			at: options.at ?? new Date().toISOString(),
			kind: options.kind,
			member: targetMember,
			actor_member: options.actorMember,
			actor_host: options.actorHost,
			...(options.host ? { host: options.host } : {}),
			...(options.name ? { name: options.name } : {}),
			...(options.reason ? { reason: options.reason } : {}),
		});
		if (options.signing) {
			assertSigningIdentityEnrolled(manifest, options.signing, options.actorMember);
			event = signTeamEvent(event, options.signing);
		}
		const trust = options.agentDir ? readProjectTrust(options.agentDir, manifest.project) : undefined;
		if (trust) assertTeamEventPolicy(event, manifest, trust);
		const updated = writeProjectManifest(options.storePath, {
			...manifest,
			schema: event.signature ? SIGNED_PROJECT_MANIFEST_SCHEMA : manifest.schema,
			team_events: [...manifest.team_events, event],
		});
		const committed = await commitJournalLocked({
			storePath: options.storePath,
			hostId: options.actorHost,
			hostName: options.actorHostName,
			entries: 0,
			force: true,
			identity: storeIdentity({ id: options.actorHost, name: options.actorHostName, createdAt: event.at }),
			message: `team: ${options.kind}`,
		});
		return {
			event: updated.team_events.find((candidate) => candidate.id === event.id) as ProjectTeamEvent,
			roster: projectTeamRoster(
				updated,
				options.actorMember,
				options.actorHost,
				trust ? { trust, projection: new VerificationProjection(updated, trust) } : undefined,
			),
			committed: committed.committed,
		};
	});
}

export function renderTeamRoster(roster: TeamRoster): string[] {
	const lines = [`team: ${roster.name} · ${roster.project}`, "members:"];
	for (const member of roster.members) {
		lines.push(
			`  ${member.state === "active" ? "●" : "○"} ${member.name} · ${member.id}${member.local ? " (you)" : ""}`,
		);
		for (const host of roster.hosts.filter((candidate) => candidate.member === member.id)) {
			lines.push(
				`    ${host.state === "active" ? "●" : "○"} ${host.name} · ${host.id}${host.local ? " (this host)" : ""}`,
			);
		}
	}
	lines.push(`events: ${roster.events}`);
	return lines;
}

/** Warnings are diagnostic only; post-retirement records remain visible and valid. */
export function lifecycleWarnings(
	manifest: ProjectManifest,
	records: readonly JournalRecord[],
	governance?: TeamRosterGovernance,
): string[] {
	const events = manifest.team_events;
	const warnings: string[] = [];
	for (const record of records) {
		let memberState: TeamLifecycleState = "active";
		let hostState: TeamLifecycleState = "active";
		for (const event of events) {
			if (event.at >= record.at) break;
			if (governance && !lifecycleEventAllowed(event, governance.trust, governance.projection)) continue;
			if (event.member === record.member) {
				if (event.kind === "member-retired") memberState = "retired";
				if (event.kind === "member-restored") memberState = "active";
			}
			if (event.host === record.host) {
				if (event.kind === "host-retired") hostState = "retired";
				if (event.kind === "host-restored") hostState = "active";
			}
		}
		if (memberState === "retired" || hostState === "retired") {
			warnings.push(
				`record ${record.id} was written while its ${memberState === "retired" ? "member" : "host"} was retired`,
			);
		}
	}
	return warnings;
}
