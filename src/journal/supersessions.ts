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
 * Nothing writes this file in Phase 1 — dreams do, in Phase 2. It is read from
 * the start because recall must be active-only from the first query, and
 * because a store synced from a machine running a later Muninn may already
 * have one.
 */
import { readFileSync } from "node:fs";
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
