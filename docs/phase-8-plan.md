# Phase 8 — model-assisted memory and solution recall

**Status: core implementation complete; local Node 24 checks passed. Real-model quality
evaluation and the remaining runtime/platform release matrix are pending.** Assisted recall
requires explicit global user opt-in and stays `manual` by default, independently of the
quality evaluation's outcome.

Implementation notes:

- `src/memory/` implements model resolution, structured extraction, branch processing and
  recoverable prepared writes. `src/recall/` implements bounded model-assisted selection.
- The two new tools share `src/tools/journal-memory.ts`; both slash commands are wired through
  the extension. Current settings and workflows are documented in the user guide.
- Pi snapshots tool guidance at runtime construction. Assisted mode therefore uses a
  `before_agent_start` hook carrying only procedural guidance, with no journal content.
- Private `muninn-memory-v1` session entries preserve frozen records and processed ranges.
  Operations have an eight-call ceiling in addition to the shared time and per-call token
  limits. These bounds can yield a partial result that the user can explicitly retry.
- `npm run eval:memory -- --model PROVIDER/MODEL` is the opt-in real-model fixture runner.
  Scripted tests do not close the factual-quality or proactive-use acceptance gate.
- Local verification and an intermittent unrelated clone-cancellation test failure are
  recorded in [testing](testing.md#memory-extraction-and-assisted-recall).

Outcome: a user can ask Muninn to remember the useful lessons from a session, using a
separately selected memory model. A later task can recall a relevant solution, understand
when it applies, and avoid repeating a known failed approach. Journal storage contains
compact evidence-backed memories; pi retains the original local transcript for inspection.

This phase follows the completed Phase 7 cryptographic governance work and release
hardening. It builds on the current capture, query and governed-write services.

## User experience and completion example

The acceptance scenario is a test runner that hangs in CI:

1. In session A, the agent observes the hang, investigates, tries an unsuccessful timeout
   change, fixes the invocation with a verified command, and checks the result.
2. Automatic capture stores the issue, supported cause, working command, failed attempt,
   verification and applicability. The user can also say “Remember how we solved this” or
   run `/muninn remember` to request a retrospective over the current session branch.
3. In session B, the user asks about the same symptom using different wording. The agent
   searches before repeating the investigation, loads the applicable memory and any
   corrections, and identifies the earlier evidence to the user.
4. The agent checks that the command and environment still apply to the current checkout.
   A historical success alone does not establish that today's issue is fixed.
5. An unrelated session receives no irrelevant memory. A conflicting or corrected solution
   is presented with its uncertainty instead of being recommended as an established fix.

Explicit recall remains available through `/muninn recall QUERY` and ordinary requests such
as “Recall earlier solutions for this error.” The user does not need to know record IDs or
the individual journal tools.

## Phase 7 baseline and Phase 8 changes

| Area | Phase 7 behavior | Phase 8 change |
| --- | --- | --- |
| Outcome capture | `src/capture/outcome.ts` summarizes a bounded run; `src/index.ts` calls the active session model at settlement and before compaction. | Select a memory model independently and extract structured, supported lessons. |
| Explicit remembering | `src/capture/capture.ts` saves the user's remember text; `journal_note` saves model-authored prose. | Add session retrospectives and focused issue capture; distinguish the request to summarize from the facts being remembered. |
| Long sessions | The run renderer favors recent messages; older messages and long individual outputs can be truncated. | Process bounded chunks and retain links to earlier checkpoints so early failures and later fixes can be connected. |
| Recall | `journal_search`, `journal_read` and `journal_context` support explicit lexical retrieval and selected context. | Add a bounded model-assisted recall operation and teach the coding agent when to use it. |
| State and evidence | Session deltas retain the task and written IDs; records can point to the local transcript. | Track completed capture operations and exact source ranges across retries, compaction and resume. |

The Phase 7 outcome call had a 12,000 estimated-token input budget and retried malformed
output once. `journal_context` defaults to 12,000 characters. These are different limits;
the new interfaces must keep input tokens and output characters distinct.

## Scope and design decisions

### 1. User-selected memory model

Implemented settings under the existing global `muninn` object:

```json
{
  "muninn": {
    "memory": {
      "model": "session",
      "maxInputTokens": 12000,
      "maxOutputTokens": 2000,
      "timeoutMs": 30000
    },
    "recall": {
      "mode": "manual",
      "maxCandidates": 20,
      "maxChars": 12000
    }
  }
}
```

`memory.model` also accepts `{ "provider": "configured-provider", "id": "configured-model" }`.
The `session` default preserves current model selection. A dedicated model handles both
memory extraction and recall relevance selection; the coding model owns the task and the
decision to apply a remembered solution. Assisted mode requires explicit global user
opt-in; selecting a model alone does not enable it.

- Resolve the model through pi's existing model registry and authentication. The installed
  0.85.0 API exposes `find(provider, modelId)` and `complete(...)`; no new provider SDK or
  credentials store is needed. Keep the coding model unchanged.
- Snapshot model selection for each operation. Changing the session model affects the next
  operation in `session` mode, and does not redirect an in-flight operation.
- An explicitly selected model that is missing, unauthenticated or unavailable produces an
  actionable diagnostic. Do not silently send its input to another provider. Existing raw
  search/read and direct notes remain usable.
- Model selection is global/user-owned. Project settings may disable assisted recall or
  automatic capture and lower numeric budgets; they cannot select a provider, raise budgets,
  or re-enable a globally disabled capability. Preserve existing `capture.outcomes` behavior.
- Bound total model time, input, output and retries per operation. Reserve space for the
  extraction/selection prompt and output inside the selected model's context window. Smaller
  windows reduce chunk size. Permit at most one format-repair retry within the same deadline.
- Show the effective memory model, recall mode, operation outcome and available usage counts
  in `/muninn` status. Keep model configuration and usage telemetry in local state.

### 2. Relevant memory content

Replace the free-form outcome reply contract with a validated internal response containing
zero to five memories per chunk, within the shared output budget. For an issue/solution
memory, the model supplies:

| Field | Meaning |
| --- | --- |
| `symptom` | Observable problem, useful error text, failing command or affected behavior. |
| `cause` | Supported explanation, or an explicit indication that the cause is unknown. |
| `solution` | Steps or changes that worked, with exact commands/flags when available; absent for unresolved work. |
| `failed_attempts` | Approaches worth avoiding and their observed failure conditions. |
| `verification` | What was checked and the observed result; distinguish a proposed check from an executed one. |
| `applies_when` | Environment, versions or other constraints affecting reuse. |
| `cue` | Short description of when a future session should retrieve this memory. |
| `evidence_refs` | References to the supplied source messages or prior records supporting the claims. |

Keep a general durable-outcome variant for decisions, constraints and discoveries that do
not fit an issue/solution. Routine progress reports, conversation logistics, copied file
contents and repeated tool output are excluded. Unresolved investigations can still produce
useful memories. A valid empty result means there is nothing durable to store.

Use a bounded JSON response and a provider-independent parser. Code checks field sizes,
allowed fields and evidence references; the prompt and evaluation check factual support.
Schema validation cannot prove a model's causal explanation. Missing evidence must remain
unknown rather than becoming an invented successful fix or verification result.

Persist the rendered fields as readable sections in the existing `body`, with a versioned
format marker and a stable tag such as `memory:issue-solution:v1`. Existing lexical search
then indexes symptoms, causes, commands and solutions without new top-level schema fields.
Retain the existing phase tags and `cue`. Current clients continue to read these records,
and older unstructured records remain eligible for recall.

Code assigns IDs, source, type, task, session pointers, Git provenance and observed paths.
Select canonical status only from trustworthy runtime evidence; omit it or use `unknown`
when settlement alone does not prove completion. Do not accept these metadata fields from
the memory model. Keep automated records `source: agent`, and preserve signing, redaction,
the 64 KiB canonical record limit and writer authority checks.

### 3. Session processing and explicit remembering

Implement a shared capture service used by settlement, pre-compaction, a new
`journal_remember` tool and `/muninn remember [FOCUS]`.

- Automatic capture processes newly completed work. Explicit remembering examines the
  current session branch and its existing memories, with optional focus text such as “the
  CI hang and how to avoid it.” It can recover relevant earlier work instead of merely
  storing that request sentence. It never traverses sibling branches or unrelated sessions.
- `journal_remember` accepts focus text, not arbitrary transcript paths, identities or
  preconstructed outcome records. The extension supplies the branch and evidence through
  the capture service. The service retains the automatic-writer authority boundary.
- `/muninn remember` is a direct invocation and returns written/reused IDs, skipped work and
  any partial-processing diagnostic. A natural-language request is handled by the coding
  agent through `journal_remember`; a targeted fix to explicit-cue handling prevents
  “remember this session” from also becoming a misleading fact note. Literal instructions
  such as “Remember: use pnpm here” and `/muninn note TEXT` retain direct-user provenance.
- `capture.outcomes: false` disables automatic extraction; an explicit remember request may
  still initiate extraction when the project journal is enabled. A disabled project journal
  blocks both. Document and test this distinction.
- Build model input from visible user/assistant messages and relevant tool arguments and
  results. Exclude hidden reasoning, Muninn bookkeeping, summarizer messages, binary payloads
  and attachments. Refer to transcript evidence when omitted material is needed.
- Redact selected text before sending it to the memory model, and redact the resulting
  record again before signing and storage. Selecting a remote memory model sends the bounded
  excerpt to that provider; keeping full transcripts out of journal Git does not mean all
  processing stays on the originating machine.
- Process oversized work in bounded chronological chunks, preserving useful error lines,
  commands and verification evidence with explicit omission markers. Collect checkpoints
  before the buffer would otherwise discard early work, and at pre-compaction. Record the
  source `first` and `last` IDs for each frozen chunk.
- Feed a bounded set of prior same-task checkpoint memories into later extraction so a fix
  can be related to an earlier failure. An explicit retrospective may synthesize these
  records and uncovered branch messages. Preserve contributing record IDs in the rendered
  evidence section; the transcript range must not pretend to cover evidence from another
  range. No automatic correction or supersession relations are introduced.
- Freeze input before dispatch. Serialize capture operations and prevent journal tool
  results or recall-only turns from recursively generating new memories of old memories.
  A new application and verification of a recalled fix can supply new evidence.

Capture is incremental and recoverable. Extend private pi session deltas with an operation
identity derived from source ranges, focus and extraction version, plus preallocated record
IDs and bounded prepared records. Freeze canonical timestamps and signing inputs with the
prepared payload so replay does not regenerate different bytes. Persist the validated,
redacted prepared records before append; reconcile their IDs under the journal lock on retry.
Mark ranges processed only
after all appends succeed or the model returns a valid empty result. A crash between append
and state update must reuse the existing identical records; changed bytes for an existing ID
are an error. Old session deltas must still load.

Repeated remember requests over the same evidence reuse existing IDs. A different focus may
produce additional memories, but compares against existing same-task memories to avoid exact
duplicates. Semantic deduplication remains best effort; do not delete history or merge
unrelated incidents based on text similarity alone.

Model calls run outside the journal lock. Automatic capture must not stall the coding loop
indefinitely. Use bounded backpressure and explicit partial/deferred status when a capture
budget is exhausted. Failed or cancelled work remains eligible for a later explicit retry.
Session switches retain the original operation's project and evidence identity; late results
must never be appended to the replacement session's project.

### 4. Model-assisted recall into the current session

Add `journal_recall` as the convenience operation over the existing query/read services:

1. Accept task/error text and optional path/branch hints; redact and bound the input.
2. Use lexical search for exact error fragments, commands, identifiers and task terms. Treat
   the current branch/path as ranking hints unless the caller explicitly requests filters.
3. If direct candidates are weak, permit one bounded query-expansion call to the selected
   memory model and at most three alternative lexical queries. Synonymous problem wording
   is a required test case. Expansion still searches the local journal.
4. Merge and deduplicate candidates, load their bounded records and relevant correction or
   annotation neighborhoods, and ask the memory model to select zero to five useful records
   with short applicability reasons. The model may only return IDs from this candidate set.
5. Validate selections, refresh the query snapshot and return the selected canonical records
   with attribution, verification, conflict labels and reasons under `recall.maxChars`.
   If corrections or trust changed during selection, revalidate the evidence before return.

The complete recall operation, including expansion and any format repair, shares one
deadline. Limit candidates to 20 by default and 50 maximum; clamp returned context to the
existing 64,000-character maximum. Keep full records intact. Omitted oversized records,
missing IDs and unavailable correction neighborhoods must be reported. A solution cannot
be returned as unqualified when its relevant corrections could not fit.

In ordinary mode, retain unsigned/legacy evidence with existing verification labels. Invalid
or locally distrusted material cannot become a recommended fix. Conflicts and compromised
history follow the existing local trust semantics and must be explicit to the coding model.
Model-written reasons remain separate from canonical record text and never replace it.

`journal_recall` returns evidence as a normal, visible tool result in the active session.
Existing `journal_search`, `journal_read` and `journal_context` remain available for manual
inspection, including records that assisted selection declines. Memory-model failure returns
an actionable status and preserves access to these deterministic tools; it does not pretend
that no relevant history exists.

`/muninn recall QUERY` starts the same assisted workflow using an extension-origin request to
the coding agent. The query is user-supplied data in that request; neither it nor generated
wrapper text becomes a direct-user memory. Support TUI and RPC, with plain diagnostics when
no interactive UI is present. The standalone CLI retains raw `search`/`show`; standalone
model-backed commands and their authentication lifecycle are outside this phase.

### 5. Proactive use and honest feedback

`recall.mode` has two values: `assisted` (opt-in) and `manual` (default). Assisted mode adds
concise tool guidance instructing the coding agent to call `journal_recall` for a substantive
new task, an explicit reference to previous work, or a newly encountered error before
repeating an investigation. Reuse an existing recall for an unchanged task/error; search
again when evidence or the task changes. Skip ordinary chat and routine successful commands.

Pi 0.85.0 snapshots tool `promptGuidelines` at runtime construction. Session-specific
assisted guidance is therefore added through `before_agent_start`; the hook does not read
the journal or insert journal text into the system prompt. Guidance reflects effective
session settings across reloads and project changes, and manual mode receives none.

This is agent-initiated proactive recall, not a guarantee that every model will call the
tool. Evaluate actual tool use separately from search ranking. A deterministic background
search trigger or automatic context insertion would change the current explicit-retrieval
contract and requires a separate follow-up if agent guidance proves inadequate.

Only report “Recalled 2 relevant memories” after canonical records have reached the coding
model, with IDs/reasons available for inspection. Do not label candidate search as recall.
Keep empty automatic searches quiet, show capture/recall failures in status, and return
explicit “nothing relevant found” for an explicit user request. Historical records remain
fallible evidence subordinate to current code and current user instructions.

## Implementation sequence

Each slice should be reviewable independently. All slices are required to close Phase 8.
Slices 0–5 are implemented. Slice 6 has the authored corpus, opt-in evaluation runner and
regression coverage; its remaining real-model evaluation is recorded above.

| Slice | Deliverable and main touchpoints | Acceptance gate |
| --- | --- | --- |
| 0 — contract | This plan; link it from the documentation index and README as planned work. | Proposed behavior is visibly separate from current documentation. |
| 1 — memory runtime | Add `src/memory/` model resolution, limits and diagnostics; update `settings.ts`, `settings-io.ts`, `status.ts` and the outcome caller in `index.ts`. | A mock session uses model A for coding and model B for extraction; missing B never silently falls back. Existing defaults and project restrictions work. |
| 2 — focused extraction | Add `memory/extract.ts` and `memory/evidence.ts`; replace the settlement caller's free-form outcome path with structured extraction and compatible record rendering. | Preserve symptom, working command, failed attempt and verification; skip noise; preserve unsupported/unknown distinctions and existing signed-record bytes. |
| 3 — session remembering | Add the shared incremental service and `journal_remember`; extend session deltas and `/muninn remember`; target cue handling and replay-safe writes. | Early failure plus later fix survives chunking/compaction; explicit requests cover the current branch; repeat/resume/crash replay creates no duplicate operation records. |
| 4 — assisted recall | Add `src/recall/` and `tools/journal-memory.ts`; reuse query/read relations and add `/muninn recall`. | Retrieve the fixture's earlier solution under different wording; reject invented IDs; surface corrections and no-match/failure states within budgets. |
| 5 — proactive workflow | Register mode-aware guidance, suppress recall-only capture loops and show meaningful status. | A scripted real pi session exercises recall before retrying a known issue; manual mode and irrelevant tasks behave as specified. |
| 6 — evaluation and release | Add end-to-end fixtures, update current guides and run supported release checks. | The completion example and failure cases below pass; limitations and actual model-evaluation results are documented. |

## Verification and release criteria

Use the existing local mock-provider integration harness for deterministic tests. Extend it
to distinguish coding, extraction, expansion and selection requests, and verify request
budgets and which model receives each input. No remote provider credentials are required
for CI.

Required regression scenarios:

- Save and recall the CI fix across two actual pi sessions, with evidence returned to the
  second coding model before it chooses the next action.
- Recall from legacy unstructured outcomes as well as new issue/solution records, and retain
  scan/index agreement for lexical candidate selection.
- Preserve an early failed attempt and a later verified fix across chunking, compaction,
  resume and an explicit retrospective. Exclude sibling session branches.
- Do not write ordinary chat, a bare retrospective request, unsupported causes, fabricated
  test success, or a new outcome that merely repeats retrieved history.
- Bound malformed replies, repair attempts, timeouts, cancellation, oversized input/output,
  excessive candidate lists and no-relevant-result cases. Never expose raw rejected replies
  in diagnostics or journal content.
- Exercise a dedicated model, the default session model, model changes, missing credentials,
  smaller model windows and project attempts to widen settings.
- Inject failure before append, after append and before the state update; retry must reconcile
  the same prepared IDs. Verify project switching and concurrent store writes.
- Exercise stale/corrected solutions, unresolved conflicts, local distrust changes and
  instructions embedded in journal text. Preserve authority, signatures and provenance.
- Verify that pre-model redaction removes known fixture secrets and that automatic capture
  cannot export raw transcript payloads to journal Git or model-selection logs.

Add an authored memory-quality corpus covering at least ten issue/solution scenarios, each
with a differently worded recall task and an unrelated negative task. Include an unresolved
investigation, a misleading similar error, a version-dependent fix, an early dead end and a
later correction. Author expected facts and relevance labels before changing prompts/ranking.

Measure extraction fact retention and unsupported claims, candidate recall, selection
precision, abstention on negative tasks, correction handling and proactive tool-use rate
separately. Keep the current lexical evaluation floors (recall@10 >= 0.90, MRR@10 >= 0.80,
nDCG@10 >= 0.85). Scripted model replies prove orchestration and contracts only. Document
the selected real memory/coding models and results from an explicitly run quality evaluation;
do not claim production recall quality from scripted tests. The factual-quality and
proactive-use acceptance gate remains open pending this evaluation, but assisted mode
must stay disabled by default even after it passes. Only explicit global user opt-in
enables proactive recall; no evaluation, migration or project setting may opt the user in.

Run `npm run check`, `npm run build`, the relevant unit/integration tests, `npm run test:eval`
and the isolated package test during implementation. Finish with the existing full release
suite and separate performance checks on the supported runtime matrix. Document which checks
were actually run; do not claim unavailable platforms were tested locally.

Update the README, how-it-works, operations, technical design, testing and format documentation
as each behavior ships. Keep settings/examples marked as proposed until implementation.
Once the phase is complete, fold the lasting contract into those guides and retain this plan
in Git history, following the repository's existing documentation convention.

## Deferred work

- Embeddings/vector storage, cross-project retrieval and a separately configurable recall
  model. Start with the existing local search and the one selected memory model.
- Automatic retrospective processing of old unrelated transcripts or remote transcript
  exchange. Explicit current-branch remembering is the supported starting point.
- Global semantic deduplication, scheduled consolidation, memory deletion, automated user
  corrections and rewriting signed history.
- Automatic prompt insertion or guaranteed pre-task background retrieval. Phase 8 measures
  model-driven recall before expanding the retrieval contract.
- Images/audio as memory-model input, model-specific tuning and a standalone hosted service.
