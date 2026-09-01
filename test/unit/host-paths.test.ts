import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isHostId } from "../../src/ids.ts";
import { loadHostIdentity, shortHostname } from "../../src/store/host.ts";
import {
	globalStorePath,
	hostFilePath,
	projectRegistryPath,
	projectStorePath,
	projectsRootPath,
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

	it("keeps the user-owned project registry below the agent directory", () => {
		expect(projectsRootPath("/home/u/.pi/agent")).toBe("/home/u/.pi/agent/muninn-projects");
		expect(projectRegistryPath("/home/u/.pi/agent")).toBe("/home/u/.pi/agent/muninn-projects/registry.json");
	});

	it("names a project store only by its durable UUID", () => {
		const id = "0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b02";
		expect(projectStorePath("/home/u/.pi/agent", id)).toBe(`/home/u/.pi/agent/muninn-projects/${id}`);
	});
});
