/**
 * The `/muninn` status report, `/muninn scope`, and the footer status line.
 *
 * Pure formatting: everything it needs is passed in, so the wording is testable
 * without a pi session.
 */

import type { ScopeJournalStats, SessionContext } from "./session.ts";
import type { SettingsWarning } from "./settings.ts";
import type { SettingsSource } from "./settings-io.ts";

export interface StatusInput {
	muninnVersion: string;
	piVersion: string;
	runtime: string;
	session: SessionContext;
	/** Per-scope journal counts. Computed on demand, so absent means "not asked for". */
	journal?: ScopeJournalStats[];
	/** Journal writes that failed this session. Silence here would be the worst outcome. */
	captureFailures?: string[];
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
	const { loaded, scopes, host, problems } = input.session;
	const { settings, warnings, sources } = loaded;
	const lines: string[] = [];

	lines.push(`⟡ muninn ${input.muninnVersion} · pi ${input.piVersion} · ${input.runtime}`);
	lines.push("");
	lines.push(`host      ${host.name} · ${host.id}`);

	if (scopes.active.length === 0) {
		lines.push("stores    none active — nothing is captured or recalled");
	} else {
		scopes.active.forEach((scope, index) => {
			// The arrow marks the capture target: the one scope this session writes to.
			const marker = scope.scope === scopes.captureTarget ? "→" : " ";
			const state = scope.exists ? "" : " (not created yet)";
			const label = index === 0 ? "stores" : "      ";
			lines.push(`${label}  ${marker} ${scope.scope}: ${scope.path}${state}`);
		});
	}

	const captureKinds = [
		settings.capture.corrections ? "corrections" : null,
		settings.capture.outcomes ? "outcomes" : null,
		settings.capture.toolFacts ? "tool facts" : null,
	].filter((kind): kind is string => kind !== null);
	lines.push(`capture   ${captureKinds.length > 0 ? captureKinds.join(", ") : "nothing (all kinds disabled)"}`);
	lines.push("          outcome entries land in step 6 of Phase 1");
	for (const failure of input.captureFailures ?? []) lines.push(`          ! ${failure}`);

	if (input.journal) {
		if (input.journal.length === 0) {
			lines.push("journal   no active scope");
		} else {
			input.journal.forEach((stats, index) => {
				const label = index === 0 ? "journal  " : "         ";
				lines.push(
					`${label} ${stats.scope}: ${stats.entries} ${stats.entries === 1 ? "entry" : "entries"}, ${stats.claims} ${stats.claims === 1 ? "claim" : "claims"}`,
				);
				for (const problem of stats.problems) lines.push(`          ! ${problem}`);
			});
		}
	}

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

	if (problems.length > 0) {
		lines.push("");
		lines.push(`${problems.length} store problem${problems.length === 1 ? "" : "s"}:`);
		for (const problem of problems) lines.push(`  ! ${problem}`);
	}

	return lines.join("\n");
}

/** `/muninn scope` — which scopes are active here, and why. */
export function formatScopes(session: SessionContext): string {
	const lines: string[] = [];
	for (const reason of session.scopes.reasons) lines.push(`  ${reason}`);
	if (session.scopes.captureTarget === null) {
		lines.push("");
		lines.push("Nothing will be captured in this session.");
	}
	return ["scopes here:", ...lines].join("\n");
}

/** The compact footer entry set through `ctx.ui.setStatus`. */
export function formatStatusLine(session: SessionContext): string {
	const parts = ["⟡ muninn"];
	parts.push(session.scopes.captureTarget ?? "no store");
	const trouble = session.loaded.warnings.length + session.problems.length;
	if (trouble > 0) parts.push(`${trouble}⚠`);
	return parts.join(" · ");
}
