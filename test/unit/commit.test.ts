import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitJournal, DEBOUNCE_MS, resetCommitDebounce } from "../../src/capture/commit.ts";
import { git } from "../../src/git.ts";
import { newHostId, newMemberId, newProjectId } from "../../src/ids.ts";
import { appendAuthorizedJournalRecord } from "../../src/journal/writer.ts";
import type { HostIdentity } from "../../src/store/host.ts";
import { ensureStore } from "../../src/store/init.ts";

let root: string;
let store: string;
let host: HostIdentity;
let project: string;
let member: string;

beforeEach(async () => {
	resetCommitDebounce();
	root = mkdtempSync(join(tmpdir(), "muninn-commit-"));
	store = join(root, "store");
	host = { id: newHostId(), name: "mbp", createdAt: "2026-08-01T00:00:00.000Z" };
	project = newProjectId();
	member = newMemberId();
	await ensureStore(store, {
		host,
		project: {
			id: project,
			name: "demo",
			member: { id: member, name: "Martin", createdAt: "2026-08-01T00:00:00.000Z" },
		},
	});
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function append(body: string): Promise<void> {
	await appendAuthorizedJournalRecord(
		{ authority: "headless-user", record: { type: "note", source: "user", channel: "cli", body } },
		{ storePath: store, project, member, host: host.id },
	);
}

function options(overrides: Partial<Parameters<typeof commitJournal>[0]> = {}) {
	return { storePath: store, hostId: host.id, hostName: host.name, entries: 1, ...overrides };
}

async function count(): Promise<number> {
	return Number((await git(store, { kind: "log-count" })).stdout.trim());
}

describe("commitJournal", () => {
	it("commits canonical JSONL records and leaves the store clean", async () => {
		await append("first");
		const before = await count();
		expect(await commitJournal(options())).toEqual({ committed: true });
		expect(await count()).toBe(before + 1);
		expect((await git(store, { kind: "status-porcelain", paths: [] })).stdout.trim()).toBe("");
	});

	it("commits metadata but leaves unrelated files alone", async () => {
		await append("first");
		writeFileSync(join(store, "notes.txt"), "not owned by muninn\n");
		await commitJournal(options());
		const dirty = (await git(store, { kind: "status-porcelain", paths: [] })).stdout;
		expect(dirty).toContain("notes.txt");
		expect(dirty).not.toContain("journal/");
	});

	it("commits a crash backlog even when this session reports zero entries", async () => {
		await append("left behind");
		expect((await commitJournal(options({ entries: 0 }))).committed).toBe(true);
	});

	it("debounces per batch and force bypasses the window", async () => {
		await append("one");
		expect((await commitJournal(options({ now: 1_000 }))).committed).toBe(true);
		await append("two");
		expect((await commitJournal(options({ now: 1_000 + DEBOUNCE_MS - 1 }))).reason).toBe("debounced");
		expect((await commitJournal(options({ now: 1_001, force: true }))).committed).toBe(true);
	});

	it("leaves no lock files behind", async () => {
		await append("one");
		await commitJournal(options());
		expect(existsSync(join(store, ".lock"))).toBe(false);
		expect(existsSync(join(store, ".lock.json"))).toBe(false);
	});

	it("reports a directory that is not a repository", async () => {
		const plain = join(root, "plain");
		mkdirSync(plain);
		const result = await commitJournal({ storePath: plain, hostId: host.id, hostName: host.name, entries: 1 });
		expect(result).toMatchObject({ committed: false, reason: expect.stringContaining("not a git repository") });
	});
});
