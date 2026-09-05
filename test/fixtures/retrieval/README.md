# Retrieval fixture

60 crafted relevance judgments over 34 records. The original eight application scenarios remain; 26 additional Muninn scenarios each have a natural-language question and a shorter lexical query. Some queries constrain paths or branches. These are authored test data, not captured user queries or production measurements.

The expected records were selected while writing the scenarios, before measuring ranking. Broad wording, overlapping concepts, typos and a correction relation deliberately exercise distractors. Source material is the repository behavior and its review on 2026-09-05; record timestamps are synthetic.

Run `npm run test:eval` from the checkout to print metrics, and `npm test -- test/unit/evaluate.test.ts` to verify scan/index equivalence and regression budgets. Keep relevance labels tied to the question when adjusting retrieval; do not change them merely to improve the score.
