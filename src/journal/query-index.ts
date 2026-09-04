/** Disposable lexical candidate index. Canonical filtering and ranking live in query.ts. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JournalRecord } from "./record.ts";
import { serializeJournalRecord } from "./record.ts";

const INDEX_SCHEMA = 1 as const;

interface PersistedIndex {
	schema: typeof INDEX_SCHEMA;
	records: Record<string, { hash: string; terms: string[] }>;
}

export interface OpenJournalIndexResult {
	index: JournalLexicalIndex;
	kind: "loaded" | "rebuilt" | "incremental";
	warnings: string[];
}

export interface JournalIndexInspection {
	present: boolean;
	readable: boolean;
	exact: boolean;
	problem?: string;
}

export function journalIndexPath(storePath: string): string {
	return join(storePath, ".index", "journal-v1.json");
}

export function normalizeJournalText(text: string): string {
	return text.normalize("NFKC").toLowerCase();
}

export function tokenizeJournalText(text: string): string[] {
	return [...new Set((normalizeJournalText(text).match(/[\p{L}\p{N}_-]+/gu) ?? []).filter(Boolean))];
}

export type JournalTokenMatchKind = "exact" | "prefix" | "fuzzy";

/** Strongest deterministic match allowed by the canonical lexical scorer. */
export function journalTokenMatch(queryTerm: string, recordTerm: string): JournalTokenMatchKind | undefined {
	if (recordTerm === queryTerm) return "exact";
	const queryLength = [...queryTerm].length;
	if (queryLength >= 3 && recordTerm.startsWith(queryTerm)) return "prefix";
	if (queryLength >= 5 && oneEditApart(queryTerm, recordTerm)) return "fuzzy";
	return undefined;
}

/** Unicode-code-point Levenshtein distance of exactly one, without transposition. */
export function oneEditApart(left: string, right: string): boolean {
	const leftPoints = [...left];
	const rightPoints = [...right];
	if (Math.abs(leftPoints.length - rightPoints.length) > 1 || left === right) return false;
	if (leftPoints.length === rightPoints.length) {
		let differences = 0;
		for (let at = 0; at < leftPoints.length; at++) {
			if (leftPoints[at] !== rightPoints[at] && ++differences > 1) return false;
		}
		return differences === 1;
	}
	const [shorter, longer] =
		leftPoints.length < rightPoints.length ? [leftPoints, rightPoints] : [rightPoints, leftPoints];
	let shortAt = 0;
	let longAt = 0;
	let skipped = false;
	while (shortAt < shorter.length && longAt < longer.length) {
		if (shorter[shortAt] === longer[longAt]) {
			shortAt++;
			longAt++;
			continue;
		}
		if (skipped) return false;
		skipped = true;
		longAt++;
	}
	return true;
}

/** Inspect the disposable index without repairing, creating, or rewriting it. */
export function inspectJournalIndex(storePath: string, records: readonly JournalRecord[]): JournalIndexInspection {
	const path = journalIndexPath(storePath);
	if (!existsSync(path)) return { present: false, readable: false, exact: false, problem: "index is missing" };
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as PersistedIndex;
		if (raw.schema !== INDEX_SCHEMA || typeof raw.records !== "object" || raw.records === null) {
			throw new Error("unsupported index schema");
		}
		JournalLexicalIndex.fromJSON(raw);
		const expected = new Map(records.map((record) => [record.id, recordHash(record)]));
		const actual = Object.entries(raw.records);
		const exact = actual.length === expected.size && actual.every(([id, indexed]) => expected.get(id) === indexed.hash);
		return {
			present: true,
			readable: true,
			exact,
			...(exact ? {} : { problem: "index records or hashes differ from the canonical journal" }),
		};
	} catch (error) {
		return {
			present: true,
			readable: false,
			exact: false,
			problem: error instanceof Error ? error.message : String(error),
		};
	}
}

function searchable(record: JournalRecord): string {
	return [record.id, record.body, record.cue ?? "", ...record.tags, ...record.paths].join("\n");
}

function recordHash(record: JournalRecord): string {
	return createHash("sha256").update(serializeJournalRecord(record)).digest("hex");
}

export class JournalLexicalIndex {
	private readonly records = new Map<string, { hash: string; terms: string[] }>();
	private readonly postings = new Map<string, Set<string>>();
	private dirty = false;

	static open(storePath: string, records: readonly JournalRecord[], force = false): OpenJournalIndexResult {
		const warnings: string[] = [];
		let index: JournalLexicalIndex | undefined;
		if (!force) {
			try {
				if (existsSync(journalIndexPath(storePath))) {
					const raw = JSON.parse(readFileSync(journalIndexPath(storePath), "utf-8")) as PersistedIndex;
					if (raw.schema !== INDEX_SCHEMA || typeof raw.records !== "object" || raw.records === null) {
						throw new Error("unsupported index schema");
					}
					index = JournalLexicalIndex.fromJSON(raw);
				}
			} catch (error) {
				warnings.push(`index rebuilt: ${error instanceof Error ? error.message : String(error)}`);
				index = undefined;
			}
		}

		if (!index) {
			index = new JournalLexicalIndex();
			for (const record of records) index.add(record);
			index.save(storePath);
			return { index, kind: "rebuilt", warnings };
		}

		const expected = new Map(records.map((record) => [record.id, record]));
		let changed = false;
		for (const id of [...index.records.keys()]) {
			if (expected.has(id)) continue;
			index.remove(id);
			changed = true;
		}
		for (const record of records) {
			if (index.records.get(record.id)?.hash === recordHash(record)) continue;
			index.add(record);
			changed = true;
		}
		if (changed) index.save(storePath);
		return { index, kind: changed ? "incremental" : "loaded", warnings };
	}

	static fromJSON(data: PersistedIndex): JournalLexicalIndex {
		const index = new JournalLexicalIndex();
		for (const [id, stored] of Object.entries(data.records)) {
			if (
				typeof stored !== "object" ||
				stored === null ||
				typeof stored.hash !== "string" ||
				!Array.isArray(stored.terms) ||
				stored.terms.some((term) => typeof term !== "string")
			)
				throw new Error(`invalid index record ${id}`);
			index.records.set(id, { hash: stored.hash, terms: stored.terms });
			index.addPostings(id, stored.terms);
		}
		return index;
	}

	get size(): number {
		return this.records.size;
	}

	add(record: JournalRecord): void {
		this.remove(record.id);
		const terms = tokenizeJournalText(searchable(record));
		this.records.set(record.id, { hash: recordHash(record), terms });
		this.addPostings(record.id, terms);
		this.dirty = true;
	}

	remove(id: string): void {
		const prior = this.records.get(id);
		if (!prior) return;
		for (const term of prior.terms) {
			const ids = this.postings.get(term);
			ids?.delete(id);
			if (ids?.size === 0) this.postings.delete(term);
		}
		this.records.delete(id);
		this.dirty = true;
	}

	/** A complete candidate superset for query.ts's phrase/token scorer. */
	candidates(query: string): Set<string> {
		const terms = tokenizeJournalText(query);
		if (terms.length === 0) return new Set(this.records.keys());
		const found = new Set<string>();
		for (const queryTerm of terms) {
			for (const [term, ids] of this.postings) {
				// Infix covers phrase substrings that begin inside a token; fuzzy covers the
				// remaining canonical token matches. Ranking still evaluates full records.
				if (!term.includes(queryTerm) && journalTokenMatch(queryTerm, term) !== "fuzzy") continue;
				for (const id of ids) found.add(id);
			}
		}
		return found;
	}

	save(storePath: string): void {
		if (!this.dirty && existsSync(journalIndexPath(storePath))) return;
		const path = journalIndexPath(storePath);
		mkdirSync(join(storePath, ".index"), { recursive: true, mode: 0o700 });
		const temporary = `${path}.${process.pid}.tmp`;
		const records = Object.fromEntries(
			[...this.records.entries()].sort(([left], [right]) => left.localeCompare(right)),
		);
		try {
			writeFileSync(temporary, `${JSON.stringify({ schema: INDEX_SCHEMA, records }, null, "\t")}\n`, { mode: 0o600 });
			renameSync(temporary, path);
			this.dirty = false;
		} finally {
			rmSync(temporary, { force: true });
		}
	}

	private addPostings(id: string, terms: readonly string[]): void {
		for (const term of terms) {
			let ids = this.postings.get(term);
			if (!ids) {
				ids = new Set();
				this.postings.set(term, ids);
			}
			ids.add(id);
		}
	}
}
