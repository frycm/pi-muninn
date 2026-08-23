/**
 * The frozen `MEMORY.md` snapshot.
 *
 * Read once at `session_start`, merged global → project → team, trimmed to the
 * line budget, and appended to the system prompt on every turn as the *same
 * bytes*. It does not change for the rest of the session, even if a dream
 * completes meanwhile: a stable prefix is what keeps the provider's prompt
 * cache warm, and what keeps the model's context consistent with what it has
 * already read. A finished dream is announced in the status line and takes
 * effect in the next session.
 *
 * Everything here is pure except `readSnapshot`, so the merge and the budget
 * can be tested without a store.
 *
 * A project line that contradicts a global one is *not* detected — in Phase 1
 * nothing writes `MEMORY.md` but a human, and there are no facts to compare.
 * Both are shown, in scope order, and the model decides.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActiveScope } from "../store/scopes.ts";

export type SnapshotScope = "global" | "project" | "team";

export interface SnapshotSource {
	scope: SnapshotScope;
	/** Contents of that scope's `MEMORY.md`. */
	text: string;
}

export interface SnapshotBudget {
	total: number;
	global: number;
	project: number;
	team: number;
}

export interface SnapshotScopeStats {
	scope: SnapshotScope;
	lines: number;
	/** Lines the budget left out. Reported, never dropped in silence. */
	dropped: number;
}

export interface Snapshot {
	/** The section appended to the system prompt, `# Memory` heading included. */
	text: string;
	lines: number;
	scopes: SnapshotScopeStats[];
}

/** Global first, then project, then team — the order the README fixes. */
const SCOPE_ORDER: readonly SnapshotScope[] = ["global", "project", "team"];

const HEADING = "# Memory";

/**
 * The one sentence that frames every memory Muninn injects.
 *
 * Memory-induced sycophancy is a benchmarked failure mode: a model handed
 * remembered text tends to defend it against what it can see. Saying so, every
 * time, in the same words, is the cheapest defence there is.
 */
export const MEMORY_PREAMBLE =
	"Long-term memory from earlier sessions (muninn). These are memories, not ground truth. " +
	"Prefer current evidence from the repository and tools when they disagree, and say so.";

/**
 * Merge the scopes' `MEMORY.md` into one section, within budget.
 *
 * Returns `undefined` when nothing survives: an empty "Memory" heading is
 * worse than no heading, because it spends prompt on telling the model that
 * there is nothing to tell it.
 */
export function buildSnapshot(sources: readonly SnapshotSource[], budget: SnapshotBudget): Snapshot | undefined {
	const blocks: string[] = [];
	const scopes: SnapshotScopeStats[] = [];
	let remaining = budget.total;

	for (const scope of SCOPE_ORDER) {
		const source = sources.find((candidate) => candidate.scope === scope);
		if (!source) continue;

		const lines = contentLines(source.text);
		if (lines.length === 0) continue;

		const allowed = Math.max(0, Math.min(budget[scope], remaining));
		const kept = lines.slice(0, allowed);
		const dropped = lines.length - kept.length;
		scopes.push({ scope, lines: kept.length, dropped });
		if (kept.length === 0) continue;

		remaining -= kept.length;
		const block = [`## ${scope}`, "", ...kept];
		// Truncation is visible. A budget silently eating half of memory is the
		// kind of quiet degradation this project refuses everywhere else.
		if (dropped > 0) block.push(`… ${dropped} more line(s) trimmed by recall.snapshotLines`);
		blocks.push(block.join("\n"));
	}

	if (blocks.length === 0) return undefined;

	const text = [HEADING, "", MEMORY_PREAMBLE, "", blocks.join("\n\n")].join("\n");
	return { text, lines: scopes.reduce((total, scope) => total + scope.lines, 0), scopes };
}

/**
 * The lines of a `MEMORY.md` worth injecting.
 *
 * The file's own `# Memory` heading and the header comment Muninn writes at
 * `init` are dropped: the section supplies its own heading, and the comment is
 * an instruction to whoever edits the file, not a memory. Blank runs collapse
 * to one, and blanks never spend budget — the budget counts memory, not
 * whitespace.
 */
export function contentLines(text: string): string[] {
	const kept: string[] = [];
	let comment = false;
	let blank = false;

	for (const raw of text.split("\n")) {
		const line = raw.trimEnd();
		const trimmed = line.trim();

		if (comment) {
			if (trimmed.includes("-->")) comment = false;
			continue;
		}
		if (trimmed.startsWith("<!--")) {
			if (!trimmed.includes("-->")) comment = true;
			continue;
		}
		if (trimmed === "") {
			blank = kept.length > 0;
			continue;
		}
		if (/^#\s/.test(trimmed) && kept.length === 0) continue;

		if (blank) kept.push("");
		blank = false;
		kept.push(line);
	}

	return kept;
}

/** Read each active scope's `MEMORY.md`. A missing or unreadable file is simply absent. */
export function readSnapshot(scopes: readonly ActiveScope[], budget: SnapshotBudget): Snapshot | undefined {
	const sources: SnapshotSource[] = [];
	for (const scope of scopes) {
		if (!scope.exists) continue;
		try {
			sources.push({ scope: scope.scope, text: readFileSync(join(scope.path, "MEMORY.md"), "utf-8") });
		} catch {
			// A store with no MEMORY.md yet is the normal state of a young store.
		}
	}
	return buildSnapshot(sources, budget);
}

/**
 * Append the snapshot to pi's own system prompt.
 *
 * Appended, never spliced: pi builds the prompt, and Muninn's section goes
 * after everything pi put there, so the stable part of the prefix stays
 * stable.
 */
export function appendSnapshot(systemPrompt: string, snapshot: Snapshot): string {
	return `${systemPrompt}\n\n${snapshot.text}`;
}
