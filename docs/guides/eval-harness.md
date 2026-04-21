# Eval harness

The eval harness measures pbrain end-to-end across three stages: **ingest**
(markdown source → page + fact capture), **retrieval** (query → ranked
pages), and **answer** (query + retrieved context → answer with citations).
It replaces "does the feature work?" gut checks with metrics you can diff
run-over-run to catch regressions before users hit them.

## What it measures

| Stage      | Input                              | Primary metric                  | Ship gate                             |
|------------|------------------------------------|---------------------------------|---------------------------------------|
| ingest     | markdown source doc                | `fact_union_recall`             | `forbidden_fact_rate = 0`             |
| retrieval  | query                              | `nDCG@5`                        | no regression ≥ 5% vs baseline        |
| answer     | query + retrieved context          | `answer_fact_coverage`          | `citation_hallucination_rate = 0` + `refusal_correctness = 1` on expected_refusal cases |

Additional observability metrics per stage: latency, tokens in/out, judge
call count, judge-degraded count, and page/citation F1 in exact +
hierarchical flavors.

## Scope honesty

v0.4.0 measures:
- **Markdown ingest** (`importFromContent`) — one of several ingest paths.
  Audio transcription, `pbrain sync`, `pbrain data-research`, webhook
  transforms, and media-ingest skill paths are NOT covered; each will
  gain its own stage as those pipelines stabilize.
- **Retrieval** — all strategies (keyword / vector / hybrid).
- **Answer generation + citation accuracy** against **inline retrieved
  context** (from the fixture). Live retrieval → answer stitching lands
  in v0.4.x once the frozen seed brain is committed.

Not covered: enrichment LLM calls in isolation, embedding quality,
chunking quality (all rolled into ingest observability), cron/backoff/
rate-limit behavior.

## Running evals

```bash
# Single stage, full baseline
pbrain eval ingest   --fixtures test/fixtures/eval/ingest/baseline/baseline.json
pbrain eval answer   --fixtures test/fixtures/eval/answer/baseline.json
pbrain eval retrieve --fixtures test/fixtures/eval/retrieval/baseline.json

# Dev loop — first N cases only (cheap + fast)
pbrain eval ingest --fixtures ./ingest-baseline.json --sample 1

# Machine-readable JSON for regression tooling
pbrain eval ingest --fixtures ./baseline.json --json > runs/ingest.json

# Composite run across all three stages
pbrain eval all --fixtures-dir test/fixtures/eval/ --sample 3

# Variance-aware ship-gate run (mean ± stdev on ship-gate metrics)
pbrain eval all --fixtures-dir test/fixtures/eval/ --runs 3 --json > runs/candidate.json
```

### Required environment

| Stage     | Required env vars                                                         |
|-----------|---------------------------------------------------------------------------|
| ingest    | `ANTHROPIC_API_KEY` (judge). `OPENAI_API_KEY` only if embeddings aren't skipped — the runner passes `noEmbed: true` by default. |
| retrieval | `OPENAI_API_KEY` (query embedding for the vector path).                   |
| answer    | `ANTHROPIC_API_KEY` (generator + judge).                                  |

Missing keys surface as a loud error **before** any case runs — no
half-executed runs with mixed results.

### Pinned models

Both generator and judge pin exact Anthropic snapshots so calibration
doesn't drift silently when a model alias rolls over:

- `DEFAULT_GENERATOR_MODEL = 'claude-haiku-4-5-20251001'` (answer stage)
- `DEFAULT_JUDGE_MODEL     = 'claude-sonnet-4-5-20250929'` (ingest + answer)

Override via `EVAL_GENERATOR_MODEL` / `EVAL_JUDGE_MODEL` env vars for
experiments; production runs should stick to the committed pins.

## Fixture format

Every fixture is a single JSON file with the same outer envelope:

```jsonc
{
  "version": 1,
  "kind": "ingest" | "retrieval" | "answer",
  "meta": {
    "description": "Short prose about what this covers",
    "generator_model": "claude-haiku-4-5-20251001",
    "judge_model": "claude-sonnet-4-5-20250929",
    "source_type": "markdown",
    "curated_at": "2026-04-21",
    "curator": "joe@ticc.net",
    "fixture_class": "baseline"
  },
  "cases": [ /* stage-specific */ ]
}
```

`version: 1` is explicit. Unknown version values reject at load time with
a clear error — no silent drift when fixture shape evolves.

### Ingest case

```jsonc
{
  "id": "adr-001-database-choice",
  "source": { "type": "markdown", "path": "./sources/adr-001-database-choice.md" },
  "expected_pages": [
    { "slug": "decisions/adr-001-database-choice", "type": "decision" }
  ],
  "required_facts": [
    { "fact": "Chose Postgres with pgvector over SQLite and DuckDB", "fact_type": "narrative" },
    { "fact": "The decision was made on 2026-02-14", "fact_type": "temporal" }
  ],
  "forbidden_facts": [
    { "fact": "Chose SQLite as the production engine" }
  ],
  "forbidden_pages": []
}
```

- `fact_type: narrative | temporal | structural` routes the judge to the
  right column preferentially (narrative → compiled_truth, temporal →
  timeline, structural → frontmatter).
- `forbidden_facts` is a hallucination guard. Rate MUST be 0 to ship.
- `forbidden_pages` are slugs that must NOT be created by ingest.

### Retrieval case

```jsonc
{
  "id": "find-database-decision",
  "query": "What database did I pick for pbrain?",
  "relevant": ["decisions/adr-001-database-choice"],
  "grades": { "decisions/adr-001-database-choice": 3 }
}
```

Field-for-field aligned with `EvalQrel` (the retrieval primitive).

### Answer case

```jsonc
{
  "id": "database-choice-factual",
  "query": "What database did I pick for the pbrain data pipeline and why?",
  "required_answer_facts": [
    "Chose Postgres with pgvector",
    "Reason was hybrid search"
  ],
  "forbidden_answer_facts": [
    "Chose SQLite",
    "The decision was made in 2024"
  ],
  "required_citations": ["decisions/adr-001-database-choice"],
  "forbidden_citations": [],
  "expected_refusal": false,
  "retrieved_context": [
    {
      "slug": "decisions/adr-001-database-choice",
      "text": "Short chunk the generator will see as context..."
    }
  ]
}
```

- `expected_refusal: true` flips the check: the model MUST refuse and MUST
  emit no citations. Useful for unanswerable-query cases. Judge is NOT
  called on facts in this mode — refusal correctness is the only gate.
- `retrieved_context` is inline in v0.4.0. v0.4.x will add an orchestrator
  path that fills this from live retrieval against a seed brain.

## Regression-guard ship gate

v0.4.0 thresholds are **regression guards against a committed baseline**,
not absolute quality bars. The question is "did we regress from where we
were," not "are these numbers good in isolation."

```bash
# Capture the baseline once (first clean run on green master):
pbrain eval all --fixtures-dir test/fixtures/eval/ --runs 3 --json \
  > runs/v0_4_0-baseline.json
# Commit runs/v0_4_0-baseline.json to the repo.

# Every subsequent ship:
pbrain eval all --fixtures-dir test/fixtures/eval/ --runs 3 --json \
  > runs/candidate.json
# Diff candidate vs baseline:
#   - Any stage metric regressed > 5% → fail the gate.
#   - Absolute requirements must always hold:
#       ingest.forbidden_fact_rate = 0
#       ingest.forbidden_page_rate = 0
#       answer.forbidden_fact_rate = 0
#       answer.citation_hallucination_rate = 0
#       answer.refusal_correctness = 1.0 on expected_refusal cases
```

**Why `--runs 3`.** Claude at T=0 is not fully deterministic. Single-run
detection at a 5% threshold produces false alarms from run-to-run variance.
`--runs 3` lets regression detection distinguish noise from signal:
require `(baseline_mean - candidate_mean) > 2 * candidate_stdev` for a
real regression.

**Baseline update policy.** New baselines land via a dedicated PR that
only modifies `runs/v0_4_0-baseline.json` and nothing else. The diff shows
exactly what moved. One reviewer reads the PR for the reason the baseline
is being updated. This prevents the regressing-PR-rewrites-its-own-baseline
footgun.

## Cost + runtime (honest numbers)

With pinned Haiku generator + Sonnet judge, as of v0.4.0:

- **Ingest**: ~$0.05-0.07 per case × 10 cases ≈ **$0.50-0.70 per full run**
- **Retrieval**: ~$0.01 for 10 queries (OpenAI embeddings only)
- **Answer**: ~$0.02 per case × 10 cases ≈ **$0.20 per full run**
- **Judge calibration** (if triggered): ~$0.15 across all stages
- **`pbrain eval all` full run: ~$0.75-1.00**
- **Ship-gate `--runs 3` variant**: ~$2.25-3.00

Runtime, sequential: ~6-10 min for the full composite. Dev loop with
`--sample 3` stays under $0.25 and a couple minutes.

**Don't run in a loop.** If anyone wires `pbrain eval all` into an
auto-re-run-on-change flow, $1/run × 50 runs/day = $50/day. Use `--sample 3`
or the individual stage subcommands for iteration.

## Seed-brain rebuild (v0.4.x)

The frozen seed brain at `test/fixtures/eval/seed-brain/brain.pgdump.sql`
is a committed PGLite dump built by running the baseline ingest cases
against an empty brain and exporting the result. It lets retrieval and
answer eval run against known content instead of the user's live brain.

Rebuild when fixture content changes materially:

```bash
# Fresh in-memory PGLite + run ingest baseline
pbrain eval ingest --fixtures test/fixtures/eval/ingest/baseline/baseline.json
# Export the resulting brain state
#   (procedure lands with the seed-brain artifact in v0.4.x)
```

Until the seed brain ships, retrieval and answer stages in `pbrain eval all`
run against the engine the CLI passes in (your live brain by default) or
inline context (answer stage), respectively.

## Judge calibration

The Sonnet judge is the correctness oracle for ingest + answer facts.
Calibration artifacts at `test/fixtures/eval/judge-calibration/<stage>.jsonl`
carry hand-labeled `{input, human_label, judge_verdict}` rows. CI
recomputes verdicts and fails if agreement < 0.9.

Sample sizes: 50 rows per stage. At P(agreement)=0.9 the 95% CI on 50
samples is roughly [0.80, 0.96] — tight enough to trust the ship gate.

**Drift detector.** Every `pbrain eval all` run picks 3 random calibration
rows, re-runs the judge, and emits a stderr warning if any disagree. Does
not block the run; surfaces the problem so you can re-calibrate before
metrics drift invisibly.

Calibration artifacts ship in the v0.4.0-fixtures follow-up PR alongside
the remaining 7 baselines + 3 adversarials per stage.

## CI recipe

```yaml
# .github/workflows/eval.yml (sketch)
- name: Run eval harness
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  run: |
    pbrain eval all --fixtures-dir test/fixtures/eval/ --runs 3 --json \
      > runs/candidate.json
    bun run scripts/check-regression.ts runs/v0_4_0-baseline.json runs/candidate.json
```

The regression-check script is a ~50-line diff tool that compares each
stage's mean against the baseline with the variance-aware threshold
described above. Lands with the captured-baseline PR.

## What's not in v0.4.0

- **Cross-family judge** (GPT or Gemini). Haiku + Sonnet is tier-only
  decorrelation (~30% bias reduction per Zheng 2023), not true
  cross-family separation. Deferred to v0.4.x.
- **Meta-eval** — running the harness against a known-regressed pbrain
  version to prove it detects the regression. v0.4.1 work.
- **Seed brain artifact** — committed PGLite dump for hermetic retrieval
  + answer eval. v0.4.x.
- **Full 10 baselines + 3 adversarials per stage** — v0.4.0 ships 3
  representative baselines per stage; the fixtures-completion PR lands
  the remaining 7 + adversarials + judge-calibration JSONL.
- **Consolidation stage** — ships with Auto Dream when that lands.

## Writing new fixtures

1. Pick the shape that fits your gap (ingest for "ingest missed X",
   retrieval for "search ranks the wrong thing first", answer for "the
   answer is confident about something false").
2. Start with one case. Get it green with the fake-judge unit tests in
   `test/eval-{ingest,answer}.test.ts` if you're adding coverage code-side.
3. Run it manually against live models: `pbrain eval <stage> --fixtures
   ./my-new-case.json --sample 1 --verbose`. Inspect the judge's
   rationale strings — if they disagree with your expectation, either
   your fact phrasing is ambiguous OR the model is legitimately missing
   it. Both are useful signals.
4. Commit alongside the fixture's source doc if it's an ingest case.
   Source docs live under `test/fixtures/eval/ingest/baseline/sources/`.
5. Update `runs/v0_4_0-baseline.json` in a follow-up PR that only touches
   that file.
