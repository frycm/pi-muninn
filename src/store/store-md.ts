/**
 * `store.md` — the store's identity and its host registry.
 *
 * Markdown with a flat `key: value` block, like everything else Muninn writes:
 * it is what a small model emits reliably and what a thirty-line parser reads
 * without a YAML library.
 *
 * Host display names are for humans only. Two hosts registering `mbp` while
 * offline is harmless — nothing is keyed on the name, and the reader
 * disambiguates for display.
 */
import { isHostId, isStoreId } from "../ids.ts";
import { parseIdLine } from "../journal/trailer.ts";

/** Bumped when the on-disk layout changes in a way an older Muninn cannot read. */
export const SCHEMA_VERSION = 1;

export interface HostRecord {
	id: string;
	name: string;
	registered: string;
}

export interface StoreMd {
	schema: number;
	store: string;
	created: string;
	hosts: HostRecord[];
}

export interface ParsedStoreMd {
	store: StoreMd | undefined;
	problems: string[];
}

const HEADER = "# muninn store";

export function formatStoreMd(store: StoreMd): string {
	const lines = [
		HEADER,
		"",
		`schema: ${store.schema}`,
		`store: ${store.store}`,
		`created: ${store.created}`,
		"",
		"## Hosts",
		"",
	];
	for (const host of store.hosts) {
		lines.push(`- ${host.id} · name: ${host.name} · registered: ${host.registered}`);
	}
	return `${lines.join("\n")}\n`;
}

/**
 * Parse `store.md`. Tolerant of unknown keys and blank lines, strict about the
 * two things everything else depends on: a schema number and a store id.
 */
export function parseStoreMd(text: string): ParsedStoreMd {
	const problems: string[] = [];
	const fields = new Map<string, string>();
	const hosts: HostRecord[] = [];

	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;

		if (line.startsWith("- ")) {
			const host = parseHostLine(line.slice(2));
			if (host) hosts.push(host);
			else problems.push(`unreadable host line: ${line}`);
			continue;
		}

		const colon = line.indexOf(":");
		if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
	}

	const schemaText = fields.get("schema");
	const storeId = fields.get("store");
	const schema = schemaText === undefined ? Number.NaN : Number.parseInt(schemaText, 10);

	if (!Number.isInteger(schema)) problems.push("missing or unreadable `schema`");
	if (storeId === undefined || !isStoreId(storeId)) problems.push("missing or unreadable `store` id");
	if (problems.some((p) => p.startsWith("missing"))) return { store: undefined, problems };

	return {
		store: {
			schema,
			store: storeId as string,
			created: fields.get("created") ?? "",
			hosts,
		},
		problems,
	};
}

function parseHostLine(line: string): HostRecord | undefined {
	const { id, fields } = parseIdLine(line);
	if (!isHostId(id)) return undefined;
	return { id, name: fields.get("name") ?? "", registered: fields.get("registered") ?? "" };
}

/**
 * Add a host to the registry if it is not already there.
 * Returns the updated store and whether anything changed — callers use the flag
 * to decide whether a commit is warranted.
 */
export function registerHost(store: StoreMd, host: HostRecord): { store: StoreMd; changed: boolean } {
	const existing = store.hosts.find((candidate) => candidate.id === host.id);
	if (existing) {
		if (existing.name === host.name) return { store, changed: false };
		// A renamed machine: keep the registration date, take the new name.
		const hosts = store.hosts.map((candidate) =>
			candidate.id === host.id ? { ...candidate, name: host.name } : candidate,
		);
		return { store: { ...store, hosts }, changed: true };
	}
	return { store: { ...store, hosts: [...store.hosts, host] }, changed: true };
}

/**
 * Display name for a host, disambiguated against the rest of the registry.
 *
 * Two machines that both call themselves `mbp` show as `mbp` and `mbp (2)`, in
 * registration order. Nothing is keyed on the result.
 */
export function hostDisplayName(store: StoreMd, hostId: string): string {
	const host = store.hosts.find((candidate) => candidate.id === hostId);
	if (!host) return hostId;
	const sameName = store.hosts.filter((candidate) => candidate.name === host.name);
	if (sameName.length <= 1) return host.name;
	const position = sameName.findIndex((candidate) => candidate.id === hostId);
	return position === 0 ? host.name : `${host.name} (${position + 1})`;
}

/**
 * Union-merge two host registries.
 *
 * The one merge Phase 1 knows how to do, and the only conflict sync can
 * normally hit: journal files are per host, so the single file two hosts write
 * concurrently is the registry they both add themselves to. Union is the right resolution because
 * a host registration is an *addition* — neither side is asserting anything
 * about the other's hosts.
 *
 * Identity and creation date come from `ours`; where both sides know a host,
 * the earlier registration date wins, because that is the one that is true.
 */
export function mergeStoreMd(ours: StoreMd, theirs: StoreMd): StoreMd {
	const hosts = new Map<string, HostRecord>();
	for (const host of [...theirs.hosts, ...ours.hosts]) {
		const existing = hosts.get(host.id);
		if (!existing) {
			hosts.set(host.id, host);
			continue;
		}
		hosts.set(host.id, {
			id: host.id,
			// A rename is a local fact about a machine; the side that has a name
			// keeps it, and ours wins when both do.
			name: host.name || existing.name,
			registered: earliest(existing.registered, host.registered),
		});
	}

	return {
		schema: Math.max(ours.schema, theirs.schema),
		store: ours.store,
		created: earliest(ours.created, theirs.created),
		// Sorted by registration date then id, so two hosts merging the same two
		// registrations in opposite orders produce the same bytes.
		hosts: [...hosts.values()].sort((a, b) => a.registered.localeCompare(b.registered) || a.id.localeCompare(b.id)),
	};
}

function earliest(a: string, b: string): string {
	if (a === "") return b;
	if (b === "") return a;
	return a <= b ? a : b;
}
