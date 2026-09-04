import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSigningIdentity } from "../../src/governance/identity.ts";
import { enrollProjectSigningKey } from "../../src/governance/registry.ts";
import { newHostId, newMemberId, newProjectId, newTeamEventId } from "../../src/ids.ts";
import { JournalQueryService } from "../../src/journal/query.ts";
import { appendAuthorizedJournalRecord } from "../../src/journal/writer.ts";
import type { MemberIdentity } from "../../src/project/registry.ts";
import type { HostIdentity } from "../../src/store/host.ts";
import { ensureStore } from "../../src/store/init.ts";
import {
	mergeProjectManifests,
	type ProjectManifest,
	parseProjectManifest,
	readProjectManifest,
} from "../../src/store/project-manifest.ts";
import { declareTeamEvent, projectTeamRoster, verifyTeamEventSignature } from "../../src/team/lifecycle.ts";

let root: string;
let store: string;
let project: string;
let member: MemberIdentity;
let host: HostIdentity;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "muninn-team-"));
	store = join(root, "store");
	project = newProjectId();
	member = { id: newMemberId(), name: "Martin", createdAt: "2026-09-01T00:00:00.000Z" };
	host = { id: newHostId(), name: "laptop", createdAt: "2026-09-01T00:00:00.000Z" };
	await ensureStore(store, { host, project: { id: project, name: "demo", member } });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function event(
	kind: "member-renamed" | "member-retired" | "member-restored",
	at: string,
	extra: { id?: string; name?: string } = {},
) {
	return {
		id: extra.id ?? newTeamEventId(),
		at,
		kind,
		member: member.id,
		actor_member: member.id,
		actor_host: host.id,
		...(extra.name ? { name: extra.name } : {}),
	};
}

describe("team lifecycle manifest", () => {
	it("accepts old schema-1 manifests as an empty event stream", () => {
		const manifest = readProjectManifest(store) as ProjectManifest;
		const { team_events: _events, ...old } = manifest;
		expect(parseProjectManifest(JSON.stringify(old)).team_events).toEqual([]);
	});

	it("projects events in timestamp then ID order", () => {
		const manifest = readProjectManifest(store) as ProjectManifest;
		const retired = event("member-retired", "2026-09-03T00:00:00.000Z");
		const renamed = event("member-renamed", "2026-09-02T00:00:00.000Z", { name: "Marty" });
		const restored = event("member-restored", "2026-09-04T00:00:00.000Z");
		const canonical = parseProjectManifest(JSON.stringify({ ...manifest, team_events: [restored, retired, renamed] }));
		expect(canonical.team_events.map((item) => item.id)).toEqual([renamed.id, retired.id, restored.id]);
		expect(projectTeamRoster(canonical, member.id, host.id)).toMatchObject({
			members: [{ id: member.id, name: "Marty", state: "active", local: true }],
			hosts: [{ id: host.id, state: "active", local: true }],
		});
	});

	it("union-merges independent events and rejects collisions or forged administration", () => {
		const manifest = readProjectManifest(store) as ProjectManifest;
		const first = event("member-renamed", "2026-09-02T00:00:00.000Z", { name: "Marty" });
		const second = event("member-retired", "2026-09-03T00:00:00.000Z");
		const merged = mergeProjectManifests({ ...manifest, team_events: [first] }, { ...manifest, team_events: [second] });
		expect(merged.team_events.map((item) => item.id)).toEqual([first.id, second.id]);
		expect(() =>
			mergeProjectManifests(
				{ ...manifest, team_events: [first] },
				{ ...manifest, team_events: [{ ...first, name: "Someone else" }] },
			),
		).toThrow(/team event id collision/);
		expect(() =>
			parseProjectManifest(JSON.stringify({ ...manifest, team_events: [{ ...second, member: newMemberId() }] })),
		).toThrow(/unknown member|self-declared/);
	});

	it("rejects terminal controls, direction changes, and secrets in synchronized metadata", () => {
		const manifest = readProjectManifest(store) as ProjectManifest;
		for (const name of ["host\u001b[2J", "member\u202Etxt", "token=abcdefghijklmnopqrstuvwx"]) {
			expect(() =>
				parseProjectManifest(
					JSON.stringify({
						...manifest,
						team_events: [event("member-renamed", "2026-09-02T00:00:00.000Z", { name })],
					}),
				),
			).toThrow(/control|direction|secret/);
		}
	});
});

describe("team lifecycle declarations", () => {
	it("signs the canonical declaration with an enrolled member key", async () => {
		const signing = generateSigningIdentity(member.id, new Date("2026-09-02T00:00:00.000Z"));
		await enrollProjectSigningKey({ storePath: store, project, member: member.id, host, identity: signing });
		const declared = await declareTeamEvent({
			storePath: store,
			project,
			actorMember: member.id,
			actorHost: host.id,
			actorHostName: host.name,
			kind: "member-renamed",
			name: "Marty",
			at: "2026-09-03T00:00:00.000Z",
			signing,
		});
		expect(declared.event.signature).toMatchObject({ key: signing.id, algorithm: "ed25519" });
		expect(verifyTeamEventSignature(declared.event, signing.public_key)).toBe(true);
		expect(verifyTeamEventSignature({ ...declared.event, name: "Mallory" }, signing.public_key)).toBe(false);
		expect(readProjectManifest(store)).toMatchObject({ schema: 2 });
	});

	it("commits a local self-declaration and refuses a teammate target", async () => {
		const declared = await declareTeamEvent({
			storePath: store,
			project,
			actorMember: member.id,
			actorHost: host.id,
			actorHostName: host.name,
			kind: "member-renamed",
			name: "Marty",
		});
		expect(declared.committed).toBe(true);
		expect(readProjectManifest(store)?.team_events).toHaveLength(1);
		expect(declared.roster.members[0]?.name).toBe("Marty");
		await expect(
			declareTeamEvent({
				storePath: store,
				project,
				actorMember: member.id,
				actorHost: host.id,
				actorHostName: host.name,
				kind: "member-retired",
				member: newMemberId(),
			}),
		).rejects.toThrow(/only target you/);
	});

	it("keeps records visible and adds advisory labels and post-retirement warnings", async () => {
		await declareTeamEvent({
			storePath: store,
			project,
			actorMember: member.id,
			actorHost: host.id,
			actorHostName: host.name,
			kind: "member-retired",
			at: "2020-01-01T00:00:00.000Z",
		});
		const written = await appendAuthorizedJournalRecord(
			{ authority: "headless-user", record: { type: "note", source: "user", channel: "cli", body: "Still visible." } },
			{ storePath: store, project, member: member.id, host: host.id },
		);
		const result = new JournalQueryService({ storePath: store, localMember: member.id, mode: "scan" }).query({
			ids: [written.id],
		});
		expect(result.records).toHaveLength(1);
		expect(result.records[0]?.labels).toContain("retired-member");
		expect(result.records[0]?.labels).toContain("retired-host");
		expect(result.warnings.join("\n")).toContain("was written while its member was retired");
		const filtered = new JournalQueryService({ storePath: store, localMember: member.id, mode: "scan" }).query({
			label: ["retired-member"],
		});
		expect(filtered.records.map((record) => record.id)).toEqual([written.id]);
	});
});
