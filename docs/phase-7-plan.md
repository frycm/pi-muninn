# Phase 7 — optional cryptographic governance

**Status: implementation in progress.** The contract and five implementation slices below
are separate reviewable commits.

*Outcome: a team can authenticate new journal records and self-governance declarations with
explicitly trusted member keys, rotate or recover those keys without rewriting history, and
choose a prospective local enforcement policy. Teams that do not enable the feature keep the
plain Phase 3–6 workflow unchanged.*

Phase 7 adds cryptographic provenance, not a certificate authority or hosted identity
service. Git still transports the journal and repository ACLs still decide who can push.
Muninn verifies signed bytes and projects trust locally; it cannot prove that a complete Git
history was delivered or remove a compromised collaborator from a remote.

The implementation uses Ed25519 from Node's standard crypto API with distinct domain
separation for keys, transitions, journal records and governance events. Ed25519 is specified
by [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032), and Node has exposed Ed25519 key
generation and signing since Node 12. No native dependency, network service or reuse of an
`age` encryption key is involved.

## Threat model

Phase 7 protects against:

- undetected modification of a signed record or lifecycle event;
- a Git collaborator forging another pinned member's signature;
- silent replacement of a pinned public key;
- treating a merely self-signed key from synchronized `project.json` as trusted;
- silently trusting post-revocation or post-compromise records; and
- accidentally enforcing signatures retroactively over unsigned Phase 3–6 history.

It does not protect against:

- theft or use of an unlocked local private key before effective revocation;
- deletion, rollback, withholding or reordering of otherwise valid Git commits;
- a malicious model or process acting with the local user's filesystem authority;
- confidentiality loss (record text remains ordinary journal JSONL);
- incorrect out-of-band fingerprint verification;
- denial of service by a collaborator who can push malformed repository content; or
- remote access after retirement or key revocation. Repository ACLs must be changed
  separately.

The local OS account and mode-`0600` private-key file are the Tier 0 key boundary. Hardware
tokens, SSH agents, passphrase prompts, threshold administration and transparency logs need a
separate design and are not implied by this phase.

## Trust bootstrap and compatibility

Public key descriptors synchronize additively in `project.json`. A descriptor proves
possession of its private key by signing its canonical own bytes, but that alone is not
identity. A person establishes identity by comparing a full key fingerprint over an
independent channel and explicitly pinning `(member, key)` in the user-owned local trust file.

A rotation descriptor is signed by both the new key and the previous key. Trust therefore
follows a valid rotation chain from a local pin. If the old private key is lost or suspected
compromised, recovery creates an unchained self-signed key; every participant must explicitly
pin that recovery fingerprint. Muninn never turns a synchronized self-assertion into trust.

Compatibility is prospective:

- no key or trust file is created automatically;
- unsigned records and lifecycle events remain readable and visible;
- the default local policy is `observe`;
- `require` records an explicit `required_after` timestamp and applies only at or after it;
- canonical scan and raw Unix access never hide failed verification; and
- an older client preserves signed records as unknown additive fields and can still read the
  schema-1 journal.

## Local private identity

One member identity is stored outside all project journals:

```text
<agent-dir>/muninn/signing.json
```

It contains the member UUID, Ed25519 SPKI public key, PKCS#8 private key, creation timestamp
and fingerprint. The directory is private and the file is written atomically with mode
`0600`. The private key is never placed in argv, logs, the journal repository, pi sessions,
JSON command output or diagnostic messages.

The initial interface is headless because key and policy changes should be unambiguous shell
actions:

```text
muninn crypto init [--json]
muninn crypto public [--json]
muninn crypto status [--json]
muninn crypto trust MEMBER KEY [--json]
muninn crypto distrust KEY [--reason TEXT] [--json]
muninn crypto rotate [--json]
muninn crypto recover [--json]
muninn crypto revoke KEY [--reason TEXT] [--json]
muninn crypto compromise KEY --effective RFC3339 [--reason TEXT] [--json]
muninn crypto policy observe [--json]
muninn crypto policy require [--from now|RFC3339] [--compromised-history retain|reject] [--json]
```

`init` creates, enrolls and locally pins the first key. `rotate` enrolls a transition-signed
successor and revokes the old key from the rotation time. `recover` is accepted only when no
readable local private identity exists; its unchained replacement is pinned only on the local
machine. `trust` requires the exact key descriptor to exist in the current project manifest.

## Synchronized key and governance events

Every project key descriptor includes:

- algorithm (`ed25519`), fingerprint ID, member UUID, creation time and SPKI public key;
- a proof-of-possession signature by that key; and
- for rotation, the previous key ID and a transition signature by that key.

Descriptors are immutable and union-merged by fingerprint. A non-identical duplicate,
invalid fingerprint, invalid proof, missing predecessor, cross-member predecessor or invalid
transition makes the manifest invalid.

Revocation and compromise are additive signed governance events. An actor key may affect only
keys belonging to its own member. A compromise declaration must be signed by a different
key, normally a trusted successor or explicitly pinned recovery key. `effective_at` may
precede discovery so verification can distinguish pre-compromise from post-compromise bytes.

Removing an event is not cryptographically detectable from a single checkout; operators use
Git history and remote protections for append-only transport. Muninn's merge never chooses
between conflicting rotations or recovery assertions. It surfaces every valid branch and
leaves local trust pins explicit.

## Signed objects and canonical bytes

Journal records gain an optional signature:

```json
{"algorithm":"ed25519","key":"ed25519:...","value":"..."}
```

The signature covers a domain tag plus the existing canonical JSON serialization with the
signature field omitted. It therefore binds record ID, timestamp, project/member/host,
source authority, body, relations, session pointer, Git provenance and integration metadata.
Signing happens after deterministic fields and redaction are complete and before the one-line
size check and append.

New lifecycle declarations use the same signature shape and sign their canonical event bytes
without the signature. A signature authenticates the member key; it does not turn agent or
external text into `source: "user"`, and it does not widen any writer-authority rule.

## Verification projection

Every record receives exactly one local verification state:

- `unsigned` — no signature;
- `unknown-key` — the manifest has no matching descriptor;
- `invalid` — signature bytes do not verify or contradict the record member;
- `untrusted` — cryptographically valid but not chained to a local pin;
- `verified` — valid and chained to a local pin at the record time;
- `revoked` — written at or after a trusted effective revocation; or
- `compromised` — written at or after a trusted compromise time.

Valid records before a compromise remain `verified` when local policy says `retain`; with
`reject`, they receive `compromised` as an explicit conservative choice. The original bytes
never change in either case.

`verification` becomes a shared query filter and a field in search/read DTOs, CLI JSON and
model tools. It is metadata only: ranking does not silently reward signatures, and scan/index
equivalence remains exact.

## Local policy and sync

Per-project trust state lives outside the journal Git repository at:

```text
<agent-dir>/muninn-trust/<project-id>.json
```

It contains pins, local distrust declarations and:

```json
{"mode":"observe","required_after":null,"compromised_history":"retain"}
```

`observe` reports all states and applies every structurally valid historical lifecycle event,
matching Phase 4 behavior. `require` refuses an unsigned, invalid, unknown, untrusted, revoked
or compromised local write at or after `required_after`. During sync it stops before push if
the resulting current store violates the local prospective policy. Query results remain
visible with diagnostics; enforcement never deletes or hides evidence.

For lifecycle projection under `require`, a declaration at or after `required_after` affects
the local roster only when its signature is verified. Rejected declarations remain present
and are reported. Cryptographic retirement or key revocation still does not update a Git host,
GitHub team or repository ACL; the operations guide makes that second action explicit.

## Commit sequence

### Commit 0 — threat model and contract

- Freeze bootstrap, canonical signatures, verification states and compatibility behavior.
- Define the local trust/enforcement boundary and honest remote-ACL limitation.
- Link the plan from the roadmap before emitting new fields.

### Commit 1 — member keys and manifest registry

- Add atomic local Ed25519 identity creation and validation.
- Add self-signed public descriptors and transition verification to `project.json`.
- Preserve deterministic additive manifest merging and safe onboarding.

Tests: key-file permissions; corrupt/mismatched private material; fingerprint/proof/transition
tampering; key collisions; merge order; no automatic key creation; private-byte non-disclosure.

### Commit 2 — signed records and lifecycle declarations

- Sign canonical records after redaction and deterministic provenance.
- Sign new self-lifecycle declarations without changing source authority.
- Preserve unsigned history and exact one-line/idempotent behavior.

Tests: every signed field; post-signature tampering; secret redaction before signing; record
size; unsigned compatibility; model/integration authority; deterministic replay.

### Commit 3 — verification and explicit interfaces

- Project record/event verification from synchronized keys and local pins.
- Add the `verification` filter and stable DTO fields across scan/index, tools and CLI.
- Add status and read-only doctor diagnostics without automatic prompt injection.

Tests: all verification states; filter/interface parity; untrusted self-enrollment; rotation
chain; bounded warnings; scan/index equality; no ranking contribution.

### Commit 4 — rotation, recovery and enforcement

- Add explicit rotate, recover, revoke, compromise, trust, distrust and policy commands.
- Apply prospective write/sync gates and signed lifecycle policy.
- Surface competing key branches and compromised-history policy without rewriting history.

Tests: rotation and recovery across clones; lost/compromised key; effective time; legacy
cutoff; local-policy divergence; sync stop-before-push; remote ACL remains out of scope.

### Commit 5 — release hardening

- Exercise signed capture, tools, governance and multi-clone sync through acceptance tests.
- Document backup, recovery, fingerprint verification, ACL removal and rollback limitations.
- Verify Node/Bun and supported operating systems without optional native dependencies.

Done when the default unsigned workflow is unchanged, two clones agree after pinning and
rotation, adversarial mutation is visible, prospective required mode refuses unverified new
bytes, and no output or committed path contains private key material.

## Roadmap impact

Phase 7 closes the current roadmap. Further cryptographic work—hardware-backed keys,
threshold governance, transparency or provider-specific ACL automation—requires its own
threat model and evidence from real deployments. It must not be implied by the verification
labels introduced here.
