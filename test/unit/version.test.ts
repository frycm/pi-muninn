import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MUNINN_VERSION } from "../../src/version.ts";

describe("MUNINN_VERSION", () => {
	it("matches package.json", () => {
		// version.ts is a literal so the extension needs no JSON import attribute
		// on either runtime; this is the check that keeps the two in step.
		const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
		expect(MUNINN_VERSION).toBe(pkg.version);
	});
});
