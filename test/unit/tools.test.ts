import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MuninnSessionState } from "../../src/capture/session-state.ts";
import { newHostId } from "../../src/ids.ts";
import { SessionIndexes } from "../../src/index/search.ts";
import { appendEntry, type NewJournalEntry } from "../../src/journal/append.ts";
import { readStoreJournal } from "../../src/journal/read.ts";
import type { SessionContext } from "../../src/session.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import type { CaptureTarget } from "../../src/store/scopes.ts";
import { memoryNoteTool } from "../../src/tools/memory-note.ts";
import { memoryReadTool } from "../../src/tools/memory-read.ts";
import { memorySearchTool } from "../../src/tools/memory-search.ts";
import type { ToolRuntime } from "../../src/tools/runtime.ts";

let global: string;
let project: string;
let host: string;
let state: MuninnSessionState;

const SESSION_FILE = "/sessions/2026-08-22_0198f2b0.jsonl";

beforeEach(() => {
	global = mkdtempSync(join(tmpdir(), "muninn-tools-global-"));
	project = mkdtempSync(join(tmpdir(), "muninn-tools-project-"));
	host = newHostId();
	state = { task: "0198f2b0-1111-7000-8000-000000000001", written: [] };
});

afterEach(() => {
	for (const path of [global, project]) {
		chmodSync(path, 0o755);
		rmSync(path, { recursive: true, force: true });
	}
});

function sessionContext(captureTarget: CaptureTarget | null = "project"): SessionContext {
	return {
		host: { id: host, name: "mbp", createdAt: "2026-08-22T00:00:00.000Z" },
		loaded: {
			settings: structuredClone(DEFAULT_SETTINGS),
			warnings: [],
			sources: {
				global: { path: "/home/u/.pi/agent/settings.json", present: true, hasMuninnBlock: false },
				project: { path: "/src/app/.pi/settings.json", present: false, hasMuninnBlock: false },
			},
		},
		scopes: {
			active: [
				{ scope: "global", path: global, exists: true },
				{ scope: "project", path: project, exists: true },
			],
			captureTarget,
			reasons: [],
		},
		problems: [],
	};
}

/** The runtime the extension gives the tools, with the pi parts left out. */
function runtimeFor(session: SessionContext): ToolRuntime {
	const indexes = SessionIndexes.open(session.scopes.active).indexes;
	return {
		settle: async () => {},
		session: () => session,
		indexes: () => indexes,
		state: () => state,
		async append(scope, entry: NewJournalEntry) {
			const storePath = session.scopes.active.find((active) => active.scope === scope)?.path as string;
			const written = await appendEntry(entry, { storePath, hostId: host });
			state.written.push(written.id);
			indexes.addEntry(storePath, { ...written.entry, date: written.date, host, path: written.path });
			return written;
		},
		// Reopen after a direct write in a test, the way a session start would.
	};
}

const ctx = {
	mode: "tui",
	sessionManager: { getSessionFile: () => SESSION_FILE, getLeafId: () => "e5f6g7h8" },
} as unknown as ExtensionContext;

async function run<T>(tool: { execute: (...args: never[]) => Promise<T> }, params: unknown): Promise<T> {
	return tool.execute(...([`call-${Math.random()}`, params, undefined, undefined, ctx] as never[]));
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => block.text ?? "").join("\n");
}

async function seed(storePath: string, entry: Partial<NewJournalEntry> & { claims: string[] }) {
	return appendEntry({ source: "user", prose: "", ...entry } as NewJournalEntry, { storePath, hostId: host });
}

// ---------------------------------------------------------------------------

describe("tool schemas", () => {
	it("memory_search takes a query and the filters the README names", () => {
		const tool = memorySearchTool(runtimeFor(sessionContext()));
		expect(JSON.parse(JSON.stringify(tool.parameters))).toMatchInlineSnapshot(`
			{
			  "properties": {
			    "kind": {
			      "description": "Restrict to journal claims or entry prose. Default: both.",
			      "items": {
			        "anyOf": [
			          {
			            "const": "claim",
			            "type": "string",
			          },
			          {
			            "const": "prose",
			            "type": "string",
			          },
			        ],
			      },
			      "type": "array",
			    },
			    "limit": {
			      "description": "Maximum results. Default 10.",
			      "maximum": 50,
			      "minimum": 1,
			      "type": "integer",
			    },
			    "phase": {
			      "anyOf": [
			        {
			          "const": "locate",
			          "type": "string",
			        },
			        {
			          "const": "reproduce",
			          "type": "string",
			        },
			        {
			          "const": "fix",
			          "type": "string",
			        },
			        {
			          "const": "test",
			          "type": "string",
			        },
			        {
			          "const": "review",
			          "type": "string",
			        },
			        {
			          "const": "ops",
			          "type": "string",
			        },
			        {
			          "const": "other",
			          "type": "string",
			        },
			      ],
			      "description": "Restrict to memories captured during this step of the coding loop.",
			    },
			    "query": {
			      "description": "What to look for. Plain words; the index matches the claim text, its retrieval cue and its heading.",
			      "type": "string",
			    },
			    "scope": {
			      "anyOf": [
			        {
			          "const": "global",
			          "type": "string",
			        },
			        {
			          "const": "project",
			          "type": "string",
			        },
			      ],
			      "description": "Restrict to one memory store. Default: every scope active in this session.",
			    },
			  },
			  "required": [
			    "query",
			  ],
			  "type": "object",
			}
		`);
		expect(tool.executionMode).toBe("parallel");
	});

	it("memory_read takes an id or a path", () => {
		const tool = memoryReadTool(runtimeFor(sessionContext()));
		expect(JSON.parse(JSON.stringify(tool.parameters))).toMatchInlineSnapshot(`
			{
			  "properties": {
			    "id": {
			      "description": "A journal entry (j-…), claim (j-….1), or session pointer taken from an entry.",
			      "type": "string",
			    },
			    "path": {
			      "description": "A path inside an active journal store.",
			      "type": "string",
			    },
			    "range": {
			      "description": "Line range for a path read, as first-last (for example 20-80).",
			      "type": "string",
			    },
			  },
			  "type": "object",
			}
		`);
		expect(tool.executionMode).toBe("parallel");
	});

	it("memory_note takes text, and is the only sequential one", () => {
		const tool = memoryNoteTool(runtimeFor(sessionContext()));
		expect(JSON.parse(JSON.stringify(tool.parameters))).toMatchInlineSnapshot(`
			{
			  "properties": {
			    "cue": {
			      "description": "When would a future session need this? A short situation, such as 'when vitest hangs in CI'. Indexed heavily — it is how memory is found by situation rather than by keyword.",
			      "type": "string",
			    },
			    "phase": {
			      "anyOf": [
			        {
			          "const": "locate",
			          "type": "string",
			        },
			        {
			          "const": "reproduce",
			          "type": "string",
			        },
			        {
			          "const": "fix",
			          "type": "string",
			        },
			        {
			          "const": "test",
			          "type": "string",
			        },
			        {
			          "const": "review",
			          "type": "string",
			        },
			        {
			          "const": "ops",
			          "type": "string",
			        },
			        {
			          "const": "other",
			          "type": "string",
			        },
			      ],
			      "description": "The step of the coding loop this belongs to. Retrieval filters by it.",
			    },
			    "scope": {
			      "anyOf": [
			        {
			          "const": "global",
			          "type": "string",
			        },
			        {
			          "const": "project",
			          "type": "string",
			        },
			      ],
			      "description": "Which store to write to. Default: this session's capture target — the project store when one is active, otherwise global.",
			    },
			    "text": {
			      "description": "What to remember. Every line starting with '- ' becomes its own claim; anything else is context around them. Text with no bullets is taken as one claim.",
			      "type": "string",
			    },
			  },
			  "required": [
			    "text",
			  ],
			  "type": "object",
			}
		`);
		expect(tool.executionMode).toBe("sequential");
	});
});

describe("memory_search", () => {
	it("finds a claim and returns its full id, date and provenance", async () => {
		const written = await seed(project, {
			phase: "test",
			cue: "when the CI job hangs",
			claims: ["Run `pnpm test --run`; vitest watch mode hangs the CI job."],
		});

		const tool = memorySearchTool(runtimeFor(sessionContext()));
		const text = textOf(await run(tool, { query: "vitest watch" }));

		expect(text).toContain("watch mode hangs the CI job");
		expect(text).toContain(`id: ${written.claimIds[0]}`);
		expect(text).toContain("source: user");
		expect(text).toContain("scope: project");
		expect(text).toContain("cue: when the CI job hangs");
	});

	it("restricts to one scope when asked", async () => {
		await seed(global, { claims: ["Always use pnpm, never npm."] });
		await seed(project, { claims: ["This repository pins node 22."] });
		const tool = memorySearchTool(runtimeFor(sessionContext()));

		expect(textOf(await run(tool, { query: "pnpm node", scope: "project" }))).toContain("node 22");
		expect(textOf(await run(tool, { query: "pnpm node", scope: "project" }))).not.toContain("never npm");
	});

	it("honours the limit", async () => {
		for (let index = 0; index < 5; index++) {
			await seed(project, { claims: [`Claim number ${index} about the CI runner.`] });
		}
		const tool = memorySearchTool(runtimeFor(sessionContext()));
		expect(textOf(await run(tool, { query: "CI runner", limit: 2 }))).toContain("2 journal records");
	});
});

describe("memory_read", () => {
	it("reads a whole entry: its context, its claims and their addresses", async () => {
		const written = await seed(project, {
			prose: "The CI job hung for twenty minutes.",
			cue: "when the CI job hangs",
			claims: ["vitest watch mode hangs the CI job.", "The runner has no TTY."],
		});

		const tool = memoryReadTool(runtimeFor(sessionContext()));
		const text = textOf(await run(tool, { id: written.id }));

		expect(text).toContain("The CI job hung for twenty minutes.");
		expect(text).toContain(`${written.id}.1`);
		expect(text).toContain(`${written.id}.2`);
		expect(text).toContain("cue: when the CI job hangs");
	});

	it("shows a claim inside the entry it came from, marked", async () => {
		const written = await seed(project, {
			prose: "Context around it.",
			claims: ["First claim.", "Second claim."],
		});
		const tool = memoryReadTool(runtimeFor(sessionContext()));
		const text = textOf(await run(tool, { id: `${written.id}.2` }));

		expect(text).toContain("Context around it.");
		expect(text).toMatch(new RegExp(`→ ${written.id.replace(/[-.]/g, "\\$&")}\\.2`));
	});

	it("fails by name on an id nothing has", async () => {
		const tool = memoryReadTool(runtimeFor(sessionContext()));
		await expect(run(tool, { id: "j-01a02e19-f1c6-7142-bcb1-2806083bd725" })).rejects.toThrow(/no journal entry/);
	});

	it("reads a journal-store file, with line numbers, and a range", async () => {
		writeFileSync(join(project, "store.md"), "# Store\n\n- one\n- two\n- three\n");
		const tool = memoryReadTool(runtimeFor(sessionContext()));

		const whole = textOf(await run(tool, { path: "store.md" }));
		expect(whole).toContain("project:store.md");
		expect(whole).toContain("3  - one");

		const range = textOf(await run(tool, { path: "store.md", range: "4-5" }));
		expect(range).toContain("lines 4–5");
		expect(range).not.toContain("- one");
	});

	it("refuses a path that leaves the store", async () => {
		const tool = memoryReadTool(runtimeFor(sessionContext()));
		await expect(run(tool, { path: "../../etc/passwd" })).rejects.toThrow(
			/not a readable file in any active memory store/,
		);
		await expect(run(tool, { path: "/etc/hosts" })).rejects.toThrow(/not a readable file in any active memory store/);
	});

	it("follows a session pointer into pi's own transcript", async () => {
		const sessionFile = join(project, "transcript.jsonl");
		// Only transcripts the journal points at can be opened, so the entry that
		// points at this one has to exist first.
		await seed(project, { claims: ["Something was learned here."], session: `${sessionFile}#b2` });
		writeFileSync(
			sessionFile,
			[
				JSON.stringify({
					type: "message",
					id: "a1",
					timestamp: "t1",
					message: { role: "user", content: "why does CI hang?" },
				}),
				JSON.stringify({
					type: "message",
					id: "b2",
					timestamp: "t2",
					message: { role: "assistant", content: [{ type: "text", text: "the runner has no TTY" }] },
				}),
				"",
			].join("\n"),
		);

		const tool = memoryReadTool(runtimeFor(sessionContext()));
		const text = textOf(await run(tool, { id: `session:${sessionFile}#b2` }));

		expect(text).toContain("why does CI hang?");
		expect(text).toContain("→ assistant");
		expect(text).toContain("the runner has no TTY");
	});

	it("follows a session pointer whose path contains a hash", async () => {
		// pi embeds the project directory in the session file's name and only
		// rewrites `/`, `\\` and `:` — so a project called `proj#1` puts a `#`
		// in the path, and splitting on the first one truncates it.
		const dir = join(project, "--Users-me-proj#1--");
		mkdirSync(dir, { recursive: true });
		const sessionFile = join(dir, "2026-08-22_abc.jsonl");
		await seed(project, { claims: ["Learned in proj#1."], session: `${sessionFile}#b2` });
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "message", id: "b2", timestamp: "t", message: { role: "assistant", content: "found it" } })}\n`,
		);

		const tool = memoryReadTool(runtimeFor(sessionContext()));
		const text = textOf(await run(tool, { id: `session:${sessionFile}#b2` }));
		expect(text).toContain("found it");
	});

	it("tells the model when its note was redacted", async () => {
		const tool = memoryNoteTool(runtimeFor(sessionContext()));
		const text = textOf(
			await run(tool, { text: "The token is sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef and it works." }),
		);
		expect(text).toContain("(secrets redacted)");
	});

	it("refuses a transcript no memory points at", async () => {
		// Tool arguments are model-controlled, and a model reads text other
		// people wrote. Without this, "read the session at /etc/…" is a
		// local-file read primitive for anything that can get a sentence in
		// front of the model.
		const elsewhere = join(project, "private.jsonl");
		writeFileSync(
			elsewhere,
			`${JSON.stringify({ type: "message", id: "x", message: { role: "user", content: "secret" } })}\n`,
		);

		const tool = memoryReadTool(runtimeFor(sessionContext()));
		await expect(run(tool, { id: `session:${elsewhere}#x` })).rejects.toThrow(
			/only opens transcripts the journal refers to/,
		);
		await expect(run(tool, { id: "session:/etc/hosts.jsonl#x" })).rejects.toThrow(
			/not a session file any memory points at/,
		);
	});

	it("refuses a symlink that leaves the store", async () => {
		// `resolve()` normalises `..` but knows nothing about symlinks: a link
		// inside the store passes a lexical prefix test and is then read.
		const outside = join(global, "..", "outside-any-store.md");
		writeFileSync(outside, "a secret from outside every store\n");
		symlinkSync(outside, join(project, "escape.md"));

		const tool = memoryReadTool(runtimeFor(sessionContext()));
		await expect(run(tool, { path: "escape.md" })).rejects.toThrow(/not a readable file in any active memory store/);
		rmSync(outside, { force: true });
	});

	it("needs something to read", async () => {
		const tool = memoryReadTool(runtimeFor(sessionContext()));
		await expect(run(tool, {})).rejects.toThrow(/needs either an id or a path/);
	});
});

describe("memory_note", () => {
	it("writes one entry attributed to the agent, into the capture target", async () => {
		const tool = memoryNoteTool(runtimeFor(sessionContext()));
		const text = textOf(
			await run(tool, {
				text: "The runner has no TTY.\n- Use --run in CI.\n- Never start watch mode headless.",
				phase: "test",
				cue: "when CI hangs",
			}),
		);

		expect(text).toContain("Remembered in the project store as j-");

		const journal = readStoreJournal(project);
		expect(journal.entries).toHaveLength(1);
		const entry = journal.entries[0];
		expect(entry?.source).toBe("agent");
		expect(entry?.channel).toBe("tui");
		expect(entry?.phase).toBe("test");
		expect(entry?.cue).toBe("when CI hangs");
		expect(entry?.claims).toEqual(["Use --run in CI.", "Never start watch mode headless."]);
		expect(entry?.prose).toBe("The runner has no TTY.");
		expect(entry?.task).toBe(state.task);
		expect(entry?.session).toBe(`${SESSION_FILE}#e5f6g7h8`);
		// Nothing was written to the other scope.
		expect(readStoreJournal(global).entries).toEqual([]);
	});

	it("takes text with no bullets as a single claim", async () => {
		const tool = memoryNoteTool(runtimeFor(sessionContext()));
		await run(tool, { text: "Deploys go through staging first." });
		expect(readStoreJournal(project).entries[0]?.claims).toEqual(["Deploys go through staging first."]);
	});

	it("writes to the scope it is told to", async () => {
		const tool = memoryNoteTool(runtimeFor(sessionContext()));
		await run(tool, { text: "Always use pnpm.", scope: "global" });
		expect(readStoreJournal(global).entries).toHaveLength(1);
		expect(readStoreJournal(project).entries).toEqual([]);
	});

	it("fails loudly on a read-only store instead of writing somewhere else", async () => {
		// The plan's "done when": a write that cannot happen must be reported,
		// never redirected — a model told a memory was stored has no way to find
		// out that it went somewhere it will never look.
		chmodSync(project, 0o555);
		const tool = memoryNoteTool(runtimeFor(sessionContext()));

		// The 5 s lock budget is spent first: a store that cannot be locked is
		// indistinguishable from one held by another process until the wait is
		// over. Slow, and correct in the order it tries things.
		const failure = await run(tool, { text: "This cannot be written." }).catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain(project);
		chmodSync(project, 0o755);
		expect(readStoreJournal(global).entries).toEqual([]);
		expect(readStoreJournal(project).entries).toEqual([]);
	});

	it("says so when no scope is active at all", async () => {
		const session = sessionContext(null);
		session.scopes.active = [];
		const tool = memoryNoteTool(runtimeFor(session));
		await expect(run(tool, { text: "Nowhere to put this." })).rejects.toThrow(/nowhere to write/);
	});

	it("refuses a scope this session does not have", async () => {
		const session = sessionContext("global");
		session.scopes.active = [{ scope: "global", path: global, exists: true }];
		const tool = memoryNoteTool(runtimeFor(session));
		await expect(run(tool, { text: "No project here.", scope: "project" })).rejects.toThrow(
			/not active in this session/,
		);
	});
});
