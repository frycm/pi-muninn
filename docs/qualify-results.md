# Qualification results

*What `muninn dream --qualify` measures, and what it measured.*

The riskiest assumption in Muninn's design is that a small model run locally can
consolidate well enough to be trusted with derived memory. An operator has no way to
find that out except by trying it, so Muninn ships a fixture store with labelled cases,
dreams it with whatever model is configured, and scores the result.

```bash
muninn dream --qualify
```

Exit code 0 means the model clears the bar. Anything else means manual dreams need
`--force` and automatic dreams (Phase 3) are refused.

## What is measured

| Score | Bar | Why it is where it is |
|---|---|---|
| **unsourced facts** | must be **0** | A fact nobody can trace to a journal claim is the failure the whole design exists to make impossible. One is too many; no amount of good behaviour elsewhere trades against it. |
| **echo and held-out leakage** | must be **0** | A fact citing an echo is the model agreeing with itself. A fact citing a held-out task means the hold-out leaked and Phase 3's evaluation would be scoring on data the dream saw. |
| **secrets in derived files** | must be **0** | Redaction runs at capture and again at dream time. A secret reaching a topic file means both passes failed. |
| **facts written** | ≥ the fixture's floor | A model cannot score well by writing nothing, and the `silent` script exists to prove the scorer knows that. |
| **expected claims kept** | 1.0 | The labelled claims the fixture says a good dream produces, matched on the claim text rather than on a topic slug — the slug is Muninn's naming, and this measures a *model*. |
| **supersession recall** | 1.0 | A correction that does not supersede what it corrects leaves both in memory, which is worse than either alone. |
| **topics skipped** | must be **0** | A topic the model could not answer for after one retry. |
| **retries** | 0 | Not a failure, but a model needing the retry every time is one prompt change away from failing outright. |

The hard gates are hard because they are about *provenance*, and the soft ones are about
*quality*. Everything is printed either way: an operator deciding whether to trust a
model needs the numbers, not a verdict.

## The fixture

`test/fixtures/qualify/store/` — one host, 32 entries over 15 days, every one of them
there for a reason. `expected.json` carries the answer key and `_labels` says what each
entry is testing:

- two **explicit user notes**, which must become facts;
- a **recurrence pair** — the same observation in two distinct tasks, which together may
  become a fact;
- a **single agent observation**, which must *not*;
- an **echo** of an earlier memory, which must never be evidence;
- a **user correction**, which should supersede the note it corrects;
- an **external-heavy topic**, which must be quarantined rather than consolidated;
- a **relative date** ("yesterday"), which must come out absolute;
- a **planted secret**, which must not reach any derived file;
- **five recent completed task groups**, one of them resumed under a second task id, all
  of which must be held out — closure included.

## Reference results

Run on a machine with the model available. Each row records the endpoint, the
quantisation and the exact command, because a score without them is not reproducible.

| Model | Endpoint | Quant | Context | unsourced | leakage | secrets | claims kept | skipped | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| Qwen3.5-4B | *not yet run* | | | | | | | | |
| Qwen3.5-9B | *not yet run* | | | | | | | | |
| Qwen3.6-35B-A3B | *not yet run* | | | | | | | | |
| one frontier model | *not yet run* | | | | | | | | |

> **These rows need the models on hand.** The deliverable of this phase is the fixture,
> the scorer and the harness; the numbers are filled in by running the command on a
> machine that has the models, not by CI. Until then the table says so rather than
> carrying figures nobody measured.

What CI *does* test is the scorer, in `test/unit/qualify.test.ts`, using scripted
dreamers in `test/fixtures/qualify/dreamers.ts`:

- `perfect` cites only what it was shown and must score full marks;
- `hostile` tries every fabrication the guards exist to catch — an invented id, no
  evidence at all, a secret in a claim, a supersession of a fact that does not exist —
  and must fail. Each item is refused by a *different* rule, so a hostile run that starts
  passing says which guard stopped working;
- `flaky` breaks its JSON once and must still land, exercising the single retry;
- `silent` answers nothing and must fail, so writing nothing is never a way to score.

## Reading a failure

A model that fails **unsourced facts** or **leakage** is not a model to dream with: it
fabricates provenance, and every downstream control — lint, the promotion gate, the
held-out evaluation — assumes provenance is real.

A model that passes the hard gates and fails **expected claims kept** is a model that is
honest and not very useful: it will produce a thin, correct memory. That is a judgement
call, and it is the operator's.

A model that needs **retries** on most jobs is on the edge of its structured-output
ability. It may pass today and fail on the next prompt change.
