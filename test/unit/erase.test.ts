import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetCommitDebounce } from "../../src/capture/commit.ts";
import { erase, eraseImpact, hasFilterRepo } from "../../src/dream/erase.ts";
import { git } from "../../src/git.ts";
import { newHostId } from "../../src/ids.ts";
import { indexDir, StoreIndex } from "../../src/index/build.ts";
import { resetSupersessionCache, search } from "../../src/index/search.ts";
import { appendEntry } from "../../src/journal/append.ts";
import { readErasures } from "../../src/journal/erasures.ts";
import { readStoreJournal } from "../../src/journal/read.ts";
import { readSupersessions } from "../../src/journal/supersessions.ts";
import type { HostIdentity } from "../../src/store/host.ts";
import { ensureStore } from "../../src/store/init.ts";
import type { ActiveScope } from "../../src/store/scopes.ts";
import { formatTopic, parseTopic } from "../../src/topics/format.ts";

let home: string;
let storePath: string;
let host: HostIdentity;
let scope: ActiveScope;
const NOW = new Date("2026-08-25T09:00:00Z");
const SECRET = "the customer's home address is 14 Elm Row, Edinburgh";

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "muninn-erase-"));
	storePath = join(home, "agent", "muninn");
	mkdirSync(join(home, "agent"), { recursive: true });
	host = { id: newHostId(), name: "mbp", createdAt: "2026-08-01" };
	await ensureStore(storePath, { host });
	scope = { scope: "global", path: storePath, exists: true, inRepo: false };
	resetCommitDebounce();
	resetSupersessionCache();
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

async function note(text: string): Promise<string> {
	const result = await appendEntry(
		{ source: "user", prose: "Context.", claims: [text] },
		{ storePath, hostId: host.id },
	);
	resetCommitDebounce();
	return result.id;
}

/** A topic whose one fact rests on the entry about to be erased. */
function topicCiting(claimId: string): string {
	const topic = parseTopic("# People\n", "people");
	const factId = "f-people-0198f2c2-0a1b-7c2d-8e3f-405162738495";
	topic.facts.push({
		id: factId,
		claim: "A fact resting on it.",
		validFrom: "2026-08-22",
		source: "user",
		evidence: [claimId],
	});
	mkdirSync(join(storePath, "topics"), { recursive: true });
	writeFileSync(join(storePath, "topics", "people.md"), formatTopic(topic));
	return factId;
}

describe("erase", () => {
	it("tombstones the entry, lists it, and supersedes what rested on it", async () => {
		const id = await note(SECRET);
		const factId = topicCiting(`${id}.1`);

		const impact = eraseImpact(storePath, id);
		expect(impact.facts).toEqual([factId]);

		const result = await erase({ scope, host, entryId: id, now: NOW, noRewrite: true });
		expect(result.problems).toEqual([]);
		expect(result.ok).toBe(true);

		// 1. the body is gone from the file, the id is not
		const daily = readFileSync(readStoreJournal(storePath).entries[0]?.path as string, "utf-8");
		expect(daily).not.toContain("Elm Row");
		expect(daily).toContain(id);
		expect(daily).toContain("erased: 2026-08-25");

		// 2. listed, so another host drops it instead of resurrecting it
		expect(readErasures(storePath).ids.has(id)).toBe(true);

		// 3. the fact that rested on it is superseded, with the reason
		const topic = parseTopic(readFileSync(join(storePath, "topics", "people.md"), "utf-8"), "people");
		expect(topic.facts).toEqual([]);
		expect(topic.superseded[0]?.reason).toBe("erased");
		expect(result.supersededFacts).toEqual([factId]);
		expect(readSupersessions(storePath).superseded.has(`${id}.1`)).toBe(true);

		// 4. the index held a copy of the text
		expect(existsSync(indexDir(storePath))).toBe(false);
		const rebuilt = StoreIndex.open(storePath).index;
		expect(search([{ scope: "global", storePath, index: rebuilt }], { query: "Elm Row", history: true })).toEqual([]);
	});

	it("refuses without git-filter-repo rather than erasing halfway", async () => {
		const id = await note(SECRET);
		const result = await erase({ scope, host, entryId: id, now: NOW });

		if (await hasFilterRepo(storePath)) {
			// On a machine that has it, the rewrite is the point.
			expect(result.ok).toBe(true);
			expect(result.rewroteHistory).toBe(true);
			return;
		}
		expect(result.ok).toBe(false);
		expect(result.problems.join(" ")).toContain("git-filter-repo is not installed");
		// And nothing was done: a refusal must not leave a half-erased store.
		expect(readStoreJournal(storePath).entries[0]?.claims[0]).toContain("Elm Row");
		expect(readErasures(storePath).ids.size).toBe(0);
	});

	it("says out loud what --no-rewrite leaves behind", async () => {
		const id = await note(SECRET);
		const result = await erase({ scope, host, entryId: id, now: NOW, noRewrite: true });
		expect(result.rewroteHistory).toBe(false);
		expect(result.notes.join(" ")).toContain("still reachable in .git");
		// The old bytes really are still there, which is why it has to be said.
		const { stdout } = await git(storePath, { kind: "log-entries", ref: "main", limit: 20 });
		expect(stdout.length).toBeGreaterThan(0);
	});

	it("refuses in an in-repo store, because that history is not Muninn's", async () => {
		const inRepo: ActiveScope = { ...scope, inRepo: true, scope: "project" };
		const result = await erase({ scope: inRepo, host, entryId: "j-x", now: NOW, noRewrite: true });
		expect(result.ok).toBe(false);
		expect(result.problems.join(" ")).toContain("project's own history");
	});

	it("reports an id that is not there, and one already erased, differently", async () => {
		const missing = await erase({
			scope,
			host,
			entryId: "j-01a00000-0000-7000-8000-000000000099",
			now: NOW,
			noRewrite: true,
		});
		expect(missing.problems.join(" ")).toContain("no journal entry");

		const id = await note(SECRET);
		await erase({ scope, host, entryId: id, now: NOW, noRewrite: true });
		const again = await erase({ scope, host, entryId: id, now: NOW, noRewrite: true });
		expect(again.problems.join(" ")).toContain("already erased");
	});
});
