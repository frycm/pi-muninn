# Phase 2 — open questions

*Decisions I made to finish the phase that are yours to confirm or overturn, and
measurements the code is now able to make but nobody has made yet.*

Each of these is one line to change. They are ordered by how much rides on the answer.

---

## 1. Dreams do not write `rules.md`. Is that the right cut?

**What I did.** A dream reads `rules.md`, lints it (the cap, rules nothing has used, a
project rule contradicting a global one) and reports. It never writes one. The
consolidate schema has no `rule` field, so a model cannot propose one either.

**Why.** The v1 cut says dreams "write topics and rules", but every control that makes an
auto-derived rule safe — the provenance gate, canaries that check a rule *fires*, the
held-out evaluation — is Phase 3. A rule is followed, not merely recalled: a wrong fact
is a wrong answer, a wrong rule changes what the agent does everywhere. Shipping rule
derivation now would put the riskiest output in the system behind the weakest fence.

**What overturning it costs.** One field in the consolidate schema, one branch in
`applyFactList`, and a `rules.md` writer — maybe a day. The gate would then be "manual
remember", which is the same gate topics have.

**My recommendation:** leave it. The gate arrives in Phase 3 and rules can arrive with it.

---

## 2. A dream no longer holds the store lock. Should the design say so?

**What I did.** The store lock covers a dream's *setup* only — commit the pending
journal, read `HEAD`, cut the worktree. A separate `.dreaming` marker (pid, host, stamp,
timestamp; stale after two hours) excludes a second dream on the host.

**Why.** The README promises capture keeps writing while a dream runs, and separately
lists the operations that hold `.lock` for their whole duration — dream is not among
them, and cannot be. A dream is minutes of work; a queued append waits 60 s and then
gives up. Holding the lock throughout would have silently lost entries written during a
dream, which is the exact failure the whole project exists to prevent.

**What you need to decide.** Whether [Triggers and
locking](../README.md#triggers-and-locking) should be amended to describe the marker,
since it currently says two dreams are excluded "by it" — the store lock. I have not
edited that section, because it is design text and the change is yours to bless.

---

## 3. The loss guard measures net loss, not supersessions

**What I did.** `withinLossBound(before, after)` rejects a job when
`before - after > max(1, floor(0.25 × before))`.

**Why two departures from "> 25 % of a topic's facts".** As a pure ratio it forbids the
correction the mechanism exists for: a topic with three facts could never have one
superseded, and the design's own worked example is one fact of one replaced by a user
correction. As a count of *supersessions* it forbids merging two facts into one better
one — which is exactly what a merge dream does with every residue pair it settles.

**What you might prefer.** A hard floor of one fact is generous for a two-fact topic
(50 % net loss passes). If that is too loose, the alternative is a floor that scales —
say `max(1, ceil(0.25 × before))` — at the cost of making a one-fact topic
uncorrectable again.

---

## 4. Selecting decisions by `phase` was dropped

**What I did.** An `agent` or `tool` claim is promoted when it reads as a decision or a
failure (word cues), or when it recurs across two independent pieces of work. The plan
also said `phase: fix|review|ops` should count on its own; it does not.

**Why.** The qualification fixture showed the cost immediately: every "finished the
investigation" outcome entry of an `ops` task became a fact. Phase records *where* work
happened, not what was learned.

**The trade.** A genuine decision phrased without any of the cue words now waits for a
second sighting. That is the conservative direction — it stays in the journal, findable
— but it is a real loss of recall, and the fixture can measure it if you want a middle
ground (phase *and* a claim that is not a run-completion sentence, say).

---

## 5. Thresholds that are still guesses

The fixture now exists to measure these; I have not swept them.

| Constant | Value | Where | What moving it costs |
|---|---|---|---|
| echo overlap | 0.8 | `gather.ts` `ECHO_THRESHOLD` | too low discounts genuine re-observations; too high lets paraphrased echoes through |
| recurrence | ≥ 2 independent sightings | `gather.ts` | at 3 the store learns much more slowly; at 1 it is not gating at all |
| contradiction candidate | 0.6 | `lint.ts` | too low floods the report; too high misses near-duplicates |
| topic routing floor | BM25 score 2 | `gather.ts` `TOPIC_SCORE_FLOOR` | too low and everything lands in whichever topic shares a common word; too high and topics fragment |

The README lists the echo threshold as an open question and says the fixture will carry
labelled cases so it becomes a measurement. It now does — the measurement is the
outstanding work.

---

## 6. New topic names come from cues, and they read oddly

A topic nothing exists for yet gets a slug from the entry's `cue`, with stopwords
stripped: `running-test-suite`, `integration-tests-fail`, `unexpectedly-slow`. It is
deterministic, which matters — two hosts must propose the same slug or their dreams fork
instead of merging — but nobody would choose those names.

**Options.** Leave it (topics are addressed by id, and the slug is cosmetic); let the
model name a *new* topic only, keeping determinism for existing ones by routing; or
curate names by hand and let `/muninn topics` rename.

---

## 7. `allowedEvidence` includes the topic's existing evidence

A consolidate job may cite the claims this job showed it **plus** the claims the topic's
own facts already stand on. That is deliberate — a consolidation that merges two facts
has to be able to re-cite what they rested on — but it means a model can pull an id
forward from an old fact into a new one without seeing the entry it came from.

Lint still requires that id to exist and be live, so nothing untraceable gets in. The
question is whether "cited by a fact in this topic" is a strong enough licence, or
whether a merge should be the only job allowed to do it.

---

## 8. Erasure requires `git-filter-repo`, and refuses in-repo stores

Two calls I made, both in the direction of refusing rather than half-doing:

- **`git-filter-repo` is required**, not optional. Without it the erasure is refused;
  `--no-rewrite` does everything else and says loudly that the text is still in `.git`
  and in every existing clone. The alternative — `git filter-branch` — is deprecated by
  git itself and leaves backup refs, which would mean shipping the bytes it was meant to
  remove. It is not installed by default anywhere, including this machine.
- **In-repo stores refuse erasure outright.** Rewriting the product's history is not
  Muninn's call. This resolves the README's open question in the direction it suspected;
  the migration command is Phase 5, and until then the message tells the operator how to
  move the store by hand.

---

## 9. The qualification table needs you and a GPU

`docs/qualify-results.md` ships with the four rows the plan names and no numbers.
Filling them is one command per model on a machine that has them:

```bash
muninn dream --qualify
```

CI scores the *scorer* against scripted dreamers, so the harness is verified; what is
missing is the measurement the whole phase's central assumption rests on — that a 9B
model dreams well enough. Until those rows are filled, the README's first acceptance
criterion is met in form and not in fact, and both documents say so.

---

## 10. Smaller things I decided without asking

- **Worktrees live under `<agentDir>/muninn-worktrees/`**, not `.git/worktrees/` — that
  is where git keeps worktree *metadata*, and the checkout has to be somewhere git is not
  tracking.
- **A dream that fails keeps its worktree**, because it and the branch are the evidence;
  the next dream collects it.
- **`updated:` in a topic moves only when a fact does**, so an idle dream leaves no diff.
- **`MEMORY.md`'s hand-written part is everything above a marker line**, and the budget
  is measured with the same function recall counts with rather than estimated.
- **Rules keep their room in `MEMORY.md` when topics have to be dropped**, because
  dropping a rule changes what the agent does and dropping a topic line only changes what
  it is reminded of.
- **A session with `dream.model` unset dreams with the session's own model** and says so
  on stderr — refusing would be worse, silence would be a surprise.
