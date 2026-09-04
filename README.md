# pi-muninn

**Searchable project history for [pi](https://github.com/earendil-works/pi).**

Muninn records bounded, provenance-rich history from pi sessions and makes the resulting
project journal searchable by models, people and ordinary Unix tools. The repository remains
the source of truth for code, configuration and documentation. The journal explains how it
got there: what was attempted, why a decision was made, what failed and which session holds
the detailed evidence.

The design is local-first and composable: append-only JSONL, Git synchronization, explicit
retrieval and no hosted service in the storage or search path.

> [!IMPORTANT]
> Phases 3 and 4 are implemented. Linked worktrees and team clones share one sharded JSONL
> project journal with validated onboarding, advisory lifecycle declarations, explicit
> conflict resolution and read-only diagnostics. Automatic capture, model tools, attended
> commands and Unix interfaces all use the same canonical service. Journal content is never
> injected into prompts.

The legacy Markdown migration-input contract is
[docs/journal-format.md](docs/journal-format.md). The JSONL contract is
[docs/project-journal-format.md](docs/project-journal-format.md), and the implementation
sequence is [docs/phase-3-plan.md](docs/phase-3-plan.md).
The implemented identity and registry contract is
[docs/project-registry.md](docs/project-registry.md). Team onboarding, migration and recovery
are covered by [docs/operations.md](docs/operations.md). The implemented Phase 4 contract is
[docs/phase-4-plan.md](docs/phase-4-plan.md).

## Why a project journal

For development and system administration, current truth already has better homes:

- code and configuration say what the system does;
- tests say which behavior is required;
- documentation and project instructions say how it should be used;
- Git says exactly what changed.

A generated secondary knowledge base would compete with those sources and could silently
become stale. A journal has a narrower, more useful role: retain the history and provenance
that the repository does not express well.

This leads to three rules:

1. Journal records are historical evidence, never implicit instructions.
2. Models retrieve history only when they decide it is relevant.
3. Stale or mistaken history is corrected by appending a user-authored record that points to
   the original. Routine operation never rewrites or silently hides evidence.

## Current foundation

The repository now includes:

- a validated, canonically serialized, append-only JSONL record contract;
- writer-owned member/host/month shards with single-write, fsync-backed appends;
- restartable and idempotent import of legacy Markdown stores;
- correction, supersession and annotation graphs with explicit trust labels;
- one bounded canonical query service with a disposable lexical candidate index;
- explicit model search, read, context and note tools;
- a user-owned logical-project registry with atomic updates and stable member/project UUIDs;
- canonical Git common-directory resolution across linked worktrees;
- automatic user-cue and agent-outcome capture into the same JSONL contract; and
- explicit project remotes, member/host ownership validation and additive multi-clone sync;
- validated, rollback-safe `project share` and `project join` onboarding;
- an additive team-event stream with deterministic active/retired roster projection;
- a bounded active-conflict inbox and explicit append-only resolution records; and
- a read-only doctor for registry, store, Git, manifest, shard, lifecycle, relation and
  disposable-index health.

The project store is now `<agent-dir>/muninn-projects/<project-id>/`. Checkout roots, Git
common directories and paths are registry aliases or provenance, never durable identity.

Current model tools:

| Tool | Purpose |
|---|---|
| `journal_search` | Search this logical project's journal with bounded filters and pagination. |
| `journal_read` | Read one record by stable ID with a bounded relation neighborhood. |
| `journal_context` | Batch records already selected by stable ID under a hard output budget. |
| `journal_note` | Append an agent-authored note or annotation; never a user correction. |

Current attended commands:

```text
/muninn
/muninn search QUERY [FILTERS]
/muninn show ID [--relations]
/muninn sessions [FILTERS]
/muninn tail [FILTERS]
/muninn note TEXT
/muninn correct ID TEXT
/muninn annotate ID TEXT
/muninn conflicts
/muninn project
/muninn team
/muninn reindex
/muninn sync [--no-push]
```

Current headless commands:

```text
muninn search QUERY [FILTERS] [--json|--jsonl]
muninn show ID [--relations] [--json|--jsonl]
muninn sessions [FILTERS] [--json|--jsonl]
muninn tail [FILTERS] [--follow] [--jsonl]
muninn note TEXT [--json]
muninn correct ID TEXT [--json]
muninn annotate ID TEXT [--json]
muninn conflicts [--json|--jsonl]
muninn resolve TARGET TEXT [--json]
muninn path
muninn project link [PATH] [--id UUID] [--name NAME] [--force]
muninn project show [PATH]
muninn project unlink [PATH]
muninn project remote [URL|--remove]
muninn project share [PATH] [--json]
muninn project join JOURNAL-URL [PATH] [--force] [--json]
muninn team list [--json]
muninn team rename-member NAME [--reason TEXT] [--json]
muninn team rename-host HOST-ID NAME [--reason TEXT] [--json]
muninn team retire-host|restore-host HOST-ID [--reason TEXT] [--json]
muninn team leave|return [--reason TEXT] [--json]
muninn migrate [--dry-run] [--json]
muninn reindex [--json]
muninn status [--json]
muninn sync [--no-push]
muninn doctor [--json]
```

`project show` and `/muninn project` display the project UUID, member UUID, store, aliases and
the resolver reason. `project remote` reads or changes the explicit journal Git remote.
`unlink` removes the local mapping, not the store or retained project record. See the
[registry contract](docs/project-registry.md) for relinking and the
[operations guide](docs/operations.md) for joining a team journal.

## Phase 3 design

### One logical project across worktrees

A Git worktree is a checkout, not a project identity. The implemented resolver selects a
logical project in this order:

1. an explicit mapping in the user-owned Muninn registry;
2. the canonical `git rev-parse --git-common-dir` shared by linked worktrees;
3. a newly minted local project UUID for an unregistered Git common directory or non-Git
   root.

A committed `.pi/muninn-project.json` may suggest a UUID to an explicit `muninn project link`
command. Automatic and untrusted sessions ignore it; it cannot choose a path or remote.

The checkout root, working directory, branch and commit remain on each record as provenance.
They do not choose the store. Two concurrent pi sessions in linked worktrees therefore append
to different writer-owned shards of the same logical journal and can search each other's
completed records.

### Append-only JSONL

The logical journal is sharded by member, host and month:

```text
<agent-dir>/muninn-projects/<project-id>/
├── project.json
├── journal/
│   └── <member-id>/<host-id>/<YYYY-MM>.jsonl
├── migration.json
├── .index/
└── .git/
```

Each terminated line is one immutable record. Sharding avoids ordinary append conflicts
between hosts while keeping the whole store easy to clone, inspect and synchronize. The
index is disposable; a canonical scan of JSONL is always sufficient to rebuild it.

The journal is intentionally not a copy of pi's session file. A record contains a bounded
outcome or note, deterministic Git/worktree provenance and a pointer to the local transcript.
This preserves a useful team history without publishing every prompt, tool result or secret.

### Explicit model interface

Phase 3 narrows the implemented model surface around the journal:

```ts
journal_search({
  query?: string,
  ids?: string[],
  type?: string[],
  source?: string[],
  member?: string[],
  host?: string[],
  branch?: string[],
  path?: string[],
  tag?: string[],
  status?: string[],
  since?: string,
  until?: string,
  relatedTo?: string,
  limit?: number,
  cursor?: string
})

journal_read({
  id: string,
  relationDepth?: number
})

journal_context({
  ids: string[],
  maxChars?: number
})

journal_note({
  text: string,
  cue?: string,
  tags?: string[],
  paths?: string[],
  relations?: Array<{ type: "annotates", target: string }>
})
```

`journal_search` returns bounded summaries and stable IDs. `journal_read` expands a record,
its provenance and its correction chain. `journal_context` is an optional batching tool for
the records a model has already chosen; it is not an automatic prompt hook. `journal_note`
can write agent-authored observations, but it cannot claim user authority.

### Human and Unix interface

The same query service backs the model tools, attended commands and headless CLI:

```text
/muninn search QUERY
/muninn show ID
/muninn sessions [FILTERS]
/muninn tail [FILTERS]
/muninn correct ID TEXT
/muninn annotate ID TEXT
/muninn conflicts
/muninn team

muninn search QUERY [FILTERS] [--json]
muninn show ID [--relations] [--json]
muninn sessions [FILTERS] [--json]
muninn tail [FILTERS] [--follow] [--json]
muninn correct ID TEXT
muninn annotate ID TEXT
muninn conflicts [--json|--jsonl]
muninn resolve TARGET TEXT [--json]
muninn path
muninn project remote [URL|--remove]
muninn team list [--json]
muninn doctor [--json]
```

Machine-readable output is stable enough for direct composition:

```bash
muninn search "database migration" --json | jq -r '.records[] | [.at, .id, .snippet] | @tsv'
muninn sessions --branch feature/auth --json | jq '.sessions[] | select(.status == "failed")'
rg -n '"type":"correction"' "$(muninn path)"/journal
muninn search "timeout" --json | jq -r '.records[].id' | fzf
```

Interactive polish may use a fuzzy finder when available, but raw JSONL and deterministic CLI
output remain first-class interfaces.

`muninn show` returns exit code `3` when its record is available but the referenced transcript
is not present on this machine. JSON output still includes the record plus transcript
availability metadata.

### User-authored corrections

Corrections are ordinary append-only records with explicit relations:

```json
{"schema":1,"id":"j-019c1000-1111-7000-8000-000000000001","at":"2026-08-30T15:42:00.000Z","type":"correction","project":"019c0111-1c2f-7d33-8e55-aa10b2c3d4e0","member":"019c0112-1c2f-7d33-8e55-aa10b2c3d4e0","host":"019c0113-1c2f-7d33-8e55-aa10b2c3d4e0","source":"user","body":"The service now uses PostgreSQL 17; the earlier PostgreSQL 16 note is stale.","relations":[{"type":"corrects","target":"j-019c0000-1111-7000-8000-000000000001"}]}
```

Supported relations initially are:

- `corrects`: the target contains a mistake or is stale;
- `supersedes`: this user-authored record should be preferred for the stated subject;
- `annotates`: adds context without disputing the target.

The original line remains physically present and searchable. Query projections label the
relationship and may prefer the newest user correction, but they never pretend the earlier
record did not exist. Competing corrections are shown as a conflict rather than resolved by
timestamp alone.

Only direct attended user actions and authenticated user API calls may create
`source: "user"` correction records. A model may propose correction text or append an
agent-authored note; it cannot forge the user's authority.

There is no background policy that decides which history is stale, no age-based removal and
no automatic mutation of the journal. Corrections happen because a user identifies something
that needs correcting.

## Pi extension fit

The design follows pi's extension model without requiring a core fork:

- session and agent lifecycle events provide capture boundaries;
- tools provide explicit, bounded model access;
- slash commands provide an attended user surface;
- the standalone binary provides automation and Unix composition;
- pi session pointers preserve detailed evidence locally;
- extension-owned stores and indexes keep project repositories clean.

The journal is useful even when no model is running. Its storage contract is plain files,
its sync transport is Git and its canonical query path is deterministic lexical search.

## Trust and privacy

- Code, docs, config and explicit project instructions outrank journal history.
- Every record carries source, member, host, session and Git/worktree provenance when known.
- Teammate records retain their original source but are labelled relative to the reader.
- Lifecycle declarations are unsigned and advisory: retirement labels records but neither
  hides them nor revokes Git access.
- Secrets are redacted before append; records marked as redacted remain visibly so.
- Full pi transcripts are local evidence and are not synchronized by default.
- A project checkout cannot silently select an arbitrary journal path or sync remote.
- Search results are data, not prompt instructions, and are bounded before reaching a model.

## Settings

The current foundation reads the `muninn` object from pi's settings:

```json
{
  "muninn": {
    "scopes": {
      "project": "auto"
    },
    "sync": {
      "onShutdown": true
    },
    "capture": {
      "corrections": true,
      "outcomes": true
    }
  }
}
```

Project settings are tighten-only. They may disable behavior but cannot re-enable a globally
disabled capability. Identity is not a project setting: only the user-owned registry can
choose a project UUID or store. The journal remote is explicit user-owned `project.json`
metadata changed by `muninn project remote`, not a settings field.

## Roadmap

### Phase 1 — foundation

Implemented and retained as migration/safety foundations: append safety, provenance,
redaction, explicit retrieval, session pointers, store locking and Git sync. The Phase 1
Markdown format is now migration input only.

### Phase 3 — logical project journal

Complete: logical project UUID resolution, linked-worktree discovery, member/host identity,
sharded JSONL, restartable migration, user corrections, deterministic provenance,
model/human/Unix query interfaces and explicit multi-clone Git synchronization.

### Phase 4 — team operations and governance

Complete: validated share/join commands, deterministic roster projection, shell-only local
member/host lifecycle declarations, attended read-only team/conflict views, an explicit
correction-conflict resolution flow and a read-only operational doctor. Signed identity or
enforceable revocation remains out of scope until real team use justifies its key-management
cost. See the [Phase 4 plan](docs/phase-4-plan.md).

### Phase 5 — retrieval quality and scale

Measure lexical retrieval on real project histories beyond the Phase 3 10,000-record budget,
improve query explanation, filters and ranking, and consider local embeddings only if
evaluation shows a material benefit. Raw JSONL scanning remains the correctness baseline.

### Phase 6 — integrations

Add optional remote-session and sandbox integrations where the core journal contract is not
enough, including explicit encrypted transcript exchange if teams need it. Integrations must
not make the plain-file local workflow secondary.

### Phase 7 — optional cryptographic governance

Only evidence from real distributed use should start this work. It requires a threat model,
member keys, rotation and recovery, signed records/events, remote ACL interaction and an
explicit policy for compromised-key history. Until then, lifecycle state stays honestly
advisory.

## Development

```bash
npm ci
npm run check
npm test
```

The supported baseline is `@earendil-works/pi-coding-agent >=0.84.2 <0.85.0`, Node
`>=22.19.0`, Git, MiniSearch and `proper-lockfile`.

Sibling projects are [pi-huginn](https://github.com/frycm/pi-huginn) for remote sessions and
voice, and [pi-enclave](https://github.com/frycm/pi-enclave) for sandbox-first automation.
Muninn can integrate with both but depends on neither.
