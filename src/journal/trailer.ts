/**
 * The ` · `-separated `key: value` trailer.
 *
 * Store metadata uses it for compact human-readable lines such as host
 * registrations, so there is exactly one parser and a grammar change lands
 * once.
 */

/** `key: value · key: value` → map. Parts without a colon are skipped. */
export function parseTrailer(text: string): Map<string, string> {
	const fields = new Map<string, string>();
	for (const part of text.split("·")) {
		const colon = part.indexOf(":");
		if (colon < 0) continue;
		fields.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
	}
	return fields;
}

/**
 * A line of the form `<id> · key: value · …`: the bare id first, then the
 * trailer. The id is returned untrimmed of meaning — callers validate it.
 */
export function parseIdLine(text: string): { id: string; fields: Map<string, string> } {
	const dot = text.indexOf("·");
	if (dot < 0) return { id: text.trim(), fields: new Map() };
	return { id: text.slice(0, dot).trim(), fields: parseTrailer(text.slice(dot + 1)) };
}
