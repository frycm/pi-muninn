import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isHostId } from "../../src/ids.ts";
import { loadHostIdentity, shortHostname } from "../../src/store/host.ts";
import {
	globalStorePath,
	hostFilePath,
	inRepoProjectStorePath,
	projectStoreSlug,
	separateProjectStorePath,
} from "../../src/store/paths.ts";

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "muninn-host-"));
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

describe("shortHostname", () => {
	it("takes the first label and slugifies it", () => {
		expect(shortHostname("MacBook-Pro.local")).toBe("macbook-pro");
		expect(shortHostname("ops1")).toBe("ops1");
		expect(shortHostname("weird__name!!")).toBe("weird-name");
	});

	it("never returns an empty name", () => {
		expect(shortHostname("...")).toBe("host");
		expect(shortHostname("")).toBe("host");
	});
});

describe("loadHostIdentity", () => {
	it("mints an identity on first run and persists it", () => {
		const first = loadHostIdentity(agentDir);
		expect(isHostId(first.id)).toBe(true);
		expect(first.name).not.toBe("");

		const second = loadHostIdentity(agentDir);
		expect(second.id).toBe(first.id);
	});

	it("writes the identity where the design says it lives", () => {
		const identity = loadHostIdentity(agentDir);
		const onDisk = JSON.parse(readFileSync(hostFilePath(agentDir), "utf-8")) as { id: string };
		expect(onDisk.id).toBe(identity.id);
	});

	it("adopts an id another session wrote first rather than overwriting it", () => {
		// Two pi sessions can start at the same moment on a fresh machine. The
		// loser of that race must take the winner's id: two ids for one machine
		// would split its journal directory in two.
		const path = hostFilePath(agentDir);
		mkdirSync(join(agentDir, "muninn"), { recursive: true });
		const winner = {
			id: "0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01",
			name: "winner",
			createdAt: "2026-08-23T00:00:00.000Z",
		};
		writeFileSync(path, JSON.stringify(winner));

		expect(loadHostIdentity(agentDir).id).toBe(winner.id);
	});

	it("fails loudly on a corrupt host file rather than minting a second identity", () => {
		mkdirSync(join(agentDir, "muninn"), { recursive: true });
		writeFileSync(hostFilePath(agentDir), "{ not json");
		expect(() => loadHostIdentity(agentDir)).toThrow(/could not be read/);
	});
});

describe("store paths", () => {
	it("puts the global store under the agent directory", () => {
		expect(globalStorePath("/home/u/.pi/agent")).toBe("/home/u/.pi/agent/muninn");
	});

	it("derives a stable, readable slug for a project", () => {
		const slug = projectStoreSlug("/Users/me/src/my-app");
		expect(slug.startsWith("my-app-")).toBe(true);
		expect(projectStoreSlug("/Users/me/src/my-app")).toBe(slug);
	});

	it("keeps two checkouts of the same project name apart", () => {
		// Same basename, different paths: these may be different worktrees on
		// different branches, so sharing one store would be a surprise.
		expect(projectStoreSlug("/a/my-app")).not.toBe(projectStoreSlug("/b/my-app"));
	});

	it("defaults a project store to a separate repository, not the project's own", () => {
		const path = separateProjectStorePath("/home/u/.pi/agent", "/src/app");
		expect(path.startsWith("/home/u/.pi/agent/muninn-projects/")).toBe(true);
		expect(path).not.toContain("/src/app/");
	});

	it("puts an in-repo store inside the project", () => {
		expect(inRepoProjectStorePath("/src/app", ".pi")).toBe("/src/app/.pi/muninn");
	});
});
