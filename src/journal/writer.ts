/** One authority boundary for every non-migration project-journal write. */
import { isEntryId, newEntryId } from "../ids.ts";
import { type AppendJournalOptions, type AppendJournalResult, appendJournalRecord } from "./jsonl.ts";
import type { JournalRelationType, NewJournalRecord } from "./record.ts";

export type JournalWriterAuthority = "attended-user" | "headless-user" | "model" | "automatic";

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

/** Validate authority before bytes are built, redacted or appended. */
export async function appendAuthorizedJournalRecord(
	write: AuthorizedJournalWrite,
	options: AppendJournalOptions,
): Promise<AppendJournalResult> {
	const id = options.id ?? newEntryId();
	assertAuthority(write, id);
	return appendJournalRecord(write.record, { ...options, id });
}

export interface UserRelationWriteOptions extends Omit<AppendJournalOptions, "id"> {
	authority: "attended-user" | "headless-user";
	target: string;
	text: string;
	relation: JournalRelationType;
	channel: "tui" | "rpc" | "sdk" | "cli";
	task?: string;
	continues?: string;
	tags?: string[];
	paths?: string[];
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
			},
		},
		options,
	);
}
