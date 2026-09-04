# Project journal operations

Phase 3 stores one logical project's history in a separate Git repository. The code
repository remains authoritative; this repository contains immutable JSONL history,
`project.json` team metadata and an optional migration manifest.

The manual team-join procedure below remains the Phase 3 recovery path. Phase 4's validated
one-command onboarding and governance work is specified in
[phase-4-plan.md](phase-4-plan.md).

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
and refuses identity collisions.

### Manual recovery join

If automated join cannot be used, obtain the project UUID and journal Git URL from a
teammate, run `muninn project link --id <project-id>`, and use `muninn project show` to find
the destination. If that path was initialized already, move it to a backup path before
cloning the shared journal there. Then run `muninn project remote <journal-url>` to register
the local writer. Do not merge unrelated Git histories.

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
muninn status --json | jq
git -C "$(muninn path)" status --short
git -C "$(muninn path)" log --oneline --decorate -20
muninn reindex --json | jq
muninn sync --no-push
```

If two manifests name different remotes, choose the intended URL explicitly with
`muninn project remote`; Muninn will not guess. If a host UUID appears under another member,
stop and restore the correct host identity or journal clone before syncing again.

A record may point to a transcript that exists only on its originating machine. Search and
read still return the record. `journal_read` reports `available: false`; `muninn show` emits
the record and exits `3`. This is expected team behavior, not journal corruption.

## Release performance budgets

The correctness baseline is always a canonical scan. The Phase 3 release budget on the CI
reference environment is:

- open, validate and build the disposable index for 10,000 typical records in under 8 s;
- execute 20 exact lexical queries over that index in under 2 s;
- keep a serialized record at or below 64 KiB;
- keep a normal query page at or below the configured output budget (128 KiB by default);
- complete one local append as one locked write plus flush, without a model or network call.

`test/unit/query-perf.test.ts` enforces the 10,000-record open/search budgets. Query/index
equivalence tests enforce that speed cannot change the canonical record set.
