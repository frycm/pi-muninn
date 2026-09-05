# Project journal operations

Muninn stores one logical project's history in a separate Git repository. The code
repository remains authoritative; this repository contains immutable JSONL history,
`project.json` team metadata and an optional migration manifest.

See the [user guide](../README.md) for installation, the [technical design](technical-design.md) for implementation, and the [security model](security.md) for trust limits.

## Session memory and solution recall

Inside pi, `/muninn remember [FOCUS]` distills the current branch's useful lessons with the
configured memory model. `/muninn recall QUERY` asks the coding agent to search and load
relevant evidence. Natural requests use the `journal_remember` and `journal_recall` tools.
The standalone CLI continues to provide deterministic `search` and `show` commands.

Set `muninn.memory.model` in global pi settings to `"session"` or `{ "provider": "NAME",
"id": "MODEL" }`. Pi supplies model configuration and credentials. Model selection is
user-owned; repository settings can lower budgets or disable assisted recall, but cannot
redirect excerpts to another provider. A failed explicit model selection never silently
falls back. Restart or reload pi after changing settings.

Remembering produces agent-authored records even when requested by a user. Direct notes
and corrections retain their existing authority. `capture.outcomes: false` disables automatic
extraction but permits an explicit remember command; disabling the project journal disables
both. Full transcripts remain local, while redacted excerpts go to the selected provider.

`/muninn` reports the selected model, recall mode, last operation and available token usage.
A partial remember result lists completed IDs and an error; repeat the command to process
remaining evidence. Prepared records preserve their IDs, timestamps and signatures through
retry. Do not edit memory-state entries to work around an error. Invalid state or changed
prepared bytes require investigation, and the original transcript remains available.

Proactive recall stays disabled by default. The user opts in by setting
`muninn.recall.mode: "assisted"` in global pi settings and reloading or restarting pi.
`/muninn` then reports `recall assisted (proactive on)`. Set it to `"manual"` or remove the
global setting and reload to opt out. A project can disable proactive recall but cannot
enable it without global user opt-in; neither model selection nor quality evaluation opts
the user in. Explicit remember/recall requests remain available in manual mode, independently
of the `capture.outcomes` setting for automatic extraction.

Assisted mode guides the coding model to recall before repeating investigations, without
automatically inserting journal text.
Missing/unavailable model results are distinct from no relevant evidence: use `journal_search`
and `journal_read`, or the CLI, when assisted recall fails. Truncation or changed corrections
can prevent a selected solution from being returned; inspect the complete records explicitly.

## Start a local project journal

From any checkout or linked worktree:

```bash
muninn project link --name my-project
muninn project show
muninn status
```

`project show` prints the durable project UUID and external store path. Linked worktrees
that share a Git common directory resolve to this same UUID and store automatically.

To connect an empty journal remote:

```bash
muninn project remote ssh://git.example/team/my-project-journal.git
muninn sync
```

The command approves the URL in the journal repository’s local Git configuration and also advertises it in the shared manifest. Synced metadata cannot grant or change local approval. An absent approval means local-only even if a legacy manifest or ambient `origin` names a URL. Existing installations must explicitly approve their intended destination once after upgrading. `muninn project remote --remove` disables local synchronization.

## Join an existing team journal

On an existing member's machine, print a share descriptor:

```bash
muninn project share
muninn project share --json | jq
```

On the new machine, run the printed join command from the code checkout:

```bash
muninn project join <journal-url>
muninn sync
```

Join clones into a private temporary directory, validates the manifest, tracked paths,
records and writer ownership, then installs the UUID store and registry mapping. It never
overwrites an existing store. Each member/host writes only
`journal/<member-id>/<host-id>/<YYYY-MM>.jsonl`; sync union-merges concurrent registrations
and refuses identity collisions. Cancellation removes the staged clone; the next join also
cleans private `.join-*` directories left by a process killed before installation. A small
agent-local recovery marker bridges the later crash boundary between installing the
validated UUID store and publishing its registry mapping. The next join revalidates the
same project and remote, verifies the staged member/host ownership, and completes that exact
transaction; it does not adopt an arbitrary unregistered directory.

### Manual recovery join

If automated join cannot be used, obtain the project UUID and journal Git URL from a
teammate, run `muninn project link --id <project-id>`, and use `muninn project show` to find
the destination. If that path was initialized already, move it to a backup path before
cloning the shared journal there. Then run `muninn project remote <journal-url>` to register
the local writer. Do not merge unrelated Git histories.

## Inspect and maintain the team roster

The roster is a deterministic projection over base member/host registration plus immutable
`team_events` in `project.json`:

```bash
muninn team list
muninn team list --json | jq
muninn team rename-member "Display name" --reason "preferred name"
muninn team rename-host <host-id> "build server"
muninn team retire-host <host-id> --reason "machine replaced"
muninn team restore-host <host-id>
muninn team leave --reason "leaving the project"
muninn team return
```

Lifecycle commands can declare state only for the local member and hosts owned by that
member. They append events and commit `project.json`; they never rewrite prior events or
journal records. `/muninn team` is the read-only attended view.

Under the default `observe` policy, retirement remains advisory: it adds lifecycle labels and
diagnostics but does not hide records, block a writer or revoke remote access. Optional
signatures can authenticate a declaration, and `require` can refuse an unverified local
declaration from its prospective cutoff. Repository ACLs still provide actual access control.

## Enable and operate cryptographic governance

Cryptographic governance is optional and never starts itself. To create the first local
Ed25519 member identity, enroll its public descriptor, and pin it on this machine:

```bash
muninn crypto init
muninn crypto public --json | jq '{member, key, public_key}'
muninn crypto status
```

The private key is at `<agent-dir>/muninn/signing.json`, outside every journal repository.
Keep that file mode `0600`, never paste or commit it, and include it in an encrypted private
backup after initialization and every rotation. Test that the backup decrypts to a private
mode-`0600` file and compare only its `id` field with the full `key` fingerprint captured by
`muninn crypto public`; do not activate the test copy alongside the original. Do not use a
transcript-exchange `age` key as this signing identity.

### Verify and pin a teammate

A synchronized public descriptor proves possession, not identity. Obtain the teammate's
member UUID and complete `ed25519:...` key fingerprint over an independent authenticated
channel, compare every character, and only then run:

```bash
muninn crypto trust <member-uuid> <full-ed25519-fingerprint>
muninn crypto status --json | jq
```

`trust` accepts only an exact descriptor already present in the current `project.json`.
Pins and distrust decisions live in
`<agent-dir>/muninn-trust/<project-id>.json`; they are intentionally local and do not
synchronize. To stop accepting a key or every rotation chained through it:

```bash
muninn crypto distrust <full-ed25519-fingerprint> --reason "device custody is uncertain"
```

Re-running `trust` after a new out-of-band comparison removes that local distrust entry.

### Rotate, revoke, or recover a key

Routine rotation retains continuity:

```bash
muninn crypto rotate
muninn crypto public
muninn sync
```

`rotate` durably prepares private successor material in `<agent-dir>/muninn/signing-pending.json`, then publishes and commits the public transition and revocation, installs the successor, and clears the pending transaction. Trust follows an authorized transition from an existing pin. Back up the new private identity after successful rotation.

If a hook, Git commit or process fails, preserve the pending file and rerun **the same command in the same project**. It reuses the same key and event instead of generating another successor. Recovery uses the same durable transaction and can also be retried. Until completion, initialization and identity changes in other projects are refused.

If later governance invalidates a pending rotation, automatic retry refuses to install an untrusted successor. Stop writers; privately back up the store, `signing.json`, `signing-pending.json` and trust file. Move both private identity files to an encrypted recovery archive outside the active agent directory, retaining mode `0600`. Then use `muninn crypto recover` and independently establish new teammate pins. Do not edit the synchronized history or delete the only copy of pending private material. A corrupt pending file should likewise be preserved for diagnosis before recovery.

The local signing identity is shared by the member across logical projects, while public-key
registries and trust remain project-specific. After rotation, visit every other signed project
before writing and run `muninn crypto init`: it reuses and enrolls the current local identity
instead of creating one. Because that other project's manifest did not observe the old key
signing the transition, this enrollment is unchained there; teammates in that project must
compare and pin the fingerprint again. `require` safely refuses writes in the interim.

To revoke one of your enrolled keys explicitly:

```bash
muninn crypto revoke <old-key> --reason "retired device"
```

Recovery deliberately breaks continuity. Use it when the private key is lost or suspected
compromised:

1. Stop writers and preserve any suspect `signing.json` outside the agent directory for
   incident analysis; `recover` runs only when no readable local identity exists.
2. Run `muninn crypto recover`. It creates an unchained key, enrolls it, and pins it only on
   this machine.
3. Send the new member UUID and full fingerprint to every teammate over an independent
   authenticated channel. Each teammate syncs, compares it, and runs `crypto trust`.
4. From the recovered machine, declare the old key compromised at the earliest defensible
   timestamp and synchronize:

```bash
muninn crypto compromise <old-key> --effective 2026-09-04T12:34:56.000Z --reason "laptop stolen"
muninn sync
```

`compromised_history: retain` keeps valid pre-compromise records verified and marks records
at or after the effective time compromised. The conservative `reject` setting marks all
records from that key compromised. Neither setting changes a journal line.

### Require verified new bytes locally

The default mode only observes and reports verification states. After keys have been checked
and pinned, a machine can set a prospective cutoff:

```bash
muninn crypto policy require --from now
muninn crypto policy require --from now --compromised-history reject
muninn search --verification untrusted --json | jq
```

At and after the cutoff, authorized writers require a `verified` signature. Signed lifecycle
events are applied to that machine's roster only when verified. Sync fetches and reconciles
first, then stops before push if the resulting store violates local policy; it does not hide
or delete the offending evidence. Inspect the original bytes, establish trust if appropriate,
append corrections where history is wrong, or explicitly return to reporting-only mode:

```bash
muninn crypto policy observe
```

Local policy does not promise journal completeness. A valid signature detects mutation of an
object that is present, but a single checkout cannot detect a collaborator or remote that
deleted, withheld, or rolled back valid Git history. Use protected branches, repository audit
logs and independent remote backups where those properties matter.

### Remove repository access separately

Member retirement, key revocation, compromise and local distrust do not change Git hosting
permissions. During offboarding or an incident, separately remove the person's/team's SSH
keys, tokens, deploy keys and repository role at the hosting provider, then review branch
protection and audit logs. Muninn intentionally has no provider credential or ACL automation.

## Search and correct history

```bash
muninn search "database migration"
muninn show <record-id> --relations
muninn correct <record-id> "The service now uses PostgreSQL 17."
muninn annotate <record-id> "This applied only to production."
```

Corrections append new direct-user records. They never modify or delete the target. A model
can retrieve and annotate history with `journal_*` tools, but cannot create user-authored
correction meaning.

Raw composition remains supported:

```bash
rg -n '"type":"correction"' "$(muninn path)/journal"
muninn search timeout --json | jq -r '.records[] | [.at, .id, .snippet] | @tsv'
muninn search timeout --json | jq -r '.records[].id' | fzf
```

## Ingest external observations

A process integration writes a bounded envelope to a file or stdin. It cannot choose journal
identity, claim user authority or add correction relations:

```json
{
  "schema": 1,
  "type": "outcome",
  "channel": "hook",
  "status": "completed",
  "body": "Remote deployment finished successfully.",
  "cue": "when reviewing the remote deployment",
  "tags": ["deployment"],
  "paths": ["deploy/service.yaml"],
  "integration": {
    "provider": "deployment-agent",
    "kind": "remote-run",
    "event": "completed",
    "external_id": "run-1842",
    "observed_at": "2026-09-04T12:00:00.000Z",
    "metadata": {"environment": "staging", "attempt": 1}
  }
}
```

```bash
muninn ingest observation.json --json | jq
generate-observations | muninn ingest - --json | jq
muninn search --integration deployment-agent --json | jq '.records[]'
```

Input may be one object, a JSON array or JSONL, up to 1 MiB and 100 observations. The entire
batch is validated before its first append. Replaying identical `(provider, external_id)`
content returns the existing record; different content under the same key is refused. Text
and string metadata receive the normal secret redaction.

Another pi extension can import `muninnIntegrationEntry` from `pi-muninn/integration` and
append its result as a `muninn-integration-v1` custom session entry. Muninn folds those
requests only at safe lifecycle boundaries and validates them again. Ordinary RPC-hosted pi
sessions require no special producer: normal capture already records `channel: "rpc"`.

## Import a pi-enclave audit checkpoint

Summarize one complete local `pi-enclave` audit log without copying commands, paths, prompts
or rule text into the journal:

```bash
muninn integrate enclave /path/to/audit.jsonl --json | jq
muninn search --integration pi-enclave --json | jq '.records[].integration'
```

Muninn verifies the file shape, sequence, timestamp order and exact SHA-256 `prevHash` chain
before appending one aggregate checkpoint. A torn, mixed-session, reordered or tampered log
writes nothing. Re-importing the same verified tail is idempotent; a later tail creates a new
checkpoint. Keep the original audit log under `pi-enclave`'s own retention policy.

## Exchange one transcript with age

Journal records synchronize only transcript pointers. To share detailed evidence, exchange a
single selected transcript explicitly. The sender needs the recipient's public `age`
recipient string:

```bash
muninn transcript export <record-id> evidence.age --recipient age1...
```

Move `evidence.age` through an appropriate team channel; Muninn does not stage or synchronize
it. On the recipient machine, with an `age` identity file:

```bash
chmod 600 identity.txt
muninn transcript import evidence.age --identity identity.txt --json | jq
muninn show <record-id> --json | jq '.transcripts'
```

Import decrypts in a private temporary directory, verifies the project, record, byte length,
SHA-256 and initial JSONL object, then installs a mode-`0600` copy under
`<agent-dir>/muninn-transcripts/<project-id>/`. It refuses a different existing copy and an
identical replay is a no-op. `show` reports that local copy as `availability: "exchange"`
without changing the sender's original pointer.

The `age` executable is needed only for these two commands. Muninn does not manage recipient
or identity keys and an encryption key must not be treated as a signing identity.
Imported copies are local caches: after preserving anything still needed, a user may remove
one explicitly; the journal record remains and its transcript becomes locally unavailable.

## Review and resolve correction conflicts

Two active corrections of the same target remain a visible conflict; timestamp order never
chooses truth:

```bash
muninn conflicts
muninn conflicts --json | jq
muninn resolve <target-id> "The reviewed current statement."
```

`resolve` writes one direct-user correction that points to the target and explicitly
supersedes every branch active under the store lock. It changes no existing bytes. A later
independent correction reopens the conflict, and concurrent resolutions on separate clones
remain competing branches after sync. `/muninn conflicts` provides the same read-only inbox
inside a session; resolution is shell-only.

If `resolve` says the target is not conflicted, it writes nothing. Re-run `muninn conflicts`
after syncing before deciding whether another resolution is needed.

## Migrate a legacy Markdown store

Migration is restartable, idempotent and leaves every source byte untouched:

```bash
muninn migrate --dry-run --json | jq
muninn migrate --json | jq
muninn migrate --json | jq   # imports zero records on a completed rerun
```

Valid legacy IDs, source labels, task grouping, session pointers and unknown fields are
preserved. Truncated or unreadable entries are reported and skipped. `migration.json`
records source fingerprints and imported counts; an interrupted run resumes by stable ID.

Review the dry-run problems before the first write. A mistaken historical assertion is
handled with a correction record, not by rewriting either the source Markdown or imported
JSONL.

## Recovery

The journal has four recovery layers:

1. **Canonical JSONL** — the source of truth. A malformed or truncated line is reported
   locally; later valid records remain readable. Restore accidental byte damage from Git or
   a backup after preserving the damaged shard for diagnosis.
2. **Git history** — sync commits locally before any network operation and never
   force-pushes. Offline fetch leaves new records committed for the next retry. A conflict
   outside `project.json` aborts the rebase and leaves the pre-sync HEAD checked out.
3. **Disposable index** — move or delete `.index/` and run `muninn reindex`; canonical
   results do not depend on index files.
4. **Local signing and trust state** — restore `signing.json` only from a private backup and
   verify its public fingerprint before writing. Never reconstruct local trust from
   synchronized self-assertions. If the key is unavailable or suspect, use unchained recovery
   and repeat out-of-band pinning.

Useful checks:

```bash
muninn doctor
muninn doctor --json | jq
muninn status --json | jq
muninn crypto status --json | jq
git -C "$(muninn path)" status --short
git -C "$(muninn path)" log --oneline --decorate -20
muninn reindex --json | jq
muninn sync --no-push
```

Doctor is read-only. Its stable checks distinguish sync-blocking errors from advisory
warnings and provide a remedy without repairing anything automatically. In particular,
deleting or moving a corrupt `.index/` remains a separate explicit action followed by
`muninn reindex`; doctor never takes it on the user's behalf. It also checks existing local
transcript exchange directories for ownership, private permissions, symlinks, size and a
session-backed record ID, but does not treat an absent exchange cache as a problem.

If shared metadata differs from local transport approval, inspect the change. To change or restore the advertised destination explicitly, use
`muninn project remote URL`; synchronization retains the approved local destination. If a host UUID appears under another member,
stop and restore the correct host identity or journal clone before syncing again.

A record may point to a transcript that exists only on its originating machine. Search and
read still return the record. With no imported copy, `journal_read` reports
`availability: "missing"`; `muninn show` emits the record and exits `3`. This is expected team
behavior, not journal corruption.

## Release performance budgets

The correctness baseline is always a canonical scan. The current release budget on the CI
reference environment is:

- open, validate and build the disposable index for 50,000 typical records in under 20 s;
- execute 50 selective exact, infix or one-edit queries over that index in under 3 s;
- keep a serialized record at or below 64 KiB;
- keep a normal query page at or below the configured output budget (128 KiB by default);
- complete one local append as one locked write plus flush, without a model or network call.

`test/unit/query-perf.test.ts` enforces the 50,000-record open/search budgets. Query/index
equivalence tests enforce that speed cannot change the canonical record set.

The current fixture has 60 crafted queries over 34 records and measures Recall@10 `1.0`, MRR@10 `0.955556` and nDCG@10 `0.967062`, with identical scan/index rankings. These are authored regression scenarios, not production query measurements. Signed-history benchmarks additionally cover cold reads, 50 warm queries and append refresh over 10,000 records. See [testing](testing.md) for commands, budgets and limitations.

The disposable index is currently schema 2. An old schema, invalid analyzer, damaged JSON,
oversized file or mismatch with canonical record terms causes an explicit local rebuild;
`muninn doctor` only reports the condition and never repairs it.
