import { describe, expect, it } from "vitest";
import { estimateTokens, RunAccumulator, renderRun } from "../../src/capture/accumulate.ts";
import { buildOutcomePrompt, outcomeEntry, parseOutcome, shouldWriteOutcome } from "../../src/capture/outcome.ts";
import { runOutcome } from "../../src/capture/outcome-run.ts";
import type { MuninnSessionState } from "../../src/capture/session-state.ts";

const STATE: MuninnSessionState = { task: "0198f2b0-1111-7000-8000-000000000001", written: [] };

function assistant(text: string, toolCalls: string[] = []) {
	return {
		role: "assistant",
		content: [{ type: "text", text }, ...toolCalls.map((name) => ({ type: "toolCall", name }))],
	};
}

function toolResult(text: string) {
	return { role: "toolResult", content: [{ type: "text", text }] };
}

const GOOD_REPLY = [
	"phase: test",
	"cue: when vitest hangs in CI",
	"",
	"The CI job hung until watch mode was disabled.",
	"",
	"- Run `pnpm test --run`; vitest watch mode hangs the CI job.",
	"- The CI runner has no TTY, which is why watch mode never exits.",
].join("\n");

describe("RunAccumulator", () => {
	it("collects turns as they finish", () => {
		const run = new RunAccumulator();
		expect(run.isEmpty).toBe(true);
		run.onTurnEnd(assistant("Looking at the config", ["read"]), [toolResult("file contents")]);
		const buffer = run.peek();
		expect(buffer.messages).toHaveLength(2);
		expect(buffer.toolCallCount).toBe(1);
		expect(buffer.turnCount).toBe(1);
	});

	it("lets agent_end overrule what was accumulated", () => {
		// pi's own view of the run is authoritative; the turn-by-turn buffer only
		// exists so a run cut short still has something.
		const run = new RunAccumulator();
		run.onTurnEnd(assistant("first"), []);
		run.onAgentEnd([{ role: "user", content: "the task" }, assistant("the answer")]);
		expect(run.peek().messages.map((message) => message.text)).toEqual(["the task", "the answer"]);
	});

	it("keeps custom messages as ordinary visible evidence", () => {
		const run = new RunAccumulator();
		run.onAgentEnd([{ role: "custom", customType: "someone-else", content: "their note" }]);
		expect(run.peek().messages).toHaveLength(1);
	});

	it("take() empties it for the next run", () => {
		const run = new RunAccumulator();
		run.onTurnEnd(assistant("x"), []);
		expect(run.take().messages).toHaveLength(1);
		expect(run.isEmpty).toBe(true);
	});
});

describe("renderRun", () => {
	it("keeps the newest messages and says how many were dropped", () => {
		// The tail of a run is what its outcome is about — what was tried last and
		// what finally worked.
		const run = new RunAccumulator();
		run.onAgentEnd(Array.from({ length: 40 }, (_, index) => assistant(`message ${index} ${"padding ".repeat(60)}`)));

		const rendered = renderRun(run.peek(), 500);
		expect(rendered).toContain("earlier message(s) omitted");
		expect(rendered).toContain("message 39");
		expect(rendered).not.toContain("message 0 ");
		expect(estimateTokens(rendered)).toBeLessThan(700);
	});

	it("keeps everything when it fits", () => {
		const run = new RunAccumulator();
		run.onAgentEnd([assistant("short one"), assistant("short two")]);
		const rendered = renderRun(run.peek(), 12_000);
		expect(rendered).toContain("short one");
		expect(rendered).not.toContain("omitted");
	});
});

describe("parseOutcome", () => {
	it("reads the documented template", () => {
		const parsed = parseOutcome(GOOD_REPLY);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.outcome.phase).toBe("test");
		expect(parsed.outcome.cue).toBe("when vitest hangs in CI");
		expect(parsed.outcome.claims).toHaveLength(2);
		expect(parsed.outcome.prose).toBe("The CI job hung until watch mode was disabled.");
	});

	it("tolerates a code fence the model added anyway", () => {
		const parsed = parseOutcome("```\nphase: fix\n\ncontext\n\n- a claim\n```");
		expect(parsed.ok).toBe(true);
	});

	it("refuses a phase retrieval could not filter on", () => {
		// A made-up phase would quietly exclude the entry from every future search
		// that filtered by step — worse than not writing it.
		const parsed = parseOutcome("phase: debugging\n\ncontext\n\n- a claim");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error.problem).toContain("debugging");
	});

	it("refuses a reply with no phase", () => {
		const parsed = parseOutcome("The task went fine.\n\n- a claim");
		expect(parsed.ok).toBe(false);
	});

	it("refuses an empty reply", () => {
		expect(parseOutcome("   ").ok).toBe(false);
	});

	it("accepts a reply with no claims, so the caller can decide", () => {
		// "nothing durable was learned" is a legitimate outcome the template invites.
		const parsed = parseOutcome("phase: other\n\nJust a chat.");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.outcome.claims).toEqual([]);
	});

	it("treats an indented continuation as part of the claim above it", () => {
		const parsed = parseOutcome("phase: fix\n\n- a claim that\n  wrapped\n");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.outcome.claims).toEqual(["a claim that wrapped"]);
	});
});

describe("shouldWriteOutcome", () => {
	const buffer = (toolCallCount: number, turnCount: number, messages = 2) => ({
		messages: Array.from({ length: messages }, () => ({ role: "assistant", text: "x", toolCalls: [] })),
		toolCallCount,
		turnCount,
	});

	it("writes for a real task", () => {
		expect(shouldWriteOutcome(buffer(1, 2), { outcomesEnabled: true })).toBeUndefined();
	});

	it("skips a question answered in one turn with no tools", () => {
		// Journaling these is how a memory store fills with chit-chat nobody trusts.
		const skip = shouldWriteOutcome(buffer(0, 1), { outcomesEnabled: true });
		expect(skip?.reason).toContain("a question, not a task");
	});

	it("writes for a single turn that used a tool", () => {
		expect(shouldWriteOutcome(buffer(1, 1), { outcomesEnabled: true })).toBeUndefined();
	});

	it("skips when the setting is off", () => {
		expect(shouldWriteOutcome(buffer(3, 3), { outcomesEnabled: false })?.reason).toContain("off");
	});

	it("skips an empty run", () => {
		expect(shouldWriteOutcome(buffer(0, 0, 0), { outcomesEnabled: true })?.reason).toContain("nothing happened");
	});
});

describe("buildOutcomePrompt", () => {
	it("contains the bounded run transcript and no implicit journal context", () => {
		const prompt = buildOutcomePrompt({
			buffer: {
				messages: [{ role: "assistant", text: "did a thing", toolCalls: [] }],
				toolCallCount: 0,
				turnCount: 1,
			},
			state: STATE,
		});
		expect(prompt).toContain("did a thing");
		expect(prompt).not.toContain("Journal context");
	});
});

describe("outcomeEntry", () => {
	const request = {
		buffer: { messages: [], toolCallCount: 0, turnCount: 0 },
		state: STATE,
	};

	it("marks the entry as the agent's own inference", () => {
		const parsed = parseOutcome(GOOD_REPLY);
		if (!parsed.ok) throw new Error("fixture failed to parse");
		const entry = outcomeEntry(parsed.outcome, request, { channel: "tui" });
		expect(entry.source).toBe("agent");
		expect(entry.phase).toBe("test");
		expect(entry.task).toBe(STATE.task);
	});
});

describe("runOutcome", () => {
	const request = {
		buffer: {
			messages: [{ role: "assistant", text: "did a thing", toolCalls: ["bash"] }],
			toolCallCount: 1,
			turnCount: 2,
		},
		state: STATE,
	};

	it("returns an entry for a well-formed reply", async () => {
		const result = await runOutcome({
			request,
			model: { complete: async () => GOOD_REPLY },
			channel: "tui",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.entry.claims).toHaveLength(2);
	});

	it("retries once, telling the model what was wrong", async () => {
		const prompts: string[] = [];
		let call = 0;
		const result = await runOutcome({
			request,
			model: {
				complete: async (context) => {
					prompts.push(JSON.stringify(context.messages));
					call++;
					return call === 1 ? "I think the task went well!" : GOOD_REPLY;
				},
			},
			channel: "tui",
		});

		expect(result.ok).toBe(true);
		expect(call).toBe(2);
		expect(prompts[1]).toContain("could not be parsed");
		expect(prompts[1]).toContain("phase:");
	});

	it("gives up after one retry rather than journaling something unreadable", async () => {
		// An unparsable entry in an append-only journal burdens every reader
		// forever, and the run is still in pi's session file if a human wants it.
		let call = 0;
		const result = await runOutcome({
			request,
			model: {
				complete: async () => {
					call++;
					return "still not the format";
				},
			},
			channel: "tui",
		});
		expect(call).toBe(2);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.problem).toContain("unparsable after one retry");
	});

	it("writes nothing when the model reports nothing durable", async () => {
		const result = await runOutcome({
			request,
			model: { complete: async () => "phase: other\n\nJust a chat, nothing learned." },
			channel: "tui",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.problem).toContain("nothing durable");
	});

	it("reports a failed model call instead of throwing into pi", async () => {
		const result = await runOutcome({
			request,
			model: {
				complete: async () => {
					throw new Error("connection refused");
				},
			},
			channel: "tui",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.problem).toContain("connection refused");
	});
});

describe("tool calls carry their arguments", () => {
	it("renders what was called, not just that something was", () => {
		// "The agent called read" tells a future session nothing. "The agent read
		// README.md" is the durable detail an outcome entry exists for.
		const run = new RunAccumulator();
		run.onAgentEnd([
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "1", name: "read", arguments: { path: "README.md" } }],
			},
		]);
		expect(run.peek().messages[0]?.toolCalls).toEqual(["read(path: README.md)"]);
		expect(renderRun(run.peek(), 1000)).toContain("README.md");
	});

	it("truncates a huge argument rather than pasting a whole file in", () => {
		const run = new RunAccumulator();
		run.onAgentEnd([
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "1", name: "write", arguments: { path: "a.ts", content: "x".repeat(5000) } }],
			},
		]);
		const rendered = run.peek().messages[0]?.toolCalls[0] ?? "";
		expect(rendered).toContain("path: a.ts");
		expect(rendered).toContain("…");
		expect(rendered.length).toBeLessThan(300);
	});

	it("still counts a call with no arguments", () => {
		const run = new RunAccumulator();
		run.onAgentEnd([{ role: "assistant", content: [{ type: "toolCall", id: "1", name: "ls" }] }]);
		expect(run.peek().messages[0]?.toolCalls).toEqual(["ls"]);
		expect(run.peek().toolCallCount).toBe(1);
	});
});

describe("RunAccumulator — a run that continues after compaction", () => {
	it("collects the continuation as a fresh run once the first part is taken", () => {
		// pi compacts on agent_end and may then continue the run (overflow
		// retry, queued messages) before agent_settled. Muninn takes the buffer
		// at compaction, so the continuation is its own outcome rather than
		// being sealed away behind pi's first agent_end and then discarded.
		const run = new RunAccumulator();
		run.onTurnEnd({ role: "assistant", content: [{ type: "toolCall", name: "read" }] }, []);
		run.onAgentEnd([{ role: "assistant", content: [{ type: "toolCall", name: "read" }] }]);
		expect(run.hadAuthoritativeEnd).toBe(true);

		const first = run.take();
		expect(first.toolCallCount).toBe(1);

		// The continuation: new turns arrive, and accumulate again.
		run.onTurnEnd({ role: "assistant", content: [{ type: "toolCall", name: "edit" }] }, []);
		run.onTurnEnd({ role: "assistant", content: "Fixed after compaction." }, []);
		const second = run.take();
		expect(second.messages.map((message) => message.text)).toContain("Fixed after compaction.");
		expect(second.toolCallCount).toBe(1);
	});
});
