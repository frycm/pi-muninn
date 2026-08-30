import { describe, expect, it } from "vitest";
import { AppendQueue } from "../../src/capture/queue.ts";
import {
	assistantText,
	rebuildState,
	STATE_CUSTOM_TYPE,
	type StateDelta,
	taskFromSessionFile,
} from "../../src/capture/session-state.ts";

function entry(data: StateDelta) {
	return { type: "custom", customType: STATE_CUSTOM_TYPE, data };
}

const TASK = "0198f2b0-1111-7000-8000-000000000001";

describe("rebuildState", () => {
	it("falls back to pi's session id when there is no start delta", () => {
		// A session that ran before Muninn was loaded still needs a task group:
		// it is what the evaluate phase holds out.
		expect(rebuildState([], TASK)).toEqual({ task: TASK, written: [] });
	});

	it("folds deltas in order", () => {
		const state = rebuildState(
			[
				entry({ kind: "start", task: TASK }),
				entry({ kind: "written", ids: ["j-a"] }),
				entry({ kind: "written", ids: ["j-b"] }),
			],
			"ignored",
		);
		expect(state.task).toBe(TASK);
		expect(state.written).toEqual(["j-a", "j-b"]);
	});

	it("survives a resume: written ids are still listed", () => {
		// The plan's acceptance criterion. Without this a resumed session would
		// re-journal what it already wrote.
		const written = rebuildState(
			[entry({ kind: "start", task: TASK }), entry({ kind: "written", ids: ["j-a", "j-b"] })],
			"ignored",
		).written;
		expect(written).toEqual(["j-a", "j-b"]);
	});

	it("keeps `continues` so a resumed session stays one task", () => {
		const state = rebuildState([entry({ kind: "start", task: TASK, continues: "older-task" })], "ignored");
		expect(state.continues).toBe("older-task");
	});

	it("does not double-count an id recorded twice", () => {
		const state = rebuildState(
			[entry({ kind: "written", ids: ["j-a"] }), entry({ kind: "written", ids: ["j-a"] })],
			TASK,
		);
		expect(state.written).toEqual(["j-a"]);
	});

	it("ignores other extensions' entries and malformed data", () => {
		const state = rebuildState(
			[
				{ type: "custom", customType: "someone-else", data: { kind: "written", ids: ["nope"] } },
				{ type: "custom", customType: STATE_CUSTOM_TYPE, data: { kind: "nonsense" } },
				{ type: "custom", customType: STATE_CUSTOM_TYPE, data: "not an object" },
				entry({ kind: "written", ids: ["j-a"] }),
			],
			TASK,
		);
		expect(state.written).toEqual(["j-a"]);
	});
});

describe("taskFromSessionFile", () => {
	it("takes the uuid out of a timestamped file name", () => {
		expect(taskFromSessionFile("/s/--proj--/2026-08-23T10-00-00_0198f2b0-1111-7000-8000-000000000001.jsonl")).toBe(
			"0198f2b0-1111-7000-8000-000000000001",
		);
	});

	it("handles a bare uuid file name", () => {
		expect(taskFromSessionFile("/s/--proj--/0198f2b0-1111-7000-8000-000000000001.jsonl")).toBe(
			"0198f2b0-1111-7000-8000-000000000001",
		);
	});

	it("falls back to the basename rather than dropping the link", () => {
		// A coarser grouping key beats losing the connection between two halves
		// of one task.
		expect(taskFromSessionFile("/s/--proj--/something-else.jsonl")).toBe("something-else");
	});

	it("returns nothing when there is no previous file", () => {
		expect(taskFromSessionFile(undefined)).toBeUndefined();
	});
});

describe("assistantText", () => {
	it("joins the text blocks of an assistant message", () => {
		expect(
			assistantText({
				role: "assistant",
				content: [
					{ type: "text", text: "I'll run npm install" },
					{ type: "text", text: "then build." },
				],
			}),
		).toBe("I'll run npm install\nthen build.");
	});

	it("excludes thinking and tool calls", () => {
		// A correction answers what the agent *said*; reasoning the user never
		// saw cannot be what they are contradicting.
		expect(
			assistantText({
				role: "assistant",
				content: [
					{ type: "thinking", text: "the user probably wants npm" },
					{ type: "toolCall", name: "bash" },
					{ type: "text", text: "Running the install." },
				],
			}),
		).toBe("Running the install.");
	});

	it("ignores messages that are not the assistant's", () => {
		expect(assistantText({ role: "user", content: [{ type: "text", text: "hi" }] })).toBeUndefined();
	});

	it("returns nothing for a turn with no visible text", () => {
		expect(assistantText({ role: "assistant", content: [{ type: "toolCall", name: "bash" }] })).toBeUndefined();
		expect(assistantText(undefined)).toBeUndefined();
	});
});

describe("AppendQueue", () => {
	it("runs work in order", async () => {
		const queue = new AppendQueue();
		const order: number[] = [];
		queue.enqueue("a", async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			order.push(1);
		});
		queue.enqueue("b", async () => {
			order.push(2);
		});
		await queue.flush();
		expect(order).toEqual([1, 2]);
	});

	it("does not reject into pi's event handlers when a write fails", async () => {
		// A failed append means memory is not working; it must not surface as an
		// extension crash that takes the session with it.
		const queue = new AppendQueue();
		queue.enqueue("failing", async () => {
			throw new Error("store lock is busy");
		});
		queue.enqueue("after", async () => {
			/* still runs */
		});
		await expect(queue.flush()).resolves.toBeUndefined();

		const failures = queue.takeFailures();
		expect(failures).toHaveLength(1);
		expect(failures[0]?.label).toBe("failing");
		expect(failures[0]?.message).toContain("store lock is busy");
		expect(queue.takeFailures()).toEqual([]);
	});

	it("reports how much is still in flight", async () => {
		const queue = new AppendQueue();
		queue.enqueue("slow", () => new Promise((resolve) => setTimeout(resolve, 10)));
		expect(queue.inFlight).toBe(1);
		await queue.flush();
		expect(queue.inFlight).toBe(0);
	});
});
