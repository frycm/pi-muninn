# Development, testing and compatibility

## Develop from a checkout

```bash
npm ci --ignore-scripts
npm run check
npm run build
npm test
npm run test:package
npm run test:eval
```

`check` runs strict TypeScript and Biome. Compilation uses `NodeNext` module resolution and explicit type imports, following [TypeScript's guidance for Node output](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html#im-compiling-and-running-the-outputs-in-nodejs). `build` emits JavaScript and declarations into ignored `dist/`. Relative TypeScript import suffixes are rewritten for Node. The `prepare` hook builds Git installs and npm tarballs; consumers receive compiled files and do not need a TypeScript loader.

`test:package` packs the repository, installs the tarball into an isolated temporary consumer with lifecycle scripts disabled, verifies CLI writes/searches and both package exports at runtime and through a strict TypeScript consumer, and drives a real installed pi task against a scripted local provider. It catches missing runtime dependencies, missing compiled files and package entry points that only work in the source tree.

Integration tests use temporary agent directories, local mock HTTP providers and temporary Git repositories. They need process creation and loopback networking, but no model credentials or remote journal access. Install `age` and `age-keygen` to include the real encryption round-trip and wrong-recipient tests; without them that test is skipped locally. CI installs and checks both executables explicitly.

## Runtime matrix

| Component | Release target |
| --- | --- |
| pi fork | `@earendil-works/pi-coding-agent` 0.85.0; peer range `>=0.85.0 <0.86.0` |
| Node | Minimum 22.19.0; CI tests 22.19.0 and 24 on Linux and macOS |
| Bun | 1.4.2; CI runs `bun --bun run vitest --run` on Linux |
| age | Real CLI round-trip on CI; locally validated with 1.2.1 |

The sibling pi checkout used for compatibility review is tag `v0.85.0`, commit `107d79f11072bbc8a3a757ed7fd69596bee7d68c` in `frycm/pi`. No changes to that checkout are required.

Pi 0.85.0's main package export imports `@earendil-works/pi-server` but omits it from its published runtime dependency list. Muninn explicitly supplies version 0.85.0 as a runtime dependency so package exports and tools load from a clean install. Remove that workaround only after a newer pi package includes the dependency and the isolated package test passes. `typebox` is also a direct runtime dependency because tool schemas import it at runtime.

The compaction fixture answers pi's summary request with text, as required by the current provider path; it still asserts that a compaction entry actually exists and that the task is journaled once. A passing test that never compacted would not establish this behavior.

## Retrieval evaluation

The checked-in fixture has **60 authored queries over 34 records**. It retains eight application scenarios and adds 26 Muninn scenarios, each with a natural-language question and a shorter lexical query. Some queries constrain paths or branches. It includes overlapping terminology, typos and a correction relation. These are crafted test cases, not captured production queries.

Run `npm run test:eval` to print all rankings and metrics. On the reviewed implementation, scan and index agree exactly:

| Metric | Value |
| --- | ---: |
| Recall@10 | 1.000000 |
| MRR@10 | 0.955556 |
| nDCG@10 | 0.967062 |

Regression tests require recall at least 0.90, MRR at least 0.80 and nDCG at least 0.85, plus identical rankings/explanations in scan and index modes. Relevance labels were authored with the scenarios before measurement. Keep them tied to the question when changing ranking. The fixture README documents provenance.

For evaluation on a real project, create a JSONL file of judgments using stable record IDs and run `muninn eval judgments.jsonl --json`. Such field data would be needed before claiming production retrieval quality or deciding whether semantic search is justified. The current release uses no embedding service or vector database.

## Performance and output budgets

`test/unit/query-perf.test.ts` enforces:

| Workload | Budget |
| --- | ---: |
| Open/index 50,000 unsigned records | <20 s |
| 50 selective queries over those records | <3 s |
| Unfiltered browsing over those records | <3 s |
| Cold open and first verified query over 10,000 signed records with annotations | <15 s |
| 50 warm verified queries over signed records | <3 s |
| Append, refresh and verified retrieval over signed history | <15 s |

Run `npm run test:perf` to measure these budgets separately. CI runs this file after the other tests, so concurrent Git repositories and pi processes do not compete with timed queries. The same limits apply on Linux and macOS.

A Linux Node 24 run measured approximately 1.42 s cold, 0.13 s for 50 warm queries and 1.44 s for append/refresh on the signed fixture. These are representative measurements from the test environment, not user latency guarantees. Tests run with generous cold-operation limits; full scans remain proportional to history size.

Records are limited to 64 KiB after serialization. Query/read responses honor a character budget, including relations, warnings and transcript metadata. The default CLI/service budget is 128 KiB; extension search/read uses 16,000 characters. `journal_context` defaults to 12,000 characters and accepts an explicit bounded limit.

## Regression coverage

The suite exercises local-only and approved sync, clean and diverged shared metadata changes, a separate Git push URL, revoked/compromised successor chains, later invalidation of descendant governance, and historical signed imports. Live readers are checked after append/replacement/deletion/trust changes, repeated invalid trust reads, and index corruption/repair. Full-record and model-context tests distinguish oversized existing records from missing IDs.

Signing fault tests cover failed commits, private installation, recovery trust pinning and final cleanup. Pending-state tests reject corrupt key material, missing or unsupported fields, wrong operation/project/store/member scopes, unsafe permissions and symlinks while preserving recovery bytes.

The independent security review is followed by focused reproductions and the full suite. All 461 tests pass on the reviewed Linux runtime matrix, including the real age test. Linux runtime results are validated locally; the macOS jobs run in CI and are not claimed as local executions.

## Validated security repairs

The reviewed security findings are fixed in the shared service boundaries. The independent candidate review also exercised separate Git push URLs and governance retained after retrospective compromise; both cases have executable regressions.

| Previously vulnerable path | Enforced invariant and implementation | Regression evidence and legitimate control |
| --- | --- | --- |
| Shared manifest URL → subsequent sync → changed destination | `src/sync/remote.ts` owns explicit local approval; `src/sync/sync.ts` reads it and pushes to the approved URL directly. | `test/unit/sync.test.ts` proves that clean and diverged metadata updates cannot redirect later private history, and a separate push URL receives nothing. First push, ordinary two-clone exchange, local-only mode and no-push still pass. |
| Revoked/compromised predecessor → trusted successor → records/governance | `src/governance/verification.ts` checks transition-time authority and withdraws unrelated governance after later invalidation. | `test/unit/governance-verification.test.ts` rejects successors, descendants and their events while preserving explicit pins and pre-compromise rotations. `governance-operations.test.ts` verifies ordinary atomic handover. |
| Public successor/revocation → failed commit → lost private key | `src/governance/transaction.ts` durably prepares scoped private material; `operations.ts` resumes publication and installation under a shared identity lock. | `test/unit/governance-operations.test.ts` injects commit, private installation, trust pinning and cleanup failures, verifies the same key/event is resumed, and races rotations across two projects. `governance-transaction.test.ts` verifies private state validation and preservation. Recovery and ordinary rotation still pass. |
| Failed trust refresh → subsequent read → stale verified evidence | `src/journal/query.ts` publishes the new snapshot and fingerprint only after complete validation. | `test/unit/governance-verification.test.ts` checks repeated search/read/lookup/conflict calls against invalid trust state in both scan and index modes, then verifies recovery after repair and distrust. |

Verification gates: strict typecheck/lint and build passed; focused malicious and legitimate controls passed; the complete 46-suite/461-test matrix passed on Linux with Node 22.19.0, Node 24.18.0 and Bun 1.4.2. `npm run test:package` passed on both Node versions. `npm audit --omit=dev` reported no production dependency advisories. macOS execution is configured in CI but was not available for local execution. Timestamp backdating and complete-history detection retain the limits documented in [security](security.md).
