import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bodyFromUserText, channelForMode, detectCorrection, detectExplicit } from "../../src/capture/cues.ts";

interface Turn {
	assistant?: string;
	user: string;
}

interface Corpus {
	explicit: Turn[];
	corrections: Turn[];
	neither: Turn[];
}

const CORPUS = JSON.parse(
	readFileSync(fileURLToPath(new URL("../fixtures/turns/classifier.json", import.meta.url)), "utf-8"),
) as Corpus;

/** What capture would do with a turn: journal it as one kind, or not at all. */
function classify(turn: Turn): "explicit" | "correction" | "neither" {
	if (detectExplicit(turn.user).matched) return "explicit";
	if (detectCorrection({ text: turn.user, previousAssistantText: turn.assistant }).matched) return "correction";
	return "neither";
}

describe("the 60-turn corpus", () => {
	it("is the shape the plan asked for", () => {
		expect(CORPUS.explicit).toHaveLength(20);
		expect(CORPUS.corrections).toHaveLength(20);
		expect(CORPUS.neither).toHaveLength(20);
	});

	it("has zero false positives on turns that are neither", () => {
		// The gate. A false positive is noise in an append-only journal for good;
		// a missed correction is caught later by the outcome entry. So this is
		// the number that must be zero, and recall is merely reported.
		const flagged = CORPUS.neither.filter((turn) => classify(turn) !== "neither");
		expect(flagged.map((turn) => turn.user)).toEqual([]);
	});

	it("recognises explicit requests to remember", () => {
		const missed = CORPUS.explicit.filter((turn) => classify(turn) !== "explicit");
		expect(missed.map((turn) => turn.user)).toEqual([]);
	});

	it("recognises corrections", () => {
		const missed = CORPUS.corrections.filter((turn) => classify(turn) !== "correction");
		expect(missed.map((turn) => turn.user)).toEqual([]);
	});
});

describe("detectExplicit", () => {
	it("only fires at the start of a sentence", () => {
		// Most of the precision comes from this anchoring alone.
		expect(detectExplicit("I don't remember which flag it was").matched).toBe(false);
		expect(detectExplicit("Do you remember the config?").matched).toBe(false);
		expect(detectExplicit("I remember it differently").matched).toBe(false);
		expect(detectExplicit("Remember to use pnpm here").matched).toBe(true);
	});

	it("finds a cue in a later sentence too", () => {
		expect(detectExplicit("The build is fine. From now on use pnpm.").matched).toBe(true);
	});

	it("ignores reminiscing", () => {
		expect(detectExplicit("Remember when the CI broke last month?").matched).toBe(false);
	});

	it("ignores 'never mind'", () => {
		expect(detectExplicit("Never mind, I fixed it").matched).toBe(false);
	});

	it("wants a directive, not a bare word", () => {
		expect(detectExplicit("Always?").matched).toBe(false);
		expect(detectExplicit("Remember.").matched).toBe(false);
		expect(detectExplicit("Always run the tests first").matched).toBe(true);
	});

	it("names the rule that fired", () => {
		expect(detectExplicit("From now on, use pnpm").reason).toBe("from-now-on");
	});
});

describe("detectCorrection", () => {
	const previous = "I'll run npm install to add the dependency.";

	it("needs something to contradict", () => {
		// A correction on the first turn is not a correction.
		expect(detectCorrection({ text: "No, use pnpm instead" }).matched).toBe(false);
		expect(detectCorrection({ text: "No, use pnpm instead", previousAssistantText: "" }).matched).toBe(false);
	});

	it("needs both a contrast marker and a reference to the last turn", () => {
		// "no" on its own is an ordinary answer to a question.
		expect(detectCorrection({ text: "No.", previousAssistantText: previous }).matched).toBe(false);
		expect(detectCorrection({ text: "no thanks", previousAssistantText: previous }).matched).toBe(false);
		// Sharing vocabulary without contradicting is just the conversation going on.
		expect(detectCorrection({ text: "npm install takes a while", previousAssistantText: previous }).matched).toBe(
			false,
		);
		// Both present.
		expect(detectCorrection({ text: "No, use pnpm not npm", previousAssistantText: previous }).matched).toBe(true);
	});

	it("accepts a demonstrative as the reference", () => {
		expect(detectCorrection({ text: "Don't do that", previousAssistantText: previous }).matched).toBe(true);
	});

	it("accepts a shared content word as the reference", () => {
		const result = detectCorrection({ text: "Actually pnpm replaces npm here", previousAssistantText: previous });
		expect(result.matched).toBe(true);
		expect(result.reason).toContain("overlap:");
	});

	it("does not treat common words as evidence", () => {
		// Without a stop list, almost any two turns in a coding session overlap.
		expect(
			detectCorrection({ text: "Actually the file should work", previousAssistantText: "The file will work." }).matched,
		).toBe(false);
	});

	it("names the marker and the reference that fired", () => {
		expect(detectCorrection({ text: "No, don't do that", previousAssistantText: previous }).reason).toBe(
			"no+referential",
		);
	});
});

describe("channelForMode", () => {
	it("maps pi's run mode onto an observation channel", () => {
		expect(channelForMode("tui")).toBe("tui");
		expect(channelForMode("rpc")).toBe("rpc");
		expect(channelForMode("json")).toBe("sdk");
		expect(channelForMode("print")).toBe("sdk");
	});

	it("treats an unknown mode as headless rather than guessing a TUI", () => {
		expect(channelForMode("something-new")).toBe("sdk");
	});
});

describe("bodyFromUserText", () => {
	it("turns bullets into claims and the rest into context", () => {
		expect(bodyFromUserText("Remember this:\n- deploys need the VPN\n- rollbacks are one command")).toEqual({
			prose: "Remember this:",
			claims: ["deploys need the VPN", "rollbacks are one command"],
		});
	});

	it("makes text with no bullets a single claim", () => {
		// The user's whole point is the claim; filing it as context would leave
		// an entry with nothing anything downstream can cite.
		expect(bodyFromUserText("Always use pnpm in this repo")).toEqual({
			prose: "",
			claims: ["Always use pnpm in this repo"],
		});
	});

	it("handles empty text", () => {
		expect(bodyFromUserText("   ")).toEqual({ prose: "", claims: [] });
	});
});
