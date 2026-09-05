/** Explicit, credentialed quality evaluation on authored synthetic data. Never runs in CI by default. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { newHostId, newMemberId, newProjectId } from "../dist/ids.js";
import { appendJournalRecord } from "../dist/journal/jsonl.js";
import { JournalQueryService } from "../dist/journal/query.js";
import { extractMemories } from "../dist/memory/extract.js";
import { MemoryOperation } from "../dist/memory/runtime.js";
import { recallMemories } from "../dist/recall/recall.js";
import { DEFAULT_SETTINGS } from "../dist/settings.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--model" || !args[1]?.includes("/")) {
	process.stdout.write(
		"Usage: npm run eval:memory -- --model PROVIDER/MODEL\nSends synthetic fixtures to your explicitly selected pi model. Uses its configured credentials. Outputs JSONL for human fact review.\n",
	);
	process.exitCode = args.includes("--help") ? 0 : 2;
} else {
	const split = args[1].indexOf("/");
	const provider = args[1].slice(0, split);
	const id = args[1].slice(split + 1);
	const agentDir = getAgentDir();
	const registry = new ModelRegistry(
		await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		}),
	);
	const model = registry.find(provider, id);
	if (!model) throw new Error("Selected evaluation model is unavailable in pi's registry.");
	const settings = { ...DEFAULT_SETTINGS.memory, model: { provider, id } };
	const cases = JSON.parse(await readFile(new URL("../test/fixtures/memory/corpus.json", import.meta.url), "utf8"));
	const scratch = await mkdtemp(join(tmpdir(), "muninn-quality-"));
	try {
		const write = { storePath: scratch, project: newProjectId(), member: newMemberId(), host: newHostId() };
		const canonical = new Map();
		for (const item of cases) {
			const { correction: _correction, recall: _recall, negative: _negative, id: _id, ...facts } = item;
			const record = await appendJournalRecord(
				{ type: "outcome", source: "agent", channel: "sdk", body: JSON.stringify(facts), cue: item.symptom },
				write,
			);
			canonical.set(item.id, record.id);
			if (item.correction)
				await appendJournalRecord(
					{
						type: "correction",
						source: "user",
						channel: "cli",
						body: item.correction,
						relations: [{ type: "corrects", target: record.id }],
					},
					write,
				);
		}
		const service = new JournalQueryService({ storePath: scratch, localMember: write.member, maxChars: 64_000 });
		for (const item of cases) {
			const { correction: _correction, recall: _recall, negative: _negative, id: _id, ...facts } = item;
			const extraction = new MemoryOperation({ model, modelRegistry: registry }, settings);
			try {
				const evidence = Object.entries(facts)
					.filter(([, text]) => text !== null)
					.map(([key, text]) => ({ id: key, role: "toolResult", text, tools: [], paths: [] }));
				const memories = await extractMemories(extraction, { focus: "", evidence, prior: [] });
				process.stdout.write(
					`${JSON.stringify({ case: item.id, stage: "extraction", expected: facts, memories, usage: extraction.usage, review: "Human review required: fact retention, unsupported claims, unknowns and verification." })}\n`,
				);
			} catch {
				process.stdout.write(`${JSON.stringify({ case: item.id, stage: "extraction", error: "extraction failed" })}\n`);
			} finally {
				extraction.close();
			}
			for (const [kind, query] of [
				["positive", item.recall],
				["negative", item.negative],
			]) {
				const operation = new MemoryOperation({ model, modelRegistry: registry }, settings);
				try {
					const result = await recallMemories(service, operation, DEFAULT_SETTINGS.recall, { query });
					// Negative tasks target another scenario: this case's memory should not be selected.
					const selected = result.selected.flatMap((entry) => entry.records.map((record) => record.id));
					const hit = selected.includes(canonical.get(item.id));
					process.stdout.write(
						`${JSON.stringify({ case: item.id, stage: kind, query, expected: canonical.get(item.id), pass: result.status !== "unavailable" && (kind === "positive" ? hit : !hit), result, usage: operation.usage })}\n`,
					);
				} finally {
					operation.close();
				}
			}
		}
		const abstention = new MemoryOperation({ model, modelRegistry: registry }, settings);
		try {
			const query = "Design CSS hover styles for a profile avatar.";
			const result = await recallMemories(service, abstention, DEFAULT_SETTINGS.recall, { query });
			process.stdout.write(
				`${JSON.stringify({ stage: "abstention", query, pass: result.status === "no-match" && result.selected.length === 0, result, usage: abstention.usage })}\n`,
			);
		} finally {
			abstention.close();
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
