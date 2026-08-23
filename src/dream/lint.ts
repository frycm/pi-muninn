/**
 * Phase 4 of a dream: check what the model produced, deterministically.
 *
 * Lint is the fence around consolidation. It cannot catch a plausible,
 * well-sourced, wrong generalisation — nothing here can, which is why dreams
 * are remembered by hand in this phase — but it can catch every way a derived
 * file stops being traceable to the journal, and those are the failures that
 * make memory untrustworthy rather than merely wrong.
 *
 * Findings are **blocking** or **advisory**. Blocking means the dream failed:
 * the branch and the report are kept for inspection and nothing is remembered.
 * Advisory means someone should look, and the report is where they look.
 *
 * Contradiction detection is deliberately two-part. Finding *candidate* pairs —
 * two active facts in one topic that overlap heavily — is code. Deciding whether
 * a pair actually contradicts is a judgement, so it is asked of a model only
 * where one is at hand; the headless path reports the pairs unjudged rather
 * than spending a model call per topic from cron.
 */
import { jaccard } from "../capture/outcome.ts";
import { isFactId } from "../ids.ts";
import { containsSecret } from "../redact.ts";
import { allFacts, type Fact, type TopicFile } from "../topics/format.ts";
import { activeRules, parseRules } from "../topics/rules.ts";
import type { Usage } from "../topics/use-count.ts";
import type { LintFinding } from "./report.ts";

/** Overlap at which two facts in one topic are worth a second look. */
export const CONTRADICTION_THRESHOLD = 0.6;

export interface LintInput {
	topics: ReadonlyMap<string, TopicFile>;
	/** Every journal claim id that exists at all. */
	claims: ReadonlySet<string>;
	superseded: ReadonlySet<string>;
	/** Erased *entry* ids; a claim of one is unusable too. */
	erased: ReadonlySet<string>;
	/** Claim ids that are echoes of a memory, per the entries that wrote them. */
	echoes: ReadonlySet<string>;
	rules: string;
	memory: string;
	usage: ReadonlyMap<string, Usage>;
	rulesCap: number;
	retireAfterDays: number;
	now: Date;
	/** A global store's rules, when linting a project. */
	globalRules?: string;
}

export interface ContradictionPair {
	topic: string;
	a: Fact;
	b: Fact;
}

export interface LintResult {
	findings: LintFinding[];
	/** Pairs a model could be asked about, if one is at hand. */
	candidates: ContradictionPair[];
	blocking: number;
}

export function lint(input: LintInput): LintResult {
	const findings: LintFinding[] = [];
	const candidates: ContradictionPair[] = [];
	const factIds = new Set<string>();
	for (const topic of input.topics.values()) for (const fact of allFacts(topic)) factIds.add(fact.id);

	for (const [slug, topic] of input.topics) {
		for (const fact of topic.facts.concat(topic.external)) {
			checkEvidence(slug, fact, input, findings);
			if (containsSecret(fact.claim) || (fact.cue !== undefined && containsSecret(fact.cue))) {
				// Never quote the fact: a lint finding is written into a report
				// that is committed and synced.
				findings.push({ blocking: true, rule: "secret", message: `${slug}: fact ${fact.id} would carry a secret` });
			}
		}
		candidates.push(...contradictionCandidates(slug, topic));
		for (const fact of topic.superseded) {
			if (fact.supersededBy !== undefined && !factIds.has(fact.supersededBy) && isFactId(fact.supersededBy)) {
				findings.push({
					blocking: false,
					rule: "dangling-supersession",
					message: `${slug}: ${fact.id} says it was superseded by ${fact.supersededBy}, which does not exist`,
				});
			}
		}
	}

	findings.push(...lintRules(input));
	findings.push(...lintMemory(input, factIds));

	return { findings, candidates, blocking: findings.filter((finding) => finding.blocking).length };
}

/**
 * The rule the whole design rests on: a fact must be traceable to live evidence.
 *
 * Three ways it fails, and they are different failures. Citing an id that does
 * not exist is a hallucination. Citing only superseded claims means the fact
 * outlived what it was built from. Citing only echoes means the fact is the
 * model agreeing with itself.
 */
function checkEvidence(slug: string, fact: Fact, input: LintInput, findings: LintFinding[]): void {
	if (fact.evidence.length === 0) {
		findings.push({ blocking: true, rule: "unsourced", message: `${slug}: fact ${fact.id} cites no evidence` });
		return;
	}

	const unknown = fact.evidence.filter((id) => !input.claims.has(id));
	if (unknown.length === fact.evidence.length) {
		findings.push({
			blocking: true,
			rule: "unsourced",
			message: `${slug}: fact ${fact.id} cites ${unknown.length} claim(s) that do not exist`,
		});
		return;
	}
	if (unknown.length > 0) {
		findings.push({
			blocking: false,
			rule: "partly-unsourced",
			message: `${slug}: fact ${fact.id} cites ${unknown.join(", ")}, which do not exist`,
		});
	}

	const live = fact.evidence.filter((id) => input.claims.has(id) && !input.superseded.has(id) && !isErased(id, input));
	if (live.length === 0) {
		findings.push({
			blocking: true,
			rule: "stale-evidence",
			message: `${slug}: every claim behind fact ${fact.id} is superseded or erased`,
		});
		return;
	}
	if (live.every((id) => input.echoes.has(id))) {
		findings.push({
			blocking: true,
			rule: "echo-only",
			message: `${slug}: fact ${fact.id} rests only on claims that restate a memory`,
		});
	}
}

function isErased(claimId: string, input: LintInput): boolean {
	const dot = claimId.lastIndexOf(".");
	return input.erased.has(dot < 0 ? claimId : claimId.slice(0, dot));
}

/**
 * Pairs of active facts in one topic that overlap enough to be worth judging.
 *
 * Overlap is not contradiction — "run tests with --run" and "run tests with
 * --run in CI" overlap heavily and agree. That is exactly why this returns
 * *candidates* and the judgement is somebody else's.
 */
export function contradictionCandidates(slug: string, topic: TopicFile): ContradictionPair[] {
	const pairs: ContradictionPair[] = [];
	const facts = topic.facts;
	for (let i = 0; i < facts.length; i++) {
		for (let j = i + 1; j < facts.length; j++) {
			const a = facts[i] as Fact;
			const b = facts[j] as Fact;
			if (jaccard(a.claim, b.claim) >= CONTRADICTION_THRESHOLD) pairs.push({ topic: slug, a, b });
		}
	}
	return pairs;
}

function lintRules(input: LintInput): LintFinding[] {
	const findings: LintFinding[] = [];
	const parsed = parseRules(input.rules);
	for (const problem of parsed.problems) findings.push({ blocking: false, rule: "rules", message: problem });

	const active = activeRules(parsed);
	if (active.length > input.rulesCap) {
		// A cap that is only advisory is not a cap. The design's soft-retirement
		// answer is the proposals below; the cap itself has to bite, or a rules
		// file grows until nothing in it is followed.
		findings.push({
			blocking: true,
			rule: "rules-cap",
			message: `${active.length} active rules, over the cap of ${input.rulesCap}`,
		});
	}

	const cutoff = new Date(input.now.getTime() - input.retireAfterDays * 86_400_000).toISOString().slice(0, 10);
	for (const rule of active) {
		const usage = input.usage.get(rule.id);
		const last = usage?.lastUsed ?? rule.lastConfirmed ?? rule.since;
		if (last !== undefined && last < cutoff) {
			findings.push({
				blocking: false,
				rule: "unused-rule",
				message: `${rule.id} has not been used since ${last} — propose retiring it`,
			});
		}
	}

	if (input.globalRules !== undefined) {
		const globals = activeRules(parseRules(input.globalRules));
		for (const rule of active) {
			for (const other of globals) {
				// A project rule may add; it may not quietly countermand a global
				// one. Surfaced, never resolved: the design says a conflict is
				// shown rather than decided.
				if (jaccard(rule.text, other.text) >= CONTRADICTION_THRESHOLD) {
					findings.push({
						blocking: false,
						rule: "project-vs-global-rule",
						message: `${rule.id} overlaps global ${other.id} — a project rule cannot override a global one`,
					});
				}
			}
		}
	}

	return findings;
}

/** `MEMORY.md` lines that point at a fact or a topic which is not there. */
function lintMemory(input: LintInput, factIds: ReadonlySet<string>): LintFinding[] {
	const findings: LintFinding[] = [];
	for (const line of input.memory.split("\n")) {
		for (const id of line.match(/\bf-[a-z0-9-]+-[0-9a-f-]{36}\b/g) ?? []) {
			if (!factIds.has(id)) {
				findings.push({ blocking: false, rule: "orphan", message: `MEMORY.md cites ${id}, which does not exist` });
			}
		}
		for (const path of line.match(/\btopics\/([a-z0-9-]+)\.md\b/g) ?? []) {
			const slug = path.slice("topics/".length, -".md".length);
			if (!input.topics.has(slug)) {
				findings.push({
					blocking: false,
					rule: "orphan",
					message: `MEMORY.md points at ${path}, which does not exist`,
				});
			}
		}
	}
	return findings;
}
