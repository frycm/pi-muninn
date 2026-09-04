/** Stable, dependency-free producer contract for optional Muninn integrations. */
import { createHash } from "node:crypto";
import {
	buildJournalRecord,
	type JournalChannel,
	type JournalIntegration,
	type JournalStatus,
	type NewJournalRecord,
	parseJournalRecord,
} from "../journal/record.ts";

export const MUNINN_INTEGRATION_ENTRY_TYPE = "muninn-integration-v1";
export const INTEGRATION_INPUT_MAX_BYTES = 1024 * 1024;
export const INTEGRATION_INPUT_MAX_OBSERVATIONS = 100;

const PLACEHOLDER_ID = "j-019c0000-0000-7000-8000-000000000001";
const PLACEHOLDER_PROJECT = "019c0000-0000-7000-8000-000000000002";
const PLACEHOLDER_MEMBER = "019c0000-0000-7000-8000-000000000003";
const PLACEHOLDER_HOST = "019c0000-0000-7000-8000-000000000004";
const ALLOWED_TYPES = new Set(["note", "checkpoint", "outcome"]);
const ENVELOPE_KEYS = new Set(["schema", "type", "channel", "status", "body", "cue", "tags", "paths", "integration"]);

export interface IntegrationObservation {
	schema: 1;
	type: "note" | "checkpoint" | "outcome";
	channel: JournalChannel;
	status?: JournalStatus;
	body: string;
	cue?: string;
	tags: string[];
	paths: string[];
	integration: JournalIntegration;
}

export interface MuninnIntegrationSessionEntry {
	customType: typeof MUNINN_INTEGRATION_ENTRY_TYPE;
	data: IntegrationObservation;
}

export class IntegrationInputError extends Error {
	constructor(message: string) {
		super(`muninn: invalid integration input: ${message}`);
		this.name = "IntegrationInputError";
	}
}

function object(value: unknown, at: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new IntegrationInputError(`${at} must be an object`);
	}
	return value as Record<string, unknown>;
}

/** Validate one untrusted producer envelope without assigning journal authority or identity. */
export function parseIntegrationObservation(value: unknown): IntegrationObservation {
	const input = object(value, "observation");
	const unknown = Object.keys(input).find((key) => !ENVELOPE_KEYS.has(key));
	if (unknown) throw new IntegrationInputError(`observation has unsupported field ${unknown}`);
	if (input.schema !== 1) throw new IntegrationInputError("observation.schema must be 1");
	try {
		const parsed = parseJournalRecord({
			schema: 1,
			id: PLACEHOLDER_ID,
			at:
				typeof (input.integration as { observed_at?: unknown } | undefined)?.observed_at === "string"
					? (input.integration as { observed_at: string }).observed_at
					: "",
			type: input.type ?? "note",
			project: PLACEHOLDER_PROJECT,
			member: PLACEHOLDER_MEMBER,
			host: PLACEHOLDER_HOST,
			source: "external",
			channel: input.channel ?? "hook",
			...(input.status !== undefined ? { status: input.status } : {}),
			body: input.body,
			...(input.cue !== undefined ? { cue: input.cue } : {}),
			tags: input.tags ?? [],
			paths: input.paths ?? [],
			relations: [],
			integration: input.integration,
		}).record;
		if (!ALLOWED_TYPES.has(parsed.type)) {
			throw new IntegrationInputError("observation.type must be note, checkpoint, or outcome");
		}
		return {
			schema: 1,
			type: parsed.type as IntegrationObservation["type"],
			channel: parsed.channel,
			...(parsed.status ? { status: parsed.status } : {}),
			body: parsed.body,
			...(parsed.cue ? { cue: parsed.cue } : {}),
			tags: parsed.tags,
			paths: parsed.paths,
			integration: parsed.integration as JournalIntegration,
		};
	} catch (error) {
		if (error instanceof IntegrationInputError) throw error;
		throw new IntegrationInputError(error instanceof Error ? error.message : String(error));
	}
}

/** Convert a validated producer envelope into the only journal shape integration authority accepts. */
export function integrationObservationRecord(observation: IntegrationObservation): NewJournalRecord {
	const parsed = parseIntegrationObservation(observation);
	return {
		type: parsed.type,
		source: "external",
		channel: parsed.channel,
		...(parsed.status ? { status: parsed.status } : {}),
		body: parsed.body,
		...(parsed.cue ? { cue: parsed.cue } : {}),
		tags: parsed.tags,
		paths: parsed.paths,
		relations: [],
		integration: parsed.integration,
	};
}

/**
 * Build a pi custom entry with free text redacted before it reaches the session file.
 * The consumer still validates and redacts again before canonical append.
 */
export function muninnIntegrationEntry(value: unknown): MuninnIntegrationSessionEntry {
	const input = integrationObservationRecord(parseIntegrationObservation(value));
	const clean = buildJournalRecord(input, {
		project: PLACEHOLDER_PROJECT,
		member: PLACEHOLDER_MEMBER,
		host: PLACEHOLDER_HOST,
		id: PLACEHOLDER_ID,
		now: new Date(input.integration?.observed_at ?? 0),
	});
	return {
		customType: MUNINN_INTEGRATION_ENTRY_TYPE,
		data: {
			schema: 1,
			type: clean.type as IntegrationObservation["type"],
			channel: clean.channel,
			...(clean.status ? { status: clean.status } : {}),
			body: clean.body,
			...(clean.cue ? { cue: clean.cue } : {}),
			tags: clean.tags,
			paths: clean.paths,
			integration: clean.integration as JournalIntegration,
		},
	};
}

/** Parse a bounded JSON object, array, or JSONL batch completely before any append. */
export function parseIntegrationInput(text: string): IntegrationObservation[] {
	const bytes = Buffer.byteLength(text, "utf-8");
	if (bytes > INTEGRATION_INPUT_MAX_BYTES) {
		throw new IntegrationInputError(`input exceeds ${INTEGRATION_INPUT_MAX_BYTES} bytes`);
	}
	const trimmed = text.trim();
	if (trimmed === "") throw new IntegrationInputError("input is empty");
	let values: unknown[];
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		values = Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		values = trimmed.split(/\r?\n/).map((line, index) => {
			try {
				return JSON.parse(line) as unknown;
			} catch (error) {
				throw new IntegrationInputError(
					`line ${index + 1} is not JSON (${error instanceof Error ? error.message : String(error)})`,
				);
			}
		});
	}
	if (values.length < 1 || values.length > INTEGRATION_INPUT_MAX_OBSERVATIONS) {
		throw new IntegrationInputError(`input must contain 1 to ${INTEGRATION_INPUT_MAX_OBSERVATIONS} observations`);
	}
	return values.map(parseIntegrationObservation);
}

interface CustomEntryLike {
	id?: string;
	type?: string;
	customType?: string;
	data?: unknown;
}

export interface CollectedIntegrationEntries {
	observations: Array<{ key: string; observation: IntegrationObservation }>;
	problems: string[];
}

/** Fold producer entries out of an authoritative pi session branch. */
export function collectIntegrationEntries(entries: readonly CustomEntryLike[]): CollectedIntegrationEntries {
	const observations: CollectedIntegrationEntries["observations"] = [];
	const problems: string[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index] as CustomEntryLike;
		if (entry.type !== "custom" || entry.customType !== MUNINN_INTEGRATION_ENTRY_TYPE) continue;
		const key = entry.id ?? createHash("sha256").update(JSON.stringify(entry.data)).digest("base64url");
		if (seen.has(key)) continue;
		seen.add(key);
		try {
			observations.push({ key, observation: parseIntegrationObservation(entry.data) });
		} catch (error) {
			problems.push(
				`session integration entry ${entry.id ?? index}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { observations, problems };
}
