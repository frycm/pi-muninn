/**
 * `supersessions.md` — which claims are no longer current.
 *
 * A superseded fact's evidence is still in the immutable journal, and a search
 * over the journal would happily return it. So a dream appends one line per
 * invalidated *claim*, and ordinary recall drops those claims.
 *
 * The key is a claim id, never a whole entry: one outcome entry routinely
 * supports several independent facts, and superseding one of them must not
 * hide the others.
 *
 * Dreams write it; nothing else does. It is append-only, which is what makes it
 * the one derived file a cross-host merge can resolve by union without asking
 * anybody: two hosts that superseded different claims both end up with both
 * rows, in either order, and the reader only ever asks "is this id in here".
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isClaimId } from "../ids.ts";
import { parseIdLine } from "./trailer.ts";

export interface Supersession {
	/** The claim that is no longer current. */
	claim: string;
	/** ISO date on which it stopped being true. */
	validTo?: string;
	/** The claim that replaced it. */
	by?: string;
	/** The fact whose supersession caused this. */
	fact?: string;
}

export interface Supersessions {
	/** Claim ids that ordinary recall must drop. */
	superseded: Set<string>;
	byClaim: Map<string, Supersession>;
	problems: string[];
}

export function emptySupersessions(): Supersessions {
	return { superseded: new Set(), byClaim: new Map(), problems: [] };
}

export function parseSupersessions(text: string): Supersessions {
	const result = emptySupersessions();

	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		if (!line.startsWith("- ")) continue;

		const { id: claim, fields } = parseIdLine(line.slice(2));
		if (!isClaimId(claim)) {
			result.problems.push(`unreadable supersession line: ${line}`);
			continue;
		}

		const entry: Supersession = { claim };
		const validTo = fields.get("valid_to");
		if (validTo !== undefined) entry.validTo = validTo;
		const by = fields.get("by");
		if (by !== undefined) entry.by = by;
		const fact = fields.get("fact");
		if (fact !== undefined) entry.fact = fact;

		result.superseded.add(claim);
		result.byClaim.set(claim, entry);
	}

	return result;
}

/** Read a store's supersessions. An absent file means nothing is superseded. */
export function readSupersessions(storePath: string): Supersessions {
	try {
		return parseSupersessions(readFileSync(join(storePath, "supersessions.md"), "utf-8"));
	} catch {
		return emptySupersessions();
	}
}

/** One supersession line, as a dream will write it in Phase 2. */
export function formatSupersession(entry: Supersession): string {
	const parts = [entry.claim];
	if (entry.validTo) parts.push(`valid_to: ${entry.validTo}`);
	if (entry.by) parts.push(`by: ${entry.by}`);
	if (entry.fact) parts.push(`fact: ${entry.fact}`);
	return `- ${parts.join(" · ")}`;
}

const HEADER = [
	"<!-- Written by muninn dreams: which journal claims are no longer current. Append-only. -->",
	"",
	"# Superseded claims",
	"",
].join("\n");

/** Where a store keeps its supersessions. */
export function supersessionsPath(storePath: string): string {
	return join(storePath, "supersessions.md");
}

/**
 * Append rows for claims that are not already listed.
 *
 * Deduplicated against what is on disk, because a claim can be cited by two
 * facts and a dream that retires both would otherwise write it twice — and
 * because a re-run after a failure must be able to do the same work again
 * without leaving a trail of duplicates. Returns the rows actually written.
 */
export function appendSupersessions(storePath: string, entries: readonly Supersession[]): Supersession[] {
	const path = supersessionsPath(storePath);
	const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
	const known = parseSupersessions(existing).superseded;

	const fresh: Supersession[] = [];
	for (const entry of entries) {
		if (!isClaimId(entry.claim) || known.has(entry.claim)) continue;
		known.add(entry.claim);
		fresh.push(entry);
	}
	if (fresh.length === 0) return [];

	const base = existing === "" ? HEADER : existing.endsWith("\n") ? existing : `${existing}\n`;
	writeFileSync(path, `${base}${fresh.map(formatSupersession).join("\n")}\n`);
	return fresh;
}
