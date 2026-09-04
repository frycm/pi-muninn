/** Explicit, user-owned Ed25519 member identity outside every journal repository. */
import { createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { isMemberId } from "../ids.ts";
import { signingIdentityPath } from "../store/paths.ts";
import { type ProjectManifest, readProjectManifest } from "../store/project-manifest.ts";
import { privateKeyObject, SIGNING_ALGORITHM, type SigningMaterial, signingKeyId, signingTimestamp } from "./keys.ts";

export const SIGNING_IDENTITY_SCHEMA = 1 as const;

export interface LocalSigningIdentity extends SigningMaterial {
	schema: typeof SIGNING_IDENTITY_SCHEMA;
}

export interface PublicSigningIdentity {
	schema: 1;
	kind: "member-signing-key";
	member: string;
	key: string;
	algorithm: typeof SIGNING_ALGORITHM;
	created_at: string;
	public_key: string;
}

export class SigningIdentityError extends Error {
	constructor(message: string) {
		super(`muninn: signing identity: ${message}`);
		this.name = "SigningIdentityError";
	}
}

function generate(member: string, now: Date): LocalSigningIdentity {
	if (!isMemberId(member)) throw new SigningIdentityError("member is not a UUIDv7");
	const { publicKey, privateKey } = generateKeyPairSync(SIGNING_ALGORITHM);
	const publicEncoded = (publicKey.export({ format: "der", type: "spki" }) as Buffer).toString("base64url");
	const privateEncoded = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64url");
	return {
		schema: SIGNING_IDENTITY_SCHEMA,
		id: signingKeyId(publicEncoded),
		algorithm: SIGNING_ALGORITHM,
		member,
		created_at: now.toISOString(),
		public_key: publicEncoded,
		private_key: privateEncoded,
	};
}

export function parseSigningIdentity(text: string, path = "signing.json"): LocalSigningIdentity {
	try {
		const raw: unknown = JSON.parse(text);
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("root must be an object");
		const input = raw as Record<string, unknown>;
		const allowed = new Set(["schema", "id", "algorithm", "member", "created_at", "public_key", "private_key"]);
		const unknown = Object.keys(input).find((key) => !allowed.has(key));
		if (unknown) throw new Error(`${unknown} is not supported`);
		if (input.schema !== SIGNING_IDENTITY_SCHEMA) throw new Error(`schema must be ${SIGNING_IDENTITY_SCHEMA}`);
		if (input.algorithm !== SIGNING_ALGORITHM) throw new Error(`algorithm must be ${SIGNING_ALGORITHM}`);
		if (typeof input.member !== "string" || !isMemberId(input.member)) throw new Error("member must be a UUIDv7");
		if (typeof input.public_key !== "string") throw new Error("public_key must be a string");
		if (typeof input.private_key !== "string") throw new Error("private_key must be a string");
		const privateKey = privateKeyObject(input.private_key);
		const derivedPublic = (createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer).toString(
			"base64url",
		);
		if (derivedPublic !== input.public_key) throw new Error("public key does not match private key");
		const id = signingKeyId(input.public_key);
		if (input.id !== id) throw new Error("id does not match public key fingerprint");
		return {
			schema: SIGNING_IDENTITY_SCHEMA,
			id,
			algorithm: SIGNING_ALGORITHM,
			member: input.member,
			created_at: signingTimestamp(input.created_at, "created_at"),
			public_key: input.public_key,
			private_key: input.private_key,
		};
	} catch (error) {
		if (error instanceof SigningIdentityError) throw error;
		throw new SigningIdentityError(`${path} is invalid (${error instanceof Error ? error.message : String(error)})`);
	}
}

function assertPrivateFile(path: string): void {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isFile()) throw new SigningIdentityError(`${path} must be a regular file`);
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) throw new SigningIdentityError(`${path} is not owned by the current user`);
	if ((stat.mode & 0o077) !== 0) throw new SigningIdentityError(`${path} grants group or other access`);
}

export function readSigningIdentity(agentDir: string, expectedMember?: string): LocalSigningIdentity | undefined {
	const path = signingIdentityPath(agentDir);
	if (!existsSync(path)) return undefined;
	try {
		assertPrivateFile(path);
		const identity = parseSigningIdentity(readFileSync(path, "utf-8"), path);
		if (expectedMember && identity.member !== expectedMember) {
			throw new SigningIdentityError(
				`${path} belongs to member ${identity.member}, not current member ${expectedMember}`,
			);
		}
		return identity;
	} catch (error) {
		if (error instanceof SigningIdentityError) throw error;
		throw new SigningIdentityError(`cannot read ${path} (${error instanceof Error ? error.message : String(error)})`);
	}
}

/** Require an explicitly supplied private identity to match a synchronized descriptor. */
export function assertSigningIdentityEnrolled(
	manifest: ProjectManifest,
	identity: SigningMaterial,
	member: string,
): void {
	if (identity.member !== member) throw new SigningIdentityError(`key ${identity.id} belongs to another member`);
	const descriptor = manifest.signing_keys.find((candidate) => candidate.id === identity.id);
	if (!descriptor || descriptor.member !== member || descriptor.public_key !== identity.public_key) {
		throw new SigningIdentityError(`key ${identity.id} is not enrolled for member ${member} in this project`);
	}
}

/** Read the local key only for a project that has explicitly enrolled it. */
export function readEnrolledSigningIdentity(
	agentDir: string,
	storePath: string,
	member: string,
): LocalSigningIdentity | undefined {
	const identity = readSigningIdentity(agentDir, member);
	if (!identity) return undefined;
	const manifest = readProjectManifest(storePath);
	if (!manifest) return undefined;
	const descriptor = manifest.signing_keys.find((candidate) => candidate.id === identity.id);
	return descriptor?.member === member && descriptor.public_key === identity.public_key ? identity : undefined;
}

function writeNewIdentity(path: string, identity: LocalSigningIdentity): void {
	const root = dirname(path);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	chmodSync(root, 0o700);
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", 0o600);
		writeFileSync(fd, `${JSON.stringify(identity, null, "\t")}\n`, "utf-8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		try {
			linkSync(temporary, path);
			// Make the new directory entry durable where the platform supports it.
			try {
				const directory = openSync(root, "r");
				try {
					fsyncSync(directory);
				} finally {
					closeSync(directory);
				}
			} catch {
				// Windows and some filesystems do not permit fsync on a directory.
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(temporary, { force: true });
	}
}

/** Explicit and idempotent initialization; ordinary Muninn startup never calls this. */
export function initializeSigningIdentity(
	agentDir: string,
	member: string,
	now: Date = new Date(),
): { identity: LocalSigningIdentity; created: boolean } {
	const existing = readSigningIdentity(agentDir, member);
	if (existing) return { identity: existing, created: false };
	const generated = generate(member, now);
	const path = signingIdentityPath(agentDir);
	writeNewIdentity(path, generated);
	const winner = readSigningIdentity(agentDir, member);
	if (!winner) throw new SigningIdentityError(`failed to create ${path}`);
	return { identity: winner, created: winner.id === generated.id };
}

export function publicSigningIdentity(identity: LocalSigningIdentity): PublicSigningIdentity {
	return {
		schema: 1,
		kind: "member-signing-key",
		member: identity.member,
		key: identity.id,
		algorithm: identity.algorithm,
		created_at: identity.created_at,
		public_key: identity.public_key,
	};
}

/** Generates material in memory for a signed rotation; it does not write anything. */
export function generateSigningIdentity(member: string, now: Date = new Date()): LocalSigningIdentity {
	return generate(member, now);
}
