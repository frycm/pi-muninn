/** Explicit cryptographic bootstrap; never called by ordinary startup or writes. */
import type { HostIdentity } from "../store/host.ts";
import { type ProjectManifest, readProjectManifest } from "../store/project-manifest.ts";
import { initializeSigningIdentity, type PublicSigningIdentity, publicSigningIdentity } from "./identity.ts";
import { enrollProjectSigningKey } from "./registry.ts";
import { pinProjectSigningKey } from "./trust.ts";

export interface InitializeProjectCryptographyResult {
	schema: 1;
	kind: "cryptographic-initialization";
	identity: PublicSigningIdentity;
	identity_created: boolean;
	key_enrolled: boolean;
	key_pinned: boolean;
	manifest: ProjectManifest;
}

export async function initializeProjectCryptography(options: {
	agentDir: string;
	storePath: string;
	project: string;
	member: string;
	host: HostIdentity;
}): Promise<InitializeProjectCryptographyResult> {
	const initialized = initializeSigningIdentity(options.agentDir, options.member);
	const enrollment = await enrollProjectSigningKey({
		storePath: options.storePath,
		project: options.project,
		member: options.member,
		host: options.host,
		identity: initialized.identity,
	});
	const manifest = readProjectManifest(options.storePath);
	if (!manifest) throw new Error(`muninn: no project.json at ${options.storePath}`);
	const pinned = await pinProjectSigningKey({
		agentDir: options.agentDir,
		manifest,
		member: options.member,
		key: initialized.identity.id,
		host: options.host.id,
	});
	return {
		schema: 1,
		kind: "cryptographic-initialization",
		identity: publicSigningIdentity(initialized.identity),
		identity_created: initialized.created,
		key_enrolled: !enrollment.replayed,
		key_pinned: pinned.changed,
		manifest,
	};
}
