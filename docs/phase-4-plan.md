# Phase 4 — team operations and governance

**Status: complete.** The six slices below are implemented. The acceptance suite runs on
Ubuntu and macOS in CI; the journal remains plain Git/JSONL with advisory, unsigned
lifecycle state.

*Outcome: a person can safely share, join, inspect and maintain a distributed project
journal without hand-editing its Git repository, and can explicitly settle competing
corrections without erasing history.*

Phase 3 established the storage and trust boundary: one logical-project UUID, per-writer
JSONL shards, explicit Git synchronization, immutable corrections and local-versus-teammate
labels. Phase 4 makes that foundation operable by a team. It does not turn the journal into
an authoritative project database or imply security properties that unsigned Git content
cannot provide.

## Scope

Phase 4 includes:

- one-command share and join workflows over an explicit journal remote;
- a stable human and JSON roster of members, hosts and their declared lifecycle state;
- direct-user shell lifecycle declarations for the local member and its hosts;
- a complete correction-conflict inbox;
- explicit resolution records that supersede every branch the user reviewed;
- a read-only doctor covering registry, manifest, Git, shard ownership and index health;
- matching standalone CLI and safe attended-session read surfaces; and
- multi-clone, rollback, adversarial-input and cross-platform acceptance coverage.

It deliberately excludes:

- hosted accounts, a central coordinator or automatic remote provisioning;
- access control, cryptographic membership, signatures or strong revocation;
- one member silently changing another member's declared lifecycle;
- automatic conflict resolution, last-write-wins truth or journal rewriting;
- automatic stale-data pruning or summarization;
- transcript synchronization; and
- injecting journal or team metadata into model prompts.

Signing and enforceable revocation remain a later decision. They should be added only with a
real threat model and a key-recovery design; an unsigned `retired` flag must never be
presented as protection against a malicious Git writer.

## Invariants

1. The code repository remains authoritative. Team journal state is evidence and metadata.
2. Every mutation is a direct user action. Models receive read tools, not governance power.
3. Join treats the remote as untrusted input until its checked-out store, manifest, records
   and ownership are validated.
4. A failed join leaves the project registry and destination store unchanged.
5. Join never overwrites or merges an existing, different store.
6. Lifecycle changes are additive declarations with stable IDs. Projection may change;
   earlier declarations and journal records remain visible.
7. Lifecycle state is advisory without signatures. It affects display and diagnostics, not
   Git authorization or the historical visibility of records.
8. A conflict disappears only after an explicit user resolution supersedes every currently
   active competing branch. A later independent correction reopens it.
9. Doctor is read-only. Repair commands remain separate and explicit.
10. Text, JSON and model-facing reads use the same canonical projections.

## User interface

### Share and join

```text
muninn project share [PATH] [--json]
muninn project join JOURNAL-URL [PATH] [--force] [--json]
```

`share` emits the logical-project UUID, name and explicit journal remote. It fails when no
remote is configured rather than guessing from the code repository.

`join` needs only the journal URL and the code checkout to link. It clones into a private
temporary directory below the agent-owned projects root, validates `project.json`, rejects
unexpected tracked paths, scans all journal shards, verifies member/host ownership, and only
then installs the store and registry mapping. `--force` may move an existing *code-location
mapping* after validation; it never overwrites a journal directory. A durable local marker
allows a later invocation to revalidate and finish the narrow crash window between the
validated store rename and registry publication.

The machine-readable result includes the project/member/host IDs, destination, remote and
whether a mapping or store was created. Secrets embedded in credential-bearing URLs are
never echoed in text output or persisted; supported remotes must use credentials supplied by
Git/SSH configuration.

### Roster and lifecycle

```text
muninn team list [--json]
muninn team rename-member NAME [--reason TEXT] [--json]
muninn team rename-host HOST-ID NAME [--reason TEXT] [--json]
muninn team retire-host HOST-ID [--reason TEXT] [--json]
muninn team restore-host HOST-ID [--reason TEXT] [--json]
muninn team leave [--reason TEXT] [--json]
muninn team return [--reason TEXT] [--json]
```

Lifecycle declarations live in an additive `team_events` array in `project.json`. Each event
has a UUIDv7-derived ID, UTC timestamp, kind, target, actor member/host and optional bounded
name/reason. Sync union-merges events by ID and rejects non-identical duplicates. A
deterministic `(at, id)` projection supplies display name and active/retired state.

The CLI may declare state only for the registry's local member or a host owned by that
member. Readers validate the same self-declaration shape for synchronized events. This
limits accidental cross-member administration; it is not authentication, because a writer
with direct repository access can forge unsigned bytes. Retired actors' old and new records
remain searchable and receive an advisory lifecycle label.

`/muninn team` is read-only and shows the same roster inside an attended session. Lifecycle
mutation stays in the shell so it cannot change underneath queued session writes.

### Correction inbox and resolution

```text
muninn conflicts [--json|--jsonl]
muninn resolve TARGET TEXT [--json]
```

`conflicts` returns every target with more than one active correcting/superseding branch,
including bounded record summaries and trust/lifecycle labels. It is not limited by a search
query.

`resolve` first reads the current conflict. It appends one direct-user correction containing
`corrects TARGET` plus `supersedes BRANCH` for every active branch shown to the user. It does
not alter those records. If the target is not currently conflicted, it exits distinctly and
writes nothing. `/muninn conflicts` is available for review; resolution remains an explicit
shell command in the first release.

### Doctor

```text
muninn doctor [--json]
```

Doctor reports independent checks for:

- local registry syntax and selected mapping;
- destination path and Git repository identity;
- project manifest schema and project UUID agreement;
- explicit manifest remote versus repository `origin`;
- member/host/event identity collisions;
- JSONL validity, duplicate IDs and shard ownership;
- lifecycle anomalies such as records after a retirement declaration;
- relation cycles, missing targets and unresolved conflicts; and
- disposable index readability and scan/index ID equivalence.

Each check is `ok`, `warning` or `error`, has a stable code, and includes a bounded remedy.
Text goes to stdout as a report; operational failures do not contaminate JSON output.

## Manifest evolution

`team_events` is an additive optional field in schema 1. Phase 4 readers accept old manifests
as an empty event list before Phase 4 writers emit the field. Once a lifecycle event is
written, the field is retained and deterministically sorted. The existing project/member/
host IDs and writer-shard rules do not change.

Manifest reconciliation is field-aware:

- project UUIDs and incompatible remotes still conflict;
- base member/host identity collisions still stop sync;
- identical lifecycle event IDs must have identical canonical bytes; and
- distinct lifecycle events are unioned and sorted by `(at, id)`.

## Implementation sequence

Each numbered slice is one reviewable commit. Tests for a slice land with that slice.

### Commit 0 — contract and roadmap (implemented)

- Freeze the scope, non-goals, trust language and commands in this document.
- Link the Phase 4 plan from the README and operations guide.

Done when later implementation choices can be judged against explicit invariants.

### Commit 1 — safe share and join (implemented)

- Add share output and a validated temporary-clone join transaction.
- Add the minimal allow-listed Git inspection/clone operations.
- Refuse unsafe URLs, unexpected tracked paths, wrong IDs, damaged records, ownership
  violations and existing destination stores.
- Roll back temporary files and registry changes on every injected failure.

Tests: share text/JSON; local bare remote; join with URL only; existing mapping; `--force`
mapping; wrong/damaged manifest; unexpected path; ownership collision; failed clone; install
failure; concurrent join.

Done when a fresh machine joins a two-member fixture with one command and a failed join is
observably a no-op.

### Commit 2 — roster and lifecycle declarations (implemented)

- Add canonical lifecycle event parsing, merge and projection.
- Add local-authority mutation functions and Git commits.
- Add `team list`, rename, retire/restore, leave/return commands.
- Add lifecycle labels to roster, query results and doctor inputs.
- Add read-only `/muninn team`.

Tests: deterministic projection; event collision; concurrent event merge; local member/host
authority; teammate mutation refusal; record visibility; post-retirement warning; JSON/text
parity.

Done when two clones exchange lifecycle declarations and still return every historical
record with the same advisory state.

### Commit 3 — conflict inbox and explicit resolution (implemented)

- Project active conflicts after superseded branches are removed.
- Expose a bounded conflict DTO from the canonical query service.
- Add CLI and attended conflict listing.
- Add headless direct-user resolution with complete superseding relations.

Tests: two branches; resolution; immutable bytes; later correction reopening; concurrent
resolutions; missing target; no-conflict no-op; output bounds; local/teammate labels.

Done when a user can drain the conflict inbox without any timestamp silently selecting
truth.

### Commit 4 — doctor and operational recovery (implemented)

- Implement read-only checks with stable codes/severity.
- Cover registry/store/manifest/Git/shards/events/relations/index boundaries.
- Add text and JSON output with actionable remedies.
- Extend the operations guide with join, lifecycle, conflict and doctor runbooks.

Tests: one fixture per code; multiple simultaneous problems; clean store; corrupt index;
remote mismatch; JSON stdout cleanliness; proof that doctor writes no bytes.

Done when a team member can distinguish repairable local state, expected advisory warnings
and sync-blocking corruption without inspecting implementation files.

### Commit 5 — release hardening (implemented)

- Run real multi-clone acceptance on Linux/macOS path semantics.
- Add cancellation and both pre-install cleanup and post-install recovery coverage for join.
- Audit output bounds, URL redaction and hostile manifest/event text.
- Update README, format and operations docs from target language to implemented language.
- Remove any temporary Phase 4 compatibility paths.

Done when all local and CI suites pass and the manual onboarding sequence is documentation
for recovery rather than the primary interface.

## Roadmap impact

### Phase 5 — retrieval quality and scale

Phase 5 receives canonical lifecycle and conflict projections as ranking/filter inputs. It
adds explicit relevance evaluation, score explanations, projected filters and deterministic
typo-tolerant lexical ranking under a 50,000-record budget. Raw JSONL scanning stays the
correctness oracle and lifecycle never hides history by default. See
[phase-5-plan.md](phase-5-plan.md).

### Phase 6 — integrations

External importers use the same writer authority and can supply external observations, not
user corrections or governance events. Automation may run doctor and sync, but mutation
requires explicit credentials and policy.

### Phase 7 — optional cryptographic governance

Only evidence from real distributed use should start this phase. It would need a threat
model, member keys, rotation/recovery, signed records and events, remote ACL interaction and
an explicit answer for compromised-key history. Until then, Phase 4 lifecycle state remains
honestly advisory.
