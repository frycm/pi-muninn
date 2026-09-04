/** Locked, additive publication of member signing keys into project.json. */
import { commitJournalLocked } from "../capture/commit.ts";
import { storeIdentity } from "../store/init.ts";
import { withStoreLock } from "../store/lock.ts";
import {
	type ProjectManifest,
	readProjectManifest,
	withProjectSigningKey,
	writeProjectManifest,
} from "../store/project-manifest.ts";
import type { LocalSigningIdentity } from "./identity.ts";
import { createSigningKeyDescriptor, type SigningKeyDescriptor } from "./keys.ts";

export interface EnrollProjectSigningKeyOptions {
	storePath: string;
	project: string;
	member: string;
	host: { id: string; name: string };
	identity: LocalSigningIdentity;
	previous?: LocalSigningIdentity;
}

export interface EnrollProjectSigningKeyResult {
	key: SigningKeyDescriptor;
	manifest: ProjectManifest;
	replayed: boolean;
	committed: boolean;
}

/** Publish a self-proof, plus an old-key transition when this is a rotation. */
export async function enrollProjectSigningKey(
	options: EnrollProjectSigningKeyOptions,
): Promise<EnrollProjectSigningKeyResult> {
	if (options.identity.member !== options.member) {
		throw new Error(`muninn: signing key belongs to member ${options.identity.member}, not ${options.member}`);
	}
	if (options.previous && options.previous.member !== options.member) {
		throw new Error(`muninn: previous signing key belongs to another member`);
	}
	const key = createSigningKeyDescriptor(options.identity, options.previous);
	return withStoreLock(options.storePath, "governance", { host: options.host.id }, async () => {
		const manifest = readProjectManifest(options.storePath);
		if (!manifest) throw new Error(`muninn: no project.json at ${options.storePath}`);
		if (manifest.project !== options.project) {
			throw new Error(`muninn: project manifest belongs to ${manifest.project}, not ${options.project}`);
		}
		if (!manifest.members.some((candidate) => candidate.id === options.member)) {
			throw new Error(`muninn: member ${options.member} is not registered in this project journal`);
		}
		if (!manifest.hosts.some((candidate) => candidate.id === options.host.id && candidate.member === options.member)) {
			throw new Error(`muninn: local host is not registered to the local member in this project journal`);
		}
		const existing = manifest.signing_keys.find((candidate) => candidate.id === key.id);
		if (existing) {
			if (JSON.stringify(existing) !== JSON.stringify(key)) {
				throw new Error(`muninn: signing key ${key.id} already exists with different metadata`);
			}
			return { key: existing, manifest, replayed: true, committed: false };
		}
		if (key.previous && !manifest.signing_keys.some((candidate) => candidate.id === key.previous)) {
			throw new Error(`muninn: previous signing key ${key.previous} is not enrolled in this project`);
		}
		const updated = writeProjectManifest(options.storePath, withProjectSigningKey(manifest, key));
		const committed = await commitJournalLocked({
			storePath: options.storePath,
			hostId: options.host.id,
			hostName: options.host.name,
			entries: 0,
			force: true,
			identity: storeIdentity({ id: options.host.id, name: options.host.name, createdAt: key.created_at }),
			message: key.previous ? "crypto: rotate member signing key" : "crypto: enroll member signing key",
		});
		return { key, manifest: updated, replayed: false, committed: committed.committed };
	});
}
