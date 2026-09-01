/** Cross-clone acceptance for one distributed logical-project journal. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetCommitDebounce } from "../../src/capture/commit.ts";
import { newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import { JournalQueryService } from "../../src/journal/query.ts";
import { appendAuthorizedJournalRecord } from "../../src/journal/writer.ts";
import type { HostIdentity } from "../../src/store/host.ts";
import { ensureStore } from "../../src/store/init.ts";
import { readProjectManifest } from "../../src/store/project-manifest.ts";
import { sync } from "../../src/sync/sync.ts";

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
});
