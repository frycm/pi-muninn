import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetCommitDebounce } from "../../src/capture/commit.ts";
import { setVerificationPolicy } from "../../src/governance/trust.ts";
import { newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import { appendJournalRecord } from "../../src/journal/jsonl.ts";
import { JournalQueryService } from "../../src/journal/query.ts";
import { appendAuthorizedJournalRecord } from "../../src/journal/writer.ts";
import type { MemberIdentity } from "../../src/project/registry.ts";
import type { HostIdentity } from "../../src/store/host.ts";
import { type EnsureProjectStoreOptions, ensureStore } from "../../src/store/init.ts";
import { withStoreLock } from "../../src/store/lock.ts";
import { mergeProjectManifests, readProjectManifest, setProjectRemote } from "../../src/store/project-manifest.ts";
import { authorizeJournalRemote } from "../../src/sync/remote.ts";
import { describeSync, sync } from "../../src/sync/sync.ts";
import { declareTeamEvent, projectTeamRoster } from "../../src/team/lifecycle.ts";

const execFileAsync = promisify(execFile);
let root: string;
let remote: string;
let one: string;
let two: string;
let project: string;
let hostOne: HostIdentity;
let hostTwo: HostIdentity;
let memberOne: MemberIdentity;
let memberTwo: MemberIdentity;

async function git(cwd: string, args: string[]): Promise<string> {
	return (await execFileAsync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout;
}

function actor(name: string): { host: HostIdentity; member: MemberIdentity } {
	return {
		host: { id: newHostId(), name, createdAt: "2026-08-01T00:00:00.000Z" },
		member: { id: newMemberId(), name, createdAt: "2026-08-01T00:00:00.000Z" },
	};
}

function options(host: HostIdentity, member: MemberIdentity, projectId = project): EnsureProjectStoreOptions {
	return { host, project: { id: projectId, name: "demo", member } };
}

async function note(store: string, host: HostIdentity, member: MemberIdentity, body: string): Promise<string> {
	return (
		await appendAuthorizedJournalRecord(
			{ authority: "headless-user", record: { type: "note", source: "user", channel: "cli", body } },
			{ storePath: store, project, member: member.id, host: host.id },
		)
	).id;
}

async function synchronize(store: string, host: HostIdentity, remoteUrl: string | null = remote) {
	resetCommitDebounce();
	await authorizeJournalRemote(store, remoteUrl);
	return sync({ storePath: store, hostId: host.id, hostName: host.name });
}

async function seed(): Promise<void> {
	await ensureStore(one, options(hostOne, memberOne));
	await note(one, hostOne, memberOne, "Laptop one saw vitest watch mode hang CI.");
	const result = await synchronize(one, hostOne);
	expect(result.problem).toBeUndefined();
	expect(result.pushed).toBe(true);
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "muninn-sync-"));
	remote = join(root, "remote.git");
	one = join(root, "one");
	two = join(root, "two");
	project = newProjectId();
	({ host: hostOne, member: memberOne } = actor("Martin"));
	({ host: hostTwo, member: memberTwo } = actor("Ada"));
	mkdirSync(remote);
	await git(remote, ["init", "--bare", "--quiet", "--initial-branch=main"]);
	resetCommitDebounce();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("project journal sync", () => {
	it("commits and first-pushes canonical project data", async () => {
		await ensureStore(one, options(hostOne, memberOne));
		await note(one, hostOne, memberOne, "Deploys need the VPN.");
		const result = await synchronize(one, hostOne);
		expect(result).toMatchObject({ committed: true, fetched: true, pushed: true });
		expect(describeSync(result)).toBe("sync: committed, fetched, pushed");
		expect(await git(remote, ["ls-tree", "--name-only", "main"])).toContain("project.json");
	});

	it("exchanges records and team metadata between two clones", async () => {
		await seed();
		await git(root, ["clone", "--quiet", remote, two]);
		await ensureStore(two, options(hostTwo, memberTwo));
		await note(two, hostTwo, memberTwo, "Laptop two changed the database URL.");
		expect((await synchronize(two, hostTwo)).problem).toBeUndefined();
		expect((await synchronize(one, hostOne)).problem).toBeUndefined();

		const service = new JournalQueryService({ storePath: one, localMember: memberOne.id, mode: "scan" });
		expect(service.query({ query: "database URL" }).records[0]?.trust).toBe("teammate-user");
		expect(service.query({ query: "vitest watch" }).records[0]?.trust).toBe("local-user");
		const manifest = readProjectManifest(one);
		expect(manifest?.members.map((item) => item.id).sort()).toEqual([memberOne.id, memberTwo.id].sort());
		expect(manifest?.hosts.map((item) => item.id).sort()).toEqual([hostOne.id, hostTwo.id].sort());
	});

	it("union-merges concurrent member and host registration", async () => {
		await seed();
		await git(root, ["clone", "--quiet", remote, two]);
		await ensureStore(two, options(hostTwo, memberTwo));
		const third = actor("Lin");
		await ensureStore(one, options(third.host, third.member));
		expect((await synchronize(one, hostOne)).problem).toBeUndefined();
		const merged = await synchronize(two, hostTwo);
		expect(merged.problem).toBeUndefined();
		expect(merged.mergedManifest).toBe(true);
		expect(readProjectManifest(two)?.members).toHaveLength(3);
	});

	it("exchanges and union-merges concurrent lifecycle declarations", async () => {
		await seed();
		await git(root, ["clone", "--quiet", remote, two]);
		await ensureStore(two, options(hostTwo, memberTwo));
		await declareTeamEvent({
			storePath: one,
			project,
			actorMember: memberOne.id,
			actorHost: hostOne.id,
			actorHostName: hostOne.name,
			kind: "member-renamed",
			name: "Martin One",
		});
		await declareTeamEvent({
			storePath: two,
			project,
			actorMember: memberTwo.id,
			actorHost: hostTwo.id,
			actorHostName: hostTwo.name,
			kind: "member-renamed",
			name: "Ada Two",
		});
		expect((await synchronize(one, hostOne)).problem).toBeUndefined();
		const merged = await synchronize(two, hostTwo);
		expect(merged.problem).toBeUndefined();
		expect(merged.mergedManifest).toBe(true);
		expect((await synchronize(one, hostOne)).problem).toBeUndefined();
		const manifest = readProjectManifest(one) as NonNullable<ReturnType<typeof readProjectManifest>>;
		expect(manifest.team_events).toHaveLength(2);
		expect(
			projectTeamRoster(manifest)
				.members.map((candidate) => candidate.name)
				.sort(),
		).toEqual(["Ada Two", "Martin One"]);
	});

	it("refuses a remote for another logical project", async () => {
		await seed();
		const otherProject = newProjectId();
		await ensureStore(two, options(hostTwo, memberTwo, otherProject));
		const result = await synchronize(two, hostTwo);
		expect(result.problem).toContain("different project");
		expect(result.pushed).toBe(false);
	});

	it("refuses an existing remote branch without project.json", async () => {
		const unrelated = join(root, "unrelated");
		mkdirSync(unrelated);
		await git(unrelated, ["init", "--quiet", "--initial-branch=main"]);
		await git(unrelated, ["config", "user.email", "dev@example.com"]);
		await git(unrelated, ["config", "user.name", "Dev"]);
		writeFileSync(join(unrelated, "README.md"), "# unrelated\n");
		await git(unrelated, ["add", "README.md"]);
		await git(unrelated, ["commit", "--quiet", "-m", "initial"]);
		await git(unrelated, ["push", "--quiet", remote, "HEAD:main"]);
		await ensureStore(one, options(hostOne, memberOne));
		const result = await synchronize(one, hostOne);
		expect(result.problem).toContain("has no project.json");
		expect(result.pushed).toBe(false);
	});

	it("does not adopt an ambient origin when the manifest remote is unset", async () => {
		await ensureStore(one, options(hostOne, memberOne));
		await git(one, ["remote", "add", "origin", remote]);
		await note(one, hostOne, memberOne, "local only");
		const result = await synchronize(one, hostOne, null);
		expect(result.committed).toBe(true);
		expect(result.fetched).toBe(false);
		expect(result.pushed).toBe(false);
		expect(result.notes.join("\n")).toContain("no project journal remote configured");
	});

	it("rejects records from a host not registered in the project manifest", async () => {
		await ensureStore(one, options(hostOne, memberOne));
		const intruder = actor("intruder");
		await appendJournalRecord(
			{ type: "note", source: "external", channel: "hook", body: "unowned" },
			{ storePath: one, project, member: intruder.member.id, host: intruder.host.id },
		);
		const result = await synchronize(one, hostOne, null);
		expect(result.problem).toContain("unregistered host");
		expect(result.stoppedAt).toBe("commit");
	});

	it("supports fetch/rebase without push and an expired deadline", async () => {
		await seed();
		const noPush = await sync({
			storePath: one,
			hostId: hostOne.id,
			hostName: hostOne.name,
			noPush: true,
		});
		expect(noPush.notes).toContain("push skipped");
		const expired = await sync({
			storePath: one,
			hostId: hostOne.id,
			hostName: hostOne.name,
			signal: AbortSignal.abort(),
		});
		expect(expired.problem).toContain("ran out of time");
		expect(expired.stoppedAt).toBe("fetch");
	});

	it("stops a synchronized policy violation before the first push", async () => {
		const agentDir = join(root, "agent");
		await ensureStore(one, options(hostOne, memberOne));
		await appendJournalRecord(
			{ type: "note", source: "user", channel: "cli", body: "unsigned after cutoff" },
			{
				storePath: one,
				project,
				member: memberOne.id,
				host: hostOne.id,
				now: new Date("2026-09-04T13:00:00.000Z"),
			},
		);
		await setVerificationPolicy({
			agentDir,
			project,
			host: hostOne.id,
			mode: "require",
			requiredAfter: "2026-09-04T12:00:00.000Z",
		});
		await authorizeJournalRemote(one, remote);
		const result = await sync({
			storePath: one,
			agentDir,
			hostId: hostOne.id,
			hostName: hostOne.name,
		});
		expect(result).toMatchObject({ stoppedAt: "push", pushed: false });
		expect(result.problem).toContain("local verification policy");
		expect(await git(remote, ["branch", "--list", "main"])).toBe("");
	});

	it("reports lock contention and non-repositories instead of throwing", async () => {
		await ensureStore(one, options(hostOne, memberOne));
		await withStoreLock(one, "migrate", { host: hostTwo.id }, async () => {
			const busy = await synchronize(one, hostOne);
			expect(busy.problem).toContain("busy");
		});
		const plain = join(root, "plain");
		mkdirSync(plain);
		const invalid = await sync({ storePath: plain, hostId: hostOne.id, hostName: hostOne.name });
		expect(invalid.problem).toContain("not a git repository");
	});
});

describe("project manifest reconciliation", () => {
	it("is order-independent and rejects remote disagreement", () => {
		const base = {
			schema: 1 as const,
			project,
			name: "demo",
			created_at: "2026-08-01T00:00:00.000Z",
			remote: null,
			members: [{ id: memberOne.id, name: memberOne.name }],
			hosts: [{ id: hostOne.id, name: hostOne.name, member: memberOne.id }],
			team_events: [],
			signing_keys: [],
			key_events: [],
		};
		const teammate = {
			...base,
			members: [{ id: memberTwo.id, name: memberTwo.name }],
			hosts: [{ id: hostTwo.id, name: hostTwo.name, member: memberTwo.id }],
		};
		expect(mergeProjectManifests(base, teammate)).toEqual(mergeProjectManifests(teammate, base));
		expect(() =>
			mergeProjectManifests(
				{ ...base, remote: "ssh://one/journal.git" },
				{ ...teammate, remote: "ssh://two/journal.git" },
			),
		).toThrow(/remote conflict/);
	});
});

describe("local transport authorization", () => {
	it.each([false, true])("never redirects future syncs through shared metadata (diverged=%s)", async (diverged) => {
		await seed();
		const sink = join(root, "sink.git");
		await git(root, ["init", "--bare", "--quiet", "--initial-branch=main", sink]);
		await git(root, ["clone", "--quiet", remote, two]);
		setProjectRemote(two, sink);
		await git(two, [
			"-c",
			"user.name=Peer",
			"-c",
			"user.email=peer@example.test",
			"commit",
			"--quiet",
			"-am",
			"change advertised URL",
		]);
		await git(two, ["push", "--quiet", "origin", "main"]);
		if (diverged) await note(one, hostOne, memberOne, "local unpushed history");
		const run = () => sync({ storePath: one, hostId: hostOne.id, hostName: hostOne.name });
		expect((await run()).problem).toBeUndefined();
		expect(readProjectManifest(one)?.remote).toBe(sink);
		await note(one, hostOne, memberOne, "future private note");
		expect((await run()).pushed).toBe(true);
		expect((await git(one, ["remote", "get-url", "origin"])).trim()).toBe(remote);
		expect(await git(sink, ["branch", "--list"])).toBe("");
		await authorizeJournalRemote(one, null);
		expect((await run()).fetched).toBe(false);
	});

	it("does not bootstrap approval from legacy manifest or ambient origin", async () => {
		await ensureStore(one, options(hostOne, memberOne));
		setProjectRemote(one, remote);
		await git(one, ["remote", "add", "origin", remote]);
		const result = await sync({ storePath: one, hostId: hostOne.id, hostName: hostOne.name });
		expect(result.fetched).toBe(false);
		expect(result.notes.join(" ")).toContain("approve");
	});
});

it("pushes only to the approved URL even when origin has a separate pushurl", async () => {
	await ensureStore(one, options(hostOne, memberOne));
	const sink = join(root, "push-sink.git");
	await git(root, ["init", "--bare", "--quiet", "--initial-branch=main", sink]);
	await git(one, ["remote", "add", "origin", remote]);
	await git(one, ["remote", "set-url", "--push", "origin", sink]);
	await authorizeJournalRemote(one, remote);
	expect((await sync({ storePath: one, hostId: hostOne.id, hostName: hostOne.name })).pushed).toBe(true);
	expect(await git(sink, ["branch", "--list"])).toBe("");
	expect(await git(remote, ["branch", "--list"])).toContain("main");
});
