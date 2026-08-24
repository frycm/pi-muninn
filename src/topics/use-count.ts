/**
 * `use_count` and `last_used`, derived from the journal.
 *
 * Nothing stores these. The outcome entry of every session lists the recalled
 * ids that actually mattered (`used:`), and counting them is a walk over the
 * journal — so recall never dirties git, the count survives deleting `.index/`,
 * and two hosts compute the same number from the same journal.
 *
 * The counted id may be a fact id or a journal claim id: recall injects both,
 * and both are things a session can say it used.
 */
import type { JournalEntry } from "../journal/format.ts";

export interface Usage {
	count: number;
	/** The date of the most recent entry that named this id. */
	lastUsed: string;
}

export interface UsageEntry {
	entry: JournalEntry;
	/** The journal file's date; the entry's own id carries the exact instant. */
	date: string;
}

/**
 * Tally `used:` across a journal.
 *
 * An echoed id still counts. An echo is a claim that restates a memory rather
 * than corroborating it — that distinction matters to *evidence*, which is the
 * gather phase's problem, and not to "was this memory worth injecting", which
 * is what a use count answers.
 */
export function useCounts(entries: readonly UsageEntry[]): Map<string, Usage> {
	const counts = new Map<string, Usage>();
	for (const { entry, date } of entries) {
		for (const id of entry.used ?? []) {
			const current = counts.get(id);
			if (current === undefined) {
				counts.set(id, { count: 1, lastUsed: date });
				continue;
			}
			current.count++;
			if (date > current.lastUsed) current.lastUsed = date;
		}
	}
	return counts;
}

/**
 * Order ids by use, then by recency — the order `MEMORY.md` is written in.
 *
 * Ties break on the id so that two hosts regenerating from the same journal
 * produce byte-identical files; anything less and every sync would carry a
 * spurious `MEMORY.md` diff.
 */
export function byUsage(counts: ReadonlyMap<string, Usage>, fallbackDate: (id: string) => string) {
	return (a: string, b: string): number => {
		const left = counts.get(a);
		const right = counts.get(b);
		const byCount = (right?.count ?? 0) - (left?.count ?? 0);
		if (byCount !== 0) return byCount;
		const leftDate = left?.lastUsed ?? fallbackDate(a);
		const rightDate = right?.lastUsed ?? fallbackDate(b);
		if (leftDate !== rightDate) return leftDate < rightDate ? 1 : -1;
		return a < b ? -1 : a > b ? 1 : 0;
	};
}
