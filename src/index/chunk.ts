/**
 * Turn journal entries into the small units scored by the Tier 0 index.
 *
 * Claims are independent hits because they are concise and addressable. Entry
 * prose is a hit as well: it carries the situation around those claims, which
 * is often the useful part of project history. Either hit leads back to the
 * complete entry through its `entry` field.
 */
import { claimsOf } from "../journal/format.ts";
import type { JournalEntryWithContext } from "../journal/read.ts";

export const CHUNK_KINDS = ["claim", "prose"] as const;
export type ChunkKind = (typeof CHUNK_KINDS)[number];

export interface Chunk {
	id: string;
	kind: ChunkKind;
	/** Store-relative path of the journal shard this came from. */
	path: string;
	title: string;
	headingPath: string;
	cue?: string;
	body: string;
	tags: string;
	date?: string;
	source?: string;
	phase?: string;
	/** The journal entry this chunk belongs to. */
	entry: string;
	/** Journal ids and wikilinks mentioned by this text. */
	links: string[];
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ENTRY_OR_CLAIM = new RegExp(`\\bj-${UUID}(?:\\.\\d+)?`, "g");
const WIKILINK = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

export function extractLinks(text: string): string[] {
	const found = new Set<string>();
	for (const pattern of [WIKILINK, ENTRY_OR_CLAIM]) {
		pattern.lastIndex = 0;
		for (const match of text.matchAll(pattern)) {
			const target = (match[1] ?? match[0]).trim();
			if (target !== "") found.add(target);
		}
	}
	return [...found];
}

export function chunkJournalEntry(entry: JournalEntryWithContext, path: string): Chunk[] {
	const headingPath = ["journal", entry.date, entry.time].join(" › ");
	const tags = [entry.source, entry.phase, entry.channel].filter(Boolean).join(" ");
	const chunks: Chunk[] = [];

	for (const claim of claimsOf(entry)) {
		chunks.push({
			id: claim.id,
			kind: "claim",
			path,
			title: "",
			headingPath,
			...(entry.cue ? { cue: entry.cue } : {}),
			body: claim.text,
			tags: `claim ${tags}`,
			date: entry.date,
			source: entry.source,
			...(entry.phase ? { phase: entry.phase } : {}),
			entry: entry.id,
			links: extractLinks(claim.text).filter((link) => link !== claim.id),
		});
	}

	if (entry.claims.length > 0 && entry.prose !== "") {
		chunks.push({
			id: `${entry.id}#prose`,
			kind: "prose",
			path,
			title: "",
			headingPath,
			...(entry.cue ? { cue: entry.cue } : {}),
			body: entry.prose,
			tags: `prose ${tags}`,
			date: entry.date,
			source: entry.source,
			...(entry.phase ? { phase: entry.phase } : {}),
			entry: entry.id,
			links: extractLinks(entry.prose),
		});
	}

	return chunks;
}
