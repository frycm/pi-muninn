import { describe, expect, it } from "vitest";
import type { Chunk } from "../../src/index/chunk.ts";
import { snippet, Tier0Index } from "../../src/index/tier0.ts";

const ENTRY_A = "j-01a02e19-f1c6-7142-bcb1-2806083bd725";
const ENTRY_B = "j-01a02e1b-655b-7317-bf15-3bba2f63f9c1";
const FACT = "f-testing-01a02e1c-1234-7abc-8def-1234567890ab";

function chunk(overrides: Partial<Chunk> & { id: string }): Chunk {
	return {
		kind: "claim",
		path: "journal/host/2026-08-22.md",
		title: "",
		headingPath: "journal › 2026-08-22 › 14:32",
		body: "",
		tags: "claim user",
		links: [],
		...overrides,
	};
}

function indexOf(...chunks: Chunk[]): Tier0Index {
	const index = Tier0Index.empty();
	index.add(chunks);
	return index;
}

describe("Tier0Index.search", () => {
	it("finds a claim by its words", () => {
		const index = indexOf(
			chunk({
				id: `${ENTRY_A}.1`,
				body: "Run `pnpm test --run`; vitest watch mode hangs the CI job.",
				date: "2026-08-22",
			}),
			chunk({ id: `${ENTRY_B}.1`, body: "The database URL points at the docker compose service.", date: "2026-08-21" }),
		);
		const hits = index.search("vitest watch");
		expect(hits[0]?.id).toBe(`${ENTRY_A}.1`);
		expect(hits).toHaveLength(1);
	});

	it("weighs the cue above the body: a cue is written to answer *when would I need this*", () => {
		const cued = chunk({ id: `${ENTRY_A}.1`, cue: "when CI hangs", body: "Use the --run flag." });
		const bodied = chunk({ id: `${ENTRY_B}.1`, body: "Some note about CI that hangs around in passing." });
		const hits = indexOf(cued, bodied).search("CI hangs");
		expect(hits[0]?.id).toBe(`${ENTRY_A}.1`);
	});

	it("matches a prefix and tolerates a typo", () => {
		const index = indexOf(chunk({ id: `${ENTRY_A}.1`, body: "vitest hangs in continuous integration" }));
		expect(index.search("vites").map((hit) => hit.id)).toEqual([`${ENTRY_A}.1`]);
		expect(index.search("integrtion").map((hit) => hit.id)).toEqual([`${ENTRY_A}.1`]);
	});

	it("returns nothing for an empty query", () => {
		expect(indexOf(chunk({ id: `${ENTRY_A}.1`, body: "anything" })).search("   ")).toEqual([]);
	});

	it("breaks a score tie by date, newest first", () => {
		const index = indexOf(
			chunk({ id: `${ENTRY_A}.1`, body: "identical text", date: "2026-08-20" }),
			chunk({ id: `${ENTRY_B}.1`, body: "identical text", date: "2026-08-22" }),
		);
		expect(index.search("identical text").map((hit) => hit.id)).toEqual([`${ENTRY_B}.1`, `${ENTRY_A}.1`]);
	});

	it("honours the limit", () => {
		const chunks = Array.from({ length: 5 }, (_value, position) =>
			chunk({ id: `${ENTRY_A}.${position + 1}`, body: `vitest note number ${position}` }),
		);
		expect(indexOf(...chunks).search("vitest", { limit: 2 })).toHaveLength(2);
	});
});

describe("Tier0Index — active-only", () => {
	const claim = chunk({ id: `${ENTRY_A}.1`, body: "vitest watch mode hangs CI" });
	const prose = chunk({ id: `${ENTRY_A}#prose`, kind: "prose", body: "vitest was hanging while we looked at CI" });

	it("does not match context chunks by default", () => {
		expect(
			indexOf(claim, prose)
				.search("vitest")
				.map((hit) => hit.id),
		).toEqual([`${ENTRY_A}.1`]);
	});

	it("matches them when the caller asks for history", () => {
		const ids = indexOf(claim, prose)
			.search("vitest", { history: true })
			.map((hit) => hit.id);
		expect(ids).toContain(`${ENTRY_A}#prose`);
	});

	it("drops a claim listed in supersessions.md, and returns it under history", () => {
		const index = indexOf(claim);
		const superseded = new Set([`${ENTRY_A}.1`]);
		expect(index.search("vitest", { superseded })).toEqual([]);
		const withHistory = index.search("vitest", { superseded, history: true });
		expect(withHistory[0]?.superseded).toBe(true);
	});

	it("drops a fact the file itself marks superseded", () => {
		const index = indexOf(chunk({ id: FACT, kind: "fact", body: "tests run with pnpm test", superseded: true }));
		expect(index.search("pnpm test")).toEqual([]);
		expect(index.search("pnpm test", { history: true })).toHaveLength(1);
	});

	it("filters by kind, phase and source", () => {
		const index = indexOf(
			chunk({ id: `${ENTRY_A}.1`, body: "vitest note", phase: "test", source: "user" }),
			chunk({ id: `${ENTRY_B}.1`, body: "vitest note", phase: "ops", source: "agent" }),
			chunk({ id: FACT, kind: "fact", body: "vitest note", phase: "test", source: "agent" }),
		);
		expect(index.search("vitest", { kind: ["fact"] }).map((hit) => hit.id)).toEqual([FACT]);
		expect(index.search("vitest", { phase: "ops" }).map((hit) => hit.id)).toEqual([`${ENTRY_B}.1`]);
		expect(index.search("vitest", { source: "user" }).map((hit) => hit.id)).toEqual([`${ENTRY_A}.1`]);
	});
});

describe("Tier0Index — the link graph", () => {
	it("records what a chunk points at, and who points back", () => {
		const index = indexOf(
			chunk({ id: `${ENTRY_B}.1`, body: `supersedes ${ENTRY_A}.1`, links: [`${ENTRY_A}.1`] }),
			chunk({ id: FACT, kind: "fact", body: "evidence", links: [`${ENTRY_A}.1`] }),
		);
		expect(index.linksFrom(`${ENTRY_B}.1`)).toEqual([`${ENTRY_A}.1`]);
		expect(index.backlinksTo(`${ENTRY_A}.1`)).toEqual([FACT, `${ENTRY_B}.1`]);
	});

	it("forgets a chunk's edges when it is discarded", () => {
		const index = indexOf(chunk({ id: `${ENTRY_B}.1`, body: "points", links: [`${ENTRY_A}.1`] }));
		index.discard([`${ENTRY_B}.1`]);
		expect(index.backlinksTo(`${ENTRY_A}.1`)).toEqual([]);
		expect(index.search("points")).toEqual([]);
	});
});

describe("Tier0Index — persistence", () => {
	it("round-trips through its serialised form, links included", () => {
		const index = indexOf(chunk({ id: `${ENTRY_A}.1`, body: "vitest watch hangs", links: [FACT] }));
		const loaded = Tier0Index.load(JSON.parse(JSON.stringify(index.toJSON())));
		expect(loaded.search("vitest").map((hit) => hit.id)).toEqual([`${ENTRY_A}.1`]);
		expect(loaded.backlinksTo(FACT)).toEqual([`${ENTRY_A}.1`]);
		expect(loaded.size).toBe(1);
	});

	it("replaces a chunk that is added twice rather than throwing", () => {
		const index = indexOf(chunk({ id: `${ENTRY_A}.1`, body: "first text" }));
		index.add([chunk({ id: `${ENTRY_A}.1`, body: "second text" })]);
		expect(index.size).toBe(1);
		expect(index.search("first")).toEqual([]);
		expect(index.search("second").map((hit) => hit.id)).toEqual([`${ENTRY_A}.1`]);
	});
});

describe("snippet", () => {
	it("returns a short body unchanged, with whitespace collapsed", () => {
		expect(snippet("one\n  two", "one")).toBe("one two");
	});

	it("windows a long body around the first matching term", () => {
		const body = `${"padding ".repeat(60)}needle ${"padding ".repeat(60)}`;
		const result = snippet(body, "needle");
		expect(result).toContain("needle");
		expect(result.startsWith("…")).toBe(true);
		expect(result.length).toBeLessThan(body.length);
	});

	it("falls back to the head of the body when nothing matches", () => {
		const body = "padding ".repeat(60);
		expect(snippet(body, "needle").endsWith("…")).toBe(true);
	});
});
