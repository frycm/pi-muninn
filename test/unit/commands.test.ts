import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MuninnSessionState } from "../../src/capture/session-state.ts";
import { type CommandRuntime, parseFlags, runMuninnCommand, USAGE } from "../../src/commands/muninn.ts";
import type { DreamListing } from "../../src/dream/dreams.ts";
import { emptyReport } from "../../src/dream/report.ts";
import { newHostId } from "../../src/ids.ts";
import { SessionIndexes } from "../../src/index/search.ts";
import { appendEntry, type NewJournalEntry } from "../../src/journal/append.ts";
import { readStoreJournal } from "../../src/journal/read.ts";
import type { SessionContext } from "../../src/session.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import type { CaptureTarget } from "../../src/store/scopes.ts";

let global: string;
let project: string;
let host: string;
let state: MuninnSessionState;
let created: number;
let synced: number;

const SESSION_POINTER = "/sessions/2026-08-22_0198f2b0.jsonl#e5f6g7h8";

beforeEach(() => {
	global = mkdtempSync(join(tmpdir(), "muninn-cmd-global-"));
	project = mkdtempSync(join(tmpdir(), "muninn-cmd-project-"));
	host = newHostId();
	state = { task: "0198f2b0-1111-7000-8000-000000000001", recalled: [], written: [] };
	created = 0;
	synced = 0;
});

afterEach(() => {
	for (const path of [global, project]) rmSync(path, { recursive: true, force: true });
});

function sessionContext(
	options: { captureTarget?: CaptureTarget | null; scopes?: Array<"global" | "project"> } = {},
): SessionContext {
	const names = options.scopes ?? ["global", "project"];
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
			active: names.map((name) =>
				name === "global"
					? { scope: "global" as const, path: global, exists: true, inRepo: false }
					: { scope: "project" as const, path: project, exists: true, inRepo: false, slug: `app-${basename(project)}` },
			),
			captureTarget: options.captureTarget === undefined ? "project" : options.captureTarget,
			reasons: ["global: active", "project: active, separate store at /p", "capture target: project"],
		},
		problems: [],
	};
}

let dreamt = 0;

let dreamListing: DreamListing[] = [];
let derivedShape: { topics: Array<{ slug: string; facts: number; title: string }>; rules: string[] } = {
	topics: [],
	rules: [],
};

function runtimeFor(session: SessionContext): CommandRuntime {
	let indexes = SessionIndexes.open(session.scopes.active).indexes;
	return {
		load: async ({ createStores }) => {
			if (createStores) created++;
			return session;
		},
		settle: async () => {},
		indexes: () => indexes,
		state: () => state,
		async append(scope, entry: NewJournalEntry) {
			const storePath = session.scopes.active.find((active) => active.scope === scope)?.path as string;
			const written = await appendEntry(entry, { storePath, hostId: host });
			indexes.addEntry(storePath, { ...written.entry, date: written.date, host, path: written.path });
			return written;
		},
		async reindex() {
			indexes = SessionIndexes.open(session.scopes.active, { force: true }).indexes;
			return indexes.size;
		},
		async sync() {
			synced++;
			return [
				{
					scope: "project" as const,
					result: {
						committed: true,
						fetched: false,
						rebased: false,
						pushed: false,
						mergedRegistry: false,
						notes: ["no sync.remote configured — committed locally only"],
					},
				},
			];
		},
		statusReport: () => "⟡ muninn 0.1.0 · status report",
		channel: () => "tui",
		sessionPointer: () => SESSION_POINTER,

		// The dreaming half, stubbed: these tests are about the command surface —
		// what it prints, which arguments it accepts, what it refuses — and the
		// dream itself has its own tests over a real store.
		dream: async (options) => {
			dreamt++;
			options.progress("orient");
			options.progress("commit");
			return {
				ok: true,
				stamp: "2026-08-23T03-00",
				branch: "dream/mbp/2026-08-23T03-00",
				report: {
					...emptyReport({ stamp: "2026-08-23T03-00", scope: "project", host: "mbp", started: "" }),
					consolidated: [{ topic: "testing", added: 2, superseded: 1, addedIds: ["f-testing-x"] }],
					gathered: ["3 entries in range"],
				},
				problems: [],
			};
		},
		dreams: async () => dreamListing,
		remember: async (_scope, stamp) => ({ ok: true, problems: [], notes: [`remembered ${stamp}`] }),
		forget: async (_scope, stamp) => ({ ok: true, problems: [], notes: [`reverted ${stamp}`] }),
		erase: async (_scope, entryId) => ({ ok: true, problems: [], notes: [`${entryId} is tombstoned`] }),
		eraseImpact: () => ({ claims: ["j-x.1"], facts: ["f-testing-x"] }),
		derived: () => derivedShape,
	};
}

async function seed(storePath: string, entry: Partial<NewJournalEntry> & { claims: string[] }) {
	return appendEntry({ source: "user", prose: "", ...entry } as NewJournalEntry, { storePath, hostId: host });
}

describe("parseFlags", () => {
	it("takes leading flags and leaves the text alone", () => {
		const { flags, rest } = parseFlags("--global remember the --force flag", { flags: ["global"] });
		expect([...flags]).toEqual(["global"]);
		expect(rest).toBe("remember the --force flag");
	});

	it("leaves an unknown leading flag in the text rather than eating it", () => {
		// `--no-verify is required for the hook` is a note *about* a flag.
		const { flags, rest } = parseFlags("--no-verify is required for the pre-commit hook", { flags: ["global"] });
		expect([...flags]).toEqual([]);
		expect(rest).toBe("--no-verify is required for the pre-commit hook");
	});

	it("reads a valued flag", () => {
		const { values, rest } = parseFlags("--limit 3 vitest watch", { valued: ["limit"] });
		expect(values.get("limit")).toBe("3");
		expect(rest).toBe("vitest watch");
	});
});

describe("/muninn", () => {
	it("defaults to the status report", async () => {
		const output = await runMuninnCommand("", runtimeFor(sessionContext()));
		expect(output.level).toBe("info");
		expect(output.text).toContain("status report");
	});

	it("prints usage for an unknown subcommand rather than failing", async () => {
		const output = await runMuninnCommand("dreamm", runtimeFor(sessionContext()));
		expect(output.level).toBe("warning");
		expect(output.text).toContain('unknown subcommand "dreamm"');
		expect(output.text).toContain(USAGE);
	});

	it("prints usage on request", async () => {
		expect((await runMuninnCommand("help", runtimeFor(sessionContext()))).text).toBe(USAGE);
	});

	it("syncs, and reports every note the transaction produced", async () => {
		const output = await runMuninnCommand("sync", runtimeFor(sessionContext()));
		expect(synced).toBe(1);
		expect(output.level).toBe("info");
		expect(output.text).toContain("project: sync: committed");
		expect(output.text).toContain("no sync.remote configured");
	});
});

describe("/muninn scope", () => {
	it("explains the situation without creating a store", async () => {
		const output = await runMuninnCommand("scope", runtimeFor(sessionContext()));
		expect(output.text).toContain("capture target: project");
		expect(created).toBe(0);
	});
});

describe("/muninn note", () => {
	it("writes to the capture target, as source: user", async () => {
		const output = await runMuninnCommand("note Deploys need the VPN.", runtimeFor(sessionContext()));

		expect(output.text).toContain("noted in the project store as j-");
		const entry = readStoreJournal(project).entries[0];
		expect(entry?.source).toBe("user");
		expect(entry?.channel).toBe("tui");
		expect(entry?.claims).toEqual(["Deploys need the VPN."]);
		expect(entry?.task).toBe(state.task);
		expect(entry?.session).toBe(SESSION_POINTER);
		expect(readStoreJournal(global).entries).toEqual([]);
	});

	it("writes to global with --global", async () => {
		await runMuninnCommand("note --global Always use pnpm.", runtimeFor(sessionContext()));
		expect(readStoreJournal(global).entries).toHaveLength(1);
		expect(readStoreJournal(project).entries).toEqual([]);
	});

	it("splits bullets into claims and keeps the rest as context", async () => {
		await runMuninnCommand(
			"note The CI runner has no TTY.\n- Use --run in CI.\n- Never watch mode headless.",
			runtimeFor(sessionContext()),
		);
		const entry = readStoreJournal(project).entries[0];
		expect(entry?.prose).toBe("The CI runner has no TTY.");
		expect(entry?.claims).toEqual(["Use --run in CI.", "Never watch mode headless."]);
	});

	it("asks for text when given none", async () => {
		const output = await runMuninnCommand("note", runtimeFor(sessionContext()));
		expect(output.level).toBe("warning");
		expect(output.text).toContain("/muninn note [--global] <text>");
	});

	it("says so when there is nowhere to write", async () => {
		// The rule is `resolveWriteScope`'s, shared with memory_note; it throws,
		// and the command handler in the extension turns that into an error line.
		const session = sessionContext({ captureTarget: null, scopes: [] });
		await expect(runMuninnCommand("note Nowhere.", runtimeFor(session))).rejects.toThrow(/nowhere to write/);
	});
});

describe("/muninn promote", () => {
	it("copies a project entry into the global journal, naming where it came from", async () => {
		const written = await seed(project, {
			phase: "test",
			cue: "when CI hangs",
			prose: "Context.",
			claims: ["vitest watch mode hangs the CI job."],
			session: SESSION_POINTER,
		});
		const session = sessionContext();
		const output = await runMuninnCommand(`promote ${written.id}`, runtimeFor(session));

		expect(output.level).toBe("info");
		const promoted = readStoreJournal(global).entries[0];
		expect(promoted?.claims).toEqual(["vitest watch mode hangs the CI job."]);
		expect(promoted?.cue).toBe("when CI hangs");
		expect(promoted?.phase).toBe("test");
		expect(promoted?.session).toBe(SESSION_POINTER);
		expect(promoted?.promotedFrom).toBe(`${session.scopes.active[1]?.slug}/${written.id}`);
		// A copy, not a move: the journal is append-only.
		expect(readStoreJournal(project).entries).toHaveLength(1);
	});

	it("accepts a claim id and promotes the entry it belongs to", async () => {
		const written = await seed(project, { claims: ["First.", "Second."] });
		await runMuninnCommand(`promote ${written.claimIds[1]}`, runtimeFor(sessionContext()));
		expect(readStoreJournal(global).entries[0]?.claims).toEqual(["First.", "Second."]);
	});

	it("refuses to promote what is already global", async () => {
		const written = await seed(global, { claims: ["Already here."] });
		const output = await runMuninnCommand(`promote ${written.id}`, runtimeFor(sessionContext()));
		expect(output.level).toBe("warning");
		expect(output.text).toContain("already in the global journal");
	});

	it("reports an id that is not an entry id", async () => {
		const output = await runMuninnCommand("promote not-an-id", runtimeFor(sessionContext()));
		expect(output.level).toBe("error");
		expect(output.text).toContain("not a journal entry id");
	});

	it("asks for an id when given none", async () => {
		expect((await runMuninnCommand("promote", runtimeFor(sessionContext()))).text).toContain(
			"/muninn promote <entry id>",
		);
	});
});

describe("/muninn search", () => {
	it("lists one compact line per hit", async () => {
		await seed(project, { cue: "when CI hangs", claims: ["vitest watch mode hangs the CI job."] });
		const output = await runMuninnCommand("search vitest watch", runtimeFor(sessionContext()));

		expect(output.text).toContain('1 memory for "vitest watch"');
		expect(output.text).toContain("· project · user ·");
		expect(output.text).toContain("when CI hangs");
	});

	it("suggests history when nothing active matches", async () => {
		const output = await runMuninnCommand("search nothing here", runtimeFor(sessionContext()));
		expect(output.text).toContain("/muninn search --history");
	});

	it("includes superseded memories with --history, marked", async () => {
		const written = await seed(project, { claims: ["Tests run with `pnpm test`."] });
		writeFileSync(join(project, "supersessions.md"), `- ${written.claimIds[0]} · valid_to: 2026-08-23\n`);
		const output = await runMuninnCommand("search --history tests run", runtimeFor(sessionContext()));

		expect(output.text).toContain("(including superseded)");
		expect(output.text).toContain("· superseded");
	});

	it("honours --limit", async () => {
		for (let index = 0; index < 4; index++) await seed(project, { claims: [`Claim ${index} about the CI runner.`] });
		const output = await runMuninnCommand("search --limit 2 CI runner", runtimeFor(sessionContext()));
		expect(output.text).toContain("2 memories");
	});

	it("asks for a query when given none", async () => {
		expect((await runMuninnCommand("search", runtimeFor(sessionContext()))).level).toBe("warning");
	});
});

describe("/muninn reindex", () => {
	it("rebuilds and reports the chunk count", async () => {
		await seed(project, { claims: ["A claim to index."] });
		const output = await runMuninnCommand("reindex", runtimeFor(sessionContext()));
		expect(output.text).toMatch(/index rebuilt — \d+ chunks?/);
	});
});

describe("parseFlags — text is left verbatim", () => {
	it("keeps the line structure a note depends on", () => {
		// `/muninn note` reads line starts to tell a claim from its context, so a
		// parser that rejoined words would silently merge three bullets into one.
		const { rest } = parseFlags("--global Context.\n- one\n- two", { flags: ["global"] });
		expect(rest).toBe("Context.\n- one\n- two");
	});

	it("does not treat a flag-looking word inside the text as a flag", () => {
		const { flags, rest } = parseFlags("use the --run flag in CI");
		expect([...flags]).toEqual([]);
		expect(rest).toBe("use the --run flag in CI");
	});
});

describe("/muninn dream and the dreaming surface", () => {
	it("reports what a dream did, and how to apply it", async () => {
		const output = await runMuninnCommand("dream", runtimeFor(sessionContext()));
		expect(dreamt).toBe(1);
		expect(output.level).toBe("info");
		expect(output.text).toContain("dream/mbp/2026-08-23T03-00");
		expect(output.text).toContain("testing: +2 fact(s), 1 superseded");
		expect(output.text).toContain("/muninn dreams remember 2026-08-23T03-00");
	});

	it("refuses a scope that is not a scope", async () => {
		const output = await runMuninnCommand("dream --scope everything", runtimeFor(sessionContext()));
		expect(output.level).toBe("warning");
		expect(output.text).toContain('"global" or "project"');
	});

	it("says there are no dreams rather than printing an empty list", async () => {
		dreamListing = [];
		const output = await runMuninnCommand("dreams", runtimeFor(sessionContext()));
		expect(output.text).toContain("no dreams yet");
	});

	it("lists a pending dream, a remembered one and a forgotten one", async () => {
		dreamListing = [
			{ stamp: "2026-08-25T03-00", branch: "dream/mbp/2026-08-25T03-00", remembered: false, forgotten: false },
			{ stamp: "2026-08-24T03-00", sha: "abc", remembered: true, forgotten: false },
			{ stamp: "2026-08-23T03-00", sha: "def", remembered: true, forgotten: true },
		];
		const output = await runMuninnCommand("dreams", runtimeFor(sessionContext()));
		expect(output.text).toContain("2026-08-25T03-00  pending");
		expect(output.text).toContain("2026-08-24T03-00  remembered");
		expect(output.text).toContain("2026-08-23T03-00  forgotten");
	});

	it("says the new memory arrives next session, not this one", async () => {
		// The snapshot is frozen for a session's whole life by design, so
		// "remembered" without this would look like nothing happened.
		dreamListing = [{ stamp: "s", branch: "dream/mbp/s", remembered: false, forgotten: false }];
		const output = await runMuninnCommand("dreams remember s", runtimeFor(sessionContext()));
		expect(output.level).toBe("info");
		expect(output.text).toContain("next one reads the new MEMORY.md");
	});

	it("needs a stamp, and refuses a verb it does not have", async () => {
		expect((await runMuninnCommand("dreams remember", runtimeFor(sessionContext()))).text).toContain(
			"needs a dream stamp",
		);
		expect((await runMuninnCommand("dreams ponder x", runtimeFor(sessionContext()))).text).toContain(
			'"remember" or "forget"',
		);
	});
});

describe("/muninn topics and rules", () => {
	it("says topics are written by dreams when there are none", async () => {
		derivedShape = { topics: [], rules: [] };
		expect((await runMuninnCommand("topics", runtimeFor(sessionContext()))).text).toContain("/muninn dream");
	});

	it("says rules are yours to write, not something dreams have not got to", async () => {
		derivedShape = { topics: [], rules: [] };
		const output = await runMuninnCommand("rules", runtimeFor(sessionContext()));
		expect(output.text).toContain("written by hand");
		expect(output.text).toContain("do not write it");
	});

	it("lists what is there", async () => {
		derivedShape = {
			topics: [{ slug: "testing", facts: 3, title: "Testing" }],
			rules: ["R-014 · test — Run `pnpm test --run`."],
		};
		expect((await runMuninnCommand("topics", runtimeFor(sessionContext()))).text).toContain("testing");
		expect((await runMuninnCommand("rules", runtimeFor(sessionContext()))).text).toContain("R-014");
	});
});

describe("/muninn erase", () => {
	it("prints the impact and refuses until it is confirmed twice", async () => {
		const output = await runMuninnCommand(
			"erase j-0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01 --yes",
			runtimeFor(sessionContext()),
		);
		expect(output.level).toBe("warning");
		expect(output.text).toContain("1 claim(s), 1 fact(s)");
		expect(output.text).toContain("cannot be undone");
		expect(output.text).toContain("--yes --yes");
	});

	it("goes ahead on the second confirmation", async () => {
		const output = await runMuninnCommand(
			"erase j-0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01 --yes --yes",
			runtimeFor(sessionContext()),
		);
		expect(output.level).toBe("info");
		expect(output.text).toContain("tombstoned");
	});

	it("needs an entry id", async () => {
		const output = await runMuninnCommand("erase --yes --yes", runtimeFor(sessionContext()));
		expect(output.text).toContain("needs a journal entry id");
	});
});
