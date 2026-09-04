/** Disposable lexical candidate index. Canonical filtering and ranking live in query.ts. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isEntryId } from "../ids.ts";
import type { JournalRecord } from "./record.ts";
import { serializeJournalRecord } from "./record.ts";

const INDEX_SCHEMA = 2 as const;
const INDEX_ANALYZER = "unicode-nfkc-lower-v1" as const;
const MAX_OPTIMIZED_TOKEN_POINTS = 64;
const MAX_INDEX_BYTES = 256 * 1024 * 1024;
const MAX_INDEX_TERMS_PER_RECORD = 32_768;

interface PersistedIndex {
	schema: typeof INDEX_SCHEMA;
	analyzer: typeof INDEX_ANALYZER;
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
	return join(storePath, ".index", "journal-v2.json");
}

function legacyJournalIndexPath(storePath: string): string {
	return join(storePath, ".index", "journal-v1.json");
}

function readPersistedIndex(path: string): PersistedIndex {
	if (statSync(path).size > MAX_INDEX_BYTES) throw new Error(`index exceeds ${MAX_INDEX_BYTES} bytes`);
	return JSON.parse(readFileSync(path, "utf-8")) as PersistedIndex;
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
	if (!existsSync(path)) {
		if (existsSync(legacyJournalIndexPath(storePath)))
			return {
				present: true,
				readable: false,
				exact: false,
				problem: "legacy index schema requires a rebuild",
			};
		return { present: false, readable: false, exact: false, problem: "index is missing" };
	}
	try {
		const raw = readPersistedIndex(path);
		if (
			raw.schema !== INDEX_SCHEMA ||
			raw.analyzer !== INDEX_ANALYZER ||
			typeof raw.records !== "object" ||
			raw.records === null
		) {
			throw new Error("unsupported index schema");
		}
		JournalLexicalIndex.fromJSON(raw);
		const expected = new Map(
			records.map((record) => [record.id, { hash: recordHash(record), terms: recordTerms(record) }]),
		);
		const actual = Object.entries(raw.records);
		const exact =
			actual.length === expected.size &&
			actual.every(([id, indexed]) => {
				const canonical = expected.get(id);
				return canonical?.hash === indexed.hash && sameTerms(canonical.terms, indexed.terms);
			});
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
	return [record.body, record.cue ?? "", ...record.tags, ...record.paths].join("\n");
}

function recordTerms(record: JournalRecord): string[] {
	return [...new Set([normalizeJournalText(record.id), ...tokenizeJournalText(searchable(record))])].sort();
}

function recordHash(record: JournalRecord): string {
	return createHash("sha256").update(serializeJournalRecord(record)).digest("hex");
}

function sameTerms(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((term, index) => term === right[index]);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function ngrams(points: readonly string[], size: number): string[] {
	const grams = new Set<string>();
	for (let at = 0; at <= points.length - size; at++) grams.add(points.slice(at, at + size).join(""));
	return [...grams];
}

function addPosting(postings: Map<string, Set<string>>, term: string, id: string): void {
	let ids = postings.get(term);
	if (!ids) {
		ids = new Set();
		postings.set(term, ids);
	}
	ids.add(id);
}

function removePosting(postings: Map<string, Set<string>>, term: string, id: string): boolean {
	const ids = postings.get(term);
	ids?.delete(id);
	if (ids?.size === 0) {
		postings.delete(term);
		return true;
	}
	return false;
}

function addCandidates(found: Set<string>, candidates: ReadonlySet<string> | undefined): void {
	if (candidates) for (const id of candidates) found.add(id);
}

function addTermCandidates(
	found: Set<string>,
	terms: ReadonlySet<string> | undefined,
	exactPostings: ReadonlyMap<string, ReadonlySet<string>>,
): void {
	if (!terms) return;
	for (const term of terms) addCandidates(found, exactPostings.get(term));
}

export class JournalLexicalIndex {
	private readonly records = new Map<string, { hash: string; terms: string[] }>();
	private readonly exactPostings = new Map<string, Set<string>>();
	private readonly trigramTerms = new Map<string, Set<string>>();
	private readonly bigramTerms = new Map<string, Set<string>>();
	private readonly fallbackRecords = new Set<string>();
	private dirty = false;

	static open(storePath: string, records: readonly JournalRecord[], force = false): OpenJournalIndexResult {
		const warnings: string[] = [];
		let index: JournalLexicalIndex | undefined;
		if (!force) {
			try {
				if (existsSync(journalIndexPath(storePath))) {
					const raw = readPersistedIndex(journalIndexPath(storePath));
					if (
						raw.schema !== INDEX_SCHEMA ||
						raw.analyzer !== INDEX_ANALYZER ||
						typeof raw.records !== "object" ||
						raw.records === null
					) {
						throw new Error("unsupported index schema");
					}
					index = JournalLexicalIndex.fromJSON(raw);
				} else if (existsSync(legacyJournalIndexPath(storePath))) {
					throw new Error("legacy index schema");
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
			const prior = index.records.get(record.id);
			const terms = recordTerms(record);
			if (prior?.hash === recordHash(record) && sameTerms(prior.terms, terms)) continue;
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
				!isEntryId(id) ||
				typeof stored !== "object" ||
				stored === null ||
				typeof stored.hash !== "string" ||
				!/^[0-9a-f]{64}$/.test(stored.hash) ||
				!Array.isArray(stored.terms) ||
				stored.terms.length > MAX_INDEX_TERMS_PER_RECORD ||
				stored.terms.some(
					(term, at) =>
						typeof term !== "string" ||
						term.length < 1 ||
						term.length > 65_536 ||
						normalizeJournalText(term) !== term ||
						(at > 0 && (stored.terms[at - 1] as string) >= term),
				)
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
		const terms = recordTerms(record);
		this.records.set(record.id, { hash: recordHash(record), terms });
		this.addPostings(record.id, terms);
		this.dirty = true;
	}

	remove(id: string): void {
		const prior = this.records.get(id);
		if (!prior) return;
		this.removePostings(id, prior.terms);
		this.records.delete(id);
		this.dirty = true;
	}

	/** A complete candidate superset for query.ts's phrase/token scorer. */
	candidates(query: string): Set<string> {
		const terms = tokenizeJournalText(query);
		if (terms.length === 0) return new Set(this.records.keys());
		const found = new Set(this.fallbackRecords);
		for (const queryTerm of terms) {
			const points = [...queryTerm];
			// Short or exceptionally long infix terms are uncommon and deliberately
			// fall back to the canonical scorer instead of growing an unbounded index.
			if (points.length < 3 || points.length > MAX_OPTIMIZED_TOKEN_POINTS) return new Set(this.records.keys());
			addCandidates(found, this.exactPostings.get(queryTerm));
			addTermCandidates(found, this.trigramTerms.get(points.slice(0, 3).join("")), this.exactPostings);
			if (points.length < 5) continue;
			// Any insertion, deletion, or substitution in a token of at least five
			// code points leaves at least one adjacent code-point pair unchanged.
			for (const bigram of ngrams(points, 2))
				addTermCandidates(found, this.bigramTerms.get(bigram), this.exactPostings);
		}
		return found;
	}

	save(storePath: string): void {
		if (!this.dirty && existsSync(journalIndexPath(storePath))) return;
		const path = journalIndexPath(storePath);
		mkdirSync(join(storePath, ".index"), { recursive: true, mode: 0o700 });
		const temporary = `${path}.${process.pid}.tmp`;
		const records = Object.fromEntries([...this.records.entries()].sort(([left], [right]) => compareText(left, right)));
		try {
			writeFileSync(
				temporary,
				`${JSON.stringify({ schema: INDEX_SCHEMA, analyzer: INDEX_ANALYZER, records }, null, "\t")}\n`,
				{ mode: 0o600 },
			);
			renameSync(temporary, path);
			rmSync(legacyJournalIndexPath(storePath), { force: true });
			this.dirty = false;
		} finally {
			rmSync(temporary, { force: true });
		}
	}

	private addPostings(id: string, terms: readonly string[]): void {
		for (const term of terms) {
			const first = !this.exactPostings.has(term);
			addPosting(this.exactPostings, term, id);
			if (term === normalizeJournalText(id)) continue;
			const points = [...term];
			if (points.length > MAX_OPTIMIZED_TOKEN_POINTS) {
				this.fallbackRecords.add(id);
				continue;
			}
			if (!first) continue;
			if (points.length >= 2) for (const gram of ngrams(points, 2)) addPosting(this.bigramTerms, gram, term);
			if (points.length >= 3) for (const gram of ngrams(points, 3)) addPosting(this.trigramTerms, gram, term);
		}
	}

	private removePostings(id: string, terms: readonly string[]): void {
		this.fallbackRecords.delete(id);
		for (const term of terms) {
			const last = removePosting(this.exactPostings, term, id);
			if (!last || term === normalizeJournalText(id)) continue;
			const points = [...term];
			if (points.length > MAX_OPTIMIZED_TOKEN_POINTS) continue;
			if (points.length >= 2) for (const gram of ngrams(points, 2)) removePosting(this.bigramTerms, gram, term);
			if (points.length >= 3) for (const gram of ngrams(points, 3)) removePosting(this.trigramTerms, gram, term);
		}
	}
}
