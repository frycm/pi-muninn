# Phase 6 — optional integrations

**Status: implemented.** The contract and five implementation slices below are separate
reviewable commits.

*Outcome: remote session hosts, sandbox extensions and other local tools can contribute
bounded, attributable evidence to the same project journal, while a person can exchange a
specific transcript securely when the journal pointer alone is insufficient. None of these
features is required for the plain-file workflow.*

Phase 5 stabilized the journal/query API. Phase 6 adds adapters at its edges; it does not add
a service, a second database or ambient model context. In particular, running Muninn inside
an RPC-hosted pi session already captures that session with `channel: "rpc"`. A remote host
needs an adapter only when it has additional provenance, such as a client or daemon event,
that the ordinary pi lifecycle does not expose.

The sibling projects currently have different maturity. `pi-enclave` has an implemented,
hash-chained local audit log, so Phase 6 can provide a concrete importer for it. `pi-huginn`
is still a design-only remote-session project, so Muninn freezes a small producer contract
for it without depending on an interface that does not exist yet.

## Scope

Phase 6 includes:

- structured integration provenance on ordinary journal records;
- an idempotent writer path for external observations that cannot claim user authority;
- an explicit `integration` query filter shared by CLI, attended commands and model tools;
- a bounded custom-session-entry contract that another pi extension can emit without a
  runtime dependency on Muninn;
- a headless JSON/JSONL ingest command for process integrations;
- an explicit importer that verifies and summarizes a `pi-enclave` audit chain;
- opt-in transcript export/import encrypted by the standard `age` CLI; and
- local resolution of an imported transcript without changing the synchronized record.

It deliberately excludes:

- importing full remote transcripts into the journal;
- automatically reading another extension's private state;
- copying individual sandbox decisions or command arguments into journal text;
- automatically injecting integration evidence into a model prompt;
- a daemon, webhook listener, plugin discovery system or hosted integration service;
- storing plaintext or encrypted transcript bundles in the journal Git repository;
- implementing encryption, recipient-key management or team identity in Muninn; and
- claiming that external evidence is authenticated or authoritative.

## Invariants

1. Integrations append through the existing project resolver, store lock, redaction and Git
   commit path. They cannot choose a store from project-controlled input.
2. An integration record always has `source: "external"`; no producer can mint user
   corrections, supersessions or user authority.
3. `(provider, external_id)` is an idempotency key. Replaying identical input returns the
   existing record; reusing the key for different input is refused under the append lock.
4. Provider, kind, event, IDs, timestamps, metadata, batches and rendered output are bounded.
5. Integration provenance is visible in raw JSONL and through an explicit query filter. It
   never silently changes ranking, trust or lifecycle projection.
6. A pi custom entry is only an untrusted contribution request. Muninn validates it again at
   the authority boundary before writing canonical JSONL.
7. RPC sessions need no special storage path: when Muninn is loaded by the session host,
   normal capture records `channel: "rpc"` and uses the same logical project journal.
8. A sandbox audit import verifies the complete hash chain and emits only aggregate counts;
   it never copies actions, paths, prompts, rules or secrets into the journal.
9. Transcript exchange is an explicit user command for one selected journal record. Plaintext
   exists only in the original session store, a mode-`0600` temporary file during encryption,
   or the recipient's local exchange cache.
10. Muninn delegates encryption and identity handling to `age`. It never accepts passphrases,
    private keys or plaintext transcripts on command lines and never stages exchange files.
11. Import verifies the encrypted envelope's project, journal-record ID, length and SHA-256
    before an atomic local install. Existing different bytes are never overwritten.
12. The journal remains fully useful when no producer, `pi-enclave`, `pi-huginn` or `age`
    executable is installed.

## Integration record contract

An externally contributed record carries the ordinary record fields plus:

```json
{
  "integration": {
    "provider": "pi-enclave",
    "kind": "sandbox-audit",
    "event": "audit-checkpoint",
    "external_id": "session-id:42:sha256:...",
    "observed_at": "2026-09-04T12:00:00.000Z",
    "metadata": { "records": 42, "violations": 0, "chain": "verified" }
  }
}
```

The provider is an ecosystem identifier, not a trust root. Metadata is a small, flat map of
JSON scalars intended for audit correlation; it is returned by `show`, but search summaries
expose only provider/kind/event. Free-form searchable meaning belongs in the redacted body,
cue and tags like every other journal record.

The CLI and model query DTO add `integration`, with OR semantics within the field and AND
semantics across other filters:

```text
muninn search "denied deployment" --integration pi-enclave --json
journal_search({ query: "remote rollout", integration: ["pi-huginn"] })
```

## Producer paths

### Headless process input

`muninn ingest FILE|- [--json]` accepts one JSON object, a JSON array or JSONL. A batch is
validated completely before its first append and is capped in both bytes and observation
count. `-` reads stdin, which keeps shell integrations composable without putting observation
text in argv.

The ingest envelope supplies the integration block and the permitted journal payload:
`type` (`note`, `checkpoint` or `outcome`), `body`, optional cue/status/tags/paths and channel.
Identity, source, record ID, timestamp, Git provenance and store location are assigned by
Muninn. A producer can use the same envelope through the exported TypeScript helper.

### Pi custom entries

An extension running in the same pi session can append the exact ingest envelope under the
custom type `muninn-integration-v1`. At settle, compaction and shutdown, Muninn folds those
entries from the authoritative session branch and idempotently appends any it has not seen.
This uses pi's durable extension mechanism and survives extension load order, resume and fork.

`pi-huginn` can eventually add remote client/daemon provenance this way. Until it implements
a runtime, Phase 6 tests the producer contract with a fixture instead of guessing its future
protocol. Ordinary remote runs are already covered by the `rpc` channel.

## Sandbox audit adapter

`muninn integrate enclave AUDIT.jsonl [--json]` is an explicit, read-only import. It checks:

- a regular, non-symbolic-link input within the configured byte limit;
- one bounded JSON object per terminated line;
- one session ID, strictly increasing sequence numbers and RFC 3339 timestamps; and
- `prevHash` against SHA-256 of the exact preceding line, starting at the documented genesis.

One checkpoint is appended for the verified tail. Its text and metadata contain only counts
by audit kind/outcome plus whether the breaker opened. Re-importing the same tail is a no-op;
a later tail creates a new checkpoint. The original enclave log remains the detailed evidence
and retains its own policy and retention.

## Encrypted transcript exchange

Transcript pointers remain local by default. When a teammate needs the detailed evidence:

```text
muninn transcript export RECORD-ID BUNDLE.age --recipient age1... [--recipient age1...] [--json]
muninn transcript import BUNDLE.age --identity KEY.txt [--json]
```

Export accepts only an existing local transcript reached through the selected record and the
configured pi session root. It creates a versioned envelope containing the project ID, record
ID, byte length, SHA-256 and transcript bytes, then invokes `age` with an argv array. Import
decrypts to a private temporary directory, validates the whole envelope against the current
project journal and atomically installs it at:

```text
<agent-dir>/muninn-transcripts/<project-id>/<record-id>.jsonl
```

`journal_read` and `muninn show` then report the local exchange copy as available while
preserving the sender's original session pointer. Exchange files are user-local evidence:
they are never indexed, committed or synchronized by Muninn. Teams distribute the encrypted
bundle and recipient public keys through channels appropriate to their own threat model.

## Commit sequence

### Commit 0 — contract and roadmap (implemented)

- Freeze the external-observation, custom-entry, sandbox-summary and transcript-exchange
  boundaries.
- Record why normal RPC capture needs no remote-specific storage adapter.
- Link this plan from the README and Phase 5 handoff.

### Commit 1 — external observation records (implemented)

- Add bounded integration provenance to schema-1 records.
- Add the idempotent external writer authority and shared `integration` filter.
- Preserve scan/index equality and deterministic canonical bytes.

Tests: malformed provenance; bounds; authority refusal; identical replay; conflicting replay;
filter/query/tool/CLI parity; older records without integration metadata.

### Commit 2 — producer interfaces (implemented)

- Add JSON/JSONL file/stdin ingest and stable result DTOs.
- Export the envelope parser and pi custom-entry helper.
- Fold custom entries at safe lifecycle boundaries and prove RPC capture remains ordinary
  journal capture.

Tests: atomic prevalidation; input and batch bounds; resume/fork replay; load-order independence;
redaction; no implicit retrieval.

### Commit 3 — pi-enclave audit adapter (implemented)

- Verify the complete hash chain and strict audit structure.
- Append one aggregate, idempotent checkpoint for the verified tail.
- Refuse torn, oversized, mixed-session or tampered logs without writing.

Tests: valid chain; tamper/delete/reorder; torn tail; bounded aggregation; secret/action fields
absent from journal output.

### Commit 4 — encrypted transcript exchange (implemented)

- Package and encrypt one locally available transcript for one or more `age` recipients.
- Decrypt, validate and atomically install a recipient-local copy.
- Resolve original versus exchanged availability in the shared read DTO.

Tests: source containment; project/record/hash/length mismatch; wrong identity; no overwrite;
idempotent import; paths with spaces; no exchange path in Git allowlists.

### Commit 5 — release hardening (implemented)

- Exercise ingest, sandbox import and transcript exchange through CLI and acceptance tests.
- Add integration and exchange checks to diagnostics where useful.
- Update README, journal format and operations documentation to implemented language.
- Verify Node/Bun and supported operating systems in CI.

The full suite remains runnable with no integration peer or `age` executable installed. A
transport-independent fixture exercises all envelope failures, while Linux CI installs real
`age` and `age-keygen` for a command-compatible encrypted round trip. The plain journal
workflow remains unchanged.

## Roadmap impact

### Phase 7 — optional cryptographic governance

Transcript encryption does not authenticate journal authors and does not make advisory team
lifecycle declarations enforceable. Phase 7 still requires evidence from real distributed use,
a threat model and a separate design for member signing keys, rotation, recovery, revocation
and compromised history. An `age` recipient key must not be silently reused as a signing key.
