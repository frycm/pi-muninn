# Project journal operations

Muninn stores one logical project's history in a separate Git repository. The code
repository remains authoritative; this repository contains immutable JSONL history,
`project.json` team metadata and an optional migration manifest.

Validated onboarding, advisory lifecycle, conflict resolution, diagnostics and optional
Phase 6 integrations are implemented. The manual team-join procedure below is a recovery
path, not the normal setup. The integration boundaries are in
[phase-6-plan.md](phase-6-plan.md).

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

The command writes the remote to the user-owned journal manifest. Muninn never infers it
from the code repository and ignores an ambient journal-repository `origin` while the
manifest remote is unset.

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

Retirement is advisory because the Git content is unsigned. It adds lifecycle labels and
diagnostics but does not hide records, block a writer or revoke remote access. Use repository
ACLs for actual access control.

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
or identity keys and an encryption key must not be treated as a Phase 7 signing identity.
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

## Migrate a Phase 1 Markdown store

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

The journal has three recovery layers:

1. **Canonical JSONL** — the source of truth. A malformed or truncated line is reported
   locally; later valid records remain readable. Restore accidental byte damage from Git or
   a backup after preserving the damaged shard for diagnosis.
2. **Git history** — sync commits locally before any network operation and never
   force-pushes. Offline fetch leaves new records committed for the next retry. A conflict
   outside `project.json` aborts the rebase and leaves the pre-sync HEAD checked out.
3. **Disposable index** — move or delete `.index/` and run `muninn reindex`; canonical
   results do not depend on index files.

Useful checks:

```bash
muninn doctor
muninn doctor --json | jq
muninn status --json | jq
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

If two manifests name different remotes, choose the intended URL explicitly with
`muninn project remote`; Muninn will not guess. If a host UUID appears under another member,
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

The Phase 5 checked-in retrieval corpus has eight development/operations judgments and
measures Recall@10 `1.0`, MRR@10 `0.9375` and nDCG@10 `0.953866` identically in scan and
index modes. This is a regression fixture, not evidence broad enough to justify semantic
retrieval: it is below the 50-real-query experiment gate, while lexical recall is already
above `0.90`. The release therefore has no embedding model, vector store or hidden retrieval
service.

The disposable index is currently schema 2. An old schema, invalid analyzer, damaged JSON,
oversized file or mismatch with canonical record terms causes an explicit local rebuild;
`muninn doctor` only reports the condition and never repairs it.
