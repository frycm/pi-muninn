/**
 * Finding one journal entry by id.
 *
 * The index is the shortest path to it: every chunk of an entry stores the
 * daily file it came from, so a lookup is one file parse rather than a scan of
 * every daily file in every store. Shared by `memory_read` and by
 * `/muninn promote`, which both start from an id a human or a model copied out
 * of a search result.
 */
import { join } from "node:path";
import type { SessionIndexes } from "../index/search.ts";
import type { CaptureTarget } from "../store/scopes.ts";
import type { JournalEntry } from "./format.ts";
import { readDailyFile } from "./read.ts";

export interface FoundEntry {
	entry: JournalEntry;
	scope: CaptureTarget;
	storePath: string;
	/** Store-relative path of the daily file. */
	path: string;
	date?: string;
}

/**
 * The entry with this id, or a message saying why not.
 *
 * Throws rather than returning undefined: every caller is answering a request
 * that named this id, and "nothing happened" would be a worse answer than the
 * reason.
 */
export function findEntry(indexes: SessionIndexes | undefined, entryId: string): FoundEntry {
	if (!indexes) throw new Error("muninn: the memory index is not open in this session");

	// Any chunk of the entry will do; they all record its file.
	const found = indexes.find(`${entryId}.1`) ?? indexes.find(`${entryId}#prose`);
	if (!found) throw new Error(`muninn: no journal entry with the id ${entryId} is in the index`);

	const path = join(found.scope.storePath, found.chunk.path);
	const file = readDailyFile(path);
	const entry = file.entries.find((candidate) => candidate.id === entryId);
	if (!entry) {
		throw new Error(`muninn: ${entryId} is indexed in ${found.chunk.path} but is not in that file any more`);
	}

	return {
		entry,
		scope: found.scope.scope,
		storePath: found.scope.storePath,
		path: found.chunk.path,
		...(found.chunk.date ? { date: found.chunk.date } : {}),
	};
}
