/**
 * Building labelled journals for tests.
 *
 * Gather's rules are all about *which* claims survive, so its tests need
 * journals whose every entry is there for a reason. Writing those by hand as
 * markdown makes the label invisible; this builder keeps the intent next to the
 * entry, and mints ids whose UUIDv7 timestamps are the ones the test means.
 */

import type { Channel, Phase, Source } from "../../src/journal/format.ts";
import type { JournalEntryWithContext, ReadJournalContextResult } from "../../src/journal/read.ts";

export interface EntrySpec {
	/** Minutes since the builder's epoch — becomes the id's timestamp. */
	at: number;
	source: Source;
	claims: string[];
	prose?: string;
	cue?: string;
	phase?: Phase;
	channel?: Channel;
	task?: string;
	continues?: string;
	recalled?: string[];
	used?: string[];
	echo?: string[];
	host?: string;
	/** Why this entry is in the fixture, for the reader of the test. */
	label?: string;
}

const EPOCH = Date.UTC(2026, 7, 1, 9, 0, 0);
const DEFAULT_HOST = "0198a0b1-0000-7000-8000-000000000001";

/** A UUIDv7 whose timestamp is exactly `at` minutes after the epoch. */
export function entryIdAt(at: number, seq = 0): string {
	const ms = EPOCH + at * 60_000;
	const time = ms.toString(16).padStart(12, "0");
	const counter = seq.toString(16).padStart(3, "0");
	return `j-${time.slice(0, 8)}-${time.slice(8, 12)}-7${counter}-8000-${(at * 1000 + seq).toString(16).padStart(12, "0")}`;
}

export function buildJournal(specs: readonly EntrySpec[]): ReadJournalContextResult {
	const entries: JournalEntryWithContext[] = specs.map((spec, index) => {
		const host = spec.host ?? DEFAULT_HOST;
		const date = new Date(EPOCH + spec.at * 60_000);
		const entry: JournalEntryWithContext = {
			id: entryIdAt(spec.at, index),
			time: `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`,
			source: spec.source,
			prose: spec.prose ?? "",
			claims: spec.claims,
			date: date.toISOString().slice(0, 10),
			host,
			path: `journal/${host}/${date.toISOString().slice(0, 10)}.md`,
		};
		if (spec.cue !== undefined) entry.cue = spec.cue;
		if (spec.phase !== undefined) entry.phase = spec.phase;
		if (spec.channel !== undefined) entry.channel = spec.channel;
		if (spec.task !== undefined) entry.task = spec.task;
		if (spec.continues !== undefined) entry.continues = spec.continues;
		if (spec.recalled !== undefined) entry.recalled = spec.recalled;
		if (spec.used !== undefined) entry.used = spec.used;
		if (spec.echo !== undefined) entry.echo = spec.echo;
		return entry;
	});
	return { entries, problems: [] };
}

/** Minutes since the epoch, as a Date — for a test's "now". */
export function minutes(at: number): Date {
	return new Date(EPOCH + at * 60_000);
}
