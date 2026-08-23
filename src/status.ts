/**
 * The `/muninn` status report and the footer status line.
 *
 * Pure formatting: everything it needs is passed in, so the wording is testable
 * without a pi session.
 */

import type { SettingsWarning } from "./settings.ts";
import type { LoadedSettingsWithSources, SettingsSource } from "./settings-io.ts";

export interface StatusInput {
	muninnVersion: string;
	piVersion: string;
	runtime: string;
	cwd: string;
	loaded: LoadedSettingsWithSources;
	/**
	 * Stores discovered for this session. Empty until step 2 builds them, which
	 * is why the report says "none yet" rather than pretending memory exists.
	 */
	stores: Array<{ scope: string; path: string; entries: number }>;
	/** Whether pi considers this project trusted (`ctx.isProjectTrusted()`). */
	projectTrusted: boolean;
}

function describeSource(source: SettingsSource): string {
	if (!source.present) return `${source.path} (absent)`;
	return source.hasMuninnBlock ? `${source.path} (muninn block)` : `${source.path} (no muninn block)`;
}

export function formatWarning(warning: SettingsWarning): string {
	return `  ! [${warning.scope}] ${warning.message}`;
}

/** The multi-line report printed by `/muninn` with no arguments. */
export function formatStatus(input: StatusInput): string {
	const { settings, warnings, sources } = input.loaded;
	const lines: string[] = [];

	lines.push(`⟡ muninn ${input.muninnVersion} · pi ${input.piVersion} · ${input.runtime}`);
	lines.push("");

	if (input.stores.length === 0) {
		lines.push("store     none yet — journal and recall land in step 2 of Phase 1");
	} else {
		for (const store of input.stores) {
			lines.push(`store     ${store.scope}: ${store.path} (${store.entries} entries)`);
		}
	}

	const projectScope =
		settings.scopes.project === false
			? "off"
			: `${settings.scopes.project}${input.projectTrusted ? "" : " (project not trusted)"}`;
	lines.push(`scopes    global: ${settings.scopes.global ? "on" : "off"} · project: ${projectScope}`);

	const captureKinds = [
		settings.capture.corrections ? "corrections" : null,
		settings.capture.outcomes ? "outcomes" : null,
		settings.capture.toolFacts ? "tool facts" : null,
	].filter((kind): kind is string => kind !== null);
	lines.push(`capture   ${captureKinds.length > 0 ? captureKinds.join(", ") : "nothing (all kinds disabled)"}`);

	lines.push(
		`recall    ${settings.recall.factsPerTurn} facts/turn · ${settings.recall.tokenBudget} tokens · tier ${settings.recall.indexTier}`,
	);

	lines.push(`settings  ${describeSource(sources.global)}`);
	lines.push(`          ${describeSource(sources.project)}`);

	if (warnings.length > 0) {
		lines.push("");
		lines.push(`${warnings.length} settings warning${warnings.length === 1 ? "" : "s"}:`);
		for (const warning of warnings) lines.push(formatWarning(warning));
	}

	return lines.join("\n");
}

/** The compact footer entry set through `ctx.ui.setStatus`. */
export function formatStatusLine(input: Pick<StatusInput, "loaded" | "stores">): string {
	const parts = ["⟡ muninn"];
	parts.push(input.stores.length === 0 ? "no store" : input.stores.map((store) => store.scope).join("+"));
	const warnings = input.loaded.warnings.length;
	if (warnings > 0) parts.push(`${warnings}⚠`);
	return parts.join(" · ");
}
