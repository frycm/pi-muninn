# Phase 5 — retrieval quality and scale

**Status: complete.** The six slices below are implemented as separate reviewable commits.

*Outcome: a person or model can retrieve the most useful project-journal evidence from a
large history, see why each result matched, and measure changes against explicit relevance
judgments without making opaque generated knowledge another source of truth.*

Phase 4 made a distributed journal operable by a team. Phase 5 improves the read path only:
the append-only JSONL records, relation semantics, ownership rules and Git synchronization
remain unchanged. The canonical scan is still the correctness oracle; every index remains a
disposable local acceleration.

## Scope

Phase 5 includes:

- a read-only relevance-evaluation format and command for project-specific judgments;
- a checked-in, anonymized retrieval corpus covering realistic development and operations
  queries;
- filters for projected trust and lifecycle/conflict labels;
- stable, bounded explanations of lexical, relation, Git and recency score components;
- deterministic phrase, token-prefix and conservative typo-tolerant matching;
- a candidate index that remains a complete superset of canonical scan matches;
- scan/index equivalence tests for IDs, order, scores and explanations; and
- a performance budget for at least 50,000 journal records.

It deliberately excludes:

- automatic prompt injection or retrieval without a tool/user request;
- rewriting, summarizing, pruning or otherwise changing journal records;
- using lifecycle state to hide history by default;
- hidden personalization, remote ranking services or hosted indexes;
- unreviewed synonyms or a model-generated relevance oracle;
- making transcripts part of evaluation input; and
- local embeddings unless independent relevance judgments show a material lexical miss.

## Invariants

1. Current code, configuration, tests and documentation outrank all retrieved journal text.
2. The same normalized query produces the same ordered IDs, scores and explanations on every
   host, independent of wall-clock time.
3. Scan mode evaluates canonical records directly. Index mode may remove work only by
   returning a complete candidate superset; it may not define matching or ranking.
4. Filters run before relation expansion. An expanded correction/target must still satisfy
   every requested filter.
5. Trust and lifecycle/conflict labels are explicit filters. Retirement never silently
   removes records.
6. A typo match is conservative and visible in the explanation. Exact IDs, phrases and
   tokens always outrank fuzzy-only evidence.
7. Relation expansion never invents lexical evidence and is identified separately from a
   direct match.
8. Human, JSON, JSONL and model-tool reads delegate to one query service and share the same
   filter vocabulary.
9. Search, explanation and evaluation outputs remain bounded. Evaluation reads records and
   judgment files but writes neither the journal nor its index.
10. The persisted index is local, disposable, versioned and excluded from Git.

## Query contract

The existing query fields remain stable. Phase 5 adds:

```text
--trust local-user,local-agent,local-other,teammate-user,teammate-agent,teammate-other
--label correction,corrected,superseded,annotated,conflict,cycle,missing-target,
        retired-member,retired-host
--explain
```

`journal_search` accepts the equivalent `trust`, `label` and `explain` properties. Filters
are OR within one field and AND across fields, matching the existing filter contract.

With explanation enabled, every result carries a bounded structured breakdown:

- direct versus relation-expanded match;
- exact-ID and exact-phrase evidence;
- per-field exact, prefix and fuzzy token evidence;
- query-term coverage;
- Git head, branch and path proximity;
- deterministic recency; and
- relation/correction contribution.

The component sum equals the public score. Explanations contain only terms already supplied
in the query or present in the returned record; they do not expose unrelated journal text.

## Lexical matching and ranking

Normalization is locale-independent lowercase Unicode tokenization. An entire normalized
query phrase may match `cue`, `body`, `tags` or `paths`. Each distinct query token may match:

1. the same token;
2. a record token beginning with a query token of at least three characters; or
3. one conservative edit for query tokens of at least five characters.

Each query term contributes at most once per field, using its strongest match. Coverage
rewards records matching more distinct query terms so a one-word hit cannot outrank an
otherwise comparable all-terms hit. Field priority remains cue, body, tags, paths. Exact
record IDs remain an unambiguous top result. Stable score ties use newest record timestamp,
then ascending record ID.

Recency is relative to the newest canonical record, never the current clock. Git proximity
is a small tie-breaker and cannot overcome materially stronger lexical evidence. Explicit
active corrections are expanded next to a matched target; superseded/conflicting state stays
visible in labels and explanations.

## Evaluation contract

`muninn evaluate JUDGMENTS.jsonl [--json]` reads newline-delimited objects:

```json
{"id":"deploy-procedure","query":"canry rollout","relevant":["j-..."]}
```

An item may contain the same non-paging filters as search. IDs and queries are bounded,
judgment IDs are unique, and every relevant ID must exist in the selected project journal.
The command never reads transcript targets and never writes the journal or disposable index.

The stable report includes query count, invalid/missing judgments, Recall@10, MRR@10 and
nDCG@10 plus one bounded per-query result. A checked-in fixture is the regression baseline;
project teams can keep their own judgment file outside the journal or version it with code.

The checked-in eight-query development/operations corpus now measures Recall@10 `1.0`,
MRR@10 `0.9375` and nDCG@10 `0.953866` in both scan and index modes. One relevant target
appears second because its active user correction is intentionally ranked immediately before
it; all eight relevant records are retrieved in the first ten results.

An embedding experiment is justified only after at least 50 independently written real
queries show lexical Recall@10 below 0.90. It must improve Recall@10 by at least 0.05 without
regressing exact-ID/filter correctness, remain fully local and optional, disclose its model
and storage cost, and preserve scan-only operation. Until that gate is met, embeddings add
opacity without evidence of value and are not implemented. The current corpus has only eight
independently written judgments, below the 50-query gate, and lexical Recall@10 is already
`1.0`; Phase 5 therefore records a measured decision not to add embeddings.

## Performance and equivalence gates

On the CI reference environment:

- scan and index modes return identical ordered IDs, scores and explanations for every
  evaluation and adversarial query fixture;
- opening and validating a 50,000-record journal plus its index completes in under 20 s;
- fifty selective indexed searches complete in under 3 s; and
- one response remains within the existing 128 KiB default and 100-record limit.

Budgets are regression guards, not permission to skip validation. If a larger history needs
different storage later, the JSONL scan remains a supported oracle and recovery path.

## Commit sequence

### Commit 0 — contract and roadmap (implemented)

- Freeze the scope, non-goals, matching rules, evaluation gates and performance budgets.
- Link this plan from the README and prior-phase handoff.

Done when later ranking changes can be reviewed against measurable behavior rather than
subjective examples.

### Commit 1 — relevance evaluation (implemented)

- Parse bounded JSONL judgments without transcript access or writes.
- Compute Recall@10, MRR@10 and nDCG@10 from canonical query results.
- Add the CLI command, stable text/JSON reports and an anonymized realistic fixture.

Tests: malformed/duplicate judgments; missing IDs; filters; metric arithmetic; output bounds;
proof that journal and index bytes do not change.

### Commit 2 — projected filters and explanations (implemented)

- Add `trust` and `label` to the shared query parser, CLI and model tool schema.
- Add opt-in structured score explanations and human rendering.
- Make score construction component-based so totals are auditable.

Tests: OR/AND filter semantics; retired/conflicted records; component sums; output bounds;
CLI/tool parity; cursor mismatch.

### Commit 3 — deterministic typo-tolerant ranking (implemented)

- Implement phrase, term coverage, exact/prefix/fuzzy field matches and stable weights.
- Expand relation results without misreporting them as direct lexical matches.
- Upgrade index candidates to a complete superset for the new matcher.

Tests: typos; short-token refusal; phrase/coverage ordering; Unicode; correction expansion;
scan/index equality including explanations.

### Commit 4 — larger histories and index efficiency (implemented)

- Version and optimize the local candidate index for exact, prefix and fuzzy lookup.
- Preserve incremental append/rebuild behavior and read-only doctor inspection.
- Raise the synthetic performance gate to 50,000 records and fifty queries.

Tests: schema upgrade; corruption/deletion recovery; incremental append; deterministic bytes;
50,000-record budget.

### Commit 5 — release hardening (implemented)

- Run the relevance corpus through scan and index modes on supported CI runtimes.
- Audit query/evaluation bounds, hostile text and no-write guarantees.
- Update README, format and operations docs from target language to implemented language.
- Record the measured embedding decision and remove temporary compatibility paths.

Done when all local and CI suites pass, the evaluation baseline is published in the docs and
Phase 6 can consume stable journal/query APIs without knowing the index implementation.

## Roadmap impact

### Phase 6 — integrations

Remote-session and sandbox integrations use the stable query DTO, projected filters and
explanations. External importers may add provenance-rich observations through existing
writer authority, but cannot bypass explicit retrieval or introduce a second search store.

### Phase 7 — optional cryptographic governance

Cryptographic governance remains independent of retrieval. If signatures are later added,
their verified state may become another explicit filter/label; it must not silently alter
historical ranking.
