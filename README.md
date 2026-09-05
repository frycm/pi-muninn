# pi-muninn

**Searchable project history for [pi](https://github.com/frycm/pi).**

Muninn remembers the work behind your code: decisions, failed attempts, corrections and task outcomes. It stores that history as a local project journal that you, pi and Unix tools can search. Linked worktrees share a journal; teammates can exchange it through a separate Git repository.

Use it when a fresh session needs to answer “why did we do this?”, “what already failed?” or “which session has the details?”. Code, tests and project instructions remain authoritative. Journal entries are fallible historical evidence and are never automatically injected into the prompt.

## Install

Requirements: Git and Node.js **22.19 or newer**. This version targets the **pi fork 0.85.x**, tested against **0.85.0**. Bun 1.4.2 is also tested for extension execution. `age` and `age-keygen` are optional, needed only for encrypted transcript exchange.

From a source checkout:

```bash
git clone https://github.com/frycm/pi-muninn.git
cd pi-muninn
npm ci --ignore-scripts
npm run build
pi install .
```

Restart pi or run `/reload` to load the extension. To install the standalone `muninn` command from the same checkout:

```bash
npm pack
npm install --global ./pi-muninn-0.1.0.tgz
muninn --version
```

The tarball contains compiled JavaScript, so using the installed CLI needs no TypeScript loader. For a quick source-only extension trial, run `pi -e ./src/index.ts`. See [development and compatibility](docs/testing.md) for the runtime matrix and the pi 0.85.0 dependency workaround.

## Start using it

Open pi in a trusted project. Muninn creates a local journal when enabled and captures explicit remember/correction requests and outcomes from substantive tasks. Ordinary chat does not create task outcomes.

You can also create and use a journal directly:

```bash
cd /path/to/project
muninn project link --name my-project
muninn note "Run pnpm test --run: watch mode hangs in CI."
muninn search "watch mode"
muninn status
```

Inside pi, use the corresponding commands:

```text
/muninn
/muninn note Use the staging database for integration tests.
/muninn search staging database
/muninn show j-<full-uuid> --relations
```

Each record has a stable `j-<UUID>` ID. Replace example IDs with complete IDs returned by search. Task records include provenance such as the member, machine, branch, paths and original pi session where available.

## Find earlier work

```bash
muninn search "database migration" --explain
muninn search --type outcome --status completed --json
muninn search "deployment" --path deploy/ --since 2026-08-01 --jsonl
muninn show j-<full-uuid> --relations
muninn sessions --json
muninn tail --follow --jsonl
```

Search supports words, prefixes, limited typo tolerance and filters. `--explain` shows why a result matched. `show` reads the original record and optionally its correction neighborhood. A missing transcript does not remove the journal record; the CLI still prints it and exits with code `3`.

Pi gets four explicit tools:

| Tool | Use |
| --- | --- |
| `journal_search` | Find evidence, with filters, explanations and pagination. |
| `journal_read` | Read selected records and related evidence within a character budget. |
| `journal_context` | Load only selected IDs into bounded context. |
| `journal_note` | Append an agent note or annotation. |

Oversized records are omitted from bounded model reads with a warning and `truncated: true`; use `muninn show ID` for the complete record. Readers notice changes made by another session, including local trust changes.

## Correct a decision

History is append-only. Corrections link to the original record instead of overwriting it:

```bash
muninn correct j-<original-id> "The service now uses PostgreSQL 17."
muninn annotate j-<original-id> "The rollback procedure was tested on staging."
muninn conflicts
muninn resolve j-<conflicted-target-id> "Use the new procedure; it covers both deployment paths."
```

Only direct user actions can create user corrections or resolve conflicts. An agent note cannot impersonate a user decision. Competing corrections remain visible until a user resolves them.

## Share a project journal

Create an empty Git repository for the journal, separate from the code repository:

```bash
muninn project remote ssh://git.example/team/my-project-journal.git
muninn sync
muninn project share
```

On another machine, from the code checkout:

```bash
muninn project join ssh://git.example/team/my-project-journal.git
muninn sync
```

Joining validates the journal before linking it locally. Each member and machine owns a separate shard, and ordinary sync merges their additions. Sync commits locally, fetches, rebases and pushes without force. `muninn sync --no-push` fetches and reconciles without publishing local commits.

Remote approval is local to each journal clone. Shared metadata cannot change where your machine sends history. Existing installations must approve their intended destination once with `muninn project remote URL`; Muninn does not migrate approval from shared metadata or an ambient Git remote. To return to local-only use:

```bash
muninn project remote --remove
```

Use `muninn team list` to inspect members and machines. The [operations guide](docs/operations.md) covers team names, retirement, sharing, backups and recovery. Retirement does not change Git hosting permissions.

## Optional signing and integrations

Enable Ed25519 signing explicitly:

```bash
muninn crypto init
muninn crypto public
muninn crypto status
```

A synchronized key is not automatically trusted. Compare a teammate's full fingerprint over an independent channel, then run `muninn crypto trust MEMBER KEY`. `muninn crypto policy require --from now` requires verified new evidence from that cutoff on this machine. Older evidence stays readable. See [signing and recovery](docs/operations.md#enable-and-operate-cryptographic-governance) before rotating, revoking or recovering keys.

External tools can submit bounded JSON observations with `muninn ingest observations.jsonl --json`; `muninn integrate enclave audit.jsonl --json` imports a pi-enclave audit checkpoint. Replays are idempotent. Historical imports preserve the producer's `observed_at` separately from the local append timestamp. See [integration examples](docs/operations.md#ingest-external-observations).

Full transcripts stay on the originating machine by default. Explicit `muninn transcript export` and `import` commands exchange one selected transcript through `age` encryption. Neither encrypted bundles nor imported transcript copies enter journal Git.

## Settings and data

Muninn reads the `muninn` object in pi's settings. Defaults are:

```json
{
  "muninn": {
    "scopes": { "project": "auto" },
    "sync": { "onShutdown": true },
    "capture": { "corrections": true, "outcomes": true }
  }
}
```

Project settings can disable behavior but cannot re-enable a globally disabled capability. Set `scopes.project` to `false` to disable the project journal. Shutdown sync uses only a locally approved remote.

Data lives under pi's agent directory (overridable with `PI_CODING_AGENT_DIR`):

| Location | Contents |
| --- | --- |
| `muninn-projects/registry.json` | Local project mappings and member identity. |
| `muninn-projects/<project-id>/` | Journal Git repository and disposable search index. |
| `muninn/host.json` | Local machine identity. |
| `muninn/signing.json` | Optional private signing identity. |
| `muninn-trust/<project-id>.json` | Local trust pins and verification policy. |
| `muninn-transcripts/<project-id>/` | Explicitly imported transcript copies. |

Run `muninn path` to locate the current journal and `muninn doctor` for read-only diagnostics. Back up the journals and local registry; if signing is enabled, keep an encrypted backup of the private signing identity and trust files. Redaction reduces accidental credential capture, but inspect history before sharing it.

## Learn more

- [How it works](docs/how-it-works.md): capture, retrieval, corrections and sharing.
- [Architecture](docs/architecture.md): components and trust boundaries.
- [Technical design](docs/technical-design.md): storage, algorithms, concurrency and failure handling.
- [Operations](docs/operations.md): integrations, signing, migration and recovery.
- [Testing and development](docs/testing.md): checks, packaging, performance and retrieval evaluation.
- [Reference contracts](docs/README.md): record format, registry and legacy migration input.
