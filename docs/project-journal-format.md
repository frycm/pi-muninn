# Logical project journal format

> **Phase 3 target; not yet implemented.** The current release writes the
> [Markdown journal format](journal-format.md). Migration preserves its stable IDs and
> provenance while moving records into this format.

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
  "remote": null
}
```

The project ID is immutable. The display name may change. A remote is set only through a
user-level command; checked-in project configuration cannot select a store path or remote.

Project and member IDs are UUIDs stored in the user-owned project registry. The host UUID is
kept in the agent-owned host identity file. Display names are local metadata and do not
rewrite old records.

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

1. builds and validates the complete record outside the lock;
2. redacts bounded free-text fields;
3. verifies project, member and host identity;
4. acquires the store lock;
5. verifies that the selected shard belongs to this member/host;
6. appends the encoded line with one write and flushes it;
7. flushes a newly created shard directory where supported; and
8. releases the lock.

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
4. label trust relative to the local member;
5. apply explicit filters;
6. rank exact IDs, user corrections, cue/body matches, recency and Git proximity using fixed
   documented weights; and
7. return bounded results with stable IDs.

The index is an acceleration of this projection, never an alternative source. Deleting
`.index/` and scanning the journal must produce the same filtered record set.

Human `--json` output wraps records with query metadata but does not alter the record objects:

```json
{
  "schema": 1,
  "query": "postgres migration",
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
only on the originating host. The unavailable detail is reported explicitly.

## Git synchronization

Synchronization commits only `project.json`, `migration.json` and journal shards. Per-writer
paths make ordinary pulls additive. Manifest conflicts, ID collisions and host-ownership
violations stop the operation for attended resolution.

The code repository remote is never used as journal identity. It may be shown as a linking
hint, but only explicit user action connects a local project UUID to a shared journal remote.

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
