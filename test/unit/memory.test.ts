import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import { scanJournal } from "../../src/journal/jsonl.ts";
import { type BranchEntry, branchEvidence, evidenceChunks } from "../../src/memory/evidence.ts";
import { extractMemories } from "../../src/memory/extract.ts";
import { MEMORY_STATE_TYPE, type RememberOptions, rememberSession } from "../../src/memory/remember.ts";
import { type MemoryCaller, type MemoryContext, MemoryOperation } from "../../src/memory/runtime.ts";
import { DEFAULT_SETTINGS, resolveSettings } from "../../src/settings.ts";

const roots: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtime(reply: (input: string) => string | Promise<string> = () => '{"memories":[]}') {
	const model = { provider: "fixture", id: "coding", maxTokens: 4096, contextWindow: 128_000 };
	const complete = vi.fn(async (_model, context) => ({
		content: [{ type: "text", text: await reply(context.messages[0].content) }],
		stopReason: "stop",
		usage: { input: 10, output: 5 },
	}));
	const find = vi.fn(() => ({ ...model, id: "memory" }));
	return { ctx: { model, modelRegistry: { complete, find } } as unknown as MemoryContext, complete, find };
}

function outcome(refs: string[], claim = "Use pnpm test --run to finish the CI test job.") {
	return {
		memories: [
			{
				kind: "outcome",
				phase: "test",
				cue: "when CI hangs",
				context: "CI used watch mode.",
				claims: [claim],
				evidence_refs: refs,
			},
		],
	};
}

describe("memory model runtime", () => {
	it("selects a dedicated model without changing the coding model and redacts input before dispatch", async () => {
		const rt = runtime();
		const op = new MemoryOperation(rt.ctx, {
			...DEFAULT_SETTINGS.memory,
			model: { provider: "fixture", id: "memory" },
		});
		try {
			await op.json("Return JSON", { password: "password=abcdefgh12345678" }, (v) => v);
			expect(rt.find).toHaveBeenCalledWith("fixture", "memory");
			expect(rt.complete.mock.calls[0]?.[0]).toMatchObject({ id: "memory" });
			expect(rt.ctx.model?.id).toBe("coding");
			expect(JSON.stringify(rt.complete.mock.calls)).not.toContain("abcdefgh12345678");
			expect(op.usage).toMatchObject({ calls: 1, input: 10, output: 5 });
		} finally {
			op.close();
		}
	});

	it("does not fall back from a missing selected model", () => {
		const rt = runtime();
		rt.find.mockReturnValue(undefined as never);
		expect(
			() => new MemoryOperation(rt.ctx, { ...DEFAULT_SETTINGS.memory, model: { provider: "missing", id: "model" } }),
		).toThrow("unavailable");
		expect(rt.complete).not.toHaveBeenCalled();
	});

	it("repairs invalid JSON only once and never echoes rejected output", async () => {
		const rt = runtime(() => "private bad provider output");
		const op = new MemoryOperation(rt.ctx, DEFAULT_SETTINGS.memory);
		try {
			await expect(op.json("Return JSON", {}, (v) => v)).rejects.toThrow("one format-repair retry");
			expect(rt.complete).toHaveBeenCalledTimes(2);
			expect(JSON.stringify(rt.complete.mock.calls)).not.toContain("private bad provider output");
		} finally {
			op.close();
		}
	});

	it("bounds a provider that ignores cancellation", async () => {
		vi.useFakeTimers();
		const rt = runtime(() => new Promise(() => {}));
		const op = new MemoryOperation(rt.ctx, { ...DEFAULT_SETTINGS.memory, timeoutMs: 1000 });
		const pending = expect(op.json("Return JSON", {}, (v) => v)).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(1001);
		await pending;
		op.close();
	});

	it("rejects over-budget input before sending it", async () => {
		const rt = runtime();
		const op = new MemoryOperation(rt.ctx, DEFAULT_SETTINGS.memory);
		try {
			await expect(op.json("Return JSON", "x".repeat(100_000), (v) => v)).rejects.toThrow("budget");
			expect(rt.complete).not.toHaveBeenCalled();
		} finally {
			op.close();
		}
	});

	it("allows only project restrictions, including object-valued model settings", () => {
		const settings = resolveSettings(
			{ memory: { model: { provider: "local", id: "private" }, maxInputTokens: 5000 } },
			{
				memory: { model: { provider: "remote", id: "expensive" }, maxInputTokens: 6000 },
				recall: { mode: "assisted" },
			},
		);
		expect(settings.settings.memory.model).toEqual({ provider: "local", id: "private" });
		expect(settings.settings.memory.maxInputTokens).toBe(5000);
		expect(settings.settings.recall.mode).toBe("manual");
		expect(settings.warnings).toHaveLength(3);
		expect(
			resolveSettings({ recall: { mode: "assisted" } }, { recall: { mode: "manual" }, memory: { timeoutMs: 1000 } })
				.settings.recall.mode,
		).toBe("manual");
	});
});

const entries: BranchEntry[] = [
	{ id: "e1", type: "message", message: { role: "user", content: "Why does CI hang?" } },
	{
		id: "e2",
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", name: "bash", arguments: { command: "pnpm test --run" } }],
		},
	},
	{
		id: "e3",
		type: "message",
		message: { role: "toolResult", toolName: "bash", content: "All tests passed; exit code 0." },
	},
];

describe("session evidence and extraction", () => {
	it("omits bookkeeping, hidden reasoning, retrospective requests and recall-only answers", () => {
		const source = [
			...entries,
			{ id: "state", type: "custom", data: { secret: "private state" } },
			{ id: "ask", type: "message", message: { role: "user", content: "Remember how we solved this" } },
			{
				id: "thought",
				type: "message",
				message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden thoughts" }] },
			},
			{
				id: "recall",
				type: "message",
				message: { role: "toolResult", toolName: "journal_recall", content: "older solution" },
			},
			{ id: "answer", type: "message", message: { role: "assistant", content: "older solution recapped" } },
		];
		expect(branchEvidence(source, "/repo").map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
	});

	it("keeps early failure and late success in chronological chunks", () => {
		const evidence = branchEvidence(entries, "/repo");
		const first = evidence[0];
		if (!first) throw new Error("fixture missing");
		first.text = `ERROR: early failure\n${"log line\n".repeat(2000)}\nlate verification`;
		const chunks = evidenceChunks(evidence, 2500);
		expect(chunks.flat().map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
		expect(JSON.stringify(chunks)).toContain("early failure");
		expect(JSON.stringify(chunks)).toContain("late verification");
		expect(chunks.every((c) => JSON.stringify(c).length <= 2500)).toBe(true);
	});

	it("renders unknown cause and verification honestly and rejects forged references and authority fields", async () => {
		let raw: unknown = {
			memories: [
				{
					kind: "issue-solution",
					phase: "fix",
					cue: "CI hang",
					symptom: "Tests hang",
					cause: null,
					solution: null,
					failed_attempts: ["Increasing timeout did not help"],
					verification: null,
					applies_when: ["CI"],
					evidence_refs: ["e2"],
				},
			],
		};
		const caller: MemoryCaller = {
			maxInputTokens: 12000,
			signal: new AbortController().signal,
			json: async (_sys, _input, parse) => parse(raw),
		};
		const input = { focus: "", evidence: branchEvidence(entries, "/repo"), prior: [] };
		const records = await extractMemories(caller, input);
		expect(records[0]?.body).toContain("Verification: Unknown");
		expect(records[0]?.source).toBe("agent");
		raw = outcome(["forged"]);
		await expect(extractMemories(caller, input)).rejects.toThrow("evidence");
		raw = { memories: [{ ...outcome(["e2"]).memories[0], source: "user" }] };
		await expect(extractMemories(caller, input)).rejects.toThrow("unknown field");
	});
});

describe("recoverable remembering", () => {
	function setup() {
		const storePath = mkdtempSync(join(tmpdir(), "muninn-memory-"));
		roots.push(storePath);
		const deltas: BranchEntry[] = [];
		const rt = runtime((text) => JSON.stringify(outcome(JSON.parse(text).evidence.map((e: { id: string }) => e.id))));
		const caller = new MemoryOperation(rt.ctx, DEFAULT_SETTINGS.memory);
		const options: RememberOptions = {
			entries,
			cwd: "/repo",
			sessionFile: "/sessions/a.jsonl",
			caller,
			write: { storePath, project: newProjectId(), member: newMemberId(), host: newHostId() },
			base: { task: "task1", channel: "tui" },
			persist: (data) =>
				deltas.push({
					id: `d${deltas.length}`,
					type: "custom",
					customType: MEMORY_STATE_TYPE,
					data: structuredClone(data),
				}),
			appended: () => {},
		};
		return { options, deltas, rt, caller, storePath };
	}

	it("reuses memories on repeated requests and resumes a crash after append before marking done", async () => {
		const { options, deltas, rt, caller, storePath } = setup();
		try {
			const result = await rememberSession({
				...options,
				appended: () => {
					throw new Error("simulated crash after append");
				},
			});
			expect(result.partial).toBe(true);
			expect(scanJournal(storePath).records).toHaveLength(1);
			const resumed = await rememberSession({ ...options, entries: [...entries, ...deltas] });
			expect(resumed.partial).toBe(false);
			expect(scanJournal(storePath).records).toHaveLength(1);
			const again = await rememberSession({ ...options, entries: [...entries, ...deltas] });
			expect(again.ids).toEqual([]);
			expect(again.reused).toHaveLength(1);
			expect(rt.complete).toHaveBeenCalledTimes(1);
		} finally {
			caller.close();
		}
	});

	it("does not mark failed extraction as processed and skips automatic chat", async () => {
		const { options, caller, deltas, storePath } = setup();
		try {
			const failed: MemoryCaller = {
				maxInputTokens: 12000,
				signal: new AbortController().signal,
				json: async () => {
					throw new Error("model offline");
				},
			};
			expect((await rememberSession({ ...options, caller: failed })).partial).toBe(true);
			expect(deltas).toEqual([]);
			expect(scanJournal(storePath).records).toEqual([]);
			await rememberSession({ ...options, entries: entries.slice(0, 1), automatic: true, caller: failed });
			expect(deltas).toEqual([]);
		} finally {
			caller.close();
		}
	});

	it("scopes empty extraction checkpoints to their original project and task", async () => {
		const { options, caller, deltas } = setup();
		const empty: MemoryCaller = {
			maxInputTokens: 12000,
			signal: new AbortController().signal,
			json: vi.fn(async (_sys, _input, parse) => parse({ memories: [] })),
		};
		try {
			await rememberSession({ ...options, caller: empty });
			await rememberSession({ ...options, caller: empty, entries: [...entries, ...deltas] });
			expect(empty.json).toHaveBeenCalledTimes(1);
			await rememberSession({
				...options,
				caller: empty,
				write: { ...options.write, project: newProjectId() },
				entries: [...entries, ...deltas],
			});
			await rememberSession({
				...options,
				caller: empty,
				base: { ...options.base, task: "another-task" },
				entries: [...entries, ...deltas],
			});
			expect(empty.json).toHaveBeenCalledTimes(3);
		} finally {
			caller.close();
		}
	});
});
