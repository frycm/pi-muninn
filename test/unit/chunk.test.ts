import { describe, expect, it } from "vitest";
import { chunkJournalEntry, extractLinks } from "../../src/index/chunk.ts";
import type { JournalEntryWithContext } from "../../src/journal/read.ts";

const ENTRY_ID = "j-01a02e19-f1c6-7142-bcb1-2806083bd725";
const OTHER_ID = "j-01a02e1b-655b-7317-bf15-3bba2f63f9c1";

function entry(overrides: Partial<JournalEntryWithContext> = {}): JournalEntryWithContext {
	return {
		id: ENTRY_ID,
		time: "14:32",
		source: "user",
		date: "2026-08-22",
		host: "01a02e10-0000-7000-8000-000000000001",
		path: "/store/journal/host/2026-08-22.md",
		prose: "",
		claims: [],
		...overrides,
	};
}

describe("chunkJournalEntry", () => {
	it("makes one addressable chunk per claim", () => {
		const chunks = chunkJournalEntry(
			entry({
				cue: "when vitest hangs in CI",
				phase: "test",
				claims: ["Run `pnpm test --run`.", "The runner has no TTY."],
				prose: "The CI job was hanging.",
			}),
			"journal/host/2026-08-22.md",
		);

		const claims = chunks.filter((chunk) => chunk.kind === "claim");
		expect(claims.map((chunk) => chunk.id)).toEqual([`${ENTRY_ID}.1`, `${ENTRY_ID}.2`]);
		expect(claims[0]).toMatchObject({
			cue: "when vitest hangs in CI",
			phase: "test",
			source: "user",
			date: "2026-08-22",
			entry: ENTRY_ID,
			headingPath: "journal › 2026-08-22 › 14:32",
		});
	});

	it("indexes prose as context without duplicating an implicit claim", () => {
		const explicit = chunkJournalEntry(
			entry({ claims: ["A claim."], prose: "The situation around it." }),
			"journal/host/2026-08-22.md",
		);
		expect(explicit.find((chunk) => chunk.kind === "prose")?.body).toBe("The situation around it.");

		const implicit = chunkJournalEntry(entry({ prose: "Only context here." }), "journal/host/2026-08-22.md");
		expect(implicit).toHaveLength(1);
		expect(implicit[0]?.id).toBe(`${ENTRY_ID}.1`);
	});

	it("records journal ids a claim mentions, but never itself", () => {
		const chunks = chunkJournalEntry(
			entry({ claims: [`Corrects ${OTHER_ID}.1 and links [[deployment|the deployment notes]].`] }),
			"journal/host/2026-08-22.md",
		);
		expect(chunks[0]?.links).toEqual(["deployment", `${OTHER_ID}.1`]);
	});
});

describe("extractLinks", () => {
	it("ignores text that does not contain a journal id or wikilink", () => {
		expect(extractLinks("plain prose about j-something and R-014")).toEqual([]);
	});
});
