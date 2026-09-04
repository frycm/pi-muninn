/** Ed25519 primitives and synchronized public-key/governance contracts. */
import {
	createHash,
	createPrivateKey,
	createPublicKey,
	type KeyObject,
	sign as nodeSign,
	verify as nodeVerify,
} from "node:crypto";
import { isKeyEventId, isMemberId } from "../ids.ts";
import { containsSecret, containsUnsafeDisplayCharacters } from "../redact.ts";

export const SIGNING_ALGORITHM = "ed25519" as const;
const KEY_ID = /^ed25519:[A-Za-z0-9_-]{43}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const RFC3339_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KEY_PROOF_DOMAIN = "MUNINN-KEY-PROOF-V1\0";
const KEY_TRANSITION_DOMAIN = "MUNINN-KEY-TRANSITION-V1\0";
const KEY_EVENT_DOMAIN = "MUNINN-KEY-EVENT-V1\0";

export interface SignatureEnvelope {
	algorithm: typeof SIGNING_ALGORITHM;
	key: string;
	value: string;
}

export interface SigningKeyDescriptor {
	id: string;
	algorithm: typeof SIGNING_ALGORITHM;
	member: string;
	created_at: string;
	public_key: string;
	proof: string;
	previous?: string;
	transition?: string;
}

export type SigningKeyEventKind = "key-revoked" | "key-compromised";

export interface SigningKeyEvent {
	id: string;
	at: string;
	kind: SigningKeyEventKind;
	member: string;
	key: string;
	actor_key: string;
	effective_at: string;
	reason?: string;
	signature: SignatureEnvelope;
}

export interface SigningMaterial {
	id: string;
	algorithm: typeof SIGNING_ALGORITHM;
	member: string;
	created_at: string;
	public_key: string;
	private_key: string;
}

function object(value: unknown, at: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${at} must be an object`);
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], at: string): void {
	const allowedSet = new Set(allowed);
	const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
	if (unknown) throw new Error(`${at}.${unknown} is not supported`);
}

function string(value: unknown, at: string, max: number): string {
	if (typeof value !== "string" || value.length < 1 || value.length > max) {
		throw new Error(`${at} must be a non-empty string of at most ${max} characters`);
	}
	return value;
}

export function signingTimestamp(value: unknown, at: string): string {
	const text = string(value, at, 64);
	if (!RFC3339_MILLIS.test(text) || Number.isNaN(Date.parse(text))) {
		throw new Error(`${at} must be an RFC 3339 UTC timestamp with milliseconds`);
	}
	return text;
}

function decodeBase64Url(value: unknown, at: string, maxBytes: number): Buffer {
	const text = string(value, at, Math.ceil((maxBytes * 4) / 3) + 4);
	if (!BASE64URL.test(text)) throw new Error(`${at} must be unpadded base64url`);
	const decoded = Buffer.from(text, "base64url");
	if (decoded.length < 1 || decoded.length > maxBytes || decoded.toString("base64url") !== text) {
		throw new Error(`${at} is not canonical bounded base64url`);
	}
	return decoded;
}

function publicKeyObject(encoded: string): KeyObject {
	try {
		const key = createPublicKey({ key: Buffer.from(encoded, "base64url"), format: "der", type: "spki" });
		if (key.asymmetricKeyType !== SIGNING_ALGORITHM) throw new Error("not Ed25519");
		return key;
	} catch (error) {
		throw new Error(
			`public key is not canonical Ed25519 SPKI (${error instanceof Error ? error.message : String(error)})`,
		);
	}
}

export function privateKeyObject(encoded: string): KeyObject {
	try {
		const key = createPrivateKey({ key: decodeBase64Url(encoded, "private_key", 128), format: "der", type: "pkcs8" });
		if (key.asymmetricKeyType !== SIGNING_ALGORITHM) throw new Error("not Ed25519");
		return key;
	} catch (error) {
		throw new Error(
			`private key is not canonical Ed25519 PKCS#8 (${error instanceof Error ? error.message : String(error)})`,
		);
	}
}

export function signingKeyId(publicKey: string): string {
	const bytes = decodeBase64Url(publicKey, "public_key", 128);
	publicKeyObject(publicKey);
	return `${SIGNING_ALGORITHM}:${createHash("sha256").update(bytes).digest("base64url")}`;
}

export function isSigningKeyId(value: string): boolean {
	return KEY_ID.test(value);
}

export function signPayload(payload: Uint8Array, material: SigningMaterial): string {
	const signature = nodeSign(null, payload, privateKeyObject(material.private_key));
	return signature.toString("base64url");
}

export function verifyPayload(payload: Uint8Array, signature: string, publicKey: string): boolean {
	try {
		const bytes = decodeBase64Url(signature, "signature", 64);
		if (bytes.length !== 64) return false;
		return nodeVerify(null, payload, publicKeyObject(publicKey), bytes);
	} catch {
		return false;
	}
}

export function signatureEnvelope(payload: Uint8Array, material: SigningMaterial): SignatureEnvelope {
	return { algorithm: SIGNING_ALGORITHM, key: material.id, value: signPayload(payload, material) };
}

export function parseSignatureEnvelope(value: unknown, at = "signature"): SignatureEnvelope {
	const input = object(value, at);
	exactKeys(input, ["algorithm", "key", "value"], at);
	if (input.algorithm !== SIGNING_ALGORITHM) throw new Error(`${at}.algorithm must be ${SIGNING_ALGORITHM}`);
	const key = string(input.key, `${at}.key`, 80);
	if (!isSigningKeyId(key)) throw new Error(`${at}.key must be an Ed25519 fingerprint`);
	const signature = decodeBase64Url(input.value, `${at}.value`, 64);
	if (signature.length !== 64) throw new Error(`${at}.value must encode a 64-byte Ed25519 signature`);
	return { algorithm: SIGNING_ALGORITHM, key, value: signature.toString("base64url") };
}

function descriptorCore(input: Omit<SigningKeyDescriptor, "proof" | "transition">): Record<string, unknown> {
	return {
		id: input.id,
		algorithm: input.algorithm,
		member: input.member,
		created_at: input.created_at,
		public_key: input.public_key,
		...(input.previous ? { previous: input.previous } : {}),
	};
}

function proofPayload(input: Omit<SigningKeyDescriptor, "proof" | "transition">): Buffer {
	return Buffer.from(`${KEY_PROOF_DOMAIN}${JSON.stringify(descriptorCore(input))}`, "utf-8");
}

function transitionPayload(input: Omit<SigningKeyDescriptor, "transition">): Buffer {
	return Buffer.from(
		`${KEY_TRANSITION_DOMAIN}${JSON.stringify({ ...descriptorCore(input), proof: input.proof })}`,
		"utf-8",
	);
}

export function createSigningKeyDescriptor(
	material: SigningMaterial,
	previous?: SigningMaterial,
): SigningKeyDescriptor {
	const core = {
		id: material.id,
		algorithm: SIGNING_ALGORITHM,
		member: material.member,
		created_at: material.created_at,
		public_key: material.public_key,
		...(previous ? { previous: previous.id } : {}),
	} as const;
	const proof = signPayload(proofPayload(core), material);
	return {
		...core,
		proof,
		...(previous ? { transition: signPayload(transitionPayload({ ...core, proof }), previous) } : {}),
	};
}

function parseDescriptor(value: unknown, index: number): SigningKeyDescriptor {
	const at = `signing_keys[${index}]`;
	const input = object(value, at);
	exactKeys(input, ["id", "algorithm", "member", "created_at", "public_key", "proof", "previous", "transition"], at);
	if (input.algorithm !== SIGNING_ALGORITHM) throw new Error(`${at}.algorithm must be ${SIGNING_ALGORITHM}`);
	const id = string(input.id, `${at}.id`, 80);
	const member = string(input.member, `${at}.member`, 64);
	if (!isMemberId(member)) throw new Error(`${at}.member must be a member UUIDv7`);
	const publicKey = decodeBase64Url(input.public_key, `${at}.public_key`, 128).toString("base64url");
	if (signingKeyId(publicKey) !== id) throw new Error(`${at}.id does not match its public key`);
	const proof = decodeBase64Url(input.proof, `${at}.proof`, 64);
	if (proof.length !== 64) throw new Error(`${at}.proof must encode a 64-byte signature`);
	const previous = input.previous === undefined ? undefined : string(input.previous, `${at}.previous`, 80);
	if (previous && !isSigningKeyId(previous)) throw new Error(`${at}.previous must be an Ed25519 fingerprint`);
	const transition =
		input.transition === undefined
			? undefined
			: decodeBase64Url(input.transition, `${at}.transition`, 64).toString("base64url");
	if ((previous === undefined) !== (transition === undefined)) {
		throw new Error(`${at}.previous and transition must either both be present or both be absent`);
	}
	const descriptor: SigningKeyDescriptor = {
		id,
		algorithm: SIGNING_ALGORITHM,
		member,
		created_at: signingTimestamp(input.created_at, `${at}.created_at`),
		public_key: publicKey,
		proof: proof.toString("base64url"),
		...(previous ? { previous } : {}),
		...(transition ? { transition } : {}),
	};
	if (!verifyPayload(proofPayload(descriptor), descriptor.proof, descriptor.public_key)) {
		throw new Error(`${at}.proof is invalid`);
	}
	return descriptor;
}

export function parseSigningKeyDescriptors(value: unknown): SigningKeyDescriptor[] {
	if (!Array.isArray(value)) throw new Error("signing_keys must be an array");
	if (value.length > 10_000) throw new Error("signing_keys must contain at most 10000 descriptors");
	const keys = value.map(parseDescriptor);
	const byId = new Map<string, SigningKeyDescriptor>();
	for (const key of keys) {
		const prior = byId.get(key.id);
		if (prior && JSON.stringify(prior) !== JSON.stringify(key)) throw new Error(`signing key collision for ${key.id}`);
		byId.set(key.id, key);
	}
	for (const key of byId.values()) {
		if (!key.previous) continue;
		if (key.previous === key.id) throw new Error(`signing key ${key.id} names itself as predecessor`);
		const previous = byId.get(key.previous);
		if (!previous) throw new Error(`signing key ${key.id} names missing predecessor ${key.previous}`);
		if (previous.member !== key.member) throw new Error(`signing key ${key.id} crosses member identity`);
		if (key.created_at < previous.created_at) throw new Error(`signing key ${key.id} predates its predecessor`);
		if (!verifyPayload(transitionPayload(key), key.transition as string, previous.public_key)) {
			throw new Error(`signing key ${key.id} has an invalid transition`);
		}
	}
	for (const key of byId.values()) {
		const visited = new Set<string>();
		let cursor: SigningKeyDescriptor | undefined = key;
		while (cursor?.previous) {
			if (visited.has(cursor.id)) throw new Error(`signing key chain containing ${key.id} has a cycle`);
			visited.add(cursor.id);
			cursor = byId.get(cursor.previous);
		}
	}
	return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function eventPayload(event: Omit<SigningKeyEvent, "signature">): Buffer {
	return Buffer.from(
		`${KEY_EVENT_DOMAIN}${JSON.stringify({
			id: event.id,
			at: event.at,
			kind: event.kind,
			member: event.member,
			key: event.key,
			actor_key: event.actor_key,
			effective_at: event.effective_at,
			...(event.reason ? { reason: event.reason } : {}),
		})}`,
		"utf-8",
	);
}

export function createSigningKeyEvent(
	event: Omit<SigningKeyEvent, "signature">,
	actor: SigningMaterial,
): SigningKeyEvent {
	return { ...event, signature: signatureEnvelope(eventPayload(event), actor) };
}

export function parseSigningKeyEvents(value: unknown, keys: readonly SigningKeyDescriptor[]): SigningKeyEvent[] {
	if (!Array.isArray(value)) throw new Error("key_events must be an array");
	if (value.length > 10_000) throw new Error("key_events must contain at most 10000 events");
	const known = new Map(keys.map((key) => [key.id, key]));
	const found = new Map<string, SigningKeyEvent>();
	for (let index = 0; index < value.length; index++) {
		const at = `key_events[${index}]`;
		const input = object(value[index], at);
		exactKeys(input, ["id", "at", "kind", "member", "key", "actor_key", "effective_at", "reason", "signature"], at);
		const id = string(input.id, `${at}.id`, 64);
		if (!isKeyEventId(id)) throw new Error(`${at}.id must be a governance-event UUIDv7`);
		if (input.kind !== "key-revoked" && input.kind !== "key-compromised") {
			throw new Error(`${at}.kind is not supported`);
		}
		const member = string(input.member, `${at}.member`, 64);
		if (!isMemberId(member)) throw new Error(`${at}.member must be a member UUIDv7`);
		const key = string(input.key, `${at}.key`, 80);
		const actorKey = string(input.actor_key, `${at}.actor_key`, 80);
		const target = known.get(key);
		const actor = known.get(actorKey);
		if (!target || target.member !== member) throw new Error(`${at}.key is not owned by its member`);
		if (!actor || actor.member !== member) throw new Error(`${at}.actor_key is not owned by its member`);
		if (input.kind === "key-compromised" && key === actorKey) {
			throw new Error(`${at}.key-compromised needs a different actor key`);
		}
		const reason = input.reason === undefined ? undefined : string(input.reason, `${at}.reason`, 2_000);
		if (reason && (containsUnsafeDisplayCharacters(reason) || containsSecret(reason))) {
			throw new Error(`${at}.reason contains unsafe text or a secret`);
		}
		const unsigned = {
			id,
			at: signingTimestamp(input.at, `${at}.at`),
			kind: input.kind,
			member,
			key,
			actor_key: actorKey,
			effective_at: signingTimestamp(input.effective_at, `${at}.effective_at`),
			...(reason ? { reason } : {}),
		} as const;
		if (unsigned.at < actor.created_at) throw new Error(`${at}.actor_key was created after the event`);
		const signature = parseSignatureEnvelope(input.signature, `${at}.signature`);
		if (signature.key !== actorKey || !verifyPayload(eventPayload(unsigned), signature.value, actor.public_key)) {
			throw new Error(`${at}.signature is invalid`);
		}
		const event: SigningKeyEvent = { ...unsigned, signature };
		const prior = found.get(id);
		if (prior && JSON.stringify(prior) !== JSON.stringify(event)) throw new Error(`key event collision for ${id}`);
		found.set(id, event);
	}
	return [...found.values()].sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
}
