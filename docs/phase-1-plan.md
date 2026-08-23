# Phase 1 — Journal and recall: implementation plan

*Outcome: pi sessions leave a journal, and the next session can find it.*

This plan turns the Phase 1 section of the [README](../README.md#phase-1--journal-and-recall)
into an ordered sequence of steps, each with a "done when". It is written against pi
`v0.84.2` (`914cf14`), checked out as the sibling `../pi`; file references of the form
`core/…` are relative to `../pi/packages/coding-agent/src/`. Nothing here requires a pi
modification — see [verified at the baseline](../README.md#verified-at-the-baseline).

## Scope

**In:** global and project scope · capture (explicit, corrections, outcomes,
pre-compaction) · secret redaction · per-host journal directories with locked appends ·
UUIDv7 ids and claim bullets · `task` / `continues` grouping · capture-target scope ·
journal commits · `store.md` with schema version and host registry · Tier 0 index · the
three tools · frozen `MEMORY.md` snapshot (hand-written) · per-turn recall · `muninn sync`
· `/muninn note|promote|search|scope|reindex|sync` · `/muninn` status.

**Out (later phases):** dreams, `topics/`, `rules.md`, `supersessions.md` *writing* (the
reader is in, because recall must be active-only from day one and the file format is part
of the schema), Tier 1, team scope, erasure, skills, model2vec static embeddings (optional
Tier 0 add-on; deferred to keep the Phase 1 dependency list at two packages), tool-derived
facts (capture item 5 — needs the classifier budget to be understood first).

**Acceptance (from the README):** a correction made on Monday on one laptop is surfaced by
`memory_search` on Tuesday on another laptop in a different project directory; nothing
outside `journal/` was written; two concurrent sessions on one host produce a well-formed
daily file.

## Ground rules

- **TypeScript, ESM, Node `>=22.19.0`** (pi's own floor). Bun must work for Tier 0; nothing
  in Phase 1 is native.
- **Layout and tooling mirror `pi-enclave`:** `package.json` with `"pi": { "extensions":
  ["./src/index.ts"] }`, `peerDependencies` on `@earendil-works/pi-coding-agent ">=0.84.2
  <0.85.0"`, `tsc --noEmit` + biome for `check`, vitest for tests, `tsx` for scripts.
- **Runtime dependencies: two.** `minisearch` (Tier 0 BM25) and `proper-lockfile` (the
  store lock; pi already depends on it, so it is the same lock semantics pi uses for
  `settings.json`). UUIDv7 is minted in-tree: pi ships `@earendil-works/pi-ai` inside its
  own shrinkwrapped `node_modules`, so its `uuidv7` is not resolvable from an extension
  package. `git` is invoked as a subprocess, always via `execFile` with an argv array.
- **The extension entry is thin.** `src/index.ts` wires pi events to modules; every module
  is testable without pi. Integration tests drive the real pi through the SDK
  (`createAgentSession`) with a scratch `HOME` and `PI_CODING_AGENT_DIR`.
- **Fail loud, never silent.** Any failure that would make memory incomplete (lock
  timeout, redaction engine error, index corruption, git failure) is surfaced in the status
  line *and* on stderr; it never degrades quietly.
- **Capture never writes outside `journal/`** and the commit path never runs `git` with
  anything but `add journal/` and `commit` (plus `fetch`/`rebase`/`push` under `sync`). This
  is enforced by a single `git.ts` module with an allow-listed argument set and a test.

## Repository layout

```
pi-muninn/
├─ package.json
├─ tsconfig.json · biome.json · vitest.config.ts
├─ src/
│  ├─ index.ts                 # extension entry: registers events, tools, commands
│  ├─ settings.ts              # read `muninn` from pi's global/project settings.json
│  ├─ ids.ts                   # uuidv7 wrappers: j-, f-, host, claim ids; validation
│  ├─ store/
│  │  ├─ paths.ts              # scope → directory; global/project resolution; git toplevel
│  │  ├─ scopes.ts             # active scopes + capture target (trust-aware)
│  │  ├─ lock.ts               # the store lock (proper-lockfile; 30 s stale for appends)
│  │  ├─ store-md.ts           # store.md: schema version, store id, host registry
│  │  ├─ host.ts               # ~/.pi/agent/muninn/host.json — host id + display name
│  │  └─ init.ts               # create a store: git init, .gitignore, store.md, MEMORY.md
│  ├─ journal/
│  │  ├─ format.ts             # entry ⇄ markdown: header, flat metadata, prose, claims
│  │  ├─ append.ts             # locked, single-write, fsync append to journal/<host>/<day>.md
│  │  ├─ read.ts               # parse daily files; truncated-tail detection
│  │  └─ supersessions.ts      # read supersessions.md → Set<claim id> (writer is Phase 2)
│  ├─ redact.ts                # secret scanning: regex set + high-entropy detection
│  ├─ capture/
│  │  ├─ session-state.ts      # per-session state via pi.appendEntry (recalled, written ids)
│  │  ├─ explicit.ts           # "remember / note / from now on" detection on user input
│  │  ├─ corrections.ts        # correction classifier on user turns
│  │  ├─ accumulate.ts         # turn_end / agent_end → run transcript (minus muninn msgs)
│  │  ├─ outcome.ts            # outcome entry: prompt template, model call, parse, echo tag
│  │  └─ commit.ts             # journal commits at agent_settled / shutdown / before sync
│  ├─ recall/
│  │  ├─ snapshot.ts           # MEMORY.md merge + line budget → system-prompt section
│  │  └─ per-turn.ts           # query index with prompt → ≤ N facts → custom message
│  ├─ index/
│  │  ├─ chunk.ts              # heading-path chunking, claims as chunks, ~700 tok cap
│  │  ├─ tier0.ts              # minisearch over chunks; link graph; filters
│  │  ├─ build.ts              # content-hash incremental rebuild into .index/
│  │  └─ search.ts             # the one query API used by tools, recall and /muninn search
│  ├─ tools/
│  │  ├─ memory-search.ts · memory-read.ts · memory-note.ts
│  │  └─ render.ts             # compact custom renderers (ids, sources)
│  ├─ commands/
│  │  └─ muninn.ts             # /muninn status|note|promote|search|scope|reindex|sync
│  ├─ sync/
│  │  └─ sync.ts               # commit, fetch, rebase, push (under the store lock)
│  ├─ git.ts                   # allow-listed git subprocess wrapper
│  └─ cli.ts                   # `muninn sync` (and `muninn status`) headless
├─ test/
│  ├─ unit/                    # per module, no pi
│  ├─ fixtures/                # journals, MEMORY.md, settings, secret samples
│  └─ integration/             # SDK-driven pi sessions against a scratch HOME
└─ docs/
   └─ phase-1-plan.md          # this file
```

## Steps

Each step is a PR-sized unit, ordered so every step leaves `main` loadable by pi and
strictly more useful than before. Estimates are in working days for one person.

### 1. Scaffold and settings (0.5 d)

- `package.json`, tooling, CI (`check` + `test` on Node 22 and Bun).
- `src/index.ts` registers only `/muninn` → `status`, printing the extension version,
  pi version (`VERSION` from `@earendil-works/pi-coding-agent`), and "no store".
- `settings.ts`: read `muninn` from `~/.pi/agent/settings.json` and `<project>/.pi/
  settings.json`. pi has no extension-settings API at the baseline, but
  `SettingsManager.save()` re-reads the file and persists only *its* modified fields
  (`core/settings-manager.ts:617`), so a foreign `muninn` key survives pi's writes.
  Project settings are **tighten-only**: a project may lower `recall.factsPerTurn`,
  disable a capture kind, or set `scopes.project`; it may not raise a budget or enable
  something global disabled. Defaults are the README's block; Phase 1 ignores `dream`,
  `recall.embedding`, `recall.rerank`, `scopes.team`.

**Done when:** `pi -e ./src/index.ts` loads, `/muninn` prints status, `npm run check` and
`npm test` pass on Node and Bun.

### 2. Ids, store, host, lock (1 d)

- `ids.ts`: `newEntryId()` → `j-<uuidv7>`, `newHostId()`, `claimId(entry, ordinal)`, parsers
  with strict regexes. Ids are never truncated anywhere in code; display truncation is the
  renderer's job.
- `host.ts`: `~/.pi/agent/muninn/host.json` `{ id, name, createdAt }`; name defaults to
  `os.hostname()` short form; created on first run under the global store lock.
- `paths.ts` / `scopes.ts`: global = `~/.pi/agent/muninn/` (honouring
  `PI_CODING_AGENT_DIR`); project = `<git toplevel>/.pi/muninn/` **or** a separate
  repository keyed by the toplevel — Phase 1 implements the default, *separate*, at
  `~/.pi/agent/muninn-projects/<slug>-<hash of toplevel>/`; the in-repo variant is a path
  switch behind `scopes.project: "in-repo"` and the migration command is Phase 5. Capture
  target: project if `ctx.isProjectTrusted()` (`core/extensions/types.ts:332`) and a
  project store exists or `scopes.project === "auto"` creates one; else global.
- `lock.ts`: `withStoreLock(store, op, fn)` on `<store>/.lock` via `proper-lockfile`,
  lock content `{ pid, host, op, at }`, stale 30 s for `append`, retry with jitter for up
  to 5 s then fail loud.
- `store-md.ts`: parse and write `store.md` (`schema: 1`, `store: <uuidv7>`, host registry
  lines). Registering this host is the only write `store.md` gets in Phase 1.
- `init.ts`: `git init` if needed, `.gitignore` with `.index/` and `.lock`, empty
  `MEMORY.md` with a one-line header comment, `journal/<host id>/` directory, initial commit.

**Done when:** unit tests cover id round-trips, lock contention (two processes, one
wins, the other waits), stale-lock recovery, and store creation is idempotent. `/muninn
scope` shows active scopes, the capture target, and *why*.

### 3. Journal format, append, read (1.5 d)

- `format.ts`: the README's entry grammar. Serialize: `## HH:MM · <id>` heading, flat
  `key: value` block, blank line, prose, bullet claims. Parse: tolerant of missing
  optional fields, strict on id and `source`; an entry without bullets has one implicit
  claim `.1`. Round-trip property test (serialize ∘ parse = id).
- `append.ts`: under the store lock, build the full entry bytes, ensure the daily file
  ends with a newline, one `write`, `fsync`, release. The id is minted *before* the lock
  is taken. Returns the claim ids.
- `read.ts`: parse a daily file into entries; a final heading with no terminating blank
  line is reported as `truncated` and excluded, never thrown on. Iterate a host directory,
  a store, or all active stores.
- `supersessions.ts`: parse `supersessions.md` into `Set<claim id>` with `valid_to`; empty
  set when absent. Nothing writes it in Phase 1.

**Done when:** the concurrency acceptance test passes — 8 processes × 50 appends to one
daily file yield 400 well-formed entries, in id order per process, none interleaved. A
fixture with a deliberately truncated tail parses with exactly one `truncated` report.

### 4. Secret redaction (0.5 d) — **done**

- `redact.ts`: a provider pattern table (AWS, GitHub, GitLab, Slack, Anthropic, OpenAI,
  Google, Stripe, npm, JWT, PEM, URL credentials) plus a keyword-context rule and a
  Shannon-entropy sweep. Output is the redacted text plus a list of hits; `append.ts` sets
  `redacted: true` when the list is non-empty.
- Applied to prose *and* claims *and* `cue`, never to ids or the `session:` pointer.

Two deviations from this plan, both forced by what the code met:

1. **There is no pi-enclave regex set to copy.** Enclave defers its audit log to its own
   Phase 2, so the set is written here first, in one table, for enclave to adopt later.
2. **Entropy is scored on base64 only, never hex.** The plan asked for `> 4.0 bits/char`
   over "base64/hex", but a 16-symbol alphabet caps at exactly `log2(16) = 4.0`, so that
   threshold can never fire for hex. Lowering it would be actively harmful: the
   high-entropy hex in a coding journal is overwhelmingly git SHAs, content hashes and the
   UUIDv7s in every entry, claim and fact id — redacting those would corrupt the memory the
   journal exists to keep. Hex secrets are caught by *context* instead (`api_key: …`),
   which is the shape they actually appear in. Base64 uses a 4.5 threshold, with an
   exemption for `sha256-`/`sha512-` integrity digests, which are published hashes.

**Done when:** the fixture corpus (AWS, GitHub, Slack, OpenAI, Anthropic, generic
`key=…`, JWT, PEM blocks, high-entropy blobs, plus negatives: UUIDs, git SHAs, normal code)
produces zero false negatives and a documented false-positive rate under 1 %.
**Met:** 36 positives, 0 missed; 36 negatives, 0 flagged (0 %). At that corpus size the 1 %
gate is arithmetically a demand for zero — one false positive would be 2.8 % — and it is
stated as a rate so the corpus can grow without the gate loosening.

### 5. Capture — explicit and corrections (1 d) — **done**

- `session-state.ts`: on `session_start` (`reason` in `startup|new|resume|fork`), rebuild
  state by scanning `ctx.sessionManager.getBranch()` for `customType: "muninn-state"`
  entries written with `pi.appendEntry` — `{ recalled: [...], written: [...], task,
  continues }`. `task` is pi's session id (`ctx.sessionManager.getSessionId()`);
  `continues` is set when `reason` is `resume` or `fork` and the previous session file is
  known (`SessionStartEvent.previousSessionFile`, `core/extensions/types.ts:566`).
- `explicit.ts`: on `input` with `source === "interactive" | "rpc"` (`types.ts:828` —
  `extension`-sourced input is never `source: user`), match the README's cues (*remember*,
  *note*, *from now on*, *always*, *never* at sentence start) and `/muninn note`. Writes an
  entry with `source: user`, `channel: tui|rpc`, `phase: other` unless a phase cue is
  present, claims = lines starting `- `, prose = the rest.
- `corrections.ts`: on `input`, a cheap rule-based classifier — leading negation or
  contrast ("no", "don't", "not X", "actually", "instead", "wrong") *and* a reference to the
  previous assistant turn (pronoun or quoted fragment overlap with the last assistant
  message from `accumulate.ts`). Hits are journaled immediately with `source: user`, the
  previous assistant claim quoted in prose, and the user's text as the claim. Precision
  over recall: a missed correction is caught by the outcome entry; a false positive
  pollutes the journal.
- `channel` is `tui` in interactive mode, `rpc` under `--mode rpc`, `sdk` when the
  session was created through the SDK (detected by the absence of a TUI: `ctx.hasUI`).

**Done when:** a fixture of 60 user turns (20 explicit, 20 corrections, 20 neither)
classifies with zero false positives on the "neither" set. Entries land in the capture
target and `session-state` lists their ids after a `/resume`.
**Met:** 0 false positives on the 20 "neither" turns, and 20/20 on each of the other two
sets. Both halves are also verified against a real `pi` process in
`test/integration/capture.test.ts`, including that a `--continue` run stays in the same
task group.

Two deviations: `channel` comes from `ctx.mode` (`tui` | `rpc` | `json` | `print`), which
states the run mode directly, rather than being inferred from `ctx.hasUI`. And appends are
queued rather than awaited inside pi's event handlers — an append normally takes
milliseconds but can wait seconds on a contended store lock, and stalling a keystroke to
record a note about it is the wrong trade. `session_shutdown` flushes the queue, closing
the window where a queued entry could be lost to process exit.

### 6. Capture — accumulate, outcome, pre-compaction (2 d)

- `accumulate.ts`: `turn_end` pushes `{ turnIndex, message, toolResults }`; `agent_end`
  replaces the buffer with `messages` (authoritative); both drop messages with
  `customType === "muninn"` and record their ids into `recalled`. `agent_settled` hands the
  buffer to `outcome.ts` and clears it. A cross-check compares the buffer's first/last
  message against `ctx.sessionManager.getBranch()` and logs (not throws) on mismatch —
  this is the measurement that decides whether core change #2 is worth proposing.
- `outcome.ts`: one `ctx.modelRegistry.complete(model, context)`
  (`core/model-registry.ts:103`) with the session model (Phase 1 ignores `dream.model`),
  a fixed system prompt and the strict template: `phase:`, `cue:`, one paragraph of
  context, then claims as bullets, `used:` as a list of recalled ids that mattered. Parse
  is strict; an unparsable reply is retried once with the parse error appended, then
  dropped with a status-line warning — never journaled raw. **Skip** when the run had no
  tool calls and fewer than two turns (chit-chat), when `capture.outcomes` is false, or
  when the run already produced an outcome entry (pre-compaction path).
- **Echo tagging:** each claim is compared to every recalled text by token-overlap
  (Jaccard on lowercased word tokens ≥ 0.8); matches get `echo: <id>` on the entry. Phase
  1 writes the tag; nothing reads it until the gather phase in Phase 2.
- `session_before_compact`: run the outcome path on the current buffer *before* returning,
  mark the run as already-journaled, return nothing so compaction proceeds unchanged.
- Budget: the outcome model call is bounded to the last ~12 k tokens of the run (oldest
  turns summarised as "… N earlier turns omitted"), and cancelled on `session_shutdown`.

**Done when:** an SDK integration test runs a two-turn task with a tool call against a
fake provider (pi's test utilities) and asserts exactly one outcome entry with the
expected `task`, `phase`, ≥ 1 claim, `recalled` equal to the injected ids, and that
Muninn's own messages are absent from the prompt the fake provider received. A
compaction test asserts one entry, not two.

### 7. Journal commits (0.5 d)

- `git.ts`: `run(store, args)` with an allow-list of argument shapes (`add journal/`,
  `commit -m`, `fetch`, `rebase`, `push`, `rev-parse`, `status --porcelain`, `init`); any
  other invocation throws at the call site. Tests assert the allow-list.
- `commit.ts`: at `agent_settled`, `session_shutdown`, and before `sync`, if
  `journal/` has changes: `git add journal/ && git commit -m "journal: <host name> <n>
  entries"`. Debounced: at most one commit per 30 s per store; the shutdown path is
  synchronous and un-debounced. Commits identify the host, not the user — `user.name` /
  `user.email` are set per store to `muninn <host name>` / `muninn@<host id>` at init so a
  store never inherits a developer identity it should not publish.

**Done when:** after a session, `git log` in the store shows one commit touching only
`journal/`; a `git status` of the *project* repository is unchanged when the project store
is separate.

### 8. Tier 0 index (1.5 d)

- `chunk.ts`: heading-path chunks over `MEMORY.md`, `journal/**/*.md` (each claim is its
  own chunk with the entry header and `cue` as breadcrumb; prose is a context chunk that
  is *not* matched by active-only queries), and `topics/` + `rules.md` when present (read
  support only). Cap ~700 tokens, never split a fence.
- `tier0.ts`: `minisearch` with fields `title`, `headingPath`, `cue`, `body`, `tags`,
  boosts `title: 3, cue: 2.5, headingPath: 1.5`, prefix and fuzzy (0.2) on, stored fields
  `{ id, scope, kind, source, phase, date, superseded }`. Wikilink/backlink graph from
  `[[…]]` and bare `j-`/`f-` id mentions.
- `build.ts`: `.index/manifest.json` maps file → content hash → chunk ids; only changed
  files re-chunk; the minisearch index is serialised to `.index/tier0.json`. Rebuilt on
  `session_start` if stale, on `/muninn reindex` unconditionally, and after each append
  (incremental add of the new chunks only).
- `search.ts`: `search({ query, scope?, phase?, kind?, history?, limit? })` → ranked hits
  with `{ id, path, headingPath, snippet, date, source, scope, superseded }`. Active-only
  by default: drops chunks whose claim id is in `supersessions.md`. Multi-scope: query
  every active scope, merge by score, stable tie-break by date desc.

**Done when:** the cross-laptop acceptance test passes end-to-end in CI using two scratch
`HOME`s and a bare git remote: append a correction in `HOME1`/project A, `sync`, then in
`HOME2`/project B `memory_search("vitest watch")` returns it as the top hit with the right
id and date. Index rebuild of a 10 k-entry synthetic journal completes under 3 s on a
laptop; incremental append under 50 ms.

### 9. Recall (1 d)

- `snapshot.ts`: at `session_start` read `MEMORY.md` from each active scope, merge global
  → project, trim to `recall.snapshotLines` per scope and total, cache the string for the
  session. On every `before_agent_start` return `systemPrompt: event.systemPrompt +
  "\n\n# Memory\n…"` — byte-identical across the session (the cache, not the file). A
  project `MEMORY.md` line that contradicts a global one is not detected in Phase 1 (no
  facts exist yet); both are shown.
- `per-turn.ts`: on `before_agent_start`, `search({ query: prompt, limit: factsPerTurn })`
  filtered to `kind: claim | fact`, packed to `recall.tokenBudget`, returned as
  `message: { customType: "muninn", content, display: true }` with the fixed "memories,
  not ground truth" instruction, ids and dates. Record the ids in `session-state` as
  `recalled`. If `systemPromptOptions.contextFiles` already contains a line with ≥ 0.8
  token overlap, that hit is skipped — AGENTS.md wins.
- Nothing is injected when the index is empty; no empty "Memory" sections.

**Done when:** an SDK test asserts the system prompt received by the fake provider is
identical across three turns while `MEMORY.md` is edited on disk mid-session, and that the
per-turn message is present, labelled, and within budget.

### 10. Tools (1 d)

- `memory_search`, `memory_read`, `memory_note` per the README's table, registered with
  `pi.registerTool` (`core/extensions/types.ts:1251`), TypeBox parameters, `executionMode:
  "parallel"` (`types.ts:477`) for the two readers and `"sequential"` for `memory_note`.
- `memory_read({ id })` resolves `j-…` to the entry (whole), `j-….n` to the claim with its
  entry as context, a path to the file with optional `range`, and a `session:` pointer to
  the pi session entries via `ctx.sessionManager`-independent JSONL read of the named file
  (the pointer may be another session's file).
- `memory_note` writes `source: agent`, `channel: <session channel>`, to the capture
  target or `scope: "global"`; it cannot name any other path.
- `render.ts`: compact renderers — one line per hit: `date · scope · source · id(short)
  · heading`, full ids on expand.

**Done when:** tool schemas snapshot-tested; `memory_note` under a read-only test store
fails loudly instead of writing elsewhere.

### 11. Commands and status (0.5 d)

- `/muninn` (status: scopes, capture target, entries since last commit, index tier and
  chunk count, last sync), `/muninn note [--global] <text>`, `/muninn promote <id>`
  (copies the entry into the global journal with `promoted_from: <project slug>/<id>`),
  `/muninn search [--history] <query>`, `/muninn scope`, `/muninn reindex`, `/muninn sync`.
- Status line via `ctx.ui.setStatus("muninn", …)` (`types.ts:148`): `⟡ muninn · project ·
  t0 · 3 new` and warnings (`lock`, `redacted`, `sync failed`).

**Done when:** every subcommand has an integration test; unknown subcommands print usage.

### 12. Sync and CLI (1 d)

- `sync.ts`: under the store lock for the whole duration: commit pending journal, `fetch`,
  `rebase` onto the remote branch, `push`. Because journal files are per host, a rebase
  conflict can only come from `store.md` (two hosts registering concurrently) — resolved
  by a union merge of host lines, which is the one merge Phase 1 knows how to do; any
  other conflict aborts the rebase, leaves the store on its pre-sync commit, and reports.
  `sync.onShutdown` runs it at `session_shutdown` with a 10 s cap and a `--no-push` fast
  path when offline (fetch fails → commit only, warn once).
- `cli.ts` (`bin: muninn`): `muninn sync [--scope global|project]` and `muninn status`
  — no pi session, uses the same modules. `serve-cron` is Phase 2.

**Done when:** the two-`HOME` acceptance test from step 8 runs through `muninn sync` on
both sides, including a concurrent-registration conflict in `store.md`.

### 13. Hardening and docs (1 d)

- Failure-injection tests: lock held by a dead pid, disk full on append (ENOSPC → entry
  not written, reported), git missing, remote unreachable, index file corrupted (rebuild,
  report).
- Bun run of the whole suite.
- README: collapse the Phase 1 parts of the design into a "Using" section; keep the
  design text for unbuilt phases. Write `docs/journal-format.md` as the normative grammar
  extracted from `format.ts` tests.

**Total: ~13 working days.**

## Test strategy

| Layer | Runs | Covers |
|---|---|---|
| Unit (vitest, no pi) | every push, Node + Bun | format round-trip, ids, lock, redaction corpus, classifier fixtures, chunker, search ranking, git allow-list |
| Integration (vitest + a real `pi` process, scripted HTTP provider, scratch `HOME`) | every push, Node | capture end-to-end, recall injection and prefix stability, compaction path, commands, tools |
| Acceptance (two scratch `HOME`s, bare remote) | every push, Node | the README's Phase 1 "done when", literally |
| Concurrency (multi-process) | every push | 8 × 50 appends |

**The fake provider is an HTTP server, not an in-process double.** pi's own tests script a
model by handing `Agent` a `streamFn`, but that route is closed to an extension: neither
`createAgentSession` nor `ProviderConfig.streamSimple` is reachable without constructing an
`AssistantMessageEventStream`, and pi does not re-export it — it lives in
`@earendil-works/pi-ai`, shrinkwrapped inside pi's own `node_modules`. So
`test/fixtures/mock-provider.ts` serves a scripted OpenAI-compatible
`/v1/chat/completions` endpoint and a small extension registers it with
`pi.registerProvider`. All of that is pi's public configuration surface, which keeps the
harness from breaking on a pi upgrade — and it exercises pi's real provider path rather
than bypassing it.

Two practical notes for anyone extending the harness: pi blocks on stdin, so a child must
be spawned with `stdio: ["ignore", …]`, and `--continue` resumes the *most recent* session,
not the first.

## Risks specific to Phase 1

| Risk | Mitigation |
|---|---|
| Correction classifier noise poisons the journal | Precision-first rules, fixture-gated; every entry carries `source`/`channel` so a later dream can discount a class wholesale |
| Outcome entries are verbose or hallucinated | Strict template, strict parse, one retry, drop; bounded input; skipped for trivial runs |
| `agent_end` buffer and session tree disagree | Cross-check logs mismatches; the data decides whether core change #2 is proposed |
| Project-scope store location surprises users | Default is *separate* and shown in `/muninn scope` with the path; in-repo is opt-in |
| Prompt-cache churn from the snapshot | Snapshot string is computed once per session and appended after pi's own prompt; tested byte-identical |
| Secrets reach git | Redaction runs before the lock, before the write; `redacted: true` is visible in search results |

## Open decisions to settle during Phase 1

- Whether `memory_search` should default to the capture target's scope or all active
  scopes (plan: all active, with `scope` as a filter).
- Whether `/muninn note` with no `- ` lines should treat the whole text as one claim
  (plan: yes, implicit `.1`, matching the format rule).
- Correction classifier: add a tiny model call behind `capture.correctionsModel` if rules
  prove insufficient — decided by the fixture's measured recall after dogfooding.
