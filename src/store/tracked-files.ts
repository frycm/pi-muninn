/** The shared data boundary, checked on join and before/after synchronized checkout. */
import { git } from "../git.ts";
import { isHostId, isMemberId } from "../ids.ts";

const ROOT_FILES = new Set([".gitignore", "project.json", "migration.json"]);
const SHARD = /^journal\/([^/]+)\/([^/]+)\/\d{4}-\d{2}\.jsonl$/;

/** With a ref, inspect its tree without materializing untrusted paths. Otherwise inspect the index. */
export async function validateTrackedJournalFiles(storePath: string, ref?: string): Promise<void> {
	const { stdout } = await git(storePath, ref ? { kind: "ls-tree", ref } : { kind: "ls-files-stage" });
	const pattern = ref ? /^(\d{6}) (?:blob|commit) [0-9a-f]+\t([\s\S]+)$/i : /^(\d{6}) [0-9a-f]+ 0\t([\s\S]+)$/i;
	let hasManifest = false;
	for (const row of stdout.split("\0")) {
		if (row === "") continue;
		const match = row.match(pattern);
		if (!match) throw new Error("muninn: shared repository returned an unreadable tracked-file entry");
		const path = match[2] as string;
		if (match[1] !== "100644") throw new Error(`muninn: shared journal path ${path} is not a regular data file`);
		if (path === "project.json") hasManifest = true;
		if (ROOT_FILES.has(path)) continue;
		const shard = path.match(SHARD);
		if (!shard || !isMemberId(shard[1] as string) || !isHostId(shard[2] as string)) {
			throw new Error(`muninn: shared repository tracks unexpected path ${path}`);
		}
	}
	if (!hasManifest) throw new Error("muninn: shared repository has no tracked project.json");
}
