# Phase 1 — retained foundation

> **Status: implemented.** This is a concise record of the foundation retained for the
> logical-project journal work. Git history contains the original implementation detail.

Phase 1 established the safety and integration primitives that Phase 3 reuses. Its Markdown
storage layout is temporary migration input; its append, provenance, query and synchronization
properties remain requirements.

## Retained behavior

### Capture and provenance

- Explicit user notes and corrections retain `source: user`.
- Agent-authored outcomes and notes retain `source: agent`.
- Entries may point to the local pi session file and leaf entry that support them.
- Task and continuation IDs group resumed work without copying the full transcript.
- Secret detection runs before append and marks records whose content was redacted.

### Append safety

- Journal entries are immutable after append.
- A store lock serializes local writers.
- One complete entry is written and flushed as one append operation.
- A final incomplete entry is reported and ignored; earlier complete entries remain readable.
- UUIDv7-based IDs require no central allocator and remain stable through migration.

### Search and read

- The canonical index is rebuildable from journal files.
- Lexical search returns stable entry or claim IDs and provenance.
- Reading a claim includes the entry context around it.
- A session pointer can be followed only when a journal record already references that local
  transcript.
- Search results are bounded before being returned to a model.

### Scope and synchronization

- Global and project scopes are separate.
- Project settings may tighten user settings but cannot widen them or select a sync remote.
- Each host writes its own journal path, reducing ordinary Git conflicts.
- Sync commits only allowlisted store files, fetches, rebases and pushes.
- Store metadata merges host registrations deterministically.
- Index files, locks and temporary files are never committed.

### Pi integration

- Lifecycle hooks provide capture and commit boundaries.
- Explicit tools provide model search, read and note operations.
- `/muninn` commands provide an attended surface.
- The standalone `muninn` binary provides headless status and synchronization.
- No journal content is automatically inserted into a system prompt or turn.

## Current format boundary

The implemented store contains:

```text
<store>/
├── store.md
├── journal/<host-id>/<YYYY-MM-DD>.md
├── .index/
└── .git/
```

[journal-format.md](journal-format.md) defines the Markdown entry grammar. Phase 3 migrates
these entries into [project-journal-format.md](project-journal-format.md) while preserving
IDs, timestamps, source, body, task grouping and session pointers.

Phase 1 originally used the canonical checkout top-level as project identity. Phase 3 PR 1
has replaced that boundary with a logical project UUID and Git-common-directory resolver;
the temporary Markdown store now lives at that UUID path while migration is pending.

## Foundation acceptance

The retained foundation is healthy when:

1. concurrent local appends do not interleave;
2. a truncated final write cannot hide older records;
3. secrets are removed before they reach disk or Git;
4. search/read cannot escape an active store or an explicitly referenced transcript;
5. the index can be deleted and rebuilt without information loss;
6. sync never stages unrelated files;
7. project settings cannot expand user-authorized behavior; and
8. journal retrieval remains explicit.

Phase 3 may replace the concrete implementation behind these properties, but not weaken
them. Its work is specified in [phase-3-plan.md](phase-3-plan.md).
