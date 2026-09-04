# Logical project registry

Muninn keeps logical project identity in a user-owned registry, outside every project
checkout:

```text
<agent-dir>/muninn-projects/
├── registry.json
└── <project-id>/
```

`<agent-dir>` is pi's agent directory, including `PI_CODING_AGENT_DIR` overrides. Repository
content cannot choose the registry, a store path or a sync remote.

## Schema

The current registry schema is:

```json
{
  "schema": 1,
  "member": {
    "id": "019c1000-1111-7000-8000-000000000001",
    "name": "martin",
    "createdAt": "2026-09-01T12:00:00.000Z"
  },
  "projects": [
    {
      "id": "019c1000-2222-7000-8000-000000000002",
      "name": "pi-muninn",
      "createdAt": "2026-09-01T12:01:00.000Z",
      "locations": [
        {
          "root": "/src/pi-muninn",
          "gitCommonDir": "/src/pi-muninn/.git",
          "linkedAt": "2026-09-01T12:01:00.000Z"
        },
        {
          "root": "/src/pi-muninn-phase-3",
          "gitCommonDir": "/src/pi-muninn/.git",
          "linkedAt": "2026-09-01T12:05:00.000Z"
        }
      ]
    }
  ]
}
```

Member and project IDs are full UUIDv7 values. Locations are canonical absolute paths. A
location may become stale after a rename; paths are aliases and never replace the project
UUID as identity. Display names are bounded and reject credential-shaped text, terminal
controls and direction-changing characters before registry bytes are written.

Registry read-modify-write operations use one cross-process lock. A changed file is written
with owner-only permissions to a new file, flushed, atomically renamed and followed by a
best-effort directory flush. Invalid JSON, invalid IDs, relative paths, duplicate roots and
cross-project Git-common-directory collisions fail loudly. Muninn never repairs corruption
by overwriting the file.

## Resolution

For a trusted session, Muninn canonicalizes the working directory and asks Git for both its
worktree root and `git rev-parse --git-common-dir`. It then uses:

1. the most specific registered root containing the working directory;
2. a registered canonical Git common directory;
3. a new project UUID for an unregistered Git common directory, bare repository or non-Git
   root.

When a second linked worktree matches step 2, its root is added as another alias on the same
project. Branch, detached-HEAD state and code-remote URLs do not affect identity. Independent
repositories with the same remote remain independent until a user explicitly links them.

A team may commit this narrow hint at `.pi/muninn-project.json`:

```json
{"schema":1,"project":"019c1000-2222-7000-8000-000000000002","name":"pi-muninn"}
```

Automatic session resolution never reads the hint. `muninn project link` may accept it
because that command is a direct user action; an explicit `--id` takes precedence. The hint
cannot name a store path or remote.

Pi's project trust gate is applied before registry access. An untrusted checkout cannot make
Muninn read, create or change a mapping. The standalone `muninn project` command is a direct
user action and does not derive authority from repository content.

## Commands

```text
muninn project show [PATH]
muninn project link [PATH] [--id UUID] [--name NAME] [--force]
muninn project unlink [PATH]
muninn project remote [URL|--remove]
muninn project share [PATH] [--json]
muninn project join JOURNAL-URL [PATH] [--force] [--json]
```

- `show` is read-only and reports the project and member IDs, UUID store, current root,
  aliases and the rule that selected the mapping.
- `link` reuses the selected project by default. `--id` reconnects a renamed location or
  explicitly groups another clone with an existing project. `--force` is required to move a
  location already owned by another project.
- `unlink` removes the current Git-common-directory group, or the selected non-Git root. It
  leaves the project record and store untouched. With `scopes.project: "auto"`, a later pi
  session will mint a new project if the path was not relinked first.
- `/muninn project` shows the active session mapping. Registry changes remain explicit shell
  commands so an attended session cannot silently switch stores beneath pending writes.
- `remote` reads or changes the explicit remote in the journal's `project.json`. The value is
  user-owned metadata and is never inferred from the code repository's remotes.
- `share` prints the project UUID, name and explicit journal remote without exposing a store
  path as team identity.
- `join` validates an untrusted temporary clone before installing the UUID store and mapping
  the selected code checkout. `--force` may replace an existing checkout mapping but never
  an existing store directory. Cancellation and validation failures publish neither a
  registry mapping nor a destination store; a later join cleans abandoned private staging
  clones. If the process stops after the validated store rename but before registry
  publication, an agent-local recovery marker lets a later join revalidate and finish only
  that same project/remote/member transaction.

To reconnect a renamed repository, retain the UUID printed by `unlink` or obtain it with
`show`, then run:

```bash
muninn project link --id <project-id>
```

No command deletes a store. Recovery from a mistaken mapping is therefore an unlink/relink,
not data restoration.

Joining normally requires only the explicit journal URL; the manifest supplies the project
UUID. The automated and manual recovery sequences are documented in
[operations.md](operations.md).
