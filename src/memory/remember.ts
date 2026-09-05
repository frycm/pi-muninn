/** Incremental, recoverable session extraction. No model calls while holding the journal lock. */
import type { AppendJournalOptions, AppendJournalResult } from "../journal/jsonl.ts";
import type { JournalRecord, NewJournalRecord } from "../journal/record.ts";
import { parseJournalRecord } from "../journal/record.ts";
import { appendPreparedAutomaticRecord, prepareAutomaticRecord } from "../journal/writer.ts";
import { redact } from "../redact.ts";
import { estimateTokens } from "../tokens.ts";
import { type BranchEntry, branchEvidence, digest, evidenceChunks } from "./evidence.ts";
import { EXTRACTION_PROMPT, extractMemories } from "./extract.ts";
import { type MemoryCaller, object, string, strings } from "./runtime.ts";

export const MEMORY_STATE_TYPE = "muninn-memory-v1";
interface CaptureOperation {
	key: string;
	project: string;
	task: string;
	sources: string[];
	focus: string;
	records: JournalRecord[];
	done: boolean;
}
export interface RememberResult {
	ids: string[];
	reused: string[];
	processed: number;
	partial: boolean;
	problem?: string;
}

export interface RememberOptions {
	entries: readonly BranchEntry[];
	cwd: string;
	sessionFile: string;
	focus?: string;
	automatic?: boolean;
	checkpoint?: boolean;
	caller: MemoryCaller;
	write: AppendJournalOptions;
	base: Pick<NewJournalRecord, "continues" | "git" | "channel"> & { task: string };
	persist(data: unknown): void;
	appended(result: AppendJournalResult): void;
}

function operations(entries: readonly BranchEntry[]): Map<string, CaptureOperation> {
	const found = new Map<string, CaptureOperation>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MEMORY_STATE_TYPE) continue;
		try {
			const raw = object(entry.data, ["key", "project", "task", "sources", "focus", "records", "done"]);
			if (
				typeof raw.focus !== "string" ||
				raw.focus.length > 2000 ||
				typeof raw.done !== "boolean" ||
				!Array.isArray(raw.records) ||
				raw.records.length > 5
			)
				throw new Error("invalid capture delta");
			const op = {
				key: string(raw.key, 64),
				project: string(raw.project, 256),
				task: string(raw.task, 256),
				sources: strings(raw.sources, 10_000, 256),
				focus: raw.focus,
				records: raw.records.map((r) => parseJournalRecord(r).record),
				done: raw.done,
			};
			found.set(op.key, op);
		} catch {
			throw new Error("muninn: invalid saved memory operation; session evidence was preserved");
		}
	}
	return found;
}

export async function rememberSession(options: RememberOptions): Promise<RememberResult> {
	const focus = redact(options.focus?.trim() ?? "").text;
	if (focus.length > 2000) throw new Error("muninn: memory focus exceeds 2000 characters");
	const ops = operations(options.entries);
	const source = branchEvidence(options.entries, options.cwd);
	const sourceIds = new Set(source.map((entry) => entry.id));
	const relevant = [...ops.values()].filter(
		(op) =>
			op.project === options.write.project &&
			op.task === options.base.task &&
			op.focus === focus &&
			op.sources.every((id) => sourceIds.has(id)) &&
			op.records.every((r) => r.project === options.write.project && r.task === options.base.task),
	);
	const result: RememberResult = { ids: [], reused: [], processed: 0, partial: false };
	const persist = (op: CaptureOperation) => {
		options.persist(op);
		ops.set(op.key, op);
	};
	const finish = async (op: CaptureOperation) => {
		for (const record of op.records) {
			if (options.caller.signal.aborted) throw new Error("muninn: memory operation cancelled or timed out");
			if (record.task !== options.base.task || !record.session?.file)
				throw new Error("muninn: prepared memory belongs to a different session");
			const written = await appendPreparedAutomaticRecord(record, options.write, options.caller.signal);
			options.appended(written);
			result.ids.push(record.id);
		}
		op.done = true;
		persist(op);
	};
	try {
		for (const op of relevant) {
			if (!op.done) await finish(op);
			else result.reused.push(...op.records.map((r) => r.id));
		}
		const covered = new Set(relevant.filter((op) => op.done).flatMap((op) => op.sources));
		const fresh = source.filter((entry) => !covered.has(entry.id));
		// A journal-only turn contributes no tool evidence. Explicit retrospectives can also cover durable discussion.
		if (
			options.automatic &&
			!fresh.some((e) => e.tools.length || e.role === "toolResult" || e.role === "bashExecution")
		)
			return result;
		const fixedTokens = estimateTokens(EXTRACTION_PROMPT) + estimateTokens(focus) + 512;
		const availableChars = Math.max(0, (options.caller.maxInputTokens - fixedTokens) * 3);
		if (availableChars < 1500) throw new Error("muninn: memory budget too small for extraction instructions");
		const chunks = evidenceChunks(fresh, Math.floor(availableChars * 0.7));
		for (let i = 0; i < chunks.length; i++) {
			if (options.caller.signal.aborted) throw new Error("muninn: memory operation cancelled or timed out");
			const evidence = chunks[i] as (typeof chunks)[number];
			const prior: Array<{ id: string; body: string }> = [];
			for (const record of [...ops.values()].flatMap((op) => op.records).reverse()) {
				if (record.project !== options.write.project || record.task !== options.base.task) continue;
				const candidate = { id: record.id, body: record.body };
				if (JSON.stringify([...prior, candidate]).length > availableChars * 0.25) continue;
				prior.push(candidate);
				if (prior.length === 5) break;
			}
			const memories = await extractMemories(options.caller, { focus, evidence, prior });
			const unique = memories.filter((m) => !prior.some((p) => p.body === m.body));
			const prepared = unique.map((memory) =>
				prepareAutomaticRecord(
					{
						...memory,
						...options.base,
						type: options.checkpoint || i < chunks.length - 1 ? "checkpoint" : "outcome",
						session: {
							file: options.sessionFile,
							first: evidence[0]?.id as string,
							last: evidence.at(-1)?.id as string,
						},
					},
					options.write,
				),
			);
			const op: CaptureOperation = {
				key: digest({ v: 1, project: options.write.project, task: options.base.task, focus, evidence }),
				project: options.write.project,
				task: options.base.task,
				sources: evidence.map((e) => e.id),
				focus,
				records: prepared,
				done: false,
			};
			persist(op);
			await finish(op);
			result.processed += evidence.length;
		}
	} catch (error) {
		result.partial = true;
		result.problem = error instanceof Error ? error.message : "muninn: memory extraction failed";
	}
	return result;
}
