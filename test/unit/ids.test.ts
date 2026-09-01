import { describe, expect, it } from "vitest";
import {
	claimId,
	isClaimId,
	isEntryId,
	isUuidV7,
	newEntryId,
	newHostId,
	parseClaimId,
	shortenId,
	uuidv7,
	uuidv7Timestamp,
} from "../../src/ids.ts";

describe("uuidv7", () => {
	it("has the version and variant bits RFC 9562 requires", () => {
		for (let i = 0; i < 200; i++) {
			const id = uuidv7();
			expect(isUuidV7(id)).toBe(true);
			expect(id[14]).toBe("7"); // version
			expect("89ab").toContain(id[19]); // variant 0b10
		}
	});

	it("encodes the current time", () => {
		const before = Date.now();
		const stamp = uuidv7Timestamp(uuidv7());
		const after = Date.now();
		expect(stamp).not.toBeNull();
		expect(stamp as number).toBeGreaterThanOrEqual(before);
		expect(stamp as number).toBeLessThanOrEqual(after);
	});

	it("sorts lexicographically in creation order, even within one millisecond", () => {
		// This is the property the journal depends on: a daily file read back in
		// id order is in write order. Plain random UUIDv7 tails would break it for
		// ids minted in the same millisecond, which appends routinely are.
		const ids = Array.from({ length: 5_000 }, () => uuidv7());
		const sorted = [...ids].sort();
		expect(sorted).toEqual(ids);
	});

	it("never repeats", () => {
		const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7()));
		expect(ids.size).toBe(10_000);
	});

	it("rejects a uuid of the wrong version", () => {
		expect(isUuidV7("0198f2c1-7b3e-4a10-9c44-2d6e0f1a8b01")).toBe(false); // v4
		expect(isUuidV7("not-a-uuid")).toBe(false);
		expect(isUuidV7("")).toBe(false);
	});
});

describe("entry and claim ids", () => {
	it("mints and recognises entry ids", () => {
		const id = newEntryId();
		expect(id.startsWith("j-")).toBe(true);
		expect(isEntryId(id)).toBe(true);
		expect(isEntryId(id.slice(2))).toBe(false);
		expect(isEntryId(`f-${id.slice(2)}`)).toBe(false);
	});

	it("round-trips a claim id", () => {
		const entry = newEntryId();
		const claim = claimId(entry, 3);
		expect(claim).toBe(`${entry}.3`);
		expect(parseClaimId(claim)).toEqual({ entryId: entry, ordinal: 3 });
		expect(isClaimId(claim)).toBe(true);
	});

	it("refuses a non-positive or non-integer ordinal", () => {
		const entry = newEntryId();
		expect(() => claimId(entry, 0)).toThrow();
		expect(() => claimId(entry, -1)).toThrow();
		expect(() => claimId(entry, 1.5)).toThrow();
	});

	it("refuses to build a claim id on something that is not an entry", () => {
		expect(() => claimId("j-nope", 1)).toThrow();
	});

	it("rejects malformed claim ids rather than guessing", () => {
		const entry = newEntryId();
		expect(parseClaimId(entry)).toBeNull();
		expect(parseClaimId(`${entry}.0`)).toBeNull();
		expect(parseClaimId(`${entry}.01`)).toBeNull();
		expect(parseClaimId(`${entry}.x`)).toBeNull();
		expect(parseClaimId(`${entry}.`)).toBeNull();
	});
});

describe("host ids", () => {
	it("are bare uuidv7s", () => {
		expect(isUuidV7(newHostId())).toBe(true);
	});
});

describe("shortenId", () => {
	it("keeps the time-ordered prefix and the tail", () => {
		const id = "j-0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01";
		const short = shortenId(id);
		expect(short.startsWith("j-0198f2c1")).toBe(true);
		expect(short.endsWith("8b01")).toBe(true);
		expect(short.length).toBeLessThan(id.length);
	});

	it("leaves an already-short string alone", () => {
		expect(shortenId("j-1")).toBe("j-1");
	});

	it("keeps two ids from the same millisecond visibly distinct", () => {
		const a = newEntryId();
		const b = newEntryId();
		expect(shortenId(a)).not.toBe(shortenId(b));
	});
});
