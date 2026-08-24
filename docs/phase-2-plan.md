# Phase 2 — Dreaming, manual: implementation plan

*Outcome: a dream produces a reviewable branch from the journal, with a local model.*

This plan turns the Phase 2 section of the [README](../README.md#phase-2--dreaming-manual)
into an ordered sequence of steps, each with a "done when", in the shape of
[docs/phase-1-plan.md](phase-1-plan.md). It is written against the Phase 1 code as merged
(`17cb0ea`) and pi `v0.84.2`, checked out as the sibling `../pi`; file references of the
form `core/…` are relative to `../pi/packages/coding-agent/src/`. Nothing here requires a
pi modification.

## Scope

**In:** the dream job — orient / gather / consolidate / lint / commit — on a git worktree
and a `dream/<host>/<ts>` branch · topic file format with fact ids, a writer to go with the
reader Phase 1 already has · supersession *writing* into `supersessions.md` (recall has been
active-only since Phase 1; this is the first thing that populates it) · echo exclusion and
recurrence gating in gather · the held-out task groups (withheld and listed; *scored* in
Phase 3) · the journal→dream apply transaction with the `.remember` marker and its recovery
· fact-level 3-way merge, residue detection and the merge dream · `MEMORY.md` regeneration
with per-scope budgets · dream reports · `/muninn dream`, `/muninn dreams` with remember /
forget, `/muninn topics|rules`, `/muninn erase` · `muninn dream [--scope] [--qualify]
[--force]` headless · the `--qualify` fixture store, its scorer, and a reference-results
table for Qwen3.5-4B, Qwen3.5-9B, Qwen3.6-35B-A3B and one frontier model.

**Out (later phases):** the evaluate phase and canaries (Phase 3 — gather *holds out* the
task groups so the evaluate phase can be added without changing what consolidation sees),
auto-trigger and auto-remember (Phase 3), the `rules.md` promotion gate and **rule
derivation** (see [Decisions](#decisions-made-by-this-plan) — Phase 2 reads and lints
`rules.md`, it does not write rules), `muninn serve-cron` (Phase 3, it exists to run the
auto-dream), Tier 1, team scope, skills, the `dream.host` fallback (only if the
qualification fixture shows the merge dream is markedly worse than consolidation).

**Acceptance (from the README):** the fixture store dreamed by a 9B model yields zero
unsourced facts; every superseded fact retains its audit row and its evidence is absent from
default `memory_search`; a dream remembered while capture committed ten entries lands
without conflict; and the diff is readable in `git log -p`.

## Ground rules

Phase 1's ground rules stand (TypeScript/ESM, Node ≥ 22.19, Bun for everything non-native,
thin entry, fail loud, `git` only through `src/git.ts`). Four more for this phase:

- **Phases 1, 4 and 6 are code; 2 and 3 are where the model runs.** Orient, lint, `MEMORY.md`
  and the commit are deterministic and fully unit-tested without a model. Gather is
  deterministic too (it is *search*, not judgement); the model sees only the consolidate job
  and — in step 9 — the merge job. Anything that can be decided by code is.
- **A dream writes only its worktree; remember writes only derived paths.** The allow-list
  in `src/git.ts` already names every derived path (`MEMORY.md`, `supersessions.md`,
  `topics/`, `rules.md`, `dreams/`, `skills/`); this phase adds the git *verbs* a dream
  needs, each as a typed `GitCommand` variant with its own test, and nothing that can
  rewrite `main` except `erase`, which gets its own variant and its own confirmation.
- **No new runtime dependency.** The model is reached through pi (`ctx.modelRegistry` in a
  session, `ModelRuntime` from `@earendil-works/pi-coding-agent` in the CLI — see
  [headless](#headless-dreams-and-the-model)). The 3-way merge, the fact-line grammar and
  the JSON-block parser are small and in-tree.
- **Every dream is a commit range.** `input_head` and `journal_through` are recorded before
  the model runs; "what has this store not learned from" is `git diff input_head..main --
  journal/`, and every test that asserts what a dream saw asserts it from the report.

## Repository layout (additions)

```
src/
├─ git.ts                      # + worktree-add/remove/prune, branch-list/delete, merge-ff-only,
│                              #   revert, checkout-paths, rev-list, diff-name-only, merge-base,
│                              #   filter-repo, push-force (erase only)
├─ topics/
│  ├─ format.ts                # topic file ⇄ { facts, superseded, prose }; fact-line grammar
│  │                           #   (parseFactLine moves here from index/chunk.ts)
│  ├─ write.ts                 # apply a fact list: mint ids, move to ## Superseded, valid_to
│  └─ use-count.ts             # use_count / last_used per fact id from journal `used:`
├─ journal/
│  ├─ supersessions.ts         # + appendSupersessions(storePath, lines[])
│  └─ erasures.ts              # journal/erasures.md reader + writer; tombstone line
├─ dream/
│  ├─ dream.ts                 # the orchestrator: lock → worktree → phases → report → commit
│  ├─ worktree.ts              # create / reuse / gc dream worktrees; branch naming
│  ├─ orient.ts                # read MEMORY.md, last report, rules.md; topic → evidence map
│  ├─ gather.ts                # range, active-only, echo exclusion, recurrence, hold-out
│  ├─ consolidate.ts           # job builder, prompt, flat-JSON parse + one retry, guards
│  ├─ model.ts                 # DreamModel interface; session + headless implementations
│  ├─ lint.ts                  # deterministic checks; blocking vs advisory findings
│  ├─ memory-md.ts             # MEMORY.md regeneration: per-scope budgets, ordering, preamble
│  ├─ report.ts                # dreams/<ts>.md ⇄ DreamReport (input_head, journal_through, …)
│  ├─ remember.ts              # the apply transaction, .remember marker, recovery on open
│  ├─ forget.ts                # revert of a remember commit through the same transaction
│  ├─ merge.ts                 # fact-level 3-way merge, residue detection, merge dream
│  ├─ erase.ts                 # tombstone, erasures.md, supersede citing facts, rewrite history
│  └─ qualify.ts               # dream the fixture store, score, print the table
├─ commands/muninn.ts          # + dream, dreams [remember|forget], topics, rules, erase
└─ cli.ts                      # + dream [--scope] [--qualify] [--force], dreams, erase
test/
├─ fixtures/qualify/           # the fixture store (journal, 3 hosts), expected.json, scripts
└─ unit/ · integration/        # per module, as in Phase 1
docs/
├─ phase-2-plan.md             # this file
├─ topic-format.md             # normative grammar for topics/, supersessions.md, dreams/
└─ qualify-results.md          # reference results table
```

## Steps

Each step is a PR-sized unit, ordered so every step leaves `main` loadable by pi and strictly
more useful than before — and so that the riskiest part (a small model consolidating well)
is reached with every deterministic phase already in place around it, which is what makes
its output measurable. Estimates are working days for one person.

### 1. Git verbs and dream worktrees (1 d) — **done**

- `git.ts`: add `GitCommand` variants, each with an argv shape test:
  `worktree-add { path, branch, startPoint }`, `worktree-remove { path, force }`,
  `worktree-prune`, `branch-list { pattern }`, `branch-delete { name }`,
  `merge-ff-only { ref }`, `revert { sha }` (`--no-edit`), `checkout-paths { ref, paths }`
  (paths drawn from the existing `STAGEABLE` set minus `journal/`), `rev-list { range,
  paths }`, `diff-name-only { range, paths }`, `merge-base { a, b }`, `log-trailers { ref }`.
  `commit` stays pathspec-limited; a dream commit in a worktree passes the derived paths.
- `worktree.ts`: worktrees live **outside every store**, at
  `<agentDir>/muninn-worktrees/<store id>/<branch slug>/` — never inside the main worktree
  (git would see a nested checkout as untracked content) and never inside a project
  repository. For an **in-repo** project store the repository *is* the project, so the
  worktree is created `--no-checkout` and sparse-checked-out to `.pi/muninn/` only; the
  dream never materialises the project's sources. Branch name `dream/<host name>/<ts>` with
  `<ts>` = `YYYY-MM-DDTHH-MM` UTC; the report file is `dreams/<ts>.md` so branch and report
  share a key. GC: on every dream start, worktrees whose branch no longer exists or whose
  lock is stale are removed and `worktree prune` runs.
- `lock.ts` already knows `dream` (2 h) and `remember`; no change.

**Done when:** a unit test creates a worktree from a scratch store, commits a derived file on
its branch, fast-forwards `main` to it, and asserts the main worktree's file matches and
`git status --porcelain` is clean; the in-repo variant asserts the sparse checkout contains
only `.pi/muninn/`; `toArgv` is snapshot-tested for every new variant; any argv not in the
union still throws at the call site.

### 2. Topic format, fact ids, supersession writer (1 d) — **done**

- `topics/format.ts`: the README's topic grammar as a normative parser/serializer —
  front matter (`topic`, `updated`), `# Title`, free prose, `## Facts`, `## Superseded`.
  Fact line: `- **<claim>** id: f-<topic>-<uuidv7> · valid_from · source · evidence:
  <claim ids> [· cue] [· phase] [· shadows] [· valid_to · superseded_by · reason]`. Round-trip
  property test (serialize ∘ parse = id); tolerant of hand edits in prose, strict on fact
  lines. `parseFactLine` in `index/chunk.ts` becomes a call into this module so the index
  and the dream cannot disagree about what a fact is. The grammar goes into
  `docs/topic-format.md`, as `docs/journal-format.md` did for entries.
- `topics/write.ts`: `applyFactList(topic, items)` — new facts get `newFactId(topic)`
  (`ids.ts:148`, already there), superseded facts *move* to `## Superseded` with `valid_to:
  <today>`, `superseded_by`, `reason`; nothing is deleted; the result is byte-stable for an
  unchanged input (so an idle dream produces no diff). Relative dates in claims
  ("yesterday", "last week") are rewritten to absolute dates using the evidence entries'
  UUIDv7 timestamps — code, not the model.
- `journal/supersessions.ts`: `appendSupersessions(storePath, entries[])` — append-only,
  one line per invalidated **claim** through the `formatSupersession` Phase 1 already wrote
  for this purpose (`supersessions.ts:83`), deduplicated against what is already there. The reader's `Set<claim id>` is what recall already
  filters on, so the first dream that writes this file makes recall active-only for real.
- `topics/use-count.ts`: `useCounts(entries)` → `Map<fact id, { count, lastUsed }>` from
  journal `used:` fields. Derived, never stored; the dream computes it in orient, and
  `MEMORY.md` ordering (step 7) reads it.

**Done when:** round-trip tests on the fixture topic files; a test applies a fact list that
supersedes one of three facts and asserts the superseded row keeps its id, gains
`valid_to`/`superseded_by`/`reason`, its evidence claims appear in `supersessions.md`, and
`search()` without `history` no longer returns those claims while `memory_read` by id still
does, labelled `superseded` — that is the second README acceptance criterion, in a unit test.

### 3. The dream skeleton — lock, input head, orient, report, commit (1.5 d) — **done**

A dream that consolidates nothing but does everything else, end to end: this is the step
that makes the transaction testable before a model is in the loop.

- `dream/dream.ts`: `dream(scope, options)` → `DreamResult`. Sequence: take the `dream`
  lock (`lock.ts:22` already names it, 2 h stale; fail loud if held, take over if stale) →
  commit this host's pending entries from *inside* that lock with `commitJournalLocked`
  (`capture/commit.ts:100` — the lock is not reentrant, which is exactly why `sync.ts:126`
  uses the same call); in a session, `/muninn dream` first runs the extension's
  `commitPending(true)` and drains the append queue so nothing queued is left behind → record
  `input_head = rev-parse HEAD` → find the previous dream's `input_head` from the newest
  report on `main` (absent → the root commit) → create the worktree on
  `dream/<host>/<ts>` from `input_head` → phases → write `dreams/<ts>.md` → commit on the
  branch with a trailer (`Muninn-Topics:`, `Muninn-Journal:` — the ids, for `git log`) →
  release the lock. The main worktree is never written.
- `dream/orient.ts`: read `MEMORY.md`, the last report, `rules.md`, every topic; build
  `Map<topic, Set<claim id>>` of existing evidence and the fact→use_count map. One read
  each; no model.
- `dream/report.ts`: `DreamReport` ⇄ markdown, front matter with `input_head`,
  `journal_through` (last entry id per host in the range), `previous_input_head`, `model`,
  `held_out: [task ids]`, then sections *Gathered*, *Consolidated* (facts added /
  superseded per topic), *Lint*, *Eval* (empty table in Phase 2, with the columns Phase 3
  fills), *Skipped* (topics whose job failed twice). The report is also what `/muninn
  dreams` renders, so it is parsed, not just written.
- `dream/model.ts`: `DreamModel { complete(system, user, signal): Promise<string>; id }` —
  the same narrow port as `OutcomeModel` (`capture/outcome-run.ts:19`), with the pi adapter
  confined to `index.ts` as `writeOutcome` does it (`index.ts:496`). `dream.model`
  (`provider/model`) is resolved through `ctx.modelRegistry` — new work; Phase 1 reads the
  setting and resolves nothing — and `null` means the session model. The headless implementation is step 11.
- Progress: `/muninn dream` reports each phase through `ctx.ui.setStatus("muninn", …)`
  and, where there is no UI, stderr — the Phase 1 rule for command output.

**Done when:** an integration test runs `/muninn dream` through a real `pi` against a store
with journal entries and no model replies needed (no topic is affected because gather is
still a stub), and asserts: a `dream/<host>/<ts>` branch exists, `main` did not move, the
report on the branch names `input_head` equal to `main`'s sha *after* the pre-dream commit,
the main worktree is clean, and a second dream started while the first holds the lock fails
with a message naming the holder. A dream killed mid-phase (`SIGKILL` the child) leaves a
worktree and a lock that the next dream removes after the lock goes stale (`staleMs`
override).

### 4. Gather (1.5 d) — **done**

- `dream/gather.ts`, deterministic, over the range `previous_input_head..input_head`:
  1. **Range.** `diff-name-only` on `journal/` gives the daily files; parse them
     (`journal/read.ts`) and keep entries whose id is not already cited by a fact and not
     older than the previous `journal_through` per host (a daily file grows across dreams).
  2. **Hold-out.** The *k* (`dream.evalSessions`, default 5) most recent **completed task
     groups** — every entry sharing a `task`, closed over `continues`, of every `source` —
     are removed from the candidate set and listed in the report by task id. "Completed"
     means the group has an outcome entry and no entry in the last hour. Held-out groups are
     also excluded from recurrence counting and from `memory_read` during phases 2–3 (the
     dream's `DreamModel` never gets tools in Phase 2, so this is a guard on the gather
     code, not on a tool).
  3. **Active-only.** Drop claims in `supersessions.md`; drop erased ids
     (`journal/erasures.md`).
  4. **Echo exclusion.** A claim carrying `echo:` is kept as *usage signal* (it feeds
     use_count through `used:`) but never as evidence and never counted toward recurrence.
  5. **Selection.** Keep: every `source: user` entry (explicit notes and corrections);
     decisions and failures (outcome entries whose `phase` is `fix`/`review`/`ops` or whose
     prose matches the decision/failure cues); and any `agent`/`tool` claim whose `cue` or
     body recurs ≥ 2 times across *distinct* `task` groups with distinct `recalled` sets
     (Jaccard ≥ 0.8 on tokens, the `outcome.ts:175` function). Single-occurrence
     `agent`/`tool` claims stay in the journal and are not promoted.
  6. **Topic assignment.** Each kept claim is routed to a topic by search (`search()` over
     `topics/` with the claim and its `cue` as the query, `kind: fact|topic`); a hit above a
     score floor joins that topic's job, else the claim proposes a new topic whose slug is
     derived from its `cue` (or `phase` as a last resort). Top-K per query; a claim joins
     at most one topic.
  7. **Poisoning budget.** A topic whose gathered evidence is > 50 % `external` is not
     consolidated; it goes in the report under *Needs review* with the entry ids.
  8. **Bound.** A job is ≤ 30 evidence entries; a topic with more gets the most recent 30
     and the rest are listed as deferred — the next dream's range still contains them
     because they were not cited.

**Done when:** a fixture journal (three hosts, ~60 entries: explicit notes, corrections, an
echo of a recalled fact, a claim recurring in two tasks, a claim recurring twice in *one*
task, a superseded claim, an `external`-heavy topic, five completed tasks and one open one)
gathers exactly the labelled set: the echo is not evidence, the single-task repeat is not
recurrence, the superseded claim is absent, the five most recent completed tasks are held
out and listed, the `external` topic is deferred to review. The test asserts the job inputs
by id, so the fixture doubles as the first half of the qualification fixture (step 11).

### 5. Consolidate (2 d) — **done**

- `dream/consolidate.ts`: for each affected topic, **one bounded job**: system prompt
  (fixed), user prompt = current topic file (facts with ids; ≤ 40 facts, else the 40 most
  recently `valid_from` plus a note that the rest are unchanged and out of scope), the new
  evidence (entry header, cue, claims with ids), and the instruction to reason first then
  emit a fenced `json` block: a flat array of `{ claim, evidence: [claim ids], supersedes?:
  [fact ids], cue?, phase? }`. Existing facts the model keeps are re-emitted by id
  (`{ id }` alone means "unchanged"). The prompt states the date so `valid_from` and
  relative-date rewriting agree.
- Parse: take the **last** fenced block, `JSON.parse`, validate flatly (array; each item an
  object with known keys; `evidence` non-empty and every id a known, active, non-echo claim
  id from *this job's* evidence or the topic's existing evidence; `supersedes` ids from this
  topic). On failure retry **once** with the parser error quoted; a second failure skips the
  topic and reports it. Same shape as `outcome.ts:95`'s parser, shared helper.
- Guards, in code, before anything is written: a result that drops or supersedes > 25 % of
  the topic's active facts is rejected (reported, topic unchanged); a claim that the
  redaction scanner flags is refused — `redact()` today runs only inside `appendEntry`
  (`append.ts:154`), so `topics/write.ts` and `memory-md.ts` call `containsSecret` on every
  line they emit, and a hit is a blocking lint finding as well; a claim whose only
  evidence is `external` lands under `## External` in the topic, not `## Facts`.
- Apply through `topics/write.ts` and `appendSupersessions`; new topics get front matter
  and a title from the slug. Each job's token count is measured with `tokens.ts` and must
  fit 8 k; the evidence bound from step 4 keeps it there.

**Done when:** with the mock provider scripted from `test/fixtures/qualify/scripts/perfect.ts`
(replies derived from `expected.json`), a dream over the gather fixture writes the expected
topics byte-for-byte; with `broken.ts` (malformed JSON once, then valid) the topic is still
written and the report records one retry; with `hostile.ts` (cites a held-out claim, an echo,
a fabricated id; supersedes 60 % of a topic; emits a claim containing an AWS key) every
violation is refused by code and named in the report, and the topic file is unchanged.

### 6. Lint (1 d) — **done**

- `dream/lint.ts`, deterministic, over the worktree after consolidation. **Blocking** (the
  dream fails, the branch is kept with the report for inspection, nothing is remembered):
  a fact citing a non-existent, superseded, erased or echo-only claim; an active fact whose
  evidence is entirely superseded; `rules.md` over `dream.rulesCap`; a secret in a derived
  file. **Advisory** (in the report): pairwise contradiction candidates within a topic
  (token overlap above the threshold; the model is asked to judge only those pairs, one
  call per topic, and only in the session path where a model is present — the headless
  path reports the pairs unjudged); rules unused > `dream.retireAfterDays` days (computed
  from `used:`), *proposed* for retirement; `MEMORY.md` lines pointing at nothing; a project
  rule contradicting a global rule (the project dream reads the global `rules.md` read-only
  for this check; dreams never cross scopes otherwise).
- Lint also runs standalone: `/muninn` status shows the last dream's blocking count, and
  `muninn dream --lint-only` (undocumented flag for tests and for a hand-edited store) runs
  it on `main`.

**Done when:** each rule has a unit fixture that trips it and one that does not; a dream
over a store whose hand-edited topic cites a fake id fails with the id in the report and
leaves `main` untouched.

### 7. `MEMORY.md` regeneration and the commit phase (1 d) — **done**

- `dream/memory-md.ts`: one line per active topic (`- **<topic title>** — <first fact
  claim, trimmed> · topics/<slug>.md`) and per rule; per-scope reserved budgets
  (`recall.snapshotLines`: 120 / 60 / 20 of 200 — *this* dream writes only its own scope's
  file and respects its own scope's reservation; the cross-scope merge and lending stay in
  `recall/snapshot.ts`, which already does them). Ordering: `use_count` desc, then
  `valid_from` desc. Overflow drops the least-used lines, which stay searchable.
  **Hand-written content is kept:** everything above the first `## Topics` / `## Rules`
  heading is preserved verbatim and counted against the budget, so the `MEMORY.md` people
  wrote during Phase 1 survives the first dream; a comment line marks where generation
  starts, and the header `init.ts:38` writes ("hand edits survive until the next dream
  rewrites this file") is reworded to say exactly that.
- Commit: `git add` of exactly the derived paths, one commit `dream: <n> facts, <m>
  superseded, <t> topics` with the trailers from step 3. `git log -p` on the branch reads as
  one readable diff — the fourth acceptance criterion — because fact lines are one line
  each and supersession is a move plus a trailer.

**Done when:** regeneration is byte-stable on unchanged input; a budget test fills 130 topic
lines into a 120-line reservation and asserts which ten were dropped and why; a hand-written
preamble survives; `git log -p` of the dream commit in the integration test is snapshot-
tested.

### 8. Remember, forget, recovery, `/muninn dreams` (1.5 d) — **done**

- `dream/remember.ts`: the README's apply transaction under the `remember` lock: write
  `.remember` `{ branch, mainSha, at }` → `commitJournalLocked` (worktree clean) → rebase
  the dream branch onto `main` (conflict-free when `main` moved only by journal commits; a
  derived-file conflict aborts the rebase and hands off to step 9) → `merge-ff-only` → delete
  `.remember`. `--ff-only` failing because `main` moved again retries the rebase once, then
  reports. After a successful remember the session's indexes are refreshed
  (`SessionIndexes.refresh`, `index/search.ts:202`) exactly as after `sync`; the frozen
  snapshot stays frozen for this session, by design, and the status line says "remembered —
  new MEMORY.md next session".
- Recovery, on every store open (`ensureStore`): a `.remember` marker with `main` still at
  `mainSha` is deleted; otherwise `checkout-paths HEAD -- <derived paths>` then delete. A
  unit test kills the process between each pair of steps (the fixture worker pattern from
  `test/fixtures/lock-worker.ts`) and asserts the next open repairs it.
- `dream/forget.ts`: `revert` of the remember commit through the same transaction; the
  report is kept and gains a `forgotten: <date> · reason:` line on `main`.
- `/muninn dreams` lists `dream/*` branches (local and, when a remote exists, fetched
  `origin/dream/*`) with their reports: facts added / superseded, lint counts, held-out
  tasks, remembered-or-not. `/muninn dreams remember <ts>` and `/muninn dreams forget <ts>`.
  A branch that was remembered is deleted after the fast-forward (the commit is on `main`;
  the report is the record); a remote dream branch is deleted on the next sync's push.
- `sync.ts` pushes `dream/*` branches alongside `main` (refspec added to the existing
  `push` variant, never force).

**Done when:** the third README acceptance criterion in `test/integration/`: a dream is
created; ten entries are captured and committed on `main` by a separate `pi` process while
the branch exists; remember succeeds without conflict; `git log` shows the journal commits
followed by the dream commit; `MEMORY.md` on disk is the dream's; `git status` is clean.
Forget reverts it and a subsequent dream re-derives the same facts with new ids. The
recovery test passes for every interruption point.

### 9. Merge — fact-level 3-way, residue, merge dream (2 d) — **done**

- `dream/merge.ts`, three layers, cheapest first, invoked from step 8 when the rebase
  conflicts on a derived path:
  1. **Structural, per fact**, with `base = merge-base`, `ours = main`, `theirs = dream`
     read through `show-file`: a fact added on one side only is kept; superseded on one side
     and untouched on the other is superseded; superseded on both keeps the earlier
     `valid_to` and both `superseded_by`; `supersessions.md` and `## Superseded` are unioned;
     `MEMORY.md` is regenerated, never merged. Ids never collide (UUIDv7).
  2. **Residue detection**: pairs of active facts, one per side or one new and one existing,
     with shared evidence ids, the same `cue`, or token overlap above the lint threshold.
     No model.
  3. **The merge dream**: one consolidate job per topic with residue, the same flat schema
     and bound, a different prompt (`base`, both candidate lists, the union of their
     evidence — synced first, so both hosts have it), plus one extra lint rule: every active
     fact from either side is present, superseded with a reason, or listed as dropped in the
     report. Committed as `dream/<host>/<ts>-merge` with a report naming both parents, and
     remembered through the ordinary transaction.
  `rules.md` residue is never resolved by the model; it is listed for review and the merge
  stops there.
- A conflict on `journal/` is reported as a bug and never merged.

**Done when:** unit tests cover each structural case and the residue detector on labelled
pairs; an integration test with two scratch `HOME`s (the Phase 1 acceptance harness) has
each laptop dream and remember a different rewrite of the same topic, sync, and end with one
merge dream whose report names both parents, no fact lost, and both laptops on the same
`main`. The merge cases are also in the qualification fixture.

### 10. Erase (1 d) — **done**

- `dream/erase.ts`, under the `erase` lock for the whole duration, after two confirmations
  (`/muninn erase <id>` asks in the TUI; the CLI needs `--yes --yes`): the entry body in
  the daily file is replaced by a tombstone line (`## HH:MM · <id>` + `erased: <date>`), the
  id is appended to `journal/erasures.md`, every fact citing any of its claims is superseded
  with `reason: erased` (through `topics/write.ts`, committed directly on `main` — erase is
  a human action, not a dream), the index is rebuilt, and history is rewritten with
  `git filter-repo --replace-text` on a generated replacements file, then force-pushed if a
  remote exists. `push-force` and `filter-repo` are the two `GitCommand` variants only
  `erase.ts` constructs.
- **`git-filter-repo` is not part of git** and is absent on a stock macOS. Erase checks for
  it first and refuses with the install hint; `--no-rewrite` does everything except the
  history rewrite and says loudly that the bytes are still in `.git`. Erase is **refused in
  an in-repo store** (the open question's likely answer, adopted): rewriting the product's
  history is not Muninn's call; migrate to a separate store first (Phase 5 command; until
  then, the message says how by hand).
- Gather and lint read `erasures.md` (step 4, step 6), so an erased id can never be cited
  again, and a host that still has the entry drops it at the next sync (its rebase onto the
  rewritten remote is a forced re-clone — documented, with `muninn sync` detecting the
  rewritten history by a missing `merge-base` and printing the command).

**Done when:** after erasing an entry on one scratch laptop, `git log -p --all` on the
remote contains no byte of the erased body, the tombstone and `erasures.md` line are
present, the citing fact is superseded with `reason: erased`, `memory_search` and
`memory_read` do not return it, and the second laptop's next sync reports the rewrite and
the re-clone command.

### 11. Headless CLI, `--qualify`, reference results (2 d) — **done**

- <a id="headless-dreams-and-the-model"></a>**Headless dreams and the model.** `muninn
  dream` needs a model without a pi session. The SDK's `createAgentSession` is the wrong
  tool (it builds an agent; Phase 1 also found its `Model` type unreachable from an
  extension package), but pi exports `ModelRuntime`
  (`core/model-runtime.ts:172`, `ModelRuntime.create({ authPath, modelsPath })`) with
  `getModel(provider, id)` and `complete(model, context)` — the same runtime
  `ctx.modelRegistry` wraps. The headless `DreamModel` uses it. `dream.model` must be set
  for the CLI (`null` falls back to pi's `defaultModel` setting; no default → refuse with a
  message). Local endpoints (llama-server, Ollama) are ordinary `models.json` providers
  (`docs/models.md`), so nothing Muninn-specific is needed to dream offline. Unlike `sync`,
  `dream` imports pi — lazily, in its own subcommand, so `muninn sync` in cron keeps its
  one-second start.
- `cli.ts`: `muninn dream [--scope global|project] [--qualify] [--force] [--lint-only]`,
  `muninn dreams [remember|forget <ts>]`, `muninn erase <id> --yes --yes [--no-rewrite]`.
- `dream/qualify.ts` + `test/fixtures/qualify/`: a fixture **store** (not just a journal):
  three hosts, ~80 entries over three "weeks", six topics, with labelled cases — explicit
  notes, corrections that supersede, echoes (paraphrased and verbatim, the open question's
  threshold data), recurrence across tasks vs within one, an `external`-heavy topic, a
  relative date, a planted secret, held-out tasks, and two merge cases (disjoint facts; a
  genuine residue). `expected.json` lists, per topic, the facts that must exist (matched by
  evidence set, not wording), the supersessions that must be written, the ids that must
  *not* be cited, and the merge outcomes. `--qualify` copies the fixture to a scratch
  store, dreams it with the configured model (and runs the two merge jobs), scores:
  **unsourced facts** (must be 0 — hard), **supersession recall**, **echo leakage**
  (must be 0), **retention** (active facts kept ≥ 75 %), **recurrence precision**, **merge
  loss** (must be 0), plus retries and skipped topics. Prints the table and exits non-zero
  below the bar. Automatic dreams (Phase 3) will read the last qualification result;
  manual ones run with `--force` regardless.
- `docs/qualify-results.md`: the table for Qwen3.5-4B, Qwen3.5-9B, Qwen3.6-35B-A3B and one
  frontier model, with the endpoint, quantisation, context size and the command used.
  **These runs need the models on hand**; the deliverable of this step is the fixture, the
  scorer, and a table with the rows the plan names — filled by running them on a machine
  that has the models, not by CI. CI scores the scorer: the `perfect` script must score
  100 %, `hostile` must fail every hard gate.

**Done when:** `muninn dream --qualify` against the mock provider reproduces the fixture's
expected table; the first README acceptance criterion (zero unsourced facts from a 9B
model) is recorded in `docs/qualify-results.md` with the exact command, and the table has
the four rows.

### 12. Commands, status, docs, hardening (1.5 d) — **done**

- `/muninn dream [--scope s]` foreground with progress; `/muninn dreams`; `/muninn
  topics|rules` (list; `open` in `$EDITOR` where `ctx.hasUI`); `/muninn erase`. `/muninn`
  status gains: entries since last dream (from the last report's `journal_through`), pending
  dream branches, last dream's lint result, `.remember` marker present (should never be).
- Failure injection: model endpoint down mid-dream (branch kept, report says which phase),
  disk full in the worktree, a worktree path that already exists, `main` moving twice during
  remember, `git filter-repo` missing, a daily file appended to between input head and
  gather (must not matter — gather reads the worktree, and the test proves it).
- Bun run of the whole suite.
- README: move the Phase 2 parts of *Using it today* into place (dream, dreams, erase,
  topics, settings `dream.*`), mark Phase 2 **done** with the same three-pointer pattern as
  Phase 1; `docs/topic-format.md` normative; `docs/qualify-results.md`.

**Total: ~17 working days. All twelve steps are done**, and three of the four acceptance
criteria at the top of this document are met outright: a superseded fact keeps its audit
row while its evidence leaves default `memory_search`
(`test/unit/topic-write.test.ts`), a dream remembered while capture committed ten entries
lands without conflict (`test/unit/remember.test.ts`), and the diff reads as one list of
facts in `git log -p` (`test/unit/dream-end-to-end.test.ts`). The fourth — *a 9B model*
yielding zero unsourced facts on the fixture — ships as the fixture, the scorer and the
harness, scored in CI against scripted dreamers; the model rows in
[qualify-results.md](qualify-results.md) need the models on hand.

739 tests. Bun is exercised by CI (`.github/workflows/ci.yml`) and was not run locally —
Bun is not installed on the machine this was built on, and nothing added in this phase is
native.

## What the steps turned up

Each of these came from a test failing for a reason that was not the test's fault. They
are the argument for writing the "done when" first.

- **Worktrees needed canonical paths.** `rev-parse --show-toplevel` answers with the path
  the filesystem would open, so on macOS `relative()` against a store's own `/var/…` path
  produced a sparse-checkout pattern made of `..`. The same lexical-versus-canonical gap
  the Phase 1 review closed for the store boundary, met again at a different door (step 1).
- **`updated:` must move only when a fact does.** Stamping it on every dream meant an idle
  dream dirtied every topic it looked at, which would have made `git log -p` — the whole
  point of a reviewable branch — unreadable (step 2).
- **Recurrence has to count contexts, not just tasks.** Counting distinct tasks alone lets
  a fact corroborate itself by a second route: recall injects a memory into two sessions,
  both restate it, and two "independent" observations appear where there was one cause
  (step 4).
- **The loss guard had to be rewritten twice.** As a pure ratio it forbade the correction
  the mechanism exists for — a topic with three facts could never have one superseded. As
  a count of supersessions it forbade merging two facts into one better one, which is what
  a merge dream does with every residue pair. It measures net loss (steps 5 and 9).
- **`echo:` names a memory, which may be a claim id.** Echo resolution looked only at
  topic facts, so every echo of a *journal* memory walked into consolidation untouched.
  Found by the qualification fixture, which is exactly what it is for (step 11).
- **Selecting decisions by `phase` promoted filler.** Every "finished the investigation"
  outcome entry of an ops task became a fact. Phase is where work happened, not what was
  learned (step 11).
- **`refs/heads/dream/*` matches nothing.** git's ref globbing will not let a single star
  cross a `/`, and a dream branch is two levels down. Branch listing silently found
  nothing, which broke `/muninn dreams` and sync's dream-branch push both (step 11).
- **The fixture's own journal was half-invisible.** The generator omitted each daily
  file's terminating blank line, so every file's last entry parsed as a truncated tail —
  the reader working exactly as designed, and a reminder that the format's strictness is
  load-bearing (step 11).
- **A dream must not hold the store lock.** Holding it for the whole run blocks every
  append on the machine for minutes, and a queued append that times out is an entry lost
  for good. The lock now covers the setup — commit the pending journal, read `HEAD`, cut
  the worktree — and a separate `.dreaming` marker excludes other dreams (step 12).

## The review

A review over the whole diff — every finding verified against the running code before it
was reported — found seven correctness bugs and six smaller ones. All are fixed, each with
a test that fails against the old code. Four are worth keeping, because each is a boundary
that looked closed:

- **Erase left the erased body in the file.** A daily file starts with `## ` at byte 0, so
  a search for `"\n## "` found the *second* entry and treated the first as a preamble —
  copying it out verbatim, secret included, with its id then appearing twice. Only a
  single-entry file behaved, which is exactly what the tests built. The Phase 1 lesson,
  again: a fixture that is simpler than reality tests the code against the fixture.
- **The echo refusal was inverted.** `echo:` names the memory that was restated, so the
  refusal list held the *original observation* and left the echo citable. An entry reaches
  a job for one of its claims and brings all of them into the prompt and the allow-list,
  so the refusal has to be by claim id.
- **Held-out and deferred entries were dropped from every future dream.** The watermark
  took the maximum over everything in range, so what gather withheld sat below it and no
  later dream ever saw it. A hold-out became a deletion — and the comment promising
  deferred claims were "deferred rather than lost" was, exactly, the Phase 1 pattern of a
  comment asserting a boundary that is not enforced.
- **The transaction and a running dream fought over worktrees.** `collectWorktrees`
  justified force-removing every dream checkout with "the store lock is held, so no other
  dream is alive" — true before step 12 split the lock, false after. Splitting a lock
  invalidates every comment that reasoned from it, and this one was not re-read.

And the merge dream had no caller at all: `rebaseOnto` threw `RebaseConflict` and its own
comment said "the caller is told which topics need it", but the caller was a generic
`catch`. Step 9 shipped a tested module that nothing could reach. It is wired now, through
a `resolve` callback the caller supplies, with the cross-host test the step's "done when"
always described.

A second review, on the PR itself, found eleven more — seven P1. The themes worth
recording:

- **The watermark, twice more.** Excluding withheld ids while taking the maximum still ran
  past them whenever retained and withheld entries interleaved, and it was computed before
  consolidation so a skipped or model-less job was recorded as consumed. It is now the
  largest contiguous prefix per host, computed after consolidation, over what was actually
  consumed. Three rounds of bugs in one function is the argument for its test fixture
  being labelled entry by entry.
- **The resolver reconstructed instead of rebasing.** Starting a fresh branch and
  rewriting only the conflicted topics dropped the dream's non-conflicting topics, report
  and supersessions — and rejected the MEMORY-only conflict, which is the *normal* case
  for disjoint work. It now rebases the dream's own branch and resolves each stop:
  topics via the three layers, `supersessions.md` by union, `MEMORY.md` by regeneration;
  the result is linted and carries its own report before the transaction may apply it,
  and its merge-job evidence is bounded to what the conflicting facts cite.
- **A dream's identity now includes its host.** Two hosts dreaming the same store in the
  same minute produced one stamp, one listing key and one report file. The id is
  `<host slug>/<ts>` and reports live per host, like journal files, for the same reason.
- **Remembering a fetched dream detached.** A worktree from `origin/dream/…` is a detached
  checkout; the rebase moved the detached HEAD while the ref stayed put and the work was
  lost. The fetched branch is materialised locally first.
- **"ok" that was not.** An erase whose history rewrite failed still returned ok; a
  `filter-repo` note is not a result. And carried-forward evidence was superseded by the
  very merge that still cited it, making the merged fact stale against its own sources —
  supersession rows are now written only for claims nothing active cites any more.

## Decisions made by this plan

Things the README leaves open or states at a level an implementation cannot follow, decided
here so the steps are unambiguous. Each is one line to overturn.

- **Phase 2 dreams write topics; `rules.md` is read, linted and hand-edited.** The README's
  v1 cut says dreams "write topics and rules", but every control that makes an
  auto-derived rule safe — the provenance gate, the canaries that check a rule fires, the
  evaluate phase — is Phase 3, and a rule is *followed*, not just recalled. A dream that
  proposes rules without those is the riskiest output in the system behind the weakest
  fence. So in Phase 2 the consolidate schema stays the README's flat fact schema (no
  `rule` field), lint enforces the cap and proposes retirements, and rules are written by
  people. Rule derivation arrives with its gate.
- **Worktrees live under `<agentDir>/muninn-worktrees/`, not under `.git/worktrees/`.**
  The README names git's metadata directory; the checkout itself must be a directory git
  is not tracking, outside the main worktree and outside any project repository. In-repo
  stores are sparse-checked-out to `.pi/muninn/`.
- **Gather routes claims to topics by search, and new topics come from cues.** The README
  says "for each affected topic" without saying how a claim finds its topic; letting the
  model assign topics would put a nested decision in the one job that must stay flat.
- **"Completed task group" = has an outcome entry and has been quiet for an hour.** The
  hold-out needs a definition that works on a journal alone.
- **The hand-written `MEMORY.md` preamble survives regeneration.** Phase 1 told people to
  write it by hand; the first dream must not throw it away.
- **Erase requires `git-filter-repo` and is refused in in-repo stores.** `git
  filter-branch` is deprecated by git itself and leaves backup refs; shipping a history
  rewrite on it would be shipping the bytes it was meant to remove.
- **The merge dream is Phase 2, with `dream.host` held in reserve.** It is the hardest
  prompt for a small model, so it is in the qualification fixture from the first run;
  if the 4B/9B rows show it markedly worse than consolidation, `dream.host` is one setting
  and one `if` away.
- **Contradiction judging is session-only.** The headless path reports candidate pairs
  unjudged rather than spend a model call per topic from cron; Phase 3's evaluate phase is
  the right place to decide whether that call is worth it.

## Test strategy

| Layer | Runs | Covers |
|---|---|---|
| Unit (vitest, no pi, no model) | every push, Node + Bun | topic grammar round-trip, fact-list apply, supersession writer, gather on the labelled fixture, consolidate parser and guards, every lint rule, `MEMORY.md` budget, 3-way merge cases, residue detector, report ⇄ markdown, git argv shapes, recovery at every interruption point |
| Integration (vitest + a real `pi`, scripted HTTP provider, scratch `HOME`) | every push, Node | `/muninn dream` end to end with `perfect` / `broken` / `hostile` scripts, remember while capture commits, forget, `/muninn dreams`, erase, the headless CLI through `models.json` pointing at the mock |
| Acceptance (two scratch `HOME`s, bare remote) | every push, Node | the README's Phase 2 "done when" 2–4 literally; the cross-host merge dream |
| Qualification (`muninn dream --qualify`) | CI with the mock (scores the scorer); by hand with real models | criterion 1 and `docs/qualify-results.md` |

**The mock provider scripts the dreamer.** `test/fixtures/mock-provider.ts` already serves
an OpenAI-compatible endpoint and tells Muninn's outcome call apart from pi's own by a
substring of the system prompt (`OUTCOME_MARKER`, `mock-provider.ts:33`); the consolidate
and merge prompts get marker constants of their own, and a dream script is a `MockScript`
that recognises the job by its marker and topic slug and answers from `expected.json`. For the CLI path the
same server is named in a scratch `models.json`, which also proves the documented
local-endpoint configuration works. The `perfect` script is derived from the expectations,
so the fixture and its answer key cannot drift apart; `hostile` is hand-written, and every
guard in step 5 exists because that script defeats the code without it.

## Risks specific to Phase 2

| Risk | Mitigation |
|---|---|
| A small model consolidates plausibly and wrongly | Flat schema, evidence-id validation, the 25 % loss guard, lint, manual remember only in this phase; the qualification fixture measures it before anyone trusts it |
| The dream's first run on a real Phase 1 store is a mess (months of journal, no topics) | Step 4's per-job bound and deferral make the first dream partial and honest rather than one huge job; the report lists what was deferred |
| The hand-written `MEMORY.md` is lost or doubled | Preamble preserved and tested; generated sections marked |
| Remember races capture on a busy host | The transaction's `--ff-only` is the CAS; the acceptance test runs capture concurrently; recovery is tested at every step |
| Worktrees accumulate | GC at every dream start; `/muninn dreams` lists them; a branch remembered is deleted |
| Erase leaves bytes behind | `filter-repo` required, `--no-rewrite` is loud, remote re-clone detected and printed |
| Headless model access breaks on a pi upgrade | `ModelRuntime` is a public export under the existing `<0.85.0` peer range; the CLI test exercises it |
| Cross-host merge quality | In the fixture from day one; `dream.host` fallback named |

## Open decisions to settle during Phase 2

- The recurrence threshold (≥ 2 distinct tasks) and echo threshold (0.8) — the fixture
  carries labelled cases so both become measurements rather than guesses.
- Whether a new topic proposed by a single `source: user` note should be created at once or
  wait for a second entry (plan: at once — a user note is the strongest signal there is).
- Whether `/muninn dream` should refuse when the session model is a frontier API model and
  `dream.model` is unset — the README's point is offline dreaming — or merely warn (plan:
  warn once, name the setting).
- Whether `dreams/<ts>.md` reports of *forgotten* dreams should be pruned after N days or
  kept forever (plan: forever; they are small and they are the record of why).
