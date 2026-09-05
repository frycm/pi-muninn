/**
 * Registers the scripted endpoint as a pi provider, so an integration test can
 * run a real session without credentials. Loaded alongside pi-muninn with a
 * second `-e` flag; `MUNINN_TEST_PROVIDER_URL` says where the server is.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	const baseUrl = process.env.MUNINN_TEST_PROVIDER_URL;
	if (!baseUrl) return;

	pi.registerProvider("muninn-test", {
		name: "Muninn test provider",
		baseUrl,
		apiKey: "test-key",
		api: "openai-completions",
		models: ["mock", "memory"].map((id) => ({
			id,
			name: `Mock ${id} model`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4_096,
		})),
	});
}
