import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MuninnSessionState } from "../../src/capture/session-state.ts";
import { type CommandRuntime, runMuninnCommand, splitArgs, USAGE } from "../../src/commands/muninn.ts";
import { newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import { scanJournal } from "../../src/journal/jsonl.ts";
import { JournalQueryService } from "../../src/journal/query.ts";
import type { NewJournalRecord } from "../../src/journal/record.ts";
import { appendAuthorizedJournalRecord, appendUserRelation } from "../../src/journal/writer.ts";
import type { SessionContext } from "../../src/session.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";

let store: string;
let projectId: string;
let memberId: string;
let hostId: string;
let state: MuninnSessionState;
let query: JournalQueryService;
let synced: number;

beforeEach(() => {
	store = mkdtempSync(join(tmpdir(), "muninn-command-"));
	projectId = newProjectId();
	memberId = newMemberId();
	hostId = newHostId();
	state = { task: "0198f2b0-1111-7000-8000-000000000001", written: [] };
	query = new JournalQueryService({ storePath: store, localMember: memberId, mode: "index" });
	synced = 0;
});

afterEach(() => {
	rmSync(store, { recursive: true, force: true });
});

function sessionContext(): SessionContext {
	return {
		host: { id: hostId, name: "workstation", createdAt: "2026-09-01T00:00:00.000Z" },
		loaded: {
			settings: structuredClone(DEFAULT_SETTINGS),
			warnings: [],
			sources: {
				global: { path: "/agent/settings.json", present: false, hasMuninnBlock: false },
				project: { path: "/src/app/.pi/settings.json", present: false, hasMuninnBlock: false },
			},
		},
		project: {
			id: projectId,
			name: "app",
			storePath: store,
			registryPath: "/agent/muninn-projects/registry.json",
			member: { id: memberId, name: "martin", createdAt: "2026-09-01T00:00:00.000Z" },
			root: "/src/app",
			gitCommonDir: "/src/app/.git",
			locations: [{ root: "/src/app", gitCommonDir: "/src/app/.git", linkedAt: "2026-09-01T00:00:00.000Z" }],
			reason: "root",
			reasonDetail: "canonical root mapping /src/app",
		},
		scopes: {
			active: [{ scope: "project", path: store, exists: true, projectId }],
			captureTarget: "project",
			reasons: ["project: active", "capture target: project"],
		},
		problems: [],
	};
}

function runtime(): CommandRuntime {
	return {
		load: async () => sessionContext(),
		settle: async () => {},
		query: () => query,
		state: () => state,
		async appendUser(record) {
			const written = await appendAuthorizedJournalRecord(
				{ authority: "attended-user", record },
				{ storePath: store, project: projectId, member: memberId, host: hostId },
			);
			query.add(written.record);
			return written;
		},
		async appendRelation(target, text, relation) {
			const written = await appendUserRelation({
				authority: "attended-user",
				target,
				text,
				relation,
				channel: "tui",
				storePath: store,
				project: projectId,
				member: memberId,
				host: hostId,
				task: state.task,
			});
			query.add(written.record);
			return written;
		},
		async reindex() {
			query.refresh(true);
			return query.size;
		},
		async sync() {
			synced++;
			return [
				{
					scope: "project",
					result: {
						committed: true,
						fetched: false,
						rebased: false,
						pushed: false,
						mergedManifest: false,
						notes: ["committed locally"],
					},
				},
			];
		},
		statusReport: () => "⟡ muninn 0.1.0 · project journal",
	};
}

async function seed(body: string, extra: Partial<NewJournalRecord> = {}) {
	const written = await appendAuthorizedJournalRecord(
		{
			authority: "attended-user",
			record: {
				type: "note",
				source: "user",
				channel: "tui",
				body,
				tags: [],
				paths: [],
				relations: [],
				...extra,
			},
		},
		{ storePath: store, project: projectId, member: memberId, host: hostId },
	);
	query.add(written.record);
	return written;
}

describe("attended command parsing", () => {
	it("keeps quoted queries together without touching direct note text", () => {
		expect(splitArgs('--branch "feature/auth" "database migration"')).toEqual([
			"--branch",
			"feature/auth",
			"database migration",
		]);
	});

	it("prints the new usage for help and unknown commands", async () => {
		expect((await runMuninnCommand("help", runtime())).text).toBe(USAGE);
		const unknown = await runMuninnCommand("promote old", runtime());
		expect(unknown.level).toBe("warning");
		expect(unknown.text).toContain("unknown subcommand");
	});
});

describe("/muninn project journal", () => {
	it("defaults to status and shows the project mapping", async () => {
		expect((await runMuninnCommand("", runtime())).text).toContain("project journal");
		const project = await runMuninnCommand("project", runtime());
		expect(project.text).toContain(projectId);
		expect(project.text).toContain("git common dir: /src/app/.git");
	});

	it("writes direct user notes and preserves text", async () => {
		const output = await runMuninnCommand("note Use --run in CI.\nKeep this line.", runtime());
		expect(output.text).toContain("appended note j-");
		const record = scanJournal(store).records[0]?.record;
		expect(record?.source).toBe("user");
		expect(record?.body).toBe("Use --run in CI.\nKeep this line.");
		expect(record?.task).toBe(state.task);
	});

	it("searches, shows, filters, tails, and groups sessions through one service", async () => {
		const written = await seed("Vitest watch mode hangs the CI runner.", {
			cue: "when CI hangs",
			session: { file: "/sessions/task.jsonl", last: "entry-1" },
			git: { cwd: "/src/app", branch: "feature/ci", head: null, dirty: false },
		});
		const searched = await runMuninnCommand('search "vitest watch" --branch feature/ci', runtime());
		expect(searched.text).toContain(written.id);
		const shown = await runMuninnCommand(`show ${written.id}`, runtime());
		expect(shown.text).toContain("CI runner");
		const sessions = await runMuninnCommand("sessions --branch feature/ci", runtime());
		expect(sessions.text).toContain("/sessions/task.jsonl");
		const tail = await runMuninnCommand("tail --limit 1", runtime());
		expect(tail.text).toContain(written.id);
	});

	it("appends corrections and annotations while retaining the original", async () => {
		const target = await seed("The service uses PostgreSQL 16.");
		const corrected = await runMuninnCommand(`correct ${target.id} It now uses PostgreSQL 17.`, runtime());
		expect(corrected.text).toContain("appended correction");
		await runMuninnCommand(`annotate ${target.id} Historical note only.`, runtime());
		const chain = query.read(target.id, 5)?.records ?? [];
		expect(chain).toHaveLength(3);
		expect(chain.find((record) => record.id === target.id)?.body).toContain("16");
		expect(
			chain.filter((record) => record.relations[0]?.target === target.id).map((record) => record.relations[0]?.type),
		).toEqual(expect.arrayContaining(["corrects", "annotates"]));
	});

	it("reports missing targets rather than creating dangling user corrections", async () => {
		const missing = "j-0198f2b0-1111-7000-8000-000000000099";
		const output = await runMuninnCommand(`correct ${missing} New text.`, runtime());
		expect(output.level).toBe("warning");
		expect(scanJournal(store).records).toHaveLength(0);
	});

	it("rebuilds the disposable index and runs sync", async () => {
		await seed("One indexed record.");
		expect((await runMuninnCommand("reindex", runtime())).text).toContain("1 record");
		const output = await runMuninnCommand("sync --no-push", runtime());
		expect(synced).toBe(1);
		expect(output.text).toContain("committed locally");
	});
});
