/** Stable, private-key-free cryptographic status for humans and automation. */
import { scanJournal } from "../journal/jsonl.ts";
import type { ProjectManifest } from "../store/project-manifest.ts";
import { readSigningIdentity } from "./identity.ts";
import { readProjectTrust } from "./trust.ts";
import { VERIFICATION_STATES, VerificationProjection, type VerificationState } from "./verification.ts";

export interface CryptographicStatus {
	schema: 1;
	kind: "cryptographic-status";
	project: string;
	member: string;
	identity: { state: "absent" | "unenrolled" | "enrolled"; key?: string };
	keys: { synchronized: number; trusted: number; pins: number; events: number };
	policy: ReturnType<typeof readProjectTrust>["policy"];
	records: { total: number; states: Record<VerificationState, number> };
	team_events: { total: number; states: Record<VerificationState, number> };
	warnings: string[];
}

function counts(): Record<VerificationState, number> {
	return Object.fromEntries(VERIFICATION_STATES.map((state) => [state, 0])) as Record<VerificationState, number>;
}

export function cryptographicStatus(options: {
	agentDir: string;
	storePath: string;
	manifest: ProjectManifest;
	member: string;
}): CryptographicStatus {
	const identity = readSigningIdentity(options.agentDir, options.member);
	const trust = readProjectTrust(options.agentDir, options.manifest.project);
	const projection = new VerificationProjection(options.manifest, trust);
	const records = scanJournal(options.storePath).records.map((item) => item.record);
	const teamStates = counts();
	for (const event of options.manifest.team_events) teamStates[projection.teamEvent(event)]++;
	const enrolled = identity
		? options.manifest.signing_keys.some(
				(key) => key.id === identity.id && key.member === options.member && key.public_key === identity.public_key,
			)
		: false;
	return {
		schema: 1,
		kind: "cryptographic-status",
		project: options.manifest.project,
		member: options.member,
		identity: identity ? { state: enrolled ? "enrolled" : "unenrolled", key: identity.id } : { state: "absent" },
		keys: {
			synchronized: options.manifest.signing_keys.length,
			trusted: projection.trustedKeys.size,
			pins: trust.pins.length,
			events: options.manifest.key_events.length,
		},
		policy: trust.policy,
		records: projection.summarize(records),
		team_events: { total: options.manifest.team_events.length, states: teamStates },
		warnings: [...projection.warnings],
	};
}

export function renderCryptographicStatus(status: CryptographicStatus): string[] {
	const nonzero = (states: Record<VerificationState, number>) =>
		VERIFICATION_STATES.filter((state) => states[state] > 0)
			.map((state) => `${state} ${states[state]}`)
			.join(" · ") || "none";
	return [
		`cryptography: ${status.identity.state}${status.identity.key ? ` · ${status.identity.key}` : ""}`,
		`keys: ${status.keys.synchronized} synchronized · ${status.keys.trusted} trusted · ${status.keys.pins} local pin(s) · ${status.keys.events} event(s)`,
		`policy: ${status.policy.mode}${status.policy.required_after ? ` from ${status.policy.required_after}` : ""} · compromised history ${status.policy.compromised_history}`,
		`records: ${nonzero(status.records.states)}`,
		`team events: ${nonzero(status.team_events.states)}`,
		...status.warnings.map((warning) => `! ${warning}`),
	];
}
