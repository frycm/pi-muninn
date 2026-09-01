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

export function journalIndexPath(storePath: string): string {
	return join(storePath, ".index", "journal-v1.json");
}

export function tokenizeJournalText(text: string): string[] {
	return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter(Boolean))];
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

	private static fromJSON(data: PersistedIndex): JournalLexicalIndex {
		const index = new JournalLexicalIndex();
		for (const [id, stored] of Object.entries(data.records)) {
			if (typeof stored.hash !== "string" || !Array.isArray(stored.terms))
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

	/** A complete candidate superset for query.ts's exact token/prefix scorer. */
	candidates(query: string): Set<string> {
		const terms = tokenizeJournalText(query);
		if (terms.length === 0) return new Set(this.records.keys());
		const found = new Set<string>();
		for (const queryTerm of terms) {
			for (const [term, ids] of this.postings) {
				if (term !== queryTerm && !(queryTerm.length >= 3 && term.startsWith(queryTerm))) continue;
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
