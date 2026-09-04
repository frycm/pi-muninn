import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diagnoseProject } from "../../src/doctor.ts";
import { git } from "../../src/git.ts";
import { newEntryId } from "../../src/ids.ts";
import { transcriptExchangePath } from "../../src/integrations/transcript.ts";
import { journalShardPath } from "../../src/journal/jsonl.ts";
import { JournalQueryService } from "../../src/journal/query.ts";
import { journalIndexPath } from "../../src/journal/query-index.ts";
import { appendAuthorizedJournalRecord, appendUserRelation } from "../../src/journal/writer.ts";
import { type ResolvedProject, resolveLogicalProject } from "../../src/project/resolver.ts";
import { type HostIdentity, loadHostIdentity } from "../../src/store/host.ts";
import { ensureStore, projectStoreIdentity } from "../../src/store/init.ts";
import { hostFilePath } from "../../src/store/paths.ts";
import { readProjectManifest, setProjectRemote } from "../../src/store/project-manifest.ts";
import { declareTeamEvent } from "../../src/team/lifecycle.ts";

let root: string;
let agentDir: string;
let cwd: string;
let project: ResolvedProject;
let host: HostIdentity;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "muninn-doctor-"));
	agentDir = join(root, "agent");
	cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	host = loadHostIdentity(agentDir);
	project = (await resolveLogicalProject({ agentDir, cwd, hostId: host.id, create: true })) as ResolvedProject;
	await ensureStore(project.storePath, projectStoreIdentity(project, host));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function check(result: Awaited<ReturnType<typeof diagnoseProject>>, code: string) {
	return result.checks.find((candidate) => candidate.code === code);
}

describe("muninn doctor", () => {
	it("reports stable independent checks for a healthy project without changing bytes", async () => {
		await appendAuthorizedJournalRecord(
			{ authority: "headless-user", record: { type: "note", source: "user", channel: "cli", body: "healthy" } },
			{
				storePath: project.storePath,
				project: project.id,
				member: project.member.id,
				host: host.id,
			},
		);
		new JournalQueryService({
			storePath: project.storePath,
			localMember: project.member.id,
			mode: "index",
			forceReindex: true,
		});
		const indexBefore = readFileSync(journalIndexPath(project.storePath), "utf-8");
		const manifestBefore = readFileSync(join(project.storePath, "project.json"), "utf-8");
		const result = await diagnoseProject({ agentDir, cwd });
		expect(result.summary).toEqual({ ok: 12, warnings: 0, errors: 0 });
		expect(result.checks.map((candidate) => candidate.code)).toEqual([
			"registry.valid",
			"project.mapping",
			"store.path",
			"store.git",
			"manifest.valid",
			"project.identity",
			"remote.consistent",
			"journal.valid",
			"lifecycle.consistent",
			"relations.consistent",
			"transcripts.local",
			"index.valid",
		]);
		expect(readFileSync(journalIndexPath(project.storePath), "utf-8")).toBe(indexBefore);
		expect(readFileSync(join(project.storePath, "project.json"), "utf-8")).toBe(manifestBefore);
	});

	it("does not mint host, registry, store, or index state on a fresh directory", async () => {
		const freshAgent = join(root, "fresh-agent");
		const freshCwd = join(root, "fresh-project");
		mkdirSync(freshAgent);
		mkdirSync(freshCwd);
		const result = await diagnoseProject({ agentDir: freshAgent, cwd: freshCwd });
		expect(result.summary.errors).toBeGreaterThan(0);
		expect(existsSync(hostFilePath(freshAgent))).toBe(false);
		expect(existsSync(join(freshAgent, "muninn-projects"))).toBe(false);
	});

	it("reports a stale or damaged index without repairing it", async () => {
		const path = journalIndexPath(project.storePath);
		mkdirSync(join(project.storePath, ".index"));
		writeFileSync(path, "{broken");
		const result = await diagnoseProject({ agentDir, cwd });
		expect(check(result, "index.valid")?.status).toBe("warning");
		expect(readFileSync(path, "utf-8")).toBe("{broken");
	});

	it("reports unsafe or orphaned local transcript exchange copies without changing them", async () => {
		const path = transcriptExchangePath(agentDir, project.id, newEntryId());
		mkdirSync(join(agentDir, "muninn-transcripts", project.id), { recursive: true, mode: 0o700 });
		writeFileSync(path, "{}\n", { mode: 0o600 });
		chmodSync(path, 0o644);
		const before = readFileSync(path);
		const result = await diagnoseProject({ agentDir, cwd });
		expect(check(result, "transcripts.local")?.status).toBe("warning");
		expect(check(result, "transcripts.local")?.message).toMatch(/session-backed|group or other/);
		expect(readFileSync(path)).toEqual(before);
		expect(statSync(path).mode & 0o777).toBe(0o644);
	});

	it("separately reports remote, journal, lifecycle, and relation problems", async () => {
		setProjectRemote(project.storePath, "ssh://git.example/team/expected.git");
		await git(project.storePath, { kind: "remote-add", name: "origin", url: "ssh://git.example/team/other.git" });
		await declareTeamEvent({
			storePath: project.storePath,
			project: project.id,
			actorMember: project.member.id,
			actorHost: host.id,
			actorHostName: host.name,
			kind: "member-retired",
			at: "2020-01-01T00:00:00.000Z",
		});
		const target = await appendAuthorizedJournalRecord(
			{ authority: "headless-user", record: { type: "note", source: "user", channel: "cli", body: "target" } },
			{ storePath: project.storePath, project: project.id, member: project.member.id, host: host.id },
		);
		for (const body of ["left", "right"]) {
			await appendUserRelation({
				authority: "headless-user",
				target: target.id,
				text: body,
				relation: "corrects",
				channel: "cli",
				storePath: project.storePath,
				project: project.id,
				member: project.member.id,
				host: host.id,
			});
		}
		const result = await diagnoseProject({ agentDir, cwd });
		expect(check(result, "remote.consistent")?.status).toBe("error");
		expect(check(result, "remote.consistent")?.message).toBe("manifest remote differs from Git origin");
		expect(check(result, "journal.valid")?.status).toBe("ok");
		expect(check(result, "lifecycle.consistent")?.status).toBe("warning");
		expect(check(result, "relations.consistent")?.status).toBe("warning");
	});

	it("reports malformed journal bytes and manifest identity collisions", async () => {
		const shard = journalShardPath(project.storePath, project.member.id, host.id, new Date());
		appendFileSync(shard, "{broken\n");
		let result = await diagnoseProject({ agentDir, cwd });
		expect(check(result, "journal.valid")?.status).toBe("error");

		const manifest = readProjectManifest(project.storePath);
		writeFileSync(
			join(project.storePath, "project.json"),
			JSON.stringify({
				...manifest,
				members: [...(manifest?.members ?? []), { id: project.member.id, name: "collision" }],
			}),
		);
		result = await diagnoseProject({ agentDir, cwd });
		expect(check(result, "manifest.valid")?.status).toBe("error");
	});
});
