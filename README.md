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
> Phase 3 is planned, not implemented. The cleaned foundation currently writes per-checkout
> Markdown journals and exposes explicit `memory_search`, `memory_read` and `memory_note`
> tools. It does not inject journal content into model prompts. Phase 3 replaces the
> checkout-scoped format with one JSONL journal for the logical project and adds the human
> and team interfaces described below.

The current Markdown contract is [docs/journal-format.md](docs/journal-format.md). The Phase
3 target format is [docs/project-journal-format.md](docs/project-journal-format.md), and the
implementation sequence is [docs/phase-3-plan.md](docs/phase-3-plan.md).

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

The repository keeps the parts needed for Phase 3:

- provenance-aware capture of explicit notes, direct user corrections and bounded outcomes;
- append-only Markdown journal files with crash-safe writes and secret redaction;
- lexical indexing over journal entries and claims;
- explicit model search, read and note tools;
- attended status, note, promote, search, reindex and sync commands;
- per-host journal paths, store locking and reviewable Git synchronization.

The current project store is resolved from the checkout top-level, so linked worktrees use
different project stores. Phase 3 fixes that identity boundary and migrates the records.

Current model tools:

| Tool | Purpose |
|---|---|
| `memory_search` | Search active global and checkout-scoped journals. |
| `memory_read` | Read an entry, claim, journal file or referenced local pi transcript. |
| `memory_note` | Append an agent-authored note. |

Current attended commands:

```text
/muninn
/muninn note [--global] TEXT
/muninn promote ID
/muninn search [--limit N] QUERY
/muninn scope
/muninn reindex
/muninn sync [--no-push]
```

Current headless commands:

```text
muninn status [--scope global|project]
muninn sync [--scope global|project] [--no-push]
```

## Phase 3 target

### One logical project across worktrees

A Git worktree is a checkout, not a project identity. Phase 3 resolves a logical project in
this order:

1. an explicit mapping in the user-owned Muninn registry;
2. the canonical `git rev-parse --git-common-dir` shared by linked worktrees;
3. a newly minted local project UUID for an unregistered Git common directory or non-Git
   root.

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

Phase 3 renames and narrows the model surface around the journal:

```ts
journal_search({
  query: string,
  project?: string,
  type?: string[],
  source?: string[],
  member?: string,
  branch?: string,
  path?: string,
  since?: string,
  until?: string,
  limit?: number
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
  tags?: string[]
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

muninn search QUERY [FILTERS] [--json]
muninn show ID [--relations] [--json]
muninn sessions [FILTERS] [--json]
muninn tail [FILTERS] [--follow] [--json]
muninn correct ID TEXT
muninn annotate ID TEXT
muninn path
```

Machine-readable output is stable enough for direct composition:

```bash
muninn search "database migration" --json | jq -r '.records[] | [.at, .id, .summary] | @tsv'
muninn sessions --branch feature/auth --json | jq '.sessions[] | select(.status == "failed")'
rg -n '"type":"correction"' "$(muninn path)"/journal
muninn search "timeout" --json | jq -r '.records[].id' | fzf
```

Interactive polish may use a fuzzy finder when available, but raw JSONL and deterministic CLI
output remain first-class interfaces.

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
      "global": true,
      "project": "auto"
    },
    "sync": {
      "remote": null,
      "onShutdown": true
    },
    "capture": {
      "corrections": true,
      "outcomes": true
    }
  }
}
```

Project settings are tighten-only. They may disable behavior but cannot name a sync remote or
re-enable a globally disabled capability. Phase 3 will add identity and query settings only
where user-owned registry state is insufficient.

## Roadmap

### Phase 1 — foundation

Implemented and retained: append safety, provenance, redaction, lexical journal indexing,
explicit tools, session pointers, store locking and Git sync. The implemented format is
temporary migration input, not the final project-journal layout.

### Phase 3 — logical project journal

Resolve linked worktrees to one project UUID, introduce the sharded JSONL schema, migrate
existing journal entries, capture deterministic Git provenance, add user correction
relations, and ship model/human/Unix query interfaces over one service.

### Phase 4 — distributed team journal

Make project UUID linking and member identity usable across machines, harden per-host Git
sync, show trust boundaries, and define conflict behavior for concurrent or competing
corrections. Transcript exchange remains opt-in and separate from the journal.

### Phase 5 — retrieval quality and scale

Measure lexical retrieval on real project histories, add rebuildable full-text and fuzzy
indexes, improve filters and ranking, and consider local embeddings only if evaluation shows
a material benefit. Raw JSONL scanning remains the correctness baseline.

### Phase 6 — integrations

Add optional remote-session and sandbox integrations where the core journal contract is not
enough, including explicit encrypted transcript exchange if teams need it. Integrations must
not make the plain-file local workflow secondary.

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
