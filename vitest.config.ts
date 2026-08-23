import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// Integration tests drive real pi sessions against a scratch HOME.
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
