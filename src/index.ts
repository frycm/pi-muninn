/**
 * pi-muninn extension entry point.
 *
 * Phase 1 step 5: sessions now leave a journal. Explicit requests to remember
 * and corrections of the agent are captured as they happen; outcome entries and
 * recall arrive in steps 6 and 9.
 */
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import { decideCapture } from "./capture/capture.ts";
import { channelForMode } from "./capture/cues.ts";
import { AppendQueue } from "./capture/queue.ts";
import {
	assistantText,
	type MuninnSessionState,
	rebuildState,
	STATE_CUSTOM_TYPE,
	type StateDelta,
	taskFromSessionFile,
} from "./capture/session-state.ts";
import { appendEntry } from "./journal/append.ts";
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

	pi.registerCommand("muninn", {
		description: "Muninn status, scopes and settings",
		handler: async (args, ctx) => {
			const sub = args.trim() || "status";
			// `scope` explains the situation and must not change it, so it never
			// creates a store.
			const current = await load(ctx.cwd, ctx.isProjectTrusted(), sub !== "scope");

			if (sub === "status") {
				// Counts would otherwise miss an entry still in the queue.
				await queue.flush();
				ctx.ui.notify(
					formatStatus({
						muninnVersion: MUNINN_VERSION,
						piVersion: PI_VERSION,
						runtime: describeRuntime(),
						session: current,
						journal: journalStats(current),
						captureFailures: queue.peekFailures().map((failure) => `${failure.label}: ${failure.message}`),
					}),
					"info",
				);
				return;
			}
			if (sub === "scope") {
				ctx.ui.notify(formatScopes(current), "info");
				return;
			}
			// Every other subcommand named in the design lands in a later step; say
			// so rather than failing as if it were a typo.
			ctx.ui.notify(`"/muninn ${sub}" is not implemented yet (try: status, scope)`, "warning");
		},
	});

	pi.on("session_start", async (event, ctx) => {
		session = undefined;
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
			currentState.written.push(result.id);
			pi.appendEntry(STATE_CUSTOM_TYPE, { kind: "written", ids: [result.id] } satisfies StateDelta);
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Closes the window where a queued entry could be lost to process exit.
		await queue.flush();
		const failures = queue.takeFailures();
		if (failures.length === 0) return;

		const report = failures.map((failure) => `  ! ${failure.label}: ${failure.message}`);
		process.stderr.write(`${["muninn: capture failed", ...report].join("\n")}\n`);
		ctx.ui.notify(`muninn: ${failures.length} journal write(s) failed`, "error");
	});
}
