/** Local transport approval. Neither cloned data nor an ambient origin grants it. */
import { GitError, git } from "../git.ts";
import { isUsableRemote } from "../settings.ts";

export async function readAuthorizedRemote(storePath: string): Promise<string | null> {
	let value: string;
	try {
		value = (await git(storePath, { kind: "journal-remote-read" })).stdout.trim();
	} catch (error) {
		if (error instanceof GitError && error.exitCode === 1) return null;
		throw error;
	}
	if (value === "") return null;
	if (!isUsableRemote(value)) throw new Error("muninn: locally approved journal remote is invalid");
	return value;
}

/** Call only for an explicit user's project remote/join action, while holding its lock. */
export async function authorizeJournalRemote(storePath: string, remote: string | null): Promise<void> {
	if (remote !== null && !isUsableRemote(remote)) throw new Error("muninn: invalid journal remote");
	await git(storePath, { kind: "journal-remote-write", url: remote });
}
