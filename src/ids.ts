/**
 * Identities.
 *
 * Everything Muninn cites is a UUIDv7 in full, never truncated. UUIDv7 is
 * time-ordered, so ids sort chronologically within a host's clock, and it needs
 * no coordination: no sequence, no registry lookup, no hash that might collide.
 * Truncation is a rendering concern — `shortenId` exists for display and its
 * output must never be written to a file or used as a key.
 *
 * Muninn mints these itself rather than importing pi's `uuidv7`: pi ships
 * `@earendil-works/pi-ai` inside its own shrinkwrapped `node_modules`, so the
 * symbol is not resolvable from an extension package, and depending on it
 * directly would couple Muninn's id generation to pi's dependency tree.
 */
import { randomBytes } from "node:crypto";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOPIC_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Counter state for RFC 9562 method 1 (replace leftmost random bits with a counter). */
let lastMs = -1;
let counter = 0;

/** 12 bits of counter space; seeded low so there is room to increment within a millisecond. */
const COUNTER_MAX = 0xfff;
const COUNTER_SEED_MASK = 0x7ff;

/**
 * A UUIDv7 (RFC 9562): 48-bit millisecond timestamp, 4-bit version, a 12-bit
 * monotonic counter, 2-bit variant, then 62 random bits.
 *
 * The counter makes ids minted in the same millisecond by this process strictly
 * increasing, which is what lets a journal file be read back in write order. It
 * also absorbs a clock that steps backwards: time never goes down, so ids never
 * do either. Ordering *between* processes within one millisecond is not
 * guaranteed by the id — appends are serialised by the store lock instead.
 */
export function uuidv7(): string {
	const now = Date.now();
	if (now > lastMs) {
		lastMs = now;
		counter = randomBytes(2).readUInt16BE(0) & COUNTER_SEED_MASK;
	} else if (counter >= COUNTER_MAX) {
		// Counter space for this millisecond is exhausted; borrow from the next.
		lastMs += 1;
		counter = randomBytes(2).readUInt16BE(0) & COUNTER_SEED_MASK;
	} else {
		counter += 1;
	}

	const bytes = randomBytes(16);
	const ms = lastMs;
	// 48-bit timestamp, big-endian. Split because a JS bitwise op is 32-bit.
	bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
	bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
	bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
	bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
	bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
	bytes[5] = ms & 0xff;
	// Version 7 in the high nibble, counter in the remaining 12 bits.
	bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
	bytes[7] = counter & 0xff;
	// Variant 0b10.
	bytes[8] = 0x80 | ((bytes[8] as number) & 0x3f);

	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Milliseconds encoded in a UUIDv7, for ordering checks and tests. */
export function uuidv7Timestamp(id: string): number | null {
	if (!UUID_V7.test(id)) return null;
	return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

export function isUuidV7(value: string): boolean {
	return UUID_V7.test(value);
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export function newHostId(): string {
	return uuidv7();
}

export function isHostId(value: string): boolean {
	return UUID_V7.test(value);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function newStoreId(): string {
	return uuidv7();
}

export function isStoreId(value: string): boolean {
	return UUID_V7.test(value);
}

// ---------------------------------------------------------------------------
// Dreams
// ---------------------------------------------------------------------------

/** A globally unique identity for one dream run. */
export function newDreamId(): string {
	return uuidv7();
}

// ---------------------------------------------------------------------------
// Journal entries and claims
// ---------------------------------------------------------------------------

export function newEntryId(): string {
	return `j-${uuidv7()}`;
}

export function isEntryId(value: string): boolean {
	return value.startsWith("j-") && UUID_V7.test(value.slice(2));
}

/**
 * The address of one claim: `<entry id>.<ordinal>`, 1-based.
 *
 * Claims are the unit of everything downstream — indexed as their own chunk,
 * cited as evidence, superseded individually — so they are addressed, not
 * merely counted.
 */
export function claimId(entryId: string, ordinal: number): string {
	if (!isEntryId(entryId)) throw new Error(`not an entry id: ${entryId}`);
	if (!Number.isInteger(ordinal) || ordinal < 1)
		throw new Error(`claim ordinal must be a positive integer: ${ordinal}`);
	return `${entryId}.${ordinal}`;
}

export function parseClaimId(value: string): { entryId: string; ordinal: number } | null {
	const dot = value.lastIndexOf(".");
	if (dot === -1) return null;
	const entryId = value.slice(0, dot);
	const ordinalText = value.slice(dot + 1);
	if (!isEntryId(entryId)) return null;
	if (!/^[1-9][0-9]*$/.test(ordinalText)) return null;
	return { entryId, ordinal: Number.parseInt(ordinalText, 10) };
}

export function isClaimId(value: string): boolean {
	return parseClaimId(value) !== null;
}

// ---------------------------------------------------------------------------
// Facts (minted by dreams in Phase 2; the format is fixed here)
// ---------------------------------------------------------------------------

export function newFactId(topic: string): string {
	if (!TOPIC_SLUG.test(topic)) throw new Error(`topic must be a lowercase slug: ${topic}`);
	return `f-${topic}-${uuidv7()}`;
}

export function isFactId(value: string): boolean {
	return parseFactId(value) !== null;
}

/** A topic may itself contain hyphens, so the uuid is taken from the end. */
export function parseFactId(value: string): { topic: string; uuid: string } | null {
	if (!value.startsWith("f-")) return null;
	if (value.length < 2 + 1 + 1 + 36) return null;
	const uuid = value.slice(-36);
	if (!UUID_V7.test(uuid)) return null;
	const topic = value.slice(2, -37);
	if (value[value.length - 37] !== "-") return null;
	if (!TOPIC_SLUG.test(topic)) return null;
	return { topic, uuid };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * Elide the middle of an id for a terminal. Display only: the result is
 * ambiguous by construction and must never be written to a file, used as a
 * lookup key, or passed to a tool.
 */
export function shortenId(id: string, keepTail = 4): string {
	// Keep the time-ordered prefix, which is what makes two ids visibly distinct.
	const prefixLength = id.startsWith("j-") || id.startsWith("f-") ? 10 : 8;
	if (id.length <= prefixLength + keepTail + 1) return id;
	return `${id.slice(0, prefixLength)}…${id.slice(-keepTail)}`;
}
