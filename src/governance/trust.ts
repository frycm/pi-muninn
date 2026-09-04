/** Local, explicit trust anchors and prospective verification policy. */
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isMemberId, isProjectId } from "../ids.ts";
import { containsSecret, containsUnsafeDisplayCharacters } from "../redact.ts";
import { withStoreLock } from "../store/lock.ts";
import { projectTrustPath, trustRootPath } from "../store/paths.ts";
import type { ProjectManifest } from "../store/project-manifest.ts";
import { isSigningKeyId, signingTimestamp } from "./keys.ts";

export const PROJECT_TRUST_SCHEMA = 1 as const;
export const VERIFICATION_MODES = ["observe", "require"] as const;
export const COMPROMISED_HISTORY_POLICIES = ["retain", "reject"] as const;

export type VerificationMode = (typeof VERIFICATION_MODES)[number];
export type CompromisedHistoryPolicy = (typeof COMPROMISED_HISTORY_POLICIES)[number];

export interface TrustPin {
	member: string;
	key: string;
	pinned_at: string;
}

export interface LocalDistrust {
	key: string;
	distrusted_at: string;
	reason?: string;
}

export interface VerificationPolicy {
	mode: VerificationMode;
	required_after: string | null;
	compromised_history: CompromisedHistoryPolicy;
}

export interface ProjectTrust {
	schema: typeof PROJECT_TRUST_SCHEMA;
	project: string;
	pins: TrustPin[];
	distrust: LocalDistrust[];
	policy: VerificationPolicy;
}

function blank(project: string): ProjectTrust {
	if (!isProjectId(project)) throw new Error("muninn: trust project must be a full UUIDv7");
	return {
		schema: PROJECT_TRUST_SCHEMA,
		project,
		pins: [],
		distrust: [],
		policy: { mode: "observe", required_after: null, compromised_history: "retain" },
	};
}

function object(value: unknown, at: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${at} must be an object`);
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], at: string): void {
	const names = new Set(allowed);
	const unknown = Object.keys(value).find((key) => !names.has(key));
	if (unknown) throw new Error(`${at}.${unknown} is not supported`);
}

function keyId(value: unknown, at: string): string {
	if (typeof value !== "string" || !isSigningKeyId(value)) throw new Error(`${at} must be an Ed25519 fingerprint`);
	return value;
}

function parsePins(value: unknown): TrustPin[] {
	if (!Array.isArray(value) || value.length > 10_000) throw new Error("pins must be an array of at most 10000 items");
	const found = new Map<string, TrustPin>();
	for (let index = 0; index < value.length; index++) {
		const at = `pins[${index}]`;
		const input = object(value[index], at);
		exactKeys(input, ["member", "key", "pinned_at"], at);
		if (typeof input.member !== "string" || !isMemberId(input.member)) {
			throw new Error(`${at}.member must be a member UUIDv7`);
		}
		const pin = {
			member: input.member,
			key: keyId(input.key, `${at}.key`),
			pinned_at: signingTimestamp(input.pinned_at, `${at}.pinned_at`),
		};
		const prior = found.get(pin.key);
		if (prior && JSON.stringify(prior) !== JSON.stringify(pin)) throw new Error(`pin collision for ${pin.key}`);
		found.set(pin.key, pin);
	}
	return [...found.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function parseDistrust(value: unknown): LocalDistrust[] {
	if (!Array.isArray(value) || value.length > 10_000) {
		throw new Error("distrust must be an array of at most 10000 items");
	}
	const found = new Map<string, LocalDistrust>();
	for (let index = 0; index < value.length; index++) {
		const at = `distrust[${index}]`;
		const input = object(value[index], at);
		exactKeys(input, ["key", "distrusted_at", "reason"], at);
		const reason = input.reason;
		if (reason !== undefined && (typeof reason !== "string" || reason.length < 1 || reason.length > 2_000)) {
			throw new Error(`${at}.reason must be a non-empty string of at most 2000 characters`);
		}
		if (typeof reason === "string" && (containsSecret(reason) || containsUnsafeDisplayCharacters(reason))) {
			throw new Error(`${at}.reason contains unsafe text or a secret`);
		}
		const entry = {
			key: keyId(input.key, `${at}.key`),
			distrusted_at: signingTimestamp(input.distrusted_at, `${at}.distrusted_at`),
			...(typeof reason === "string" ? { reason } : {}),
		};
		const prior = found.get(entry.key);
		if (prior && JSON.stringify(prior) !== JSON.stringify(entry))
			throw new Error(`distrust collision for ${entry.key}`);
		found.set(entry.key, entry);
	}
	return [...found.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function parsePolicy(value: unknown): VerificationPolicy {
	const input = object(value, "policy");
	exactKeys(input, ["mode", "required_after", "compromised_history"], "policy");
	if (input.mode !== "observe" && input.mode !== "require") throw new Error("policy.mode is not supported");
	if (input.compromised_history !== "retain" && input.compromised_history !== "reject") {
		throw new Error("policy.compromised_history is not supported");
	}
	const requiredAfter =
		input.required_after === null ? null : signingTimestamp(input.required_after, "policy.required_after");
	if (input.mode === "observe" && requiredAfter !== null) throw new Error("observe policy cannot have required_after");
	if (input.mode === "require" && requiredAfter === null) throw new Error("require policy needs required_after");
	return { mode: input.mode, required_after: requiredAfter, compromised_history: input.compromised_history };
}

export function parseProjectTrust(text: string, expectedProject?: string, path = "trust file"): ProjectTrust {
	try {
		const input = object(JSON.parse(text), "trust");
		exactKeys(input, ["schema", "project", "pins", "distrust", "policy"], "trust");
		if (input.schema !== PROJECT_TRUST_SCHEMA) throw new Error(`schema must be ${PROJECT_TRUST_SCHEMA}`);
		if (typeof input.project !== "string" || !isProjectId(input.project)) {
			throw new Error("project must be a full UUIDv7");
		}
		if (expectedProject && input.project !== expectedProject)
			throw new Error(`project does not match ${expectedProject}`);
		return {
			schema: PROJECT_TRUST_SCHEMA,
			project: input.project,
			pins: parsePins(input.pins),
			distrust: parseDistrust(input.distrust),
			policy: parsePolicy(input.policy),
		};
	} catch (error) {
		throw new Error(
			`muninn: project trust at ${path} is invalid (${error instanceof Error ? error.message : String(error)})`,
		);
	}
}

export function formatProjectTrust(trust: ProjectTrust): string {
	return `${JSON.stringify(parseProjectTrust(JSON.stringify(trust), trust.project), null, "\t")}\n`;
}

function assertTrustFile(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error(`muninn: project trust at ${path} must be a regular file`);
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid)
		throw new Error(`muninn: project trust at ${path} is not owned by this user`);
	if ((stat.mode & 0o022) !== 0) throw new Error(`muninn: project trust at ${path} is writable by group or others`);
}

export function readProjectTrust(agentDir: string, project: string): ProjectTrust {
	const path = projectTrustPath(agentDir, project);
	if (!existsSync(path)) return blank(project);
	assertTrustFile(path);
	return parseProjectTrust(readFileSync(path, "utf-8"), project, path);
}

function fsyncDirectory(path: string): void {
	try {
		const directory = openSync(path, "r");
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
	} catch {
		// Windows and some filesystems do not permit fsync on a directory.
	}
}

function writeProjectTrust(agentDir: string, trust: ProjectTrust): void {
	const root = trustRootPath(agentDir);
	const path = projectTrustPath(agentDir, trust.project);
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", 0o600);
		writeFileSync(fd, formatProjectTrust(trust), "utf-8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporary, path);
		fsyncDirectory(root);
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(temporary, { force: true });
	}
}

async function editProjectTrust(
	agentDir: string,
	project: string,
	host: string,
	edit: (trust: ProjectTrust) => ProjectTrust,
): Promise<{ trust: ProjectTrust; changed: boolean }> {
	const root = trustRootPath(agentDir);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	chmodSync(root, 0o700);
	return withStoreLock(root, "governance", { host }, () => {
		const before = readProjectTrust(agentDir, project);
		const after = parseProjectTrust(JSON.stringify(edit(before)), project);
		if (formatProjectTrust(after) === formatProjectTrust(before)) return { trust: before, changed: false };
		writeProjectTrust(agentDir, after);
		return { trust: after, changed: true };
	});
}

export async function pinProjectSigningKey(options: {
	agentDir: string;
	manifest: ProjectManifest;
	member: string;
	key: string;
	host: string;
	now?: Date;
}): Promise<{ trust: ProjectTrust; changed: boolean }> {
	const descriptor = options.manifest.signing_keys.find(
		(candidate) => candidate.id === options.key && candidate.member === options.member,
	);
	if (!descriptor) throw new Error(`muninn: signing key ${options.key} is not enrolled for member ${options.member}`);
	return editProjectTrust(options.agentDir, options.manifest.project, options.host, (trust) => {
		const prior = trust.pins.find((pin) => pin.key === options.key);
		if (prior && prior.member !== options.member) throw new Error(`muninn: local pin collision for ${options.key}`);
		return {
			...trust,
			pins: prior
				? trust.pins
				: [
						...trust.pins,
						{ member: options.member, key: options.key, pinned_at: (options.now ?? new Date()).toISOString() },
					],
			distrust: trust.distrust.filter((entry) => entry.key !== options.key),
		};
	});
}

export async function distrustProjectSigningKey(options: {
	agentDir: string;
	manifest: ProjectManifest;
	key: string;
	host: string;
	reason?: string;
	now?: Date;
}): Promise<{ trust: ProjectTrust; changed: boolean }> {
	if (!options.manifest.signing_keys.some((candidate) => candidate.id === options.key)) {
		throw new Error(`muninn: signing key ${options.key} is not enrolled in this project`);
	}
	return editProjectTrust(options.agentDir, options.manifest.project, options.host, (trust) => ({
		...trust,
		distrust: [
			...trust.distrust.filter((entry) => entry.key !== options.key),
			{
				key: options.key,
				distrusted_at: (options.now ?? new Date()).toISOString(),
				...(options.reason ? { reason: options.reason } : {}),
			},
		],
	}));
}

export async function setVerificationPolicy(options: {
	agentDir: string;
	project: string;
	host: string;
	mode: VerificationMode;
	requiredAfter?: string;
	compromisedHistory?: CompromisedHistoryPolicy;
}): Promise<{ trust: ProjectTrust; changed: boolean }> {
	return editProjectTrust(options.agentDir, options.project, options.host, (trust) => ({
		...trust,
		policy: {
			mode: options.mode,
			required_after:
				options.mode === "observe"
					? null
					: signingTimestamp(options.requiredAfter ?? new Date().toISOString(), "required_after"),
			compromised_history: options.compromisedHistory ?? trust.policy.compromised_history,
		},
	}));
}
