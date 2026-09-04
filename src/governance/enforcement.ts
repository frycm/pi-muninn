/** Prospective local policy gates; evidence is never deleted or hidden. */
import { scanJournal } from "../journal/jsonl.ts";
import type { JournalRecord } from "../journal/record.ts";
import { type ProjectManifest, type ProjectTeamEvent, readProjectManifest } from "../store/project-manifest.ts";
import type { ProjectTrust } from "./trust.ts";
import { readProjectTrust } from "./trust.ts";
import { VerificationProjection } from "./verification.ts";

export class VerificationPolicyError extends Error {
	constructor(message: string) {
		super(`muninn: verification policy refused ${message}`);
		this.name = "VerificationPolicyError";
	}
}

function applies(at: string, trust: ProjectTrust): boolean {
	return trust.policy.mode === "require" && at >= (trust.policy.required_after as string);
}

export function assertRecordPolicy(record: JournalRecord, manifest: ProjectManifest, trust: ProjectTrust): void {
	if (!applies(record.at, trust)) return;
	const state = new VerificationProjection(manifest, trust).record(record);
	if (state !== "verified") throw new VerificationPolicyError(`record ${record.id} because it is ${state}`);
}

export function lifecycleEventAllowed(
	event: ProjectTeamEvent,
	trust: ProjectTrust,
	projection: VerificationProjection,
): boolean {
	return !applies(event.at, trust) || projection.teamEvent(event) === "verified";
}

export function assertTeamEventPolicy(event: ProjectTeamEvent, manifest: ProjectManifest, trust: ProjectTrust): void {
	if (!lifecycleEventAllowed(event, trust, new VerificationProjection(manifest, trust))) {
		throw new VerificationPolicyError(`team event ${event.id} because it is not verified`);
	}
}

/** Validate the synchronized result immediately before a push. */
export function projectPolicyProblem(storePath: string, agentDir: string): string | undefined {
	let manifest: ProjectManifest | undefined;
	try {
		manifest = readProjectManifest(storePath);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	if (!manifest) return "project.json is missing";
	let trust: ProjectTrust;
	try {
		trust = readProjectTrust(agentDir, manifest.project);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	if (trust.policy.mode !== "require") return undefined;
	const projection = new VerificationProjection(manifest, trust);
	const scan = scanJournal(storePath);
	if (scan.problems.length > 0) return `journal has ${scan.problems.length} scan problem(s)`;
	for (const item of scan.records) {
		if (!applies(item.record.at, trust)) continue;
		const state = projection.record(item.record);
		if (state !== "verified") return `record ${item.record.id} is ${state}`;
	}
	for (const event of manifest.team_events) {
		if (applies(event.at, trust) && projection.teamEvent(event) !== "verified") {
			return `team event ${event.id} is not verified`;
		}
	}
	for (const event of manifest.key_events) {
		if (applies(event.at, trust) && projection.keyEvent(event) !== "verified") {
			return `key event ${event.id} is not verified`;
		}
	}
	return undefined;
}
