/**
 * Tier 0: BM25 over chunks, plus the link graph.
 *
 * Tier 0 is the tier that must always work — no native modules, no model, no
 * network — so it is `minisearch` and nothing else. Fields are weighted the
 * way memory is actually queried: a retrieval `cue` written at capture time
 * ("when vitest hangs in CI") is worth far more than the same words buried in
 * a body, because it was written to answer *when would I need this*.
 *
 * Two rules make a query "active-only", which is the default everywhere:
 * superseded claims and facts are dropped, and context chunks — entry prose,
 * topic prose — are not matched at all. `history: true` turns both off, which
 * is the only way to see what memory used to say.
 */
import MiniSearch, { type AsPlainObject } from "minisearch";
import { type Chunk, type ChunkKind, EVIDENCE_KINDS } from "./chunk.ts";

/** Searched fields, and the weights the README fixes. */
const SEARCH_FIELDS = ["title", "headingPath", "cue", "body", "tags"];
const BOOST = { title: 3, cue: 2.5, headingPath: 1.5, body: 1, tags: 1 };

/**
 * Fields kept on the hit itself.
 *
 * `body` is stored so a result carries its own snippet: recall runs on every
 * turn, and re-opening a daily file per hit to cut 200 characters out of it
 * would make the index's one job — answering without touching the store —
 * false.
 */
const STORE_FIELDS = [
	"id",
	"kind",
	"path",
	"title",
	"headingPath",
	"cue",
	"body",
	"date",
	"source",
	"phase",
	"entry",
	"superseded",
];

/** Fractional fuzziness: within 0.2 × term length, so short terms stay exact. */
const FUZZY = 0.2;

const DEFAULT_LIMIT = 20;
const SNIPPET_CHARS = 220;

export interface QueryOptions {
	/** Restrict to these chunk kinds. Narrows the default, never widens it. */
	kind?: readonly ChunkKind[];
	phase?: string;
	source?: string;
	/** Include superseded claims and context chunks. Default false. */
	history?: boolean;
	limit?: number;
	/** Claim and fact ids listed in `supersessions.md`. */
	superseded?: ReadonlySet<string>;
}

export interface Hit {
	id: string;
	kind: ChunkKind;
	path: string;
	title: string;
	headingPath: string;
	cue?: string;
	body: string;
	/** A window of the body around the first matched term. */
	snippet: string;
	date?: string;
	source?: string;
	phase?: string;
	entry?: string;
	superseded: boolean;
	score: number;
}

/** The serialised form written to `.index/tier0.json`. */
export interface Tier0Data {
	search: AsPlainObject;
	/** Chunk id → what it points at. Backlinks are derived on load. */
	links: Record<string, string[]>;
}

function options(): ConstructorParameters<typeof MiniSearch>[0] {
	return {
		fields: SEARCH_FIELDS,
		storeFields: STORE_FIELDS,
		searchOptions: { boost: BOOST, prefix: true, fuzzy: FUZZY },
	};
}

export class Tier0Index {
	private readonly mini: MiniSearch;
	private readonly outbound: Map<string, string[]>;
	private readonly inbound: Map<string, Set<string>>;

	private constructor(mini: MiniSearch, outbound: Map<string, string[]>) {
		this.mini = mini;
		this.outbound = outbound;
		this.inbound = new Map();
		for (const [from, targets] of outbound) this.link(from, targets);
	}

	static empty(): Tier0Index {
		return new Tier0Index(new MiniSearch(options()), new Map());
	}

	/** Rehydrate a serialised index. Throws if the data is not `minisearch`'s. */
	static load(data: Tier0Data): Tier0Index {
		const mini = MiniSearch.loadJS(data.search, options());
		return new Tier0Index(mini, new Map(Object.entries(data.links ?? {})));
	}

	toJSON(): Tier0Data {
		return { search: this.mini.toJSON(), links: Object.fromEntries(this.outbound) };
	}

	get size(): number {
		return this.mini.documentCount;
	}

	has(id: string): boolean {
		return this.mini.has(id);
	}

	add(chunks: readonly Chunk[]): void {
		// Re-adding an id minisearch already holds throws, and an incremental
		// append after a partial rebuild can legitimately present one. Discarding
		// first makes `add` mean "this is the current text of this chunk".
		const known = chunks.filter((chunk) => this.mini.has(chunk.id)).map((chunk) => chunk.id);
		if (known.length > 0) this.discard(known);

		this.mini.addAll(chunks as Chunk[]);
		for (const chunk of chunks) {
			if (chunk.links.length === 0) continue;
			this.outbound.set(chunk.id, chunk.links);
			this.link(chunk.id, chunk.links);
		}
	}

	discard(ids: readonly string[]): void {
		const present = ids.filter((id) => this.mini.has(id));
		if (present.length > 0) this.mini.discardAll(present);
		for (const id of ids) {
			for (const target of this.outbound.get(id) ?? []) this.inbound.get(target)?.delete(id);
			this.outbound.delete(id);
		}
	}

	/** What this chunk points at. */
	linksFrom(id: string): string[] {
		return [...(this.outbound.get(id) ?? [])];
	}

	/** Which chunks point at this id — an entry, a claim, a fact or a rule. */
	backlinksTo(id: string): string[] {
		return [...(this.inbound.get(id) ?? [])].sort();
	}

	search(query: string, query_options: QueryOptions = {}): Hit[] {
		const terms = query.trim();
		if (terms === "") return [];

		const history = query_options.history === true;
		const kinds = new Set<string>(query_options.kind ?? (history ? [] : EVIDENCE_KINDS));
		const superseded = query_options.superseded ?? new Set<string>();
		const limit = query_options.limit ?? DEFAULT_LIMIT;

		const results = this.mini.search(terms, {
			filter: (result) => {
				if (kinds.size > 0 && !kinds.has(result.kind as string)) return false;
				if (query_options.phase !== undefined && result.phase !== query_options.phase) return false;
				if (query_options.source !== undefined && result.source !== query_options.source) return false;
				if (!history && (result.superseded === true || superseded.has(result.id as string))) return false;
				return true;
			},
		});

		const hits = results.map((result) => toHit(result, superseded, terms));
		// minisearch orders by score; the tie-break is ours, and it is date
		// descending — between two equally good answers, memory prefers the
		// newer one.
		hits.sort((a, b) => b.score - a.score || (b.date ?? "").localeCompare(a.date ?? "") || a.id.localeCompare(b.id));
		return hits.slice(0, limit);
	}

	private link(from: string, targets: readonly string[]): void {
		for (const target of targets) {
			let set = this.inbound.get(target);
			if (!set) {
				set = new Set();
				this.inbound.set(target, set);
			}
			set.add(from);
		}
	}
}

function toHit(result: Record<string, unknown>, superseded: ReadonlySet<string>, query: string): Hit {
	const body = (result.body as string | undefined) ?? "";
	const id = result.id as string;
	const hit: Hit = {
		id,
		kind: result.kind as ChunkKind,
		path: (result.path as string | undefined) ?? "",
		title: (result.title as string | undefined) ?? "",
		headingPath: (result.headingPath as string | undefined) ?? "",
		body,
		snippet: snippet(body, query),
		superseded: result.superseded === true || superseded.has(id),
		score: result.score as number,
	};
	if (typeof result.cue === "string") hit.cue = result.cue;
	if (typeof result.date === "string") hit.date = result.date;
	if (typeof result.source === "string") hit.source = result.source;
	if (typeof result.phase === "string") hit.phase = result.phase;
	if (typeof result.entry === "string") hit.entry = result.entry;
	return hit;
}

/**
 * A window of the body around the first query term that appears in it.
 *
 * Deliberately dumb: no highlighting, no sentence detection. A snippet is
 * there so a model can decide whether to `memory_read` the whole thing.
 */
export function snippet(body: string, query: string): string {
	const flat = body.replace(/\s+/g, " ").trim();
	if (flat.length <= SNIPPET_CHARS) return flat;

	const lower = flat.toLowerCase();
	let at = -1;
	for (const term of query.toLowerCase().split(/\W+/)) {
		if (term.length < 3) continue;
		const found = lower.indexOf(term);
		if (found >= 0 && (at < 0 || found < at)) at = found;
	}
	if (at < 0) return `${flat.slice(0, SNIPPET_CHARS).trimEnd()}…`;

	const from = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3));
	const slice = flat.slice(from, from + SNIPPET_CHARS).trim();
	return `${from > 0 ? "…" : ""}${slice}${from + SNIPPET_CHARS < flat.length ? "…" : ""}`;
}
