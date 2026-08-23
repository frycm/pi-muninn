/**
 * `dreams/<stamp>.md` — what a dream read, what it changed, and what it could not.
 *
 * The report is not a log. It is the record that makes a dream reviewable: the
 * exact commit range it consolidated from, the task groups it held out, the
 * lint findings, and — from Phase 3 — the eval table. `/muninn dreams` renders
 * it, so it is parsed as well as written, and the machine-readable part is the
 * front matter while the body is prose for whoever is deciding whether to
 * remember it.
 *
 * `input_head` and `journal_through` are the two fields everything else leans
 * on. They turn "which entries has this store not yet learned from" into
 * `git diff input_head..main -- journal/`, which is a question with an exact
 * answer rather than a heuristic.
 */
import { parseTrailer } from "../journal/trailer.ts";

export type DreamStatus = "complete" | "lint-blocked" | "failed";

export interface TopicChange {
	topic: string;
	added: number;
	superseded: number;
	/** Fact ids added, so a reviewer can find them without a diff. */
	addedIds: string[];
}

export interface LintFinding {
	blocking: boolean;
	rule: string;
	message: string;
}

export interface DreamReport {
	stamp: string;
	scope: string;
	host: string;
	/** The dreamer model, or `none` when no job needed one. */
	model: string;
	status: DreamStatus;
	/** The commit everything consolidated is at or before. */
	inputHead: string;
	/** The previous dream's `input_head`; the range starts there. */
	previousInputHead?: string;
	/** Last entry id seen per host id, in the range. */
	journalThrough: Record<string, string>;
	/** Task ids withheld from gather, so the evaluate phase can score on them. */
	heldOut: string[];
	started: string;
	finished?: string;
	/** Free-text lines under *Gathered*. */
	gathered: string[];
	consolidated: TopicChange[];
	lint: LintFinding[];
	/** Topics a job could not produce a usable answer for. */
	skipped: Array<{ topic: string; reason: string }>;
	/** Anything else worth saying, in the order it was said. */
	notes: string[];
}

export function emptyReport(base: Pick<DreamReport, "stamp" | "scope" | "host" | "started">): DreamReport {
	return {
		...base,
		model: "none",
		status: "complete",
		inputHead: "",
		journalThrough: {},
		heldOut: [],
		gathered: [],
		consolidated: [],
		lint: [],
		skipped: [],
		notes: [],
	};
}

export function reportPath(stamp: string): string {
	return `dreams/${stamp}.md`;
}

/** Totals, for a status line and for the branch's commit message. */
export function reportTotals(report: DreamReport): { added: number; superseded: number; topics: number } {
	let added = 0;
	let superseded = 0;
	for (const change of report.consolidated) {
		added += change.added;
		superseded += change.superseded;
	}
	return { added, superseded, topics: report.consolidated.length };
}

export function formatReport(report: DreamReport): string {
	const out: string[] = ["---"];
	out.push(`dream: ${report.stamp}`);
	out.push(`scope: ${report.scope}`);
	out.push(`host: ${report.host}`);
	out.push(`model: ${report.model}`);
	out.push(`status: ${report.status}`);
	out.push(`input_head: ${report.inputHead}`);
	if (report.previousInputHead) out.push(`previous_input_head: ${report.previousInputHead}`);
	const through = Object.entries(report.journalThrough)
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([host, id]) => `${host}: ${id}`)
		.join(" · ");
	if (through !== "") out.push(`journal_through: ${through}`);
	if (report.heldOut.length > 0) out.push(`held_out: ${report.heldOut.join(", ")}`);
	out.push(`started: ${report.started}`);
	if (report.finished) out.push(`finished: ${report.finished}`);
	out.push("---", "", `# Dream ${report.stamp}`, "");

	out.push("## Gathered", "");
	out.push(...bullets(report.gathered, "Nothing new in this range."));
	out.push("");

	out.push("## Consolidated", "");
	if (report.consolidated.length === 0) {
		out.push("No topic was affected.");
	} else {
		for (const change of report.consolidated) {
			out.push(`- **${change.topic}** — ${change.added} added, ${change.superseded} superseded`);
			for (const id of change.addedIds) out.push(`  - ${id}`);
		}
	}
	out.push("");

	out.push("## Lint", "");
	if (report.lint.length === 0) {
		out.push("Clean.");
	} else {
		for (const finding of report.lint) {
			out.push(`- ${finding.blocking ? "**blocking**" : "advisory"} · ${finding.rule} — ${finding.message}`);
		}
	}
	out.push("");

	// The columns Phase 3 fills. Written empty rather than omitted so that the
	// shape of a report does not change when the evaluate phase arrives.
	out.push("## Eval", "", "_Not run: the evaluate phase arrives with Phase 3._", "");

	if (report.skipped.length > 0) {
		out.push("## Skipped", "");
		for (const skip of report.skipped) out.push(`- **${skip.topic}** — ${skip.reason}`);
		out.push("");
	}

	if (report.notes.length > 0) {
		out.push("## Notes", "");
		out.push(...bullets(report.notes, ""));
		out.push("");
	}

	return `${out.join("\n").trimEnd()}\n`;
}

function bullets(lines: readonly string[], empty: string): string[] {
	if (lines.length === 0) return empty === "" ? [] : [empty];
	return lines.map((line) => `- ${line}`);
}

/**
 * Read a report's front matter.
 *
 * Only the front matter: the body is prose for a human, and a parser that tried
 * to read it back would make the prose a format nobody could edit. Everything a
 * command needs to decide something — the range, the status, the held-out
 * groups — is above the second `---`.
 */
export function parseReport(text: string, stamp: string): DreamReport | undefined {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") return undefined;

	const fields = new Map<string, string>();
	let index = 1;
	for (; index < lines.length && lines[index]?.trim() !== "---"; index++) {
		const line = lines[index] as string;
		const colon = line.indexOf(":");
		if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
	}

	const status = fields.get("status");
	const report = emptyReport({
		stamp: fields.get("dream") ?? stamp,
		scope: fields.get("scope") ?? "global",
		host: fields.get("host") ?? "",
		started: fields.get("started") ?? "",
	});
	report.model = fields.get("model") ?? "none";
	report.status = status === "failed" || status === "lint-blocked" ? status : "complete";
	report.inputHead = fields.get("input_head") ?? "";
	const previous = fields.get("previous_input_head");
	if (previous !== undefined && previous !== "") report.previousInputHead = previous;
	const finished = fields.get("finished");
	if (finished !== undefined && finished !== "") report.finished = finished;

	const through = fields.get("journal_through");
	if (through !== undefined && through !== "") {
		for (const [host, id] of parseTrailer(through)) report.journalThrough[host] = id;
	}
	const heldOut = fields.get("held_out");
	if (heldOut !== undefined && heldOut !== "") {
		report.heldOut = heldOut
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part !== "");
	}
	return report;
}
