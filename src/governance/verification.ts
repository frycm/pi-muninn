/** Local projection from synchronized signatures plus explicit trust anchors. */
import type { JournalRecord } from "../journal/record.ts";
import { verifyJournalRecordSignature } from "../journal/record.ts";
import type { ProjectManifest, ProjectTeamEvent } from "../store/project-manifest.ts";
import { verifyTeamEventSignature } from "../team/lifecycle.ts";
import type { SigningKeyDescriptor, SigningKeyEvent } from "./keys.ts";
import type { ProjectTrust } from "./trust.ts";

export const VERIFICATION_STATES = [
	"unsigned",
	"unknown-key",
	"invalid",
	"untrusted",
	"verified",
	"revoked",
	"compromised",
] as const;

export type VerificationState = (typeof VERIFICATION_STATES)[number];
const MAX_VERIFICATION_WARNINGS = 20;

export interface VerificationSummary {
	total: number;
	states: Record<VerificationState, number>;
}

function emptyCounts(): Record<VerificationState, number> {
	return {
		unsigned: 0,
		"unknown-key": 0,
		invalid: 0,
		untrusted: 0,
		verified: 0,
		revoked: 0,
		compromised: 0,
	};
}

/** Immutable for one manifest/trust snapshot; rebuild after sync or a local trust edit. */
export class VerificationProjection {
	readonly trustedKeys: ReadonlySet<string>;
	readonly acceptedKeyEvents: readonly SigningKeyEvent[];
	readonly warnings: readonly string[];
	private readonly keys: Map<string, SigningKeyDescriptor>;
	private readonly distrust: Set<string>;
	private readonly trust: ProjectTrust | undefined;

	constructor(manifest: ProjectManifest | undefined, trust: ProjectTrust | undefined) {
		this.trust = trust;
		this.keys = new Map(manifest?.signing_keys.map((key) => [key.id, key]) ?? []);
		this.distrust = new Set(trust?.distrust.map((entry) => entry.key) ?? []);
		const warnings: string[] = [];
		let omittedWarnings = 0;
		const warn = (message: string) => {
			if (warnings.length < MAX_VERIFICATION_WARNINGS) warnings.push(message);
			else omittedWarnings++;
		};
		const trusted = new Set<string>();
		for (const pin of trust?.pins ?? []) {
			const descriptor = this.keys.get(pin.key);
			if (!descriptor) {
				warn(`local trust pin names unknown key ${pin.key}`);
				continue;
			}
			if (descriptor.member !== pin.member) {
				warn(`local trust pin ${pin.key} names the wrong member`);
				continue;
			}
			if (!this.distrust.has(pin.key)) trusted.add(pin.key);
		}
		let changed = true;
		while (changed) {
			changed = false;
			for (const key of this.keys.values()) {
				if (trusted.has(key.id) || this.distrust.has(key.id) || !key.previous || !trusted.has(key.previous)) continue;
				trusted.add(key.id);
				changed = true;
			}
		}
		this.trustedKeys = trusted;
		const accepted: SigningKeyEvent[] = [];
		for (const event of manifest?.key_events ?? []) {
			if (!trusted.has(event.actor_key)) continue;
			if (this.keyState(event.actor_key, event.at, accepted) !== "verified") continue;
			accepted.push(event);
		}
		this.acceptedKeyEvents = accepted;
		if (omittedWarnings > 0) warnings.push(`${omittedWarnings} additional verification warning(s) omitted`);
		this.warnings = warnings;
	}

	record(record: JournalRecord): VerificationState {
		if (!record.signature) return "unsigned";
		const descriptor = this.keys.get(record.signature.key);
		if (!descriptor) return "unknown-key";
		if (
			descriptor.member !== record.member ||
			record.at < descriptor.created_at ||
			!verifyJournalRecordSignature(record, descriptor.public_key)
		) {
			return "invalid";
		}
		if (!this.trustedKeys.has(descriptor.id)) return "untrusted";
		return this.keyState(descriptor.id, record.at, this.acceptedKeyEvents);
	}

	key(key: string, at: string): VerificationState {
		const descriptor = this.keys.get(key);
		if (!descriptor) return "unknown-key";
		if (at < descriptor.created_at) return "invalid";
		if (!this.trustedKeys.has(key)) return "untrusted";
		return this.keyState(key, at, this.acceptedKeyEvents);
	}

	keyEvent(event: SigningKeyEvent): VerificationState {
		const actor = this.keys.get(event.actor_key);
		if (!actor || actor.member !== event.member || event.at < actor.created_at) return "invalid";
		if (!this.trustedKeys.has(actor.id)) return "untrusted";
		if (this.acceptedKeyEvents.some((candidate) => candidate.id === event.id)) return "verified";
		return this.keyState(actor.id, event.at, this.acceptedKeyEvents);
	}

	teamEvent(event: ProjectTeamEvent): VerificationState {
		if (!event.signature) return "unsigned";
		const descriptor = this.keys.get(event.signature.key);
		if (!descriptor) return "unknown-key";
		if (
			descriptor.member !== event.actor_member ||
			event.at < descriptor.created_at ||
			!verifyTeamEventSignature(event, descriptor.public_key)
		) {
			return "invalid";
		}
		if (!this.trustedKeys.has(descriptor.id)) return "untrusted";
		return this.keyState(descriptor.id, event.at, this.acceptedKeyEvents);
	}

	summarize(records: readonly JournalRecord[]): VerificationSummary {
		const states = emptyCounts();
		for (const record of records) states[this.record(record)]++;
		return { total: records.length, states };
	}

	private keyState(
		key: string,
		at: string,
		events: readonly SigningKeyEvent[],
	): "verified" | "revoked" | "compromised" {
		let revoked = false;
		let compromised = false;
		for (const event of events) {
			if (event.key !== key) continue;
			if (event.kind === "key-compromised") {
				if (this.trust?.policy.compromised_history === "reject" || event.effective_at <= at) compromised = true;
			} else if (event.effective_at <= at) revoked = true;
		}
		return compromised ? "compromised" : revoked ? "revoked" : "verified";
	}
}
