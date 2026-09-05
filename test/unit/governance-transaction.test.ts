import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSigningIdentity } from "../../src/governance/identity.ts";
import {
	prepareSigningTransaction,
	readSigningTransaction,
	type SigningTransaction,
	signingTransactionPath,
} from "../../src/governance/transaction.ts";
import { newKeyEventId, newMemberId, newProjectId } from "../../src/ids.ts";

let root: string;
let agentDir: string;
let path: string;
let pending: Extract<SigningTransaction, { kind: "rotation" }>;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "muninn-signing-transaction-"));
	agentDir = join(root, "agent");
	path = signingTransactionPath(agentDir);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const member = newMemberId();
	pending = {
		schema: 1,
		kind: "rotation",
		project: newProjectId(),
		storePath: realpathSync(root),
		previous: generateSigningIdentity(member, new Date("2026-09-04T10:00:00.000Z")),
		successor: generateSigningIdentity(member, new Date("2026-09-04T11:00:00.000Z")),
		eventId: newKeyEventId(),
	};
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function scope() {
	return { ...pending, member: pending.successor.member };
}

describe("private signing transaction validation", () => {
	it.each([
		["malformed JSON", () => "{broken"],
		["unknown schema", () => JSON.stringify({ ...pending, schema: 2 })],
		["unsupported field", () => JSON.stringify({ ...pending, extra: true })],
		["missing predecessor", () => JSON.stringify({ ...pending, previous: undefined })],
		["invalid event ID", () => JSON.stringify({ ...pending, eventId: "invalid" })],
		["duplicate keys", () => JSON.stringify({ ...pending, successor: pending.previous })],
		[
			"reversed timestamps",
			() => JSON.stringify({ ...pending, previous: pending.successor, successor: pending.previous }),
		],
		["foreign successor", () => JSON.stringify({ ...pending, successor: generateSigningIdentity(newMemberId()) })],
		[
			"damaged private key",
			() =>
				JSON.stringify({ ...pending, successor: { ...pending.successor, private_key: pending.previous.private_key } }),
		],
		["invalid project", () => JSON.stringify({ ...pending, project: 42 })],
		["relative store", () => JSON.stringify({ ...pending, storePath: "relative/store" })],
		["rotation fields in recovery", () => JSON.stringify({ ...pending, kind: "recovery" })],
	] satisfies Array<[string, () => string]>)("preserves %s without revealing private material", (_label, bytes) => {
		const original = bytes();
		writeFileSync(path, original, { mode: 0o600 });
		let failure: unknown;
		try {
			readSigningTransaction(agentDir, scope());
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure)).toContain("invalid; preserve it for recovery");
		expect(String(failure)).not.toContain(pending.previous.private_key);
		expect(String(failure)).not.toContain(pending.successor.private_key);
		expect(readFileSync(path, "utf-8")).toBe(original);
	});

	it("refuses a different operation, project, store or member without replacing pending material", () => {
		prepareSigningTransaction(agentDir, pending);
		const original = readFileSync(path, "utf-8");
		for (const changed of [
			{ ...scope(), kind: "recovery" as const },
			{ ...scope(), project: newProjectId() },
			{ ...scope(), storePath: agentDir },
			{ ...scope(), member: newMemberId() },
		])
			expect(() => readSigningTransaction(agentDir, changed)).toThrow(/original project/);
		expect(() => prepareSigningTransaction(agentDir, pending)).toThrow(/already pending/);
		expect(readFileSync(path, "utf-8")).toBe(original);
		expect(readSigningTransaction(agentDir, scope())).toEqual(pending);
	});

	it("rejects group-readable pending files and symlinks", () => {
		prepareSigningTransaction(agentDir, pending);
		chmodSync(path, 0o640);
		expect(() => readSigningTransaction(agentDir, scope())).toThrow(/group or other access/);
		rmSync(path);
		const target = join(root, "private.json");
		writeFileSync(target, JSON.stringify(pending), { mode: 0o600 });
		symlinkSync(target, path);
		expect(() => readSigningTransaction(agentDir, scope())).toThrow(/regular file/);
		expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual(pending);
	});
});
