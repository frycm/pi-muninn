/**
 * pi-muninn extension entry point.
 *
 * Phase 1 step 2: settings, host identity, stores, the store lock, and the
 * status commands. Muninn now creates a store and registers this host in it,
 * but still journals nothing — capture lands in steps 3-6.
 */
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import { buildSessionContext, journalStats, type SessionContext } from "./session.ts";
import { formatScopes, formatStatus, formatStatusLine, formatWarning } from "./status.ts";
import { MUNINN_VERSION } from "./version.ts";

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

	pi.registerCommand("muninn", {
		description: "Muninn status, scopes and settings",
		handler: async (args, ctx) => {
			const sub = args.trim() || "status";
			// `scope` explains the situation and must not change it, so it never
			// creates a store.
			const current = await load(ctx.cwd, ctx.isProjectTrusted(), sub !== "scope");

			if (sub === "status") {
				ctx.ui.notify(
					formatStatus({
						muninnVersion: MUNINN_VERSION,
						piVersion: PI_VERSION,
						runtime: describeRuntime(),
						session: current,
						journal: journalStats(current),
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

	pi.on("session_start", async (_event, ctx) => {
		session = undefined;
		const current = await load(ctx.cwd, ctx.isProjectTrusted(), true);
		ctx.ui.setStatus("muninn", formatStatusLine(current));

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
}
