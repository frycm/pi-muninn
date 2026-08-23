/**
 * `/muninn …` — the human's way in.
 *
 * The tools are for the model; this is for the person watching. Every
 * subcommand answers in one screen of text, and the dispatch lives here rather
 * than in the extension entry so that "what does `/muninn promote` do" is a
 * question about one testable function rather than about a pi session.
 *
 * Two rules the whole surface follows:
 *
 *  - **Nothing surprising is silent.** An unknown subcommand prints usage
 *    rather than failing as if it were a typo; a write says which store it went
 *    to; a search that found nothing says how to widen it.
 *  - **Inspection never changes anything.** `scope` explains the situation
 *    without creating a store, which is what makes it usable for finding out
 *    why memory is not where you expected.
 */

import type { Channel } from "../capture/cues.ts";
import { bodyFromUserText } from "../capture/cues.ts";
import type { MuninnSessionState } from "../capture/session-state.ts";
import type { DreamListing } from "../dream/dreams.ts";
import { type DreamReport, reportTotals } from "../dream/report.ts";
import { isEntryId, parseClaimId } from "../ids.ts";
import type { SessionIndexes } from "../index/search.ts";
import type { AppendResult, NewJournalEntry } from "../journal/append.ts";
import { findEntry } from "../journal/lookup.ts";
import type { SessionContext } from "../session.ts";
import { formatScopes } from "../status.ts";
import type { CaptureTarget } from "../store/scopes.ts";
import { describeSync, type SyncResult } from "../sync/sync.ts";
import { renderHitLine } from "../tools/render.ts";
import { resolveWriteScope } from "../tools/runtime.ts";

export type CommandLevel = "info" | "warning" | "error";

export interface CommandOutput {
	text: string;
	level: CommandLevel;
}

/** What the command surface needs from the session it runs in. */
export interface CommandRuntime {
	/**
	 * Resolve this session's context.
	 *
	 * `createStores` is false for inspection: `/muninn scope` must be able to
	 * explain that no store exists without creating one as a side effect of
	 * asking.
	 */
	load(options: { createStores: boolean }): Promise<SessionContext>;
	/** Wait for pending appends and for the index to be open. */
	settle(): Promise<void>;
	indexes(): SessionIndexes | undefined;
	state(): MuninnSessionState | undefined;
	append(scope: CaptureTarget, entry: NewJournalEntry): Promise<AppendResult>;
	/** Throw away `.index/` and rebuild it. Returns the chunk count. */
	reindex(): Promise<number>;
	/** Commit, fetch, rebase and push every active store. */
	sync(options: { noPush?: boolean }): Promise<Array<{ scope: CaptureTarget; result: SyncResult }>>;
	/** The multi-line `/muninn` report, assembled by the extension entry. */
	statusReport(session: SessionContext): string;
	channel(): Channel;
	/** `<session file>#<leaf entry id>`, when there is one. */
	sessionPointer(): string | undefined;
	/**
	 * Run a dream in this session, reporting progress as it goes.
	 *
	 * Assembled by the extension entry, which is the only place a session's
	 * model and agent directory are both at hand.
	 */
	dream(options: { scope?: CaptureTarget; progress: (phase: string) => void }): Promise<DreamOutcome>;
	dreams(scope: CaptureTarget): Promise<DreamListing[]>;
	remember(scope: CaptureTarget, stamp: string): Promise<{ ok: boolean; problems: string[]; notes: string[] }>;
	forget(scope: CaptureTarget, stamp: string): Promise<{ ok: boolean; problems: string[]; notes: string[] }>;
	erase(
		scope: CaptureTarget,
		entryId: string,
		options: { noRewrite: boolean },
	): Promise<{ ok: boolean; problems: string[]; notes: string[] }>;
	eraseImpact(scope: CaptureTarget, entryId: string): { claims: string[]; facts: string[] };
	/** `topics/` and `rules.md` as they stand, for browsing. */
	derived(scope: CaptureTarget): { topics: Array<{ slug: string; facts: number; title: string }>; rules: string[] };
}

export interface DreamOutcome {
	ok: boolean;
	stamp: string;
	branch: string;
	report: DreamReport;
	problems: string[];
}

const SEARCH_LIMIT = 10;

export const USAGE = [
	"/muninn — long-term memory",
	"",
	"  /muninn                          status: scopes, journal, index, recall",
	"  /muninn note [--global] <text>   remember something, as source: user",
	"  /muninn promote <id>             copy a project entry into the global journal",
	"  /muninn search [--history] [--limit n] <query>",
	"  /muninn scope                    which scopes are active here, and why",
	"  /muninn reindex                  rebuild the index from the files",
	"  /muninn sync [--no-push]         commit, fetch, rebase, push",
	"  /muninn dream [--scope s]        consolidate the journal onto a branch",
	"  /muninn dreams                   list dreams; remember or forget one",
	"  /muninn dreams remember|forget <stamp>",
	"  /muninn topics | rules           what has been derived so far",
	"  /muninn erase <id> --yes --yes   privacy erasure (confirms twice)",
].join("\n");

/**
 * Pull leading `--flag` and `--flag value` out of an argument string.
 *
 * Only *leading* flags, and only the ones the subcommand knows: everything
 * from the first ordinary word — or the first unknown `--word` — on is the
 * text, verbatim. Newlines included, because `/muninn note` uses line starts
 * to tell a claim from its context, and a parser that rejoined the words would
 * quietly turn three bullets into one paragraph. And unknown flags are text,
 * because `/muninn note --no-verify is required here` is a note about a flag,
 * not a request for one, and eating the word would silently alter the memory.
 */
export function parseFlags(
	args: string,
	known: { flags?: readonly string[]; valued?: readonly string[] } = {},
): { flags: Set<string>; values: Map<string, string>; rest: string } {
	const flags = new Set<string>();
	const values = new Map<string, string>();
	const valued = known.valued ?? [];
	const boolean = known.flags ?? [];
	let cursor = 0;

	while (true) {
		const flag = args.slice(cursor).match(/^\s*--([a-z][a-z0-9-]*)/i);
		if (!flag) break;
		const name = flag[1] as string;
		if (!valued.includes(name) && !boolean.includes(name)) break;
		cursor += (flag[0] as string).length;
		if (!valued.includes(name)) {
			flags.add(name);
			continue;
		}
		const value = args.slice(cursor).match(/^[ \t]+(\S+)/);
		values.set(name, value ? (value[1] as string) : "");
		if (value) cursor += (value[0] as string).length;
	}

	return { flags, values, rest: args.slice(cursor).trim() };
}

export async function runMuninnCommand(args: string, runtime: CommandRuntime): Promise<CommandOutput> {
	const trimmed = args.trim();
	const space = trimmed.indexOf(" ");
	const name = (space === -1 ? trimmed : trimmed.slice(0, space)) || "status";
	const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();

	switch (name) {
		case "status":
			return status(runtime);
		case "scope":
			return scope(runtime);
		case "reindex":
			return reindex(runtime);
		case "note":
			return note(rest, runtime);
		case "promote":
			return promote(rest, runtime);
		case "search":
			return search(rest, runtime);
		case "sync":
			return runSync(rest, runtime);
		case "dream":
			return runDreamCommand(rest, runtime);
		case "dreams":
			return runDreamsCommand(rest, runtime);
		case "topics":
			return browse("topics", runtime);
		case "rules":
			return browse("rules", runtime);
		case "erase":
			return runEraseCommand(rest, runtime);
		case "help":
		case "--help":
			return { level: "info", text: USAGE };
		default:
			return { level: "warning", text: [`muninn: unknown subcommand "${name}"`, "", USAGE].join("\n") };
	}
}

// ---------------------------------------------------------------------------

async function status(runtime: CommandRuntime): Promise<CommandOutput> {
	const session = await runtime.load({ createStores: true });
	// Counts would otherwise miss an entry still on the queue.
	await runtime.settle();
	return { level: "info", text: runtime.statusReport(session) };
}

async function scope(runtime: CommandRuntime): Promise<CommandOutput> {
	const session = await runtime.load({ createStores: false });
	return { level: "info", text: formatScopes(session) };
}

async function reindex(runtime: CommandRuntime): Promise<CommandOutput> {
	await runtime.load({ createStores: true });
	const chunks = await runtime.reindex();
	return { level: "info", text: `muninn: index rebuilt — ${chunks} ${chunks === 1 ? "chunk" : "chunks"}` };
}

async function note(args: string, runtime: CommandRuntime): Promise<CommandOutput> {
	const { flags, rest } = parseFlags(args, { flags: ["global"] });
	if (rest === "") return { level: "warning", text: "muninn: /muninn note [--global] <text>" };

	const session = await runtime.load({ createStores: true });
	// The same rule `memory_note` uses, so the two never disagree about where a
	// write may go. It throws; the command handler turns that into an error line.
	const target = resolveWriteScope(session, flags.has("global") ? "global" : undefined);

	const body = bodyFromUserText(rest);
	const state = runtime.state();
	const entry: NewJournalEntry = {
		// The user typed it. That is the strongest provenance Muninn records,
		// and it is why `/muninn note` is not the same tool as `memory_note`.
		source: "user",
		channel: runtime.channel(),
		phase: "other",
		prose: body.prose,
		claims: body.claims,
	};
	if (state) {
		entry.task = state.task;
		if (state.continues) entry.continues = state.continues;
		if (state.recalled.length > 0) entry.recalled = [...state.recalled];
	}
	const pointer = runtime.sessionPointer();
	if (pointer) entry.session = pointer;

	const written = await runtime.append(target, entry);
	return {
		level: "info",
		text: [`muninn: noted in the ${target} store as ${written.id}`, ...written.claimIds.map((id) => `  ${id}`)].join(
			"\n",
		),
	};
}

/**
 * Copy a project entry into the global journal.
 *
 * A copy, not a move: the project journal is append-only and the original stays
 * where it was observed. The copy carries `promoted_from: <project>/<id>`, so
 * the global store can always say which project a memory came from — long after
 * that checkout is gone from this machine.
 */
async function promote(args: string, runtime: CommandRuntime): Promise<CommandOutput> {
	const id = args.trim();
	if (id === "") return { level: "warning", text: "muninn: /muninn promote <entry id>" };

	const session = await runtime.load({ createStores: true });
	await runtime.settle();

	const claim = parseClaimId(id);
	const entryId = claim?.entryId ?? id;
	if (!isEntryId(entryId)) return { level: "error", text: `muninn: ${id} is not a journal entry id` };

	const found = findEntry(runtime.indexes(), entryId);
	if (found.scope === "global") {
		return { level: "warning", text: `muninn: ${entryId} is already in the global journal` };
	}
	if (!session.scopes.active.some((active) => active.scope === "global")) {
		return {
			level: "error",
			text: "muninn: the global scope is not active in this session, so there is nowhere to promote to",
		};
	}

	const project = session.scopes.active.find((active) => active.scope === "project");
	const origin = `${project?.slug ?? "project"}/${entryId}`;
	const source = found.entry;
	const copy: NewJournalEntry = {
		source: source.source,
		channel: runtime.channel(),
		phase: source.phase ?? "other",
		prose: source.prose,
		claims: source.claims,
		promotedFrom: origin,
	};
	if (source.cue) copy.cue = source.cue;
	// The evidence pointer still resolves — it names a pi session file, not a
	// store — so the promoted copy keeps its way back to the transcript.
	if (source.session) copy.session = source.session;

	const written = await runtime.append("global", copy);
	return {
		level: "info",
		text: `muninn: promoted ${entryId} into the global journal as ${written.id} (from ${origin})`,
	};
}

/**
 * Commit, fetch, rebase and push every active store.
 *
 * Reports per scope and in full: sync is the one operation whose failure a
 * user has to be able to act on — an unreachable remote, a conflict it will
 * not resolve, a rejected push — so every note it produced is shown rather
 * than summarised away.
 */
async function runSync(args: string, runtime: CommandRuntime): Promise<CommandOutput> {
	const { flags } = parseFlags(args, { flags: ["no-push"] });
	await runtime.load({ createStores: true });
	await runtime.settle();

	const outcomes = await runtime.sync(flags.has("no-push") ? { noPush: true } : {});
	if (outcomes.length === 0)
		return { level: "warning", text: "muninn: no store is active here, so there is nothing to sync" };

	const lines: string[] = [];
	let level: CommandLevel = "info";
	for (const { scope, result } of outcomes) {
		lines.push(`${scope}: ${describeSync(result)}`);
		for (const note of result.notes) lines.push(`  ${note}`);
		if (result.problem) level = result.offline ? "warning" : "error";
	}
	return { level, text: lines.join("\n") };
}

async function search(args: string, runtime: CommandRuntime): Promise<CommandOutput> {
	const { flags, values, rest } = parseFlags(args, { flags: ["history"], valued: ["limit"] });
	if (rest === "") return { level: "warning", text: "muninn: /muninn search [--history] [--limit n] <query>" };

	await runtime.load({ createStores: true });
	await runtime.settle();

	const parsed = Number.parseInt(values.get("limit") ?? "", 10);
	const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : SEARCH_LIMIT;
	const history = flags.has("history");
	const hits = runtime.indexes()?.search({ query: rest, limit, history }) ?? [];

	if (hits.length === 0) {
		return {
			level: "info",
			text: history
				? `muninn: nothing matches "${rest}", including superseded memories`
				: `muninn: nothing active matches "${rest}" — try /muninn search --history "${rest}"`,
		};
	}

	// One line per hit, ids elided: this is a list to look at. `memory_read`
	// and the full ids are one step away for whoever wants the whole entry.
	const lines = hits.map((hit) => `  ${renderHitLine(hit)}${hit.superseded ? " · superseded" : ""}`);
	const header = `${hits.length} ${hits.length === 1 ? "memory" : "memories"} for "${rest}"${history ? " (including superseded)" : ""}:`;
	return { level: "info", text: [header, ...lines].join("\n") };
}

// ---------------------------------------------------------------------------
// Dreaming
// ---------------------------------------------------------------------------

/**
 * `/muninn dream` — run one now, in the foreground, with progress.
 *
 * Foreground because a dream started from a keystroke is something the person
 * is waiting for, and because the alternative — a background job whose failure
 * arrives later out of context — is exactly the shape of failure this design
 * spends so much effort avoiding elsewhere.
 */
async function runDreamCommand(args: string, runtime: CommandRuntime): Promise<CommandOutput> {
	const { values } = parseFlags(args, { valued: ["scope"] });
	const wanted = values.get("scope");
	if (wanted !== undefined && wanted !== "global" && wanted !== "project") {
		return { level: "warning", text: 'muninn: --scope takes "global" or "project"' };
	}

	// Anything this session appended has to be on disk before the dream commits
	// the journal, or it lands in the next dream's range instead of this one's.
	await runtime.settle();

	const lines: string[] = [];
	const outcome = await runtime.dream({
		...(wanted ? { scope: wanted } : {}),
		progress: (phase) => lines.push(`  ${phase}…`),
	});

	const totals = reportTotals(outcome.report);
	lines.push(...outcome.report.gathered.map((line) => `  ${line}`));
	for (const change of outcome.report.consolidated) {
		lines.push(`  ${change.topic}: +${change.added} fact(s), ${change.superseded} superseded`);
	}
	const blocking = outcome.report.lint.filter((finding) => finding.blocking);
	for (const finding of blocking) lines.push(`  ! ${finding.rule}: ${finding.message}`);
	for (const skip of outcome.report.skipped) lines.push(`  ! skipped ${skip.topic}: ${skip.reason}`);
	for (const problem of outcome.problems) lines.push(`  ! ${problem}`);

	if (!outcome.ok) {
		return { level: "error", text: ["muninn: the dream did not finish", ...lines].join("\n") };
	}
	if (blocking.length > 0) {
		return {
			level: "warning",
			text: [
				`muninn: ${outcome.branch} failed lint (${blocking.length} blocking)`,
				...lines,
				"  the branch is kept so you can see what it did; it will not be offered for remember",
			].join("\n"),
		};
	}
	return {
		level: "info",
		text: [
			`muninn: ${outcome.branch} — ${totals.added} fact(s), ${totals.superseded} superseded, ${totals.topics} topic(s)`,
			...lines,
			`  review with /muninn dreams, apply with /muninn dreams remember ${outcome.stamp}`,
		].join("\n"),
	};
}

/** `/muninn dreams [remember|forget <stamp>]`. */
async function runDreamsCommand(args: string, runtime: CommandRuntime): Promise<CommandOutput> {
	const session = await runtime.load({ createStores: false });
	const target = session.scopes.captureTarget;
	if (target === null) return { level: "warning", text: "muninn: no scope is active here" };

	const [action, stamp] = args.split(/\s+/).filter((part) => part !== "");

	if (action === undefined) {
		const listed = await runtime.dreams(target);
		if (listed.length === 0) {
			return { level: "info", text: "muninn: no dreams yet — /muninn dream runs one" };
		}
		const lines = listed.map((entry) => {
			const state = entry.forgotten ? "forgotten" : entry.remembered ? "remembered" : "pending";
			const totals = entry.report ? reportTotals(entry.report) : undefined;
			const shape = totals ? `${totals.added} fact(s), ${totals.superseded} superseded` : "no report";
			const blocking = entry.report?.lint.filter((finding) => finding.blocking).length ?? 0;
			return `  ${entry.stamp}  ${state.padEnd(11)} ${shape}${blocking > 0 ? ` · ${blocking} blocking` : ""}`;
		});
		return { level: "info", text: [`muninn: ${listed.length} dream(s)`, ...lines].join("\n") };
	}

	if (action !== "remember" && action !== "forget") {
		return { level: "warning", text: `muninn: /muninn dreams takes "remember" or "forget", not "${action}"` };
	}
	if (stamp === undefined) {
		return { level: "warning", text: `muninn: ${action} needs a dream stamp; /muninn dreams lists them` };
	}

	const result = action === "remember" ? await runtime.remember(target, stamp) : await runtime.forget(target, stamp);
	const lines = [...result.notes.map((note) => `  ${note}`), ...result.problems.map((problem) => `  ! ${problem}`)];
	if (!result.ok) return { level: "error", text: [`muninn: could not ${action} ${stamp}`, ...lines].join("\n") };
	return {
		level: "info",
		text: [
			`muninn: ${action === "remember" ? "remembered" : "forgot"} ${stamp}`,
			...lines,
			// The snapshot is frozen for the life of a session by design, so
			// saying "done" without this would look like nothing happened.
			"  this session keeps the memory it started with; the next one reads the new MEMORY.md",
		].join("\n"),
	};
}

/** `/muninn topics` and `/muninn rules` — what has been derived so far. */
async function browse(what: "topics" | "rules", runtime: CommandRuntime): Promise<CommandOutput> {
	const session = await runtime.load({ createStores: false });
	const target = session.scopes.captureTarget;
	if (target === null) return { level: "warning", text: "muninn: no scope is active here" };

	const derived = runtime.derived(target);
	if (what === "topics") {
		if (derived.topics.length === 0) {
			return { level: "info", text: "muninn: no topics yet — they are written by /muninn dream" };
		}
		const lines = derived.topics.map((topic) => `  ${topic.slug.padEnd(24)} ${topic.facts} fact(s)  ${topic.title}`);
		return { level: "info", text: [`muninn: ${derived.topics.length} topic(s)`, ...lines].join("\n") };
	}

	if (derived.rules.length === 0) {
		// Said plainly, because "no rules" could otherwise be read as "dreams
		// have not got round to it" rather than "this is yours to write".
		return {
			level: "info",
			text: "muninn: no rules — rules.md is written by hand; dreams read and lint it but do not write it",
		};
	}
	return {
		level: "info",
		text: [`muninn: ${derived.rules.length} rule(s)`, ...derived.rules.map((rule) => `  ${rule}`)].join("\n"),
	};
}

/**
 * `/muninn erase <id> --yes --yes`.
 *
 * The impact is printed on the first call and the second `--yes` is what
 * proceeds, so a person confirms something specific rather than a general
 * intention.
 */
async function runEraseCommand(args: string, runtime: CommandRuntime): Promise<CommandOutput> {
	const session = await runtime.load({ createStores: false });
	const target = session.scopes.captureTarget;
	if (target === null) return { level: "warning", text: "muninn: no scope is active here" };

	const words = args.split(/\s+/).filter((part) => part !== "");
	const entryId = words.find((word) => isEntryId(word));
	if (entryId === undefined) {
		return { level: "warning", text: "muninn: /muninn erase needs a journal entry id (j-…)" };
	}
	const confirmations = words.filter((word) => word === "--yes").length;
	const impact = runtime.eraseImpact(target, entryId);
	const summary = `${entryId}: ${impact.claims.length} claim(s), ${impact.facts.length} fact(s) rest on them`;

	if (confirmations < 2) {
		return {
			level: "warning",
			text: [
				`muninn: ${summary}`,
				"  erasure rewrites git history and cannot be undone.",
				`  to go ahead: /muninn erase ${entryId} --yes --yes`,
			].join("\n"),
		};
	}

	const result = await runtime.erase(target, entryId, { noRewrite: words.includes("--no-rewrite") });
	const lines = [...result.notes.map((note) => `  ${note}`), ...result.problems.map((problem) => `  ! ${problem}`)];
	return {
		level: result.ok ? "info" : "error",
		text: [result.ok ? `muninn: erased ${entryId}` : `muninn: could not erase ${entryId}`, ...lines].join("\n"),
	};
}
