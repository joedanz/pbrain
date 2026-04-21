/**
 * Tests for src/core/eval/ingest.ts.
 *
 * Two layers:
 *   1. Unit tests with a fake judge — always run. Exercise the full runner
 *      end-to-end against a fresh in-memory PGLite, but replace the real
 *      Anthropic judge call with a deterministic stub so no API key is
 *      needed and the test is fast/hermetic.
 *   2. Integration test gated on ANTHROPIC_API_KEY — runs one real baseline
 *      fixture case against the live judge. Skips cleanly when the key is
 *      absent. Not gated on OPENAI_API_KEY because the runner forces
 *      noEmbed: true (ingest eval doesn't measure embedding quality).
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import {
  runIngestEval,
  buildPageView,
  type JudgeFn,
  type IngestEvalOpts,
} from '../src/core/eval/ingest.ts';
import type { IngestFixture } from '../src/core/eval/fixtures.ts';
import type { JudgeResult } from '../src/core/eval/judge.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';

// ─────────────────────────────────────────────────────────────────
// Judge stubs — these let unit tests exercise the runner without
// spending API tokens or needing a key. The stub signature matches
// JudgeFn (text, fact) -> Promise<JudgeResult>.
// ─────────────────────────────────────────────────────────────────

const yesJudge: JudgeFn = async (_text, _fact) => ({
  verdict: 'yes',
  reason: 'stub',
  judge_model: 'stub-judge',
  tokens_in: 10,
  tokens_out: 5,
});

const noJudge: JudgeFn = async (_text, _fact) => ({
  verdict: 'no',
  reason: 'stub',
  judge_model: 'stub-judge',
  tokens_in: 10,
  tokens_out: 5,
});

/**
 * Judge that says YES to facts whose first 8 chars appear in the text
 * verbatim (crude but deterministic). Good enough to simulate
 * "ingest captured the obvious stuff, missed the hard stuff" without
 * hand-writing a per-test verdict table.
 */
const substringJudge: JudgeFn = async (text, fact) => {
  const needle = fact.slice(0, 8).toLowerCase();
  const match = text.toLowerCase().includes(needle);
  return {
    verdict: match ? 'yes' : 'no',
    reason: match ? 'substring match' : 'substring miss',
    judge_model: 'stub-substring',
    tokens_in: 20,
    tokens_out: 8,
  };
};

// ─────────────────────────────────────────────────────────────────
// Minimal inline fixture — used across most unit tests
// ─────────────────────────────────────────────────────────────────

const inlineFixture = (cases: IngestFixture['cases']): IngestFixture => ({
  version: 1,
  kind: 'ingest',
  meta: { source_type: 'markdown' },
  cases,
});

const buildCase = (overrides: Partial<IngestFixture['cases'][number]> = {}): IngestFixture['cases'][number] => ({
  id: 'unit-case',
  source: {
    type: 'markdown',
    content: [
      '---',
      'slug: decisions/pg-choice',
      'type: decision',
      'title: PG Choice',
      '---',
      '# PG Choice',
      '',
      'We chose Postgres with pgvector as the production engine. The decision ',
      'was made on 2026-02-14 after evaluating SQLite and DuckDB. Primary ',
      'reason is pgvector gives HNSW vector search plus Postgres features in ',
      'one system.',
      '',
    ].join('\n'),
  },
  expected_pages: [{ slug: 'decisions/pg-choice', type: 'decision' }],
  required_facts: [
    { fact: 'Chose Postgres with pgvector' },
    { fact: 'Decision made on 2026-02-14' },
  ],
  forbidden_facts: [
    { fact: 'Chose SQLite' },
  ],
  forbidden_pages: [],
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────
// Runner unit tests (fake judge)
// ─────────────────────────────────────────────────────────────────

describe('runIngestEval — fact_union_recall', () => {
  test('all facts YES → fact_union_recall = 1.0', async () => {
    const fixture = inlineFixture([buildCase()]);
    const report = await runIngestEval(fixture, { judgeFn: yesJudge });

    expect(report.cases).toHaveLength(1);
    const m = report.cases[0];
    expect(m.import_error).toBeUndefined();
    expect(m.fact_union_recall).toBe(1.0);
    expect(m.fact_hits).toBe(2);
    expect(m.fact_total).toBe(2);
    expect(m.forbidden_fact_rate).toBe(1.0); // yesJudge also says YES to forbidden → flagged
    expect(report.mean.fact_union_recall).toBe(1.0);
  });

  test('all facts NO → fact_union_recall = 0', async () => {
    const fixture = inlineFixture([buildCase()]);
    const report = await runIngestEval(fixture, { judgeFn: noJudge });

    expect(report.cases[0].fact_union_recall).toBe(0);
    expect(report.cases[0].forbidden_fact_rate).toBe(0); // noJudge is safe on forbidden too
  });

  test('substring judge reports partial recall when fact wording drifts', async () => {
    const fixture = inlineFixture([buildCase({
      required_facts: [
        { fact: 'We chose' },   // matches first 8 chars in body → YES
        { fact: 'Zzzzzzzzzzzzz' },   // no substring match → NO
      ],
    })]);
    const report = await runIngestEval(fixture, { judgeFn: substringJudge });
    expect(report.cases[0].fact_hits).toBe(1);
    expect(report.cases[0].fact_total).toBe(2);
    expect(report.cases[0].fact_union_recall).toBe(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────
// Forbidden fact and forbidden page guards
// ─────────────────────────────────────────────────────────────────

describe('runIngestEval — forbidden facts', () => {
  test('forbidden_fact_rate = 0 when judge rejects all forbidden facts', async () => {
    const fixture = inlineFixture([buildCase({
      forbidden_facts: [{ fact: 'Chose SQLite' }, { fact: 'Chose DuckDB' }],
    })]);
    const report = await runIngestEval(fixture, { judgeFn: noJudge });
    expect(report.cases[0].forbidden_fact_rate).toBe(0);
    expect(report.cases[0].forbidden_fact_hits).toBe(0);
    expect(report.cases[0].forbidden_fact_total).toBe(2);
  });

  test('page_scope on forbidden_fact: null scope → union view; unknown scope → skip', async () => {
    let captured = 0;
    const spyJudge: JudgeFn = async (_t, _f) => {
      captured++;
      return { verdict: 'no', reason: '', judge_model: 'stub' };
    };
    const fixture = inlineFixture([buildCase({
      required_facts: [{ fact: 'x' }],
      forbidden_facts: [
        { fact: 'a', page_scope: null },
        { fact: 'b', page_scope: 'decisions/pg-choice' },  // exists → judged
        { fact: 'c', page_scope: 'decisions/does-not-exist' },  // missing → skipped
      ],
    })]);
    await runIngestEval(fixture, { judgeFn: spyJudge });
    // 1 required + 2 forbidden judged (the third skipped) = 3 judge calls
    expect(captured).toBe(3);
  });
});

describe('runIngestEval — forbidden pages', () => {
  test('forbidden_page_rate = 0 when the blocked slug is not created', async () => {
    const fixture = inlineFixture([buildCase({
      forbidden_pages: ['people/unrelated-person'],
    })]);
    const report = await runIngestEval(fixture, { judgeFn: yesJudge });
    expect(report.cases[0].forbidden_page_rate).toBe(0);
    expect(report.cases[0].forbidden_pages_hit).toEqual([]);
  });

  test('forbidden_page_rate = 1 when the blocked slug equals the imported page', async () => {
    const fixture = inlineFixture([buildCase({
      forbidden_pages: ['decisions/pg-choice'],   // same as the slug we're importing
    })]);
    const report = await runIngestEval(fixture, { judgeFn: noJudge });
    expect(report.cases[0].forbidden_page_rate).toBe(1);
    expect(report.cases[0].forbidden_pages_hit).toEqual(['decisions/pg-choice']);
  });
});

// ─────────────────────────────────────────────────────────────────
// Error paths: malformed fixture, import failure
// ─────────────────────────────────────────────────────────────────

describe('runIngestEval — error paths', () => {
  test('empty expected_pages reports fixture error, does not crash', async () => {
    const fixture = inlineFixture([buildCase({ expected_pages: [] })]);
    const report = await runIngestEval(fixture, { judgeFn: yesJudge });
    expect(report.cases[0].import_error).toMatch(/expected_pages/);
    expect(report.cases[0].fact_union_recall).toBe(0);
  });

  test('unreadable path reports import error', async () => {
    const fixture = inlineFixture([buildCase({
      source: { type: 'markdown', path: '/tmp/does-not-exist-pbrain-ingest-eval.md' },
    })]);
    const report = await runIngestEval(fixture, { judgeFn: yesJudge });
    expect(report.cases[0].import_error).toMatch(/source content unreadable/);
  });
});

// ─────────────────────────────────────────────────────────────────
// Sample slicing, totals aggregation
// ─────────────────────────────────────────────────────────────────

describe('runIngestEval — sample + aggregation', () => {
  test('sample N limits the number of cases run', async () => {
    const fixture = inlineFixture([
      buildCase({ id: 'a' }),
      buildCase({ id: 'b' }),
      buildCase({ id: 'c' }),
    ]);
    const report = await runIngestEval(fixture, { judgeFn: yesJudge, sample: 2 });
    expect(report.cases).toHaveLength(2);
    expect(report.cases.map(c => c.case_id)).toEqual(['a', 'b']);
  });

  test('totals aggregate across cases', async () => {
    const fixture = inlineFixture([buildCase(), buildCase({ id: 'case-2' })]);
    const report = await runIngestEval(fixture, { judgeFn: yesJudge });
    // 2 required + 1 forbidden per case = 3 judge calls per case × 2 cases
    expect(report.totals.judge_calls).toBe(6);
    // yesJudge stub returns tokens_in=10, tokens_out=5 per call
    expect(report.totals.tokens_in).toBe(60);
    expect(report.totals.tokens_out).toBe(30);
  });
});

// ─────────────────────────────────────────────────────────────────
// buildPageView — rendered judge input
// ─────────────────────────────────────────────────────────────────

describe('buildPageView', () => {
  test('renders title, slug, type, compiled_truth, timeline, frontmatter', async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      await importFromContent(engine, 'decisions/x', [
        '---',
        'slug: decisions/x',
        'type: decision',
        'title: Example Decision',
        'authors: [joe]',
        '---',
        '# Example Decision',
        '',
        'Body content with a claim.',
        '',
        '## Timeline',
        '- **2026-02-14** | decision — Chose option A',
      ].join('\n'), { noEmbed: true });

      const view = await buildPageView(engine, 'decisions/x');
      expect(view).toContain('Example Decision');
      expect(view).toContain('decisions/x');
      expect(view).toContain('type: decision');
      expect(view).toContain('Body content with a claim');
      expect(view).toContain('2026-02-14');
    } finally {
      await engine.disconnect();
    }
  });

  test('returns empty string for a missing slug', async () => {
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      expect(await buildPageView(engine, 'does/not/exist')).toBe('');
    } finally {
      await engine.disconnect();
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Layer 2: real-judge integration, gated on ANTHROPIC_API_KEY
// ─────────────────────────────────────────────────────────────────

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
const describeReal = hasKey ? describe : describe.skip;

describeReal('runIngestEval — real judge integration', () => {
  test('baseline ADR case hits fact_union_recall >= 0.8', async () => {
    const fixturePath = join('test', 'fixtures', 'eval', 'ingest', 'baseline', 'baseline.json');
    if (!existsSync(fixturePath)) {
      // Defensive: the fixture ships in this PR, but skip instead of crashing
      // if someone deleted it locally.
      return;
    }
    const raw = readFileSync(fixturePath, 'utf-8');
    const fixture = JSON.parse(raw) as IngestFixture;
    // Take just the first case; the full run is too slow for CI.
    const single = { ...fixture, cases: [fixture.cases[0]] };

    const opts: IngestEvalOpts = {
      baseDir: dirname(fixturePath),
      noEmbed: true,
    };
    const report = await runIngestEval(single, opts);
    const m = report.cases[0];

    expect(m.import_error).toBeUndefined();
    expect(m.fact_union_recall).toBeGreaterThanOrEqual(0.8);
    expect(m.forbidden_fact_rate).toBe(0);
  }, 120_000);
});
