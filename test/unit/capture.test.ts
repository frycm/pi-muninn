import { describe, expect, it } from "vitest";
import { type CaptureInput, decideCapture } from "../../src/capture/capture.ts";
import type { MuninnSessionState } from "../../src/capture/session-state.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";

const STATE: MuninnSessionState = {
	task: "0198f2b0-1111-7000-8000-000000000001",
	written: [],
};

function input(overrides: Partial<CaptureInput> = {}): CaptureInput {
	return {
		text: "",
		inputSource: "interactive",
		channel: "tui",
		state: STATE,
		settings: structuredClone(DEFAULT_SETTINGS),
		...overrides,
	};
}

describe("decideCapture — what is not captured", () => {
	it("ignores an ordinary turn", () => {
		expect(decideCapture(input({ text: "Can you also check the type errors?" }))).toBeUndefined();
	});

	it("ignores empty and whitespace-only input", () => {
		expect(decideCapture(input({ text: "   " }))).toBeUndefined();
	});

	it("ignores slash commands", () => {
		// The command has its own handler; classifying its text would journal the
		// command line itself.
		expect(decideCapture(input({ text: "/muninn note always use pnpm" }))).toBeUndefined();
	});

	it("ignores input an extension synthesised", () => {
		// Only text the user actually typed is `source: user`. Treating a
		// synthesised turn as the user's assertion would launder provenance.
		expect(decideCapture(input({ text: "Always use pnpm in this repo", inputSource: "extension" }))).toBeUndefined();
	});

	it("respects capture.corrections being disabled", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.capture.corrections = false;
		expect(
			decideCapture(input({ text: "No, use pnpm not npm", previousAssistantText: "I'll run npm install.", settings })),
		).toBeUndefined();
	});

	it("still captures an explicit request when corrections are disabled", () => {
		// They are separate settings because they are separate kinds of evidence.
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.capture.corrections = false;
		expect(decideCapture(input({ text: "Always use pnpm here", settings }))?.kind).toBe("explicit");
	});
});

describe("decideCapture — explicit", () => {
	it("records the user's text as the claim", () => {
		const decision = decideCapture(input({ text: "Always use pnpm in this repo" }));
		expect(decision?.kind).toBe("explicit");
		expect(decision?.entry.claims).toEqual(["Always use pnpm in this repo"]);
		expect(decision?.entry.prose).toBe("");
	});

	it("splits bullets into separate claims", () => {
		const decision = decideCapture(
			input({ text: "Remember this:\n- deploys need the VPN\n- rollbacks are one command" }),
		);
		expect(decision?.entry.claims).toEqual(["deploys need the VPN", "rollbacks are one command"]);
		expect(decision?.entry.prose).toBe("Remember this:");
	});

	it("carries provenance, task grouping and channel", () => {
		const decision = decideCapture(input({ text: "Always use pnpm here", channel: "rpc" }));
		expect(decision?.entry.source).toBe("user");
		expect(decision?.entry.channel).toBe("rpc");
		expect(decision?.entry.task).toBe(STATE.task);
		expect(decision?.entry.phase).toBe("other");
	});

	it("carries `continues` so a resumed session stays one task", () => {
		const state = { ...STATE, continues: "0198f2af-0000-7000-8000-000000000000" };
		const decision = decideCapture(input({ text: "Always use pnpm here", state }));
		expect(decision?.entry.continues).toBe(state.continues);
	});

	it("carries the evidence pointer when there is one", () => {
		const pointer = "~/.pi/agent/sessions/--x--/y.jsonl#e5f6";
		expect(decideCapture(input({ text: "Always use pnpm here", session: pointer }))?.entry.session).toBe(pointer);
	});
});

describe("decideCapture — corrections", () => {
	const previousAssistantText = "I'll run npm install to add the dependency.";

	it("quotes the agent's last turn as context, not as a claim", () => {
		// The quoted turn is the belief being rejected. Recording it as evidence
		// would preserve exactly what the user just overruled.
		const decision = decideCapture(input({ text: "No, use pnpm not npm", previousAssistantText }));
		expect(decision?.kind).toBe("correction");
		expect(decision?.entry.prose).toContain("The agent had said:");
		expect(decision?.entry.prose).toContain("npm install");
		expect(decision?.entry.claims).toEqual(["No, use pnpm not npm"]);
	});

	it("truncates a long previous turn instead of copying the whole thing", () => {
		const decision = decideCapture(input({ text: "No, that is wrong", previousAssistantText: "x".repeat(2000) }));
		expect(decision?.entry.prose.length).toBeLessThan(500);
		expect(decision?.entry.prose).toContain("…");
	});

	it("is not a correction without a previous turn", () => {
		expect(decideCapture(input({ text: "No, use pnpm not npm" }))).toBeUndefined();
	});

	it("prefers the explicit reading when a turn is both", () => {
		// "Always" makes it a directive about the future, which is the more
		// durable of the two readings.
		const decision = decideCapture(input({ text: "Always use pnpm, not npm", previousAssistantText }));
		expect(decision?.kind).toBe("explicit");
	});

	it("names the rule that fired", () => {
		expect(decideCapture(input({ text: "No, use pnpm not npm", previousAssistantText }))?.reason).toContain("no+");
	});
});
