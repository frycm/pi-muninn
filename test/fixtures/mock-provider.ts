/**
 * A scripted OpenAI-compatible endpoint, for driving real pi sessions in tests.
 *
 * pi does not re-export the stream constructor an extension would need to
 * script a model in-process, so the fake model is an actual HTTP server and pi
 * reaches it through its ordinary `openai-completions` provider. Nothing here
 * touches pi's internals, which is what keeps this harness from breaking on a
 * pi upgrade.
 */
import { createServer, type Server } from "node:http";

export interface MockRequest {
	messages: Array<{ role: string; content: unknown }>;
	/** True when this is Muninn asking for an outcome entry rather than pi running the task. */
	isOutcomeCall: boolean;
	/** True when this is a dream's consolidate job. */
	isConsolidateCall: boolean;
	/** True when this is a merge dream. */
	isMergeCall: boolean;
	raw: string;
}

/** What the scripted model does next: say something, or call a tool. */
export type MockReply = string | { toolCall: { name: string; arguments: Record<string, unknown> } };

export type MockScript = (request: MockRequest, callIndex: number) => MockReply;

export interface MockProvider {
	url: string;
	port: number;
	/** Prompts pi has sent, in order. */
	requests: MockRequest[];
	close(): Promise<void>;
}

/**
 * Markers that tell Muninn's own model calls apart from pi's turns.
 *
 * A scripted provider sees every request pi makes, and Muninn makes three kinds
 * of its own. Matching on a sentence of the system prompt is the one signal
 * that travels with the request, so each prompt carries a marker constant and
 * the script keys on it.
 */
const OUTCOME_MARKER = "journal entry recording the outcome";
const CONSOLIDATE_MARKER = "You are consolidating one topic of a memory store";
const MERGE_MARKER = "You are merging two versions of one topic";

export interface MockOptions {
	/** Fixed port, for driving pi from a shell. Default: an ephemeral one. */
	port?: number;
	/**
	 * Prompt tokens to report.
	 *
	 * pi decides when to compact from the usage a provider reports, so a test
	 * that wants compaction has to claim a nearly full context — a mock that
	 * always reports a handful of tokens can never trigger it.
	 */
	promptTokens?: number;
}

/**
 * Serve `script` — either replies in order (the last repeating), or a function
 * that decides from the request.
 */
export async function startMockProvider(
	script: string[] | MockScript,
	options: MockOptions = {},
): Promise<MockProvider> {
	const fixedPort = options.port ?? 0;
	const promptTokens = options.promptTokens ?? 10;
	const requests: MockRequest[] = [];
	let call = 0;
	const decide: MockScript =
		typeof script === "function" ? script : (_request, index) => script[Math.min(index, script.length - 1)] ?? "";

	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			if (!req.url?.includes("/chat/completions")) {
				res.writeHead(404).end();
				return;
			}
			let parsed: MockRequest;
			try {
				const json = JSON.parse(body) as { messages?: MockRequest["messages"] };
				parsed = {
					messages: json.messages ?? [],
					isOutcomeCall: body.includes(OUTCOME_MARKER),
					isConsolidateCall: body.includes(CONSOLIDATE_MARKER),
					isMergeCall: body.includes(MERGE_MARKER),
					raw: body,
				};
			} catch {
				parsed = { messages: [], isOutcomeCall: false, isConsolidateCall: false, isMergeCall: false, raw: body };
			}
			requests.push(parsed);

			const reply = decide(parsed, call);
			call++;

			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
				`data: ${JSON.stringify({
					id: "chatcmpl-mock",
					object: "chat.completion.chunk",
					created: 0,
					model: "mock",
					choices: [{ index: 0, delta, finish_reason: finish }],
				})}\n\n`;

			res.write(chunk({ role: "assistant", content: "" }));
			if (typeof reply === "string") {
				res.write(chunk({ content: reply }));
				res.write(chunk({}, "stop"));
			} else {
				res.write(
					chunk({
						tool_calls: [
							{
								index: 0,
								id: `call_${call}`,
								type: "function",
								function: { name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.arguments) },
							},
						],
					}),
				);
				res.write(chunk({}, "tool_calls"));
			}
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-mock",
					object: "chat.completion.chunk",
					created: 0,
					model: "mock",
					choices: [],
					usage: { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 },
				})}\n\n`,
			);
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});

	await new Promise<void>((resolve) => server.listen(fixedPort, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;

	return {
		url: `http://127.0.0.1:${port}/v1`,
		port,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}
