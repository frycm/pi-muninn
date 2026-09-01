import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockBusyError, lockMetaPath, lockPath, readLockHolder, withStoreLock } from "../../src/store/lock.ts";

const execFileAsync = promisify(execFile);
const WORKER = fileURLToPath(new URL("../fixtures/lock-worker.ts", import.meta.url));

let store: string;

beforeEach(() => {
	store = mkdtempSync(join(tmpdir(), "muninn-lock-"));
});

afterEach(() => {
	rmSync(store, { recursive: true, force: true });
});

describe("withStoreLock", () => {
	it("runs the body and releases afterwards", async () => {
		const result = await withStoreLock(store, "append", { host: "h1" }, () => "done");
		expect(result).toBe("done");
		expect(existsSync(lockPath(store))).toBe(false);
		expect(existsSync(lockMetaPath(store))).toBe(false);
	});

	it("releases even when the body throws", async () => {
		await expect(
			withStoreLock(store, "append", { host: "h1" }, () => Promise.reject(new Error("boom"))),
		).rejects.toThrow("boom");
		expect(existsSync(lockPath(store))).toBe(false);
		expect(existsSync(lockMetaPath(store))).toBe(false);
	});

	it("records who holds it while it is held", async () => {
		await withStoreLock(store, "sync", { host: "host-a" }, () => {
			const holder = readLockHolder(store);
			expect(holder?.pid).toBe(process.pid);
			expect(holder?.host).toBe("host-a");
			expect(holder?.operation).toBe("sync");
			expect(Date.parse(holder?.at ?? "")).not.toBeNaN();
		});
	});

	it("excludes a second acquisition and names the holder when it gives up", async () => {
		await withStoreLock(store, "migrate", { host: "host-a" }, async () => {
			const rejected = withStoreLock(store, "append", { host: "host-b", timeoutMs: 150 }, () => "never");
			await expect(rejected).rejects.toBeInstanceOf(LockBusyError);
			await expect(rejected).rejects.toThrow(/host-a/);
		});
	});

	it("breaks a lock whose holder died without releasing it", async () => {
		// A crashed process leaves the lock directory behind with a stale mtime.
		// Recovering from that is the difference between one bad session and a
		// store nobody can write to again.
		mkdirSync(lockPath(store), { recursive: true });
		const longAgo = new Date(Date.now() - 60_000);
		utimesSync(lockPath(store), longAgo, longAgo);
		writeFileSync(lockMetaPath(store), JSON.stringify({ pid: 999999, host: "dead", operation: "append", at: "old" }));

		const result = await withStoreLock(store, "append", { host: "host-b", staleMs: 1_000 }, () => "recovered");
		expect(result).toBe("recovered");
		expect(existsSync(lockPath(store))).toBe(false);
	});

	it("does not break a lock that is still fresh", async () => {
		mkdirSync(lockPath(store), { recursive: true });
		await expect(
			withStoreLock(store, "append", { host: "host-b", staleMs: 60_000, timeoutMs: 150 }, () => "never"),
		).rejects.toBeInstanceOf(LockBusyError);
	});

	it("keeps the lock fresh while a long body runs", async () => {
		// proper-lockfile refreshes the mtime while held. Without that, a long
		// migration would look dead to the next process.
		await withStoreLock(store, "append", { host: "h1", staleMs: 2_000 }, async () => {
			const first = statSync(lockPath(store)).mtimeMs;
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			expect(statSync(lockPath(store)).mtimeMs).toBeGreaterThan(first);
		});
	});
});

describe("withStoreLock across processes", () => {
	it("serialises two processes: one waits for the other", async () => {
		const log = join(store, "log.txt");
		writeFileSync(log, "");

		await Promise.all([
			execFileAsync(process.execPath, ["--experimental-strip-types", WORKER, store, log, "a", "400"]),
			execFileAsync(process.execPath, ["--experimental-strip-types", WORKER, store, log, "b", "400"]),
		]);

		const events = readFileSync(log, "utf-8")
			.trim()
			.split("\n")
			.map((line) => {
				const [label, kind, at] = line.split(" ") as [string, string, string];
				return { label, kind, at: Number.parseInt(at, 10) };
			});

		expect(events).toHaveLength(4);
		// Both ran, and neither entered while the other held the lock.
		expect(new Set(events.map((e) => e.label))).toEqual(new Set(["a", "b"]));
		expect(events[0]?.kind).toBe("enter");
		expect(events[1]?.kind).toBe("exit");
		expect(events[1]?.label).toBe(events[0]?.label);
		expect(events[2]?.kind).toBe("enter");
		expect(events[3]?.kind).toBe("exit");
		expect(events[2]?.label).not.toBe(events[0]?.label);
	}, 30_000);
});
