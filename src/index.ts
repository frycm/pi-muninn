/**
 * pi-muninn extension entry point.
 *
 * Phase 1 step 9: sessions leave a journal of what the user asked to be
 * remembered, what they corrected and how each task turned out; every store
 * carries a Tier 0 index of it; and both halves of recall are wired up — the
 * frozen `MEMORY.md` snapshot in the system prompt, and a bounded, prompt-
 * driven injection each turn. The tools the model can drive itself arrive in
 * step 10.
 */
import {
	type BeforeAgentStartEventResult,
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import { MUNINN_MESSAGE_TYPE, RunAccumulator } from "./capture/accumulate.ts";
import { decideCapture } from "./capture/capture.ts";
import { commitJournal } from "./capture/commit.ts";
import { channelForMode } from "./capture/cues.ts";
import { shouldWriteOutcome } from "./capture/outcome.ts";
import { type OutcomeModel, runOutcome } from "./capture/outcome-run.ts";
import { AppendQueue } from "./capture/queue.ts";
import {
	assistantText,
	type MuninnSessionState,
	rebuildState,
	STATE_CUSTOM_TYPE,
	type StateDelta,
	taskFromSessionFile,
} from "./capture/session-state.ts";
import { SessionIndexes } from "./index/search.ts";
import { type AppendResult, appendEntry } from "./journal/append.ts";
import { buildRecallMessage, contextFileLines, RECALL_KINDS } from "./recall/per-turn.ts";
import { appendSnapshot, readSnapshot, type Snapshot } from "./recall/snapshot.ts";
import { buildSessionContext, journalStats, type SessionContext } from "./session.ts";
import { formatScopes, formatStatus, formatStatusLine, formatWarning } from "./status.ts";
import { MUNINN_VERSION } from "./version.ts";

function describeRuntime(): string {
	const bunVersion = (globalThis as { Bun?: { version: string } }).Bun?.version;
	if (bunVersion) return `bun ${bunVersion}`;
	return `node ${process.versions.node}`;
}

/** `<session file>#<leaf entry id>` — the evidence pointer into pi's session tree. */
function sessionPointer(sessionManager: {
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
}): string | undefined {
	const file = sessionManager.getSessionFile();
	if (!file) return undefined;
	const leaf = sessionManager.getLeafId();
	return leaf ? `${file}#${leaf}` : file;
}

export default function (pi: ExtensionAPI): void {
	// Resolved per session rather than once at load: the project settings file
	// and the project store both depend on cwd, and a session can start in a
	// different directory than the one the extension was loaded from.
	let session: SessionContext | undefined;
	let state: MuninnSessionState | undefined;
	/** The agent's last turn — what a correction is a correction *of*. */
	let previousAssistantText: string | undefined;
	const queue = new AppendQueue();
	const run = new RunAccumulator();
	/** Set when the pre-compaction path already wrote this run's outcome entry. */
	let runAlreadyJournaled = false;
	/** Aborts an outcome call when the session goes away mid-flight. */
	let outcomeAbort: AbortController | undefined;
	/**
	 * Runs that settled without pi's authoritative `agent_end` payload, and so
	 * were assembled from `turn_end` alone. Reported by `/muninn`; if this stays
	 * at zero across real use, core change #2 is an ergonomics ask rather than a
	 * gap worth proposing.
	 */
	let runsWithoutAgentEnd = 0;
	/** Entries appended since the last commit, for the commit message. */
	let uncommittedEntries = 0;
	/** One Tier 0 index per active scope, opened once and kept for the session. */
	let indexes: SessionIndexes | undefined;
	/**
	 * The frozen `MEMORY.md` snapshot: read once, injected byte-identically on
	 * every turn. Re-reading the file mid-session would break the provider's
	 * prompt cache and leave the model's context disagreeing with itself.
	 */
	let snapshot: Snapshot | undefined;
	/** Lines pi already loaded into the prompt, so recall does not repeat them. */
	let contextLines: string[] | undefined;
	/** Texts of what was recalled this session, by id — the input to echo detection. */
	const recalledTexts = new Map<string, string>();

	const load = async (cwd: string, projectTrusted: boolean, createStores: boolean): Promise<SessionContext> => {
		session ??= await buildSessionContext({
			agentDir: getAgentDir(),
			cwd,
			configDirName: CONFIG_DIR_NAME,
			projectTrusted,
			createStores,
		});
		return session;
	};

	const captureTargetPath = (current: SessionContext): string | undefined =>
		current.scopes.active.find((scope) => scope.scope === current.scopes.captureTarget)?.path;

	/**
	 * Everything that follows an append: remember the id, count it for the
	 * commit message, and put it in the index.
	 *
	 * Indexing here rather than at the next session start is what makes a
	 * correction findable in the turn after it was made — the entry is chunked
	 * from what was just written, so nothing is re-read and nothing waits.
	 */
	const afterAppend = (
		current: SessionContext,
		currentState: MuninnSessionState,
		storePath: string,
		written: AppendResult,
	): void => {
		currentState.written.push(written.id);
		uncommittedEntries++;
		indexes?.addEntry(storePath, {
			...written.entry,
			date: written.date,
			host: current.host.id,
			path: written.path,
		});
		pi.appendEntry(STATE_CUSTOM_TYPE, { kind: "written", ids: [written.id] } satisfies StateDelta);
	};

	/**
	 * Open (and rebuild what is stale in) every active scope's index.
	 *
	 * On the queue, not awaited in the handler: a first build over a large
	 * store is seconds of work, and no session should wait on it to accept the
	 * user's first keystroke. The queue is serial, so any append that follows —
	 * and recall, which drains the queue before it queries — finds the index
	 * already open.
	 */
	const openIndexes = (current: SessionContext, force: boolean): void => {
		queue.enqueue("index", async () => {
			const opened = SessionIndexes.open(current.scopes.active, force ? { force: true } : {});
			indexes = opened.indexes;
			if (opened.problems.length > 0) {
				process.stderr.write(`${["muninn: index problems", ...opened.problems.map((p) => `  ! ${p}`)].join("\n")}\n`);
			}
		});
	};

	pi.registerCommand("muninn", {
		description: "Muninn status, scopes, settings and index",
		handler: async (args, ctx) => {
			const sub = args.trim() || "status";
			// `scope` explains the situation and must not change it, so it never
			// creates a store.
			const current = await load(ctx.cwd, ctx.isProjectTrusted(), sub !== "scope");

			if (sub === "status") {
				// Counts would otherwise miss an entry still in the queue.
				await queue.flush();
				const indexStats = indexes?.scopes.map((scoped) => ({
					scope: scoped.scope,
					chunks: scoped.index.size,
					files: scoped.index.files,
				}));
				const recallStats = {
					snapshotLines: snapshot?.lines ?? 0,
					snapshotTrimmed: snapshot?.scopes.reduce((total, scope) => total + scope.dropped, 0) ?? 0,
					recalled: state?.recalled.length ?? 0,
				};
				ctx.ui.notify(
					formatStatus({
						muninnVersion: MUNINN_VERSION,
						piVersion: PI_VERSION,
						runtime: describeRuntime(),
						session: current,
						journal: journalStats(current),
						captureFailures: queue.peekFailures().map((failure) => `${failure.label}: ${failure.message}`),
						runsWithoutAgentEnd,
						...(indexStats ? { index: indexStats } : {}),
						recall: recallStats,
					}),
					"info",
				);
				return;
			}
			if (sub === "reindex") {
				// Unconditional: the point of asking is to distrust what is on disk.
				openIndexes(current, true);
				await queue.flush();
				const total = indexes?.size ?? 0;
				ctx.ui.notify(`muninn: index rebuilt — ${total} ${total === 1 ? "chunk" : "chunks"}`, "info");
				return;
			}
			if (sub === "scope") {
				ctx.ui.notify(formatScopes(current), "info");
				return;
			}
			// Every other subcommand named in the design lands in a later step; say
			// so rather than failing as if it were a typo.
			ctx.ui.notify(`"/muninn ${sub}" is not implemented yet (try: status, scope, reindex)`, "warning");
		},
	});

	pi.on("session_start", async (event, ctx) => {
		session = undefined;
		indexes = undefined;
		snapshot = undefined;
		contextLines = undefined;
		recalledTexts.clear();
		previousAssistantText = undefined;
		const current = await load(ctx.cwd, ctx.isProjectTrusted(), true);
		ctx.ui.setStatus("muninn", formatStatusLine(current));

		const task = ctx.sessionManager.getSessionId();
		state = rebuildState(ctx.sessionManager.getBranch(), task);

		// A resumed or forked session continues the same task, so both halves stay
		// one group for the evaluate phase to hold out together.
		if (state.continues === undefined && (event.reason === "resume" || event.reason === "fork")) {
			const continues = taskFromSessionFile(event.previousSessionFile);
			if (continues && continues !== task) state.continues = continues;
		}
		pi.appendEntry(
			STATE_CUSTOM_TYPE,
			(state.continues
				? { kind: "start", task: state.task, continues: state.continues }
				: { kind: "start", task: state.task }) satisfies StateDelta,
		);

		openIndexes(current, false);
		// Read once, here. Everything downstream uses this string, never the file.
		snapshot = readSnapshot(current.scopes.active, current.loaded.settings.recall.snapshotLines);

		// A misread setting or an unusable store means Muninn is not behaving the
		// way the files say it should. That is exactly the class of failure this
		// project refuses to let pass quietly, so it goes to stderr as well as the
		// footer — stderr is visible in --print and RPC modes, where no footer is
		// attached.
		const trouble = [...current.loaded.warnings.map(formatWarning), ...current.problems.map((p) => `  ! ${p}`)];
		if (trouble.length > 0) {
			process.stderr.write(`${[`muninn: ${trouble.length} problem(s)`, ...trouble].join("\n")}\n`);
		}
	});

	pi.on("turn_end", (event) => {
		const text = assistantText(event.message);
		if (text !== undefined) previousAssistantText = text;
		run.onTurnEnd(event.message, event.toolResults);
	});

	// pi's own view of the run. Where it and the accumulated turns disagree, pi
	// is right.
	pi.on("agent_end", (event) => {
		run.onAgentEnd(event.messages);
	});

	/**
	 * Recall, both halves, on the way into a turn.
	 *
	 * The snapshot is the same bytes every turn; the per-turn message is chosen
	 * by this prompt and bounded by `recall.factsPerTurn` and
	 * `recall.tokenBudget`. Either half may be absent — a store with nothing in
	 * it injects nothing at all, rather than an empty "Memory" heading.
	 */
	pi.on("before_agent_start", async (event) => {
		const current = session;
		if (!current) return;

		const result: BeforeAgentStartEventResult = {};
		if (snapshot) result.systemPrompt = appendSnapshot(event.systemPrompt, snapshot);

		// pi loads its context files once per session, so their lines are worth
		// splitting once rather than on every turn.
		contextLines ??= [
			...contextFileLines(event.systemPromptOptions.contextFiles),
			...(snapshot ? snapshot.text.split("\n") : []),
		];

		// Two things are on that queue and both must land before a query: the
		// index open (queued at session start, so the first turn would otherwise
		// recall from nothing) and any entry the previous turn appended. Recall
		// missing what this very session just captured would be the kind of
		// silent gap that makes memory untrustworthy. A queue failure is
		// recorded rather than thrown, so this waits but never hangs on one.
		await queue.flush();

		const recall = indexes
			? buildRecallMessage({
					// Over-fetch: the "AGENTS.md wins" rule drops hits *after* the
					// search, and asking for exactly `factsPerTurn` would let a
					// couple of duplicates silently shrink the turn's memory.
					hits: indexes.search({
						query: event.prompt,
						kind: RECALL_KINDS,
						limit: current.loaded.settings.recall.factsPerTurn * 2,
					}),
					limit: current.loaded.settings.recall.factsPerTurn,
					tokenBudget: current.loaded.settings.recall.tokenBudget,
					contextLines,
					prompt: event.prompt,
				})
			: undefined;

		if (recall) {
			result.message = recallMessage(recall.content, recall.ids);
			for (const [id, text] of recall.texts) recalledTexts.set(id, text);
			if (state) {
				for (const id of recall.ids) {
					if (!state.recalled.includes(id)) state.recalled.push(id);
				}
			}
			// Recorded in pi's own session, so a resumed session still knows what
			// it had been told — and so `recalled:` on a later entry is complete.
			pi.appendEntry(STATE_CUSTOM_TYPE, { kind: "recalled", ids: recall.ids } satisfies StateDelta);
		}

		if (result.systemPrompt === undefined && result.message === undefined) return;
		return result;
	});

	pi.on("input", (event, ctx) => {
		const current = session;
		const currentState = state;
		if (!current || !currentState) return;

		const storePath = captureTargetPath(current);
		if (!storePath) return;

		const decision = decideCapture({
			text: event.text,
			inputSource: event.source,
			channel: channelForMode(ctx.mode),
			previousAssistantText,
			state: currentState,
			settings: current.loaded.settings,
			session: sessionPointer(ctx.sessionManager),
		});
		if (!decision) return;

		// Queued rather than awaited: an append normally takes milliseconds, but
		// under contention with another pi session it can wait seconds, and
		// stalling the user's turn to record a note about it is the wrong trade.
		queue.enqueue(`capture ${decision.kind}`, async () => {
			const result = await appendEntry(decision.entry, { storePath, hostId: current.host.id });
			afterAppend(current, currentState, storePath, result);
		});
	});

	/**
	 * Write the outcome entry for the run just finished.
	 *
	 * Shared by `agent_settled` and the pre-compaction path, because both are
	 * "the run is over as far as memory is concerned" — the only difference is
	 * that one of them happens before pi summarises the context away.
	 */
	const writeOutcome = async (
		ctx: {
			mode: string;
			model: unknown;
			modelRegistry: { complete(model: never, context: never, options?: never): Promise<unknown> };
			sessionManager: { getSessionFile(): string | undefined; getLeafId(): string | null };
		},
		buffer: ReturnType<RunAccumulator["peek"]>,
	): Promise<void> => {
		const current = session;
		const currentState = state;
		if (!current || !currentState) return;

		const storePath = captureTargetPath(current);
		if (!storePath) return;

		const skip = shouldWriteOutcome(buffer, {
			outcomesEnabled: current.loaded.settings.capture.outcomes,
			alreadyJournaled: runAlreadyJournaled,
		});
		if (skip) return;

		const model = ctx.model;
		if (!model) {
			queue.enqueue("outcome", async () => {
				throw new Error("no model available to write an outcome entry");
			});
			return;
		}

		outcomeAbort = new AbortController();
		const signal = outcomeAbort.signal;
		const outcomeModel: OutcomeModel = {
			async complete(context, abort) {
				const reply = (await ctx.modelRegistry.complete(
					model as never,
					{ systemPrompt: context.systemPrompt, messages: context.messages } as never,
					{ signal: abort } as never,
				)) as { content?: unknown };
				return extractText(reply);
			},
		};

		const result = await runOutcome({
			request:
				recalledTexts.size > 0 ? { buffer, state: currentState, recalledTexts } : { buffer, state: currentState },
			model: outcomeModel,
			channel: channelForMode(ctx.mode),
			session: sessionPointer(ctx.sessionManager),
			signal,
		});

		if (!result.ok) {
			// Not written is not the same as broken: "nothing durable was learned"
			// is a legitimate outcome the template invites.
			if (!signal.aborted) {
				process.stderr.write(`muninn: no outcome entry — ${result.problem}\n`);
			}
			return;
		}

		runAlreadyJournaled = true;
		queue.enqueue("outcome", async () => {
			const written = await appendEntry(result.entry, { storePath, hostId: current.host.id });
			afterAppend(current, currentState, storePath, written);
		});
	};

	/**
	 * Commit what has been journaled, on the queue so it lands after the appends
	 * it is committing. Debounced except at shutdown, so a chatty session leaves
	 * one commit rather than one per run.
	 */
	const commitPending = (force: boolean): void => {
		const current = session;
		if (!current) return;
		const storePath = captureTargetPath(current);
		if (!storePath) return;

		queue.enqueue("commit", async () => {
			if (uncommittedEntries === 0 && !force) return;
			const result = await commitJournal({
				storePath,
				hostId: current.host.id,
				hostName: current.host.name,
				entries: uncommittedEntries,
				force,
			});
			if (result.committed) uncommittedEntries = 0;
		});
	};

	pi.on("agent_settled", async (_event, ctx) => {
		// The run is over and pi will not continue on its own: no retry, no
		// compaction, no queued continuation.
		if (!run.isEmpty && !run.hadAuthoritativeEnd) runsWithoutAgentEnd++;
		const buffer = run.take();
		await writeOutcome(ctx as never, buffer);
		runAlreadyJournaled = false;
		commitPending(false);
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		// Write the outcome *before* the summary is produced, so nothing
		// compaction drops is lost to the journal. Returning nothing leaves pi's
		// compaction exactly as it was.
		await writeOutcome(ctx as never, run.peek());
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// An outcome call still in flight is the session ending, not a failure.
		outcomeAbort?.abort();
		// Un-debounced: this is the last chance to make the session's entries
		// durable in git before the process goes away.
		commitPending(true);
		// After the commit, so the index reflects every entry this session wrote.
		queue.enqueue("index save", async () => {
			for (const problem of indexes?.save() ?? []) process.stderr.write(`muninn: ${problem}\n`);
		});
		// Closes the window where a queued entry could be lost to process exit.
		await queue.flush();
		const failures = queue.takeFailures();
		if (failures.length === 0) return;

		const report = failures.map((failure) => `  ! ${failure.label}: ${failure.message}`);
		process.stderr.write(`${["muninn: capture failed", ...report].join("\n")}\n`);
		ctx.ui.notify(`muninn: ${failures.length} journal write(s) failed`, "error");
	});
}

/**
 * The custom message recalled memories ride in.
 *
 * `details.ids` is not decoration: the run accumulator reads it to fill
 * `recalled:` on the entry this run produces, and strips the message itself
 * from what the outcome model sees.
 */
function recallMessage(content: string, ids: string[]): NonNullable<BeforeAgentStartEventResult["message"]> {
	return { customType: MUNINN_MESSAGE_TYPE, content, display: true, details: { ids } };
}

/** Plain text of an assistant reply, whatever block shape it arrived in. */
function extractText(reply: { content?: unknown }): string {
	if (typeof reply.content === "string") return reply.content;
	if (!Array.isArray(reply.content)) return "";
	const parts: string[] = [];
	for (const block of reply.content) {
		if (typeof block !== "object" || block === null) continue;
		const typed = block as { type?: unknown; text?: unknown };
		if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
	}
	return parts.join("");
}
