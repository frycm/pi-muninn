# Security model

Muninn separates historical evidence, local authority and transport. Its boundaries assume the local OS account and its agent directory are trusted. A program with the user's unrestricted filesystem access can read private keys or change local configuration; signatures and settings do not sandbox that program.

## Properties

- A code checkout cannot automatically select an arbitrary journal path or another project's identity. Registry mappings are user-owned, and the extension applies pi's project trust gate.
- Shared manifest metadata cannot grant network permission or redirect later syncs. Local Git configuration holds explicit transport approval, and pushes use that approved URL directly.
- Model, automatic, integration and direct-user writes have different permitted source/type/relation combinations. Signing does not widen these permissions.
- A synchronized self-proof proves possession of a key, not a person's identity. Full fingerprints must be compared independently and pinned locally.
- Ed25519 signatures detect modification of present signed bytes and prevent a collaborator without the key from forging a pinned member's signature. Distinct signing domains separate descriptors, transitions, records and governance events.
- Inherited trust does not pass through a predecessor revoked or compromised at transition time. Later retrospective declarations can invalidate existing descendants and their unrelated governance. Local distrust also cuts inherited chains.
- Pending private identity transactions retain the material needed to resume interrupted rotation or recovery. Sensitive files are private, and public output excludes private material.

## Limits

Journal text is plaintext. A signature does not make its assertion correct, classify agent text as user intent, or make old instructions current. Redaction reduces accidental credential capture but is not a guarantee that every secret will be recognized. Inspect evidence before sharing it.

Signatures authenticate objects that are present. They do not prove completeness or detect every deletion, rollback, withholding or reordering of Git history from one checkout. Use repository protections and independent backups when those properties matter. A collaborator who can push malformed data can also cause denial of service.

Creation and effective timestamps are signed assertions, not trusted publication times. An attacker holding a compromised private key may backdate a new record or transition; there is no transparency log or external timestamp authority to disprove that from the object alone. Conservative history rejection and explicit distrust provide local controls, with the tradeoff of rejecting legitimate older evidence.

Key revocation, member retirement and local distrust do not remove Git hosting access. Remove repository credentials and roles separately. Local Git transport configuration, including deliberate URL rewriting and SSH configuration, remains part of the trusted user environment.

The private Ed25519 identity is a mode-`0600` file protected by the OS account. Hardware key storage, passphrase management and threshold administration are not provided. The optional `age` identity used for transcript exchange is a different key and must not be substituted for the signing identity.

## Recovery and policy

`observe` labels evidence without requiring signatures. `require` applies locally from an explicit cutoff and can refuse new writes or stop a synchronized violation before push. Both retain evidence for inspection. A separately verified and pinned recovery key breaks the old chain of trust; every participating machine must establish its own pin.

See [operations](operations.md) for fingerprint verification, private backups, interrupted rotation, compromise handling and repository access removal. The [technical design](technical-design.md) describes temporal governance semantics and the serialized [format](project-journal-format.md) defines signed objects.
