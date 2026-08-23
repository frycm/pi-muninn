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
import { git, gitToplevel } from "../git.ts";
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

const MEMORY_HEADER = [
	"<!-- Written by muninn dreams. Hand edits survive until the next dream rewrites this file. -->",
	"",
	"# Memory",
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
 * `inRepo` marks a store that lives inside a repository Muninn does not own. In
 * that case the repository is never initialised and its git identity is never
 * reconfigured — those commits belong to the project and carry the project's
 * author.
 */
export async function ensureStore(
	storePath: string,
	options: { host: HostIdentity; inRepo?: boolean },
): Promise<EnsureStoreResult> {
	mkdirSync(storePath, { recursive: true });

	return withStoreLock(storePath, "init", { host: options.host.id }, async () => {
		const inRepo = options.inRepo === true;
		const storeMdPath = join(storePath, "store.md");
		const existed = existsSync(storeMdPath);
		const staged = new Set<string>();

		if (!inRepo) {
			// "Inside a work tree" is not the same question as "is this store its
			// own repository": an agent directory that happens to live under a
			// dotfiles repository would otherwise be adopted by it — committing
			// memory into someone else's history, rewriting that repository's
			// git identity, and publishing through its remote. The store must be
			// the toplevel, or it gets its own repository nested here.
			const toplevel = await gitToplevel(storePath);
			const canonical = canonicalPath(storePath);
			if (toplevel === undefined || canonicalPath(toplevel) !== canonical) {
				await git(storePath, { kind: "init" });
			}
			// Set on every open, not only on creation: a store this host *cloned*
			// from its own remote is just as much Muninn's, and would otherwise
			// commit under whatever identity the machine's git config happens to
			// carry — or fail outright on a machine that has none. An in-repo
			// store is the exception: it keeps the project's own author, because
			// reconfiguring it would rewrite the user's git config as a side
			// effect of turning memory on.
			await git(storePath, { kind: "config", key: "user.name", value: `muninn ${options.host.name}` });
			await git(storePath, { kind: "config", key: "user.email", value: `muninn@${options.host.id}` });
		}

		if (!existsSync(join(storePath, ".gitignore"))) {
			writeFileSync(join(storePath, ".gitignore"), GITIGNORE);
			staged.add(".gitignore");
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

		if (!existsSync(join(storePath, "MEMORY.md"))) {
			writeFileSync(join(storePath, "MEMORY.md"), MEMORY_HEADER);
			staged.add("MEMORY.md");
		}

		// This host's journal directory. Git does not track empty directories, so
		// nothing is staged for it; the first append is what puts it in history.
		mkdirSync(join(storePath, "journal", options.host.id), { recursive: true });

		if (staged.size > 0) {
			const paths = [...staged];
			await git(storePath, { kind: "add", paths });
			await git(storePath, {
				kind: "commit",
				message: existed
					? `store: register host ${options.host.name}`
					: `store: initialise (host ${options.host.name})`,
				paths,
			});
		}

		return { path: storePath, created: !existed, store, problems };
	});
}
