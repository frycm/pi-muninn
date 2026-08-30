/**
 * Secret scanning.
 *
 * Every journal entry runs through this before it is written. A hit is
 * replaced and the entry marked `redacted: true`. The journal is append-only
 * and syncs to a git remote, so a secret that gets in is not merely leaked, it
 * is leaked into history on every machine that pulls.
 *
 * The plan called for copying pi-enclave's audit-log regex set. That set does
 * not exist yet — enclave defers its audit log to its own Phase 2 — so the set
 * is written here first, in one table, for enclave to adopt when it needs one.
 * Keeping it in a single exported place is what lets the two be diffed later.
 *
 * ## Why hex is not scored by entropy
 *
 * The plan specified entropy > 4.0 bits/char over "base64/hex". For hex that
 * threshold can never fire: a 16-symbol alphabet has a maximum Shannon entropy
 * of exactly log2(16) = 4.0. Lowering it would be worse than useless here,
 * because the things that look like high-entropy hex in *this* corpus are
 * almost all identifiers Muninn depends on — git SHAs, content hashes, and the
 * UUIDv7s in every entry, claim and fact id. Redacting those would corrupt the
 * memory the journal exists to keep.
 *
 * So hex is caught by *context* instead (`api_key: deadbeef…`), which is the
 * shape a hex secret actually appears in, and entropy scoring is applied only
 * to base64-alphabet tokens, where the threshold separates real key material
 * from ordinary identifiers cleanly.
 */

export type SecretKind =
	| "private-key"
	| "aws-access-key"
	| "github-token"
	| "gitlab-token"
	| "slack-token"
	| "slack-webhook"
	| "anthropic-key"
	| "openai-key"
	| "google-api-key"
	| "stripe-key"
	| "npm-token"
	| "jwt"
	| "url-credentials"
	| "keyed-secret"
	| "high-entropy";

export interface SecretHit {
	kind: SecretKind;
	/** Where the secret started in the original text. */
	index: number;
	length: number;
}

export interface RedactionResult {
	text: string;
	hits: SecretHit[];
}

interface PatternRule {
	kind: SecretKind;
	pattern: RegExp;
	/**
	 * Which capture group holds the secret. 0 means the whole match. Used where
	 * the surrounding context must survive — `api_key: <secret>` keeps the key
	 * name so a reader knows what was scrubbed.
	 */
	group?: number;
}

/**
 * Provider-specific shapes, most specific first.
 *
 * Order matters for labelling: `sk-ant-…` is also matched by the generic
 * OpenAI `sk-…`, and whichever runs first names the hit.
 */
const PATTERNS: PatternRule[] = [
	// Whole PEM blocks, including the body, which is the actual key material.
	{
		kind: "private-key",
		pattern: /-----BEGIN[ A-Z0-9]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z0-9]*PRIVATE KEY-----/g,
	},
	{ kind: "aws-access-key", pattern: /\b(?:A3T[A-Z0-9]{2}|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g },
	{ kind: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
	{ kind: "github-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{50,255}\b/g },
	{ kind: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
	{
		kind: "slack-webhook",
		pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]+/g,
	},
	{ kind: "slack-token", pattern: /\bxox[baprse]-[A-Za-z0-9-]{10,}/g },
	{ kind: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
	{ kind: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
	{ kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ kind: "stripe-key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
	{ kind: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
	// Three base64url segments: header.payload.signature.
	{ kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g },
	// user:password@host — the password, not the whole URL.
	{ kind: "url-credentials", pattern: /(?<=:\/\/)[^/\s:@]+:([^/\s:@]{3,})(?=@)/g, group: 1 },
	// The catch-all that gives hex secrets their context. Deliberately requires
	// an assignment: a bare token is not evidence of a secret, a named one is.
	{
		kind: "keyed-secret",
		pattern:
			/(?:password|passwd|pwd|secret|secret[-_]?key|token|api[-_]?key|access[-_]?key|auth[-_]?token|credentials?|bearer)["']?\s*[:=]\s*["']?([^\s"',;)}\]]{8,})["']?/gi,
		group: 1,
	},
];

/** Tokens that look like key material but are identifiers Muninn depends on. */
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const HEX_ONLY = /^[0-9a-fA-F]+$/;
/** Muninn's own journal ids and claim addresses. */
const MUNINN_ID = /^j-/;
/**
 * Subresource-integrity and lockfile digests. They are base64 and they are
 * high entropy, but they are published in every lockfile — a hash of public
 * bytes is not key material, and the algorithm prefix says so unambiguously.
 */
const INTEGRITY_DIGEST = /^sha(?:256|384|512)-/;

const BASE64ISH_TOKEN = /[A-Za-z0-9+/=_-]{20,}/g;
const ENTROPY_THRESHOLD = 4.5;

export function shannonEntropy(value: string): number {
	if (value.length === 0) return 0;
	const counts = new Map<string, number>();
	for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
	let entropy = 0;
	for (const count of counts.values()) {
		const probability = count / value.length;
		entropy -= probability * Math.log2(probability);
	}
	return entropy;
}

/**
 * True when a high-entropy-looking token is something Muninn must never
 * redact: a UUID, one of its own ids, or a bare hex string (git SHA, content
 * hash, checksum).
 *
 * This guards the *entropy* sweep only, and deliberately not the pattern
 * rules. Every pattern requires positive evidence — a provider prefix like
 * `AKIA`, or an explicit `api_key:` assignment — and that evidence outranks
 * the token's shape. Applying the exemption there would mean `api_key:
 * <32 hex chars>` was skipped as "just a hash", which is exactly the case the
 * keyed rule exists to catch.
 */
function isKnownIdentifier(token: string): boolean {
	const bare = token.replace(/^[jf]-/, "").replace(/\.\d+$/, "");
	if (UUID.test(bare)) return true;
	if (MUNINN_ID.test(token)) return true;
	if (INTEGRITY_DIGEST.test(token)) return true;
	// Bare hex of any length: SHAs and hashes. Hex secrets are caught by the
	// keyed-secret rule instead, where the key name supplies the evidence.
	if (HEX_ONLY.test(token)) return true;
	return false;
}

function placeholder(kind: SecretKind): string {
	return `[redacted: ${kind}]`;
}

interface Span {
	start: number;
	end: number;
	kind: SecretKind;
}

/**
 * Scan `text` and replace anything that looks like key material.
 *
 * Returns the redacted text plus one hit per replacement. Hit positions refer
 * to the *original* text, so a caller can report what was found without ever
 * holding the secret itself.
 */
export function redact(text: string): RedactionResult {
	if (text === "") return { text, hits: [] };

	const spans: Span[] = [];

	for (const rule of PATTERNS) {
		for (const match of text.matchAll(rule.pattern)) {
			const group = rule.group ?? 0;
			const raw = match[group];
			if (raw === undefined || raw === "") continue;
			// A secret at the end of a sentence would otherwise swallow the full
			// stop, leaving prose that reads as if a word were missing. Dotted
			// secrets (JWTs) keep their inner dots — only trailing ones go, and
			// the JWT rule matches those in full anyway.
			const value = rule.group === undefined ? raw : raw.replace(/[.]+$/, "");
			if (value === "") continue;
			const start = group === 0 ? match.index : text.indexOf(value, match.index);
			if (start < 0) continue;
			spans.push({ start, end: start + value.length, kind: rule.kind });
		}
	}

	// Entropy sweep over base64-alphabet tokens only. See the note at the top of
	// this file for why hex is excluded.
	for (const match of text.matchAll(BASE64ISH_TOKEN)) {
		const value = match[0];
		if (isKnownIdentifier(value)) continue;
		if (shannonEntropy(value) < ENTROPY_THRESHOLD) continue;
		spans.push({ start: match.index, end: match.index + value.length, kind: "high-entropy" });
	}

	if (spans.length === 0) return { text, hits: [] };

	// Merge overlaps, keeping the widest span and the label of the rule that
	// started earliest — two rules matching one secret is one hit, not two.
	spans.sort((a, b) => a.start - b.start || b.end - a.end);
	const merged: Span[] = [];
	for (const span of spans) {
		const last = merged[merged.length - 1];
		if (last && span.start <= last.end) {
			last.end = Math.max(last.end, span.end);
			continue;
		}
		merged.push({ ...span });
	}

	let out = "";
	let cursor = 0;
	const hits: SecretHit[] = [];
	for (const span of merged) {
		out += text.slice(cursor, span.start) + placeholder(span.kind);
		hits.push({ kind: span.kind, index: span.start, length: span.end - span.start });
		cursor = span.end;
	}
	out += text.slice(cursor);

	return { text: out, hits };
}

/** True when `text` contains anything this scanner would redact. */
export function containsSecret(text: string): boolean {
	return redact(text).hits.length > 0;
}
