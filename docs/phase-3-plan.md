# Phase 3 — logical project journal

> **Status: implemented.** PRs 0–8 are represented by the commits on the Phase 3 branch.
> The format contract, operational procedures and release budgets are now executable or
> documented rather than future design.

*Outcome: every pi session in one logical project can contribute bounded history to one
append-only journal, across linked worktrees, and both models and people can search that
history explicitly.*

This plan is written against pi `v0.84.2`. The existing extension hooks, tools, slash commands
and standalone CLI are sufficient; no pi fork is required.

The repository, configuration, tests, documentation and Git remain authoritative. Muninn
records the path by which that state was reached. It does not turn journal text into hidden
instructions or judge on its own that old history is stale.

The target record contract is
[project-journal-format.md](project-journal-format.md). The current Markdown input is
[journal-format.md](journal-format.md).

## Scope

**In:** logical project UUIDs · linked worktree discovery through Git common directories ·
explicit user-owned project mappings · member and host identity · per-writer monthly JSONL
shards · lossless Markdown migration · session/worktree/branch/commit provenance · outcome,
checkpoint, note, correction and import records · explicit relation chains · deterministic
lexical search and filters · model search/read/context/note tools · attended commands · a
headless CLI with stable JSON · direct use with `jq`, `rg` and fuzzy finders · Git sync ·
concurrent capture · status, failure injection, fixtures and documentation.

**Out:** automatic prompt injection · generated project instructions · autonomous stale-data
judgement · age-based removal · rewriting records during routine operation · copying complete
pi transcripts into the journal · a hosted service · mandatory embeddings or reranking ·
silently grouping clones by a mutable code-remote URL · allowing project-controlled settings
to select a journal path or remote.

## Acceptance criteria

Phase 3 is complete when all of these hold:

1. Two simultaneous pi sessions in linked worktrees append complete records to different
   writer-owned shards of one logical project store.
2. Either session can search the other's completed record without copying data between
   checkout-scoped stores.
3. Canonical scan, model tool, slash command and CLI return the same record IDs for equivalent
   queries and filters.
4. CLI `--json` is stable and composes directly with `jq`, `rg` and a fuzzy finder.
5. `/muninn correct ID TEXT` appends a direct-user correction relation; the target line remains
   unchanged and both records are returned by relation-aware read.
6. A model cannot create a `source: user` correction through any registered tool.
7. Competing corrections are reported as a conflict, not silently resolved by timestamp.
8. A Markdown store migrates with stable IDs, provenance and session pointers. Re-running the
   migration creates no duplicates.
9. After two hosts synchronize, each can search the other's journal record. A missing remote
   transcript is reported without hiding that record.
10. Deleting `.index/` and rebuilding it preserves the canonical filtered result set.
11. No journal content enters a model prompt until the model invokes a journal tool.
12. Interrupted append, malformed-line, identity-collision and Git-conflict tests demonstrate
   bounded failure without data loss.

## Product contract

### Authority layers

| Layer | Authority | Mutation | Access |
|---|---|---|---|
| Project repository | Current behavior and instructions | Normal project/Git workflow | Pi context and ordinary file tools |
| Project journal | Historical evidence and provenance | Immutable records appended by authorized writers | Explicit journal queries |
| Query projection/index | Relations, trust labels, filtering and acceleration | Disposable and rebuildable | Shared query service |

A journal record can explain why a decision was made at a particular commit. It cannot
override files that now say otherwise.

### Logical project identity

`git rev-parse --show-toplevel` identifies one checkout. Phase 3 adds a resolver with this
precedence:

1. an explicit canonical-root mapping in the user-owned registry;
2. a registry mapping for canonical `git rev-parse --git-common-dir`;
3. a new local project UUID minted for an unregistered common directory or non-Git root.

The registry lives below the pi agent directory. A project may contain an identifier hint,
but it becomes active only after the user links it to a local store. Repository content can
never select an arbitrary filesystem path or sync remote.

Each resolved session carries both identity and provenance:

```text
project UUID
member UUID
host UUID
canonical common directory
canonical worktree root
working directory
branch or detached state
HEAD commit
dirty flag
```

Paths can change and are never used as durable project IDs. A code-remote URL is a displayable
hint only; forks and independent projects frequently share or change remotes.

### Writer ownership and synchronization

The store uses `journal/<member>/<host>/<YYYY-MM>.jsonl`. A writer appends only to its own
member/host path. Local sessions share one store lock; remote hosts normally touch different
files. A host ID observed with two writers is an error that blocks sync.

Git synchronization remains explicit and reviewable. Only the manifest, migration manifest
and journal shards are staged. Manifest conflicts, non-identical duplicate IDs and shard
ownership violations stop for attended resolution.

### Session boundary

The journal stores bounded records, not transcripts. The detailed pi JSONL remains in pi's
session directory and a journal record may point to its supporting entry range. This keeps
the team journal useful without synchronizing hidden reasoning, complete prompts, large tool
outputs or secrets.

Outcome/checkpoint generation may use the session model, but deterministic provenance is
computed by code and the result is always labelled `source: agent`. A direct note or
correction preserves user text instead of asking a model to rewrite it.

## Correction semantics

Stale or mistaken information is handled by an explicit user action:

```text
old record ──corrects/supersedes/annotates──▶ new user record
```

The arrow is stored on the new record as `{type, target}`. The old line is immutable.

- `corrects` says what is wrong or stale;
- `supersedes` asks the projection to prefer the new user statement for its stated subject;
- `annotates` adds context without disputing the target.

The projection labels relations and ranks a direct user correction with its target, while
raw and relation-aware queries always expose the original. It does not infer transitive truth
outside an explicit chain. Branches in that chain are conflicts presented to the caller.

Authority is enforced at the interface boundary:

| Writer | May write record | May use `source: user` | May relate to earlier record |
|---|---:|---:|---:|
| Attended slash command | yes | yes | yes |
| Direct headless CLI/API user | yes | yes | yes |
| Model journal tool | yes | no | agent note only |
| Automatic outcome capture | yes | no | no in Phase 3 |

No background process appends correction meaning, changes a record's visibility or removes
old data. Search can filter by dates, sources and relations because the caller asked it to;
that is a query, not maintenance.

## Shared query service

One internal service owns schema validation, canonical scan, relation resolution, filters,
ranking, pagination and output limits. Every interface delegates to it.

Initial filters:

```ts
interface JournalQuery {
  query?: string;
  ids?: string[];
  type?: Array<"outcome" | "checkpoint" | "note" | "correction" | "import">;
  source?: Array<"user" | "agent" | "tool" | "external" | "mixed">;
  member?: string[];
  host?: string[];
  branch?: string[];
  path?: string[];
  tag?: string[];
  status?: string[];
  since?: string;
  until?: string;
  relatedTo?: string;
  limit?: number;
  cursor?: string;
}
```

An empty textual query with filters is valid. Exact IDs rank first. Lexical matches use body,
cue, paths and tags with documented fixed weights. Direct user corrections are returned with
their targets but do not erase them. Recency and Git proximity are bounded secondary signals.

The canonical implementation can scan JSONL without an index. MiniSearch or another local
index accelerates it and is verified against scan-mode fixtures.

## Interfaces

### Model tools

```ts
journal_search(query: JournalQuery)
journal_read({ id, relationDepth? })
journal_context({ ids, maxChars? })
journal_note({ text, cue?, tags?, relations? })
```

- `journal_search` returns bounded summaries, provenance, trust labels and stable IDs.
- `journal_read` returns a complete record and a bounded explicit relation neighborhood.
- `journal_context` batches selected IDs under a hard output limit; nothing calls it
  automatically.
- `journal_note` writes only `source: agent`. Relation types exposed here are restricted so
  the model cannot impersonate a direct-user correction.

Tool descriptions say that journal content is fallible historical evidence. The extension
registers no lifecycle hook that inserts record bodies into prompts.

### Attended commands

```text
/muninn search QUERY [FILTERS]
/muninn show ID [--relations]
/muninn sessions [FILTERS]
/muninn tail [FILTERS]
/muninn note TEXT
/muninn correct ID TEXT
/muninn annotate ID TEXT
/muninn project
/muninn reindex
/muninn sync [--no-push]
```

Attended corrections show the target and exact new record before append when the text was
model-proposed. Direct text typed in `/muninn correct` needs no second confirmation because
the command itself is the explicit action.

### Headless and Unix interface

```text
muninn search QUERY [FILTERS] [--json|--jsonl]
muninn show ID [--relations] [--json]
muninn sessions [FILTERS] [--json|--jsonl]
muninn tail [FILTERS] [--follow] [--jsonl]
muninn note TEXT [--json]
muninn correct ID TEXT [--json]
muninn annotate ID TEXT [--json]
muninn path
muninn project link|show|unlink
muninn project remote [URL|--remove]
muninn migrate [--dry-run]
muninn reindex
muninn sync [--no-push]
```

Human text can change for clarity; versioned JSON fields are compatibility surface. Exit
codes distinguish no matches, invalid input, unavailable local transcripts and store/sync
failures. `muninn path` makes raw `rg`, `jq`, editors and fuzzy finders convenient without
requiring a shell-specific integration.

Team onboarding, migration and failure recovery are specified in
[operations.md](operations.md).

## Implementation sequence

Each step is intended to be one reviewable PR. Later PRs may change current command names and
store code directly; the extension is not released, so compatibility scaffolding is not a
goal.

### PR 0 — reset to the journal foundation

- Replace active documentation and roadmap with this direction.
- Remove generated-knowledge, automatic retrieval and prompt-injection code.
- Remove settings, formats, commands, fixtures and tests that exist only for those paths.
- Keep append safety, redaction, provenance, journal indexing, explicit tools and Git sync.
- Keep the suite green so Phase 3 starts from a small coherent baseline.

Done when active source/tests/docs contain no obsolete surface and the branch is one clean
commit relative to `main`.

### PR 1 — logical project resolver (implemented)

- Add user-owned project registry schema and atomic writes.
- Resolve canonical Git common directory and worktree root.
- Mint/reuse project, member and host IDs.
- Add explicit `project link|show|unlink` commands.
- Make status show project ID, aliases and why the resolver selected them.

Tests: linked worktrees, symlinks, detached HEAD, bare/non-Git roots, renamed paths,
untrusted hints, corrupted registry and concurrent registry update.

Done when two linked worktrees resolve to the same project UUID and store without using the
code-remote URL as identity.

Implemented with a locked, atomically replaced user registry, UUID-only external stores,
canonical root/common-directory aliases, member identity, attended status and explicit CLI
link/show/unlink commands. The resolver suite covers every case listed above.

### PR 2 — JSONL schema and append engine (implemented)

- Implement schema validation and canonical serialization.
- Add per-member/host monthly shard selection.
- Implement single-write append, flush and truncated-tail handling.
- Capture deterministic Git/worktree/session provenance.
- Add scan-mode reader, ID collision detection and record-size limits.

Tests: golden records, property round trips, malformed middle/final lines, interrupted write,
same-host concurrent sessions, shard rollover, redaction and identity collision.

Done when concurrent linked-worktree sessions produce a journal that a lock-free scan can
read completely.

### PR 3 — Markdown migration (implemented)

- Inventory legacy stores mapped to the logical project.
- Convert valid entries into `import` records with stable IDs.
- Write source fingerprints and counts to `migration.json`.
- Support dry-run, resume and verification before registry cutover.
- Leave source stores untouched.

Tests: full/minimal/unknown-field/truncated entries, duplicate source stores, rerun
idempotence, interrupted migration and rollback before cutover.

Done when a second migration appends zero bytes and reports identical counts.

### PR 4 — corrections and relation projection (implemented)

- Validate relation types and target IDs.
- Implement relation graph reads, cycle reporting and conflict labels.
- Add attended/headless correct and annotate commands.
- Enforce source authority in one writer API.
- Define deterministic ranking of user corrections with their targets.

Tests: target missing locally, self-link, cycle, chain, competing corrections, teammate
correction, model authority rejection and immutable target bytes.

Done when a user can correct a stale record without modifying it and every interface sees the
same relation chain.

### PR 5 — query service and index (implemented)

- Implement filters, ranking, pagination and stable result DTOs over scan mode.
- Add a rebuildable lexical index and incremental append updates.
- Compare indexed results with canonical scan in every query fixture.
- Add bounded relation expansion and trust labels.

Tests: exact ID, phrase/token, cue/path/tag, date, Git and actor filters; pagination stability;
index deletion/corruption; correction ordering; malformed records; hard output budgets.

Done when scan and indexed modes return identical filtered IDs.

### PR 6 — model tools (implemented)

- Register `journal_search`, `journal_read`, `journal_context` and `journal_note`.
- Remove temporary `memory_*` names rather than maintaining aliases.
- Keep read/search parallel and append sequential.
- Record explicit journal tool calls as ordinary session evidence.
- Verify no prompt injection hook exists.

Tests: serialized schemas, traversal resistance, transcript allowlist, output bounds, source
authority, cancellation and two-worktree visibility.

Done when a clean model session knows how to ask for journal history and receives none until
it does.

### PR 7 — human and Unix interfaces (implemented)

- Route slash commands and CLI through the query service.
- Add text, `--json` and streaming `--jsonl` renderers.
- Add sessions, tail, show, path and project commands.
- Keep stdout machine-clean and send diagnostics to stderr.
- Add optional fuzzy selection as a caller convenience, never a dependency.

Tests: golden JSON/schema, pipe closure, no-match/error exit codes, terminal widths, non-TTY
behavior, follow cancellation and parity with model query IDs.

Done when documented `jq`, `rg` and fuzzy-finder examples work unchanged.

### PR 8 — team sync and release hardening (implemented)

- Add explicit journal remote linking and member display metadata.
- Harden per-writer ownership checks and Git reconciliation.
- Label local/teammate and user/agent trust combinations.
- Add multi-clone integration fixtures and missing-transcript behavior.
- Complete migration/recovery docs and performance budgets.

Tests: two members/two hosts, concurrent sync, manifest conflict, host collision, non-identical
duplicate ID, teammate corrections, unavailable transcripts and adversarial journal text.

Done when two clones exchange searchable records without sharing transcripts or confusing a
teammate assertion with a local instruction.

Implemented with explicit manifest remotes, member/host display metadata, ownership checks
before and after reconciliation, deterministic manifest union, local/teammate trust labels,
missing-transcript metadata and exit code, real two-clone fixtures, recovery documentation
and a 10,000-record performance gate. The active Markdown writer and Tier-0 compatibility
stack were removed; only the legacy parser required by migration remains.

## Test strategy

### Fast contract suite

- schema and serializer golden tests;
- project resolver and registry tests;
- relation graph and authority tests;
- canonical scan/index equivalence;
- query/filter/ranking fixtures;
- redaction and path-boundary tests;
- CLI JSON schema and exit-code tests.

### Concurrency and failure injection

- multiple processes appending through linked worktrees;
- process termination before write, during write and before flush;
- malformed line between valid lines;
- simultaneous registry operations;
- sync races between two clones;
- host identity collision and manifest conflict;
- interrupted migration and rebuild.

### Pi integration

- session start, resume/fork, settle, compaction and shutdown;
- TUI, RPC and print/headless channels;
- model tool registration and cancellation;
- proof that journal text is absent before a tool call;
- transcript resolution from an allowed pointer only.

### Release performance budgets

- cold validation and index construction for 10,000 typical records: under 8 seconds on the
  CI reference environment;
- twenty exact lexical queries over that index: under 2 seconds;
- one canonical record: at most 64 KiB;
- one normal query response: at most the configured output budget, 128 KiB by default;
- append: one local locked write and flush, with no model or network dependency.

The executable large-journal gate is `test/unit/query-perf.test.ts`. Canonical scan/index
equivalence remains the correctness gate at every size.

## Security and privacy gates

- Canonicalize every configured path before access.
- Never trust project content to choose an external store or remote.
- Redact before append and before Git sees bytes.
- Bound record, query, relation-neighborhood and tool-output sizes.
- Treat journal strings as untrusted data in model-facing renderers.
- Preserve source/member/host labels through every query path.
- Require direct-user authority for user corrections.
- Do not synchronize pi transcripts by default.
- Refuse dangerous Git remote forms and stage only allowlisted paths.

## Roadmap impact

### Phase 4 — team operations and governance

Phase 4 is complete: it added validated onboarding, shell-only lifecycle declarations,
read-only attended roster/conflict views, explicit conflict resolution and operational
doctor diagnostics. It did not introduce an authoritative shared summary. Signed identity
or enforceable revocation is deferred to an optional Phase 7, contingent on evidence from
real team use and an explicit key-recovery design. Optional transcript exchange remains a
separate encrypted capability with explicit policy.

### Phase 5 — retrieval quality and scale

Phase 5 evaluates real journal queries and improves deterministic retrieval: full-text/fuzzy
indexes, Git/path-aware ranking, query explanation and larger histories. Local embeddings are
considered only if measured misses justify their cost and opacity. Canonical JSONL scan stays
the correctness oracle.

### Phase 6 — integrations

Phase 6 connects remote-session and sandbox systems through the stable journal/query APIs.
Integrations may contribute provenance-rich records or offer authorized remote transcript
access, but cannot bypass source authority or make the plain-file workflow depend on a
service.

## Decisions fixed by this plan

- Project identity is explicit and UUID-based; paths and remotes are aliases.
- Linked worktrees share one logical store.
- Durable storage is sharded append-only JSONL.
- Full transcripts stay outside the journal by default.
- Retrieval is explicit through tools and user interfaces.
- Human and model interfaces use one query service.
- User corrections are new records with typed relations.
- Models cannot write with user authority.
- No automatic process decides that data is stale or changes its state.
- Indexes are disposable and canonical scan is always supported.
- Later implementation replaces temporary APIs directly; compatibility code is not retained
  before the extension's first complete release.
