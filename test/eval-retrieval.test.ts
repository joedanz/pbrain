/**
 * Unit tests for src/core/eval/retrieval.ts — the thin adapter that converts
 * a v0.4 retrieval fixture envelope into the EvalQrel[] shape runEval() expects.
 *
 * The adapter is deliberately small so these tests are narrow too:
 *   - correct unwrap (kind=retrieval → EvalQrel[])
 *   - loud rejection when the envelope is a different kind
 *   - FixtureParseError propagation on malformed input
 *   - field alignment with EvalQrel (id / query / relevant / grades)
 *
 * End-to-end search-quality behavior for the retrieval stage is covered by
 * test/e2e/search-quality.test.ts — not duplicated here.
 */

import { describe, test, expect } from 'bun:test';
import { loadRetrievalFixture } from '../src/core/eval/retrieval.ts';
import { FixtureParseError } from '../src/core/eval/fixtures.ts';

// ─────────────────────────────────────────────────────────────────
// Adapter: envelope → EvalQrel[]
// ─────────────────────────────────────────────────────────────────

describe('loadRetrievalFixture — envelope unwrap', () => {
  test('returns EvalQrel[] from a well-formed retrieval envelope', () => {
    const env = JSON.stringify({
      version: 1,
      kind: 'retrieval',
      meta: { description: 'baseline' },
      cases: [
        { query: 'who founded novamind', relevant: ['people/alice'] },
        { id: 'q-2', query: 'adr database choice', relevant: ['decisions/adr-001'], grades: { 'decisions/adr-001': 3 } },
      ],
    });

    const qrels = loadRetrievalFixture(env);

    expect(qrels).toHaveLength(2);
    expect(qrels[0].query).toBe('who founded novamind');
    expect(qrels[0].relevant).toEqual(['people/alice']);
    expect(qrels[0].grades).toBeUndefined();
    expect(qrels[1].id).toBe('q-2');
    expect(qrels[1].grades).toEqual({ 'decisions/adr-001': 3 });
  });

  test('preserves empty cases array (legal — curator may ship an empty fixture scaffold)', () => {
    const env = JSON.stringify({
      version: 1, kind: 'retrieval', meta: {}, cases: [],
    });
    expect(loadRetrievalFixture(env)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────
// Kind mismatch — loud rejection with a helpful pointer
// ─────────────────────────────────────────────────────────────────

describe('loadRetrievalFixture — wrong kind', () => {
  test('rejects kind=ingest with a pointer to the right subcommand', () => {
    const env = JSON.stringify({
      version: 1, kind: 'ingest',
      meta: { source_type: 'markdown' },
      cases: [{
        id: 'x',
        source: { type: 'markdown', content: 'body' },
        expected_pages: [{ slug: 'decisions/x' }],
        required_facts: [{ fact: 'a' }],
      }],
    });
    expect(() => loadRetrievalFixture(env)).toThrow(FixtureParseError);
    expect(() => loadRetrievalFixture(env)).toThrow(/kind=ingest/);
    expect(() => loadRetrievalFixture(env)).toThrow(/pbrain eval ingest/);
  });

  test('rejects kind=answer with a pointer to the right subcommand', () => {
    const env = JSON.stringify({
      version: 1, kind: 'answer', meta: {},
      cases: [{ id: 'x', query: 'q', required_answer_facts: ['a'] }],
    });
    expect(() => loadRetrievalFixture(env)).toThrow(/kind=answer/);
    expect(() => loadRetrievalFixture(env)).toThrow(/pbrain eval answer/);
  });
});

// ─────────────────────────────────────────────────────────────────
// FixtureParseError propagation
// ─────────────────────────────────────────────────────────────────

describe('loadRetrievalFixture — malformed input', () => {
  test('propagates version-mismatch FixtureParseError', () => {
    const env = JSON.stringify({ version: 2, kind: 'retrieval', meta: {}, cases: [] });
    expect(() => loadRetrievalFixture(env)).toThrow(FixtureParseError);
    expect(() => loadRetrievalFixture(env)).toThrow(/version/);
  });

  test('propagates invalid-JSON FixtureParseError', () => {
    expect(() => loadRetrievalFixture('{ not json }')).toThrow(FixtureParseError);
  });

  test('propagates missing-relevant field error from per-case validator', () => {
    const env = JSON.stringify({
      version: 1, kind: 'retrieval', meta: {},
      cases: [{ query: 'q' }], // missing relevant
    });
    expect(() => loadRetrievalFixture(env)).toThrow(FixtureParseError);
  });
});

// ─────────────────────────────────────────────────────────────────
// Field alignment — sanity that RetrievalCase → EvalQrel doesn't drop fields
// ─────────────────────────────────────────────────────────────────

describe('loadRetrievalFixture — field alignment with EvalQrel', () => {
  test('carries id, query, relevant, grades through unchanged', () => {
    const env = JSON.stringify({
      version: 1, kind: 'retrieval', meta: {},
      cases: [{
        id: 'full-case',
        query: 'adr database choice',
        relevant: ['decisions/adr-001', 'concepts/pgvector'],
        grades: { 'decisions/adr-001': 3, 'concepts/pgvector': 1 },
      }],
    });

    const [q] = loadRetrievalFixture(env);

    expect(q.id).toBe('full-case');
    expect(q.query).toBe('adr database choice');
    expect(q.relevant).toEqual(['decisions/adr-001', 'concepts/pgvector']);
    expect(q.grades).toEqual({ 'decisions/adr-001': 3, 'concepts/pgvector': 1 });
  });

  test('omits optional fields cleanly when absent', () => {
    const env = JSON.stringify({
      version: 1, kind: 'retrieval', meta: {},
      cases: [{ query: 'q', relevant: ['a'] }],
    });
    const [q] = loadRetrievalFixture(env);
    expect(q.id).toBeUndefined();
    expect(q.grades).toBeUndefined();
  });
});
