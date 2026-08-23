# pi-muninn

**Journal, dream, remember — offline long-term memory for [pi](https://github.com/earendil-works/pi).**

An extension that keeps a markdown journal of what happens in pi sessions, *dreams* over it
offline with a local model to distil durable knowledge, and recalls that knowledge in later
sessions — across projects, with provenance, and without a cloud dependency anywhere in the
path.

> Huginn and Muninn fly each day over the wide world. I fear for Huginn, that he may not
> return — yet more I fear for Muninn.
> — *Grímnismál*, 20
>
> Muninn is Odin's raven whose name means *memory*. He ranges by day and reports back at
> evening. Odin fears losing him more than losing thought.

> [!IMPORTANT]
> **Status: design proposal (v0.2.1). No implementation yet.**
> This README is the design document, published first so the architecture can be reviewed
> and argued with before any code exists. Every section is a commitment to be tested, not a
> description of working software. It will shrink into a normal project README as phases
> land. v0.2 (revised after a second review pass) adds the contracts the v0.1 review asked
> for: global claim identities and
> active-only recall, the journal→dream git transaction, provenance channels that block
> self-reinforcement, capture scope, a held-out evaluation, sync across hosts with
> model-assisted merging of conflicting dreams, and schema versioning. v0.2.1 verifies the
> "works as an extension" claim against the pinned pi source — see
> [verified at the baseline](#verified-at-the-baseline) — and adds a
> [Phase 1 implementation plan](docs/phase-1-plan.md).

### API baseline

Every integration claim below is made against a specific pi:

| | |
|---|---|
| Repository | [`earendil-works/pi`](https://github.com/earendil-works/pi) (formerly `badlogic/pi-mono`) |
| Package | `@earendil-works/pi-coding-agent` |
| Supported range | **`>=0.84.2 <0.85.0`** |
| Reference tag | [`v0.84.2`](https://github.com/earendil-works/pi/tree/v0.84.2) (`914cf14`) — all file and doc links in this README are pinned to it |
| Runtime | Node `>=22.19.0` (pi's own floor); Bun where the optional native tier is not enabled |
| Fork for core changes | [`frycm/pi`](https://github.com/frycm/pi) — always rebased onto the **latest stable upstream release**; carries only the patches listed under [core changes](#core-changes-to-propose-to-pi) |
| Local reference | the fork checked out as a sibling directory (`../pi`, at `v0.84.2` / `914cf14`) — every API claim in this README was verified by reading that checkout; file references below are relative to `packages/coding-agent/src/` in it |

Sibling projects in the same family, same conventions, same baseline policy:
[pi-palantir](https://github.com/frycm/pi-palantir) (remote sessions and voice) and
[pi-enclave](https://github.com/frycm/pi-enclave) (sandbox-first auto mode). Muninn is
designed to run inside an enclave and to be reachable through a palantír, but depends on
neither.

---

## Contents

- [Why this exists](#why-this-exists)
- [Goals and non-goals](#goals-and-non-goals)
- [The memory model](#the-memory-model)
- [Architecture](#architecture)
- [Capture — the raven flies](#capture--the-raven-flies)
- [Recall](#recall)
- [Dreaming — the raven returns](#dreaming--the-raven-returns)
- [Sync — one store, many hosts](#sync--one-store-many-hosts)
- [Trust and provenance](#trust-and-provenance)
- [Pi integration](#pi-integration)
- [Commands and settings](#commands-and-settings)
- [Key decisions](#key-decisions)
- [Prior art, reuse and credits](#prior-art-reuse-and-credits)
- [Delivery plan](#delivery-plan)
- [Core changes to propose to pi](#core-changes-to-propose-to-pi)
- [Open questions and risks](#open-questions-and-risks)
- [Why this name](#why-this-name)
- [License](#license)

---

## Why this exists

Between March and May 2026 nearly every coding agent converged on the same memory shape: a
directory of markdown files, a short index loaded at session start, topic files read on
demand, and a periodic offline pass — variously called *auto-dream*, *dreaming*, or
*consolidation* — that merges duplicates, resolves contradictions and prunes the index.
Claude Code, OpenAI Codex, OpenClaw, Letta and Hermes Agent all ship it. The shape is no
longer novel, and this document does not pretend otherwise.

What those systems share is also what they get wrong, and the complaints are consistent
across all of them:

| Complaint | Root cause |
|---|---|
| "Stale memory made it do the wrong thing" — the single most common reason users disable auto-memory | Facts are *accumulated*, not *superseded*. Nothing records when a fact stopped being true. |
| The index overflows after a month | No decay, no retirement, no bound on procedural rules |
| Memory can be poisoned by repo content, tool output, or fetched pages, and later recalled as if the user had said it | No provenance on entries; anything the model wrote is trusted equally |
| The consolidation step needs a frontier model | Prompts assume a large model; small local models fail on the nested schemas used |
| Memory is locked inside one tool | Proprietary stores, undocumented formats, cloud sync |

The 2025–2026 research literature is unusually clear about which of these matter (see
[credits](#research-credits)): **forgetting, not recall, is the dominant production failure**;
consolidation done *offline* with the model at mutation time beats online memory; insights
and procedures transfer between tasks while raw traces cause negative transfer; and
goal-directed search over an *uncompressed* journal beats any fixed compression — so the raw
record must stay searchable and the dreamed layer is a cache over it, never the only copy.

In the pi ecosystem there are ten-odd memory packages; none does scheduled offline dreaming
over markdown with a local model, and the closest — [`pi-dream`](https://github.com/barryking/pi-dream),
which has reviewable git-backed dreams — has no journal, no search index, no provenance,
no supersession and no offline story. See [prior art](#prior-art-reuse-and-credits).

> **Thesis.** Keep an immutable, grep-able journal. Dream over it with a *small local* model,
> one bounded region at a time, grounded in journal evidence. Supersede instead of delete.
> Label where every fact came from, and never promote what the user did not say into the
> rules the agent follows without a human looking at the diff. Markdown and git are the
> store; everything else is a rebuildable index.

---

## Goals and non-goals

### Goals

- **Offline-capable, end to end.** Capture, indexing, recall and dreaming all work on an
  air-gapped server with a local model through pi's existing
  [llama.cpp](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/llama-cpp.md)
  or any OpenAI-compatible endpoint. A frontier model makes dreams better; it is never
  required.
- **Markdown is the source of truth.** Every file a human might read or edit is markdown in
  a git repository. The search index is derived, gitignored and disposable.
- **Three memory kinds, kept apart.** Episodic (journal), semantic (topics), procedural
  (rules and skills) — with different write rules, different lifetimes and different trust.
- **Multiple scopes.** Global (the operator), project (a repository, optionally committed and
  shared), and team (a git remote) — layered, with project and team able only to *add*.
- **Supersession, not deletion.** Facts carry `valid_from` / `valid_to` / `superseded_by`;
  losers stay as audit rows, and ordinary recall returns only what is currently valid.
  "What did I believe last month and why did it change" is answerable — on request.
- **One store, many hosts.** A personal store syncs between machines over a private git
  remote as a whole — journal included — so every derived fact keeps its evidence.
- **Provenance on every entry**, and a gate between "something the model read" and "a rule
  the model follows".
- **Dream as a reviewable diff.** A dream is a commit; remembering it is a fast-forward;
  forgetting it is `git revert`.
- **Retrieval that degrades gracefully**: grep and BM25 always; local embeddings and
  reranking when the operator stages the models.
- **Measured, on the operator's own traces**, not on chat benchmarks.

### Non-goals

- A knowledge base for documents. Muninn remembers *what happened and what was learned*
  in pi sessions. Indexing a wiki or a docs folder is a different tool (see
  [qmd](https://github.com/tobi/qmd)); Muninn may *point* at such a tool, not replace it.
- In-session compaction. pi has compaction; Muninn hooks the moment *before* it to
  journal, and does not try to replace the summary.
- Cloud sync, multi-tenant stores, or a hosted service. Sync is `git fetch` / `git push`
  to a remote the operator owns; team scope is a git remote.
- Parametric or activation memory. The model is frozen; memory is text.
- Perfect recall. The bound on the index is a feature.

---

## The memory model

### Three kinds, one journal

```
kind          files                         written by          lifetime         trust
────────────  ────────────────────────────  ──────────────────  ───────────────  ─────────────────────
episodic      journal/YYYY-MM-DD.<host>.md  capture (append)    immutable        carries source:
semantic      topics/<slug>.md              dream (rewrite)     superseded       derived, cites journal
procedural    rules.md, skills/*/SKILL.md   dream + human       bounded, decays  gated promotion
working       MEMORY.md                     dream (regenerate)  ≤ 200 lines      frozen per session
```

The journal is the **only** thing capture writes. Everything above it is produced by
dreaming from journal evidence and points back to the journal entries it came from. A fact
in a topic file that cannot be traced to a journal entry is a bug the lint phase reports.

pi's own session files (`~/.pi/agent/sessions/<cwd-slug>/*.jsonl`) are the raw layer
*below* the journal: full transcripts with tool calls, compaction entries and branch
summaries. Muninn does not copy them. Journal entries reference them
(`session: <file>#<entryId>`), and dreaming may open them for evidence.

### Scopes

| Scope | Location | Git | Loaded when |
|---|---|---|---|
| **global** | `~/.pi/agent/muninn/` | own repository, local | always |
| **project** | `<repo>/.pi/muninn/` | inside the project's repository **or** a separate repository keyed by the project's git toplevel — operator's choice per project, default separate | cwd is in the project and the project is [trusted](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/security.md#project-trust) |
| **team** | a git remote of the project or global store | remote | when configured; read-only by default |

Scopes layer like pi's context files: project and team can **add** facts and rules; they
cannot remove or override a global rule. A conflict is surfaced in `MEMORY.md`, not resolved
silently.

**Which scope receives a capture.** Exactly one scope is the *capture target* of a session,
decided at `session_start` and shown in the footer:

- cwd inside a **trusted** project with an active project store → **project**;
- otherwise → **global**.

Automatic capture, `/muninn note` and `memory_note` all write to the capture target unless
told otherwise: `memory_note({ scope: "global" })`, `/muninn note --global <text>`. A fact
that was captured in project scope and turns out to be general is **promoted**, never
moved: `/muninn promote <id>` copies the journal entry into the global journal with
`promoted_from: <project>/<id>`, and the next global dream consolidates it. Dreams never
cross scopes.

**Applicability.** A project fact may *shadow* a global one inside that project without
touching the global store: a project topic fact carries `shadows: <global fact id>`, recall
in that project prefers the project fact and labels the global one as shadowed, and any
other project still sees the global default. Rules cannot shadow; a project rule that
contradicts a global rule is a lint finding, not a silent override.

### File layout (one scope)

```
muninn/
├─ store.md                     # schema version, store id, host registry — see Schema versioning
├─ MEMORY.md                    # index: one line per topic/rule, ≤ 200 lines; regenerated by dream
├─ journal/
│  ├─ 0198a0b1-…-mbp/           # one directory per host id: two machines never write the same file
│  │  └─ 2026-08-22.md          # per-day within the host
│  ├─ 0198a0b2-…-ops1/
│  │  └─ 2026-08-22.md
│  └─ erasures.md               # tombstones: ids removed for privacy; the one mutation of the journal
├─ supersessions.md             # derived, append-only: which journal ids are no longer current
├─ topics/
│  ├─ testing.md
│  └─ deploy-pipeline.md
├─ rules.md                     # procedural, bounded (default 60 rules), linted
├─ skills/
│  └─ flaky-ci-triage/SKILL.md  # pi-native skill format, contributed via resources_discover
├─ dreams/
│  └─ 2026-08-22T03-00.md       # dream report: what was read, what changed, eval result
├─ .index/                      # gitignored, rebuildable: chunks, embeddings, links
└─ .gitignore                   # .index/
```

### Formats

Everything is markdown with a **flat** metadata block — `key: value` lines, no nesting, no
lists-of-maps. The flatness is deliberate: it is what a 4B model emits reliably and what a
thirty-line parser reads without a YAML library.

**Journal entry** — appended, never edited:

```markdown
## 14:32 · j-0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01
source: user
channel: tui
task: 0198f2b0-1111-7000-8000-000000000001
session: ~/.pi/agent/sessions/--Users-mfryc-src-app--/0198f2b0-….jsonl#e5f6g7h8
phase: test
cue: when vitest hangs in CI
recalled: j-0198e9a4-1c2f-7d33-8e55-aa10b2c3d4e0.1

Martin corrected an earlier assumption (see j-0198e9a4-1c2f-7d33-8e55-aa10b2c3d4e0.1) while the CI job hung.

- Run `pnpm test --run`; vitest watch mode hangs the CI job.
- The CI runner has no TTY, which is why watch mode never exits.
```

The prose is **context**; the bullets are **claims**. Claims are the unit of everything
downstream: each is addressed as `<entry id>.<ordinal>` (`j-0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01.1`), indexed as its own
chunk with the entry's header and `cue` as breadcrumb, cited by facts as evidence, and
superseded individually. Prose is returned by `memory_read` for a human or a model to see
the situation, but is never evidence on its own and never matched by active-only filtering.
An entry with no bullets has exactly one implicit claim, its prose, addressed as `.1`. The
capture template for outcome entries asks the model for claims as bullets; `/muninn note`
turns each line starting with `- ` into a claim and anything else into context.

| Field | Values | Purpose |
|---|---|---|
| `source` | `user` · `agent` · `tool` · `external` | **Assertion origin** — [provenance](#trust-and-provenance). `user` is only text the user typed; `agent` is the model's own inference; `tool` is derived from tool output; `external` is from fetched or repo content. |
| `channel` | `tui` · `rpc` · `sdk` · `hook` · `dream` | **Observation channel** — how the entry reached Muninn. Kept separate from `source` so that "the user typed it in the TUI" and "an SDK script asserted it on the user's behalf" are distinguishable. |
| `recalled` | claim / fact ids | **Model derivation** — every Muninn memory that was in the model's context when this entry was produced. A claim that restates a recalled fact is an *echo*, not corroboration ([self-reinforcement](#self-reinforcement)). |
| `used` | claim / fact ids | Subset of `recalled` that the outcome entry names as having mattered; the only input to `use_count`. |
| `task` | pi session id | **Task group** — the unit the evaluate phase holds out. Every entry from one pi session shares it; a resumed or branched session adds `continues: <task>` so a multi-session task is one group. |
| `session` | file `#` entry id | Evidence pointer into pi's session tree |
| `phase` | `locate` · `reproduce` · `fix` · `test` · `review` · `ops` · `other` | The step of the coding loop this belongs to. Retrieval filters by it; subtask-aligned memory outperforms instance-level memory on SWE tasks. |
| `cue` | free text | "When would I need this?" — a retrieval cue written at capture time, indexed alongside the body so BM25 finds it by situation, not only by keyword. |

**Topic file** — rewritten by dreams, one region at a time:

```markdown
---
topic: testing
updated: 2026-08-22
---

# Testing

## Facts

- **Run tests with `pnpm test --run`, never watch mode.** id: f-testing-0198f2c2-0a1b-7c2d-8e3f-405162738495 · valid_from: 2026-08-22 · source: user · evidence: j-0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01.1 · cue: CI hangs on vitest
- **Integration tests need `DATABASE_URL` pointing at the docker compose db.** id: f-testing-0198d1e7-7081-7a2b-8c3d-4e5f60718293 · valid_from: 2026-07-30 · source: tool · evidence: j-0198c0d5-5e6f-7081-92a3-b4c5d6e7f801.2, j-0198d1e6-6f70-7192-a3b4-c5d6e7f80912.1

## Superseded

- ~~Tests run with `pnpm test`.~~ id: f-testing-0198e9a5-2d3e-7f40-9152-63748596a7b8 · valid_from: 2026-08-01 · valid_to: 2026-08-22 · superseded_by: f-testing-0198f2c2-0a1b-7c2d-8e3f-405162738495 · reason: user correction — watch mode hangs CI
```

A fact line is one bullet: bolded claim, then a ` · `-separated flat trailer. Facts have
stable ids (`f-<topic>-<uuidv7>`, minted by the dream, never reused — two hosts' dreams
cannot collide and a [merge](#merging-dreams) never renumbers). Evidence cites **claims**,
not entries. Supersession moves the
line to `## Superseded` with `valid_to`, `superseded_by` and `reason`; nothing is deleted by
a dream.

**Supersession reaches the journal — per claim.** A superseded fact's evidence is still in
the immutable journal, and a search over the journal would happily return it — or a later
dream re-promote it. So the dream also appends to `supersessions.md`, one line per
invalidated **claim**:

```markdown
- j-0198e9a4-1c2f-7d33-8e55-aa10b2c3d4e0.1 · valid_to: 2026-08-22 · by: j-0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01.1 · fact: f-testing-0198e9a5-2d3e-7f40-9152-63748596a7b8
```

The key is a claim id, never a whole entry: an outcome entry routinely supports several
independent facts, and superseding one of them must not hide the others. Since a claim is
also the indexing chunk, validity is applied at exactly one granularity everywhere —
retrieval drops superseded chunks, lint checks that every evidence claim is active, and a
claim of the same entry that nobody superseded stays searchable.

`supersessions.md` is derived (a dream writes it, a forgotten dream reverts it) but
**committed**, so it is the same on every host. Ordinary recall — the per-turn injection,
`memory_search` and the gather phase — is **active-only**: it drops claim chunks and facts
whose id appears there. `memory_search({ history: true })` and `memory_read` by id still
return them, labelled `superseded`, for "what did I believe in July".

`last_used` / `use_count` are **derived from the journal**, not stored: the outcome entry of
every session lists the recalled fact ids it `used`, and `.index/` counts them. Recall does
not dirty git, the count survives deleting `.index/`, and two hosts compute the same number
from the same journal.

**Rules** — the procedural layer the agent actually follows, bounded and linted:

```markdown
- R-014 · phase: test · scope: project · source: user · since: 2026-08-22 · last_confirmed: 2026-08-22
  Run `pnpm test --run`; never start watch mode in a non-interactive session.
```

Rules have identities so that a dream can *retire* one (moved to `## Retired` with a reason
when unused for 90 days or contradicted) rather than silently drop it, and so the eval phase
can tell which rule a regression touches.

---

## Architecture

```
                       day                                          night
 ┌──────────────────────────────────────────────┐   ┌──────────────────────────────────────┐
 │ pi session (TUI, palantír, SDK)               │   │ muninn dream  (cron / idle / manual)  │
 │                                               │   │                                       │
 │  session_start ─► MEMORY.md frozen snapshot   │   │  1 orient   read MEMORY.md, dreams/   │
 │  before_agent_start ─► recalled facts (budget)│   │  2 gather   search journal + sessions │
 │  tools: memory_search / memory_read /         │   │             for corrections, repeats, │
 │         memory_note                           │   │             decisions — not everything│
 │  session_before_compact ─► journal entry      │   │  3 consolidate one topic at a time,   │
 │  agent_settled / session_shutdown ─► journal  │   │             grounded in evidence,     │
 │                                               │   │             supersede not delete      │
 │            writes ONLY journal/               │   │  4 lint     contradictions, orphans,  │
 └───────────────────────┬───────────────────────┘   │             unsourced facts, rule cap │
                         │ append + commit           │  5 evaluate held-out tasks + canaries │
                         ▼                           │  6 commit   branch dream/<ts>, report │
 ┌──────────────────────────────────────────────┐   └──────────────────┬───────────────────┘
 │ memory store (git)                            │                      │ reads journal,
 │  journal/  topics/  rules.md  skills/  MEMORY │◄─────────────────────┘ writes topics/rules/
 │  ▲                                            │                        MEMORY on a branch
 │  │ rebuild by hash                            │
 │  ▼                                            │        remember: fast-forward main
 │ .index/  chunks · BM25 · vectors · links      │        forget:   git revert
 └──────────────────────────────────────────────┘
```

Two processes, one store. The session-side extension is thin and append-only. The dreamer
is a separate job — runnable from the TUI (`/muninn dream`), from a cron entry, or from the
palantír daemon's idle hook — that rewrites the derived layers on a branch. They never write
the same paths (`journal/` versus everything else), so a dream branch always rebases cleanly
onto new journal commits; the exact transaction is under
[the journal→dream transaction](#the-journaldream-transaction).

---

## Capture — the raven flies

Capture is **selective by construction**. It writes journal entries, nothing else, and it
writes far fewer of them than a transcript has turns — the research on auto-capture noise
(Supermemory, claude-mem) is unambiguous that "remember everything" produces a store nobody
trusts.

What gets a journal entry, in priority order:

1. **Explicit** — the user says *remember*, *note*, *from now on*, or calls `/muninn note`.
   Always `source: user`.
2. **Corrections** — a user message that contradicts what the agent just did or assumed
   ("no, use X", "don't", "actually…"). Detected by a cheap classifier on the user turn;
   these are the highest-value signal Anthropic's dreamer mines for, and Muninn captures
   them at the moment they happen rather than reconstructing them later.
3. **Decisions and outcomes** at `agent_settled`: what the task was, what was tried, what
   worked, what failed and why — one entry, phase-tagged, written by the *session's* model
   with a strict template. Failures are memory too. The turn's messages and tool results
   are accumulated from `turn_end` / `agent_end` as they happen; `agent_settled` (which
   carries no payload) is only the signal that pi will not continue on its own.
4. **Pre-compaction** — `session_before_compact` fires before context is summarised away;
   Muninn writes the outcome entry then, so nothing that compaction drops is lost to the
   journal. It does not alter pi's compaction.
5. **Tool-derived facts** — environment gotchas discovered through tool output (a port in
   use, a flag that does not exist, a version mismatch). `source: tool`.

Every entry runs through **secret scanning** (the same regex set pi-enclave uses for its
audit log, plus high-entropy detection) before it is written; a hit is redacted and the
entry marked `redacted: true`. Capture never writes outside `journal/` and never writes to
project scope unless the project is trusted.

**Identities.** Every id that anything cites is a **UUIDv7**, in full, never truncated:

| Id | Minted | By | Form |
|---|---|---|---|
| host | first run on a machine, stored in `~/.pi/agent/muninn/host.json` | Muninn | UUIDv7; `store.md` maps it to a display name |
| journal entry | at append | capture | `j-<uuidv7>` |
| claim | at append | capture | `<entry id>.<ordinal>` — immutable because the entry is |
| fact | at consolidate | dream | `f-<topic>-<uuidv7>` |
| task | at `session_start` | pi (its session id) | as pi gives it |

UUIDv7 is time-ordered, so ids sort chronologically within a host's clock, and it needs no
coordination at all: no sequence, no registry lookup, no hash that might collide. The
price is readability in a diff; the examples in this README elide the middle of ids and
real files do not. Display names in `store.md` are for humans only — two hosts registering
`mbp` while offline is harmless, the UI shows `mbp` and `mbp (2)` and nothing is keyed on
the name. Timestamps are local with offset and are for humans.

**Appends.** Journal files are per host directory (`journal/<host id>/`) and per day, so
sync never has to merge two hosts' writes to one file. Within a host, several pi sessions append to the same daily file; each
append takes the [store lock](#the-store-lock) for a few milliseconds, writes the whole
entry with one `write`, `fsync`s, and releases. The id is a UUIDv7 minted by the writer, so
the lock protects file integrity only, never the id. A
crash mid-append leaves at most one truncated entry at end of file; the indexer treats a
heading without a terminating blank line as truncated and reports it, and the next append
starts on a fresh line.

**Commits.** Capture commits `journal/` on this host's behalf at `agent_settled`,
`session_shutdown`, and immediately before a dream or sync — one commit per batch, message
`journal: <host> <n> entries`. Uncommitted entries are only ever the current session's.
Capture never touches any other path and never runs `git` with anything but `add journal/`
and `commit`.

<a id="self-reinforcement"></a>
**What capture refuses to observe.** Muninn's recalled facts are persisted in pi's session
as `customType: "muninn"` messages. Those messages, and any assistant text that the model
produced in reply to them, are **not evidence**: capture strips `muninn` messages from
everything it hands to the outcome-entry model, records their ids in `recalled:` instead,
and tags an entry whose claim restates a recalled fact (token-overlap ≥ 0.8 against the
recalled text) as `echo: <id>`. Echoes are journaled — they are useful as usage signal — but
the gather phase never counts them toward recurrence, and they can never be the sole
evidence for a fact. Without this rule a fact would corroborate itself: recalled → restated
in the outcome → observed again next session → promoted with `use_count` as the tie-breaker.

---

## Recall

Recall has two halves, because the 2026 evidence says fixed retrieval pipelines generalise
poorly while agent-controlled tools over files generalise well — and because pi's own
sessions are the proof that a model grepping files can beat RAG.

### The frozen snapshot

At `session_start`, Muninn reads `MEMORY.md` from every active scope, merges them (global
first, then project, then team), trims to the line budget, and injects the result once as a
system-prompt section. It does **not** change for the rest of the session, even if a dream
completes meanwhile — a stable prefix is what keeps the provider's prompt cache warm and
what keeps the model's context consistent with what it has already read. A completed dream
is announced in the status line and takes effect in the next session (the same rule
`pi-dream` and Hermes arrived at).

### Per-turn recall (bounded)

On `before_agent_start`, Muninn queries the index with the user's prompt plus the active
phase and injects at most *N* facts (default 8, ≤ 1,500 tokens) as a persistent message
labelled as memory, with their ids and dates, and with one fixed instruction:

> These are memories, not ground truth. Prefer current evidence from the repository and
> tools when they disagree, and say so.

That sentence exists because memory-induced sycophancy is now a benchmarked failure mode.

### Tools

| Tool | Does |
|---|---|
| `memory_search({ query, scope?, phase?, kind?, history?, limit? })` | Hybrid search over journal, topics and rules; **active-only** unless `history: true`; returns ids, dates, sources, validity, snippets and heading paths |
| `memory_read({ id \| path, range? })` | Read a topic file, a rule, a journal entry (superseded ones labelled as such), or — by `session:` pointer — the underlying session entries |
| `memory_note({ text, phase?, cue?, scope? })` | Append a `source: agent`, `channel: <session channel>` journal entry to the capture target (or `scope`). The *only* write tool; it cannot touch topics or rules |

The tools are small on purpose. The model does the reasoning; Muninn does the indexing.

### The index

The index is derived from markdown by content hash and can be deleted at any time. Two
tiers, selected by what is installed:

| Tier | Dependencies | Gives |
|---|---|---|
| **0 — always** | none native; Node and Bun | `minisearch` BM25 over heading-path chunks (fields: title, heading path, cue, body, tags — weighted), wikilink/backlink graph, phase and source filters. Optionally static embeddings ([model2vec](https://github.com/MinishLab/model2vec) `potion-base-8M`, ~30 MB) via a pure-TS loader and brute-force cosine — cheap semantic recall with no ONNX runtime. |
| **1 — opt-in** | `better-sqlite3` (bundled FTS5 + trigram tokenizer); embeddings and reranking over HTTP against an OpenAI-compatible endpoint (`/v1/embeddings`, `/v1/rerank`) — llama-server or Ollama — no in-process native ML runtime | FTS5 with fuzzy matching, EmbeddingGemma-300M (or Qwen3-Embedding-0.6B) vectors stored as BLOBs and scanned brute-force (a few tens of ms under 100k chunks), `bge-reranker-v2-m3` over the top 30, reciprocal-rank fusion (k = 60) with an all-terms-in-title boost |

Chunking follows qmd's rules: split at heading boundaries, carry the `H1 › H2 › H3`
breadcrumb in every chunk, cap at ~700 tokens, never split a fenced block, re-embed only
chunks whose hash changed. `node:sqlite` is deliberately not used: pi's prebuilt Node
binaries lack FTS5 and extension loading is unreliable there; `better-sqlite3` runs on Node
and Bun and bundles its own SQLite. Tier 1 failing to load **falls back to Tier 0 loudly**
— the silent-vector-failure bug class (OpenClaw #65156) is explicitly designed out.

**Tier 1 endpoint contract.** pi's providers expose model *completion* only; at the
baseline neither the llama-server provider nor `ModelRegistry` has an embedding or rerank
operation. Muninn therefore calls those endpoints itself, under an explicit contract rather
than by assumption:

- **Configuration.** `recall.embedding` and `recall.rerank` each name a pi provider entry
  plus a model id (`{ provider: "llama-server", model: "embeddinggemma-300m" }`). Muninn
  reuses that provider's `baseUrl` and credential from pi's registry via
  `ctx.modelRegistry.getApiKeyAndHeaders(model)` (falling back to `model.baseUrl`); it
  never stores its own.
- **Discovery.** On index open Muninn probes each endpoint once (`GET /v1/models`, then a
  one-token `POST`) and caches `{ baseUrl, model, dims, ok, checkedAt }` in `.index/`. A
  dimension change invalidates every stored vector for that model.
- **Limits.** Embedding requests batch ≤ 64 chunks, time out after 10 s; rerank ≤ 30
  candidates, 5 s. Every call carries the session's `AbortSignal`; a session ending cancels
  in-flight recall.
- **Fallback.** Any probe or call failure marks the endpoint `ok: false` for 10 minutes and
  the query runs at Tier 0 with a footer warning and a log line. Indexing continues
  lexically and re-embeds the backlog when the endpoint returns. Nothing is ever silently
  unembedded.

The cleaner shape — `embed()` / `rerank()` on pi providers — is the third item under
[core changes](#core-changes-to-propose-to-pi); the contract above is what Muninn ships
with until then.

---

## Dreaming — the raven returns

A dream is a job, not a hook. It runs when the operator runs it, on a schedule, or when pi
has been idle; it reads the store, writes the derived layers on a branch, and produces a
report. It is the only thing that ever modifies `topics/`, `rules.md`, `skills/` or
`MEMORY.md`.

### Triggers and locking

- `/muninn dream` (TUI), `muninn dream` (CLI, headless via the
  [SDK](https://github.com/earendil-works/pi/blob/v0.84.2/packages/coding-agent/docs/sdk.md)'s
  `createAgentSession`), cron, or palantír's idle hook.
- Automatic trigger, when enabled: **≥ 24 h since the last dream AND ≥ 5 new journal
  entries**, or **≥ 50 new entries regardless of time**. Time alone never triggers a dream.
- A lock file with pid, host and timestamp; stale after 2 h. Dreams never run concurrently
  against one store *on one host*; different scopes may dream in parallel. Two hosts can
  dream the same synced store at once — see [Sync](#sync--one-store-many-hosts) for what
  happens at remember.
- The dream works in a **git worktree** on branch `dream/<host>/<timestamp>`. The working
  store is never touched until *remember*.

### The journal→dream transaction

A worktree sees committed state only, and capture keeps writing while a dream runs. The
contract that keeps the two honest:

**Layout.** The store directory *is* the `main` worktree: sessions read `MEMORY.md` and
the index from it, capture appends to `journal/` in it. Dreams get their own worktrees under
`.git/worktrees/` on `dream/<host>/<ts>` branches, and never touch the main worktree.
Readers never lock: a session reads `MEMORY.md` exactly once at `session_start`, and the
index rebuilds by content hash on open, so a reader that observes a half-applied remember
sees at worst a stale snapshot or a rebuild, never a torn file.

<a id="the-store-lock"></a>
**The store lock.** One exclusive lockfile, `.lock` (pid, host, operation, timestamp; stale
after 30 s for appends, 2 h for dreams). Capture holds it per append for milliseconds;
*remember*, *sync*, *erase* and *migrate* hold it for their whole duration. Two dreams on one
host are excluded by it; dreams on different hosts are not, and meet at sync.

1. **Input head.** The dream begins by asking capture to commit this host's pending journal
   entries, then records `input_head: <sha of main>` and `journal_through: <last id per
   host>` in its report. Everything the dream consolidated is at or before that commit.
2. **Concurrent capture is allowed.** Sessions keep appending to `journal/` in the main
   worktree and committing to `main`. Those entries are simply *not yet dreamed*; the next
   dream picks them up. The dream worktree never sees them and never needs to.
3. **Remember is an apply transaction** on the main worktree, under the store lock:
   1. write `.remember` (the dream branch name and the current `main` sha) — the
      in-progress marker;
   2. commit any pending journal appends, so the worktree is clean;
   3. rebase the dream branch onto `main` — conflict-free by construction when `main`
      moved only by journal commits, because capture touches only `journal/` and a dream
      only the derived paths; a genuine derived-file conflict (two dreams rewrote the same
      topic) is not left to `git merge` but goes through the [merge dream](#merging-dreams),
      which is the consolidate phase with two candidates;
   4. `git merge --ff-only <dream branch>` — git advances the ref **and** the index **and**
      the worktree in one operation, so readers see the new derived files on disk and the
      store is never dirty against its own `HEAD`. `--ff-only` doubles as the
      compare-and-swap: if `main` moved under us anyway it fails, and step 3 is retried
      once;
   5. delete `.remember`.
4. **A dream never rewrites `main`.** Fast-forward only; `forget` is a revert commit,
   applied through the same transaction.

**Recovery.** On open, a `.remember` marker means a remember died between steps 1 and 5.
If `main` still equals the recorded sha, nothing was applied: delete the marker. If it
does not, the ref moved but the worktree may not have: `git checkout HEAD -- <derived
paths>` restores the derived files from `HEAD` (journal files are never touched, because
a fast-forward from a dream branch changes only derived paths), then delete the marker. A
stale `.lock` is taken over after its timeout. No step leaves a state the next run cannot
name.

The effect: capture and dreams can overlap freely, a dream's evidence set is an exact commit
range, and "which entries has this store *not* yet learned from" is
`git diff input_head..main -- journal/`.

### Phases

| | Phase | What happens | Bound |
|---|---|---|---|
| 1 | **Orient** | Read `MEMORY.md`, the last dream report, `rules.md`. Build the list of topics and their evidence sets. | one read |
| 2 | **Gather** | *Search*, not read: journal entries in `last input_head..input_head`, **active-only** (nothing in `supersessions.md`), **echoes excluded** from recurrence; `source: user` corrections; entries whose `cue` or body recurs ≥ 2 times across *distinct* sessions with distinct `recalled` sets; decisions; failures. Optionally open the session files behind an entry for evidence. Single-occurrence `agent`/`tool` entries stay in the journal and are not promoted (recurrence gating). Before any of this, the *k* most recent **completed task groups** in the range — every entry sharing a `task`, closed over `continues`, of every `source`, plus the session files they point at — are **held out**: excluded from search, from evidence, from recurrence counting and from `memory_read` during phases 2–3, and listed by task id in the report. | top-K per query |
| 3 | **Consolidate** | For each affected topic, **one bounded job**: the model sees the current topic file, the new evidence, and emits a replacement **fact list** — not free text — with `supersedes` and `evidence` per item. Muninn applies it: new facts get ids, superseded facts move to `## Superseded` with `valid_to`, their evidence ids are appended to `supersessions.md`, nothing is deleted. Relative dates become absolute. A job that loses > 25 % of a topic's facts is rejected. | one topic per job, ≤ 40 facts |
| 4 | **Lint** | Deterministic: every fact cites an existing, active, non-echo **claim** id; no active fact's evidence is entirely superseded; no two facts contradict within a topic (pairwise, model-judged only when keyword overlap is high); `rules.md` within its cap; rules unused > 90 days proposed for retirement; orphans in `MEMORY.md`; project rules that contradict a global rule. Findings go in the report, and blocking ones (unsourced or echo-only fact, cap exceeded) fail the dream. | — |
| 5 | **Evaluate** | Two sets, neither seen by phases 2–3. **Held-out tasks**: the *k* (default 5) task groups withheld in phase 2 — whole tasks, not just their outcome entries, so no correction, tool fact or transcript line from a held-out task could have reached consolidation. A chronological holdout: the dream is scored only on the hidden groups' `used:` ids and the questions their outcome entries record. **Canaries**: a fixed, operator-maintained `eval/canaries.md` of `{ situation, must_surface, must_not_surface }` triples, including stale-fact negatives (a superseded claim that must stay out) and rule decisions (a situation and the rule that must fire). Each case runs headless with old and new `MEMORY.md` + recall. Metrics: evidence hit rate on held-out `used:` ids, stale-surfaced rate, canary pass rate. Any stale surfaced, any canary lost, or a hit-rate drop blocks auto-remember and is flagged for review. | k + canaries, read-only tools |
| 6 | **Commit** | Regenerate `MEMORY.md` (per-scope reserved budgets under a 200-line total, each scope ordered by `use_count` then recency), write `dreams/<ts>.md` with `input_head`, `journal_through` and the eval table, commit on the branch with a trailer listing touched topics and journal ids. | — |

Phases 2–3 are where the model runs; 1, 4 and 6 are code. That split is what makes a small
model sufficient.

### The local-model contract

Structured output from sub-8B models fails on nested schemas and succeeds on flat ones; hard
schema-constrained decoding can *lower* accuracy. Muninn therefore:

- uses **flat JSON** only — arrays of `{ claim, evidence[], supersedes?, cue?, phase? }` with
  no `$defs`, no nesting beyond one array;
- asks for reasoning **then** the JSON in a fenced block, parses the block, and on failure
  retries once with the parser error quoted; a second failure skips the topic and reports;
- keeps every job small enough for an 8k context (one topic, ≤ 40 facts, ≤ 30 evidence
  entries);
- ships a **qualification run** (`muninn dream --qualify`) that dreams a fixed fixture store
  and scores the result, so an operator learns before trusting it whether their model
  clears the bar. Reference targets: Qwen3.5-9B / Qwen3.6-35B-A3B pass; 4B models pass with
  reduced batch sizes; anything below is refused for automatic dreams and allowed only with
  `--force` for manual ones.

The dreamer model is configured independently of the session model (`dream.model`), through
pi's normal model registry — a llama-server or Ollama endpoint offline, anything else
online.

### Remember, review, forget

- `/muninn dreams` lists dream branches with their reports: facts added, superseded,
  retired rules, lint findings, eval delta.
- **Remember** fast-forwards `main` to the dream branch. With `dream.autoRemember: true`
  (default `false`) a dream that passed lint and eval is remembered automatically — *except*
  for any change to `rules.md` or `skills/` from non-`user` sources, which always waits for
  review ([promotion gate](#trust-and-provenance)).
- **Forget** is `git revert` of the remember commit; the journal is untouched either way.
- Dream reports are kept; the *report* of a forgotten dream is the record of why.

Three things that look alike and are not:

| | What it means | Mechanism | Touches the journal |
|---|---|---|---|
| **Supersede** | the world changed; the old fact was true and is not any more | a dream moves the fact, appends to `supersessions.md` | no |
| **Forget** (undo) | the dream was wrong; the store should be as it was before it | `git revert` of the remember commit | no |
| **Erase** | this must not exist anywhere — a secret that slipped past scanning, a person's data | `/muninn erase <id>`: the entry body is replaced by a tombstone line in the journal file, the id is listed in `journal/erasures.md`, every fact citing it is superseded with `reason: erased`, the index is rebuilt, and history is rewritten (`git filter-repo` on the store, force-push if a remote exists). The only mutation of the journal; always a human action; never automatic | **yes** |

`erasures.md` exists so that a host that had the erased entry in its clone drops it on the
next sync instead of resurrecting it, and so that a dream can prove it did not cite it.

---

## Sync — one store, many hosts

The personal case — the same operator on a laptop, a desktop and a server — is the one
every current memory system gets wrong, because each keeps a local store and offers a
cloud sync of the *summary*. Muninn's answer is that a store is a git repository and sync is
git, and that what is synced is the **whole store, journal included**.

Why not sync only the dreamed output? Because the dreamed layer is a cache over the journal,
and a cache without its source is exactly the "memory without provenance" this design exists
to avoid:

- Two hosts dreaming from *different* journals produce two rewrites of the same topic file.
  Those do not merge; one has to lose, and what it loses is evidence the other host never
  had.
- A fact that cites a claim from `ops-1`'s journal on a host that has no `ops-1` journal is
  unsourced, and lint would rightly reject it.
- `use_count`, supersession and the held-out evaluation are all computed from the journal.
  Without it every host gets a different `MEMORY.md` ordering and a different eval.
- The journal is small: text, a few entries per session, secret-scanned at write time. The
  part of it that must not leave the machine is the part that should not be in it at all,
  and [erase](#remember-review-forget) exists for the rest.

So:

| Store | Remote | What moves | Trust |
|---|---|---|---|
| **global** (personal, many hosts) | a private remote the operator owns (`sync.remote`) | everything: `journal/`, derived layers, `dream/*` branches | trusted — it is the operator's own |
| **project**, separate store | same, keyed by project | same | same |
| **project**, committed in the repo | the project's own remote | same, inside the product's history | trusted only when the project is trusted |
| **team** | a remote others write to | **derived layers only** — `topics/`, `rules.md`, `skills/`, `MEMORY.md`, `supersessions.md`; never a journal | untrusted input — see below |

**`muninn sync`** (also run automatically at `session_shutdown` when a remote is
configured and reachable, and before every dream): commit this host's journal → `fetch` →
rebase `main` onto the remote head, which is conflict-free because every host's journal
files are its own and derived files change only through remembered dreams → `push`. If the
rebase does conflict anyway — a hand-edited topic file, a remembered dream on each side —
sync stops and reports; it never force-pushes `main`.

**Dreams across hosts.** Any host may dream; its branch is `dream/<host>/<ts>` and is pushed
on sync, so `/muninn dreams` on the laptop lists the server's overnight dream and can
remember it. Remember uses the same [apply transaction](#the-journaldream-transaction) as
on one host; two hosts that remembered different dreams touching the same topic meet a
conflict at sync, and the conflict is resolved by a [merge dream](#merging-dreams), not by
hand and not by `git merge`. The lock file is per host by design: the cost of a cross-host
lock would be a second source of truth, and the cost of not having one is an occasional
merge dream.

### Merging dreams

Two dreams that rewrote the same topic from different journals are the normal case for a
store with more than one dreaming host, and their diffs are usually *not* resolvable by
line-level merge: both sides replaced the same bullet with different wording, both
superseded the same fact for different reasons, or each added a fact the other contradicts.
So a derived-file conflict is handled in three layers, cheapest first, and the model is
only asked about what the first two could not settle:

1. **Structural 3-way merge, per fact.** Topic files are lists of id'd bullets, so the
   merge unit is a fact, not a line. With `base` (the common ancestor on `main`), `ours`
   and `theirs`: a fact added on one side only is kept; a fact superseded on one side and
   untouched on the other is superseded; a fact superseded on both sides keeps the earlier
   `valid_to` and both `superseded_by` values; `supersessions.md` and `## Superseded` are
   unioned (append-only, so never a conflict); `MEMORY.md` is regenerated, never merged.
   Ids cannot collide because they are UUIDv7s.
2. **Deterministic residue detection.** What is left is the semantic residue: pairs of
   active facts — one per side, or one new and one existing — whose claims overlap (same
   `cue`, shared evidence ids, or token overlap above the lint contradiction threshold) or
   whose evidence sets intersect. These pairs are *not* merged by code.
3. **The merge dream.** For each topic with a residue, one bounded consolidate job — the
   same flat schema, the same local model, the same bound of ≤ 40 facts — with a different
   prompt: the model sees `base`, the two candidate fact lists, and the union of their
   evidence from the journal (which both hosts now have, because the journal was synced
   first), and emits one replacement fact list with `supersedes` and `evidence` per item.
   Lint runs on the result as on any dream, with one extra rule: every active fact from
   either side is either present, superseded with a reason, or listed in the report as
   dropped — a merge may not lose a fact silently. The result is committed as
   `dream/<host>/<ts>-merge` with a report naming both parents, and remembered through the
   ordinary gate, so a bad merge is reviewable and forgettable like any dream.

Layer 1 resolves the large majority of cross-host conflicts without a model call, because
most dreams touch disjoint topics or add disjoint facts. Layer 3 is where the provider
model is in the loop, and it is bounded exactly like consolidation, so the same
qualification fixture covers it: `muninn dream --qualify` includes labelled merge cases.
`rules.md` merges the same way with one difference — a residue in rules always waits for
human review, because a rule is followed, not just recalled.

A merge is **never** attempted on `journal/`; per-host files make that impossible by
construction, and a journal conflict is a bug to report, not resolve.

**The cron shape the question usually has in mind** — "when syncing, run the dreaming and
share the output" — is a server that does `muninn sync && muninn dream --scope global &&
muninn sync` nightly, with `dream.autoRemember` on once Phase 3's gate exists. The laptops
only capture and sync; they wake up to a remembered dream and a fresh `MEMORY.md`. That is
the recommended deployment for anyone with an always-on box, and why the dreamer model is
configured separately from the session model.

**Team remotes are input, not memory.** A team scope is someone else's derived output, and
it arrives with the same trust as a cloned repository: none until looked at. Muninn pins a
team scope to a commit (`team.pin`, advanced by `/muninn team review`, which shows the
diff since the last pin and asks); facts from it are loaded with `source: external`
semantics — searchable, never auto-injected, never promotable to a rule without a human —
and its `rules.md` is displayed, not followed, until a human promotes individual rules to
the global store with `scope: team` kept as the label. A team remote that publishes a
journal is refused.

### Schema versioning

`store.md` carries `schema: 1`, a `store_id` (UUIDv7, allocated at `init`), and the host
registry (`host: 0198a0b1-… · name: mbp · added: 2026-08-22 · platform: darwin`) — names
are display-only and may repeat; ids may not. Every file format above —
journal entries, fact trailers, `supersessions.md`, dream reports, `.index/` — is versioned
by that one number. Rules:

- Muninn refuses to open a store with a *newer* schema than it knows and says which version
  to install.
- Migrations are forward-only, run on open, on a branch `migrate/<from>-<to>` with a report,
  and remembered like a dream. A migration never touches `journal/` bodies; if one must
  change the *id* format, it writes an alias file rather than rewriting ids.
- `.index/` has its own version stamp and is deleted and rebuilt on mismatch — it is
  disposable by contract, so this is the one migration that is free.
- Crash recovery: a capture append is lock + single `write` + `fsync` (a truncated tail is
  reported, never parsed); a dream that dies leaves a worktree and a lock, both garbage-
  collected by the next dream after the lock goes stale; remember is the
  [apply transaction](#the-journaldream-transaction) with its `.remember` marker and
  checkout-from-`HEAD` recovery; sync is ordinary git and resumable by re-running. No step
  has a partial state that the next run cannot recognise.

---

## Trust and provenance

Memory is an input channel the agent writes to and reads from, which makes it both an
injection surface and a sycophancy amplifier. Muninn's position is that the **source class
of a fact decides what it is allowed to become**.

| Source | Can become a topic fact | Can become a rule / skill | Injected per turn |
|---|---|---|---|
| `user` | yes | yes, auto-remember allowed | yes |
| `agent` | yes, with evidence | only after human review | yes, labelled |
| `tool` | yes, with evidence | only after human review | yes, labelled |
| `external` | yes, quarantined section | **never automatically** | only via `memory_search`, never auto-injected |
| `team` (remote, pinned) | loaded, not re-derived | only by explicit per-rule promotion | only via `memory_search` until promoted |

Further controls:

- **Write scope.** The session extension writes only `journal/`; the dreamer writes only
  its worktree. Neither can write outside the store. Under pi-enclave both paths are also
  OS-enforced — the store is a declared writable root and nothing else is.
- **Secrets** are redacted at capture and re-scanned at dream time; a topic fact that would
  carry a secret is refused.
- **Project trust.** Project-scope memory is loaded and written only when pi's own project
  trust gate says the project is trusted. A committed `.pi/muninn/` in a freshly cloned
  untrusted repository is inert.
- **Team scope is pinned, reviewed, untrusted input** ([Sync](#sync--one-store-many-hosts)):
  advanced commit by commit through `/muninn team review`, rules displayed but not followed
  until promoted one at a time, journals refused.
- **Recall cannot feed itself.** `muninn` messages are never capture input; echoes are
  labelled and excluded from recurrence and from sole evidence
  ([self-reinforcement](#self-reinforcement)).
- **Poisoning budget.** Capture refuses more than *N* `external`-sourced entries per session
  (default 10) and the dreamer refuses to consolidate a topic whose evidence is > 50 %
  `external` without review. Aggressive writers are the exploitable ones; Muninn is a
  reluctant one.
- **Recall disclaimer** (see [Recall](#recall)) — memory is presented as fallible.

---

## Pi integration

Everything below uses APIs that exist in pi at the [baseline](#api-baseline).

| Need | Pi API | How Muninn uses it |
|---|---|---|
| Frozen snapshot at session start | `on("session_start")`, `on("before_agent_start")` → `systemPrompt` | Read and merge `MEMORY.md` per scope once; prepend a `# Memory` section to the chained system prompt on every turn, byte-identical across the session |
| Per-turn recall | `on("before_agent_start")` → `message: { customType: "muninn", … }` | Inject ≤ *N* recalled facts as a persistent, displayed message; `systemPromptOptions.contextFiles` tells Muninn what AGENTS.md already says so it does not repeat it |
| Tools | `pi.registerTool()` for `memory_search`, `memory_read`, `memory_note` | Read-only except `memory_note`; custom renderers show ids and sources compactly |
| Correction and explicit-remember detection | `on("input")`, `on("message_start")`, `on("turn_end")` | Only direct TUI/RPC user text counts as `source: user` — the same provenance rule pi-enclave uses for authorization |
| Outcome entry | `on("turn_end")` → `{ turnIndex, message, toolResults }`, `on("agent_end")` → `{ messages }`, `on("agent_settled")` | Accumulate the run's messages and tool results from `turn_end`/`agent_end`; at `agent_settled` (bare `{ type }`, fired once no retry, compaction or queued continuation will run) write one phase-tagged outcome entry using `ctx.modelRegistry.complete()` with the session model (or `dream.model` when configured). `ctx.sessionManager.getBranch()` is a cross-check for the turn's boundaries, not the primary source |
| Journal before compaction | `on("session_before_compact")` | Write the outcome entry *before* the summary is produced; return nothing so pi's compaction proceeds unchanged |
| Evidence pointers | `ctx.sessionManager.getSessionFile()`, entry ids | `session:` field in journal entries; `memory_read` follows it |
| Skills produced by dreams | `on("resources_discover")` → `skillPaths` | `skills/` of every active scope is offered as a skill path, so a dreamed skill is a first-class pi skill |
| Session-local state | `pi.appendEntry()` | Which facts were injected this session (becomes the outcome entry's `recalled:` / `used:`), ids of journal entries already written — survives resume, never duplicates |
| Capture input | `turn_end`/`agent_end` messages and `ctx.sessionManager.getBranch()` entries filtered by `customType !== "muninn"` | The outcome-entry model never sees Muninn's own injected messages; their ids go to `recalled:` instead |
| Commands and status | `pi.registerCommand()`, status line | `/muninn …`; footer shows scope(s), index tier, and "dream ready" |
| Dreamer model | `ctx.modelRegistry`, `pi.registerProvider()` | Any registered model; offline deployments point `dream.model` at pi's llama-server provider |
| Headless dreams | SDK `createAgentSession()` | `muninn dream` runs the evaluate phase as short, read-only, tool-restricted sessions |
| Sandbox interplay | pi-enclave `SandboxBackend` writable roots | The store path is declared as a writable root; under the ops profile dreams run through the broker |

> [!NOTE]
> `resources_discover` contributes skill, prompt and theme paths but **not** context files,
> so `MEMORY.md` cannot be offered as an AGENTS.md-style context file today; the
> system-prompt path above is the supported route. A `contextFilePaths` contribution is the
> first item under [core changes](#core-changes-to-propose-to-pi).

### Verified at the baseline

The claim that Muninn needs **no pi modification** was checked against the `v0.84.2` source
(sibling checkout `../pi`, commit `914cf14`). For each proposed core change, the gap is real
and the extension-only fallback exists:

| Gap (as proposed below) | What `v0.84.2` actually has | Fallback used by Muninn |
|---|---|---|
| No context-file contribution | `ResourcesDiscoverResult` is exactly `{ skillPaths?, promptPaths?, themePaths? }` (`core/extensions/types.ts:551`) | `before_agent_start` exposes `systemPrompt` and `systemPromptOptions` and accepts a replacement `systemPrompt`, chained across extensions (`types.ts:1102`, applied in `core/agent-session.ts:1254`); re-evaluated every turn |
| No turn summary on `agent_settled` | The event is literally `{ type: "agent_settled" }` (`types.ts:724`, emitted `agent-session.ts:599`) | `turn_end` carries `{ turnIndex, message, toolResults }` and `agent_end` is forwarded to extensions with `messages` (`agent-session.ts:731`); `ctx.sessionManager` is a `ReadonlySessionManager` with `getBranch`, `getLeafId`, `getEntry`, `getEntries`, `getTree`, `getSessionFile` (`core/session-manager.ts:190`) |
| No `embed()` / `rerank()` | Neither operation, nor `/v1/embeddings`, exists anywhere in the monorepo | `ctx.modelRegistry.getApiKeyAndHeaders(model)` returns `{ apiKey, headers, baseUrl?, env }` (`core/model-registry.ts:64`); `baseUrl` falls back to `model.baseUrl` when auth resolution does not supply one |
| No idle hook | The only "idle" in pi is the HTTP dispatcher timeout; nothing in `packages/server` either | Cron / `muninn dream`; polling if ever needed |

Also confirmed: `session_before_compact` (`types.ts:593`) and `session_shutdown`
(`types.ts:616`) exist with the semantics this README assumes, and
`ctx.isProjectTrusted()` (`types.ts:332`) is available for the capture-target decision.

---

## Commands and settings

```
/muninn                     status: scopes, entries since last dream, index tier, pending dreams
/muninn note [--global] <text>   journal entry, source: user, to the capture target (or global)
/muninn promote <id>        copy a project journal entry to the global journal
/muninn search [--history] <query>   memory_search from the TUI
/muninn erase <id>          privacy erasure: tombstone + history rewrite (confirms twice)
/muninn sync                commit journal, fetch, rebase, push
/muninn team review         show the team remote's diff since the pin; advance the pin
/muninn dream [--scope s]   run a dream now (foreground, with progress)
/muninn dreams              list dream branches with reports; remember / forget
/muninn topics|rules        browse; open in $EDITOR
/muninn reindex             delete .index/ and rebuild
/muninn scope               show which scopes are active here and why

muninn dream [--scope s] [--qualify] [--force]   # CLI, headless
muninn serve-cron                                 # prints a crontab / launchd / systemd entry
```

Settings live in pi's settings under `muninn` (global) and `.pi/settings.json` (project,
tighten-only):

```json
{
  "muninn": {
    "scopes": { "global": true, "project": "auto", "team": { "remote": null, "pin": null } },
    "sync": { "remote": null, "onShutdown": true },
    "capture": { "corrections": true, "outcomes": true, "toolFacts": true, "externalPerSession": 10 },
    "recall": {
      "factsPerTurn": 8, "tokenBudget": 1500, "indexTier": "auto",
      "snapshotLines": { "total": 200, "global": 120, "project": 60, "team": 20 },
      "embedding": null, "rerank": null
    },
    "dream": {
      "model": null,
      "auto": false, "autoRemember": false,
      "minHours": 24, "minEntries": 5, "maxEntriesBeforeForce": 50,
      "evalSessions": 5, "canaries": "eval/canaries.md",
      "rulesCap": 60, "retireAfterDays": 90
    }
  }
}
```

`recall.embedding` and `recall.rerank` take `{ provider, model }` and are Tier 1 only;
`dream.model` is a provider/model id, `null` meaning the session model. Strict JSON only —
pi parses `settings.json` with plain `JSON.parse`, so a comment breaks the file for pi as
well as for Muninn.

**Project settings are tighten-only.** A `.pi/settings.json` travels with the repository, so
a project may lower a budget, disable a capture kind, pin a lower index tier or turn a scope
off — never the reverse. Fields where a project value would widen behaviour in a way no
ordering captures are **global-only** and ignored with a warning when a project sets them:
`sync.remote` (where memory is pushed), `recall.embedding` / `recall.rerank` (where memory
is sent), `scopes.team.*`, and every `dream` field (which model reads the whole store).
Violations are reported in `/muninn` and on stderr, never applied silently.

---

## Key decisions

| Decision | Rationale |
|---|---|
| Markdown for everything git sees; JSONL only in the gitignored index | Humans must be able to read, edit and pin memory; diffs of a dream must be reviewable; Obsidian and grep must work. A JSONL journal would duplicate pi's session files, conflict at end-of-file between hosts, and be unreadable in review. |
| The journal is immutable and the only capture target | Goal-directed search over uncompressed history beats fixed compression (SUMER, Memex, LongMemEval-V2). The dreamed layers are a cache; losing them loses nothing. |
| Dream = separate job on a git branch, remembered by fast-forward | Consolidation decoupled from acquisition beats online memory (Auto-Dreamer); the model at *mutation* time is the only placement that handles intent-aware forgetting (ForgetEval); git gives review, rollback and a concurrency model for free (Letta MemFS). |
| One bounded topic per model job, replacement fact list, re-grounded in journal evidence | Monolithic rewrites collapse context (ACE); iterative re-summarisation drifts (SSGM). Bounded regions are also what makes a 4–9B model sufficient. |
| Supersede, never delete; audit rows; **active-only recall by default** | Stale facts are the #1 user complaint; bitemporal metadata with audit rows is the measured fix (TOKI, Zep) — and it only works if retrieval honours it, hence `supersessions.md` reaching the journal layer. |
| `source` / `channel` / `recalled` kept apart; echoes excluded | A memory system that counts its own output as corroboration converges on whatever it said first (MemSyco-Bench). Three fields cost three lines; collapsing them costs the provenance story. |
| Whole-store sync over git, derived-only for team | A dreamed layer without its journal is unsourced by definition; per-host journal files make whole-store sync conflict-free, and the team boundary is where trust changes, so it is where the journal stops. |
| UUIDv7 for every cited id; claims, not entries, as the unit | Any scheme built from names, counters or truncated hashes has a collision story that has to be argued; a full UUIDv7 has none, and it sorts by time. The cost is diff readability, paid once. Claim-level ids are what let supersession, retrieval and lint agree on one granularity. |
| Fact-level 3-way merge, model only for the residue | Dreams from different journals rewrite the same topic in ways line-merge cannot reconcile; but most conflicts are structural and free, and the semantic residue is a bounded consolidate job the qualification fixture can measure. |
| Provenance classes and a promotion gate | Memory poisoning and memory-induced sycophancy are benchmarked failure modes; an `external` fact must never become a rule without a human. |
| Phase tags and cues written at capture time | Subtask-aligned memory beats instance-level memory on SWE tasks; write-time cues make facts reachable by situation (T-Mem). |
| Insights, not traces | High-level insights transfer across tasks and models; raw traces cause negative transfer (Memory Transfer Learning, ERL). The journal keeps the trace pointer; the topic keeps the lesson. |
| Bounded rules with identities, retirement by disuse | Stable-size skill banks outperform growing ones (CODESKILL); retirement instead of deletion keeps the record. |
| Frozen snapshot per session, dreams apply next session | Prompt-cache stability and context consistency (Hermes, pi-dream). |
| Tools over files rather than only auto-RAG | Agent-controlled memory tools generalise across scenarios; fixed pipelines do not (AutoMEM). |
| Tier 0 has no native dependencies; Tier 1 uses pi's own llama-server provider | An air-gapped install must work with `pi install`; an operator who stages models gets better recall without a second ML runtime in-process. Tier 1 failure is loud. |
| Evaluate on the operator's own recent tasks | Chat-recall benchmarks saturate and mislead (Anatomy of Agentic Memory); the only score that matters is whether *this* store helps *these* tasks. |

---

## Prior art, reuse and credits

Surveyed before starting. None combines an immutable markdown journal, offline dreaming with
a small local model, bitemporal supersession, provenance-gated promotion, phase-tagged
procedural memory, and global/project/team scoping in one pi extension.

### pi ecosystem

| Project | What it does | Why not just use it |
|---|---|---|
| [pi-dream](https://github.com/barryking/pi-dream) | Markdown memory in local git, repository and shared stores, dreams into a separate store you review and "remember" for the next session, `/memory recover` | Closest in spirit; no journal, no search index, no provenance or supersession, frontier-model dreams. Its remember-next-session and recovery semantics are adopted here with credit |
| [pi-memory](https://github.com/jayzeng/pi-memory) | `MEMORY.md` + daily logs + scratchpad, optional [qmd](https://github.com/tobi/qmd) hybrid search, stable-bytes injection for KV cache | No dreaming, global scope only. Its cache-stable snapshot idea is adopted |
| [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory) | Hermes port: tiny core memory + SQLite FTS5 session search, background review every N turns, secret scanning, global + project | In-session review rather than offline dreaming; no provenance or supersession |
| [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory), [pi-blackhole](https://github.com/k0valik/pi-blackhole) | In-session observer/reflector that replaces compaction | Session-scoped; complementary, not overlapping |
| [pi-memory-md](https://github.com/VandeeFeng/pi-memory-md), [@josephakern/pi-memory](https://github.com/josephkern/pi-memory), `@askjo/pi-mem` | Markdown stores, git-backed or committed per project, 200-line caps | No consolidation, grep-only |
| [Signet](https://github.com/Signet-AI/signetai) | Cross-harness memory daemon with a dreaming ontology pass | External daemon, not offline-first, not pi-native |

### Elsewhere

| Project | Adopted from it |
|---|---|
| Claude Code auto-dream | Dual trigger (time **and** volume), signal gathering by *search for corrections*, relative→absolute dates, index line budget, lock file, memory-dir write sandbox, reviewable diff |
| Letta MemFS / Context Repositories | Git as the store, worktree-isolated dreams merged by git, defrag as a distinct maintenance op |
| OpenClaw Dreaming | Light → REM → Deep staging, score-gated promotion, "reject a dream that loses > 25 % of entries", pre-image for rollback |
| Hermes Agent | Frozen snapshot at session start, hard caps that force curation, Curator retirement (active → stale → archived) |
| Codex memories | Per-rollout extraction then global-lock consolidation; prune unused after 30 days |
| Karpathy's LLM Wiki | Ingest / query / **lint** as separate workflows; human pins survive regeneration; append-only log + compiled pages |
| qmd | Heading-aware chunking with break-point scoring, content-hash incremental reindex, RRF + rerank recipe |
| Basic Memory | Flat observation lines with categories, wikilinks as relations, index derived from files and rebuildable |
| pi-enclave | Secret regex set, direct-user provenance rule, tighten-only project configuration, "attendance is a setting" |

### Research credits

The design choices above lean on, in particular: Auto-Dreamer (arXiv 2605.20616) and Letta's
sleep-time compute (2504.13171) for offline consolidation; ForgetEval (2606.15903), TOKI
(2606.06240) and Zep (2501.13956) for forgetting and bitemporal supersession; Memory Transfer
Learning (2604.14004), ERL (2603.24639), CODESKILL (2605.25430), subtask-level SWE memory
(2602.21611) and ReasoningBank (2509.25140) for what to remember in a coding agent; ACE
(2510.04618) and SSGM (2603.11768) for why bounded rewrites; SUMER (2511.21726), Memex(RL)
(2603.04257) and LongMemEval-V2 (2605.12493) for keeping the raw layer searchable; RecMem
(2605.16045) for recurrence gating; T-Mem (2606.15405) for write-time cues; AutoMEM
(2606.04315) for tools over pipelines; MPBench (2606.04329), MemSyco-Bench (2607.01071) and
the memory-lifecycle security survey (2604.16548) for the trust model; and "Anatomy of
Agentic Memory" (2602.19320) for distrusting chat benchmarks. Structured-output limits of
small models: 2605.26128, 2605.02363.

---

## Delivery plan

### The v1 cut

- **Global and project scope**; team scope is configuration only (a remote), no tooling.
- **Tier 0 index only.** BM25 + links; no embeddings. Tier 1 is Phase 4.
- **Dreams are manual** (`/muninn dream`), remembered by hand. Auto-trigger and
  auto-remember are Phase 3, after the evaluate phase exists.
- **No skills output.** Dreams write topics and rules; dreamed skills are Phase 5.
- **Local-model qualification fixture ships in v1**, because offline is the point.

Phases are ordered so each is independently useful and the riskiest assumption — that a
small local model can dream well enough — is validated before anything depends on it.

### Phase 1 — Journal and recall

*Outcome: pi sessions leave a journal, and the next session can find it.*
Implementation plan: [docs/phase-1-plan.md](docs/phase-1-plan.md).

Capture (explicit, corrections, outcomes, pre-compaction), secret redaction, per-host journal
directories with locked appends, UUIDv7 ids and claim bullets, `task`/`continues`
grouping, capture-target scope, journal commits,
`store.md` with schema version and host registry, Tier 0 index, the three tools, frozen
`MEMORY.md` snapshot (hand-written at first), `muninn sync`,
`/muninn note|promote|search|scope|reindex|sync`. Done when: a correction made on Monday on
one laptop is surfaced by `memory_search` on Tuesday on another laptop in a different
project directory, nothing outside `journal/` was written, and two concurrent sessions on
one host produce a well-formed daily file.

### Phase 2 — Dreaming, manual

*Outcome: a dream produces a reviewable branch from the journal, with a local model.*

Orient / gather / consolidate / lint / commit; topic file format with fact ids;
supersession into `supersessions.md` and active-only recall; echo exclusion; the
journal→dream apply transaction with marker and recovery; fact-level 3-way merge and the
merge dream; `MEMORY.md` regeneration with
per-scope budgets; dream reports; `/muninn dreams` remember / forget; `/muninn erase`;
`--qualify` fixture and reference results for Qwen3.5-4B, Qwen3.5-9B, Qwen3.6-35B-A3B and one
frontier model. Done when: the fixture store dreamed by a 9B model yields zero unsourced
facts, every superseded fact retains its audit row and its evidence is absent from default
`memory_search`, a dream remembered while capture committed ten entries lands without
conflict, and the diff is readable in `git log -p`.

### Phase 3 — Evaluate, auto-dream, promotion gate

*Outcome: dreams can be trusted to run unattended.*

Held-out evaluate phase over the SDK with canaries; auto-trigger with lock; auto-remember
behind lint + eval; provenance gate on `rules.md`; `muninn serve-cron` and the documented
nightly sync → dream → sync deployment. Done when: a dream that would retire a
`source: user` rule is blocked, a dream that resurfaces a superseded canary is not
auto-remembered, and a dream that regresses held-out hit rate is not auto-remembered.

### Phase 4 — Tier 1 retrieval

*Outcome: better recall on large stores, still offline.*

`better-sqlite3` FTS5 + trigram, embeddings and rerank over the Tier 1 endpoint contract,
RRF, loud fallback to Tier 0, `use_count` / `last_used` reinforcement derived from `used:`.
Done when: a 20k-entry
store answers `memory_search` in < 300 ms with rerank on a CPU-only host, and unplugging the
embedding endpoint degrades to Tier 0 with a visible warning.

### Phase 5 — Skills, team scope, enclave profile

Dreamed skills via `resources_discover`; team remote with pinning, `/muninn team review`
and per-rule promotion; declared writable roots and broker path under pi-enclave;
per-project "committed vs separate store" migration command; palantír idle hook only if
cron and manual operation have shown it is needed.

### Platform matrix

| | Tier 0 | Tier 1 | Dreamer |
|---|---|---|---|
| macOS arm64 / x64 | ✓ | ✓ (`better-sqlite3` prebuilt) | llama-server, Ollama, any provider |
| Linux x64 / arm64 | ✓ | ✓ | same; CPU-only reference numbers published |
| Windows | ✓ | ✓ (prebuilt) | Ollama / remote endpoint |
| Bun | ✓ | `bun:sqlite` needs a custom SQLite on macOS — documented, not supported in v1 | ✓ |
| Air-gapped | ✓ | ✓ with pre-staged GGUF models | ✓ with pre-staged GGUF |

---

## Core changes to propose to pi

All of the above works as an extension — [verified](#verified-at-the-baseline) against
`v0.84.2`. Four small core changes would make it cleaner, and would help every memory
extension, not only this one:

1. **`contextFilePaths` in `resources_discover`.** Today an extension can contribute skills,
   prompts and themes but not context files, so a memory index has to be spliced into the
   system prompt by hand and shows up nowhere in `/context` or `systemPromptOptions.contextFiles`.
   Letting an extension offer an AGENTS.md-style file (with its own budget and provenance
   label) would make memory visible and inspectable like any other context.
2. **A stable turn-summary payload on `agent_settled`.** Extensions that want an outcome
   record currently accumulate `turn_end` / `agent_end` payloads themselves and reconcile
   them against `ctx.sessionManager` to find the run's boundaries. A
   `{ firstEntryId, lastEntryId, toolCalls, usage }` on the event would let every memory
   and telemetry extension skip that bookkeeping. Lowest priority of the four: the
   accumulation approach is adequate, and this is an ergonomics ask rather than a gap.
3. **`embed()` and `rerank()` on providers.** The llama-server and OpenAI-compatible
   providers already hold the base URL and credential for endpoints that serve
   `/v1/embeddings` and `/v1/rerank`; exposing those two operations through `ModelRegistry`
   would let every retrieval extension share one configuration, one timeout policy and one
   capability check instead of each re-implementing the
   [endpoint contract](#the-index).
4. **An idle hook.** `pi` has no notion of "no session has been active for *T*". A
   process-level `idle` event (or an `--on-idle <command>` flag for `pi server`) is what a
   dreamer and a palantír daemon both need; both currently poll. **Deferred**: this ask is
   made only if cron and manual dreams prove insufficient in practice.

None of these is implemented yet — [`frycm/pi`](https://github.com/frycm/pi) is at upstream
`v0.84.2` with no patches at the time of writing. When a patch exists it will be linked here
by branch and commit, and upstreamed with Muninn as the motivating use case under the same
fork policy as the sibling projects: rebased on every stable release, only these patches,
deleted as they land.

---

## Open questions and risks

### Residual risks

- **A small model can dream badly in ways lint cannot catch** — a plausible, well-sourced,
  wrong generalisation. The evaluate phase and the review gate bound this; they do not
  eliminate it. Until Phase 3 exists, dreams are manual for that reason.
- **Memory in a committed project store is visible to everyone with the repository.** That is
  the point of team scope, and also why the default is a separate store and why secret
  scanning runs at capture *and* dream time.
- **Provenance is a label, not a proof.** `source: user` is assigned from pi's direct-input
  events; a compromised extension in the same process could forge it. Same outer-ring caveat
  as pi-enclave.
- **Correction detection is heuristic.** A missed correction is a gap in the journal, not a
  wrong fact; a false positive is a `source: user` entry the dream will weigh heavily. The
  classifier errs toward asking (`/muninn note` confirmation) in attended sessions.

### Decided in v0.2

- **`MEMORY.md` budget.** Per-scope reserved budgets under one total cap
  (`recall.snapshotLines`, default 120 / 60 / 20 of 200). A scope that underuses its
  reservation lends the remainder to the others; overflow within a scope drops least-used
  facts from the snapshot, which stay searchable.
- **Where the project store lives.** Separate store by default, keyed by git toplevel and
  synced on its own remote; committed stores remain an opt-in for projects that want memory
  in their history. Migration command in Phase 5.
- **Evaluate-phase cost.** Chronological held-out sample of *k* recent tasks plus a fixed
  canary set, not a replay of everything; the canaries are cheap and run every dream, the
  sample size is a setting.
- **Idle hook.** Deferred until cron and manual dreams prove insufficient.
- **Sharing across machines.** Whole-store sync over a private git remote; derived-only
  sharing is reserved for team scope, where the trust boundary is
  ([Sync](#sync--one-store-many-hosts)).

### Open questions

- **Echo detection threshold.** Token overlap ≥ 0.8 against recalled text is a guess; too
  low and genuine re-observations are discounted, too high and paraphrased echoes pass.
  The qualification fixture will carry labelled echo cases so the threshold is measured.
- **Erasure and committed project stores.** `/muninn erase` rewrites history; in a store
  committed inside the product's repository that means rewriting the *product's* history,
  which may be unacceptable. Likely answer: refuse erase in committed stores and require
  migrating to a separate store first.
- **Merge-dream quality with small models.** The merge job sees two candidate lists and
  must keep one coherent result; it is the hardest prompt in the system for a 4–9B model.
  If the qualification fixture shows it is markedly worse than plain consolidation, the
  fallback is a `dream.host` setting ("only this host dreams this scope"), which turns
  cross-host conflicts from systematic into rare.
- **How much of compaction to reuse.** `session_before_compact` gives the entries about to
  be summarised; Muninn writes its own outcome entry rather than parsing pi's summary. If
  pi's summaries turn out to be good evidence, a journal entry could simply reference the
  compaction entry and save a model call.
- **Hermes-style hard caps on the rules file** (error at the cap, forcing curation) versus
  soft retirement. v1 does soft retirement with a lint failure at the cap; a hard cap is one
  setting away if soft proves too soft.
- **Tier 0 semantic recall.** model2vec in pure TS is unproven in this codebase; if it
  disappoints, Tier 0 stays lexical and the README says so.

---

## Why this name

Muninn (Old Norse *Muninn*, "memory" or "mind") is one of Odin's two ravens. Each dawn he
and Huginn ("thought") fly out over the world; each evening they return and tell Odin what
they saw. That is this extension's loop exactly: range over the day's sessions, come back at
night, report what is worth keeping. And Odin's line — that he fears more for Muninn than
for Huginn — is the thesis of the 2026 memory research in one sentence: losing memory is the
worse failure.

It sits in the same mythic register as its siblings: **palantír** (Tolkien's seeing-stone:
watch and speak from afar), **enclave** (the walled, trusted place), **muninn** (the memory
that flies out and returns). Tolkien drew the palantíri's era from the Eddas; the family
reads as one lineage.

Considered and rejected: `pi-dream` (taken, and a direct neighbour), `pi-engram` and
`pi-mnemosyne` (taken), `pi-lorien` (Irmo, the Vala of dreams — apt, but pure Tolkien twice
over), `pi-mimir` (the well of wisdom — apt, but Grafana owns the search results),
`pi-redbook` (the Red Book of Westmarch — the journal, not the dreaming).

---

## License

[MIT](LICENSE) — matching pi and the wider pi extension ecosystem.
