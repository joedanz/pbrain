/**
 * Tests for src/core/eval/answer.ts.
 *
 * Two layers (mirroring test/eval-ingest.test.ts):
 *   1. Unit tests with fake generator + fake judge — always run, hermetic.
 *   2. API-key-gated integration test that runs one real baseline case end
 *      to end through the live Anthropic generator + judge. Skips cleanly
 *      when ANTHROPIC_API_KEY is absent.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  runAnswerEval,
  type AnswerGeneratorFn,
  type AnswerGenResult,
  type AnswerJudgeFn,
} from '../src/core/eval/answer.ts';
import type { AnswerFixture, AnswerCase } from '../src/core/eval/fixtures.ts';
import type { JudgeResult } from '../src/core/eval/judge.ts';

// ─────────────────────────────────────────────────────────────────
// Stubs — fake generator + judge so unit tests don't touch Anthropic.
// ─────────────────────────────────────────────────────────────────

function staticGenerator(result: Partial<AnswerGenResult>): AnswerGeneratorFn {
  return async () => ({
    answer: '',
    citations: [],
    refused: false,
    tokens_in: 10,
    tokens_out: 20,
    ...result,
  });
}

const yesJudge: AnswerJudgeFn = async (): Promise<JudgeResult> => ({
  verdict: 'yes',
  reason: 'stub yes',
  judge_model: 'stub',
  tokens_in: 10,
  tokens_out: 5,
});

const noJudge: AnswerJudgeFn = async (): Promise<JudgeResult> => ({
  verdict: 'no',
  reason: 'stub no',
  judge_model: 'stub',
  tokens_in: 10,
  tokens_out: 5,
});

/**
 * Judge that says YES iff the fact's first 8 chars appear in the answer text.
 * Deterministic "substring match" heuristic — good enough to simulate an
 * answer that says some things but not others.
 */
const substringJudge: AnswerJudgeFn = async (text, fact) => {
  const needle = fact.slice(0, 8).toLowerCase();
  const match = text.toLowerCase().includes(needle);
  return {
    verdict: match ? 'yes' : 'no',
    reason: match ? 'substring match' : 'miss',
    judge_model: 'stub-substring',
    tokens_in: 20,
    tokens_out: 8,
  };
};

// ─────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────

const inlineFixture = (cases: AnswerFixture['cases']): AnswerFixture => ({
  version: 1,
  kind: 'answer',
  meta: {},
  cases,
});

const buildCase = (overrides: Partial<AnswerCase> = {}): AnswerCase => ({
  id: overrides.id ?? 'case-1',
  query: overrides.query ?? 'what is X?',
  required_answer_facts: overrides.required_answer_facts ?? ['fact-one', 'fact-two'],
  forbidden_answer_facts: overrides.forbidden_answer_facts ?? [],
  required_citations: overrides.required_citations ?? ['slug-a'],
  forbidden_citations: overrides.forbidden_citations ?? [],
  expected_refusal: overrides.expected_refusal ?? false,
  retrieved_context: overrides.retrieved_context ?? [
    { slug: 'slug-a', text: 'context text for slug-a' },
  ],
});

// ─────────────────────────────────────────────────────────────────
// Unit tests
// ─────────────────────────────────────────────────────────────────

describe('runAnswerEval — fact coverage', () => {
  test('all facts YES → answer_fact_coverage = 1.0', async () => {
    const fx = inlineFixture([buildCase()]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({
        answer: 'some answer',
        citations: ['slug-a'],
        refused: false,
      }),
      judgeFn: yesJudge,
    });
    expect(report.cases[0].answer_fact_coverage).toBe(1.0);
    expect(report.cases[0].fact_hits).toBe(2);
    expect(report.cases[0].fact_total).toBe(2);
  });

  test('all facts NO → answer_fact_coverage = 0', async () => {
    const fx = inlineFixture([buildCase()]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({ answer: 'answer', citations: ['slug-a'] }),
      judgeFn: noJudge,
    });
    expect(report.cases[0].answer_fact_coverage).toBe(0);
    expect(report.cases[0].fact_hits).toBe(0);
  });

  test('substring judge: partial coverage when answer mentions only one fact', async () => {
    const fx = inlineFixture([buildCase({
      required_answer_facts: ['postgres was chosen', 'sqlite was rejected'],
    })]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({
        // "postgres" (8 chars) matches first fact, "sqlite w" (first 8 of second) does not appear.
        answer: 'Postgres was the choice.',
        citations: ['slug-a'],
      }),
      judgeFn: substringJudge,
    });
    expect(report.cases[0].answer_fact_coverage).toBe(0.5);
  });
});

describe('runAnswerEval — forbidden facts', () => {
  test('yesJudge on forbidden fact → forbidden_fact_rate = 1', async () => {
    const fx = inlineFixture([buildCase({
      forbidden_answer_facts: ['SQLite was chosen'],
    })]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({ answer: 'anything', citations: ['slug-a'] }),
      judgeFn: yesJudge,
    });
    expect(report.cases[0].forbidden_fact_rate).toBe(1);
    expect(report.cases[0].forbidden_fact_hits).toBe(1);
  });

  test('noJudge on forbidden fact → forbidden_fact_rate = 0', async () => {
    const fx = inlineFixture([buildCase({
      forbidden_answer_facts: ['SQLite was chosen'],
    })]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({ answer: 'Postgres.', citations: ['slug-a'] }),
      judgeFn: noJudge,
    });
    expect(report.cases[0].forbidden_fact_rate).toBe(0);
  });

  test('empty forbidden_answer_facts → forbidden_fact_rate = 0', async () => {
    const fx = inlineFixture([buildCase({ forbidden_answer_facts: [] })]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({ citations: ['slug-a'] }),
      judgeFn: yesJudge,
    });
    expect(report.cases[0].forbidden_fact_rate).toBe(0);
    expect(report.cases[0].forbidden_fact_total).toBe(0);
  });
});

describe('runAnswerEval — citation hallucinations', () => {
  test('citation not in retrieved_context → counted as hallucination', async () => {
    const fx = inlineFixture([buildCase({
      retrieved_context: [{ slug: 'slug-a', text: 'text' }],
    })]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({
        citations: ['slug-a', 'slug-b'], // slug-b is not in context
      }),
      judgeFn: yesJudge,
    });
    expect(report.cases[0].citation_hallucinations).toEqual(['slug-b']);
    expect(report.cases[0].citation_hallucination_rate).toBe(0.5);
  });

  test('all citations in retrieved_context → rate = 0', async () => {
    const fx = inlineFixture([buildCase({
      retrieved_context: [
        { slug: 'slug-a', text: 't1' },
        { slug: 'slug-b', text: 't2' },
      ],
    })]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({ citations: ['slug-a', 'slug-b'] }),
      judgeFn: yesJudge,
    });
    expect(report.cases[0].citation_hallucination_rate).toBe(0);
    expect(report.cases[0].citation_hallucinations).toEqual([]);
  });

  test('empty citations → rate = 0 (no predictions = no hallucinations)', async () => {
    const fx = inlineFixture([buildCase({ expected_refusal: true, required_citations: [] })]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({ citations: [], refused: true }),
      judgeFn: yesJudge,
    });
    expect(report.cases[0].citation_hallucination_rate).toBe(0);
  });
});

describe('runAnswerEval — hierarchical citation matching', () => {
  test('exact match → precision + recall = 1.0', async () => {
    const fx = inlineFixture([buildCase({
      required_citations: ['companies/novamind'],
      retrieved_context: [{ slug: 'companies/novamind', text: 't' }],
    })]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({ citations: ['companies/novamind'] }),
      judgeFn: yesJudge,
    });
    expect(report.cases[0].citation_precision_hierarchical).toBe(1.0);
    expect(report.cases[0].citation_recall_hierarchical).toBe(1.0);
    expect(report.cases[0].citation_f1_hierarchical).toBe(1.0);
  });

  test('descendant citation → hierarchical F1 retains full credit', async () => {
    const fx = inlineFixture([buildCase({
      required_citations: ['companies/novamind'],
      retrieved_context: [{ slug: 'companies/novamind/series-a', text: 't' }],
    })]);
    const report = await runAnswerEval(fx, {
      // Cited a more-specific descendant; hierarchical should still credit.
      generatorFn: staticGenerator({ citations: ['companies/novamind/series-a'] }),
      judgeFn: yesJudge,
    });
    expect(report.cases[0].citation_precision_hierarchical).toBe(1.0);
    expect(report.cases[0].citation_recall_hierarchical).toBe(1.0);
    // Exact F1 should be 0 because the slug strings aren't identical.
    expect(report.cases[0].citation_f1_exact).toBe(0);
  });

  test('unrelated citation → hierarchical F1 = 0', async () => {
    const fx = inlineFixture([buildCase({
      required_citations: ['decisions/adr-001'],
      retrieved_context: [{ slug: 'people/someone', text: 't' }],
    })]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({ citations: ['people/someone'] }),
      judgeFn: yesJudge,
    });
    expect(report.cases[0].citation_f1_hierarchical).toBe(0);
  });
});

describe('runAnswerEval — refusal correctness', () => {
  test('expected_refusal=true, refused=true + no citations → correctness = 1', async () => {
    const fx = inlineFixture([buildCase({
      expected_refusal: true,
      required_citations: [],
      required_answer_facts: [],
    })]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({
        answer: "I don't have that information",
        citations: [],
        refused: true,
      }),
      judgeFn: yesJudge,
    });
    expect(report.cases[0].refusal_correctness).toBe(1);
  });

  test('expected_refusal=true, refused=true BUT citations present → correctness = 0', async () => {
    const fx = inlineFixture([buildCase({
      expected_refusal: true,
      required_citations: [],
      required_answer_facts: [],
      retrieved_context: [{ slug: 'slug-a', text: 't' }],
    })]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({
        answer: "I don't know but here's a slug",
        citations: ['slug-a'],
        refused: true,
      }),
      judgeFn: yesJudge,
    });
    expect(report.cases[0].refusal_correctness).toBe(0);
  });

  test('expected_refusal=true, refused=false → correctness = 0', async () => {
    const fx = inlineFixture([buildCase({
      expected_refusal: true,
      required_citations: [],
      required_answer_facts: [],
    })]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({ answer: 'some answer', citations: [], refused: false }),
      judgeFn: yesJudge,
    });
    expect(report.cases[0].refusal_correctness).toBe(0);
  });

  test('expected_refusal absent → refusal_correctness sentinel = -1', async () => {
    const fx = inlineFixture([buildCase()]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({ citations: ['slug-a'] }),
      judgeFn: yesJudge,
    });
    expect(report.cases[0].refusal_correctness).toBe(-1);
  });

  test('expected_refusal=true → judge not called for facts (refusal path skips judging)', async () => {
    let calls = 0;
    const countingJudge: AnswerJudgeFn = async () => {
      calls++;
      return { verdict: 'yes', reason: 'x', judge_model: 'stub' };
    };
    const fx = inlineFixture([buildCase({
      expected_refusal: true,
      required_answer_facts: ['a fact the judge would YES on'],
      forbidden_answer_facts: ['another fact'],
      required_citations: [],
    })]);
    await runAnswerEval(fx, {
      generatorFn: staticGenerator({ answer: 'refused', citations: [], refused: true }),
      judgeFn: countingJudge,
    });
    expect(calls).toBe(0);
  });
});

describe('runAnswerEval — forbidden citations + degraded', () => {
  test('forbidden citation emitted → surfaced in forbidden_citation_hits', async () => {
    const fx = inlineFixture([buildCase({
      forbidden_citations: ['decisions/wrong-adr'],
      retrieved_context: [
        { slug: 'slug-a', text: 't' },
        { slug: 'decisions/wrong-adr', text: 't' },
      ],
    })]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({ citations: ['slug-a', 'decisions/wrong-adr'] }),
      judgeFn: yesJudge,
    });
    expect(report.cases[0].forbidden_citation_hits).toEqual(['decisions/wrong-adr']);
  });

  test('generator_degraded flag propagates from generator result', async () => {
    const fx = inlineFixture([buildCase({
      expected_refusal: true,
      required_answer_facts: [],
      required_citations: [],
    })]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({
        answer: '',
        citations: [],
        refused: true,
        degraded: true,
      }),
      judgeFn: yesJudge,
    });
    expect(report.cases[0].generator_degraded).toBe(true);
  });
});

describe('runAnswerEval — aggregation', () => {
  test('sample slices to first N cases', async () => {
    const fx = inlineFixture([
      buildCase({ id: 'c1' }),
      buildCase({ id: 'c2' }),
      buildCase({ id: 'c3' }),
    ]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({ citations: ['slug-a'] }),
      judgeFn: yesJudge,
      sample: 2,
    });
    expect(report.cases.length).toBe(2);
    expect(report.cases.map((c) => c.case_id)).toEqual(['c1', 'c2']);
  });

  test('mean refusal_correctness is NaN when no refusal cases present', async () => {
    const fx = inlineFixture([buildCase()]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({ citations: ['slug-a'] }),
      judgeFn: yesJudge,
    });
    expect(Number.isNaN(report.mean.refusal_correctness)).toBe(true);
  });

  test('totals sum tokens + judge calls across cases', async () => {
    const fx = inlineFixture([buildCase({ id: 'c1' }), buildCase({ id: 'c2' })]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({ citations: ['slug-a'] }),
      judgeFn: yesJudge,
    });
    // Each case: 2 required facts + 0 forbidden = 2 judge calls. Plus tokens from generator + judges.
    expect(report.totals.judge_calls).toBe(4);
    expect(report.totals.tokens_in).toBeGreaterThan(0);
  });
});

describe('runAnswerEval — empty fixtures', () => {
  test('zero cases → empty report, NaN means', async () => {
    const fx = inlineFixture([]);
    const report = await runAnswerEval(fx, {
      generatorFn: staticGenerator({}),
      judgeFn: yesJudge,
    });
    expect(report.cases.length).toBe(0);
    // mean over empty array is 0 per our metrics.mean implementation.
    expect(report.mean.answer_fact_coverage).toBe(0);
    expect(Number.isNaN(report.mean.refusal_correctness)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// Integration — gated on ANTHROPIC_API_KEY
// ─────────────────────────────────────────────────────────────────

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
const describeReal = hasKey ? describe : describe.skip;

describeReal('runAnswerEval — live Anthropic integration', () => {
  test(
    'first baseline case: covers facts + cites correctly + no hallucinations',
    async () => {
      const fxPath = join(
        __dirname,
        'fixtures',
        'eval',
        'answer',
        'baseline.json',
      );
      if (!existsSync(fxPath)) {
        throw new Error(`answer baseline fixture not found at ${fxPath}`);
      }
      const fx: AnswerFixture = JSON.parse(readFileSync(fxPath, 'utf-8'));
      const report = await runAnswerEval(fx, { sample: 1 });

      const m = report.cases[0];
      expect(m.case_id).toBe('database-choice-factual');
      expect(m.citation_hallucination_rate).toBe(0);
      expect(m.forbidden_fact_rate).toBe(0);
      expect(m.answer_fact_coverage).toBeGreaterThanOrEqual(0.5);
    },
    120_000,
  );
});
