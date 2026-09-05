# Authored memory-quality scenarios

This corpus contains ten synthetic incidents, including an unresolved investigation and a
version-dependent solution with a later correction. The facts and recall tasks were authored
before running any real-model evaluation. They describe fixture environments, not universal
advice. Positive tasks paraphrase the observed symptom; negative tasks concern another
scenario and must not select the current scenario's memory.

Run explicitly with a model already configured in pi:

```bash
npm run eval:memory -- --model PROVIDER/MODEL
```

The runner uses pi's model/auth registry, sends only these synthetic fixtures, and creates
an isolated temporary journal which it removes afterward. It does not load pi extensions or
modify the real project journal. Model calls may incur provider charges. The model must be
available through pi's normal registry/models.json, not only through an extension provider.
No real-model run is part of the default tests, and no real-model quality result is claimed.

JSONL output includes model identity/usage, extracted memories, expected facts, and selected
canonical evidence for each recall task. Review extraction outputs for retained facts,
unsupported causes, fabricated success, unknowns and applicability. Positive/negative recall
checks are independent of extraction, using the authored records as the retrieval corpus.
Inspect correction handling and unrelated selections manually; the simple hit check is not
a precision score. This runner does not measure whether a coding model initiates recall;
that needs a separate real pi task evaluation. Scripted integration tests cover orchestration.
