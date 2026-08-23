/**
 * `rules.md` — the procedural layer, read and linted but not written.
 *
 * A rule is *followed*, not merely recalled, which is why every control that
 * makes an auto-derived rule safe — the provenance gate, canaries that check a
 * rule fires, the held-out evaluation — is a phase away. Until those exist a
 * dream reads this file, checks it and reports on it; people write it.
 *
 * The grammar is a bullet naming the rule's id and a flat trailer, with the
 * rule's text on the indented lines below. Rules have identities so that a
 * dream can *retire* one — moved to `## Retired` with a reason — rather than
 * silently drop it, and so the evaluate phase can say which rule a regression
 * touched.
 */
import { parseTrailer } from "../journal/trailer.ts";

export interface Rule {
	/** `R-014`. Allocated by whoever writes the rule. */
	id: string;
	text: string;
	phase?: string;
	/** `global` · `project` · `team` — where the rule applies. */
	scope?: string;
	source?: string;
	since?: string;
	lastConfirmed?: string;
	reason?: string;
	retired: boolean;
}

export interface RulesFile {
	rules: Rule[];
	problems: string[];
}

const RULE_LINE = /^-\s+(R-\d+)\s*(?:·(.*))?$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(```+|~~~+)/;

function trackFence(line: string, fence: string | undefined): string | undefined {
	const match = FENCE.exec(line);
	if (!match) return fence;
	const marker = (match[1] as string).slice(0, 3);
	if (fence === undefined) return marker;
	return line.trim().startsWith(fence) ? undefined : fence;
}

export function parseRules(text: string): RulesFile {
	const result: RulesFile = { rules: [], problems: [] };
	let retired = false;
	let current: { rule: Rule; body: string[] } | undefined;
	let fence: string | undefined;

	const flush = (): void => {
		if (!current) return;
		const text = current.body.join("\n").trim();
		if (text === "") result.problems.push(`rule ${current.rule.id} has no text`);
		else result.rules.push({ ...current.rule, text });
		current = undefined;
	};

	for (const line of text.split("\n")) {
		// A `# comment` in a fenced shell block inside a rule's body is not a
		// heading; without this it would end the rule and could flip `retired`.
		const wasInside = fence !== undefined;
		fence = trackFence(line, fence);
		if (wasInside || fence !== undefined) {
			if (current) current.body.push(line);
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading) {
			flush();
			retired = /retired/i.test(heading[2] as string);
			continue;
		}

		const match = RULE_LINE.exec(line);
		if (match) {
			flush();
			const trailer = parseTrailer(match[2] ?? "");
			const rule: Rule = { id: match[1] as string, text: "", retired };
			const phase = trailer.get("phase");
			if (phase !== undefined) rule.phase = phase;
			const scope = trailer.get("scope");
			if (scope !== undefined) rule.scope = scope;
			const source = trailer.get("source");
			if (source !== undefined) rule.source = source;
			const since = trailer.get("since");
			if (since !== undefined) rule.since = since;
			const lastConfirmed = trailer.get("last_confirmed");
			if (lastConfirmed !== undefined) rule.lastConfirmed = lastConfirmed;
			const reason = trailer.get("reason");
			if (reason !== undefined) rule.reason = reason;
			current = { rule, body: [] };
			continue;
		}

		if (current) current.body.push(line);
	}
	flush();

	const seen = new Set<string>();
	for (const rule of result.rules) {
		if (seen.has(rule.id)) result.problems.push(`rule ${rule.id} is defined twice`);
		seen.add(rule.id);
	}
	return result;
}

/** Rules currently in force. A retired rule is history, not procedure. */
export function activeRules(file: RulesFile): Rule[] {
	return file.rules.filter((rule) => !rule.retired);
}
