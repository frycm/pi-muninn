import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetCommitDebounce } from "../../src/capture/commit.ts";
import { newHostId } from "../../src/ids.ts";
import { appendEntry } from "../../src/journal/append.ts";
import { readStoreJournal } from "../../src/journal/read.ts";
import type { HostIdentity } from "../../src/store/host.ts";
import { ensureStore } from "../../src/store/init.ts";
import { mergeStoreMd, parseStoreMd, type StoreMd } from "../../src/store/store-md.ts";
import { describeSync, sync } from "../../src/sync/sync.ts";

const execFileAsync = promisify(execFile);

let root: string;
let remote: string;
let one: string;
let two: string;
let hostOne: HostIdentity;
let hostTwo: HostIdentity;

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
	return stdout;
}

function host(name: string): HostIdentity {
	return { id: newHostId(), name, createdAt: "2026-08-22T00:00:00.000Z" };
}

async function note(storePath: string, identity: HostIdentity, claim: string): Promise<void> {
	await appendEntry({ source: "user", prose: "", claims: [claim] }, { storePath, hostId: identity.id });
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "muninn-sync-"));
	remote = join(root, "remote.git");
	one = join(root, "laptop-one");
	two = join(root, "laptop-two");
	mkdirSync(remote, { recursive: true });
	await git(remote, ["init", "--bare", "--quiet", "--initial-branch=main"]);

	hostOne = host("laptop-one");
	hostTwo = host("laptop-two");
	resetCommitDebounce();
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Set up laptop one with one entry, synced to the remote. */
async function seedOne(): Promise<void> {
	await ensureStore(one, { host: hostOne });
	await git(one, ["branch", "-M", "main"]);
	await note(one, hostOne, "vitest watch mode hangs the CI job.");
	const result = await sync({ storePath: one, hostId: hostOne.id, hostName: hostOne.name, remote });
	expect(result.problem).toBeUndefined();
	expect(result.pushed).toBe(true);
}

describe("sync", () => {
	it("commits, pushes, and says what it did", async () => {
		await ensureStore(one, { host: hostOne });
		await git(one, ["branch", "-M", "main"]);
		await note(one, hostOne, "Deploys need the VPN.");

		const result = await sync({ storePath: one, hostId: hostOne.id, hostName: hostOne.name, remote });

		expect(result.committed).toBe(true);
		expect(result.fetched).toBe(true);
		expect(result.pushed).toBe(true);
		expect(describeSync(result)).toBe("sync: committed, fetched, pushed");
		expect(await git(remote, ["log", "-1", "--format=%s", "main"])).toContain("journal:");
	});

	it("carries another host's entries back on the next sync", async () => {
		await seedOne();
		await git(root, ["clone", "--quiet", remote, two]);
		await ensureStore(two, { host: hostTwo });
		await note(two, hostTwo, "The staging database resets nightly.");

		const second = await sync({ storePath: two, hostId: hostTwo.id, hostName: hostTwo.name, remote });
		expect(second.pushed).toBe(true);

		// Laptop one picks up both hosts' journals, without a merge.
		const back = await sync({ storePath: one, hostId: hostOne.id, hostName: hostOne.name, remote });
		expect(back.rebased).toBe(true);
		expect(back.problem).toBeUndefined();

		const claims = readStoreJournal(one).entries.flatMap((entry) => entry.claims);
		expect(claims).toContain("vitest watch mode hangs the CI job.");
		expect(claims).toContain("The staging database resets nightly.");
	});

	it("union-merges a concurrent host registration in store.md", async () => {
		// The one conflict Phase 1 resolves: two hosts adding themselves to the
		// registry at the same time, from stores that had not seen each other.
		await seedOne();
		await git(root, ["clone", "--quiet", remote, two]);
		await ensureStore(two, { host: hostTwo });

		// A third machine registers and pushes while laptop two was not looking.
		const hostThree = host("server");
		await ensureStore(one, { host: hostThree });
		const pushed = await sync({ storePath: one, hostId: hostThree.id, hostName: hostThree.name, remote });
		expect(pushed.pushed).toBe(true);

		const result = await sync({ storePath: two, hostId: hostTwo.id, hostName: hostTwo.name, remote });

		expect(result.problem).toBeUndefined();
		expect(result.mergedRegistry).toBe(true);
		expect(result.pushed).toBe(true);
		expect(result.notes.join("\n")).toContain("merged store.md host registries");

		const registry = parseStoreMd(readFileSync(join(two, "store.md"), "utf-8")).store as StoreMd;
		expect(registry.hosts.map((entry) => entry.id).sort()).toEqual([hostOne.id, hostThree.id, hostTwo.id].sort());
		// And the merge is what everyone else gets, too.
		const fetched = await sync({ storePath: one, hostId: hostOne.id, hostName: hostOne.name, remote });
		expect(fetched.problem).toBeUndefined();
		expect(parseStoreMd(readFileSync(join(one, "store.md"), "utf-8")).store?.hosts).toHaveLength(3);
	});

	it("stops on a conflict it does not understand, leaving the store where it was", async () => {
		await seedOne();
		await git(root, ["clone", "--quiet", remote, two]);
		await ensureStore(two, { host: hostTwo });

		// A hand-edited MEMORY.md on both sides: exactly the case the design says
		// sync must refuse rather than guess at.
		writeFileSync(join(one, "MEMORY.md"), "# Memory\n\n- laptop one's line\n");
		await git(one, ["commit", "--quiet", "-m", "memory", "--", "MEMORY.md"]);
		await sync({ storePath: one, hostId: hostOne.id, hostName: hostOne.name, remote });

		writeFileSync(join(two, "MEMORY.md"), "# Memory\n\n- laptop two's line\n");
		await git(two, ["commit", "--quiet", "-m", "memory", "--", "MEMORY.md"]);
		const head = (await git(two, ["rev-parse", "HEAD"])).trim();

		const result = await sync({ storePath: two, hostId: hostTwo.id, hostName: hostTwo.name, remote });

		expect(result.problem).toContain("MEMORY.md");
		expect(result.stoppedAt).toBe("rebase");
		expect(result.pushed).toBe(false);
		// The store is exactly where it was: no rebase in progress, same HEAD.
		expect((await git(two, ["rev-parse", "HEAD"])).trim()).toBe(head);
		expect((await git(two, ["status", "--porcelain"])).trim()).toBe("");
		expect(readFileSync(join(two, "MEMORY.md"), "utf-8")).toContain("laptop two's line");
	});

	it("commits locally and says so when the remote cannot be reached", async () => {
		await ensureStore(one, { host: hostOne });
		await git(one, ["branch", "-M", "main"]);
		await note(one, hostOne, "Written while offline.");

		const result = await sync({
			storePath: one,
			hostId: hostOne.id,
			hostName: hostOne.name,
			remote: join(root, "does-not-exist.git"),
		});

		expect(result.committed).toBe(true);
		expect(result.offline).toBe(true);
		expect(result.stoppedAt).toBe("fetch");
		expect(result.notes.join("\n")).toContain("offline");
		// The entry is durable either way; the next sync carries it.
		expect(readStoreJournal(one).entries).toHaveLength(1);
	});

	it("commits and stops when there is no remote at all", async () => {
		await ensureStore(one, { host: hostOne });
		await note(one, hostOne, "Nowhere to push this.");

		const result = await sync({ storePath: one, hostId: hostOne.id, hostName: hostOne.name, remote: null });
		expect(result.committed).toBe(true);
		expect(result.pushed).toBe(false);
		expect(result.notes.join("\n")).toContain("no remote configured");
	});

	it("uses the remote the store already has when no setting names one", async () => {
		// How a project store syncs: it has no setting of its own, because a
		// project settings file travels with a repository anyone can clone.
		await ensureStore(one, { host: hostOne });
		await git(one, ["branch", "-M", "main"]);
		await git(one, ["remote", "add", "origin", remote]);
		await note(one, hostOne, "Project memory, pushed to the project's own remote.");

		const result = await sync({ storePath: one, hostId: hostOne.id, hostName: hostOne.name, remote: null });

		expect(result.pushed).toBe(true);
		expect(result.notes.join("\n")).toContain("using the store's own remote");
	});

	it("never pushes an in-repo store", async () => {
		// That repository belongs to the project; pushing it would push the
		// user's own code as a side effect of remembering something.
		mkdirSync(one, { recursive: true });
		await git(one, ["init", "--quiet", "--initial-branch=main"]);
		await git(one, ["config", "user.email", "dev@example.com"]);
		await git(one, ["config", "user.name", "Dev"]);
		await ensureStore(one, { host: hostOne, inRepo: true });
		await git(one, ["remote", "add", "origin", remote]);
		await note(one, hostOne, "Stays here.");

		const result = await sync({
			storePath: one,
			hostId: hostOne.id,
			hostName: hostOne.name,
			remote: null,
			useExistingRemote: false,
		});

		expect(result.committed).toBe(true);
		expect(result.pushed).toBe(false);
		expect(result.notes.join("\n")).toContain("never pushed by muninn");
	});

	it("skips the push when asked to", async () => {
		await seedOne();
		await note(one, hostOne, "Local only, for now.");
		const result = await sync({
			storePath: one,
			hostId: hostOne.id,
			hostName: hostOne.name,
			remote,
			noPush: true,
		});
		expect(result.fetched).toBe(true);
		expect(result.pushed).toBe(false);
		expect(result.notes).toContain("push skipped");
	});

	it("stops before the network when the deadline has already passed", async () => {
		await ensureStore(one, { host: hostOne });
		await note(one, hostOne, "Shutting down.");
		const deadline = AbortSignal.abort();

		const result = await sync({ storePath: one, hostId: hostOne.id, hostName: hostOne.name, remote, signal: deadline });

		// Committed, because that is local and always worth doing; nothing else.
		expect(result.committed).toBe(true);
		expect(result.fetched).toBe(false);
		expect(result.stoppedAt).toBe("fetch");
		expect(result.problem).toContain("ran out of time");
	});

	it("reports a store that is not a repository rather than throwing", async () => {
		mkdirSync(one, { recursive: true });
		const result = await sync({ storePath: one, hostId: hostOne.id, hostName: hostOne.name, remote });
		expect(result.problem).toContain("not a git repository");
	});
});

describe("mergeStoreMd", () => {
	const base: StoreMd = { schema: 1, store: "0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01", created: "2026-08-01", hosts: [] };

	it("keeps every host both sides know about", () => {
		const ours = { ...base, hosts: [{ id: "a", name: "mbp", registered: "2026-08-02" }] };
		const theirs = { ...base, hosts: [{ id: "b", name: "server", registered: "2026-08-03" }] };
		expect(mergeStoreMd(ours, theirs).hosts.map((entry) => entry.id)).toEqual(["a", "b"]);
	});

	it("is order-independent, so both sides produce the same bytes", () => {
		const ours = { ...base, hosts: [{ id: "b", name: "server", registered: "2026-08-03" }] };
		const theirs = { ...base, hosts: [{ id: "a", name: "mbp", registered: "2026-08-02" }] };
		expect(mergeStoreMd(ours, theirs).hosts).toEqual(mergeStoreMd(theirs, ours).hosts);
	});

	it("keeps the earlier registration date for a host both sides know", () => {
		const ours = { ...base, hosts: [{ id: "a", name: "mbp", registered: "2026-08-09" }] };
		const theirs = { ...base, hosts: [{ id: "a", name: "mbp", registered: "2026-08-02" }] };
		expect(mergeStoreMd(ours, theirs).hosts[0]?.registered).toBe("2026-08-02");
	});

	it("keeps our store identity — a merge never renames the store", () => {
		const theirs = { ...base, store: "0198f2c1-0000-7a10-9c44-2d6e0f1a8b01", created: "2026-07-01" };
		const merged = mergeStoreMd(base, theirs);
		expect(merged.store).toBe(base.store);
		expect(merged.created).toBe("2026-07-01");
	});
});
