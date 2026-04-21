/**
 * Unit tests for src/core/eval/fixtures.ts — envelope parsing + per-kind validation.
 * No API keys, no DB. Just input/output on synthetic JSON.
 */

import { describe, test, expect } from 'bun:test';
import {
  parseFixture,
  validateEnvelope,
  CURRENT_FIXTURE_VERSION,
  FixtureParseError,
  type IngestFixture,
  type RetrievalFixture,
  type AnswerFixture,
} from '../src/core/eval/fixtures.ts';

// ─────────────────────────────────────────────────────────────────
// Version rejection — the forward-compat guard the reviewers called out
// ─────────────────────────────────────────────────────────────────

describe('envelope — version rejection', () => {
  test('current version is 1', () => {
    expect(CURRENT_FIXTURE_VERSION).toBe(1);
  });

  test('rejects version 2 loudly (not silent accept-with-missing-fields)', () => {
    expect(() => validateEnvelope({
      version: 2, kind: 'retrieval', meta: {}, cases: [],
    })).toThrow(FixtureParseError);
  });

  test('rejects missing version', () => {
    expect(() => validateEnvelope({ kind: 'retrieval', meta: {}, cases: [] })).toThrow();
  });

  test('rejects string version', () => {
    expect(() => validateEnvelope({ version: '1', kind: 'retrieval', meta: {}, cases: [] })).toThrow();
  });

  test('rejects unknown kind', () => {
    expect(() => validateEnvelope({ version: 1, kind: 'consolidation', meta: {}, cases: [] })).toThrow();
  });

  test('rejects non-object root (array, null, scalar)', () => {
    expect(() => validateEnvelope([])).toThrow();
    expect(() => validateEnvelope(null)).toThrow();
    expect(() => validateEnvelope('hello')).toThrow();
  });

  test('rejects non-array cases', () => {
    expect(() => validateEnvelope({
      version: 1, kind: 'retrieval', meta: {}, cases: 'not an array',
    })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────
// Retrieval cases
// ─────────────────────────────────────────────────────────────────

describe('retrieval cases', () => {
  test('valid minimal case', () => {
    const env = validateEnvelope({
      version: 1, kind: 'retrieval', meta: {},
      cases: [{ query: 'who founded novamind', relevant: ['people/alice'] }],
    }) as RetrievalFixture;
    expect(env.cases[0].query).toBe('who founded novamind');
    expect(env.cases[0].relevant).toEqual(['people/alice']);
    expect(env.cases[0].grades).toBeUndefined();
  });

  test('with graded relevance', () => {
    const env = validateEnvelope({
      version: 1, kind: 'retrieval', meta: {},
      cases: [{
        query: 'q', relevant: ['a', 'b'],
        grades: { a: 3, b: 1 },
      }],
    }) as RetrievalFixture;
    expect(env.cases[0].grades).toEqual({ a: 3, b: 1 });
  });

  test('rejects non-numeric grades', () => {
    expect(() => validateEnvelope({
      version: 1, kind: 'retrieval', meta: {},
      cases: [{ query: 'q', relevant: ['a'], grades: { a: 'three' } }],
    })).toThrow();
  });

  test('rejects missing query', () => {
    expect(() => validateEnvelope({
      version: 1, kind: 'retrieval', meta: {},
      cases: [{ relevant: ['a'] }],
    })).toThrow();
  });

  test('rejects non-string relevant array item', () => {
    expect(() => validateEnvelope({
      version: 1, kind: 'retrieval', meta: {},
      cases: [{ query: 'q', relevant: ['a', 42] }],
    })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────
// Ingest cases — most complex shape
// ─────────────────────────────────────────────────────────────────

describe('ingest cases', () => {
  const minimalIngest = {
    version: 1, kind: 'ingest', meta: { source_type: 'markdown' },
    cases: [{
      id: 'adr-001',
      source: { type: 'markdown', content: 'inline doc body' },
      expected_pages: [{ slug: 'decisions/adr-001', type: 'decision' }],
      required_facts: [{ fact: 'Chose Postgres', fact_type: 'narrative' }],
    }],
  };

  test('valid minimal case with inline content', () => {
    const env = validateEnvelope(minimalIngest) as IngestFixture;
    expect(env.cases[0].id).toBe('adr-001');
    expect(env.cases[0].source.type).toBe('markdown');
    expect((env.cases[0].source as { type: 'markdown'; content: string }).content).toBe('inline doc body');
    expect(env.cases[0].required_facts[0].fact_type).toBe('narrative');
  });

  test('valid case with path source (file existence not checked here)', () => {
    const env = validateEnvelope({
      ...minimalIngest,
      cases: [{
        ...minimalIngest.cases[0],
        source: { type: 'markdown', path: './nonexistent.md' },
      }],
    }) as IngestFixture;
    expect((env.cases[0].source as { type: 'markdown'; path: string }).path).toBe('./nonexistent.md');
  });

  test('rejects both path AND content — must be exactly one', () => {
    expect(() => validateEnvelope({
      ...minimalIngest,
      cases: [{
        ...minimalIngest.cases[0],
        source: { type: 'markdown', path: './x.md', content: 'inline' },
      }],
    })).toThrow();
  });

  test('rejects neither path nor content', () => {
    expect(() => validateEnvelope({
      ...minimalIngest,
      cases: [{
        ...minimalIngest.cases[0],
        source: { type: 'markdown' },
      }],
    })).toThrow();
  });

  test('rejects non-markdown source types in v0.4.0', () => {
    expect(() => validateEnvelope({
      ...minimalIngest,
      cases: [{
        ...minimalIngest.cases[0],
        source: { type: 'transcript', content: 'hello' },
      }],
    })).toThrow(/markdown/);
  });

  test('rejects invalid fact_type enum', () => {
    expect(() => validateEnvelope({
      ...minimalIngest,
      cases: [{
        ...minimalIngest.cases[0],
        required_facts: [{ fact: 'x', fact_type: 'frontmatter' }],
      }],
    })).toThrow(/fact_type/);
  });

  test('accepts fact without explicit fact_type', () => {
    const env = validateEnvelope({
      ...minimalIngest,
      cases: [{
        ...minimalIngest.cases[0],
        required_facts: [{ fact: 'Chose Postgres' }],
      }],
    }) as IngestFixture;
    expect(env.cases[0].required_facts[0].fact_type).toBeUndefined();
  });

  test('forbidden_facts with page_scope string', () => {
    const env = validateEnvelope({
      ...minimalIngest,
      cases: [{
        ...minimalIngest.cases[0],
        forbidden_facts: [
          { fact: 'Decision made in 2024', page_scope: null },
          { fact: 'Acquired by Microsoft', page_scope: 'decisions/adr-001' },
        ],
      }],
    }) as IngestFixture;
    expect(env.cases[0].forbidden_facts?.[0].page_scope).toBeNull();
    expect(env.cases[0].forbidden_facts?.[1].page_scope).toBe('decisions/adr-001');
  });

  test('expected_links fully specified', () => {
    const env = validateEnvelope({
      ...minimalIngest,
      cases: [{
        ...minimalIngest.cases[0],
        expected_links: [
          { from: 'decisions/adr-001', to: 'concepts/pgvector', type: 'references' },
        ],
      }],
    }) as IngestFixture;
    expect(env.cases[0].expected_links?.[0].type).toBe('references');
  });

  test('rejects expected_link with missing field', () => {
    expect(() => validateEnvelope({
      ...minimalIngest,
      cases: [{
        ...minimalIngest.cases[0],
        expected_links: [{ from: 'a', to: 'b' }], // missing type
      }],
    })).toThrow(/expected_links/);
  });

  test('forbidden_pages must be string array', () => {
    const env = validateEnvelope({
      ...minimalIngest,
      cases: [{
        ...minimalIngest.cases[0],
        forbidden_pages: ['companies/microsoft'],
      }],
    }) as IngestFixture;
    expect(env.cases[0].forbidden_pages).toEqual(['companies/microsoft']);
  });

  test('rejects missing case.id', () => {
    expect(() => validateEnvelope({
      ...minimalIngest,
      cases: [{ ...minimalIngest.cases[0], id: undefined }],
    })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────
// Answer cases
// ─────────────────────────────────────────────────────────────────

describe('answer cases', () => {
  const minimalAnswer = {
    version: 1, kind: 'answer', meta: {},
    cases: [{
      id: 'db-choice',
      query: 'What database for the pipeline?',
      required_answer_facts: ['Chose Postgres with pgvector'],
    }],
  };

  test('valid minimal case', () => {
    const env = validateEnvelope(minimalAnswer) as AnswerFixture;
    expect(env.cases[0].id).toBe('db-choice');
    expect(env.cases[0].expected_refusal).toBeUndefined();
  });

  test('full case with citations + refusal + forbidden', () => {
    const env = validateEnvelope({
      ...minimalAnswer,
      cases: [{
        ...minimalAnswer.cases[0],
        forbidden_answer_facts: ['Chose SQLite'],
        required_citations: ['decisions/adr-001'],
        forbidden_citations: ['companies/microsoft'],
        expected_refusal: false,
      }],
    }) as AnswerFixture;
    expect(env.cases[0].forbidden_answer_facts).toEqual(['Chose SQLite']);
    expect(env.cases[0].required_citations).toEqual(['decisions/adr-001']);
    expect(env.cases[0].expected_refusal).toBe(false);
  });

  test('coerces truthy expected_refusal to boolean', () => {
    const env = validateEnvelope({
      ...minimalAnswer,
      cases: [{ ...minimalAnswer.cases[0], expected_refusal: 1 }],
    }) as AnswerFixture;
    expect(env.cases[0].expected_refusal).toBe(true);
  });

  test('rejects non-string required_answer_facts entry', () => {
    expect(() => validateEnvelope({
      ...minimalAnswer,
      cases: [{ ...minimalAnswer.cases[0], required_answer_facts: ['ok', 42] }],
    })).toThrow();
  });

  test('rejects missing query', () => {
    expect(() => validateEnvelope({
      ...minimalAnswer,
      cases: [{ id: 'x', required_answer_facts: ['fact'] }],
    })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────
// parseFixture — inline JSON path (file path exercised by integration tests)
// ─────────────────────────────────────────────────────────────────

describe('parseFixture — inline JSON', () => {
  test('parses inline JSON starting with {', () => {
    const json = JSON.stringify({
      version: 1, kind: 'retrieval', meta: {},
      cases: [{ query: 'x', relevant: ['a'] }],
    });
    const env = parseFixture(json);
    expect(env.kind).toBe('retrieval');
  });

  test('parses inline JSON with leading whitespace', () => {
    const json = '\n  ' + JSON.stringify({
      version: 1, kind: 'retrieval', meta: {}, cases: [],
    });
    const env = parseFixture(json);
    expect(env.cases).toEqual([]);
  });

  test('throws on invalid JSON with helpful message', () => {
    expect(() => parseFixture('{ not json }')).toThrow(FixtureParseError);
  });

  test('throws on file-not-found when input looks like a path', () => {
    expect(() => parseFixture('/tmp/does-not-exist-pbrain-eval.json')).toThrow(/file not found/);
  });
});
