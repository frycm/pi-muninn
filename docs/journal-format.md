# The journal format

*Normative. This is the file format Muninn writes and promises to keep reading.*

The journal is the only thing capture writes and the only layer that is never derived, so
its grammar is the one contract every other part of Muninn — the index, recall, dreams,
sync — is built on. This document is the grammar; `src/journal/format.ts` is its
implementation and `test/unit/journal-format.test.ts` its executable copy. Where this
document and the code disagree, that is a bug in one of them, and the test suite decides
which.

Everything here is schema `1` (`store.md`'s `schema:` field). A Muninn that finds a higher
number refuses to touch the store.

## Where entries live

```
<store>/journal/<host id>/<YYYY-MM-DD>.md
```

- **Per host.** `<host id>` is this machine's UUIDv7, from `host.json`. Two machines never
  write the same file, which is what makes whole-store sync a rebase rather than a merge.
- **Per local day.** The date is the writer's local date, not UTC. It is a filing decision
  for humans; the authoritative timestamp of an entry is inside its id.
- Directories that are not host ids and files that are not `YYYY-MM-DD.md` are ignored in
  silence. A store is Muninn's, but a person may still leave a note in it.

Anything before the first `## ` heading in a daily file is not part of an entry and is
ignored — a store may carry a hand-written preamble.

## An entry

```markdown
## 14:32 · j-0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01
source: user
channel: tui
task: 0198f2b0-1111-7000-8000-000000000001
session: ~/.pi/agent/sessions/--Users-mfryc-src-app--/0198f2b0-….jsonl#e5f6g7h8
phase: test
cue: when vitest hangs in CI
recalled: j-0198e9a4-1c2f-7d33-8e55-aa10b2c3d4e0.1

Martin corrected an earlier assumption while the CI job hung.

- Run `pnpm test --run`; vitest watch mode hangs the CI job.
- The CI runner has no TTY, which is why watch mode never exits.

```

Four parts, in this order and no other: **heading**, **metadata**, **prose**, **claims**.

### The heading

```
## <HH:MM> · <entry id>
```

`HH:MM` is local time, for a human reading the file. It is *not* the authoritative
timestamp: the entry id is a UUIDv7, so the exact UTC milliseconds are recoverable from the
id itself — and no second field can disagree with it.

The id is `j-` followed by a UUIDv7 in full. Ids are never truncated in anything written to
a file, used as a key, or passed to a tool; elision is a rendering concern only.

### The metadata block

Every line from the heading to the first blank line is `key: value`. Flat — no nesting, no
lists of maps. That flatness is deliberate: it is what a 4B model emits reliably and what a
thirty-line parser reads without a YAML library.

| Field | Required | Values | Meaning |
|---|---|---|---|
| `source` | **yes** | `user` · `agent` · `tool` · `external` | Assertion origin. `user` is only text the user typed; `agent` is the model's own inference; `tool` is derived from tool output; `external` is fetched or repository content. |
| `channel` | no | `tui` · `rpc` · `sdk` · `hook` · `dream` | How the entry reached Muninn. Kept separate from `source` so "the user typed it in the TUI" and "an SDK script asserted it on their behalf" stay distinguishable. |
| `task` | no | pi session id | The task group the evaluate phase holds out. Every entry from one session shares it. |
| `continues` | no | task id | Set when a session was resumed or forked, so a multi-session task is one group. |
| `session` | no | `<file>#<entry id>` | Evidence pointer into pi's session tree. `memory_read` follows it. |
| `phase` | no | `locate` · `reproduce` · `fix` · `test` · `review` · `ops` · `other` | The step of the coding loop. Retrieval filters on it. |
| `cue` | no | free text | "When would I need this?" — indexed heavily, so memory is findable by situation rather than by keyword. |
| `recalled` | no | claim / fact ids | Every Muninn memory that was in the model's context when this entry was produced. |
| `used` | no | claim / fact ids | The subset of `recalled` the entry names as having mattered. The only input to `use_count`. |
| `echo` | no | claim / fact ids | Claims here that merely restate a recalled memory. Journaled as usage signal, never counted as corroboration. |
| `promoted_from` | no | `<project>/<entry id>` | This entry is a copy of a project entry, promoted into the global journal. |
| `redacted` | no | `true` | Secret scanning replaced something in this entry before it was written. |

List-valued fields are comma-separated. Unknown fields are **preserved, never dropped**: a
store synced from a machine running a later Muninn round-trips through an older one intact.

Two fields are strict, because everything downstream depends on them: an entry with an
unreadable id or an unknown `source` is reported and skipped rather than guessed at.
Everything else is tolerant — an unknown `channel` or `phase` is reported, and the entry is
kept.

### Prose is context

The paragraph block between the metadata and the bullets is **context**: what was happening.
It is returned by `memory_read`, because a claim without its situation is exactly the thing
this project refuses to trust — but it is never evidence on its own, and an ordinary
(active-only) search does not match it.

### Bullets are claims

Every line starting with `- ` is one claim. Claims are the unit of everything downstream:

- addressed as `<entry id>.<ordinal>`, 1-based (`j-0198f2c1-….1`),
- indexed as their own chunk, carrying the entry's header and `cue` as breadcrumb,
- cited by facts as evidence,
- superseded individually, in `supersessions.md`.

An indented continuation line belongs to the claim above it, so a model's line-wrapped
claim is not torn in half.

**An entry with no bullets has exactly one implicit claim: its prose, at `.1`.** This is why
`/muninn note some fact` needs no bullet to be citable.

### The terminator

Every complete entry ends with a blank line. That is what makes a crash mid-append
detectable: an entry at end of file with no blank line after it was never finished. The
reader reports it and excludes it; everything before it is still read. It is never
silently repaired, because guessing at what a half-written entry meant is worse than
showing that it is half-written.

## Writing

- **Append only.** Entries are never edited after they are written. The one exception in the
  whole design is [erasure](../README.md#remember-review-forget), which replaces a body with
  a tombstone and rewrites history — always a human action, never automatic. (Phase 2.)
- **One entry per `write`.** Each append takes the store lock, writes the whole entry with a
  single `write`, `fsync`s, and releases. Readers therefore see whole entries or nothing.
- **The id is minted before the lock.** A UUIDv7 needs no coordination, so ids are in
  creation order per writer, *not* globally ordered within a file. Readers must not assume
  otherwise.
- **Redaction happens on the way in**, to prose, claims and `cue` — never to ids, `task`,
  `session` or the derivation lists, where a redacted value would be a broken pointer. An
  entry that was scrubbed carries `redacted: true`.
- **If the file does not end with a newline** — the signature of an earlier crash — a
  newline is written first, so the new entry starts on a fresh line and the damaged one
  stays visible.

## Reading

A reader must:

1. Split on lines beginning with `## `.
2. Treat a final block with no terminating blank line as truncated: report it, exclude it,
   keep everything before it.
3. Report and skip a block with an unreadable id or an unknown `source`.
4. Report, but keep, an entry with an unknown `channel` or `phase`.
5. Preserve unknown metadata fields when writing the entry back out.

No damaged file may cost more than the damaged entry. Losing a day's journal because its
last entry is half-written would be a far worse failure than losing the half-written entry.

## Related formats

These are read by Phase 1 and written by dreams in Phase 2. Their grammars live with the
code that parses them; the shape is the same everywhere — a bullet, then a ` · `-separated
flat trailer.

- **`supersessions.md`** — one line per invalidated *claim*:
  `- <claim id> · valid_to: <date> · by: <claim id> · fact: <fact id>`
- **`topics/<slug>.md`** — one bullet per fact: bolded claim, then
  `id: f-<topic>-<uuid> · valid_from: … · source: … · evidence: <claim ids> · cue: …`
- **`rules.md`** — `- R-014 · phase: test · scope: project · source: user · since: <date>`,
  with the rule's text on the indented lines below it.
- **`store.md`** — schema version, store id, and the host registry. The one file two hosts
  write concurrently, and the one merge sync performs: a union of host lines.
