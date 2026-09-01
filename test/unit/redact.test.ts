import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { containsSecret, redact, shannonEntropy } from "../../src/redact.ts";

/**
 * Cases are blank-line-separated blocks, not lines, so that a multi-line secret
 * (a PEM key) is a single case — testing its BEGIN marker in isolation would
 * ask the scanner a question it is not meant to answer.
 *
 * The `{X}` marker inside each fixture secret is removed here. It keeps a
 * credential-shaped string out of git — secret-scanning push protection rejects
 * those however synthetic they are — while the scanner under test still sees the
 * exact shape it has to catch.
 */
function loadCorpus(name: string): string[] {
	const path = fileURLToPath(new URL(`../fixtures/secrets/${name}.txt`, import.meta.url));
	const body = readFileSync(path, "utf-8")
		.split("\n")
		.filter((line) => !line.startsWith("#"))
		.join("\n");
	return body
		.split(/\n\s*\n/)
		.map((block) => block.replaceAll("{X}", "").trim())
		.filter((block) => block !== "");
}

const POSITIVES = loadCorpus("positives");
const NEGATIVES = loadCorpus("negatives");

describe("the corpus", () => {
	it("has no false negatives: every secret is caught", () => {
		// A miss here is a credential written into an append-only journal that
		// syncs to a remote — leaked into history on every machine that pulls.
		// The gate is zero, not "few".
		const missed = POSITIVES.filter((line) => !containsSecret(line));
		expect(missed).toEqual([]);
	});

	it("has a false-positive rate under 1%", () => {
		const flagged = NEGATIVES.filter((line) => containsSecret(line));
		const rate = flagged.length / NEGATIVES.length;
		// Reported as the offending lines, not just a number, so a regression
		// names what broke.
		expect(flagged).toEqual([]);
		expect(rate).toBeLessThan(0.01);
	});

	it("is large enough for those rates to mean something", () => {
		// With a corpus this size the 1% gate is arithmetically a demand for
		// zero: one false positive out of ~36 is 2.8%. That is the intent — the
		// number is stated as a rate so the corpus can grow without the gate
		// silently loosening.
		expect(POSITIVES.length).toBeGreaterThanOrEqual(30);
		expect(NEGATIVES.length).toBeGreaterThanOrEqual(30);
	});

	it("covers the shapes the plan named", () => {
		const corpus = POSITIVES.join("\n");
		for (const marker of ["AKIA", "ghp_", "xox", "sk-ant-", "sk-proj-", "eyJ", "BEGIN", "password", "api_key"]) {
			expect(corpus).toContain(marker);
		}
	});

	it("covers the negatives the plan named", () => {
		const corpus = NEGATIVES.join("\n");
		expect(corpus).toMatch(/[0-9a-f]{40}/); // git SHA
		expect(corpus).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-7/); // uuidv7
		expect(corpus).toContain("const "); // code
	});
});

describe("redact", () => {
	it("replaces the secret and names what it was", () => {
		const result = redact("the key is AKIAIOSFODNN7EXAMPLE ok?");
		expect(result.text).toBe("the key is [redacted: aws-access-key] ok?");
		expect(result.hits).toHaveLength(1);
		expect(result.hits[0]?.kind).toBe("aws-access-key");
	});

	it("keeps the key name so a reader knows what was scrubbed", () => {
		// Losing the whole line would leave a journal entry that cannot be
		// understood at all; losing only the value keeps the memory useful.
		const result = redact("api_key: deadbeefcafebabe0123456789abcdef");
		expect(result.text).toContain("api_key:");
		expect(result.text).not.toContain("deadbeef");
	});

	it("reports positions in the original text, not the redacted one", () => {
		const text = "prefix AKIAIOSFODNN7EXAMPLE suffix";
		const hit = redact(text).hits[0];
		expect(text.slice(hit?.index, (hit?.index ?? 0) + (hit?.length ?? 0))).toBe("AKIAIOSFODNN7EXAMPLE");
	});

	it("redacts a whole PEM block including its body", () => {
		const pem = [
			"before",
			"-----BEGIN RSA PRIVATE KEY-----",
			"MIIEowIBAAKCAQEAx7Zq9K3mNpQrStUvWxYz0123456789AbCdEfGh",
			"-----END RSA PRIVATE KEY-----",
			"after",
		].join("\n");
		const result = redact(pem);
		expect(result.text).toBe("before\n[redacted: private-key]\nafter");
		expect(result.text).not.toContain("MIIEow");
	});

	it("handles several secrets in one string", () => {
		const result = redact("first AKIAIOSFODNN7EXAMPLE then ghp_1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ12 done");
		expect(result.hits).toHaveLength(2);
		expect(result.text).not.toContain("AKIA");
		expect(result.text).not.toContain("ghp_");
	});

	it("counts a secret matched by two rules once", () => {
		// A JWT after `bearer ` matches both the keyed-secret rule and the JWT
		// rule. Overlapping spans merge, so it is one hit and one placeholder.
		const result = redact("bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop");
		expect(result.hits).toHaveLength(1);
		expect(result.text.match(/\[redacted/g)).toHaveLength(1);
	});

	it("leaves text with nothing to find exactly as it was", () => {
		const text = "Run `pnpm test --run`; vitest watch mode hangs the CI job.";
		expect(redact(text)).toEqual({ text, hits: [] });
	});

	it("handles the empty string", () => {
		expect(redact("")).toEqual({ text: "", hits: [] });
	});
});

describe("identifiers Muninn depends on are never redacted", () => {
	it("leaves entry, claim and task ids alone", () => {
		for (const id of [
			"j-0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01",
			"j-0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01.3",
			"0198f2b0-1111-7000-8000-000000000001",
		]) {
			expect(redact(`see ${id} for details`).hits).toEqual([]);
		}
	});

	it("leaves git SHAs and content hashes alone", () => {
		// This is why hex is not scored by entropy: a 40-char SHA sits at ~3.9
		// bits/char, indistinguishable from a hex secret by entropy alone.
		for (const hex of [
			"914cf1472e715297caa30db4b9535d534a9eb718",
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			"d41d8cd98f00b204e9800998ecf8427e",
		]) {
			expect(redact(`commit ${hex}`).hits).toEqual([]);
		}
	});

	it("still catches a hex secret when it is named", () => {
		// Context is what makes hex actionable, so the same string that is safe
		// bare is redacted once something calls it a token.
		const hex = "d41d8cd98f00b204e9800998ecf8427e";
		expect(redact(hex).hits).toEqual([]);
		expect(containsSecret(`api_key=${hex}`)).toBe(true);
	});
});

describe("shannonEntropy", () => {
	it("is zero for a single repeated character", () => {
		expect(shannonEntropy("aaaaaaaa")).toBe(0);
	});

	it("is 1 bit for an even two-symbol split", () => {
		expect(shannonEntropy("abab")).toBeCloseTo(1, 10);
	});

	it("caps hex at 4 bits per character, which is why the plan's threshold could not fire", () => {
		const hex = "0123456789abcdef".repeat(4);
		expect(shannonEntropy(hex)).toBeCloseTo(4, 10);
		expect(shannonEntropy(hex)).toBeLessThanOrEqual(4);
	});

	it("is zero for the empty string", () => {
		expect(shannonEntropy("")).toBe(0);
	});
});

describe("redaction keeps the surrounding prose readable", () => {
	it("does not swallow the full stop that ends a sentence", () => {
		const result = redact("the registry needed api_key: deadbeefcafebabe0123456789abcdef.");
		expect(result.text).toBe("the registry needed api_key: [redacted: keyed-secret].");
	});

	it("still redacts a dotted secret in full", () => {
		const result = redact("token=abc.def.ghi.jkl.mno");
		expect(result.text).toBe("token=[redacted: keyed-secret]");
	});
});
