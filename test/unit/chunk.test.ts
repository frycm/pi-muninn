import { describe, expect, it } from "vitest";
import {
	chunkFile,
	chunkJournalEntry,
	chunkMarkdown,
	chunkRules,
	chunkTopic,
	extractLinks,
} from "../../src/index/chunk.ts";
import type { JournalEntryWithContext } from "../../src/journal/read.ts";

const ENTRY_ID = "j-01a02e19-f1c6-7142-bcb1-2806083bd725";
const OTHER_ID = "j-01a02e1b-655b-7317-bf15-3bba2f63f9c1";
const FACT_ID = "f-testing-01a02e1c-1234-7abc-8def-1234567890ab";

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
	it("makes one chunk per claim, addressed by claim id", () => {
		const chunks = chunkJournalEntry(
			entry({
				cue: "when vitest hangs in CI",
				phase: "test",
				claims: ["Run `pnpm test --run`; watch mode hangs CI.", "The runner has no TTY."],
				prose: "Martin corrected an earlier assumption.",
			}),
			"journal/host/2026-08-22.md",
		);

		const claims = chunks.filter((chunk) => chunk.kind === "claim");
		expect(claims.map((chunk) => chunk.id)).toEqual([`${ENTRY_ID}.1`, `${ENTRY_ID}.2`]);
		expect(claims[0]?.cue).toBe("when vitest hangs in CI");
		expect(claims[0]?.phase).toBe("test");
		expect(claims[0]?.source).toBe("user");
		expect(claims[0]?.date).toBe("2026-08-22");
		expect(claims[0]?.entry).toBe(ENTRY_ID);
		expect(claims[0]?.headingPath).toBe("journal › 2026-08-22 › 14:32");
	});

	it("chunks prose as context, separately from the claims", () => {
		const chunks = chunkJournalEntry(
			entry({ claims: ["A claim."], prose: "The situation around it." }),
			"journal/host/2026-08-22.md",
		);
		const prose = chunks.find((chunk) => chunk.kind === "prose");
		expect(prose?.id).toBe(`${ENTRY_ID}#prose`);
		expect(prose?.body).toBe("The situation around it.");
	});

	it("does not duplicate the prose of an entry whose only claim is implicit", () => {
		// An entry with no bullets has exactly one claim: its prose. Emitting a
		// prose chunk as well would put the same sentence in the index twice.
		const chunks = chunkJournalEntry(entry({ prose: "Only context here." }), "journal/host/2026-08-22.md");
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.kind).toBe("claim");
		expect(chunks[0]?.id).toBe(`${ENTRY_ID}.1`);
	});

	it("records the ids a claim mentions as links, but never itself", () => {
		const chunks = chunkJournalEntry(
			entry({ claims: [`Supersedes ${OTHER_ID}.1 and confirms ${FACT_ID}.`] }),
			"journal/host/2026-08-22.md",
		);
		expect(chunks[0]?.links).toEqual([`${OTHER_ID}.1`, FACT_ID]);
	});
});

describe("extractLinks", () => {
	it("finds wikilinks, claim ids, fact ids and rule ids", () => {
		const links = extractLinks(`See [[testing|the topic]], ${OTHER_ID}.2, ${FACT_ID} and R-014.`);
		expect(links).toEqual(["testing", `${OTHER_ID}.2`, FACT_ID, "R-014"]);
	});

	it("finds nothing in text that mentions no id", () => {
		expect(extractLinks("plain prose about j-something")).toEqual([]);
	});
});

describe("chunkMarkdown", () => {
	it("carries the heading breadcrumb and the file title", () => {
		const chunks = chunkMarkdown(
			"MEMORY.md",
			"# Memory\n\nTop.\n\n## Testing\n\nUnder testing.\n\n### CI\n\nUnder CI.\n",
			"memory",
		);
		expect(chunks.map((chunk) => chunk.headingPath)).toEqual(["Memory", "Memory › Testing", "Memory › Testing › CI"]);
		expect(chunks.every((chunk) => chunk.title === "Memory")).toBe(true);
	});

	it("treats a heading inside a fence as code, not as a section", () => {
		const text = "# Doc\n\n```md\n# Not a heading\n```\n\nAfter.\n";
		const chunks = chunkMarkdown("notes.md", text, "topic");
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.body).toContain("# Not a heading");
	});

	it("splits an over-long section at blank lines but never inside a fence", () => {
		const paragraph = `${"word ".repeat(200).trim()}\n\n`;
		const fence = `\`\`\`\n${"line\n".repeat(400)}\`\`\`\n`;
		const chunks = chunkMarkdown("big.md", `# Big\n\n${paragraph.repeat(4)}${fence}`, "topic");

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			const fences = chunk.body.match(/^```/gm)?.length ?? 0;
			expect(fences % 2).toBe(0);
		}
	});

	it("names a file with no H1 after the file itself", () => {
		const chunks = chunkMarkdown("topics/testing.md", "Some text with no heading at all.\n", "topic");
		expect(chunks[0]?.title).toBe("testing");
	});

	it("reads the date out of front matter", () => {
		const chunks = chunkMarkdown(
			"topics/testing.md",
			"---\ntopic: testing\nupdated: 2026-08-22\n---\n\n# Testing\n\nBody.\n",
			"topic",
		);
		expect(chunks[0]?.date).toBe("2026-08-22");
		expect(chunks[0]?.body).toBe("Body.");
	});
});

describe("chunkTopic", () => {
	const topic = [
		"---",
		"topic: testing",
		"updated: 2026-08-22",
		"---",
		"",
		"# Testing",
		"",
		"How this project tests.",
		"",
		"## Facts",
		"",
		`- **Run tests with \`pnpm test --run\`, never watch mode.** id: ${FACT_ID} · valid_from: 2026-08-22 · source: user · evidence: ${ENTRY_ID}.1 · cue: CI hangs on vitest`,
		"",
		"## Superseded",
		"",
		`- ~~Tests run with \`pnpm test\`.~~ id: f-testing-01a02e1d-4321-7fed-9abc-0987654321ba · valid_from: 2026-08-01 · valid_to: 2026-08-22 · superseded_by: ${FACT_ID}`,
		"",
	].join("\n");

	it("makes one chunk per fact, addressed by fact id", () => {
		const facts = chunkTopic("topics/testing.md", topic).filter((chunk) => chunk.kind === "fact");
		expect(facts.map((chunk) => chunk.id)).toEqual([FACT_ID, "f-testing-01a02e1d-4321-7fed-9abc-0987654321ba"]);
		expect(facts[0]?.body).toBe("Run tests with `pnpm test --run`, never watch mode.");
		expect(facts[0]?.cue).toBe("CI hangs on vitest");
		expect(facts[0]?.source).toBe("user");
		expect(facts[0]?.date).toBe("2026-08-22");
		expect(facts[0]?.links).toContain(`${ENTRY_ID}.1`);
	});

	it("marks a fact under ## Superseded, and one carrying valid_to, as superseded", () => {
		const facts = chunkTopic("topics/testing.md", topic).filter((chunk) => chunk.kind === "fact");
		expect(facts[0]?.superseded).toBeUndefined();
		expect(facts[1]?.superseded).toBe(true);
	});

	it("keeps the prose as context and does not repeat the fact lines in it", () => {
		const prose = chunkTopic("topics/testing.md", topic).filter((chunk) => chunk.kind === "topic");
		expect(prose.map((chunk) => chunk.body).join("\n")).toContain("How this project tests.");
		expect(prose.map((chunk) => chunk.body).join("\n")).not.toContain("never watch mode");
	});

	it("is what chunkFile picks for a topic path", () => {
		expect(chunkFile("topics/testing.md", topic).some((chunk) => chunk.kind === "fact")).toBe(true);
	});
});

describe("chunkRules", () => {
	const rules = [
		"# Rules",
		"",
		"- R-014 · phase: test · scope: project · source: user · since: 2026-08-22",
		"  Run `pnpm test --run`; never start watch mode in a non-interactive session.",
		"",
		"- R-015 · phase: ops · source: agent · since: 2026-08-01",
		"  Deploys go through the staging environment first.",
		"",
		"## Retired",
		"",
		"- R-002 · phase: test · source: agent · since: 2026-06-01",
		"  Run the whole suite before every commit.",
		"",
	].join("\n");

	it("makes one chunk per rule, addressed by rule id", () => {
		const chunks = chunkRules("rules.md", rules);
		expect(chunks.map((chunk) => chunk.id)).toEqual(["R-014", "R-015", "R-002"]);
		expect(chunks[0]?.body).toBe("Run `pnpm test --run`; never start watch mode in a non-interactive session.");
		expect(chunks[0]?.phase).toBe("test");
		expect(chunks[0]?.source).toBe("user");
		expect(chunks[0]?.date).toBe("2026-08-22");
	});

	it("treats a retired rule as superseded, so active-only queries drop it", () => {
		const chunks = chunkRules("rules.md", rules);
		expect(chunks[2]?.superseded).toBe(true);
		expect(chunks[0]?.superseded).toBeUndefined();
	});
});

describe("chunkMarkdown — what is not indexed", () => {
	it("skips HTML comments, so a query cannot match Muninn's own boilerplate", () => {
		const text = "<!-- Written by muninn dreams. Hand edits survive. -->\n\n# Memory\n\nThe fact itself.\n";
		const chunks = chunkMarkdown("MEMORY.md", text, "memory");
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.body).toBe("The fact itself.");
	});

	it("keeps a comment that is part of a code sample", () => {
		const text = "# Doc\n\n```html\n<!-- this one is content -->\n```\n";
		expect(chunkMarkdown("doc.md", text, "topic")[0]?.body).toContain("this one is content");
	});
});
