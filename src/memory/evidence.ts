/** Read only visible messages on the selected pi branch; split work before any evidence is dropped. */
import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { messageText } from "../capture/accumulate.ts";
import { isRememberRequest } from "../capture/cues.ts";
import { redact } from "../redact.ts";
import type { Evidence } from "./extract.ts";

export interface BranchEntry {
	id: string;
	type: string;
	message?: unknown;
	customType?: string;
	data?: unknown;
}

export function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function branchEvidence(entries: readonly BranchEntry[], cwd: string): Evidence[] {
	const result: Evidence[] = [];
	let journalOnly = false;
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		const msg = entry.message as {
			role?: string;
			content?: unknown;
			toolName?: string;
			command?: string;
			output?: string;
		};
		if (!["user", "assistant", "toolResult", "bashExecution"].includes(msg.role ?? "")) continue;
		if (msg.toolName?.startsWith("journal_")) {
			journalOnly = true;
			continue;
		}
		const tools: string[] = [];
		const paths: string[] = [];
		let hasJournalTool = false;
		if (Array.isArray(msg.content))
			for (const block of msg.content) {
				if (!block || typeof block !== "object" || block.type !== "toolCall" || typeof block.name !== "string")
					continue;
				if (block.name.startsWith("journal_")) {
					hasJournalTool = true;
					continue;
				}
				const args = block.arguments && typeof block.arguments === "object" ? block.arguments : {};
				tools.push(`${block.name}(${redact(JSON.stringify(args)).text.slice(0, 2000)})`);
				if (["read", "write", "edit"].includes(block.name) && typeof args.path === "string") {
					const path = isAbsolute(args.path) ? relative(cwd, args.path) : args.path;
					if (path && !path.startsWith("..") && !isAbsolute(path)) paths.push(path.split("\\").join("/"));
				}
			}
		const text = redact(messageText(msg)).text;
		if (msg.role === "user") {
			journalOnly = false;
			if (isRememberRequest(text) || /^\s*\/muninn\b/.test(text)) continue;
		}
		if (tools.length || (msg.role === "toolResult" && !msg.toolName?.startsWith("journal_"))) journalOnly = false;
		if (hasJournalTool && !tools.length) {
			journalOnly = true;
			continue;
		}
		if (journalOnly && msg.role === "assistant" && !tools.length) continue;
		if (text.trim() || tools.length)
			result.push({
				id: entry.id,
				role: msg.role ?? "unknown",
				text,
				tools: tools.map((tool) => redact(tool).text),
				paths,
			});
	}
	return result;
}

/** Head, error lines and tail preserve commands and exit status in oversized tool results. */
function shorten(text: string, max: number): string {
	if (text.length <= max) return text;
	const side = Math.floor(max / 3);
	const errors = text
		.split("\n")
		.filter((line) => /error|fail|exception|timeout|exit code/i.test(line))
		.join("\n")
		.slice(0, side);
	return `${text.slice(0, side)}\n… omitted; inspect source transcript …\n${errors}\n${text.slice(-side)}`.slice(
		0,
		max,
	);
}

export function evidenceChunks(evidence: Evidence[], maxChars: number): Evidence[][] {
	const chunks: Evidence[][] = [];
	let current: Evidence[] = [];
	for (const item of evidence) {
		const maxText = Math.max(128, Math.floor(maxChars / 2));
		const next = {
			...item,
			text: shorten(item.text, maxText),
			tools: item.tools.map((s) => shorten(s, 1200)).slice(0, 10),
		};
		if (JSON.stringify([next]).length > maxChars) next.tools = next.tools.slice(0, 1);
		if (JSON.stringify([next]).length > maxChars)
			throw new Error("muninn: source message metadata exceeds memory budget");
		if (JSON.stringify([...current, next]).length > maxChars) {
			chunks.push(current);
			current = [];
		}
		current.push(next);
	}
	if (current.length) chunks.push(current);
	return chunks;
}
