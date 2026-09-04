# Logical project journal format

> **Normative and implemented through Phase 6.** The legacy
> [Markdown journal format](journal-format.md) remains readable only as migration input.

The logical project journal is an append-only, sharded JSONL event stream. It records bounded
session history and enough project/Git provenance to interpret that history from another
worktree or host. It is historical evidence, not project instruction and not a copy of pi's
full transcript.

## Store layout

```text
<agent-dir>/muninn-projects/<project-id>/
├── project.json
├── journal/
│   └── <member-id>/<host-id>/<YYYY-MM>.jsonl
├── migration.json
├── .index/
├── .lock
├── .lock.json
├── .gitignore
└── .git/
```

All shards together form one logical journal. Each member/host pair owns its path and appends
only there. Monthly shards bound scan and diff size without requiring writers to coordinate.

`project.json`, `migration.json` and journal shards are durable. `.index/`, locks and
temporary files are derived local state and are not committed.

Imported transcript exchange copies live outside this Git store at
`<agent-dir>/muninn-transcripts/<project-id>/<record-id>.jsonl`. They are optional,
user-local evidence and never become canonical journal content.

## Encoding rules

- UTF-8 without a byte-order mark.
- Exactly one JSON object per terminated line.
- Canonical writers emit one trailing newline and no insignificant whitespace.
- Object key order is stable for readable Git diffs but has no semantic meaning.
- Record IDs are `j-` followed by a full UUIDv7.
- Timestamps are UTC RFC 3339 with millisecond precision.
- A line is at most 64 KiB after UTF-8 encoding.
- Arbitrary prompt, transcript and tool payloads are not allowed.
- Multiline body text uses ordinary JSON string escaping.

A reader handles damage locally:

- ignore and report a final unterminated line as an interrupted append;
- report and skip a malformed terminated line;
- report and skip an unsupported schema or record type;
- continue with later valid lines and other shards.

## Project manifest

`project.json` is formatted JSON because it is a single attended manifest:

```json
{
  "schema": 1,
  "project": "019c0111-1c2f-7d33-8e55-aa10b2c3d4e0",
  "name": "pi-muninn",
  "created_at": "2026-08-30T11:32:04.000Z",
  "remote": "ssh://git.example/team/pi-muninn-journal.git",
  "members": [
    {"id": "019c0112-1c2f-7d33-8e55-aa10b2c3d4e0", "name": "martin"}
  ],
  "hosts": [
    {"id": "019c0113-1c2f-7d33-8e55-aa10b2c3d4e0", "name": "mbp", "member": "019c0112-1c2f-7d33-8e55-aa10b2c3d4e0"}
  ],
  "team_events": [
    {
      "id": "t-019c0114-1c2f-7d33-8e55-aa10b2c3d4e0",
      "at": "2026-09-04T10:00:00.000Z",
      "kind": "host-renamed",
      "member": "019c0112-1c2f-7d33-8e55-aa10b2c3d4e0",
      "actor_member": "019c0112-1c2f-7d33-8e55-aa10b2c3d4e0",
      "actor_host": "019c0113-1c2f-7d33-8e55-aa10b2c3d4e0",
      "host": "019c0113-1c2f-7d33-8e55-aa10b2c3d4e0",
      "name": "workstation",
      "reason": "preferred display name"
    }
  ]
}
```

The project ID is immutable. Member and host arrays are sorted unions keyed by immutable
UUIDs. A host belongs to exactly one member; an ID observed with different metadata is a
collision. The remote is set only through `muninn project remote`; checked-in code-project
configuration cannot select a journal store path or remote.

Project and member IDs are UUIDs stored in the user-owned project registry. The host UUID is
kept in the agent-owned host identity file. Display names are projected metadata and do not
rewrite old records. Names and lifecycle reasons are bounded and reject terminal controls,
direction-changing characters and credential-shaped text.

### Team lifecycle events

`team_events` is optional in schema 1 for compatibility with pre-Phase-4 manifests; readers
project a missing field as an empty array. Once emitted, events are union-merged by immutable
ID and sorted by `(at, id)`. A non-identical duplicate ID is a collision.

Kinds are `member-renamed`, `member-retired`, `member-restored`, `host-renamed`,
`host-retired` and `host-restored`. Rename events require `name`; host events require `host`;
`reason` is optional. The actor host must belong to `actor_member`, the target member must be
the actor member, and a target host must belong to that member. This self-declaration rule
prevents accidental cross-member administration but is not cryptographic authentication.

Projection starts from the base member/host arrays and applies events in canonical order.
Retirement is advisory: records remain searchable and writable, while current roster state
adds `retired-member` or `retired-host` labels. Records written during a retired interval
produce a diagnostic warning.

## Record shape

An outcome record serialized as its actual one-line representation:

```json
{"schema":1,"id":"j-019c0123-7f2a-7a10-9c44-2d6e0f1a8b01","at":"2026-08-30T11:32:04.000Z","type":"outcome","project":"019c0111-1c2f-7d33-8e55-aa10b2c3d4e0","member":"019c0112-1c2f-7d33-8e55-aa10b2c3d4e0","host":"019c0113-1c2f-7d33-8e55-aa10b2c3d4e0","source":"agent","channel":"tui","task":"019c0114-1c2f-7d33-8e55-aa10b2c3d4e0","status":"completed","body":"The Phase 3 documentation now defines one journal shared across linked worktrees.","cue":"when implementing logical project identity","tags":["docs","phase-3"],"paths":["README.md","docs/phase-3-plan.md"],"relations":[],"session":{"file":"~/.pi/agent/sessions/--src-pi-muninn--/2026-08-30_019c0114.jsonl","first":"e-104","last":"e-138"},"git":{"worktree":"/src/pi-muninn-phase-3","cwd":"/src/pi-muninn-phase-3","branch":"feature/phase-3","head":"c3390cf3d43178b8b802b2da5fff691375fa390a","dirty":true}}
```

### Required fields

| Field | Meaning |
|---|---|
| `schema` | Integer record schema, exactly `1` for this contract. |
| `id` | Globally unique, time-sortable journal record ID. |
| `at` | Time the complete record was appended. |
| `type` | `outcome`, `checkpoint`, `note`, `correction` or `import`. |
| `project` | Logical project UUID matching the manifest. |
| `member` | Member identity responsible for the originating host. |
| `host` | Writer identity and shard owner. |
| `source` | `user`, `agent`, `tool`, `external` or `mixed`. |
| `channel` | `tui`, `rpc`, `sdk`, `hook`, `cli` or `unknown`. |
| `body` | Bounded, self-contained record text. |
| `tags` | Deduplicated strings in first-seen order; may be empty. |
| `paths` | Project-relative affected paths; may be empty. |
| `relations` | Typed links to other journal IDs; may be empty. |

### Optional fields

| Field | Meaning |
|---|---|
| `task` | Pi task/session group. |
| `continues` | Earlier task that this record continues. |
| `status` | `completed`, `partial`, `failed`, `cancelled` or `unknown`. |
| `cue` | Situation in which this record may be useful. |
| `session` | Local transcript path and optional first/last entry IDs. |
| `git` | Worktree, cwd, branch, head commit and dirty flag observed at capture time. |
| `integration` | Bounded external producer provenance and its idempotency key. |
| `legacy` | Migration origin and fields not represented directly in schema 1. |
| `redacted` | `true` when mandatory secret scanning changed free text. |

Unknown fields are returned under an extension view by readers and preserved by migrations.
Writers emit only fields defined by the schema version they claim.

### Record types

- `outcome`: bounded account of completed work, generated by the session model and labelled
  `source: agent` unless all body text is directly user-authored;
- `checkpoint`: partial or failed work captured at a lifecycle boundary;
- `note`: an explicit user, agent, tool or external observation;
- `correction`: a direct user correction or annotation linked to earlier records;
- `import`: a migrated Markdown record whose original source is retained.

Deterministic fields such as IDs, paths, Git refs, status and transcript pointers are filled
by code. A summarizing model cannot supply or override them.

### Integration provenance

An optional external observation has `source: "external"` and an `integration` object:

```json
{"provider":"pi-enclave","kind":"sandbox-audit","event":"audit-checkpoint","external_id":"session-42:8:sha256:...","observed_at":"2026-09-04T12:00:00.000Z","metadata":{"records":8,"violations":0,"chain":"verified"}}
```

`provider`, `kind` and `event` are lowercase integration identifiers of at most 64
characters. `external_id` is a non-empty producer identifier of at most 512 characters;
the pair `(provider, external_id)` is the append-time idempotency key. `observed_at` is UTC
RFC 3339 with millisecond precision. `metadata` is a flat map of at most 32 bounded string,
number, boolean or null values and at most 8 KiB when encoded. String metadata passes through
the same mandatory redaction as other journal text.

An identical replay returns the existing record. Reusing the key for different canonical
observation content is refused under the store lock. Integration authority cannot create
corrections, imports, relations or `source: "user"` records. The `integration` query filter
selects providers explicitly; provenance does not silently alter ranking or trust.

## Corrections and relations

A correction is another immutable journal record:

```json
{"schema":1,"id":"j-019c1000-1111-7000-8000-000000000001","at":"2026-08-30T15:42:00.000Z","type":"correction","project":"019c0111-1c2f-7d33-8e55-aa10b2c3d4e0","member":"019c0112-1c2f-7d33-8e55-aa10b2c3d4e0","host":"019c0113-1c2f-7d33-8e55-aa10b2c3d4e0","source":"user","channel":"cli","body":"The service now uses PostgreSQL 17; the PostgreSQL 16 record is stale.","tags":[],"paths":[],"relations":[{"type":"corrects","target":"j-019c0000-1111-7000-8000-000000000001"}]}
```

Each relation has exactly `type` and `target`. Initial types are:

| Relation | Meaning |
|---|---|
| `corrects` | The target is mistaken or stale in the way described by this record. |
| `supersedes` | Prefer this user-authored record for the subject it explicitly states. |
| `annotates` | Add context without disputing the target. |

Relations do not edit, delete or physically hide their targets. A query projection may label
a target as corrected and rank its user-authored correction first. It must still make the
original and complete relation chain available. Two unrelated corrections of the same target
are a visible conflict; timestamp order alone does not decide which claim is true.

An active branch is one not targeted by a `supersedes` relation. `muninn resolve` appends one
user correction with `corrects TARGET` and `supersedes BRANCH` for every active branch it
observed under the append lock. Those supersession edges retire branches; they are not
additional independent claims about each branch. The inbox closes when one active branch
remains, reopens after a later independent correction, and exposes concurrent resolutions as
competing active branches.

Only these paths may create `source: "user"` corrections:

- an attended `/muninn correct|annotate` command;
- the headless CLI invoked directly by a user; or
- an authenticated API call whose caller identity is the user.

A model-facing tool cannot set the source or write a user correction. It may append an
agent-authored note with a relation or return proposed text for user confirmation.

There is no automatic stale-data classifier, age threshold or maintenance process that
changes record state. Corrective meaning enters the journal only through an explicit record.

## Append and concurrency protocol

For one append the writer:

1. validates the requested writer authority and relation shape;
2. acquires the store lock;
3. builds the complete record and redacts bounded free-text fields;
4. verifies that an existing ID has identical canonical bytes;
5. appends to the selected member/host shard with one write and flushes it;
6. flushes a newly created shard directory where supported; and
7. releases the lock.

Two linked worktrees on one host share a store and lock. Two hosts write different shard
paths. If synchronized data shows another writer appending under the local host ID, sync
stops and reports an identity collision.

Readers do not require the lock. A final unterminated line is invisible until its newline is
durable.

## Canonical query projection

Raw records are the source of truth. The canonical reader builds a deterministic projection:

1. validate and collect records from every shard;
2. de-duplicate identical IDs and report non-identical collisions;
3. resolve relation targets without changing either record;
4. project advisory lifecycle and active correction conflicts;
5. label trust relative to the local member;
6. apply explicit record, projected trust and lifecycle/conflict filters;
7. rank exact IDs, phrases, exact/prefix/conservative one-edit tokens, term coverage, user
   corrections, deterministic recency and Git proximity using fixed weights; and
8. return bounded stable IDs with an optional component-level explanation.

The index is an acceleration of this projection, never an alternative source. Deleting
`.index/` and scanning the journal must produce the same filtered record set.
The current local index is schema 2 (`.index/journal-v2.json`), tagged with its text analyzer.
It stores canonical-record hashes and derived terms; exact, trigram and conservative bigram
candidate postings are rebuilt in memory. Schema 1, damaged and term-mismatched indexes are
discarded and regenerated from JSONL. Index bytes are deterministic for the same canonical
records.

Human `--json` output wraps records with query metadata but does not alter the record objects:

```json
{
  "schema": 1,
  "query": {"query": "postgres migration", "explain": true},
  "records": [],
  "warnings": []
}
```

## Transcript pointers

`session.file` points to pi's local JSONL and is not synchronized as journal content. The
optional `first` and `last` IDs bound the supporting range. Readers may follow the pointer
only when:

1. a valid journal record supplied it;
2. the canonical file is inside an allowed pi sessions root; and
3. the file is available on the current host.

A teammate can search and read the bounded journal record even when its transcript exists
only on the originating host. An explicit `age` import may install a verified local copy
under the agent directory without changing `session.file`. Read results distinguish
`original`, `exchange` and `missing`; `muninn show` returns exit code `3` only for `missing`
while still emitting the record.

## Git synchronization

Synchronization commits only `project.json`, `migration.json` and journal shards. Integration
records use those same shards; transcript exchange files never enter this allowlist. Per-writer
paths make ordinary pulls additive. Manifest reconciliation union-merges member, host and
team-event additions. Incompatible remotes, identity/event collisions and host-ownership
violations stop the operation for attended resolution.

The code repository remote is never used as journal identity. It may be shown as a linking
hint, but only explicit user action connects a local project UUID to a shared journal remote.

See [operations.md](operations.md) for team onboarding, migration and recovery procedures.

## Markdown migration

Migration is additive and restartable:

1. scan complete valid Markdown entries;
2. convert each to an `import` record using the existing `j-` ID;
3. derive `at` from the UUIDv7;
4. retain source, channel, task, continuation, session, phase, cue, body, claims, redaction and
   promotion data;
5. record the old store/path in `legacy`;
6. write only missing IDs to the importing host's shard; and
7. write `migration.json` with source fingerprints and counts.

The old store stays unchanged. The project registry switches to the new store only after
validation succeeds and the user confirms the mapping. Re-running migration against the same
input is byte-stable and appends nothing.

## Schema evolution

- Additive optional fields require reader support before writers emit them.
- A changed meaning, required field or relation rule increments `schema`.
- Readers never guess the meaning of a newer schema.
- A migration writes new records or a new store generation; it never edits existing journal
  lines in place.
