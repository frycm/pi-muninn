/**
 * `muninn dream --qualify`: does this model dream well enough to be trusted?
 *
 * The riskiest assumption in the design is that a small local model can
 * consolidate well enough, and an operator has no way to find that out except
 * by trying it. So Muninn ships a fixture store with labelled cases, dreams it
 * with whatever model is configured, and scores the result against what the
 * fixture says should have happened.
 *
 * The scores are chosen so that the ones that matter cannot be traded away.
 * **Unsourced facts must be zero** and **echo leakage must be zero** — a single
 * one means the model will fabricate provenance, and no amount of good
 * behaviour elsewhere makes that acceptable. Retention and supersession recall
 * are qualities; those have thresholds. Everything is printed either way,
 * because an operator deciding whether to trust a model needs the numbers and
 * not a verdict.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newHostId, newStoreId } from "../ids.ts";
import { readSupersessions } from "../journal/supersessions.ts";
import type { MuninnSettings } from "../settings.ts";
import type { HostIdentity } from "../store/host.ts";
import { ensureStore } from "../store/init.ts";
import type { ActiveScope } from "../store/scopes.ts";
import { allFacts } from "../topics/format.ts";
import { dream } from "./dream.ts";
import type { DreamModel } from "./model.ts";
import { readTopics } from "./orient.ts";

/** What the fixture says a good dream produces. */
export interface Expectations {
	/** Journal claim ids that must never be cited: echoes, held-out, superseded. */
	forbiddenEvidence: string[];
	/** Claim ids the dream should have written into `supersessions.md`. */
	expectedSupersessions: string[];
	/** At least this many active facts, so a model cannot score by writing nothing. */
	minFacts: number;
	/** Topics the fixture expects to see some fact about. */
	expectedTopics: string[];
	/**
	 * Substrings that must appear in some active fact.
	 *
	 * Matched on the claim rather than on a topic slug, because a slug depends
	 * on Muninn's own naming and this fixture is here to measure a *model*.
	 */
	expectedClaims: string[];
	/** Substrings that must not appear in any derived file. */
	forbiddenText: string[];
}

export interface Score {
	name: string;
	value: number;
	/** The bar. `0` with `hard` means "must be exactly zero". */
	threshold: number;
	hard: boolean;
	passed: boolean;
	detail: string;
}

export interface QualifyResult {
	model: string;
	scores: Score[];
	passed: boolean;
	notes: string[];
}

export interface QualifyOptions {
	fixture: string;
	model: DreamModel;
	settings: MuninnSettings;
	now: Date;
	agentDir?: string;
}

/**
 * Dream a copy of the fixture store and score the result.
 *
 * A *copy*: qualification runs must not accumulate, and a model that scored
 * well on a store a previous run already consolidated would be scoring on a
 * different, easier problem.
 */
export async function qualify(options: QualifyOptions): Promise<QualifyResult> {
	const root = mkdtempSync(join(tmpdir(), "muninn-qualify-"));
	const agentDir = options.agentDir ?? join(root, "agent");
	const storePath = join(agentDir, "muninn");

	try {
		cpSync(join(options.fixture, "store"), storePath, { recursive: true });
		const host: HostIdentity = { id: hostOf(options.fixture), name: "qualify", createdAt: "2026-08-01" };
		await ensureStore(storePath, { host });

		const scope: ActiveScope = { scope: "global", path: storePath, exists: true, inRepo: false };
		const result = await dream({
			scope,
			agentDir,
			host,
			storeId: newStoreId(),
			settings: options.settings,
			now: options.now,
			model: options.model,
		});

		const expectations = JSON.parse(readFileSync(join(options.fixture, "expected.json"), "utf-8")) as Expectations;
		// Score the *branch*, which is where a dream's work is: nothing is
		// remembered here, exactly as a real dream leaves it.
		const worktree = result.worktree;
		const scored = score(worktree ?? storePath, expectations, result.report.skipped.length, result.report.notes);
		return {
			model: options.model.id,
			scores: scored,
			passed: scored.every((entry) => entry.passed),
			notes: [...result.problems, ...result.report.notes],
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** The fixture's own host id, so its journal directory is this host's. */
function hostOf(fixture: string): string {
	try {
		const meta = JSON.parse(readFileSync(join(fixture, "expected.json"), "utf-8")) as { host?: string };
		return meta.host ?? newHostId();
	} catch {
		return newHostId();
	}
}

export function score(storePath: string, expected: Expectations, skipped: number, notes: readonly string[]): Score[] {
	const topics = readTopics(storePath);
	const facts = [...topics.values()].flatMap((topic) => topic.facts.concat(topic.external));
	const every = [...topics.values()].flatMap((topic) => allFacts(topic));
	const superseded = readSupersessions(storePath).superseded;

	const unsourced = facts.filter((fact) => fact.evidence.length === 0);
	const forbidden = new Set(expected.forbiddenEvidence);
	const leaked = facts.filter((fact) => fact.evidence.some((id) => forbidden.has(id)));

	const wantedSupersessions = expected.expectedSupersessions.filter((id) => superseded.has(id));
	const derivedText = every.map((fact) => `${fact.claim} ${fact.cue ?? ""}`).join(" ");
	const secrets = expected.forbiddenText.filter((text) => derivedText.includes(text));
	const coveredTopics = expected.expectedTopics.filter((slug) => topics.has(slug));
	const factText = facts.map((fact) => `${fact.claim} ${fact.cue ?? ""}`).join(" ");
	const covered = (expected.expectedClaims ?? []).filter((text) => factText.includes(text));

	return [
		hard("unsourced facts", unsourced.length, `${unsourced.length} fact(s) cite nothing`),
		hard("echo and held-out leakage", leaked.length, `${leaked.length} fact(s) cite evidence they must not`),
		hard("secrets in derived files", secrets.length, `${secrets.length} forbidden string(s) present`),
		soft("facts written", facts.length, expected.minFacts, `${facts.length} active fact(s)`),
		soft(
			"supersession recall",
			expected.expectedSupersessions.length === 0
				? 1
				: wantedSupersessions.length / expected.expectedSupersessions.length,
			1,
			`${wantedSupersessions.length}/${expected.expectedSupersessions.length} expected supersessions written`,
		),
		soft(
			"topic coverage",
			expected.expectedTopics.length === 0 ? 1 : coveredTopics.length / expected.expectedTopics.length,
			1,
			`${coveredTopics.length}/${expected.expectedTopics.length} expected topics present`,
		),
		soft(
			"expected claims kept",
			(expected.expectedClaims ?? []).length === 0 ? 1 : covered.length / expected.expectedClaims.length,
			1,
			`${covered.length}/${(expected.expectedClaims ?? []).length} labelled claims present`,
		),
		hard("topics skipped", skipped, `${skipped} topic(s) the model could not answer for`),
		soft("retries", countRetries(notes) === 0 ? 1 : 0, 1, `${countRetries(notes)} job(s) needed a retry`),
	];
}

function countRetries(notes: readonly string[]): number {
	return notes.filter((note) => note.includes("retry")).length;
}

function hard(name: string, value: number, detail: string): Score {
	return { name, value, threshold: 0, hard: true, passed: value === 0, detail };
}

function soft(name: string, value: number, threshold: number, detail: string): Score {
	return { name, value, threshold, hard: false, passed: value >= threshold, detail };
}

/** The table an operator reads. */
export function formatQualify(result: QualifyResult): string {
	const rows = result.scores.map((entry) => {
		const mark = entry.passed ? "ok  " : entry.hard ? "FAIL" : "warn";
		return `  ${mark}  ${entry.name.padEnd(28)} ${entry.detail}`;
	});
	return [
		`muninn dream --qualify · ${result.model}`,
		"",
		...rows,
		"",
		result.passed
			? "This model clears the bar for manual dreams."
			: "This model does NOT clear the bar. Manual dreams need --force; automatic dreams are refused.",
		...(result.notes.length > 0 ? ["", ...result.notes.map((note) => `  note: ${note}`)] : []),
	].join("\n");
}
