# Markdown journal format

> **Legacy migration input.** Current versions write the
> [logical-project JSONL format](project-journal-format.md). This grammar remains readable so
> migration can preserve every valid record and stable ID.

This was the legacy journal source from which its lexical index was rebuilt.
`src/journal/format.ts` implements this grammar and `test/unit/journal-format.test.ts` is its
executable copy.

## Store layout

```text
<store>/journal/<host-id>/<YYYY-MM-DD>.md
```

- `<host-id>` is the machine's UUIDv7 registration from `store.md`.
- The date is the writer's local calendar date and exists only for filing.
- The UUIDv7 encoded in an entry ID is the authoritative creation timestamp.
- Files outside a valid host/date path are ignored by the journal reader.
- Text before the first entry heading is ignored as a human preamble.

Per-host paths keep two synchronized hosts from appending to the same file. A local store
lock serializes sessions on one host.

## Entry grammar

```markdown
## 14:32 · j-0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01
source: user
channel: tui
task: 0198f2b0-1111-7000-8000-000000000001
session: ~/.pi/agent/sessions/--src-app--/0198f2b0.jsonl#e5f6g7h8
phase: test
cue: when vitest hangs in CI

The user corrected an earlier assumption while the CI job hung.

- Run `pnpm test --run`; vitest watch mode hangs the CI job.
- The CI runner has no TTY, which is why watch mode never exits.

```

An entry contains, in order:

1. one heading;
2. a flat metadata block;
3. an optional prose context block;
4. zero or more claim bullets; and
5. a terminating blank line.

### Heading and IDs

```text
## <HH:MM> · j-<UUIDv7>
```

`HH:MM` is local display time. IDs are written in full. A claim is addressed by appending its
one-based ordinal to the entry ID, for example `j-<UUIDv7>.2`. An entry with prose and no
bullets exposes that prose as one implicit claim at `.1`; an entirely empty body exposes no
claim.

### Metadata

Every metadata line is `key: value`. The required and implemented fields are:

| Field | Required | Values or shape | Meaning |
|---|---:|---|---|
| `source` | yes | `user`, `agent`, `tool`, `external` | Origin of the assertion. |
| `channel` | no | `tui`, `rpc`, `sdk`, `hook` | Interface through which it arrived. |
| `task` | no | pi task/session ID | Groups records from one task. |
| `continues` | no | prior task ID | Connects resumed or forked work. |
| `session` | no | `<session-file>#<entry-id>` | Pointer to detailed local evidence. |
| `phase` | no | `locate`, `reproduce`, `fix`, `test`, `review`, `ops`, `other` | Coding/operations step. |
| `cue` | no | one line of text | Situation in which this history may help. |
| `promoted_from` | no | `<project>/<entry-id>` | Origin of a copy placed in the global journal. |
| `redacted` | no | `true` | Secret scanning changed free text before append. |

An unreadable ID or missing/unknown `source` invalidates the entry. Unknown `channel` and
`phase` values are reported while the remainder stays readable. Unknown metadata keys are
preserved in `extra` and written back unchanged so an older reader does not destroy a field
introduced by a newer writer.

### Prose and claims

Prose is contextual narrative. Claims are the bullet lines indexed independently and
addressed by ordinal. Reading either returns the whole entry context.

A bullet continuation is indented by at least two spaces. When prose contains a Markdown
heading or bullet at column zero, the writer adds one guard space and the reader removes it;
this prevents quoted Markdown from changing the record structure on a round trip.

## Append protocol

For each record the writer:

1. mints the UUIDv7 entry ID;
2. redacts secrets from prose, claims and cue;
3. formats the complete block including its blank-line terminator;
4. acquires the store lock;
5. creates the host/day path if needed;
6. appends the entire block with one write and flushes the file;
7. best-effort flushes the directory when creating a new daily file; and
8. releases the lock.

IDs are minted before acquiring the lock. They are unique and time-bearing but readers do
not assume file order is a total ID order.

If an older interrupted append left the file without a final newline, the next writer first
adds a newline. It never guesses how to repair the damaged block.

## Reader behavior

A conforming reader:

1. splits a daily file at lines beginning with `## `;
2. treats a final block without its terminating blank line as incomplete;
3. reports and excludes only that incomplete block;
4. reports and skips a block with an invalid entry ID or source;
5. retains a readable entry when an optional enum is unknown;
6. preserves unknown metadata; and
7. never lets damage in one entry hide earlier complete entries.

## Redaction and trust

Redaction is mandatory at the append boundary, not optional at call sites. It applies only to
free text. Task IDs, session pointers and entry IDs are never altered because doing so would
break evidence resolution. A changed record carries `redacted: true`.

`source: user` is reserved for text the user directly supplied. Model-generated records use
`source: agent` even when they summarize a user session. The journal is historical evidence;
it does not override the current repository, configuration, tests or explicit instructions.

## Migration to the current journal

Migration reads only complete valid entries and preserves:

- the entry ID and its UUIDv7 timestamp;
- source and channel;
- task, continuation and session pointers;
- phase, cue, prose and claims;
- redaction and promotion provenance; and
- unknown fields under migration extensions.

The source files remain unchanged until the user verifies and explicitly switches the
project mapping to the new store. Re-running migration must create no duplicate records.
