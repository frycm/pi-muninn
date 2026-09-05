/** Cross-clone acceptance for one distributed logical-project journal. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetCommitDebounce } from "../../src/capture/commit.ts";
import { diagnoseProject } from "../../src/doctor.ts";
import { readSigningIdentity } from "../../src/governance/identity.ts";
import { rotateProjectSigningKey } from "../../src/governance/operations.ts";
import { initializeProjectCryptography } from "../../src/governance/setup.ts";
import { pinProjectSigningKey, readProjectTrust, setVerificationPolicy } from "../../src/governance/trust.ts";
import { VerificationProjection } from "../../src/governance/verification.ts";
import { newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import { JournalQueryService } from "../../src/journal/query.ts";
import { appendAuthorizedJournalRecord, appendUserRelation, resolveUserConflict } from "../../src/journal/writer.ts";
import { joinProjectJournal } from "../../src/project/onboarding.ts";
import { resolveLogicalProject } from "../../src/project/resolver.ts";
import type { HostIdentity } from "../../src/store/host.ts";
import { ensureStore, projectStoreIdentity } from "../../src/store/init.ts";
import { readProjectManifest, setProjectRemote } from "../../src/store/project-manifest.ts";
import { authorizeJournalRemote } from "../../src/sync/remote.ts";
import { type SyncOptions, sync as syncStore } from "../../src/sync/sync.ts";
import { declareTeamEvent, projectTeamRoster } from "../../src/team/lifecycle.ts";

const execFileAsync = promisify(execFile);
let root: string;
let remote: string;
let laptopOne: string;
let laptopTwo: string;
let project: string;

async function git(cwd: string, args: string[]): Promise<string> {
	return (await execFileAsync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout;
}

function host(name: string): HostIdentity {
	return { id: newHostId(), name, createdAt: "2026-08-24T00:00:00.000Z" };
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "muninn-team-"));
	remote = join(root, "remote.git");
	laptopOne = join(root, "one");
	laptopTwo = join(root, "two");
	project = newProjectId();
	mkdirSync(remote);
	await git(remote, ["init", "--bare", "--quiet", "--initial-branch=main"]);
	resetCommitDebounce();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("distributed project journal", () => {
	it("onboards, projects lifecycle, resolves a teammate conflict, and converges across agent directories", async () => {
		const ownerAgent = join(root, "owner-agent");
		const ownerCode = join(root, "owner-code");
		const joinerAgent = join(root, "joiner-agent");
		const joinerCode = join(root, "joiner-code");
		for (const path of [ownerAgent, ownerCode, joinerAgent, joinerCode]) mkdirSync(path);
		const ownerHost = host("owner-host");
		const joinerHost = host("joiner-host");
		const owner = await resolveLogicalProject({
			agentDir: ownerAgent,
			cwd: ownerCode,
			hostId: ownerHost.id,
			create: true,
		});
		expect(owner).toBeDefined();
		project = owner?.id as string;
		await ensureStore(owner?.storePath as string, projectStoreIdentity(owner as NonNullable<typeof owner>, ownerHost));
		setProjectRemote(owner?.storePath as string, remote);
		const target = await appendAuthorizedJournalRecord(
			{
				authority: "headless-user",
				record: { type: "note", source: "user", channel: "cli", body: "Deploy on Tuesday." },
			},
			{ storePath: owner?.storePath as string, project, member: owner?.member.id as string, host: ownerHost.id },
		);
		await appendUserRelation({
			authority: "headless-user",
			target: target.id,
			text: "Deploy on Wednesday.",
			relation: "corrects",
			channel: "cli",
			storePath: owner?.storePath as string,
			project,
			member: owner?.member.id as string,
			host: ownerHost.id,
		});
		expect(
			(await sync({ storePath: owner?.storePath as string, hostId: ownerHost.id, hostName: ownerHost.name, remote }))
				.problem,
		).toBeUndefined();

		const joined = await joinProjectJournal({ agentDir: joinerAgent, cwd: joinerCode, host: joinerHost, remote });
		await appendUserRelation({
			authority: "headless-user",
			target: target.id,
			text: "Deploy on Thursday.",
			relation: "corrects",
			channel: "cli",
			storePath: joined.project.storePath,
			project,
			member: joined.project.member.id,
			host: joinerHost.id,
		});
		await declareTeamEvent({
			storePath: joined.project.storePath,
			project,
			actorMember: joined.project.member.id,
			actorHost: joinerHost.id,
			actorHostName: joinerHost.name,
			kind: "host-renamed",
			host: joinerHost.id,
			name: "joiner-workstation",
		});
		expect(
			(await sync({ storePath: joined.project.storePath, hostId: joinerHost.id, hostName: joinerHost.name, remote }))
				.problem,
		).toBeUndefined();
		expect(
			(await sync({ storePath: owner?.storePath as string, hostId: ownerHost.id, hostName: ownerHost.name, remote }))
				.problem,
		).toBeUndefined();

		let ownerQuery = new JournalQueryService({
			storePath: owner?.storePath as string,
			localMember: owner?.member.id as string,
			mode: "scan",
		});
		expect(
			ownerQuery
				.conflictInbox()
				.conflicts[0]?.branches.map((branch) => branch.trust)
				.sort(),
		).toEqual(["local-user", "teammate-user"]);
		const resolved = await resolveUserConflict({
			authority: "headless-user",
			target: target.id,
			text: "Deploy in the approved Friday window.",
			channel: "cli",
			storePath: owner?.storePath as string,
			project,
			member: owner?.member.id as string,
			host: ownerHost.id,
		});
		expect(resolved.status).toBe("resolved");
		expect(
			(await sync({ storePath: owner?.storePath as string, hostId: ownerHost.id, hostName: ownerHost.name, remote }))
				.problem,
		).toBeUndefined();
		expect(
			(await sync({ storePath: joined.project.storePath, hostId: joinerHost.id, hostName: joinerHost.name, remote }))
				.problem,
		).toBeUndefined();

		ownerQuery = new JournalQueryService({
			storePath: joined.project.storePath,
			localMember: joined.project.member.id,
			mode: "scan",
		});
		expect(ownerQuery.conflictInbox().conflicts).toEqual([]);
		const manifest = readProjectManifest(joined.project.storePath) as NonNullable<
			ReturnType<typeof readProjectManifest>
		>;
		expect(projectTeamRoster(manifest).hosts.find((candidate) => candidate.id === joinerHost.id)?.name).toBe(
			"joiner-workstation",
		);
		expect((await diagnoseProject({ agentDir: joinerAgent, cwd: joinerCode })).summary.errors).toBe(0);
	});

	it("surfaces one teammate's correction on another clone and reports the remote transcript as unavailable", async () => {
		const martin = { id: newMemberId(), name: "Martin", createdAt: "2026-08-24T00:00:00.000Z" };
		const ada = { id: newMemberId(), name: "Ada", createdAt: "2026-08-25T00:00:00.000Z" };
		const hostOne = host("laptop-one");
		const hostTwo = host("laptop-two");
		await ensureStore(laptopOne, { host: hostOne, project: { id: project, name: "demo", member: martin } });
		const transcript = join(root, "sessions", "monday.jsonl");
		mkdirSync(join(root, "sessions"));
		writeFileSync(transcript, '{"type":"message","id":"e-9"}\n');
		const stale = await appendAuthorizedJournalRecord(
			{
				authority: "headless-user",
				record: {
					type: "note",
					source: "user",
					channel: "cli",
					body: "Run vitest in watch mode in CI.",
					session: { file: transcript, last: "e-9" },
				},
			},
			{ storePath: laptopOne, project, member: martin.id, host: hostOne.id },
		);
		await appendAuthorizedJournalRecord(
			{
				authority: "headless-user",
				record: {
					type: "correction",
					source: "user",
					channel: "cli",
					body: "Use `pnpm test --run`; watch mode hangs CI without a TTY.",
					relations: [{ type: "corrects", target: stale.id }],
				},
			},
			{ storePath: laptopOne, project, member: martin.id, host: hostOne.id },
		);
		expect(
			(await sync({ storePath: laptopOne, hostId: hostOne.id, hostName: hostOne.name, remote })).problem,
		).toBeUndefined();

		await git(root, ["clone", "--quiet", remote, laptopTwo]);
		await ensureStore(laptopTwo, { host: hostTwo, project: { id: project, name: "demo", member: ada } });
		const service = new JournalQueryService({
			storePath: laptopTwo,
			localMember: ada.id,
			mode: "index",
			transcriptRoots: [join(root, "sessions")],
		});
		const result = service.query({ query: "vitest watch CI" });
		expect(result.records[0]?.snippet).toContain("pnpm test --run");
		expect(result.records[0]?.trust).toBe("teammate-user");
		const read = service.read(stale.id, 1);
		expect(read?.records).toHaveLength(2);
		expect(read?.transcripts).toEqual([
			expect.objectContaining({ record: stale.id, file: transcript, available: true }),
		]);

		// A genuine second machine does not have laptop one's absolute transcript
		// path. Removing the fixture simulates that without changing the record.
		rmSync(transcript);
		expect(service.read(stale.id, 0)?.transcripts[0]).toMatchObject({ available: false, file: transcript });
		const manifest = readProjectManifest(laptopTwo);
		expect(manifest?.members.map((item) => item.id).sort()).toEqual([ada.id, martin.id].sort());
		expect(manifest?.hosts.map((item) => item.id).sort()).toEqual([hostOne.id, hostTwo.id].sort());
	});

	it("authenticates a required-policy workflow across clones and follows rotation", async () => {
		const ownerAgent = join(root, "signed-owner-agent");
		const ownerCode = join(root, "signed-owner-code");
		const joinerAgent = join(root, "signed-joiner-agent");
		const joinerCode = join(root, "signed-joiner-code");
		for (const path of [ownerAgent, ownerCode, joinerAgent, joinerCode]) mkdirSync(path);
		const ownerHost = host("owner-host");
		const joinerHost = host("joiner-host");
		const owner = await resolveLogicalProject({
			agentDir: ownerAgent,
			cwd: ownerCode,
			hostId: ownerHost.id,
			create: true,
		});
		if (!owner) throw new Error("owner project was not resolved");
		project = owner.id;
		await ensureStore(owner.storePath, projectStoreIdentity(owner, ownerHost));
		setProjectRemote(owner.storePath, remote);
		const ownerCrypto = await initializeProjectCryptography({
			agentDir: ownerAgent,
			storePath: owner.storePath,
			project,
			member: owner.member.id,
			host: ownerHost,
		});
		const ownerSigning = readSigningIdentity(ownerAgent, owner.member.id);
		if (!ownerSigning) throw new Error("owner signing key is missing");
		const ownerRecord = await appendAuthorizedJournalRecord(
			{
				authority: "headless-user",
				record: { type: "note", source: "user", channel: "cli", body: "Owner signed the release plan." },
			},
			{
				storePath: owner.storePath,
				agentDir: ownerAgent,
				project,
				member: owner.member.id,
				host: ownerHost.id,
				signing: ownerSigning,
			},
		);
		expect(
			(
				await sync({
					storePath: owner.storePath,
					agentDir: ownerAgent,
					hostId: ownerHost.id,
					hostName: ownerHost.name,
					remote,
				})
			).problem,
		).toBeUndefined();

		const joined = await joinProjectJournal({ agentDir: joinerAgent, cwd: joinerCode, host: joinerHost, remote });
		let manifest = readProjectManifest(joined.project.storePath);
		if (!manifest) throw new Error("joined manifest is missing");
		await pinProjectSigningKey({
			agentDir: joinerAgent,
			manifest,
			member: owner.member.id,
			key: ownerCrypto.identity.key,
			host: joinerHost.id,
		});
		await initializeProjectCryptography({
			agentDir: joinerAgent,
			storePath: joined.project.storePath,
			project,
			member: joined.project.member.id,
			host: joinerHost,
		});
		const joinerSigning = readSigningIdentity(joinerAgent, joined.project.member.id);
		if (!joinerSigning) throw new Error("joiner signing key is missing");
		await setVerificationPolicy({
			agentDir: joinerAgent,
			project,
			host: joinerHost.id,
			mode: "require",
			requiredAfter: "2026-01-01T00:00:00.000Z",
		});
		await appendAuthorizedJournalRecord(
			{
				authority: "headless-user",
				record: { type: "note", source: "user", channel: "cli", body: "Joiner verified the release plan." },
			},
			{
				storePath: joined.project.storePath,
				agentDir: joinerAgent,
				project,
				member: joined.project.member.id,
				host: joinerHost.id,
				signing: joinerSigning,
			},
		);
		expect(
			(
				await sync({
					storePath: joined.project.storePath,
					agentDir: joinerAgent,
					hostId: joinerHost.id,
					hostName: joinerHost.name,
					remote,
				})
			).problem,
		).toBeUndefined();
		expect(
			(
				await sync({
					storePath: owner.storePath,
					agentDir: ownerAgent,
					hostId: ownerHost.id,
					hostName: ownerHost.name,
					remote,
				})
			).problem,
		).toBeUndefined();

		let ownerQuery = new JournalQueryService({
			storePath: owner.storePath,
			localMember: owner.member.id,
			agentDir: ownerAgent,
			mode: "scan",
		});
		expect(ownerQuery.query({ query: "Joiner verified" }).records[0]?.verification).toBe("untrusted");
		manifest = readProjectManifest(owner.storePath);
		if (!manifest) throw new Error("owner manifest is missing");
		await pinProjectSigningKey({
			agentDir: ownerAgent,
			manifest,
			member: joined.project.member.id,
			key: joinerSigning.id,
			host: ownerHost.id,
		});
		await setVerificationPolicy({
			agentDir: ownerAgent,
			project,
			host: ownerHost.id,
			mode: "require",
			requiredAfter: "2026-01-01T00:00:00.000Z",
		});
		ownerQuery = new JournalQueryService({
			storePath: owner.storePath,
			localMember: owner.member.id,
			agentDir: ownerAgent,
			mode: "scan",
		});
		expect(ownerQuery.query({ query: "Joiner verified" }).records[0]?.verification).toBe("verified");

		await rotateProjectSigningKey({
			agentDir: joinerAgent,
			storePath: joined.project.storePath,
			project,
			member: joined.project.member.id,
			host: joinerHost,
		});
		const successor = readSigningIdentity(joinerAgent, joined.project.member.id);
		if (!successor) throw new Error("joiner successor key is missing");
		const rotatedRecord = await appendAuthorizedJournalRecord(
			{
				authority: "headless-user",
				record: { type: "note", source: "user", channel: "cli", body: "Successor signed this record." },
			},
			{
				storePath: joined.project.storePath,
				agentDir: joinerAgent,
				project,
				member: joined.project.member.id,
				host: joinerHost.id,
				signing: successor,
			},
		);
		expect(
			(
				await sync({
					storePath: joined.project.storePath,
					agentDir: joinerAgent,
					hostId: joinerHost.id,
					hostName: joinerHost.name,
					remote,
				})
			).problem,
		).toBeUndefined();
		expect(
			(
				await sync({
					storePath: owner.storePath,
					agentDir: ownerAgent,
					hostId: ownerHost.id,
					hostName: ownerHost.name,
					remote,
				})
			).problem,
		).toBeUndefined();
		manifest = readProjectManifest(owner.storePath);
		if (!manifest) throw new Error("final owner manifest is missing");
		const projection = new VerificationProjection(manifest, readProjectTrust(ownerAgent, project));
		expect(projection.record(ownerRecord.record)).toBe("verified");
		expect(projection.record(rotatedRecord.record)).toBe("verified");
		expect(projection.record({ ...rotatedRecord.record, body: "tampered" })).toBe("invalid");
		const tracked = (await git(joined.project.storePath, ["ls-files"])).trim().split("\n").filter(Boolean);
		for (const path of tracked) {
			const bytes = readFileSync(join(joined.project.storePath, path), "utf-8");
			for (const secret of [ownerSigning.private_key, joinerSigning.private_key, successor.private_key]) {
				expect(bytes).not.toContain(secret);
			}
		}
	});
});

// Explicit transport setup for these interoperability fixtures.
async function sync(options: SyncOptions & { remote: string | null }) {
	await authorizeJournalRemote(options.storePath, options.remote);
	return syncStore(options);
}
