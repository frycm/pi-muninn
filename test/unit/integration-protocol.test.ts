import { describe, expect, it } from "vitest";
import {
	collectIntegrationEntries,
	INTEGRATION_INPUT_MAX_BYTES,
	INTEGRATION_INPUT_MAX_OBSERVATIONS,
	MUNINN_INTEGRATION_ENTRY_TYPE,
	muninnIntegrationEntry,
	parseIntegrationInput,
	parseIntegrationObservation,
} from "../../src/integrations/protocol.ts";

function observation(id = "remote-1") {
	return {
		schema: 1,
		type: "checkpoint",
		channel: "rpc",
		status: "completed",
		body: "Remote session completed.",
		cue: "when reviewing the remote run",
		tags: ["remote"],
		paths: ["src/remote.ts"],
		integration: {
			provider: "pi-huginn",
			kind: "remote-session",
			event: "completed",
			external_id: id,
			observed_at: "2026-09-04T12:00:00.000Z",
			metadata: { revision: 7 },
		},
	};
}

describe("integration producer protocol", () => {
	it("normalizes defaults and rejects producer attempts to add journal authority fields", () => {
		expect(
			parseIntegrationObservation({
				...observation(),
				type: undefined,
				channel: undefined,
				tags: undefined,
				paths: undefined,
			}),
		).toMatchObject({ type: "note", channel: "hook", tags: [], paths: [] });
		expect(() => parseIntegrationObservation({ ...observation(), source: "user" })).toThrow(/unsupported field source/);
		expect(() => parseIntegrationObservation({ ...observation(), relations: [] })).toThrow(
			/unsupported field relations/,
		);
	});

	it("parses one object, an array, or JSONL only after validating the whole batch", () => {
		expect(parseIntegrationInput(JSON.stringify(observation()))).toHaveLength(1);
		expect(parseIntegrationInput(JSON.stringify([observation("1"), observation("2")]))).toHaveLength(2);
		expect(
			parseIntegrationInput(`${JSON.stringify(observation("1"))}\n${JSON.stringify(observation("2"))}\n`),
		).toHaveLength(2);
		expect(() =>
			parseIntegrationInput(`${JSON.stringify(observation("valid"))}\n${JSON.stringify({ bad: true })}`),
		).toThrow(/invalid integration input/);
		expect(() => parseIntegrationInput("x".repeat(INTEGRATION_INPUT_MAX_BYTES + 1))).toThrow(/exceeds/);
		expect(() =>
			parseIntegrationInput(
				JSON.stringify(
					Array.from({ length: INTEGRATION_INPUT_MAX_OBSERVATIONS + 1 }, (_, index) => observation(`${index}`)),
				),
			),
		).toThrow(/1 to 100/);
	});

	it("redacts a public custom entry and folds valid entries independently of load order", () => {
		const entry = muninnIntegrationEntry({
			...observation(),
			body: "Remote token sk-abcdefghijklmnopqrstuvwxyz123456 was refused.",
		});
		expect(entry.customType).toBe(MUNINN_INTEGRATION_ENTRY_TYPE);
		expect(entry.data.body).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
		const collected = collectIntegrationEntries([
			{ type: "custom", customType: "other", data: observation("ignored") },
			{ id: "valid", type: "custom", ...entry },
			{ id: "invalid", type: "custom", customType: MUNINN_INTEGRATION_ENTRY_TYPE, data: { schema: 9 } },
			{ id: "valid", type: "custom", ...entry },
		]);
		expect(collected.observations).toHaveLength(1);
		expect(collected.observations[0]?.key).toBe("valid");
		expect(collected.problems).toHaveLength(1);
	});
});
