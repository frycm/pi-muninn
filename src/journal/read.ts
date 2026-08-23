/**
 * Reading the journal back.
 *
 * Never throws on a damaged file. A crash mid-append leaves at most one
 * truncated entry at end of file; that entry is reported and excluded, and
 * everything before it is still readable. Losing a whole day's journal because
 * the last entry is half-written would be a far worse failure than losing the
 * half-written entry.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isHostId } from "../ids.ts";
import { type JournalEntry, parseEntry } from "./format.ts";

export interface JournalProblem {
	kind: "truncated" | "unreadable-entry" | "unreadable-file";
	/** The daily file this concerns. */
	path: string;
	message: string;
}

export interface ReadJournalResult {
	entries: JournalEntry[];
	problems: JournalProblem[];
}

/** An entry read from a file, with the context the file itself supplies. */
export interface JournalEntryWithContext extends JournalEntry {
	/** `YYYY-MM-DD`, from the file name. */
	date: string;
	/** The host directory the entry was found in. */
	host: string;
	path: string;
}

export interface ReadJournalContextResult {
	entries: JournalEntryWithContext[];
	problems: JournalProblem[];
}

const DAILY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;

/**
 * Split a daily file into entry blocks and parse each.
 *
 * A complete entry ends with a blank line. The last entry in a file that does
 * not is treated as truncated: the writer died between opening the file and
 * finishing its single write.
 */
export function parseDailyFile(text: string, path = "<memory>"): ReadJournalResult {
	const entries: JournalEntry[] = [];
	const problems: JournalProblem[] = [];

	if (text.trim() === "") return { entries, problems };

	const lines = text.split("\n");
	const starts: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if ((lines[i] as string).startsWith("## ")) starts.push(i);
	}

	if (starts.length === 0) {
		problems.push({ kind: "unreadable-file", path, message: "no entry headings found" });
		return { entries, problems };
	}

	// Anything before the first heading is not part of an entry. It is not an
	// error — a store may carry a hand-written preamble — so it is ignored.
	for (let index = 0; index < starts.length; index++) {
		const from = starts[index] as number;
		const to = index + 1 < starts.length ? (starts[index + 1] as number) : lines.length;
		const block = lines.slice(from, to).join("\n");

		const isLast = index === starts.length - 1;
		if (isLast && !endsWithBlankLine(block)) {
			problems.push({
				kind: "truncated",
				path,
				message: `entry at end of file is unterminated (${firstLine(block)}); it was never finished and is excluded`,
			});
			continue;
		}

		const parsed = parseEntry(block);
		if (!parsed.entry) {
			problems.push({
				kind: "unreadable-entry",
				path,
				message: `${firstLine(block)}: ${parsed.problems.join("; ")}`,
			});
			continue;
		}
		for (const problem of parsed.problems) {
			problems.push({ kind: "unreadable-entry", path, message: `${parsed.entry.id}: ${problem}` });
		}
		entries.push(parsed.entry);
	}

	return { entries, problems };
}

function endsWithBlankLine(block: string): boolean {
	// The block was split on headings, so its tail is whatever followed the last
	// body line. A complete entry always contributes a trailing empty line.
	return /\n\s*\n$/.test(block) || block.endsWith("\n\n");
}

function firstLine(block: string): string {
	return (block.split("\n")[0] ?? "").trim();
}

export function readDailyFile(path: string): ReadJournalResult {
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch (error) {
		return {
			entries: [],
			problems: [
				{
					kind: "unreadable-file",
					path,
					message: error instanceof Error ? error.message : String(error),
				},
			],
		};
	}
	return parseDailyFile(text, path);
}

export interface JournalFile {
	host: string;
	date: string;
	path: string;
}

/**
 * Every daily file in a store, sorted by host then date.
 *
 * Directories that are not host ids and files that are not `YYYY-MM-DD.md` are
 * skipped in silence: the journal directory is Muninn's, but a user may well
 * drop a note in it, and that is not a fault to report on every session start.
 */
export function listJournalFiles(storePath: string): JournalFile[] {
	const root = join(storePath, "journal");
	const files: JournalFile[] = [];

	let hosts: string[];
	try {
		hosts = readdirSync(root);
	} catch {
		return files;
	}

	for (const host of hosts.sort()) {
		if (!isHostId(host)) continue;
		const dir = join(root, host);
		try {
			if (!statSync(dir).isDirectory()) continue;
		} catch {
			continue;
		}
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names.sort()) {
			const match = name.match(DAILY_FILE);
			if (!match) continue;
			files.push({ host, date: match[1] as string, path: join(dir, name) });
		}
	}

	return files;
}

/** Read every entry in a store, tagged with the host and date it came from. */
export function readStoreJournal(storePath: string): ReadJournalContextResult {
	const entries: JournalEntryWithContext[] = [];
	const problems: JournalProblem[] = [];

	for (const file of listJournalFiles(storePath)) {
		const result = readDailyFile(file.path);
		problems.push(...result.problems);
		for (const entry of result.entries) {
			entries.push({ ...entry, date: file.date, host: file.host, path: file.path });
		}
	}

	return { entries, problems };
}
