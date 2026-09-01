/**
 * The one query API over every active journal scope.
 *
 * Everything that retrieves goes through here — the model tool and `/muninn
 * search` — so both interfaces return the same records.
 *
 * Scores from two stores come from two independent BM25 corpora, so they are
 * comparable only roughly. That is accepted rather than papered over: the
 * alternative is one corpus across scopes, which would make a project store's
 * term statistics depend on what is in the global one and make results change
 * when an unrelated project is indexed.
 */
import type { JournalEntryWithContext } from "../journal/read.ts";
import type { ActiveScope, CaptureTarget } from "../store/scopes.ts";
import { type RefreshResult, StoreIndex } from "./build.ts";
import type { ChunkKind } from "./chunk.ts";
import { byScoreThenDate, type Hit, type StoredChunk } from "./tier0.ts";

export interface SearchRequest {
	query: string;
	/** One scope, or every active one (the default). */
	scope?: CaptureTarget;
	phase?: string;
	kind?: readonly ChunkKind[];
	limit?: number;
}

export interface SearchHit extends Hit {
	scope: CaptureTarget;
	/** The store the hit came from, for `memory_read` and for display. */
	storePath: string;
}

const DEFAULT_LIMIT = 20;

/** One scope's journal index. */
export interface ScopeIndex {
	scope: CaptureTarget;
	storePath: string;
	index: StoreIndex;
}

/**
 * Query several scopes and merge.
 *
 * Each store is queried independently, then the bounded results are merged.
 */
export function search(indexes: readonly ScopeIndex[], request: SearchRequest): SearchHit[] {
	const limit = request.limit ?? DEFAULT_LIMIT;
	const hits: SearchHit[] = [];

	for (const scoped of indexes) {
		if (request.scope !== undefined && scoped.scope !== request.scope) continue;
		const options: Parameters<StoreIndex["search"]>[1] = {
			// Ask each store for the full limit: one scope may legitimately own
			// every good answer, and trimming per scope first would hide that.
			limit,
		};
		if (request.kind !== undefined) options.kind = request.kind;
		if (request.phase !== undefined) options.phase = request.phase;

		for (const hit of scoped.index.search(request.query, options)) {
			hits.push({ ...hit, scope: scoped.scope, storePath: scoped.storePath });
		}
	}

	hits.sort(byScoreThenDate);
	return hits.slice(0, limit);
}

// ---------------------------------------------------------------------------
// The session's indexes
// ---------------------------------------------------------------------------

export interface OpenScopesResult {
	indexes: SessionIndexes;
	/** One line per scope opened, and every problem found doing it. */
	notes: string[];
	problems: string[];
}

/**
 * The indexes a session holds open, one per active scope.
 *
 * Opened once at `session_start` and kept: rebuilding costs seconds on a large
 * store, while tool and command queries should remain cheap.
 */
export class SessionIndexes {
	private readonly scoped: ScopeIndex[] = [];

	/** Open (and rebuild what is stale in) the index of every active scope. */
	static open(scopes: readonly ActiveScope[], options: { force?: boolean } = {}): OpenScopesResult {
		const indexes = new SessionIndexes();
		const notes: string[] = [];
		const problems: string[] = [];

		for (const scope of scopes) {
			if (!scope.exists) continue;
			try {
				const opened = StoreIndex.open(scope.path, options);
				indexes.scoped.push({ scope: scope.scope, storePath: scope.path, index: opened.index });
				notes.push(describe(scope.scope, opened.index.size, opened.result));
				problems.push(...opened.result.problems.map((problem) => `${scope.scope} index: ${problem}`));
			} catch (error) {
				// An index that cannot be built means search is blind for that
				// scope. Capture still works, so the session continues — loudly.
				problems.push(
					`${scope.scope} index at ${scope.path}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		return { indexes, notes, problems };
	}

	get scopes(): readonly ScopeIndex[] {
		return this.scoped;
	}

	get size(): number {
		return this.scoped.reduce((total, scoped) => total + scoped.index.size, 0);
	}

	search(request: SearchRequest): SearchHit[] {
		return search(this.scoped, request);
	}

	/**
	 * Find one chunk by id, in whichever scope holds it.
	 *
	 * Ids are unique across stores by construction — a UUIDv7 minted by the host
	 * that wrote it — so the first scope that has it is the one that has it.
	 */
	find(id: string): { scope: ScopeIndex; chunk: StoredChunk } | undefined {
		for (const scoped of this.scoped) {
			const chunk = scoped.index.get(id);
			if (chunk) return { scope: scoped, chunk };
		}
		return undefined;
	}

	/**
	 * Re-read one store after something outside this session changed it.
	 *
	 * Sync rebases other hosts' journal files into the store while the session
	 * holds its index open; without this the memory that just arrived is
	 * invisible until the next session or a `/muninn reindex`. Cheap when
	 * nothing changed — the manifest's content hashes answer that.
	 */
	refresh(storePath: string): void {
		this.scoped.find((scoped) => scoped.storePath === storePath)?.index.refresh();
	}

	/** Index an entry the moment it is appended, so this turn's write is findable in the next. */
	addEntry(storePath: string, entry: JournalEntryWithContext): void {
		this.scoped.find((scoped) => scoped.storePath === storePath)?.index.addEntry(entry);
	}

	/** Persist every index that has pending changes. Never throws. */
	save(): string[] {
		const problems: string[] = [];
		for (const scoped of this.scoped) {
			try {
				scoped.index.save();
			} catch (error) {
				problems.push(`${scoped.scope} index: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return problems;
	}
}

function describe(scope: string, size: number, result: RefreshResult): string {
	const what =
		result.kind === "full"
			? `built ${size} chunks`
			: result.kind === "incremental"
				? `updated ${result.changed.length} file(s), ${size} chunks`
				: `${size} chunks`;
	return `${scope}: ${what} in ${result.ms} ms`;
}
