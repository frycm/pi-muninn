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

export interface MockProvider {
	url: string;
	port: number;
	/** Prompts pi has sent, in order. */
	requests: Array<{ messages: Array<{ role: string; content: unknown }> }>;
	close(): Promise<void>;
}

/** Serve `replies` in order; the last is repeated if pi asks again. */
export async function startMockProvider(replies: string[], fixedPort = 0): Promise<MockProvider> {
	const requests: MockProvider["requests"] = [];
	let call = 0;

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
			try {
				requests.push(JSON.parse(body));
			} catch {
				requests.push({ messages: [] });
			}

			const reply = replies[Math.min(call, replies.length - 1)] ?? "";
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
			res.write(chunk({ content: reply }));
			res.write(chunk({}, "stop"));
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-mock",
					object: "chat.completion.chunk",
					created: 0,
					model: "mock",
					choices: [],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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
