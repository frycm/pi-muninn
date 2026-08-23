/**
 * Failure injection: what happens when the machine says no.
 *
 * Muninn's rule is that memory never degrades quietly — a write that cannot
 * happen must be reported, not skipped, and a derived file that cannot be read
 * must be rebuilt, not guessed at. These tests break things on purpose and
 * check that the failure arrives somewhere a person will see it.
 *
 * Two of the plan's cases live with the code they belong to and are not
 * repeated here: a lock whose holder died is in `lock.test.ts` (broken once
 * stale, never while fresh), and an unreachable remote is in `sync.test.ts`
 * (committed locally, reported as offline).
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitJournal, resetCommitDebounce } from "../../src/capture/commit.ts";
import { AppendQueue } from "../../src/capture/queue.ts";
import { GitMissingError, isGitRepository } from "../../src/git.ts";
import { newHostId } from "../../src/ids.ts";
import { indexDir, StoreIndex } from "../../src/index/build.ts";
import { appendEntry } from "../../src/journal/append.ts";
import { readStoreJournal } from "../../src/journal/read.ts";
import { withStoreLock } from "../../src/store/lock.ts";
import { sync } from "../../src/sync/sync.ts";

let store: string;
let host: string;

beforeEach(() => {
	store = mkdtempSync(join(tmpdir(), "muninn-hardening-"));
	host = newHostId();
	resetCommitDebounce();
});

afterEach(() => {
	chmodSync(store, 0o755);
	const journal = join(store, "journal", host);
	try {
		chmodSync(journal, 0o755);
	} catch {
		// Not every test creates it.
	}
	rmSync(store, { recursive: true, force: true });
});

async function note(claim: string): Promise<void> {
	await appendEntry({ source: "user", prose: "", claims: [claim] }, { storePath: store, hostId: host });
}

describe("a write that cannot happen", () => {
	it("is reported, and leaves nothing behind", async () => {
		// Standing in for ENOSPC: the append fails inside the single `write`, at
		// the point where a full disk would fail. What matters is the same in
		// both cases — no entry, and an error naming the file.
		await note("The first entry lands normally.");
		const daily = readdirSync(join(store, "journal", host))[0] as string;
		const path = join(store, "journal", host, daily);
		chmodSync(path, 0o444);

		const failure = await appendEntry(
			{ source: "user", prose: "", claims: ["This one cannot be written."] },
			{ storePath: store, hostId: host },
		).catch((error: Error) => error);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain(daily);
		chmodSync(path, 0o644);
		const journal = readStoreJournal(store);
		// The failed entry is absent and the file is still readable: a refused
		// write is not a corrupted one.
		expect(journal.entries).toHaveLength(1);
		expect(journal.problems).toEqual([]);
	});

	it("reaches the status report rather than the void", async () => {
		// Capture runs on a queue precisely so a failing append cannot throw into
		// one of pi's event handlers. The queue is therefore the only thing
		// standing between a failed write and silence.
		mkdirSync(join(store, "journal", host), { recursive: true });
		chmodSync(join(store, "journal", host), 0o555);

		const queue = new AppendQueue();
		queue.enqueue("capture explicit", async () => {
			await appendEntry({ source: "user", prose: "", claims: ["Nope."] }, { storePath: store, hostId: host });
		});
		await queue.flush();

		const failures = queue.takeFailures();
		expect(failures).toHaveLength(1);
		expect(failures[0]?.label).toBe("capture explicit");
		expect(failures[0]?.message).toContain(host);
	});

	it("gives up on a busy store rather than writing unlocked", async () => {
		// An append that skipped the lock could interleave with another and tear
		// a daily file in half — the one failure the journal format cannot
		// repair. Waiting and then failing is the correct trade.
		await withStoreLock(store, "dream", { host }, async () => {
			const failure = await appendEntry(
				{ source: "user", prose: "", claims: ["Blocked."] },
				{ storePath: store, hostId: host },
			).catch((error: Error) => error);

			expect((failure as Error).name).toBe("LockBusyError");
			expect((failure as Error).message).toContain("dream");
		});

		expect(readStoreJournal(store).entries).toEqual([]);
	});
});

describe("git missing", () => {
	/** Run `body` with an empty PATH, so `git` cannot be found. */
	async function withoutGit<T>(body: () => Promise<T>): Promise<T> {
		const previous = process.env.PATH;
		process.env.PATH = "";
		try {
			return await body();
		} finally {
			process.env.PATH = previous;
		}
	}

	it("is named as itself, not as 'not a git repository'", async () => {
		// The two failures have different remedies, and a swallowed ENOENT sends
		// whoever reads the message looking in exactly the wrong place.
		const error = await withoutGit(() => isGitRepository(store).catch((problem: Error) => problem));
		expect(error).toBeInstanceOf(GitMissingError);
		expect((error as Error).message).toContain("not installed or not on PATH");
	});

	it("stops a commit with a message that says what to do", async () => {
		await note("Written before git went missing.");
		const result = await withoutGit(() =>
			commitJournal({ storePath: store, hostId: host, hostName: "mbp", entries: 1, force: true }),
		);

		expect(result.committed).toBe(false);
		expect(result.reason).toContain("not installed or not on PATH");
		// The entry itself is untouched: capture does not need git.
		expect(readStoreJournal(store).entries).toHaveLength(1);
	});

	it("stops a sync the same way", async () => {
		const result = await withoutGit(() => sync({ storePath: store, hostId: host, hostName: "mbp", remote: null }));
		expect(result.stoppedAt).toBe("commit");
		expect(result.problem).toContain("not installed or not on PATH");
	});
});

describe("a damaged index", () => {
	async function build(): Promise<void> {
		await note("vitest watch mode hangs the CI job.");
		StoreIndex.open(store).index.save();
	}

	it("is rebuilt when its manifest is unreadable", async () => {
		await build();
		writeFileSync(join(indexDir(store), "manifest.json"), "{ not json");

		const { index, result } = StoreIndex.open(store);
		expect(result.problems.join(" ")).toMatch(/index rebuilt/);
		expect(index.search("vitest")).toHaveLength(1);
	});

	it("is rebuilt when the manifest is json but not a manifest", async () => {
		await build();
		writeFileSync(join(indexDir(store), "manifest.json"), JSON.stringify({ hello: "world" }));

		const { index, result } = StoreIndex.open(store);
		expect(result.problems.join(" ")).toMatch(/index rebuilt/);
		expect(index.search("vitest")).toHaveLength(1);
	});

	it("is rebuilt when the serialised index has gone but the manifest has not", async () => {
		await build();
		rmSync(join(indexDir(store), "tier0.json"));

		const { index } = StoreIndex.open(store);
		expect(index.search("vitest")).toHaveLength(1);
	});

	it("is rebuilt from the journal, so nothing is lost by deleting it", async () => {
		await build();
		const before = readFileSync(join(indexDir(store), "manifest.json"), "utf-8");
		rmSync(indexDir(store), { recursive: true, force: true });

		const { index } = StoreIndex.open(store);
		index.save();
		expect(index.search("vitest")).toHaveLength(1);
		// Same files, same hashes: the index is a function of the store.
		expect(JSON.parse(readFileSync(join(indexDir(store), "manifest.json"), "utf-8"))).toEqual(JSON.parse(before));
	});
});
