/**
 * Scripted dreamers for the qualification fixture.
 *
 * CI has no local model, so what it can test is the *scorer*: `perfect` must
 * score full marks and `hostile` must fail every hard gate. That keeps the
 * fixture and its answer key from drifting apart, and it means a regression in
 * a guard shows up as a hostile script suddenly passing.
 */
import type { DreamModel } from "../../../src/dream/model.ts";

/** Claim ids the prompt actually showed, which is all a dreamer may cite. */
export function citableIds(prompt: string): string[] {
	return [...prompt.matchAll(/\[(j-[0-9a-f-]+\.\d+)\]/g)].map((match) => match[1] as string);
}

/** The claim text next to each citable id, so a script can answer about it. */
export function shownClaims(prompt: string): Array<{ id: string; text: string }> {
	return [...prompt.matchAll(/^- (.+?) \[(j-[0-9a-f-]+\.\d+)\]$/gm)].map((match) => ({
		id: match[2] as string,
		text: match[1] as string,
	}));
}

function block(items: unknown[]): string {
	return `Considering the evidence.\n\n\`\`\`json\n${JSON.stringify(items, null, 2)}\n\`\`\`\n`;
}

/**
 * A dreamer that does exactly the right thing.
 *
 * One fact per shown claim, each citing that claim and nothing else. It cannot
 * invent an id because it only ever repeats one it was given, which is the
 * behaviour every guard is trying to require.
 */
export const perfect: DreamModel = {
	id: "script/perfect",
	async complete(request) {
		const claims = shownClaims(request.prompt);
		if (claims.length === 0) return block([]);
		return block(claims.map((claim) => ({ claim: claim.text, evidence: [claim.id], cue: "from the journal" })));
	},
};

/** A dreamer whose JSON is broken once, then fine. Exercises the single retry. */
export function flaky(): DreamModel {
	let asked = false;
	return {
		id: "script/flaky",
		async complete(request) {
			if (!asked) {
				asked = true;
				return "Here you go:\n\n```json\n[{'claim': not json at all\n```";
			}
			return perfect.complete(request);
		},
	};
}

/**
 * A dreamer that tries every way of being wrong the guards exist to catch.
 *
 * Every item here is refused by a *different* rule, so a hostile run that
 * suddenly passes says which guard stopped working.
 */
export const hostile: DreamModel = {
	id: "script/hostile",
	async complete(request) {
		const shown = shownClaims(request.prompt);
		const first = shown[0];
		return block([
			// 1. an id nobody showed it — including any held-out task's
			{ claim: "A fact from nowhere at all.", evidence: ["j-01a00000-0000-7000-8000-000000000099.1"] },
			// 2. no evidence whatsoever
			{ claim: "Trust me on this one.", evidence: [] },
			// 3. a secret written into a claim
			{
				claim: "The staging deploy key is AKIAIOSFODNN7EXAMPLE and it still works.",
				evidence: first ? [first.id] : [],
			},
			// 4. a supersession of a fact that does not exist
			{
				claim: "Replacing something imaginary.",
				evidence: first ? [first.id] : [],
				supersedes: ["f-testing-0198aaaa-0a1b-7c2d-8e3f-405162738495"],
				reason: "no reason at all",
			},
		]);
	},
};

/** A dreamer that answers nothing, so a store can be dreamed with no model effect. */
export const silent: DreamModel = {
	id: "script/silent",
	complete: async () => block([]),
};
