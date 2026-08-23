import { describe, expect, it } from "vitest";
import { newHostId, newStoreId } from "../../src/ids.ts";
import {
	formatStoreMd,
	hostDisplayName,
	parseStoreMd,
	registerHost,
	SCHEMA_VERSION,
	type StoreMd,
} from "../../src/store/store-md.ts";

function sample(): StoreMd {
	return {
		schema: SCHEMA_VERSION,
		store: newStoreId(),
		created: "2026-08-23",
		hosts: [
			{ id: newHostId(), name: "mbp", registered: "2026-08-23" },
			{ id: newHostId(), name: "ops1", registered: "2026-08-24" },
		],
	};
}

describe("store.md round-trip", () => {
	it("parses back what it formatted", () => {
		const store = sample();
		const parsed = parseStoreMd(formatStoreMd(store));
		expect(parsed.problems).toEqual([]);
		expect(parsed.store).toEqual(store);
	});

	it("tolerates blank lines, extra keys and reordering", () => {
		const store = sample();
		const messy = `${formatStoreMd(store)}\n\nnote: written by hand\n\n`;
		const parsed = parseStoreMd(messy);
		expect(parsed.store?.store).toBe(store.store);
		expect(parsed.store?.hosts).toHaveLength(2);
	});

	it("refuses a file with no store id rather than inventing one", () => {
		const parsed = parseStoreMd("# muninn store\n\nschema: 1\n");
		expect(parsed.store).toBeUndefined();
		expect(parsed.problems.join(" ")).toContain("store");
	});

	it("refuses a store id that is not a uuidv7", () => {
		const parsed = parseStoreMd("# muninn store\n\nschema: 1\nstore: nope\n");
		expect(parsed.store).toBeUndefined();
	});

	it("reports an unreadable host line but keeps the store", () => {
		const store = sample();
		const parsed = parseStoreMd(`${formatStoreMd(store)}- not-a-host-id · name: x\n`);
		expect(parsed.store?.hosts).toHaveLength(2);
		expect(parsed.problems.join(" ")).toContain("unreadable host line");
	});
});

describe("registerHost", () => {
	it("adds a host that is not there yet", () => {
		const store = sample();
		const id = newHostId();
		const { store: next, changed } = registerHost(store, { id, name: "new", registered: "2026-08-25" });
		expect(changed).toBe(true);
		expect(next.hosts).toHaveLength(3);
	});

	it("is a no-op for a host already registered under the same name", () => {
		const store = sample();
		const existing = store.hosts[0] as { id: string; name: string; registered: string };
		const { store: next, changed } = registerHost(store, { ...existing, registered: "2026-09-01" });
		expect(changed).toBe(false);
		expect(next).toBe(store);
	});

	it("updates a renamed machine without losing its registration date", () => {
		const store = sample();
		const existing = store.hosts[0] as { id: string; name: string; registered: string };
		const { store: next, changed } = registerHost(store, {
			id: existing.id,
			name: "renamed",
			registered: "2026-09-01",
		});
		expect(changed).toBe(true);
		expect(next.hosts[0]?.name).toBe("renamed");
		expect(next.hosts[0]?.registered).toBe(existing.registered);
	});
});

describe("hostDisplayName", () => {
	it("returns the plain name when it is unique", () => {
		const store = sample();
		const first = store.hosts[0] as { id: string };
		expect(hostDisplayName(store, first.id)).toBe("mbp");
	});

	it("disambiguates two hosts that chose the same name offline", () => {
		// Nothing is keyed on the name, so a collision must be a display problem
		// only — never an error and never a merge conflict.
		const store = sample();
		const clash = { id: newHostId(), name: "mbp", registered: "2026-08-30" };
		const next = registerHost(store, clash).store;
		expect(hostDisplayName(next, (next.hosts[0] as { id: string }).id)).toBe("mbp");
		expect(hostDisplayName(next, clash.id)).toBe("mbp (2)");
	});

	it("falls back to the id for a host that is not registered", () => {
		const store = sample();
		const stranger = newHostId();
		expect(hostDisplayName(store, stranger)).toBe(stranger);
	});
});
