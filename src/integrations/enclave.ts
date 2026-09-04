/** Explicit verifier and aggregate adapter for pi-enclave's hash-chained audit log. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { IntegrationObservation } from "./protocol.ts";

export const ENCLAVE_AUDIT_MAX_BYTES = 32 * 1024 * 1024;
export const ENCLAVE_AUDIT_MAX_RECORDS = 50_000;
export const ENCLAVE_AUDIT_MAX_LINE_BYTES = 256 * 1024;
export const ENCLAVE_AUDIT_GENESIS = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

const RFC3339_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KINDS = ["session_start", "config", "decision", "violation", "breaker", "attendance", "pending", "refusal"];
const OUTCOMES = ["allow", "deny", "ask-denied", "ask-approved", "skip-review", "breaker-open", "error"];

export class EnclaveAuditError extends Error {
	constructor(message: string) {
		super(`muninn: invalid pi-enclave audit: ${message}`);
		this.name = "EnclaveAuditError";
	}
}

export interface EnclaveAuditSummary {
	session_id: string;
	records: number;
	last_seq: number;
	tail_hash: string;
	observed_at: string;
	kinds: Record<string, number>;
	outcomes: Record<string, number>;
	breaker_opened: boolean;
}

function hashLine(line: string): string {
	return `sha256:${createHash("sha256").update(line).digest("hex")}`;
}

function object(value: unknown, line: number): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new EnclaveAuditError(`line ${line} must be a JSON object`);
	}
	return value as Record<string, unknown>;
}

function increment(counts: Record<string, number>, key: string): void {
	counts[key] = (counts[key] ?? 0) + 1;
}

/** Verify a complete enclave audit file and return only non-sensitive aggregate evidence. */
export function summarizeEnclaveAudit(path: string): EnclaveAuditSummary {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch (error) {
		throw new EnclaveAuditError(`cannot inspect ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (stat.isSymbolicLink() || !stat.isFile())
		throw new EnclaveAuditError("input must be a regular, non-symbolic-link file");
	if (stat.size > ENCLAVE_AUDIT_MAX_BYTES)
		throw new EnclaveAuditError(`input exceeds ${ENCLAVE_AUDIT_MAX_BYTES} bytes`);
	const text = readFileSync(path, "utf-8");
	if (text !== "" && !text.endsWith("\n")) throw new EnclaveAuditError("final audit line is unterminated");
	const lines = text.split("\n");
	lines.pop();
	if (lines.length === 0) throw new EnclaveAuditError("audit is empty");
	if (lines.length > ENCLAVE_AUDIT_MAX_RECORDS) {
		throw new EnclaveAuditError(`audit exceeds ${ENCLAVE_AUDIT_MAX_RECORDS} records`);
	}

	let expectedPrev = ENCLAVE_AUDIT_GENESIS;
	let sessionId: string | undefined;
	let observedAt = "";
	let tailHash = expectedPrev;
	const kinds: Record<string, number> = {};
	const outcomes: Record<string, number> = {};
	let breakerOpened = false;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] as string;
		const lineNumber = index + 1;
		if (line === "") throw new EnclaveAuditError(`line ${lineNumber} is empty`);
		if (Buffer.byteLength(line, "utf-8") > ENCLAVE_AUDIT_MAX_LINE_BYTES) {
			throw new EnclaveAuditError(`line ${lineNumber} exceeds ${ENCLAVE_AUDIT_MAX_LINE_BYTES} bytes`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch {
			throw new EnclaveAuditError(`line ${lineNumber} is not valid JSON`);
		}
		const record = object(parsed, lineNumber);
		if (record.seq !== lineNumber) {
			throw new EnclaveAuditError(`line ${lineNumber} expected seq ${lineNumber}, found ${String(record.seq)}`);
		}
		if (record.prevHash !== expectedPrev) {
			throw new EnclaveAuditError(`line ${lineNumber} prevHash does not match the previous line`);
		}
		if (typeof record.sessionId !== "string" || record.sessionId.length < 1 || record.sessionId.length > 256) {
			throw new EnclaveAuditError(`line ${lineNumber} has an invalid sessionId`);
		}
		if (sessionId === undefined) sessionId = record.sessionId;
		else if (record.sessionId !== sessionId) throw new EnclaveAuditError(`line ${lineNumber} changes sessionId`);
		if (typeof record.ts !== "string" || !RFC3339_MILLIS.test(record.ts) || Number.isNaN(Date.parse(record.ts))) {
			throw new EnclaveAuditError(`line ${lineNumber} has an invalid timestamp`);
		}
		if (record.ts < observedAt) throw new EnclaveAuditError(`line ${lineNumber} moves timestamp backwards`);
		observedAt = record.ts;
		const kind = typeof record.kind === "string" && KINDS.includes(record.kind) ? record.kind : "other";
		increment(kinds, kind);
		if (kind === "decision") {
			const outcome =
				typeof record.outcome === "string" && OUTCOMES.includes(record.outcome) ? record.outcome : "other";
			increment(outcomes, outcome);
			if (outcome === "breaker-open") breakerOpened = true;
		}
		if (kind === "breaker" && record.event === "opened") breakerOpened = true;
		tailHash = hashLine(line);
		expectedPrev = tailHash;
	}

	return {
		session_id: sessionId as string,
		records: lines.length,
		last_seq: lines.length,
		tail_hash: tailHash,
		observed_at: observedAt,
		kinds,
		outcomes,
		breaker_opened: breakerOpened,
	};
}

function total(summary: EnclaveAuditSummary, keys: readonly string[]): number {
	return keys.reduce((sum, key) => sum + (summary.outcomes[key] ?? 0), 0);
}

/** Turn a verified audit tail into one bounded, idempotent journal checkpoint. */
export function enclaveAuditObservation(path: string): IntegrationObservation {
	const summary = summarizeEnclaveAudit(path);
	const allowed = total(summary, ["allow", "ask-approved", "skip-review"]);
	const denied = total(summary, ["deny", "ask-denied", "breaker-open", "error"]);
	const violations = summary.kinds.violation ?? 0;
	const metadata: Record<string, string | number | boolean | null> = {
		records: summary.records,
		decisions: summary.kinds.decision ?? 0,
		allowed,
		denied,
		violations,
		breaker_opened: summary.breaker_opened,
		chain: "verified",
	};
	for (const [kind, count] of Object.entries(summary.kinds).sort()) metadata[`kind_${kind}`] = count;
	for (const [outcome, count] of Object.entries(summary.outcomes).sort())
		metadata[`outcome_${outcome.replaceAll("-", "_")}`] = count;
	return {
		schema: 1,
		type: "checkpoint",
		channel: "cli",
		status: denied > 0 || violations > 0 || summary.breaker_opened ? "partial" : "completed",
		body: `Verified pi-enclave audit for session ${summary.session_id}: ${summary.records} records, ${allowed} allowed decisions, ${denied} denied decisions, ${violations} violations; breaker ${summary.breaker_opened ? "opened" : "not opened"}.`,
		cue: "when reviewing sandbox enforcement for this session",
		tags: [
			"integration:pi-enclave",
			"sandbox-audit",
			"audit-verified",
			...(summary.breaker_opened ? ["breaker-open"] : []),
		],
		paths: [],
		integration: {
			provider: "pi-enclave",
			kind: "sandbox-audit",
			event: "audit-checkpoint",
			external_id: `${summary.session_id}:${summary.last_seq}:${summary.tail_hash}`,
			observed_at: summary.observed_at,
			metadata,
		},
	};
}
