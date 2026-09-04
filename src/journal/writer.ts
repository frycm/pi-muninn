/** One authority boundary for every non-migration project-journal write. */
import { relative } from "node:path";
import { assertRecordPolicy } from "../governance/enforcement.ts";
import { assertSigningIdentityEnrolled } from "../governance/identity.ts";
import { readProjectTrust } from "../governance/trust.ts";
import { isEntryId, newEntryId } from "../ids.ts";
import { withStoreLock } from "../store/lock.ts";
import { readProjectManifest } from "../store/project-manifest.ts";
import {
	type AppendJournalOptions,
	type AppendJournalResult,
	appendJournalRecord,
	appendJournalRecordLocked,
	scanJournal,
} from "./jsonl.ts";
import type {
	JournalChannel,
	JournalGitProvenance,
	JournalRelationType,
	JournalSessionPointer,
	NewJournalRecord,
} from "./record.ts";
import { buildJournalRecord, journalRecordSigningPayload, serializeJournalRecord } from "./record.ts";
import { projectRelations } from "./relations.ts";

export type JournalWriterAuthority = "attended-user" | "headless-user" | "model" | "automatic" | "integration";

export interface AuthorizedJournalWrite {
	authority: JournalWriterAuthority;
	record: NewJournalRecord;
}

export class JournalAuthorityError extends Error {
	constructor(message: string) {
		super(`muninn: journal write refused: ${message}`);
		this.name = "JournalAuthorityError";
	}
}

function directUser(authority: JournalWriterAuthority): boolean {
	return authority === "attended-user" || authority === "headless-user";
}

function assertAuthority(write: AuthorizedJournalWrite, id: string): void {
	const { authority, record } = write;
	if (record.legacy || record.redacted) {
		throw new JournalAuthorityError("legacy and redaction metadata are assigned only by trusted code");
	}
	if (record.relations?.some((relation) => relation.target === id)) {
		throw new JournalAuthorityError(`record ${id} cannot relate to itself`);
	}
	const relationKeys = new Set<string>();
	for (const relation of record.relations ?? []) {
		const key = `${relation.type}:${relation.target}`;
		if (relationKeys.has(key)) throw new JournalAuthorityError(`duplicate relation ${key}`);
		relationKeys.add(key);
	}

	if (directUser(authority)) {
		if (record.source !== "user") throw new JournalAuthorityError(`${authority} writes must use source: user`);
		if (record.type === "import") throw new JournalAuthorityError("only migration can create import records");
		if (record.type === "correction" && (record.relations?.length ?? 0) === 0) {
			throw new JournalAuthorityError("a correction must relate to at least one earlier record");
		}
		return;
	}

	if (record.source === "user") throw new JournalAuthorityError(`${authority} cannot write source: user`);
	if (record.type === "correction" || record.type === "import") {
		throw new JournalAuthorityError(`${authority} cannot create ${record.type} records`);
	}
	if (authority === "integration") {
		if (record.source !== "external") throw new JournalAuthorityError("integration writes must use source: external");
		if (!record.integration) throw new JournalAuthorityError("integration writes need integration provenance");
		if ((record.relations?.length ?? 0) > 0) {
			throw new JournalAuthorityError("integration writes cannot assign correction meaning");
		}
		return;
	}
	if (authority === "model") {
		if (record.source !== "agent" || record.type !== "note") {
			throw new JournalAuthorityError("model tools may append only source: agent note records");
		}
		const forbidden = record.relations?.find((relation) => relation.type !== "annotates");
		if (forbidden) throw new JournalAuthorityError(`model tools cannot create ${forbidden.type} relations`);
		return;
	}
	if (record.source !== "agent" || (record.type !== "outcome" && record.type !== "checkpoint")) {
		throw new JournalAuthorityError("automatic capture may append only agent outcomes or checkpoints");
	}
	if ((record.relations?.length ?? 0) > 0) {
		throw new JournalAuthorityError("automatic capture cannot assign correction meaning");
	}
}

export interface AppendIntegrationResult extends AppendJournalResult {
	replayed: boolean;
}

function assertSigningEnrollment(options: AppendJournalOptions): void {
	if (!options.signing) return;
	const manifest = readProjectManifest(options.storePath);
	if (!manifest) throw new JournalAuthorityError(`cannot sign without project.json`);
	if (manifest.project !== options.project) throw new JournalAuthorityError(`cannot sign for another project`);
	assertSigningIdentityEnrolled(manifest, options.signing, options.member);
}

function governedOptions(options: AppendJournalOptions): AppendJournalOptions {
	const agentDir = options.agentDir;
	if (!agentDir) return options;
	return {
		...options,
		validateRecord(record) {
			options.validateRecord?.(record);
			const manifest = readProjectManifest(options.storePath);
			if (!manifest || manifest.project !== options.project) {
				throw new JournalAuthorityError("cannot enforce policy without this project's manifest");
			}
			assertRecordPolicy(record, manifest, readProjectTrust(agentDir, options.project));
		},
	};
}

/**
 * Append one external observation exactly once per provider/external ID.
 *
 * The lookup and append share the store lock, so two process integrations
 * replaying the same delivery cannot race into duplicate journal records.
 */
export async function appendIntegrationObservation(
	record: NewJournalRecord,
	options: Omit<AppendJournalOptions, "id" | "now">,
): Promise<AppendIntegrationResult> {
	assertAuthority({ authority: "integration", record }, newEntryId());
	assertSigningEnrollment(options);
	const integration = record.integration as NonNullable<NewJournalRecord["integration"]>;
	return withStoreLock(options.storePath, "append", { host: options.host }, () => {
		const scan = scanJournal(options.storePath);
		if (scan.problems.length > 0) {
			throw new JournalAuthorityError(`cannot ingest into a damaged journal (${scan.problems[0]?.message})`);
		}
		const existingItem = scan.records.find(
			(candidate) =>
				candidate.record.integration?.provider === integration.provider &&
				candidate.record.integration.external_id === integration.external_id,
		);
		if (existingItem) {
			const existing = existingItem.record;
			// task/session/Git are assigned by the local adapter, not by the
			// producer. A delivery replayed after a checkout change must therefore
			// compare against the context captured by its first successful import.
			const comparable: NewJournalRecord = {
				type: record.type,
				source: record.source,
				channel: record.channel,
				...(record.status ? { status: record.status } : {}),
				body: record.body,
				...(record.cue ? { cue: record.cue } : {}),
				tags: record.tags ?? [],
				paths: record.paths ?? [],
				relations: [],
				integration,
				...(existing.task ? { task: existing.task } : {}),
				...(existing.continues ? { continues: existing.continues } : {}),
				...(existing.session ? { session: existing.session } : {}),
				...(existing.git ? { git: existing.git } : {}),
			};
			const candidate = buildJournalRecord(comparable, {
				project: existing.project,
				member: existing.member,
				host: existing.host,
				id: existing.id,
				now: new Date(existing.at),
			});
			if (!journalRecordSigningPayload(candidate).equals(journalRecordSigningPayload(existing))) {
				throw new JournalAuthorityError(
					`integration key ${integration.provider}/${integration.external_id} was reused with different content`,
				);
			}
			return {
				id: existing.id,
				path: existingItem.path,
				shard: relative(options.storePath, existingItem.path).split("\\").join("/"),
				record: existing,
				bytes: Buffer.byteLength(serializeJournalRecord(existing), "utf-8"),
				replayed: true,
			};
		}
		const written = appendJournalRecordLocked(
			record,
			governedOptions({
				...options,
				now: new Date(integration.observed_at),
			}),
		);
		return { ...written, replayed: false };
	});
}

/** Validate authority before bytes are built, redacted or appended. */
export async function appendAuthorizedJournalRecord(
	write: AuthorizedJournalWrite,
	options: AppendJournalOptions,
): Promise<AppendJournalResult> {
	if (write.authority === "integration") {
		throw new JournalAuthorityError("integration writes must use the idempotent integration writer");
	}
	const id = options.id ?? newEntryId();
	assertAuthority(write, id);
	assertSigningEnrollment(options);
	return appendJournalRecord(write.record, governedOptions({ ...options, id }));
}

export interface UserRelationWriteOptions extends Omit<AppendJournalOptions, "id"> {
	authority: "attended-user" | "headless-user";
	target: string;
	text: string;
	relation: JournalRelationType;
	channel: JournalChannel;
	task?: string;
	continues?: string;
	tags?: string[];
	paths?: string[];
	session?: JournalSessionPointer;
	git?: JournalGitProvenance;
}

/** Shared implementation behind attended and headless correct/annotate actions. */
export async function appendUserRelation(options: UserRelationWriteOptions): Promise<AppendJournalResult> {
	if (!isEntryId(options.target)) throw new JournalAuthorityError(`${options.target} is not a journal record id`);
	if (options.text.trim() === "") throw new JournalAuthorityError("correction text cannot be empty");
	return appendAuthorizedJournalRecord(
		{
			authority: options.authority,
			record: {
				type: "correction",
				source: "user",
				channel: options.channel,
				body: options.text,
				tags: options.tags ?? [],
				paths: options.paths ?? [],
				relations: [{ type: options.relation, target: options.target }],
				...(options.task ? { task: options.task } : {}),
				...(options.continues ? { continues: options.continues } : {}),
				...(options.session ? { session: options.session } : {}),
				...(options.git ? { git: options.git } : {}),
			},
		},
		options,
	);
}

export type ResolveConflictResult =
	| { status: "resolved"; branches: string[]; written: AppendJournalResult }
	| { status: "missing" }
	| { status: "not-conflicted" };

export interface ResolveConflictOptions extends Omit<UserRelationWriteOptions, "relation"> {}

/** Resolve exactly the active branches observed under the append lock. */
export async function resolveUserConflict(options: ResolveConflictOptions): Promise<ResolveConflictResult> {
	if (!isEntryId(options.target)) throw new JournalAuthorityError(`${options.target} is not a journal record id`);
	if (options.text.trim() === "") throw new JournalAuthorityError("resolution text cannot be empty");
	assertSigningEnrollment(options);
	return withStoreLock(options.storePath, "append", { host: options.host }, () => {
		const scan = scanJournal(options.storePath);
		if (scan.problems.length > 0) {
			throw new JournalAuthorityError(`cannot resolve a damaged journal (${scan.problems[0]?.message})`);
		}
		const records = scan.records.map((item) => item.record);
		if (!records.some((record) => record.id === options.target)) return { status: "missing" };
		const conflict = projectRelations(records, options.member).conflicts.find(
			(candidate) => candidate.target === options.target,
		);
		if (!conflict) return { status: "not-conflicted" };
		const id = newEntryId();
		const record: NewJournalRecord = {
			type: "correction",
			source: "user",
			channel: options.channel,
			body: options.text,
			tags: options.tags ?? [],
			paths: options.paths ?? [],
			relations: [
				{ type: "corrects", target: options.target },
				...conflict.records.map((target) => ({ type: "supersedes" as const, target })),
			],
			...(options.task ? { task: options.task } : {}),
			...(options.continues ? { continues: options.continues } : {}),
			...(options.session ? { session: options.session } : {}),
			...(options.git ? { git: options.git } : {}),
		};
		assertAuthority({ authority: options.authority, record }, id);
		const written = appendJournalRecordLocked(record, governedOptions({ ...options, id }));
		return { status: "resolved", branches: conflict.records, written };
	});
}
