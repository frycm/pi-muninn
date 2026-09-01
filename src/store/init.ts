/**
 * Creating a store, and making sure an existing one is usable.
 *
 * Idempotent by construction: every step asks "is this already true?" first, so
 * calling `ensureStore` on every session start is cheap and safe. Nothing here
 * touches a file a later step has not been told about — a store is a git
 * repository whose whole contents Muninn wrote.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GitIdentity, git, gitToplevel } from "../git.ts";
import { newStoreId } from "../ids.ts";
import type { HostIdentity } from "./host.ts";
import { withStoreLock } from "./lock.ts";
import { canonicalPath } from "./paths.ts";
import { formatStoreMd, parseStoreMd, registerHost, SCHEMA_VERSION, type StoreMd } from "./store-md.ts";

/**
 * Derived or machine-local; never committed.
 *
 * `host.json` matters most here. It lives at `<agentDir>/muninn/host.json`,
 * which is *inside* the global store — the very repository that syncs to a
 * remote. Were it committed, another machine pulling the store would find this
 * machine's identity file and could adopt its host id, collapsing the per-host
 * journal directories that keep sync from ever having to merge two machines'
 * writes to one file.
 */
const GITIGNORE = [
	"# Derived, rebuildable, or machine-local. Never committed.",
	".index/",
	".lock",
	".lock.json",
	"host.json",
	"",
].join("\n");

export interface EnsureStoreResult {
	path: string;
	/** True when this call created the store rather than finding it. */
	created: boolean;
	store: StoreMd;
	/** Problems found parsing an existing `store.md`; empty on a healthy store. */
	problems: string[];
}

/** The branch every store lives on, whatever the machine's `init.defaultBranch` says. */
export const STORE_BRANCH = "main";

/** The identity a store Muninn owns commits under. */
export function storeIdentity(host: HostIdentity): GitIdentity {
	return { name: `muninn ${host.name}`, email: `muninn@${host.id}` };
}

export class SchemaTooNewError extends Error {
	constructor(path: string, found: number) {
		super(
			`muninn: store at ${path} uses schema ${found}, but this Muninn understands ${SCHEMA_VERSION}. ` +
				"Upgrade pi-muninn; refusing to touch the store.",
		);
		this.name = "SchemaTooNewError";
	}
}

/**
 * Create the store if absent, register this host, and leave it committed.
 *
 * Every active store is below the user-owned agent directory. A project cannot
 * opt into its code repository or make Muninn adopt an enclosing repository.
 */
export async function ensureStore(storePath: string, options: { host: HostIdentity }): Promise<EnsureStoreResult> {
	mkdirSync(storePath, { recursive: true });

	return withStoreLock(storePath, "init", { host: options.host.id }, async () => {
		const storeMdPath = join(storePath, "store.md");
		const existed = existsSync(storeMdPath);
		const staged = new Set<string>();
		const identity = storeIdentity(options.host);
		const commitOptions = { identity };
		/** This call created the repository — so nothing in it is tracked yet. */
		let fresh = false;

		// "Inside a work tree" is not the same question as "is this store its
		// own repository": an agent directory under a dotfiles repository must
		// still get a nested, Muninn-owned repository.
		const toplevel = await gitToplevel(storePath);
		const canonical = canonicalPath(storePath);
		if (toplevel === undefined || canonicalPath(toplevel) !== canonical) {
			await git(storePath, { kind: "init" });
			await git(storePath, { kind: "set-head", branch: STORE_BRANCH });
			await git(storePath, { kind: "config", key: "user.name", value: identity.name });
			await git(storePath, { kind: "config", key: "user.email", value: identity.email });
			fresh = true;
		} else {
			await ensureBranch(storePath);
			if (!hasConfiguredIdentity(storePath)) {
				await git(storePath, { kind: "config", key: "user.name", value: identity.name });
				await git(storePath, { kind: "config", key: "user.email", value: identity.email });
			}
		}

		if (!existsSync(join(storePath, ".gitignore"))) {
			writeFileSync(join(storePath, ".gitignore"), GITIGNORE);
			staged.add(".gitignore");
		}
		// A repository created around files that already existed — a store an
		// older build let an enclosing repository adopt — has them all untracked.
		// Everything the store owns goes into the first commit, not only what
		// this call wrote; otherwise the branch stays unborn and can never sync.
		if (fresh) {
			for (const name of [".gitignore", "store.md"]) {
				if (existsSync(join(storePath, name))) staged.add(name);
			}
		}

		// --- store.md -------------------------------------------------------
		let store: StoreMd;
		let problems: string[] = [];
		if (existed) {
			const parsed = parseStoreMd(readFileSync(storeMdPath, "utf-8"));
			problems = parsed.problems;
			if (!parsed.store) {
				throw new Error(`muninn: ${storeMdPath} is unreadable (${problems.join("; ")}); refusing to overwrite it`);
			}
			if (parsed.store.schema > SCHEMA_VERSION) throw new SchemaTooNewError(storePath, parsed.store.schema);
			store = parsed.store;
		} else {
			store = {
				schema: SCHEMA_VERSION,
				store: newStoreId(),
				created: new Date().toISOString().slice(0, 10),
				hosts: [],
			};
		}

		const registered = registerHost(store, {
			id: options.host.id,
			name: options.host.name,
			registered: new Date().toISOString().slice(0, 10),
		});
		store = registered.store;
		if (!existed || registered.changed) {
			writeFileSync(storeMdPath, formatStoreMd(store));
			staged.add("store.md");
		}

		// This host's journal directory. Git does not track empty directories, so
		// nothing is staged for it; the first append is what puts it in history.
		mkdirSync(join(storePath, "journal", options.host.id), { recursive: true });

		if (staged.size > 0) {
			const paths = [...staged];
			await git(storePath, { kind: "add", paths });
			await git(
				storePath,
				{
					kind: "commit",
					message:
						existed && !fresh
							? `store: register host ${options.host.name}`
							: `store: initialise (host ${options.host.name})`,
					paths,
				},
				commitOptions,
			);
		}

		return { path: storePath, created: !existed, store, problems };
	});
}

/**
 * Put the store on `STORE_BRANCH`, renaming whatever branch it is on.
 *
 * Only for a repository Muninn owns. A detached HEAD is left alone: someone is
 * looking at history, and sync will say so rather than guess.
 */
async function ensureBranch(storePath: string): Promise<void> {
	let branch: string;
	try {
		branch = (await git(storePath, { kind: "current-branch" })).stdout.trim();
	} catch {
		return;
	}
	if (branch === "" || branch === STORE_BRANCH) return;
	await git(storePath, { kind: "branch-rename", to: STORE_BRANCH });
}

/** Whether the repository's own config names a committer. */
function hasConfiguredIdentity(storePath: string): boolean {
	try {
		return /^\[user\]/m.test(readFileSync(join(storePath, ".git", "config"), "utf-8"));
	} catch {
		return false;
	}
}
