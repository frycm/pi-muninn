# Technical design

The [format contract](project-journal-format.md) defines serialized bytes. This document explains the runtime decisions that preserve them.

## Project resolution and writes

The user-owned registry maps canonical roots and Git common directories to project UUIDs. The extension checks pi's project trust before opening or creating mappings. Paths are provenance and aliases, not durable identity. Registry edits use a shared lock, an owner-only temporary file, fsync and atomic rename.

Each record belongs to `journal/<member>/<host>/<UTC-month>.jsonl`. Authorized writes check source/type/relation permissions, reject self-relations and duplicate relations, construct deterministic fields, redact sensitive text, optionally sign, validate local policy and enforce the 64 KiB serialized limit. A store lock protects the final read/decide/append transaction. The writer appends a newline-terminated buffer and fsyncs it; readers ignore incomplete tails and report malformed, oversized, colliding or incorrectly owned records.

Initialization and append check each journal/member/host directory before creating descendants. Scans reject symbolic links and non-regular shards; file opens use `O_NOFOLLOW` and verify the opened descriptor is a regular file. A local alias to the store root remains supported. These guards and the store lock contain synchronized Git content; they do not provide atomic ancestor protection against an unrelated local process renaming directories during an operation.

Integration idempotency is keyed by `(provider, external_id)` under the same lock. Replays compare canonical producer content using the first import's local provenance and timestamp. Changed content under the same delivery key is rejected. `at` records local ingestion/signing time; `integration.observed_at` retains the producer's historical timestamp. This permits signed backfills after key initialization or rotation.

## Query snapshots and index

`JournalQueryService` owns parsed records, relation and lifecycle projections, verification state and an optional candidate index. Before retrieval it fingerprints the manifest, eligible shards and local trust file using path, device, inode, size, nanosecond modification time and change time. New or removed shard paths also change the fingerprint. A mismatch rescans canonical data and rebuilds projections. The fingerprint is captured before the scan so a concurrent change during loading triggers another refresh on the next call. The service publishes that fingerprint only after every projection loads successfully; invalid trust data keeps every read failing until repaired, without reusing stale verification.

This is a local-filesystem freshness mechanism, not a distributed transaction or an adversarial filesystem integrity guarantee. A read sees a scanned snapshot; a writer arriving during that scan may be visible on the next read. Full rescans remain proportional to history size. Local appends update the service after reconciling external changes.

Cryptographic verification is memoized by record ID only within a private snapshot. Inputs added to that snapshot are cloned, and returned nested DTOs are cloned, so callers cannot mutate verified evidence behind the cache. Refresh invalidates verification and warning caches together with trust and manifest projections. No trust result is persisted into the lexical index.

The index stores canonical record hashes and normalized terms. N-grams narrow the vocabulary; matching terms then select record postings, so common fragments do not send unrelated records to the scorer. Infix candidates remain eligible for phrase matching. Canonical filters and ranking still decide results. Unicode normalization, exact matches, prefixes and bounded one-edit matches share the same analyzer. Relation expansion, correction precedence, Git provenance and recency contribute to ranking. Ranking computes the history's newest timestamp once per query, avoiding repeated history scans for every result. Optional explanations expose those contributions. The canonical scan and index must remain equivalent.

Query pages have bounded record counts and character budgets with pagination. Reads additionally bound full records, transcript metadata and warnings, accounting for their JSON envelope. Oversized records are omitted with a warning and `truncated: true`; their signed contents are never shortened. The CLI's default 128 KiB budget fits a single legal journal record. Model read/search services use a 16,000-character budget, and `journal_context` applies its own selected-record budget.

## Transport authority and sync

`muninn.remote` in the journal repository's **local** Git configuration is transport approval. Reads disable config includes. Only an explicit `project remote` or `project join` action creates or changes it. A blank or absent value means local-only; neither `project.json.remote` nor an ambient `origin` bootstraps approval. Existing installations must explicitly approve their destination after upgrading.

While holding the store lock, sync commits canonical local files, reads local approval, configures the fetch origin, fetches, checks project identity and writer ownership, rebases, checks local prospective signature policy and pushes without force. Push addresses the approved URL directly, so a distinct `origin.pushurl` cannot override it. Shared manifest URLs remain descriptive metadata. Compatible manifest additions union-merge; unsupported conflicts abort the rebase. A transient network error leaves the local commit intact.

Join and sync share the same tracked-file policy: only canonical data paths with Git mode `100644` are accepted. Sync checks its local index, the fetched tree before checkout, and the resulting index after rebase, including fetch-only runs. A rejected remote tree leaves the local checkout intact. Checking Git modes also rejects links on filesystems where Git materializes symlinks as ordinary files. Both the CLI and `/muninn` status display the locally approved destination.

## Verification and temporal authority

Public descriptors bind an Ed25519 fingerprint, member, creation time, public key and self-proof. Rotations also carry a predecessor signature. Parsing validates proofs, predecessor ownership, creation order, signatures and acyclic chains before projection.

The projection starts from explicit local pins, excludes local distrust and processes signed governance events in deterministic timestamp/ID order. Inherited trust requires an authorized predecessor at the successor's declared creation time. Revocation or compromise effective at or before that time blocks the transition. The narrow handover exception permits the new key's own predecessor revocation at exactly its creation time; it does not authorize sibling successors.

Later retrospective declarations can invalidate earlier transitions. Governance from the invalidated successor then loses authority over unrelated keys. The projection reevaluates accepted events without each event itself to preserve self-revocation and a declaration that invalidates its own ancestry without letting that declaration erase itself and resurrect the chain. Raw declarations remain in the manifest regardless of whether they are effective locally.

`compromised_history` controls the verification of historical objects. Transition authority follows the effective compromise time; rejecting all historical records does not by itself invalidate a legitimate transition made before compromise. An explicitly compared and pinned successor can establish an independent anchor. Signer-controlled timestamps are not a trusted publication clock; see [security limits](security.md).

## Private identity transactions

The signing identity is shared across a local member's projects. Initialization, rotation and recovery acquire a common identity lock before any project store lock, preventing concurrent cross-project replacement. Private material is never stored in journal Git.

Rotation prepares `muninn/signing-pending.json` before publishing the successor or revoking its predecessor. This owner-only, fsynced and atomically installed transaction retains the project/store scope, predecessor and successor material, fixed timestamp and event ID. It then publishes and commits the public transition, atomically installs and rereads the successor, and removes the pending file. Recovery uses the same ordering with an unchained key and local pin.

A retry resumes the same transaction after a failed hook, commit or process interruption, including interruption after private installation but before cleanup. An unfinished transaction prevents initializing or rotating in another project. A malformed or mismatched transaction fails closed and preserves its bytes. If subsequent governance invalidates a pending transition, automatic resumption stops; the [operations guide](operations.md#rotate-revoke-or-recover-a-key) explains manual recovery without losing that material.

## Capture and external evidence

The pi extension persists task state in custom session entries, gathers substantive tool activity and captures outcomes at settlement and before compaction. Resume and fork state retain task continuity and deduplicate already written records. Model-generated outcome text is validated; an unusable response is retried once and then discarded with diagnostics.

Memory extraction now uses `src/memory/` and pi's authenticated model registry. The default
is the active session model; a global `{ provider, id }` selection leaves that coding model
unchanged. `MemoryOperation` bounds each input/output, shares a deadline across calls, allows
one format repair and caps an operation at eight calls. Provider failures never trigger a
silent provider fallback. Numeric project settings can only lower the global limits.

Visible messages on the selected session branch become redacted evidence with source IDs.
Chronological chunks retain error lines and both ends of oversized outputs; omissions are
explicit. Earlier same-task prepared memories provide bounded context to later extraction.
The internal JSON contract supports issue/solution and general-outcome variants; code renders
them into schema-1 bodies with versioned tags. No model-supplied identity or semantic
correction relations are accepted. Validation establishes shape and valid references, not
the truth of a causal claim.

`muninn-memory-v1` custom entries contain prepared canonical records and operation state.
Timestamps, IDs, redaction and optional signatures are frozen before append. A replay checks
authority, identity, enrolled signing keys and local write policy, then reconciles identical
bytes under the normal store lock. Prepared records contain no signing secrets. A failure
after append but before marking completion reuses the same record. Only completed or valid
empty chunks advance processed evidence; failed work remains retryable. These custom entries
are local session bookkeeping and do not enter model context or journal Git.

Recall builds bounded lexical candidates, optionally asks for up to three alternative queries,
and validates the memory model's selection against candidate IDs. It loads correction
neighborhoods before selection and compares fresh records and labels afterward. Changed,
incomplete or disallowed evidence is omitted with diagnostics. Canonical records remain
separate from model-authored applicability reasons. `before_agent_start` adds only static
procedural guidance when assisted mode is enabled; no journal bytes enter that hook.

External observations enter the same governed writer, never the user-correction path. Transcript export validates a selected local pointer and encrypts a bounded bundle with `age`; import checks metadata and installs an owner-only local copy. Neither bundle nor decrypted copy becomes a canonical journal record or automatic prompt context.

## Verification strategy

Correctness is tested at shared services and through real Git repositories and real pi processes using a scripted local provider. Fault cases include remote redirection, successor authority, failed signing publication, concurrent readers and historical imports. Retrieval equivalence, authored relevance judgments, signed/unsigned scale budgets and isolated npm-package installation cover the release behavior. Exact commands and measured limits are in [testing](testing.md).
