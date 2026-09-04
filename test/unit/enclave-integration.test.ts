import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ENCLAVE_AUDIT_GENESIS,
	enclaveAuditObservation,
	summarizeEnclaveAudit,
} from "../../src/integrations/enclave.ts";

const roots: string[] = [];

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "muninn-enclave-"));
	roots.push(path);
	return path;
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function chained(records: Array<Record<string, unknown>>, sessionId = "session-7"): string[] {
	let previous = ENCLAVE_AUDIT_GENESIS;
	return records.map((fields, index) => {
		const line = JSON.stringify({
			...fields,
			seq: index + 1,
			ts: `2026-09-04T12:00:0${index}.000Z`,
			sessionId,
			prevHash: previous,
		});
		previous = `sha256:${createHash("sha256").update(line).digest("hex")}`;
		return line;
	});
}

function audit(lines: string[], terminated = true): string {
	const path = join(root(), "audit.jsonl");
	writeFileSync(path, `${lines.join("\n")}${terminated ? "\n" : ""}`, { mode: 0o600 });
	return path;
}

describe("pi-enclave audit integration", () => {
	it("verifies a chain and emits one aggregate observation without sensitive fields", () => {
		const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
		const path = audit(
			chained([
				{ kind: "session_start", backend: "srt" },
				{ kind: "decision", outcome: "allow", commands: [`curl -H Authorization:${secret}`] },
				{ kind: "decision", outcome: "deny", path: `/secret/${secret}` },
				{ kind: "violation", detail: secret },
				{ kind: "breaker", event: "opened", reason: secret },
			]),
		);
		const summary = summarizeEnclaveAudit(path);
		expect(summary).toMatchObject({
			session_id: "session-7",
			records: 5,
			last_seq: 5,
			kinds: { session_start: 1, decision: 2, violation: 1, breaker: 1 },
			outcomes: { allow: 1, deny: 1 },
			breaker_opened: true,
		});
		const observation = enclaveAuditObservation(path);
		expect(observation).toMatchObject({
			type: "checkpoint",
			status: "partial",
			integration: {
				provider: "pi-enclave",
				kind: "sandbox-audit",
				event: "audit-checkpoint",
				metadata: { records: 5, allowed: 1, denied: 1, violations: 1, chain: "verified" },
			},
		});
		expect(JSON.stringify(observation)).not.toContain(secret);
		expect(JSON.stringify(observation)).not.toContain("Authorization");
		expect(JSON.stringify(observation)).not.toContain("/secret/");
	});

	it("refuses edits, deletion, reordering, mixed sessions, and a torn tail", () => {
		const valid = chained([
			{ kind: "session_start" },
			{ kind: "decision", outcome: "allow" },
			{ kind: "decision", outcome: "deny" },
		]);
		expect(() =>
			summarizeEnclaveAudit(
				audit([valid[0] as string, (valid[1] as string).replace("allow", "deny"), valid[2] as string]),
			),
		).toThrow(/prevHash/);
		expect(() => summarizeEnclaveAudit(audit([valid[0] as string, valid[2] as string]))).toThrow(/expected seq/);
		expect(() => summarizeEnclaveAudit(audit([valid[1] as string, valid[0] as string, valid[2] as string]))).toThrow(
			/expected seq|prevHash/,
		);
		const mixed = [...valid];
		mixed[2] = (mixed[2] as string).replace("session-7", "session-8");
		expect(() => summarizeEnclaveAudit(audit(mixed))).toThrow(/sessionId|prevHash/);
		expect(() => summarizeEnclaveAudit(audit(valid, false))).toThrow(/unterminated/);
	});
});
