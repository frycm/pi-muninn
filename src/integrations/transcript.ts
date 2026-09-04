/** Explicit age-encrypted exchange for one journal record's local pi transcript. */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	rmSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isEntryId, isProjectId } from "../ids.ts";
import type { JournalRecord } from "../journal/record.ts";

export const TRANSCRIPT_EXCHANGE_DIR = "muninn-transcripts";
export const TRANSCRIPT_MAX_BYTES = 256 * 1024 * 1024;
export const TRANSCRIPT_BUNDLE_MAX_BYTES = TRANSCRIPT_MAX_BYTES + 1024 * 1024;
const MAGIC = "MUNINN-TRANSCRIPT-V1\n";
const MAX_HEADER_BYTES = 16 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

const execFileAsync = promisify(execFile);

export class TranscriptExchangeError extends Error {
	constructor(message: string) {
		super(`muninn: transcript exchange failed: ${message}`);
		this.name = "TranscriptExchangeError";
	}
}

export type AgeRunner = (args: readonly string[]) => Promise<void>;

export const runAge: AgeRunner = async (args) => {
	try {
		await execFileAsync("age", [...args], {
			env: { ...process.env },
			maxBuffer: 1024 * 1024,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new TranscriptExchangeError("age is not installed or not on PATH");
		}
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new TranscriptExchangeError(
			stderr ? `age: ${stderr}` : error instanceof Error ? error.message : String(error),
		);
	}
};

export interface TranscriptLocation {
	available: boolean;
	availability: "original" | "exchange" | "missing";
	local_file?: string;
}

export interface TranscriptExchangeInspection {
	files: number;
	problems: string[];
}

interface TranscriptBundleHeader {
	schema: 1;
	kind: "muninn-transcript";
	project: string;
	record: string;
	bytes: number;
	sha256: string;
	source_name: string;
}

export interface ExportTranscriptOptions {
	record: JournalRecord;
	transcriptRoots: readonly string[];
	output: string;
	recipients: readonly string[];
	runAge?: AgeRunner;
}

export interface ExportTranscriptResult {
	schema: 1;
	kind: "transcript-export";
	project: string;
	record: string;
	output: string;
	recipients: number;
	bytes: number;
	sha256: string;
}

export interface ImportTranscriptOptions {
	agentDir: string;
	project: string;
	input: string;
	identity: string;
	findRecord: (id: string) => JournalRecord | undefined;
	runAge?: AgeRunner;
}

export interface ImportTranscriptResult {
	schema: 1;
	kind: "transcript-import";
	project: string;
	record: string;
	path: string;
	bytes: number;
	sha256: string;
	replayed: boolean;
}

function inside(root: string, path: string): boolean {
	const fromRoot = relative(root, path);
	return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function safeRegularFile(
	path: string,
	label: string,
	maxBytes: number,
	allowSymbolicLink = true,
): { path: string; size: number } {
	let canonical: string;
	try {
		const direct = lstatSync(path);
		if (!allowSymbolicLink && direct.isSymbolicLink()) {
			throw new TranscriptExchangeError(`${label} must not be a symbolic link`);
		}
		canonical = realpathSync(path);
	} catch (error) {
		if (error instanceof TranscriptExchangeError) throw error;
		throw new TranscriptExchangeError(
			`cannot open ${label}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const stat = statSync(canonical);
	if (!stat.isFile()) throw new TranscriptExchangeError(`${label} must be a regular file`);
	if (stat.size > maxBytes) throw new TranscriptExchangeError(`${label} exceeds ${maxBytes} bytes`);
	return { path: canonical, size: stat.size };
}

/** Resolve a synchronized transcript pointer only inside explicitly configured local roots. */
export function resolveOriginalTranscript(file: string, roots: readonly string[]): string | undefined {
	if (!isAbsolute(file)) return undefined;
	let candidate: string;
	try {
		candidate = realpathSync(file);
	} catch {
		return undefined;
	}
	for (const configured of roots) {
		let root: string;
		try {
			root = realpathSync(configured);
		} catch {
			continue;
		}
		if (!inside(root, candidate)) continue;
		try {
			const stat = statSync(candidate);
			if (stat.isFile() && stat.size <= TRANSCRIPT_MAX_BYTES) return candidate;
		} catch {
			// A disappearing file is unavailable, not an error for journal reads.
		}
	}
	return undefined;
}

export function transcriptExchangePath(agentDir: string, project: string, record: string): string {
	if (!isProjectId(project)) throw new TranscriptExchangeError("project is not a valid project ID");
	if (!isEntryId(record)) throw new TranscriptExchangeError("record is not a valid journal record ID");
	return join(agentDir, TRANSCRIPT_EXCHANGE_DIR, project, `${record}.jsonl`);
}

/** Read-only structural diagnostics for one project's optional local exchange cache. */
export function inspectTranscriptExchange(
	agentDir: string,
	project: string,
	records: ReadonlyMap<string, JournalRecord>,
): TranscriptExchangeInspection {
	const problems: string[] = [];
	let files = 0;
	const root = join(agentDir, TRANSCRIPT_EXCHANGE_DIR);
	const projectRoot = join(root, project);
	if (!existsSync(root)) return { files, problems };

	for (const [path, label] of [
		[root, "exchange root"],
		[projectRoot, "project exchange directory"],
	] as const) {
		if (!existsSync(path)) return { files, problems };
		try {
			const stat = lstatSync(path);
			if (stat.isSymbolicLink() || !stat.isDirectory()) {
				problems.push(`${label} is not a real directory: ${path}`);
				return { files, problems };
			}
			const uid = process.getuid?.();
			if (uid !== undefined && stat.uid !== uid) problems.push(`${label} is not owned by the current user`);
			if ((stat.mode & 0o077) !== 0) problems.push(`${label} grants group or other access`);
		} catch (error) {
			problems.push(`cannot inspect ${label}: ${error instanceof Error ? error.message : String(error)}`);
			return { files, problems };
		}
	}

	let entries: ReturnType<typeof readdirSync>;
	try {
		entries = readdirSync(projectRoot, { withFileTypes: true, encoding: "utf-8" });
	} catch (error) {
		problems.push(`cannot list project exchange directory: ${error instanceof Error ? error.message : String(error)}`);
		return { files, problems };
	}
	if (entries.length > 10_000) problems.push("project exchange directory exceeds 10000 entries");
	entries.sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries.slice(0, 10_000)) {
		const path = join(projectRoot, entry.name);
		if (!entry.isFile() || entry.isSymbolicLink()) {
			problems.push(`unexpected non-file exchange entry: ${entry.name}`);
			continue;
		}
		files++;
		const id = entry.name.endsWith(".jsonl") ? entry.name.slice(0, -6) : "";
		const record = id && isEntryId(id) ? records.get(id) : undefined;
		if (!record || record.project !== project || !record.session) {
			problems.push(`exchange file does not name a session-backed journal record: ${entry.name}`);
		}
		try {
			const stat = lstatSync(path);
			if (stat.isSymbolicLink() || !stat.isFile()) {
				problems.push(`exchange entry changed into a non-file: ${entry.name}`);
				continue;
			}
			if ((stat.mode & 0o077) !== 0) problems.push(`exchange file grants group or other access: ${entry.name}`);
			if (stat.size > TRANSCRIPT_MAX_BYTES) problems.push(`exchange file is oversized: ${entry.name}`);
		} catch (error) {
			problems.push(
				`cannot inspect exchange file ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { files, problems };
}

/** Prefer original local evidence, then an explicitly imported exchange copy. */
export function locateTranscript(
	record: JournalRecord,
	transcriptRoots: readonly string[],
	agentDir?: string,
): TranscriptLocation {
	if (record.session) {
		const original = resolveOriginalTranscript(record.session.file, transcriptRoots);
		if (original) return { available: true, availability: "original", local_file: original };
	}
	if (agentDir) {
		const exchanged = transcriptExchangePath(agentDir, record.project, record.id);
		try {
			const checked = safeRegularFile(exchanged, "imported transcript", TRANSCRIPT_MAX_BYTES, false);
			return { available: true, availability: "exchange", local_file: checked.path };
		} catch {
			// Reads do not turn a missing or damaged optional cache into a journal failure.
		}
	}
	return { available: false, availability: "missing" };
}

function validateRecipient(recipient: string): void {
	if (
		recipient.length < 1 ||
		recipient.length > 2048 ||
		recipient.startsWith("-") ||
		[...recipient].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
	) {
		throw new TranscriptExchangeError("recipient is empty, too long, or contains control characters");
	}
}

function ensureOutputTarget(path: string): string {
	const output = resolve(path);
	if (existsSync(output)) throw new TranscriptExchangeError(`refusing to overwrite ${output}`);
	let parent: string;
	try {
		parent = realpathSync(dirname(output));
	} catch (error) {
		throw new TranscriptExchangeError(
			`cannot open output directory: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!statSync(parent).isDirectory()) throw new TranscriptExchangeError("output parent must be a directory");
	return join(parent, basename(output));
}

function fileDigest(path: string): { bytes: number; sha256: string } {
	const hash = createHash("sha256");
	const fd = openSync(path, "r");
	let bytes = 0;
	try {
		const buffer = Buffer.alloc(64 * 1024);
		while (true) {
			const count = readSync(fd, buffer, 0, buffer.length, null);
			if (count === 0) break;
			bytes += count;
			if (bytes > TRANSCRIPT_MAX_BYTES)
				throw new TranscriptExchangeError(`transcript exceeds ${TRANSCRIPT_MAX_BYTES} bytes`);
			hash.update(buffer.subarray(0, count));
		}
	} finally {
		closeSync(fd);
	}
	return { bytes, sha256: hash.digest("hex") };
}

function writeAll(fd: number, bytes: Buffer): void {
	let offset = 0;
	while (offset < bytes.length) {
		const written = writeSync(fd, bytes, offset, bytes.length - offset);
		if (written === 0) throw new TranscriptExchangeError("filesystem made no progress while writing");
		offset += written;
	}
}

function makePlainBundle(path: string, source: string, header: TranscriptBundleHeader): void {
	const output = openSync(path, "wx", 0o600);
	let input: number | undefined;
	const copiedHash = createHash("sha256");
	let copied = 0;
	try {
		input = openSync(source, "r");
		writeAll(output, Buffer.from(`${MAGIC}${JSON.stringify(header)}\n`, "utf-8"));
		const buffer = Buffer.alloc(64 * 1024);
		while (true) {
			const count = readSync(input, buffer, 0, buffer.length, null);
			if (count === 0) break;
			const chunk = buffer.subarray(0, count);
			writeAll(output, chunk);
			copiedHash.update(chunk);
			copied += count;
		}
		fsyncSync(output);
	} finally {
		if (input !== undefined) closeSync(input);
		closeSync(output);
	}
	if (copied !== header.bytes || copiedHash.digest("hex") !== header.sha256) {
		throw new TranscriptExchangeError("transcript changed while it was being packaged");
	}
}

function privateTempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "muninn-transcript-"));
	chmodSync(path, 0o700);
	return path;
}

export async function exportTranscript(options: ExportTranscriptOptions): Promise<ExportTranscriptResult> {
	if (!options.record.session)
		throw new TranscriptExchangeError(`record ${options.record.id} has no transcript pointer`);
	const source = resolveOriginalTranscript(options.record.session.file, options.transcriptRoots);
	if (!source)
		throw new TranscriptExchangeError(`record ${options.record.id} has no original transcript available locally`);
	if (options.recipients.length < 1 || options.recipients.length > 50) {
		throw new TranscriptExchangeError("export needs 1 to 50 recipients");
	}
	for (const recipient of options.recipients) validateRecipient(recipient);
	const output = ensureOutputTarget(options.output);
	if (output === source) throw new TranscriptExchangeError("output must not be the source transcript");
	const digest = fileDigest(source);
	const header: TranscriptBundleHeader = {
		schema: 1,
		kind: "muninn-transcript",
		project: options.record.project,
		record: options.record.id,
		bytes: digest.bytes,
		sha256: digest.sha256,
		source_name: basename(source).slice(0, 255),
	};
	const temporary = privateTempDir();
	const plaintext = join(temporary, "bundle.bin");
	try {
		makePlainBundle(plaintext, source, header);
		await (options.runAge ?? runAge)([
			"--encrypt",
			...options.recipients.flatMap((recipient) => ["--recipient", recipient]),
			"--output",
			output,
			plaintext,
		]);
		if (!existsSync(output))
			throw new TranscriptExchangeError("age reported success without creating the output bundle");
		safeRegularFile(output, "encrypted output bundle", TRANSCRIPT_BUNDLE_MAX_BYTES, false);
		return {
			schema: 1,
			kind: "transcript-export",
			project: options.record.project,
			record: options.record.id,
			output,
			recipients: options.recipients.length,
			bytes: digest.bytes,
			sha256: digest.sha256,
		};
	} catch (error) {
		if (existsSync(output)) rmSync(output, { force: true });
		throw error;
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

function parseHeader(path: string): { header: TranscriptBundleHeader; payloadOffset: number } {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new TranscriptExchangeError("decrypted bundle is not a regular file");
	if (stat.size > TRANSCRIPT_BUNDLE_MAX_BYTES) {
		throw new TranscriptExchangeError(`decrypted bundle exceeds ${TRANSCRIPT_BUNDLE_MAX_BYTES} bytes`);
	}
	const fd = openSync(path, "r");
	let prefix: Buffer;
	try {
		prefix = Buffer.alloc(Math.min(MAX_HEADER_BYTES, stat.size));
		const count = readSync(fd, prefix, 0, prefix.length, 0);
		prefix = prefix.subarray(0, count);
	} finally {
		closeSync(fd);
	}
	const first = prefix.indexOf(0x0a);
	const second = first < 0 ? -1 : prefix.indexOf(0x0a, first + 1);
	if (first < 0 || second < 0) throw new TranscriptExchangeError("decrypted bundle header is incomplete");
	if (prefix.subarray(0, first + 1).toString("utf-8") !== MAGIC) {
		throw new TranscriptExchangeError("decrypted file is not a Muninn transcript bundle");
	}
	let raw: unknown;
	try {
		raw = JSON.parse(prefix.subarray(first + 1, second).toString("utf-8")) as unknown;
	} catch {
		throw new TranscriptExchangeError("decrypted bundle metadata is not valid JSON");
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new TranscriptExchangeError("decrypted bundle metadata must be an object");
	}
	const value = raw as Record<string, unknown>;
	const allowed = new Set(["schema", "kind", "project", "record", "bytes", "sha256", "source_name"]);
	if (Object.keys(value).some((key) => !allowed.has(key))) {
		throw new TranscriptExchangeError("decrypted bundle metadata has unknown fields");
	}
	if (
		value.schema !== 1 ||
		value.kind !== "muninn-transcript" ||
		typeof value.project !== "string" ||
		!isProjectId(value.project) ||
		typeof value.record !== "string" ||
		!isEntryId(value.record) ||
		!Number.isInteger(value.bytes) ||
		(value.bytes as number) < 0 ||
		(value.bytes as number) > TRANSCRIPT_MAX_BYTES ||
		typeof value.sha256 !== "string" ||
		!SHA256.test(value.sha256) ||
		typeof value.source_name !== "string" ||
		value.source_name.length < 1 ||
		value.source_name.length > 255 ||
		basename(value.source_name) !== value.source_name
	) {
		throw new TranscriptExchangeError("decrypted bundle metadata is invalid");
	}
	return { header: value as unknown as TranscriptBundleHeader, payloadOffset: second + 1 };
}

function payloadDigest(path: string, offset: number): { bytes: number; sha256: string; firstLine: string } {
	const hash = createHash("sha256");
	const fd = openSync(path, "r");
	const firstLineChunks: Buffer[] = [];
	let firstLineBytes = 0;
	let sawNewline = false;
	let bytes = 0;
	let position = offset;
	try {
		const buffer = Buffer.alloc(64 * 1024);
		while (true) {
			const count = readSync(fd, buffer, 0, buffer.length, position);
			if (count === 0) break;
			const chunk = buffer.subarray(0, count);
			hash.update(chunk);
			bytes += count;
			position += count;
			if (!sawNewline) {
				const newline = chunk.indexOf(0x0a);
				const part = newline < 0 ? chunk : chunk.subarray(0, newline);
				firstLineBytes += part.length;
				if (firstLineBytes > 1024 * 1024) throw new TranscriptExchangeError("transcript first line exceeds 1 MiB");
				firstLineChunks.push(Buffer.from(part));
				sawNewline = newline >= 0;
			}
		}
	} finally {
		closeSync(fd);
	}
	return { bytes, sha256: hash.digest("hex"), firstLine: Buffer.concat(firstLineChunks).toString("utf-8") };
}

function ensurePrivateDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory())
		throw new TranscriptExchangeError(`${path} is not a private directory`);
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid)
		throw new TranscriptExchangeError(`${path} is not owned by the current user`);
	chmodSync(path, 0o700);
}

function installPayloadNoClobber(bundle: string, offset: number, destination: string): void {
	const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
	const input = openSync(bundle, "r");
	let output: number | undefined;
	let position = offset;
	let failed = false;
	try {
		output = openSync(temporary, "wx", 0o600);
		const buffer = Buffer.alloc(64 * 1024);
		while (true) {
			const count = readSync(input, buffer, 0, buffer.length, position);
			if (count === 0) break;
			writeAll(output, buffer.subarray(0, count));
			position += count;
		}
		fsyncSync(output);
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		closeSync(input);
		if (output !== undefined) closeSync(output);
		if (failed) rmSync(temporary, { force: true });
	}
	try {
		// A hard link gives us an atomic, no-replace installation on the same filesystem.
		linkSync(temporary, destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new TranscriptExchangeError(`refusing to overwrite transcript at ${destination}`);
		}
		throw error;
	} finally {
		unlinkSync(temporary);
	}
}

export async function importTranscript(options: ImportTranscriptOptions): Promise<ImportTranscriptResult> {
	if (!isProjectId(options.project)) throw new TranscriptExchangeError("current project ID is invalid");
	const input = safeRegularFile(resolve(options.input), "encrypted bundle", TRANSCRIPT_BUNDLE_MAX_BYTES).path;
	const identity = safeRegularFile(resolve(options.identity), "age identity", 1024 * 1024).path;
	const temporary = privateTempDir();
	const plaintext = join(temporary, "bundle.bin");
	try {
		await (options.runAge ?? runAge)(["--decrypt", "--identity", identity, "--output", plaintext, input]);
		if (!existsSync(plaintext)) throw new TranscriptExchangeError("age reported success without producing plaintext");
		const { header, payloadOffset } = parseHeader(plaintext);
		if (header.project !== options.project) throw new TranscriptExchangeError("bundle belongs to a different project");
		const record = options.findRecord(header.record);
		if (!record || record.project !== options.project) {
			throw new TranscriptExchangeError(`journal record ${header.record} does not exist in this project`);
		}
		if (!record.session) throw new TranscriptExchangeError(`journal record ${header.record} has no transcript pointer`);
		const digest = payloadDigest(plaintext, payloadOffset);
		if (digest.bytes !== header.bytes)
			throw new TranscriptExchangeError("transcript length does not match the bundle header");
		if (digest.sha256 !== header.sha256)
			throw new TranscriptExchangeError("transcript hash does not match the bundle header");
		try {
			const first = JSON.parse(digest.firstLine) as unknown;
			if (typeof first !== "object" || first === null || Array.isArray(first)) throw new Error("not an object");
		} catch {
			throw new TranscriptExchangeError("transcript does not begin with a JSONL object");
		}
		const exchangeRoot = join(options.agentDir, TRANSCRIPT_EXCHANGE_DIR);
		const projectRoot = join(exchangeRoot, options.project);
		ensurePrivateDir(exchangeRoot);
		ensurePrivateDir(projectRoot);
		const destination = transcriptExchangePath(options.agentDir, options.project, header.record);
		if (existsSync(destination)) {
			const existing = safeRegularFile(destination, "existing imported transcript", TRANSCRIPT_MAX_BYTES, false);
			const existingDigest = fileDigest(existing.path);
			if (existingDigest.bytes !== header.bytes || existingDigest.sha256 !== header.sha256) {
				throw new TranscriptExchangeError(`refusing to overwrite different transcript bytes at ${destination}`);
			}
			return {
				schema: 1,
				kind: "transcript-import",
				project: header.project,
				record: header.record,
				path: destination,
				bytes: header.bytes,
				sha256: header.sha256,
				replayed: true,
			};
		}
		installPayloadNoClobber(plaintext, payloadOffset, destination);
		chmodSync(destination, 0o600);
		return {
			schema: 1,
			kind: "transcript-import",
			project: header.project,
			record: header.record,
			path: destination,
			bytes: header.bytes,
			sha256: header.sha256,
			replayed: false,
		};
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}
