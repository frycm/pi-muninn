/**
 * pi-muninn extension entry point.
 *
 * Sessions append user-directed notes and task outcomes to one logical-project
 * JSONL journal. Humans, Unix tools, and model-facing tools all read the same
 * canonical records.
 */

import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import { messageText, RunAccumulator } from "./capture/accumulate.ts";
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
import { type CommandOutput, type CommandRuntime, runMuninnCommand } from "./commands/muninn.ts";
import { collectIntegrationEntries, integrationObservationRecord } from "./integrations/protocol.ts";
import type { AppendJournalResult } from "./journal/jsonl.ts";
import { collectGitProvenance } from "./journal/provenance.ts";
import { JournalQueryService } from "./journal/query.ts";
import type { JournalRelationType, JournalSessionPointer, NewJournalRecord } from "./journal/record.ts";
import { appendAuthorizedJournalRecord, appendIntegrationObservation, appendUserRelation } from "./journal/writer.ts";
import { buildSessionContext, journalStats, type SessionContext } from "./session.ts";
import { formatStatus, formatStatusLine, formatWarning } from "./status.ts";
import { storeIdentity } from "./store/init.ts";
import { readProjectManifest } from "./store/project-manifest.ts";
import { describeSync, type SyncResult, sync } from "./sync/sync.ts";
import { projectTeamRoster, renderTeamRoster } from "./team/lifecycle.ts";
import { journalContextTool } from "./tools/journal-context.ts";
import { journalNoteTool } from "./tools/journal-note.ts";
import { journalReadTool } from "./tools/journal-read.ts";
import type { JournalToolRuntime } from "./tools/journal-runtime.ts";
import { journalSearchTool } from "./tools/journal-search.ts";
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

function journalSessionPointer(pointer: string | undefined): JournalSessionPointer | undefined {
	if (!pointer) return undefined;
	const hash = pointer.lastIndexOf("#");
	if (hash === -1) return { file: pointer };
	const last = pointer.slice(hash + 1);
	return { file: pointer.slice(0, hash), ...(last ? { last } : {}) };
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
	/** Session custom entries already scheduled for idempotent integration ingest. */
	const handledIntegrationEntries = new Set<string>();
	const reportedIntegrationProblems = new Set<string>();
	/** Entries appended and not yet committed to the active project store. */
	const pending = new Map<string, number>();
	const pendingTotal = (): number => [...pending.values()].reduce((total, count) => total + count, 0);
	/** Phase 3 canonical query service for the active logical project. */
	let journal: JournalQueryService | undefined;
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

	/** Redraw the footer: project journal, uncommitted entries, warnings. */
	const refreshStatus = (): void => {
		const current = session;
		if (!current || !setStatus) return;
		try {
			setStatus(formatStatusLine(current, { uncommitted: pendingTotal() }));
		} catch {
			// A context captured before a fork or a reload is invalidated by pi.
			// The next event replaces it; a stale footer is not worth an error.
		}
	};

	const captureTargetPath = (current: SessionContext): string | undefined =>
		current.scopes.active.find((scope) => scope.scope === current.scopes.captureTarget)?.path;

	const afterJournalAppend = (
		currentState: MuninnSessionState,
		storePath: string,
		written: AppendJournalResult,
	): void => {
		currentState.written.push(written.id);
		pending.set(storePath, (pending.get(storePath) ?? 0) + 1);
		journal?.add(written.record);
		refreshStatus();
		pi.appendEntry(STATE_CUSTOM_TYPE, { kind: "written", ids: [written.id] } satisfies StateDelta);
	};

	const queryJournal = (): JournalQueryService => {
		const current = session;
		if (!current?.project) throw new Error("muninn: no logical project journal is active in this session");
		journal ??= new JournalQueryService({
			storePath: current.project.storePath,
			localMember: current.project.member.id,
			agentDir: getAgentDir(),
			mode: "index",
			maxChars: 16_000,
			transcriptRoots: [join(getAgentDir(), "sessions")],
		});
		return journal;
	};

	const enqueueSessionIntegrations = (ctx: {
		cwd: string;
		sessionManager: {
			getBranch(): ReadonlyArray<{ id?: string; type?: string; customType?: string; data?: unknown }>;
			getSessionFile(): string | undefined;
			getLeafId(): string | null;
		};
	}): void => {
		const current = session;
		const currentState = state;
		if (!current?.project || !currentState) return;
		const project = current.project;
		const storePath = captureTargetPath(current);
		if (!storePath) return;
		const collected = collectIntegrationEntries(ctx.sessionManager.getBranch());
		for (const problem of collected.problems) {
			if (reportedIntegrationProblems.has(problem)) continue;
			reportedIntegrationProblems.add(problem);
			process.stderr.write(`${problem}\n`);
		}
		for (const { key, observation } of collected.observations) {
			if (handledIntegrationEntries.has(key)) continue;
			handledIntegrationEntries.add(key);
			queue.enqueue(`integration ${observation.integration.provider}`, async () => {
				const git = await collectGitProvenance(ctx.cwd);
				const pointer = journalSessionPointer(sessionPointer(ctx.sessionManager));
				const record: NewJournalRecord = {
					...integrationObservationRecord(observation),
					task: currentState.task,
					...(currentState.continues ? { continues: currentState.continues } : {}),
					...(pointer ? { session: pointer } : {}),
					...(git ? { git } : {}),
				};
				const written = await appendIntegrationObservation(record, {
					storePath,
					project: project.id,
					member: project.member.id,
					host: current.host.id,
					lockTimeoutMs: BACKGROUND_LOCK_TIMEOUT_MS,
				});
				if (!written.replayed) afterJournalAppend(currentState, storePath, written);
			});
		}
	};

	const journalRuntime: JournalToolRuntime = {
		settle: () => queue.flush(),
		session: () => session,
		state: () => state,
		query: queryJournal,
		async append(record, context) {
			const current = session;
			const currentState = state;
			if (!current?.project) throw new Error("muninn: no logical project journal is active in this session");
			const projectScope = current.scopes.active.find((scope) => scope.scope === "project");
			if (!projectScope) throw new Error("muninn: the project journal is not active in this session");

			const provenance = await collectGitProvenance(context.cwd ?? current.project.root);
			const pointer = journalSessionPointer(sessionPointer(context.sessionManager));
			const deterministic: NewJournalRecord = {
				...record,
				channel: channelForMode(context.mode),
				...(pointer ? { session: pointer } : {}),
				...(provenance ? { git: provenance } : {}),
			};
			const written = await appendAuthorizedJournalRecord(
				{ authority: "model", record: deterministic },
				{
					storePath: projectScope.path,
					project: current.project.id,
					member: current.project.member.id,
					host: current.host.id,
				},
			);
			if (currentState) afterJournalAppend(currentState, projectScope.path, written);
			commitPending(true);
			await queue.flush();
			return written;
		},
	};

	pi.registerTool(journalSearchTool(journalRuntime));
	pi.registerTool(journalReadTool(journalRuntime));
	pi.registerTool(journalContextTool(journalRuntime));
	pi.registerTool(journalNoteTool(journalRuntime));

	/**
	 * The `/muninn` report, assembled from what only this file knows: versions,
	 * counters, and the objects the session is holding open.
	 */
	const statusReport = (current: SessionContext): string => {
		const remote = current.project ? (readProjectManifest(current.project.storePath)?.remote ?? null) : null;
		return formatStatus({
			muninnVersion: MUNINN_VERSION,
			piVersion: PI_VERSION,
			runtime: describeRuntime(),
			session: current,
			journal: journalStats(current),
			captureFailures: queue.peekFailures().map((failure) => `${failure.label}: ${failure.message}`),
			runsWithoutAgentEnd,
			uncommitted: pendingTotal(),
			sync: { remote, ...(lastSync ? { last: lastSync } : {}) },
		});
	};

	const teamReport = (current: SessionContext): string => {
		if (!current.project) return "muninn: no logical project is linked for this session";
		const manifest = readProjectManifest(current.project.storePath);
		if (!manifest) return "muninn: project journal has no project.json";
		return renderTeamRoster(projectTeamRoster(manifest, current.project.member.id, current.host.id)).join("\n");
	};

	pi.registerCommand("muninn", {
		description: "Muninn: search, inspect and correct this project journal",
		handler: async (args, ctx) => {
			const appendAttended = async (record: NewJournalRecord): Promise<AppendJournalResult> => {
				const current = await load(ctx.cwd, ctx.isProjectTrusted(), true);
				const currentState = state;
				if (!current.project) throw new Error("muninn: no logical project journal is active in this session");
				const projectScope = current.scopes.active.find((scope) => scope.scope === "project");
				if (!projectScope) throw new Error("muninn: the project journal is not active in this session");
				const pointer = journalSessionPointer(sessionPointer(ctx.sessionManager));
				const git = await collectGitProvenance(ctx.cwd);
				const written = await appendAuthorizedJournalRecord(
					{
						authority: "attended-user",
						record: {
							...record,
							channel: channelForMode(ctx.mode),
							...(pointer ? { session: pointer } : {}),
							...(git ? { git } : {}),
						},
					},
					{
						storePath: projectScope.path,
						project: current.project.id,
						member: current.project.member.id,
						host: current.host.id,
					},
				);
				if (currentState) afterJournalAppend(currentState, projectScope.path, written);
				commitPending(true);
				await queue.flush();
				return written;
			};

			const appendAttendedRelation = async (
				target: string,
				text: string,
				relation: JournalRelationType,
			): Promise<AppendJournalResult> => {
				const current = await load(ctx.cwd, ctx.isProjectTrusted(), true);
				const currentState = state;
				if (!current.project) throw new Error("muninn: no logical project journal is active in this session");
				const projectScope = current.scopes.active.find((scope) => scope.scope === "project");
				if (!projectScope) throw new Error("muninn: the project journal is not active in this session");
				const pointer = journalSessionPointer(sessionPointer(ctx.sessionManager));
				const git = await collectGitProvenance(ctx.cwd);
				const written = await appendUserRelation({
					authority: "attended-user",
					target,
					text,
					relation,
					channel: channelForMode(ctx.mode),
					storePath: projectScope.path,
					project: current.project.id,
					member: current.project.member.id,
					host: current.host.id,
					...(currentState ? { task: currentState.task } : {}),
					...(currentState?.continues ? { continues: currentState.continues } : {}),
					...(pointer ? { session: pointer } : {}),
					...(git ? { git } : {}),
				});
				if (currentState) afterJournalAppend(currentState, projectScope.path, written);
				commitPending(true);
				await queue.flush();
				return written;
			};

			const commandRuntime: CommandRuntime = {
				load: ({ createStores }) => load(ctx.cwd, ctx.isProjectTrusted(), createStores),
				settle: () => queue.flush(),
				query: queryJournal,
				state: () => state,
				appendUser: appendAttended,
				appendRelation: appendAttendedRelation,
				async reindex() {
					await load(ctx.cwd, ctx.isProjectTrusted(), true);
					const service = queryJournal();
					service.refresh(true);
					return service.size;
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
				teamReport,
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
		journal = undefined;
		pending.clear();
		handledIntegrationEntries.clear();
		reportedIntegrationProblems.clear();
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

		// A misread setting or an unusable store means Muninn is not behaving the
		// way the files say it should. That is exactly the class of failure this
		// project refuses to let pass quietly, so it goes to stderr as well as the
		// footer — stderr is visible in --print and RPC modes, where no footer is
		// attached.
		const trouble = [...current.loaded.warnings.map(formatWarning), ...current.problems.map((p) => `  ! ${p}`)];
		if (trouble.length > 0) {
			process.stderr.write(`${[`muninn: ${trouble.length} problem(s)`, ...trouble].join("\n")}\n`);
		}
		enqueueSessionIntegrations(ctx as never);
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

	pi.on("input", (event, ctx) => {
		const current = session;
		const currentState = state;
		if (!current?.project || !currentState) return;
		const projectIdentity = current.project;

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
			const git = await collectGitProvenance(ctx.cwd);
			const result = await appendAuthorizedJournalRecord(
				{ authority: "attended-user", record: { ...decision.entry, ...(git ? { git } : {}) } },
				{
					storePath,
					project: projectIdentity.id,
					member: projectIdentity.member.id,
					host: current.host.id,
					lockTimeoutMs: BACKGROUND_LOCK_TIMEOUT_MS,
				},
			);
			afterJournalAppend(currentState, storePath, result);
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
			cwd: string;
			mode: string;
			model: unknown;
			modelRegistry: { complete(model: never, context: never, options?: never): Promise<unknown> };
			sessionManager: { getSessionFile(): string | undefined; getLeafId(): string | null };
		},
		buffer: ReturnType<RunAccumulator["peek"]>,
	): Promise<void> => {
		const current = session;
		const currentState = state;
		if (!current?.project || !currentState) return;
		const projectIdentity = current.project;

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
			request: { buffer, state: currentState },
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
			const git = await collectGitProvenance(ctx.cwd);
			const written = await appendAuthorizedJournalRecord(
				{ authority: "automatic", record: { ...result.entry, ...(git ? { git } : {}) } },
				{
					storePath,
					project: projectIdentity.id,
					member: projectIdentity.member.id,
					host: current.host.id,
					lockTimeoutMs: BACKGROUND_LOCK_TIMEOUT_MS,
				},
			);
			afterJournalAppend(currentState, storePath, written);
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

		// Phase 3 has exactly one canonical project store per session.
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
					identity: storeIdentity(current.host),
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
	): Promise<Array<{ scope: "project"; result: SyncResult }>> => {
		const current = session;
		if (!current) return [];

		const outcomes: Array<{ scope: "project"; result: SyncResult }> = [];
		for (const scope of current.scopes.active) {
			if (!scope.exists) continue;
			const result = await sync({
				storePath: scope.path,
				hostId: current.host.id,
				hostName: current.host.name,
				remote: readProjectManifest(scope.path)?.remote ?? null,
				entries: pending.get(scope.path) ?? 0,
				identity: storeIdentity(current.host),
				...(options.noPush ? { noPush: true } : {}),
				...(options.signal ? { signal: options.signal } : {}),
			});
			// Sync commits on its way out, so the footer's pending count is stale
			// the moment it succeeds.
			if (result.committed) {
				pending.set(scope.path, 0);
				refreshStatus();
			}
			// Refresh the canonical query projection after fetched records land.
			if (result.rebased) {
				journal?.refresh();
			}
			outcomes.push({ scope: scope.scope, result });
			lastSync = `${scope.scope}: ${describeSync(result)}`;
		}
		return outcomes;
	};

	pi.on("agent_settled", async (_event, ctx) => {
		// The run is over and pi will not continue on its own: no retry, no
		// compaction, no queued continuation.
		if (!run.isEmpty && !run.hadAuthoritativeEnd) runsWithoutAgentEnd++;
		enqueueSessionIntegrations(ctx as never);
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
		enqueueSessionIntegrations(ctx as never);
		await writeOutcome(ctx as never, run.take());
	});

	pi.on("session_shutdown", async (event, ctx) => {
		enqueueSessionIntegrations(ctx as never);
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
		// The setting controls timing; the explicit project manifest remote
		// decides whether there is network work to do.
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

		// Closes the window where a queued entry could be lost to process exit.
		await queue.flush();
		const failures = queue.takeFailures();
		if (failures.length === 0) return;

		const report = failures.map((failure) => `  ! ${failure.label}: ${failure.message}`);
		process.stderr.write(`${["muninn: capture failed", ...report].join("\n")}\n`);
		ctx.ui.notify(`muninn: ${failures.length} journal write(s) failed`, "error");
	});
}
