import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitJournal, DEBOUNCE_MS, resetCommitDebounce } from "../../src/capture/commit.ts";
import { git } from "../../src/git.ts";
import { newHostId } from "../../src/ids.ts";
import { appendEntry } from "../../src/journal/append.ts";
import type { HostIdentity } from "../../src/store/host.ts";
import { ensureStore } from "../../src/store/init.ts";

let root: string;
let store: string;
let host: HostIdentity;

beforeEach(async () => {
	resetCommitDebounce();
	root = mkdtempSync(join(tmpdir(), "muninn-commit-"));
	store = join(root, "store");
	host = { id: newHostId(), name: "mbp", createdAt: new Date().toISOString() };
	await ensureStore(store, { host });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

async function log(cwd: string): Promise<string[]> {
	const { stdout } = await git(cwd, { kind: "status-porcelain", paths: [] });
	return stdout.trim() === "" ? [] : stdout.trim().split("\n");
}

async function commitCount(cwd: string): Promise<number> {
	const { stdout } = await git(cwd, { kind: "log-count" });
	return Number.parseInt(stdout.trim(), 10);
}

async function writeEntry(prose: string): Promise<void> {
	await appendEntry({ source: "user", prose, claims: [] }, { storePath: store, hostId: host.id });
}

function options(overrides: Partial<Parameters<typeof commitJournal>[0]> = {}) {
	return { storePath: store, hostId: host.id, hostName: host.name, entries: 1, ...overrides };
}

describe("commitJournal", () => {
	it("commits pending entries and leaves the store clean", async () => {
		await writeEntry("first");
		const before = await commitCount(store);

		expect(await commitJournal(options())).toEqual({ committed: true });
		expect(await commitCount(store)).toBe(before + 1);
		expect(await log(store)).toEqual([]);
	});

	it("commits nothing when there is nothing to commit", async () => {
		const result = await commitJournal(options({ entries: 0 }));
		expect(result.committed).toBe(false);
		expect(result.reason).toBe("nothing to commit");
	});

	it("names the host and the batch size", async () => {
		await writeEntry("one");
		await writeEntry("two");
		await commitJournal(options({ entries: 2 }));

		const { stdout } = await git(store, { kind: "rev-parse", target: "HEAD" });
		expect(stdout.trim()).not.toBe("");
		const messageText = readFileSync(join(store, ".git", "COMMIT_EDITMSG"), "utf-8");
		expect(messageText).toContain("journal: mbp 2 entries");
	});

	it("uses the singular for one entry", async () => {
		await writeEntry("one");
		await commitJournal(options({ entries: 1 }));
		expect(readFileSync(join(store, ".git", "COMMIT_EDITMSG"), "utf-8")).toContain("1 entry");
	});

	it("commits a backlog left by a crashed session even when this one wrote nothing", async () => {
		// The entries are on disk either way; refusing to commit them because
		// this session's counter is zero would strand them outside git forever.
		await writeEntry("left behind");
		const result = await commitJournal(options({ entries: 0 }));
		expect(result.committed).toBe(true);
	});

	it("touches only journal/", async () => {
		await writeEntry("first");
		// Something else changed in the store at the same time.
		writeFileSync(join(store, "store.md"), `${readFileSync(join(store, "store.md"), "utf-8")}\nhand-edited\n`);

		await commitJournal(options());

		const dirty = await log(store);
		expect(dirty.some((line) => line.includes("store.md"))).toBe(true);
		expect(dirty.some((line) => line.includes("journal/"))).toBe(false);
	});

	it("leaves no lock behind", async () => {
		await writeEntry("first");
		await commitJournal(options());
		expect(existsSync(join(store, ".lock"))).toBe(false);
		expect(existsSync(join(store, ".lock.json"))).toBe(false);
	});
});

describe("commitJournal — debounce", () => {
	it("makes one commit per batch, not one per entry", async () => {
		await writeEntry("first");
		expect((await commitJournal(options({ now: 1_000 }))).committed).toBe(true);

		await writeEntry("second");
		const second = await commitJournal(options({ now: 1_000 + DEBOUNCE_MS - 1 }));
		expect(second.committed).toBe(false);
		expect(second.reason).toBe("debounced");
	});

	it("commits again once the window passes", async () => {
		await writeEntry("first");
		await commitJournal(options({ now: 1_000 }));
		await writeEntry("second");
		expect((await commitJournal(options({ now: 1_000 + DEBOUNCE_MS }))).committed).toBe(true);
	});

	it("ignores the debounce when forced", async () => {
		// The shutdown path forces: it is the last chance to make the session's
		// entries durable before the process goes away.
		await writeEntry("first");
		await commitJournal(options({ now: 1_000 }));
		await writeEntry("second");
		expect((await commitJournal(options({ now: 1_001, force: true }))).committed).toBe(true);
	});

	it("debounces per store, not globally", async () => {
		const other = join(root, "other-store");
		const otherHost: HostIdentity = { id: newHostId(), name: "ops1", createdAt: "" };
		await ensureStore(other, { host: otherHost });
		await appendEntry({ source: "user", prose: "theirs", claims: [] }, { storePath: other, hostId: otherHost.id });
		await writeEntry("mine");

		await commitJournal(options({ now: 1_000 }));
		const result = await commitJournal({
			storePath: other,
			hostId: otherHost.id,
			hostName: otherHost.name,
			entries: 1,
			now: 1_001,
		});
		expect(result.committed).toBe(true);
	});
});

describe("commitJournal — a store that is not a repository", () => {
	it("reports rather than throwing", async () => {
		const bare = join(root, "not-a-repo");
		mkdirSync(bare, { recursive: true });
		const result = await commitJournal({ storePath: bare, hostId: host.id, hostName: host.name, entries: 1 });
		expect(result.committed).toBe(false);
		expect(result.reason).toContain("not a git repository");
	});
});

describe("commitJournal — inside the developer's own repository", () => {
	it("never commits work the developer had staged", async () => {
		// The riskiest combination: an in-repo store lives inside a repository
		// Muninn does not own, and a bare `git commit` there would sweep up
		// whatever was in the index.
		const repo = join(root, "project");
		mkdirSync(repo, { recursive: true });
		await git(repo, { kind: "init" });
		await git(repo, { kind: "config", key: "user.name", value: "Real Developer" });
		await git(repo, { kind: "config", key: "user.email", value: "dev@example.com" });
		writeFileSync(join(repo, "store.md"), "a project file that happens to share a name\n");
		await git(repo, { kind: "add", paths: ["store.md"] });
		await git(repo, { kind: "commit", message: "initial", paths: ["store.md"] });

		const inRepoStore = join(repo, ".pi", "muninn");
		await ensureStore(inRepoStore, { host, inRepo: true });

		// The developer stages their own change.
		writeFileSync(join(repo, "store.md"), "the developer's own edit, staged\n");
		await git(repo, { kind: "add", paths: ["store.md"] });

		await appendEntry({ source: "user", prose: "a memory", claims: [] }, { storePath: inRepoStore, hostId: host.id });
		expect(
			(await commitJournal({ storePath: inRepoStore, hostId: host.id, hostName: host.name, entries: 1 })).committed,
		).toBe(true);

		// Their edit is still staged, not committed by Muninn.
		const { stdout } = await git(repo, { kind: "status-porcelain", paths: ["store.md"] });
		expect(stdout).toContain("store.md");
		expect(readFileSync(join(repo, "store.md"), "utf-8")).toContain("developer's own edit");
	});
});
