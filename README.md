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
> **Status: design proposal (v0.1). No implementation yet.**
> This README is the design document, published first so the architecture can be reviewed
> and argued with before any code exists. Every section is a commitment to be tested, not a
> description of working software. It will shrink into a normal project README as phases
> land.

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
- **Supersession, not deletion.** Facts carry `valid_from` / `superseded_by`; losers stay as
  audit rows. "What did I believe last month and why did it change" is answerable.
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
- Cloud sync, multi-tenant stores, or a hosted service. Team scope is a git remote.
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

### File layout (one scope)

```
muninn/
├─ MEMORY.md                    # index: one line per topic/rule, ≤ 200 lines; regenerated by dream
├─ journal/
│  ├─ 2026-08-22.mfryc-mbp.md   # per-day, per-host: two machines never append to the same file
│  └─ 2026-08-22.ops-1.md
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
## 14:32 · j-20260822-0412
source: user
session: ~/.pi/agent/sessions/--Users-mfryc-src-app--/01J…jsonl#e5f6g7h8
phase: test
cue: when vitest hangs in CI

Martin asked to always run `pnpm test --run` — watch mode hangs the CI job.
Correction of an earlier assumption (see j-20260819-0107).
```

| Field | Values | Purpose |
|---|---|---|
| `source` | `user` · `agent` · `tool` · `external` | [Provenance](#trust-and-provenance). `user` is only text the user typed; `agent` is the model's own inference; `tool` is derived from tool output; `external` is from fetched or repo content. |
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

- **Run tests with `pnpm test --run`, never watch mode.** valid_from: 2026-08-22 · source: user · evidence: j-20260822-0412 · cue: CI hangs on vitest
- **Integration tests need `DATABASE_URL` pointing at the docker compose db.** valid_from: 2026-07-30 · source: tool · evidence: j-20260730-0021, j-20260802-0118

## Superseded

- ~~Tests run with `pnpm test`.~~ valid_from: 2026-08-01 · superseded_by: j-20260822-0412 · reason: user correction — watch mode hangs CI
```

A fact line is one bullet: bolded claim, then a ` · `-separated flat trailer. Supersession
moves the line to `## Superseded` with `superseded_by` and `reason`; nothing is deleted by a
dream. `last_used` / `use_count` are tracked in `.index/`, not in the file, so recall does
not dirty git.

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
                         │ append                    │  5 evaluate replay recent tasks       │
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
the same files, so there is no in-process lock to get wrong; a dream lock file guards only
against two dreams.

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
   with a strict template. Failures are memory too.
4. **Pre-compaction** — `session_before_compact` fires before context is summarised away;
   Muninn writes the outcome entry then, so nothing that compaction drops is lost to the
   journal. It does not alter pi's compaction.
5. **Tool-derived facts** — environment gotchas discovered through tool output (a port in
   use, a flag that does not exist, a version mismatch). `source: tool`.

Every entry runs through **secret scanning** (the same regex set pi-enclave uses for its
audit log, plus high-entropy detection) before it is written; a hit is redacted and the
entry marked `redacted: true`. Capture never writes outside `journal/` and never writes to
project scope unless the project is trusted.

**Hosts and clocks.** Journal files are per day *and per host*; two machines sharing a store
over git therefore never conflict at end-of-file. Entry ids are `j-<yyyymmdd>-<seq>` with a
per-host sequence; timestamps are local with offset.

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
| `memory_search({ query, scope?, phase?, kind?, limit? })` | Hybrid search over journal, topics and rules; returns ids, dates, sources, snippets and heading paths |
| `memory_read({ id \| path, range? })` | Read a topic file, a rule, a journal entry, or — by `session:` pointer — the underlying session entries |
| `memory_note({ text, phase?, cue? })` | Append a `source: agent` journal entry. The *only* write tool; it cannot touch topics or rules |

The tools are small on purpose. The model does the reasoning; Muninn does the indexing.

### The index

The index is derived from markdown by content hash and can be deleted at any time. Two
tiers, selected by what is installed:

| Tier | Dependencies | Gives |
|---|---|---|
| **0 — always** | none native; Node and Bun | `minisearch` BM25 over heading-path chunks (fields: title, heading path, cue, body, tags — weighted), wikilink/backlink graph, phase and source filters. Optionally static embeddings ([model2vec](https://github.com/MinishLab/model2vec) `potion-base-8M`, ~30 MB) via a pure-TS loader and brute-force cosine — cheap semantic recall with no ONNX runtime. |
| **1 — opt-in** | `better-sqlite3` (bundled FTS5 + trigram tokenizer); embeddings and reranking through pi's **llama-server** provider (`/v1/embeddings`, `/v1/rerank`) or Ollama — no in-process native ML runtime | FTS5 with fuzzy matching, EmbeddingGemma-300M (or Qwen3-Embedding-0.6B) vectors stored as BLOBs and scanned brute-force (a few tens of ms under 100k chunks), `bge-reranker-v2-m3` over the top 30, reciprocal-rank fusion (k = 60) with an all-terms-in-title boost |

Chunking follows qmd's rules: split at heading boundaries, carry the `H1 › H2 › H3`
breadcrumb in every chunk, cap at ~700 tokens, never split a fenced block, re-embed only
chunks whose hash changed. `node:sqlite` is deliberately not used: pi's prebuilt Node
binaries lack FTS5 and extension loading is unreliable there; `better-sqlite3` runs on Node
and Bun and bundles its own SQLite. Tier 1 failing to load **falls back to Tier 0 loudly**
— the silent-vector-failure bug class (OpenClaw #65156) is explicitly designed out.

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
- A lock file with pid and timestamp; stale after 2 h. Dreams never run concurrently against
  one store; different scopes may dream in parallel.
- The dream works in a **git worktree** on branch `dream/<timestamp>`. The working store is
  never touched until *remember*.

### Phases

| | Phase | What happens | Bound |
|---|---|---|---|
| 1 | **Orient** | Read `MEMORY.md`, the last dream report, `rules.md`. Build the list of topics and their evidence sets. | one read |
| 2 | **Gather** | *Search*, not read: journal entries since the last dream; `source: user` corrections; entries whose `cue` or body recurs ≥ 2 times across sessions; decisions; failures. Optionally open the session files behind an entry for evidence. Single-occurrence `agent`/`tool` entries stay in the journal and are not promoted (recurrence gating). | top-K per query |
| 3 | **Consolidate** | For each affected topic, **one bounded job**: the model sees the current topic file, the new evidence, and emits a replacement **fact list** — not free text — with `supersedes` and `evidence` per item. Muninn applies it: new facts added, superseded facts moved to `## Superseded`, nothing deleted. Relative dates become absolute. A job that loses > 25 % of a topic's facts is rejected. | one topic per job, ≤ 40 facts |
| 4 | **Lint** | Deterministic: every fact cites an existing journal id; no two facts contradict within a topic (pairwise, model-judged only when keyword overlap is high); `rules.md` within its cap; rules unused > 90 days proposed for retirement; orphans in `MEMORY.md`. Findings go in the report, and blocking ones (unsourced fact, cap exceeded) fail the dream. | — |
| 5 | **Evaluate** | Replay the last *k* (default 5) completed tasks from the journal with the *old* and *new* `MEMORY.md` + recall, headless, asking only "would recall have surfaced the fact that mattered?" — a cheap proxy for the downstream reward that Auto-Dreamer trains on. A regression blocks auto-remember and is flagged for review. | k sessions, read-only tools |
| 6 | **Commit** | Regenerate `MEMORY.md` (≤ 200 lines, ordered by `use_count` then recency), write `dreams/<ts>.md`, commit on the branch with a trailer listing touched topics and journal ids. | — |

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

Further controls:

- **Write scope.** The session extension writes only `journal/`; the dreamer writes only
  its worktree. Neither can write outside the store. Under pi-enclave both paths are also
  OS-enforced — the store is a declared writable root and nothing else is.
- **Secrets** are redacted at capture and re-scanned at dream time; a topic fact that would
  carry a secret is refused.
- **Project trust.** Project-scope memory is loaded and written only when pi's own project
  trust gate says the project is trusted. A committed `.pi/muninn/` in a freshly cloned
  untrusted repository is inert.
- **Team scope is read-only by default** and its rules are labelled `scope: team`; promoting
  a team rule to global is a human action.
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
| Outcome entry | `on("agent_settled")` | The run is over and pi will not continue on its own; write one phase-tagged outcome entry using `ctx.modelRegistry.complete()` with the session model (or `dream.model` when configured) |
| Journal before compaction | `on("session_before_compact")` | Write the outcome entry *before* the summary is produced; return nothing so pi's compaction proceeds unchanged |
| Evidence pointers | `ctx.sessionManager.getSessionFile()`, entry ids | `session:` field in journal entries; `memory_read` follows it |
| Skills produced by dreams | `on("resources_discover")` → `skillPaths` | `skills/` of every active scope is offered as a skill path, so a dreamed skill is a first-class pi skill |
| Session-local state | `pi.appendEntry()` | Which facts were injected this session (for `use_count`), ids of journal entries already written — survives resume, never duplicates |
| Commands and status | `pi.registerCommand()`, status line | `/muninn …`; footer shows scope(s), index tier, and "dream ready" |
| Dreamer model | `ctx.modelRegistry`, `pi.registerProvider()` | Any registered model; offline deployments point `dream.model` at pi's llama-server provider |
| Headless dreams | SDK `createAgentSession()` | `muninn dream` runs the evaluate phase as short, read-only, tool-restricted sessions |
| Sandbox interplay | pi-enclave `SandboxBackend` writable roots | The store path is declared as a writable root; under the ops profile dreams run through the broker |

> [!NOTE]
> `resources_discover` contributes skill, prompt and theme paths but **not** context files,
> so `MEMORY.md` cannot be offered as an AGENTS.md-style context file today; the
> system-prompt path above is the supported route. A `contextFilePaths` contribution is the
> first item under [core changes](#core-changes-to-propose-to-pi).

---

## Commands and settings

```
/muninn                     status: scopes, entries since last dream, index tier, pending dreams
/muninn note <text>         journal entry, source: user
/muninn search <query>      memory_search from the TUI
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

```jsonc
{
  "muninn": {
    "scopes": { "global": true, "project": "auto", "team": { "remote": null, "readOnly": true } },
    "capture": { "corrections": true, "outcomes": true, "toolFacts": true, "externalPerSession": 10 },
    "recall": { "factsPerTurn": 8, "tokenBudget": 1500, "indexTier": "auto" },
    "dream": {
      "model": null,                  // provider/model id; null = session model
      "auto": false, "autoRemember": false,
      "minHours": 24, "minEntries": 5, "maxEntriesBeforeForce": 50,
      "evalSessions": 5, "rulesCap": 60, "retireAfterDays": 90
    }
  }
}
```

---

## Key decisions

| Decision | Rationale |
|---|---|
| Markdown for everything git sees; JSONL only in the gitignored index | Humans must be able to read, edit and pin memory; diffs of a dream must be reviewable; Obsidian and grep must work. A JSONL journal would duplicate pi's session files, conflict at end-of-file between hosts, and be unreadable in review. |
| The journal is immutable and the only capture target | Goal-directed search over uncompressed history beats fixed compression (SUMER, Memex, LongMemEval-V2). The dreamed layers are a cache; losing them loses nothing. |
| Dream = separate job on a git branch, remembered by fast-forward | Consolidation decoupled from acquisition beats online memory (Auto-Dreamer); the model at *mutation* time is the only placement that handles intent-aware forgetting (ForgetEval); git gives review, rollback and a concurrency model for free (Letta MemFS). |
| One bounded topic per model job, replacement fact list, re-grounded in journal evidence | Monolithic rewrites collapse context (ACE); iterative re-summarisation drifts (SSGM). Bounded regions are also what makes a 4–9B model sufficient. |
| Supersede, never delete; audit rows | Stale facts are the #1 user complaint; bitemporal metadata with audit rows is the measured fix (TOKI, Zep). |
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

Capture (explicit, corrections, outcomes, pre-compaction), secret redaction, per-host journal
files, Tier 0 index, the three tools, frozen `MEMORY.md` snapshot (hand-written at first),
`/muninn note|search|scope|reindex`. Done when: a correction made on Monday is surfaced by
`memory_search` on Tuesday in a different project directory, and nothing outside `journal/`
was written.

### Phase 2 — Dreaming, manual

*Outcome: a dream produces a reviewable branch from the journal, with a local model.*

Orient / gather / consolidate / lint / commit; topic file format; supersession; `MEMORY.md`
regeneration; dream reports; `/muninn dreams` remember / forget; `--qualify` fixture and
reference results for Qwen3.5-4B, Qwen3.5-9B, Qwen3.6-35B-A3B and one frontier model. Done
when: the fixture store dreamed by a 9B model yields zero unsourced facts, every superseded
fact retains its audit row, and the diff is readable in `git log -p`.

### Phase 3 — Evaluate, auto-dream, promotion gate

*Outcome: dreams can be trusted to run unattended.*

Replay-based evaluate phase over the SDK; auto-trigger with lock; auto-remember behind
lint + eval; provenance gate on `rules.md`; `muninn serve-cron`; palantír idle hook. Done
when: a dream that would retire a `source: user` rule is blocked, and a dream that makes
recall regress on the replay set is not auto-remembered.

### Phase 4 — Tier 1 retrieval

*Outcome: better recall on large stores, still offline.*

`better-sqlite3` FTS5 + trigram, embeddings and rerank through llama-server / Ollama, RRF,
loud fallback to Tier 0, `use_count` / `last_used` reinforcement. Done when: a 20k-entry
store answers `memory_search` in < 300 ms with rerank on a CPU-only host, and unplugging the
embedding endpoint degrades to Tier 0 with a visible warning.

### Phase 5 — Skills, team scope, enclave profile

Dreamed skills via `resources_discover`; team remote with read-only default and promotion
command; declared writable roots and broker path under pi-enclave; per-project "committed
vs separate store" migration command.

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

All of the above works as an extension. Three small core changes would make it cleaner, and
would help every memory extension, not only this one:

1. **`contextFilePaths` in `resources_discover`.** Today an extension can contribute skills,
   prompts and themes but not context files, so a memory index has to be spliced into the
   system prompt by hand and shows up nowhere in `/context` or `systemPromptOptions.contextFiles`.
   Letting an extension offer an AGENTS.md-style file (with its own budget and provenance
   label) would make memory visible and inspectable like any other context.
2. **A stable turn-summary payload on `agent_settled`.** Extensions that want an outcome
   record currently re-walk `ctx.sessionManager` to find the turn's boundaries. A
   `{ firstEntryId, lastEntryId, toolCalls, usage }` on the event would remove a class of
   off-by-one bugs across memory and telemetry extensions.
3. **An idle hook.** `pi` has no notion of "no session has been active for *T*". A
   process-level `idle` event (or an `--on-idle <command>` flag for `pi server`) is what a
   dreamer and a palantír daemon both need; both currently poll.

These are prototyped in [`frycm/pi`](https://github.com/frycm/pi) and upstreamed with Muninn
as the motivating use case, under the same fork policy as the sibling projects: rebased on
every stable release, only these patches, deleted as they land.

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

### Open questions

- **Global `MEMORY.md` budget across many projects.** 200 lines is Claude Code's number and
  it overflows for heavy users within a month. Muninn's index is ordered by `use_count`, so
  the overflow is "least-used facts drop out of the snapshot but stay searchable" — is that
  the right failure mode, or should the budget be per scope?
- **Where the project store lives.** Committed (`.pi/muninn/` in the repo — shareable, but
  every dream is a commit in the product's history) versus separate (keyed by git toplevel —
  clean, but needs the team remote for sharing). Default is separate; the migration command
  is Phase 5. Expect to revisit after use.
- **Evaluate-phase cost.** Replaying five sessions headless with a local model is minutes,
  not seconds. Is it acceptable nightly on a CPU-only server, or should it sample?
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
