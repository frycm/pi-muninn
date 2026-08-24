# The derived formats

*Normative. These are the files a dream writes and promises to keep reading.*

The [journal format](journal-format.md) is the layer nothing derives; this document is
the layer above it. Every file here is **derived**: a dream writes it, a forgotten dream
reverts it, and deleting the lot loses nothing that the journal cannot produce again.
That is why they can be rewritten at all, and why every fact in them points back at the
journal claims it came from.

`src/topics/format.ts` is the implementation and `test/unit/topic-format.test.ts` its
executable copy. Where this document and the code disagree, that is a bug in one of them,
and the test suite decides which. Everything here is schema `1`.

## The shape every derived line shares

A bullet, then a ` · `-separated flat trailer of `key: value` pairs — the same grammar as
a journal entry's metadata block, read by the same parser (`src/journal/trailer.ts`).
Flat, and one line per thing, because:

- the merge unit is then a **fact**, not a line of text, so two hosts' dreams merge
  structurally ([Merging dreams](../README.md#merging-dreams));
- `git log -p` reads as a list of what changed;
- a 4B model can be asked to produce it without nested JSON.

Unknown trailer keys are **preserved**, never dropped: a store written by a later Muninn
must survive a round-trip through this one.

## `topics/<slug>.md`

```markdown
---
topic: testing
updated: 2026-08-22
---

# Testing

How this project is tested.

## Facts

- **Run tests with `pnpm test --run`, never watch mode.** id: f-testing-0198f2c2-0a1b-7c2d-8e3f-405162738495 · valid_from: 2026-08-22 · source: user · evidence: j-0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01.1 · cue: CI hangs on vitest

## Superseded

- ~~Tests run with `pnpm test`.~~ id: f-testing-0198e9a5-2d3e-7f40-9152-63748596a7b8 · valid_from: 2026-08-01 · source: agent · evidence: j-0198e9a4-1c2f-7d33-8e55-aa10b2c3d4e0.1 · valid_to: 2026-08-22 · superseded_by: f-testing-0198f2c2-0a1b-7c2d-8e3f-405162738495 · reason: user correction — watch mode hangs CI
```

**Front matter** carries `topic` (the slug, which is also the basename and the middle
part of every fact id in the file) and `updated`. `updated` moves only when a fact does:
a dream that considered a topic and changed nothing leaves the file byte-identical, or
every dream would dirty every topic it looked at.

**The title** is the first `# ` heading, and everything between it and the first fact
section is prose — a person's own notes about the topic, preserved verbatim through
every rewrite.

### Sections

| Heading | Holds |
|---|---|
| `## Facts` | Active facts. This is what recall and `MEMORY.md` are built from. |
| `## External` | Facts resting **only** on `external` evidence — fetched pages, repository content someone else wrote. Searchable, never auto-injected, never promotable to a rule without a human. The quarantine the [trust table](../README.md#trust-and-provenance) asks for. |
| `## Superseded` | Facts that were true and are not any more. Nothing is ever deleted. |

A heading this grammar does not know **ends** the fact sections: what follows is
someone's own prose, and facts do not live under it.

### A fact line

| Field | Required | Meaning |
|---|---|---|
| `id` | **yes** | `f-<topic>-<uuidv7>`. Minted by the dream, never reused, never renumbered — which is what lets two hosts dream the same topic without colliding. |
| `valid_from` | yes | The date the fact was asserted. |
| `source` | yes | `user` · `agent` · `tool` · `external` — **the weakest class the fact rests on**, computed from its evidence, not chosen by the model. A fact standing on one user correction and three tool observations is only as trustworthy as the class that can be wrong. |
| `evidence` | yes | Journal **claim** ids (`j-….n`), comma-separated. Evidence cites claims, never whole entries: an entry supports several independent facts, and superseding one must not hide the others. A fact with no live evidence is a lint failure. |
| `cue` | no | "When would I need this?" — indexed heavily, so a fact is findable by situation. |
| `phase` | no | The step of the coding loop, as in a journal entry. |
| `shadows` | no | A global fact id this project fact overrides *inside this project*. Recall prefers the project fact and labels the global one shadowed. |
| `valid_to` | superseded only | The date it stopped being true. |
| `superseded_by` | superseded only | The fact that replaced it. |
| `reason` | superseded only | Why, in a sentence. |

The claim comes first, in `**bold**` under `## Facts` and `## External` and in `~~strike~~`
under `## Superseded`; the markers are decoration and the trailer is the truth.

**Writer normalisation.** Two strings would split a fact line if a claim carried them:
the ` · ` that separates trailer fields and the ` id: ` that starts the trailer. A
newline would end the bullet outright. The writer replaces `·` with `-`, ` id: ` with
` id- `, and collapses whitespace — the same move `format.ts` makes for a prose line that
would read back as a heading. The writer bends the text so the reader cannot be wrong.

**A bullet the grammar cannot read is kept**, not deleted, and reported as a problem. A
store is Muninn's, but a person may still edit one, and silently deleting a hand-written
line is the worst possible way for them to find that out.

## `supersessions.md`

```markdown
- j-0198e9a4-1c2f-7d33-8e55-aa10b2c3d4e0.1 · valid_to: 2026-08-22 · by: j-0198f2c1-7b3e-7a10-9c44-2d6e0f1a8b01.1 · fact: f-testing-0198e9a5-2d3e-7f40-9152-63748596a7b8
```

One line per invalidated **claim**. `by` names the journal claim that overtook it; `fact`
names the fact whose supersession caused the row.

- **Append-only**, and deduplicated on the claim id. That is what makes it the one derived
  file a cross-host merge resolves by union without asking anybody, and what lets a dream
  re-run after a failure without leaving a trail of duplicates.
- **The key is a claim, never an entry.** Applying validity at exactly one granularity is
  what keeps "active-only" from meaning three different things in three places: retrieval
  drops superseded chunks, lint checks that every evidence claim is active, and a claim of
  the same entry that nobody superseded stays searchable.
- Ordinary recall — the per-turn injection, `memory_search`, the gather phase — is
  active-only. `memory_search({ history: true })` and `memory_read` by id still return
  superseded material, labelled.

## `rules.md`

```markdown
- R-014 · phase: test · scope: project · source: user · since: 2026-08-22 · last_confirmed: 2026-08-22
  Run `pnpm test --run`; never start watch mode in a non-interactive session.
```

The procedural layer. Rules have identities so that a dream can *retire* one — moved to
`## Retired` with a reason — rather than silently drop it, and so the evaluate phase can
say which rule a regression touched.

**Muninn does not write rules.** In this phase a dream reads `rules.md`, lints it (the
cap, unused rules, a project rule contradicting a global one) and reports; rules are
written by people. Rule derivation arrives with the promotion gate that makes it safe.

## `dreams/<host slug>/<ts>.md`

One report per dream. A dream's identity is `<host slug>/<ts>` — the host is part of it,
not decoration: two hosts dreaming the same synced store in the same minute is the
design's normal case, and a bare timestamp would make them one dream, with one listing
key and one report *file* that two remembers would then meet in an add/add conflict.
Reports are per host for the same reason journal files are: two machines never write the
same file. The branch is `dream/<host slug>/<ts>` and the report shares the key, so the
two are paired without an index. It records `input_head` and `journal_through` — which
makes "what has this store not yet learned from" the exact question
`git diff input_head..main -- journal/` — the held-out task groups, what was consolidated,
the lint findings, and, from Phase 3, the eval table.

Reports are kept even for dreams that were forgotten: the report of a forgotten dream is
the record of why.

## `MEMORY.md`

Unstructured markdown by contract — every reader treats it as lines, and the
[snapshot](../README.md#the-frozen-snapshot) is a line budget, not a parse. A dream
regenerates the generated sections and **preserves everything above them verbatim**, so
the file people wrote by hand before dreams existed survives the first dream.
