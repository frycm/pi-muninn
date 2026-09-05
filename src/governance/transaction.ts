/** Durable private preparation for a publication that spans Git and signing.json. */
import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { isKeyEventId, isProjectId } from "../ids.ts";
import { withStoreLock } from "../store/lock.ts";
import { signingIdentityPath } from "../store/paths.ts";
import { assertPrivateFile, type LocalSigningIdentity, parseSigningIdentity } from "./identity.ts";

interface SigningTransactionBase {
	schema: 1;
	project: string;
	storePath: string;
	successor: LocalSigningIdentity;
}

interface SigningRotation extends SigningTransactionBase {
	kind: "rotation";
	previous: LocalSigningIdentity;
	eventId: string;
}

interface SigningRecovery extends SigningTransactionBase {
	kind: "recovery";
}

export type SigningTransaction = SigningRotation | SigningRecovery;

interface SigningTransactionScope {
	kind: SigningTransaction["kind"];
	project: string;
	storePath: string;
	member: string;
}

export function signingTransactionPath(agentDir: string): string {
	return join(dirname(signingIdentityPath(agentDir)), "signing-pending.json");
}

export async function withSigningIdentityLock<T>(agentDir: string, host: string, action: () => Promise<T>): Promise<T> {
	const root = dirname(signingIdentityPath(agentDir));
	mkdirSync(root, { recursive: true, mode: 0o700 });
	return withStoreLock(root, "governance", { host }, action);
}

function syncDirectory(path: string): void {
	try {
		const fd = openSync(dirname(path), "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		/* Some platforms cannot fsync directories. */
	}
}

function parseSigningTransaction(text: string): SigningTransaction {
	const raw: unknown = JSON.parse(text);
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("object");
	const input = raw as Record<string, unknown>;
	const allowed = new Set(["schema", "kind", "project", "storePath", "successor", "previous", "eventId"]);
	if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("unsupported field");
	if (input.schema !== 1 || (input.kind !== "rotation" && input.kind !== "recovery")) throw new Error("schema");
	if (typeof input.project !== "string" || !isProjectId(input.project)) throw new Error("project");
	if (typeof input.storePath !== "string" || !isAbsolute(input.storePath)) throw new Error("storePath");
	const successor = parseSigningIdentity(JSON.stringify(input.successor));
	const base = { schema: 1 as const, project: input.project, storePath: input.storePath, successor };
	if (input.kind === "recovery") {
		if ("previous" in input || "eventId" in input) throw new Error("recovery");
		return { ...base, kind: "recovery" };
	}
	const previous = parseSigningIdentity(JSON.stringify(input.previous));
	if (
		typeof input.eventId !== "string" ||
		!isKeyEventId(input.eventId) ||
		previous.member !== successor.member ||
		previous.id === successor.id ||
		previous.created_at > successor.created_at
	)
		throw new Error("rotation");
	return { ...base, kind: "rotation", previous, eventId: input.eventId };
}

export function readSigningTransaction(
	agentDir: string,
	scope: SigningTransactionScope & { kind: "rotation" },
): SigningRotation | undefined;
export function readSigningTransaction(
	agentDir: string,
	scope: SigningTransactionScope & { kind: "recovery" },
): SigningRecovery | undefined;
export function readSigningTransaction(
	agentDir: string,
	scope: SigningTransactionScope,
): SigningTransaction | undefined;
export function readSigningTransaction(
	agentDir: string,
	scope: SigningTransactionScope,
): SigningTransaction | undefined {
	const path = signingTransactionPath(agentDir);
	if (!existsSync(path)) return undefined;
	assertPrivateFile(path);
	let pending: SigningTransaction;
	try {
		pending = parseSigningTransaction(readFileSync(path, "utf-8"));
	} catch {
		throw new Error(`muninn: private signing transaction at ${path} is invalid; preserve it for recovery`);
	}
	if (
		pending.kind !== scope.kind ||
		pending.project !== scope.project ||
		pending.storePath !== realpathSync(scope.storePath) ||
		pending.successor.member !== scope.member
	) {
		throw new Error(
			`muninn: finish the pending crypto ${pending.kind === "rotation" ? "rotate" : "recover"} in its original project before changing this signing identity`,
		);
	}
	return pending;
}

export function prepareSigningTransaction(agentDir: string, pending: SigningTransaction): void {
	const path = signingTransactionPath(agentDir);
	if (existsSync(path)) throw new Error("muninn: a signing transaction is already pending");
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", 0o600);
		writeFileSync(fd, `${JSON.stringify({ ...pending, storePath: realpathSync(pending.storePath) }, null, "\t")}\n`);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, path);
		syncDirectory(path);
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(temporary, { force: true });
	}
}

export function finishSigningTransaction(agentDir: string): void {
	const path = signingTransactionPath(agentDir);
	rmSync(path);
	syncDirectory(path);
}
