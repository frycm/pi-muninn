/**
 * pi-muninn extension entry point.
 *
 * Phase 1 step 1: settings and status only. Nothing here captures, indexes or
 * writes anything — loading this extension changes what pi *reports*, not what
 * it does. Journal, recall and the tools arrive in the following steps.
 */
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import { type LoadedSettingsWithSources, loadSettings } from "./settings-io.ts";
import { formatStatus, formatStatusLine, formatWarning } from "./status.ts";
import { MUNINN_VERSION } from "./version.ts";

function describeRuntime(): string {
	const bunVersion = (globalThis as { Bun?: { version: string } }).Bun?.version;
	if (bunVersion) return `bun ${bunVersion}`;
	return `node ${process.versions.node}`;
}

export default function (pi: ExtensionAPI): void {
	// Settings are resolved per session rather than once at load: the project
	// settings file depends on cwd, and a session can start in a different
	// directory than the one the extension was loaded from.
	let loaded: LoadedSettingsWithSources | undefined;

	const resolve = (cwd: string): LoadedSettingsWithSources => {
		loaded ??= loadSettings({ agentDir: getAgentDir(), cwd, configDirName: CONFIG_DIR_NAME });
		return loaded;
	};

	pi.registerCommand("muninn", {
		description: "Muninn status and settings",
		handler: async (args, ctx) => {
			const sub = args.trim() || "status";
			if (sub !== "status") {
				// Every other subcommand named in the design lands in a later step;
				// say so rather than failing as if it were a typo.
				ctx.ui.notify(`"/muninn ${sub}" is not implemented yet (try: status)`, "warning");
				return;
			}
			ctx.ui.notify(
				formatStatus({
					muninnVersion: MUNINN_VERSION,
					piVersion: PI_VERSION,
					runtime: describeRuntime(),
					cwd: ctx.cwd,
					loaded: resolve(ctx.cwd),
					stores: [],
					projectTrusted: ctx.isProjectTrusted(),
				}),
				"info",
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		loaded = undefined;
		const current = resolve(ctx.cwd);
		ctx.ui.setStatus("muninn", formatStatusLine({ loaded: current, stores: [] }));

		// A misread setting means Muninn is not behaving the way the file says it
		// should. That is exactly the class of failure this project refuses to let
		// pass quietly, so it goes to stderr as well as the footer — stderr is
		// visible in --print and RPC modes, where no footer is attached.
		if (current.warnings.length > 0) {
			const report = [`muninn: ${current.warnings.length} settings warning(s)`]
				.concat(current.warnings.map(formatWarning))
				.join("\n");
			process.stderr.write(`${report}\n`);
		}
	});
}
