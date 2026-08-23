/**
 * Phase 1 of a dream: read what is already there.
 *
 * One pass over the worktree, no model, no judgement. It answers three
 * questions the later phases need and would otherwise each answer differently:
 * which topics exist and what evidence they already cite, which journal claims
 * are still active, and how much each fact has actually been used.
 *
 * Everything is read from the dream's *worktree*, never from the store people
 * are using. That is what makes "everything this dream consolidated is at or
 * before `input_head`" a fact about the code rather than a hope.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readErasures } from "../journal/erasures.ts";
import { readStoreJournal } from "../journal/read.ts";
import { readSupersessions } from "../journal/supersessions.ts";
import { allFacts, type Fact, parseTopic, type TopicFile } from "../topics/format.ts";
import { type Usage, useCounts } from "../topics/use-count.ts";
import { parseReport } from "./report.ts";

export interface Orientation {
	/** Every topic file in the store, keyed by slug. */
	topics: Map<string, TopicFile>;
	/** Every fact anywhere, keyed by id — including superseded ones. */
	factsById: Map<string, Fact>;
	/** Journal claim id → the topic whose fact already cites it. */
	citedBy: Map<string, string>;
	/** Claim ids ordinary recall must drop. */
	superseded: Set<string>;
	/** Entry ids erased for privacy; a dream may never cite one. */
	erased: Set<string>;
	usage: Map<string, Usage>;
	/** `MEMORY.md` as it stands, kept so its hand-written part survives. */
	memory: string;
	/** `rules.md` as it stands. Phase 2 lints it; it does not write it. */
	rules: string;
	/** The previous dream's `input_head`, when there is one. */
	previousInputHead?: string;
	/** Last entry id per host, from that dream's report. */
	previousJournalThrough: Record<string, string>;
	problems: string[];
}

/** Read everything a dream needs to know before it decides anything. */
export function orient(storePath: string): Orientation {
	const journal = readStoreJournal(storePath);
	const usage = useCounts(journal.entries.map((entry) => ({ entry, date: entry.date })));
	const supersessions = readSupersessions(storePath);

	const orientation: Orientation = {
		topics: new Map(),
		factsById: new Map(),
		citedBy: new Map(),
		superseded: supersessions.superseded,
		erased: readErasures(storePath).ids,
		usage,
		memory: readIfPresent(join(storePath, "MEMORY.md")),
		rules: readIfPresent(join(storePath, "rules.md")),
		previousJournalThrough: {},
		problems: [...supersessions.problems, ...journal.problems.map((problem) => `${problem.kind}: ${problem.path}`)],
	};

	for (const [slug, topic] of readTopics(storePath)) {
		orientation.topics.set(slug, topic);
		orientation.problems.push(...topic.problems);
		for (const fact of allFacts(topic)) {
			orientation.factsById.set(fact.id, fact);
			// Only *active* facts claim their evidence. A superseded fact's
			// evidence is free to be cited again — that is how a claim that was
			// misread once can be consolidated correctly later.
			if (fact.validTo !== undefined) continue;
			for (const claim of fact.evidence) orientation.citedBy.set(claim, slug);
		}
	}

	const previous = latestReport(storePath);
	if (previous?.inputHead) {
		orientation.previousInputHead = previous.inputHead;
		orientation.previousJournalThrough = previous.journalThrough;
	}

	return orientation;
}

function readIfPresent(path: string): string {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "";
	}
}

/** Every `topics/*.md`, parsed. A file that is not markdown is ignored in silence. */
export function readTopics(storePath: string): Map<string, TopicFile> {
	const topics = new Map<string, TopicFile>();
	const dir = join(storePath, "topics");
	if (!existsSync(dir)) return topics;
	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith(".md")) continue;
		const slug = basename(name, ".md");
		try {
			topics.set(slug, parseTopic(readFileSync(join(dir, name), "utf-8"), slug));
		} catch {
			// Unreadable is not the same as absent, but neither is a reason to
			// refuse the dream; lint reports the topic as missing its facts.
		}
	}
	return topics;
}

/**
 * The newest dream report in the store.
 *
 * Reports are named by their stamp, which sorts chronologically, so "newest" is
 * the last name — no parsing needed to order them, and a report a person copied
 * in by hand sorts into the right place too.
 */
export function latestReport(storePath: string) {
	const dir = join(storePath, "dreams");
	if (!existsSync(dir)) return undefined;
	const names = readdirSync(dir)
		.filter((name) => name.endsWith(".md"))
		.sort();
	for (const name of names.reverse()) {
		const stamp = basename(name, ".md");
		const report = parseReport(readFileSync(join(dir, name), "utf-8"), stamp);
		// A failed dream consolidated nothing, so its range was never learned
		// from; the next dream must start where the last *successful* one ended.
		if (report && report.status === "complete") return report;
	}
	return undefined;
}
