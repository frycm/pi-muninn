/**
 * `journal/erasures.md` — ids removed for privacy.
 *
 * The journal is append-only and immutable, with exactly one exception:
 * erasure, which replaces an entry's body with a tombstone. This file is the
 * list of those ids, and it exists for two reasons that outlive the erasure
 * itself — so a host that still has the entry in its clone drops it at the next
 * sync instead of resurrecting it, and so a dream can *prove* it did not cite
 * it.
 *
 * The writer is `dream/erase.ts`. The reader is here, and is used from the
 * moment gather exists, because "may a dream cite this?" has to be answerable
 * before anything erases anything.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isEntryId } from "../ids.ts";
import { parseIdLine } from "./trailer.ts";

export interface Erasure {
	entry: string;
	erased?: string;
	reason?: string;
}

export interface Erasures {
	ids: Set<string>;
	byEntry: Map<string, Erasure>;
	problems: string[];
}

const HEADER = [
	"<!-- Entries erased for privacy. The one mutation of the journal, always by a human. -->",
	"",
	"# Erasures",
	"",
].join("\n");

export function erasuresPath(storePath: string): string {
	return join(storePath, "journal", "erasures.md");
}

export function emptyErasures(): Erasures {
	return { ids: new Set(), byEntry: new Map(), problems: [] };
}

export function parseErasures(text: string): Erasures {
	const result = emptyErasures();
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line.startsWith("- ")) continue;
		const { id, fields } = parseIdLine(line.slice(2));
		if (!isEntryId(id)) {
			result.problems.push(`unreadable erasure line: ${line}`);
			continue;
		}
		const erasure: Erasure = { entry: id };
		const erased = fields.get("erased");
		if (erased !== undefined) erasure.erased = erased;
		const reason = fields.get("reason");
		if (reason !== undefined) erasure.reason = reason;
		result.ids.add(id);
		result.byEntry.set(id, erasure);
	}
	return result;
}

export function readErasures(storePath: string): Erasures {
	try {
		return parseErasures(readFileSync(erasuresPath(storePath), "utf-8"));
	} catch {
		return emptyErasures();
	}
}

export function formatErasure(erasure: Erasure): string {
	const parts = [erasure.entry];
	if (erasure.erased) parts.push(`erased: ${erasure.erased}`);
	if (erasure.reason) parts.push(`reason: ${erasure.reason}`);
	return `- ${parts.join(" · ")}`;
}

/** Record an erasure, once. Returns false when the id was already listed. */
export function appendErasure(storePath: string, erasure: Erasure): boolean {
	const path = erasuresPath(storePath);
	const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
	if (parseErasures(existing).ids.has(erasure.entry)) return false;
	const base = existing === "" ? HEADER : existing.endsWith("\n") ? existing : `${existing}\n`;
	writeFileSync(path, `${base}${formatErasure(erasure)}\n`);
	return true;
}
