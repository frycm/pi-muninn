# How Muninn works

Muninn keeps a searchable account of work alongside a project. It does not try to maintain a second version of the codebase or decide what your current instructions should be.

## From a task to evidence

Suppose an agent investigates a failing deployment. It reads configuration, tries a command and discovers that a migration must run first. When the task settles, Muninn can record a concise outcome with the task ID, member and host identities, Git provenance and a pointer to the pi transcript. Explicit remember and correction requests can create user-authored evidence. A simple chat without substantive work is skipped.

The configured memory model extracts structured issue/solution memories or general durable
outcomes. Code validates the response and evidence references, then renders it into the
existing journal body. It assigns identity, source pointers and provenance itself. The
memory model can differ from the coding model; it receives redacted, bounded excerpts.
Unknown causes, unresolved solutions and unperformed verification are kept explicit.

“Remember this session” and `/muninn remember [FOCUS]` invoke the same service over the current
branch. These are requests to produce agent evidence; literal facts such as “Remember: use
pnpm here” remain user notes. Prepared records and processed source IDs are saved privately
in pi's session so retries reuse frozen IDs and signatures. Oversized work is chunked, with
partial results reported when the time or call budget runs out.

A write passes through a shared authority check, canonical record construction, redaction and an optional signature. Muninn appends one complete JSON line to that writer's monthly shard and flushes it to disk. Background capture is queued; synchronization uses the same store lock. This prevents a sync from racing a partially appended record.

A logical project has an opaque UUID. Local checkout paths are aliases, so linked worktrees share a journal even on different branches. An independent clone is linked or joined explicitly; matching code-repository remote URLs alone do not merge identities.

## From a question to selected context

A later session might ask “why did deployment fail last time?”. The agent can call `journal_search`, inspect snippets and provenance, then select IDs for `journal_read` or `journal_context`. No history is inserted into the system prompt automatically.

`journal_recall` combines this workflow: it searches, optionally expands weak lexical
queries, then asks the selected memory model to choose applicable records. It returns
complete evidence and correction neighborhoods, with separate applicability reasons.
Records whose correction neighborhoods cannot fit or whose trust disallows recommendation
are omitted explicitly. Evidence that changed during the model call requires a new recall.
`/muninn recall QUERY` asks the coding agent to perform this workflow.

With `recall.mode: "assisted"`, a per-task hook supplies procedural guidance to call recall
for substantive tasks and newly encountered errors. The hook includes no journal text.
Tool results are visible in the session, and recall-only turns do not generate new copies
of the retrieved memories. Manual recall remains the default: only explicit global user
opt-in enables proactive guidance. A project may turn it off but cannot opt the user in.
Quality evaluation does not change this default. Manual mode still permits explicit
remember/recall requests; automatic outcome capture is controlled separately.

Search uses local lexical matching: normalized Unicode words, prefixes, limited typo tolerance, filters and relation-aware ranking. Its optional index is disposable. A canonical scan produces the same answers, and an invalid index is rebuilt from journal bytes. Search explanations expose the matching terms and ranking contributions.

Every retrieval checks whether the journal shards, manifest or local trust file changed. Another session's append, a sync or a trust edit therefore refreshes the cached view. A verification result is reused only within that private snapshot. Model responses have character limits; full records that cannot fit are explicitly omitted rather than silently changing signed text.

## From a mistake to a correction

A record can be wrong or become outdated. A person appends a correction linked to its ID, preserving both the earlier assertion and the correction. An annotation adds context without replacing the assertion. Competing user corrections produce a conflict that stays visible until a person resolves it.

The distinction between `user`, `agent` and `external` is separate from cryptographic verification. A correctly signed agent note is still an agent note. Models cannot promote their notes to user decisions or resolve conflicts on the user's behalf through the journal tools.

## From one machine to a team

Journal Git is separate from code Git. An explicit `project remote URL` action approves the destination on the local machine. `project join URL` validates and installs a shared journal and grants local approval for that supplied URL. Synced project metadata cannot redirect later transfers.

Sync first commits pending local data, then fetches, validates project identity and ownership, rebases and pushes without force. Additive manifest changes can be merged; conflicting journal bytes stop the operation. Transient network failures leave a local commit ready for another sync. The store is useful without any remote.

The team can read concise records even when a transcript exists only on its original machine. Explicit encrypted transcript exchange is available when someone needs the detailed evidence.

## Optional signatures

`crypto init` creates a local Ed25519 key and publishes its public descriptor. Teammates establish identity by comparing and pinning its full fingerprint independently. Signatures authenticate the bytes and author key; they do not prove that an assertion is correct or that a remote delivered complete history.

Rotation transfers trust through a signed successor transition only if the predecessor was authorized at the transition time. Revocation and compromise affect verification without editing records. A pending private transaction makes rotation and recovery retryable if a commit or process fails. A local prospective `require` policy can refuse unverified new writes and stop a violating store before push.

Read the [security model](security.md) for the precise limits, and [operations](operations.md) for command examples and recovery procedures.
