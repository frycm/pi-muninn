/**
 * pi-muninn extension entry point.
 *
 * Phase 1 step 10: sessions leave a journal of what the user asked to be
 * remembered, what they corrected and how each task turned out; every store
 * carries a Tier 0 index of it; recall injects the frozen `MEMORY.md` snapshot
 * and a bounded per-turn selection; and the model can now search, read and
 * write memory itself through three tools.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type BeforeAgentStartEventResult,
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import { MUNINN_MESSAGE_TYPE, messageText, RunAccumulator } from "./capture/accumulate.ts";
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
	sessionPointer,
	taskFromSessionFile,
} from "./capture/session-state.ts";
import { type CommandOutput, type CommandRuntime, type DreamOutcome, runMuninnCommand } from "./commands/muninn.ts";
import { dream } from "./dream/dream.ts";
import { forget, listDreams, matchStamp } from "./dream/dreams.ts";
import { erase, eraseImpact } from "./dream/erase.ts";
import type { DreamModel } from "./dream/model.ts";
import { latestReport, readTopics } from "./dream/orient.ts";
import { readMarker, remember, resolveConflict } from "./dream/remember.ts";

import { SessionIndexes } from "./index/search.ts";
import { type AppendResult, appendEntry } from "./journal/append.ts";
import { readStoreJournal } from "./journal/read.ts";
import {
	buildRecallMessage,
	type ContextTokens,
	contextFileLines,
	prepareContext,
	RECALL_KINDS,
} from "./recall/per-turn.ts";
import { appendSnapshot, readSnapshot, type Snapshot } from "./recall/snapshot.ts";
import { buildSessionContext, journalStats, type SessionContext } from "./session.ts";
import { type DreamStats, formatStatus, formatStatusLine, formatWarning } from "./status.ts";
import { storeIdentity } from "./store/init.ts";
import { projectStoreSlug } from "./store/paths.ts";
import type { CaptureTarget } from "./store/scopes.ts";
import { parseStoreMd } from "./store/store-md.ts";
import { describeSync, type SyncResult, sync } from "./sync/sync.ts";
import { memoryNoteTool } from "./tools/memory-note.ts";
import { memoryReadTool } from "./tools/memory-read.ts";
import { memorySearchTool } from "./tools/memory-search.ts";
import type { ToolRuntime } from "./tools/runtime.ts";
import { activeRules, parseRules } from "./topics/rules.ts";
import { MUNINN_VERSION } from "./version.ts";

/** How long a shutdown will wait for sync before giving up on the network. */
const SHUTDOWN_SYNC_MS = 10_000;
/** How long a session change will wait for an outcome entry already being written. */
const OUTCOME_GRACE_MS = 15_000;
/**
 * Lock budget for a write nobody is waiting on.
 *
 * A queued capture or outcome append contends with syncs — this session's and
 * other processes' — that hold the lock for the length of a fetch and a push.
 * The default 5 s is the right budget for a tool call with a model waiting;
 * a background write can afford to wait out a sync rather than lose the entry.
 */
const BACKGROUND_LOCK_TIMEOUT_MS = 60_000;

function describeRuntime(): string {
	const bunVersion = (globalThis as { Bun?: { version: string } }).Bun?.version;
	if (bunVersion) return `bun ${bunVersion}`;
	return `node ${process.versions.node}`;
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
	/** Aborts an outcome call when the process is going away mid-flight. */
	let outcomeAbort: AbortController | undefined;
	/** The outcome call in progress, so a session change can wait for it rather than drop it. */
	let outcomeInFlight: Promise<void> | undefined;
	/**
	 * Runs that settled without pi's authoritative `agent_end` payload, and so
	 * were assembled from `turn_end` alone. Reported by `/muninn`; if this stays
	 * at zero across real use, core change #2 is an ergonomics ask rather than a
	 * gap worth proposing.
	 */
	let runsWithoutAgentEnd = 0;
	/**
	 * Entries appended and not yet committed, per store.
	 *
	 * Per store, because a session writes to more than one: capture goes to
	 * the capture target, but `/muninn note --global`, `promote` and a
	 * `memory_note` with a scope all go elsewhere, and a commit of one store
	 * must not zero the count of another.
	 */
	const pending = new Map<string, number>();
	const pendingTotal = (): number => [...pending.values()].reduce((total, count) => total + count, 0);
	/** One Tier 0 index per active scope, opened once and kept for the session. */
	let indexes: SessionIndexes | undefined;
	/**
	 * The frozen `MEMORY.md` snapshot: read once, injected byte-identically on
	 * every turn. Re-reading the file mid-session would break the provider's
	 * prompt cache and leave the model's context disagreeing with itself.
	 */
	let snapshot: Snapshot | undefined;
	/** What pi already loaded into the prompt, tokenised once, so recall does not repeat it. */
	let context: ContextTokens | undefined;
	/** Texts of what was recalled this session, by id — the input to echo detection. */
	const recalledTexts = new Map<string, string>();
	/** What sync did this session, for the status report's "last sync" line. */
	let lastSync: string | undefined;
	/**
	 * The footer writer, captured from the last event that carried a context.
	 *
	 * Kept rather than passed because the footer's most useful number — entries
	 * written and not yet committed — changes on the append queue, where there
	 * is no pi context to hand.
	 */
	let setStatus: ((text: string) => void) | undefined;

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

	/** Redraw the footer: capture target, tier, uncommitted entries, warnings. */
	const refreshStatus = (): void => {
		const current = session;
		if (!current || !setStatus) return;
		try {
			setStatus(formatStatusLine(current, { tier: "t0", uncommitted: pendingTotal() }));
		} catch {
			// A context captured before a fork or a reload is invalidated by pi.
			// The next event replaces it; a stale footer is not worth an error.
		}
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
		pending.set(storePath, (pending.get(storePath) ?? 0) + 1);
		refreshStatus();
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
			// A resumed session already knows *which* memories it was shown — the
			// ids are in pi's session file — but echo detection needs their text,
			// which only the index has. Without this, a claim restating something
			// recalled before the resume is journaled as fresh evidence.
			for (const id of state?.recalled ?? []) {
				if (recalledTexts.has(id)) continue;
				const found = opened.indexes.find(id);
				if (found) recalledTexts.set(id, found.chunk.body);
			}
		});
	};

	/**
	 * What the three tools are allowed to know about this session.
	 *
	 * They get accessors rather than values because a session is rebuilt on
	 * `session_start` and the tools are registered once, at load.
	 */
	const toolRuntime: ToolRuntime = {
		settle: () => queue.flush(),
		session: () => session,
		indexes: () => indexes,
		state: () => state,
		async append(scope, entry) {
			const current = session;
			const currentState = state;
			if (!current) throw new Error("muninn: memory is not available in this session yet");
			const storePath = current.scopes.active.find((active) => active.scope === scope)?.path;
			if (!storePath) throw new Error(`muninn: the ${scope} store is not active in this session`);

			// Awaited, not queued: the model asked for this write and is entitled
			// to be told whether it happened. A failure here fails the tool call.
			const written = await appendEntry(entry, { storePath, hostId: current.host.id });
			if (currentState) afterAppend(current, currentState, storePath, written);
			// Committed before the model moves on — un-debounced and awaited, so a
			// crash mid-session cannot lose what it was explicitly asked to
			// remember. A note is rare enough that the commit's cost is nothing.
			commitPending(true);
			await queue.flush();
			return written;
		},
	};

	pi.registerTool(memorySearchTool(toolRuntime));
	pi.registerTool(memoryReadTool(toolRuntime));
	pi.registerTool(memoryNoteTool(toolRuntime));

	/**
	 * The `/muninn` report, assembled from what only this file knows: versions,
	 * counters, and the objects the session is holding open.
	 */
	/**
	 * What `/muninn` says about dreaming.
	 *
	 * Computed at session start rather than on demand: it reads the store's
	 * branches and its newest report, and `/muninn` should not cost a handful of
	 * subprocesses every time somebody types it.
	 */
	let dreamStats: DreamStats | undefined;

	const readDreamStats = async (current: SessionContext): Promise<DreamStats | undefined> => {
		const target = current.scopes.active.find((scope) => scope.scope === current.scopes.captureTarget);
		if (!target?.exists) return undefined;
		try {
			const listed = await listDreams(target.path);
			const pending = listed.filter((entry) => !entry.remembered);
			const previous = latestReport(target.path);
			const through = previous?.journalThrough ?? {};
			const since = readStoreJournal(target.path).entries.filter((entry) => {
				const last = through[entry.host];
				return last === undefined || entry.id > last;
			}).length;
			return {
				sinceLastDream: since,
				...(previous ? { last: previous.stamp } : {}),
				pending: pending.length,
				blocking: pending[0]?.report?.lint.filter((finding) => finding.blocking).length ?? 0,
				interrupted: readMarker(target.path) !== undefined,
				model: current.loaded.settings.dream.model,
			};
		} catch {
			return undefined;
		}
	};

	const statusReport = (current: SessionContext): string => {
		const indexStats = indexes?.scopes.map((scoped) => ({
			scope: scoped.scope,
			chunks: scoped.index.size,
			files: scoped.index.files,
		}));
		return formatStatus({
			muninnVersion: MUNINN_VERSION,
			piVersion: PI_VERSION,
			runtime: describeRuntime(),
			session: current,
			journal: journalStats(current),
			captureFailures: queue.peekFailures().map((failure) => `${failure.label}: ${failure.message}`),
			runsWithoutAgentEnd,
			uncommitted: pendingTotal(),
			sync: { remote: current.loaded.settings.sync.remote, ...(lastSync ? { last: lastSync } : {}) },
			...(dreamStats ? { dream: dreamStats } : {}),
			...(indexStats ? { index: indexStats } : {}),
			recall: {
				snapshotLines: snapshot?.lines ?? 0,
				snapshotTrimmed: snapshot?.scopes.reduce((total, scope) => total + scope.dropped, 0) ?? 0,
				recalled: state?.recalled.length ?? 0,
			},
		});
	};

	/**
	 * What a dream needs from pi's context.
	 *
	 * Declared structurally, as `writeOutcome` does, so the parts of this module
	 * that could be tested without pi are not typed against it.
	 */
	interface DreamContext {
		cwd: string;
		model?: unknown;
		modelRegistry: { complete(model: never, context: never, options: never): Promise<unknown> };
		isProjectTrusted(): boolean;
	}

	/**
	 * The store path for a scope, creating it if this session would.
	 *
	 * A dream needs a store on disk; `/muninn dreams` on a project whose store
	 * has not been created yet should say "no dreams" rather than create one, so
	 * this does not create and the caller that needs one loads with stores.
	 */
	const storeFor = async (ctx: { cwd: string; isProjectTrusted(): boolean }, scope: CaptureTarget): Promise<string> => {
		const current = await load(ctx.cwd, ctx.isProjectTrusted(), false);
		return current.scopes.active.find((candidate) => candidate.scope === scope)?.path ?? "";
	};

	/**
	 * Run a dream from inside a session.
	 *
	 * `dream.model` selects the dreamer, falling back to the session's own model
	 * — the design's point is that the two are configured separately, and a
	 * session that has a model at hand is the one case where falling back is
	 * better than refusing.
	 */
	const runDream = async (
		ctx: DreamContext,
		options: { scope?: CaptureTarget; progress: (phase: string) => void },
	): Promise<DreamOutcome> => {
		const current = await load(ctx.cwd, ctx.isProjectTrusted(), true);
		const wanted = options.scope ?? current.scopes.captureTarget;
		const active = current.scopes.active.find((candidate) => candidate.scope === wanted);
		if (!active) throw new Error(`muninn: no ${wanted ?? "active"} store here`);

		const model = sessionDreamModel(ctx, current.loaded.settings.dream.model);
		// A session has a model at hand, so falling back to it is better than
		// refusing — but never silently. The design's point is that the dreamer
		// runs locally and offline while the session talks to whatever it likes,
		// and a dream that quietly sent the whole store to a frontier API because
		// one setting was unset is exactly the surprise this says out loud.
		if (model !== undefined && current.loaded.settings.dream.model === null) {
			process.stderr.write(
				"muninn: dream.model is not set, so this dream uses the session's own model. " +
					"Set muninn.dream.model to dream against a local endpoint.\n",
			);
		}
		const globalRules =
			active.scope === "project" ? readIfPresent(current.scopes.active, "global", "rules.md") : undefined;

		const result = await dream({
			scope: active,
			agentDir: getAgentDir(),
			host: current.host,
			// The store's own id, not a fresh one: a new uuid per dream gives
			// every dream its own worktree parent directory, and the collector
			// works through `worktree list` and never reclaims the empty shells.
			storeId: storeIdOf(active.path),

			settings: current.loaded.settings,
			now: new Date(),
			progress: options.progress,
			...(model ? { model } : {}),
			...(globalRules !== undefined ? { globalRules } : {}),
		});
		// The dream wrote on a branch, but it also committed this host's pending
		// journal, so the session's index is behind by whatever it committed.
		if (result.ok) openIndexes(current, false);
		return {
			ok: result.ok,
			stamp: result.stamp,
			branch: result.branch,
			report: result.report,
			problems: result.problems,
		};
	};

	/** A `DreamModel` over the session's own model registry. */
	const sessionDreamModel = (ctx: DreamContext, ref: string | null): DreamModel | undefined => {
		const model = ctx.model;
		if (!model) return undefined;
		return {
			// The report records what actually ran, which is the session's model
			// whenever `dream.model` is unset.
			id: ref ?? "session model",
			async complete(request, signal) {
				const reply = (await ctx.modelRegistry.complete(
					model as never,
					{
						systemPrompt: request.systemPrompt,
						messages: [{ role: "user", content: request.prompt }],
					} as never,
					{ signal } as never,
				)) as { content?: unknown };
				return messageText(reply as never);
			},
		};
	};

	/** A store's id, for keying its worktrees. Falls back to a path hash. */
	const storeIdOf = (path: string): string => {
		try {
			return parseStoreMd(readFileSync(join(path, "store.md"), "utf-8")).store?.store ?? projectStoreSlug(path);
		} catch {
			return projectStoreSlug(path);
		}
	};

	const readIfPresent = (
		scopes: readonly { scope: CaptureTarget; path: string }[],
		scope: CaptureTarget,
		name: string,
	): string | undefined => {
		const path = scopes.find((candidate) => candidate.scope === scope)?.path;
		if (path === undefined) return undefined;
		try {
			return readFileSync(join(path, name), "utf-8");
		} catch {
			return undefined;
		}
	};

	pi.registerCommand("muninn", {
		description: "Muninn: status, notes, promotion, search, scopes and the index",
		handler: async (args, ctx) => {
			const commandRuntime: CommandRuntime = {
				...toolRuntime,
				load: ({ createStores }) => load(ctx.cwd, ctx.isProjectTrusted(), createStores),
				async reindex() {
					openIndexes(await load(ctx.cwd, ctx.isProjectTrusted(), true), true);
					await queue.flush();
					return indexes?.size ?? 0;
				},
				// On the queue, so it serialises with the appends this session has
				// in flight: a sync holding the store lock while a queued outcome
				// entry times out waiting for it would lose that entry for good.
				sync: async (options) => {
					let outcomes: Awaited<ReturnType<typeof runSync>> = [];
					queue.enqueue("sync", async () => {
						outcomes = await runSync(options);
					});
					await queue.flush();
					return outcomes;
				},
				statusReport,
				channel: () => channelForMode(ctx.mode),
				sessionPointer: () => sessionPointer(ctx.sessionManager),

				// A dream runs on the append queue for the same reason a sync
				// does: it takes the store lock for its whole duration, and a
				// queued entry waiting on that lock would time out and be lost.
				dream: async (options) => {
					let outcome: DreamOutcome | undefined;
					queue.enqueue("dream", async () => {
						outcome = await runDream(ctx, options);
					});
					await queue.flush();
					if (outcome === undefined) throw new Error("muninn: the dream did not run");
					return outcome;
				},
				dreams: async (scope) => listDreams(await storeFor(ctx, scope)),
				remember: async (scope, stamp) => {
					const current = await load(ctx.cwd, ctx.isProjectTrusted(), false);
					const active = current.scopes.active.find((candidate) => candidate.scope === scope);
					if (!active) return { ok: false, problems: [`no ${scope} store here`], notes: [] };
					const matched = matchStamp(await listDreams(active.path), stamp);
					const listing = matched.listing;
					if (matched.problem !== undefined || listing?.branch === undefined) {
						return { ok: false, problems: [matched.problem ?? `no pending dream ${stamp}`], notes: [] };
					}
					if (listing.report?.status === "lint-blocked") {
						// Remembering a dream whose facts cannot be traced to the
						// journal is a decision, not a flag.
						return { ok: false, problems: [`${stamp} failed lint; fix or discard it`], notes: [] };
					}
					const model = sessionDreamModel(ctx, current.loaded.settings.dream.model);
					return remember({
						scope: active,
						agentDir: getAgentDir(),
						host: current.host,
						branch: listing.branch,
						// Two dreams that rewrote the same topic are settled by a
						// merge dream, never by `git merge`. Without a model there
						// is nothing to settle it with, and the conflict is
						// reported instead of guessed at.
						...(model
							? {
									resolve: (conflict) =>
										resolveConflict(conflict, {
											scope: active,
											agentDir: getAgentDir(),
											host: current.host,
											storeId: current.host.id,
											model,
											settings: current.loaded.settings,
											now: new Date(),
										}),
								}
							: {}),
					});
				},
				forget: async (scope, stamp) => {
					const current = await load(ctx.cwd, ctx.isProjectTrusted(), false);
					const active = current.scopes.active.find((candidate) => candidate.scope === scope);
					if (!active) return { ok: false, problems: [`no ${scope} store here`], notes: [] };
					return forget({ scope: active, host: current.host, stamp, now: new Date() });
				},
				erase: async (scope, entryId, options) => {
					const current = await load(ctx.cwd, ctx.isProjectTrusted(), false);
					const active = current.scopes.active.find((candidate) => candidate.scope === scope);
					if (!active) return { ok: false, problems: [`no ${scope} store here`], notes: [] };
					const result = await erase({
						scope: active,
						host: current.host,
						entryId,
						now: new Date(),
						...(options.noRewrite ? { noRewrite: true } : {}),
						...(current.loaded.settings.sync.remote ? { remote: current.loaded.settings.sync.remote } : {}),
					});
					// The store's own text changed under the session's index.
					if (result.ok) openIndexes(current, true);
					return result;
				},
				eraseImpact: (scope, entryId) => {
					const path = session?.scopes.active.find((candidate) => candidate.scope === scope)?.path;
					return path === undefined ? { claims: [], facts: [] } : eraseImpact(path, entryId);
				},
				derived: (scope) => {
					const path = session?.scopes.active.find((candidate) => candidate.scope === scope)?.path;
					if (path === undefined) return { topics: [], rules: [] };
					const topics = [...readTopics(path).entries()].map(([slug, topic]) => ({
						slug,
						title: topic.title,
						facts: topic.facts.length + topic.external.length,
					}));
					let rules: string[] = [];
					try {
						rules = activeRules(parseRules(readFileSync(join(path, "rules.md"), "utf-8"))).map(
							(rule) => `${rule.id}${rule.phase ? ` · ${rule.phase}` : ""} — ${rule.text.split("\n")[0]?.trim() ?? ""}`,
						);
					} catch {
						rules = [];
					}
					return { topics, rules };
				},
			};

			let output: CommandOutput;
			try {
				output = await runMuninnCommand(args, commandRuntime);
			} catch (error) {
				// A command that fails says why, in the place the user is looking.
				const message = error instanceof Error ? error.message : String(error);
				output = { level: "error", text: message.startsWith("muninn:") ? message : `muninn: ${message}` };
			}

			setStatus = (text) => ctx.ui.setStatus("muninn", text);
			ctx.ui.notify(output.text, output.level);
			// `notify` is a no-op where there is no UI to notify (`--print`, json
			// mode: `core/extensions/runner.ts:92`), and a command that answers
			// nowhere is worse than one that answers in the wrong stream.
			if (!ctx.hasUI) process.stderr.write(`${output.text}\n`);
			refreshStatus();
		},
	});

	pi.on("session_start", async (event, ctx) => {
		session = undefined;
		indexes = undefined;
		snapshot = undefined;
		context = undefined;
		recalledTexts.clear();
		pending.clear();
		previousAssistantText = undefined;
		const current = await load(ctx.cwd, ctx.isProjectTrusted(), true);
		setStatus = (text) => ctx.ui.setStatus("muninn", text);
		refreshStatus();

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
		// Queued, not awaited: this reads branches and a report, and a session
		// must not wait on subprocesses before accepting a keystroke.
		queue.enqueue("dream-status", async () => {
			dreamStats = await readDreamStats(current);
			refreshStatus();
		});

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
		context ??= prepareContext([
			...contextFileLines(event.systemPromptOptions.contextFiles),
			...(snapshot ? snapshot.text.split("\n") : []),
		]);

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
					context,
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
			const result = await appendEntry(decision.entry, {
				storePath,
				hostId: current.host.id,
				lockTimeoutMs: BACKGROUND_LOCK_TIMEOUT_MS,
			});
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

		const skip = shouldWriteOutcome(buffer, { outcomesEnabled: current.loaded.settings.capture.outcomes });
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
				return messageText(reply as never);
			},
		};

		const call = runOutcome({
			request:
				recalledTexts.size > 0 ? { buffer, state: currentState, recalledTexts } : { buffer, state: currentState },
			model: outcomeModel,
			channel: channelForMode(ctx.mode),
			session: sessionPointer(ctx.sessionManager),
			signal,
		});
		outcomeInFlight = call.then(
			() => undefined,
			() => undefined,
		);
		const result = await call;
		outcomeInFlight = undefined;

		if (!result.ok) {
			// Not written is not the same as broken: "nothing durable was learned"
			// is a legitimate outcome the template invites. An abort is reported
			// too — it is the one way a finished task's outcome can be lost.
			process.stderr.write(`muninn: no outcome entry — ${signal.aborted ? "cut short by shutdown" : result.problem}\n`);
			return;
		}

		queue.enqueue("outcome", async () => {
			// A long acquire budget: nobody is waiting on this write, and a sync
			// in another process may hold the lock for the length of a push.
			const written = await appendEntry(result.entry, {
				storePath,
				hostId: current.host.id,
				lockTimeoutMs: BACKGROUND_LOCK_TIMEOUT_MS,
			});
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

		// Every store this session may have written to — not only the capture
		// target. A promoted entry lives in the global store, and a commit of the
		// project store must not leave it behind.
		for (const scope of current.scopes.active) {
			if (!scope.exists) continue;
			const storePath = scope.path;
			queue.enqueue("commit", async () => {
				const entries = pending.get(storePath) ?? 0;
				if (entries === 0 && !force) return;
				const result = await commitJournal({
					storePath,
					hostId: current.host.id,
					hostName: current.host.name,
					entries,
					force,
					...(scope.inRepo ? {} : { identity: storeIdentity(current.host) }),
				});
				if (result.committed) {
					pending.set(storePath, 0);
					refreshStatus();
				}
			});
		}
	};

	/**
	 * Sync every active store.
	 *
	 * `signal` is the shutdown deadline: it stops the transaction between steps
	 * and kills a hanging fetch or push, but never interrupts a rebase — see
	 * `git.ts` for why that distinction is load-bearing.
	 */
	const runSync = async (
		options: { noPush?: boolean; signal?: AbortSignal } = {},
	): Promise<Array<{ scope: CaptureTarget; result: SyncResult }>> => {
		const current = session;
		if (!current) return [];

		const outcomes: Array<{ scope: CaptureTarget; result: SyncResult }> = [];
		for (const scope of current.scopes.active) {
			if (!scope.exists) continue;
			const result = await sync({
				storePath: scope.path,
				hostId: current.host.id,
				hostName: current.host.name,
				// `sync.remote` is the global store's remote. A project store has
				// no setting of its own — a project file may not name one — so it
				// syncs with the `origin` it already has, and an in-repo store is
				// never pushed by Muninn at all.
				remote: scope.scope === "global" ? current.loaded.settings.sync.remote : null,
				useExistingRemote: !scope.inRepo,
				entries: pending.get(scope.path) ?? 0,
				...(scope.inRepo ? {} : { identity: storeIdentity(current.host) }),
				...(options.noPush ? { noPush: true } : {}),
				...(options.signal ? { signal: options.signal } : {}),
			});
			// Sync commits on its way out, so the footer's pending count is stale
			// the moment it succeeds.
			if (result.committed) {
				pending.set(scope.path, 0);
				refreshStatus();
			}
			// A rebase can bring another host's entries into the store while this
			// session holds its index open. Without this, `/muninn sync` followed
			// by a search misses exactly the memory the sync just fetched. A fetch
			// that rebased nothing changed no file and needs no refresh.
			if (result.rebased) indexes?.refresh(scope.path);
			outcomes.push({ scope: scope.scope, result });
			lastSync = `${scope.scope}: ${describeSync(result)}`;
		}
		return outcomes;
	};

	pi.on("agent_settled", async (_event, ctx) => {
		// The run is over and pi will not continue on its own: no retry, no
		// compaction, no queued continuation.
		if (!run.isEmpty && !run.hadAuthoritativeEnd) runsWithoutAgentEnd++;
		const buffer = run.take();
		await writeOutcome(ctx as never, buffer);
		commitPending(false);
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		// Write the outcome *before* the summary is produced, so nothing
		// compaction drops is lost to the journal, and start the run afresh:
		// what happens after the compaction is its own outcome, written at the
		// next compaction or when the run settles. Taking rather than peeking is
		// what keeps the post-compaction work from being silently discarded.
		// Returning nothing leaves pi's compaction exactly as it was.
		await writeOutcome(ctx as never, run.take());
	});

	pi.on("session_shutdown", async (event, ctx) => {
		// An outcome call still in flight is the most valuable entry of the run
		// that just finished. `/new`, `/fork`, `/resume` and `/reload` all arrive
		// here too, and none of them is a reason to lose it — so it is waited
		// for, with a cap, and aborted only when the cap runs out.
		if (outcomeInFlight) {
			const cap = new Promise<void>((resolve) => setTimeout(resolve, OUTCOME_GRACE_MS).unref?.());
			await Promise.race([outcomeInFlight, cap]);
		}
		outcomeAbort?.abort();
		if (event.reason !== "quit") {
			// The process lives on: let the aborted call's report land before
			// the queue is flushed.
			await outcomeInFlight;
		}
		// Un-debounced: this is the last chance to make the session's entries
		// durable in git before the process goes away.
		commitPending(true);
		// Sync last, and only when the operator asked for it: it is the only step
		// that reaches the network, and a shutdown must not hang on one. The cap
		// stops the transaction between steps and kills a hanging fetch or push;
		// a rebase, once started, always finishes.
		// Gated on the setting alone: a separate project store syncs with the
		// `origin` it already has, so requiring a *global* remote here would
		// silently exclude it. Each scope decides for itself whether it has
		// anywhere to push.
		if (session?.loaded.settings.sync.onShutdown) {
			queue.enqueue("sync", async () => {
				const deadline = new AbortController();
				const timer = setTimeout(() => deadline.abort(), SHUTDOWN_SYNC_MS);
				try {
					for (const { scope, result } of await runSync({ signal: deadline.signal })) {
						if (!result.problem) continue;
						// Offline is a normal end to a laptop's day: the journal is
						// committed and the next sync carries it. Anything else is a
						// failure the operator has to know about.
						const line = `muninn: ${scope} ${describeSync(result)}`;
						process.stderr.write(`${line}\n`);
						if (!result.offline) ctx.ui.notify(line, "warning");
					}
				} finally {
					clearTimeout(timer);
				}
			});
		}

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
