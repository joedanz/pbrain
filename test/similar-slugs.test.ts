/**
 * Tests for entity-resolution prevention hint.
 *
 * Two layers:
 *   - Pure scoring (scoreTails): no DB, covers the canonical dedup cases.
 *   - findSimilarEntitySlugs: against PGLite, covers directory scoping + page type.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { scoreTails, findSimilarEntitySlugs } from '../src/core/similar-slugs.ts';
import type { PageInput } from '../src/core/types.ts';

// ─────────────────────────────────────────────────────────────────
// Pure scoring
// ─────────────────────────────────────────────────────────────────

describe('scoreTails — canonical dedup cases', () => {
  test('identical tails → 1.0', () => {
    expect(scoreTails('jane-doe', 'jane-doe')).toBe(1);
  });

  test('initial expansion: "j-doe" vs "jane-doe" → 1.0 (j matches jane, doe matches doe)', () => {
    expect(scoreTails('j-doe', 'jane-doe')).toBe(1);
    expect(scoreTails('jane-doe', 'j-doe')).toBe(1);
  });

  test('dash-stripped equal: "openai" vs "open-ai" → 0.95', () => {
    expect(scoreTails('openai', 'open-ai')).toBe(0.95);
    expect(scoreTails('open-ai', 'openai')).toBe(0.95);
  });

  test('dash-stripped substring: "anthropic" vs "anthropic-pbc" → 0.85', () => {
    expect(scoreTails('anthropic', 'anthropic-pbc')).toBe(0.85);
    expect(scoreTails('anthropic-pbc', 'anthropic')).toBe(0.85);
  });

  test('comma-reversed tokens: "doe-jane" vs "jane-doe" → 1.0', () => {
    expect(scoreTails('doe-jane', 'jane-doe')).toBe(1);
  });

  test('middle initial: "jane-a-doe" vs "jane-doe" → above threshold', () => {
    const s = scoreTails('jane-a-doe', 'jane-doe');
    expect(s).toBeGreaterThanOrEqual(0.6);
  });

  test('different person same last name: "jane-doe" vs "john-doe" → below threshold', () => {
    const s = scoreTails('jane-doe', 'john-doe');
    expect(s).toBeLessThan(0.6);
  });

  test('unrelated entities: "openai" vs "anthropic" → 0', () => {
    expect(scoreTails('openai', 'anthropic')).toBe(0);
  });

  test('too-short inputs reject', () => {
    expect(scoreTails('a', 'ab')).toBe(0);
    expect(scoreTails('', 'abc')).toBe(0);
  });

  test('no common tokens: "ben-horowitz" vs "marc-andreessen" → 0', () => {
    expect(scoreTails('ben-horowitz', 'marc-andreessen')).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// findSimilarEntitySlugs (PGLite)
// ─────────────────────────────────────────────────────────────────

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function truncate() {
  await (engine as any).db.exec('DELETE FROM pages');
}

function personPage(title: string): PageInput {
  return { type: 'person', title, compiled_truth: `Profile page for ${title}.` };
}

function companyPage(title: string): PageInput {
  return { type: 'company', title, compiled_truth: `Company page for ${title}.` };
}

describe('findSimilarEntitySlugs — scoping + results', () => {
  beforeEach(truncate);

  test('surfaces existing people/jane-doe when creating people/j-doe', async () => {
    await engine.putPage('people/jane-doe', personPage('Jane Doe'));
    const hits = await findSimilarEntitySlugs(engine, 'people/j-doe');
    expect(hits).toHaveLength(1);
    expect(hits[0].slug).toBe('people/jane-doe');
    expect(hits[0].title).toBe('Jane Doe');
    expect(hits[0].overlap).toBe(1);
  });

  test('surfaces companies/open-ai when creating companies/openai', async () => {
    await engine.putPage('companies/open-ai', companyPage('Open AI'));
    const hits = await findSimilarEntitySlugs(engine, 'companies/openai');
    expect(hits).toHaveLength(1);
    expect(hits[0].slug).toBe('companies/open-ai');
  });

  test('excludes self even when slug already exists', async () => {
    await engine.putPage('people/jane-doe', personPage('Jane Doe'));
    const hits = await findSimilarEntitySlugs(engine, 'people/jane-doe');
    expect(hits).toHaveLength(0);
  });

  test('does not surface people/ when creating companies/ (cross-directory)', async () => {
    await engine.putPage('people/openai', personPage('OpenAI'));
    const hits = await findSimilarEntitySlugs(engine, 'companies/openai');
    // We query by page type 'company', so the people/ page isn't even candidate.
    expect(hits).toHaveLength(0);
  });

  test('ignores non-entity candidate slugs (concepts/, repos/, etc.)', async () => {
    await engine.putPage('people/jane-doe', personPage('Jane Doe'));
    const hits = await findSimilarEntitySlugs(engine, 'concepts/jane-doe');
    expect(hits).toHaveLength(0);
  });

  test('slugs without a directory segment return empty', async () => {
    const hits = await findSimilarEntitySlugs(engine, 'jane-doe');
    expect(hits).toHaveLength(0);
  });

  test('empty brain returns empty array', async () => {
    const hits = await findSimilarEntitySlugs(engine, 'people/someone');
    expect(hits).toHaveLength(0);
  });

  test('returns at most `limit` matches, sorted by overlap', async () => {
    await engine.putPage('people/jane-doe', personPage('Jane Doe'));
    await engine.putPage('people/jane-a-doe', personPage('Jane A. Doe'));
    await engine.putPage('people/john-doe', personPage('John Doe'));
    await engine.putPage('people/bob', personPage('Bob'));

    const hits = await findSimilarEntitySlugs(engine, 'people/j-doe', 2);
    expect(hits.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].overlap).toBeGreaterThanOrEqual(hits[i].overlap);
    }
    // The strong matches must be at the top.
    const topSlugs = hits.map(h => h.slug);
    expect(topSlugs).toContain('people/jane-doe');
  });

  test('filters out pages below overlap threshold (no false positives for unrelated people)', async () => {
    await engine.putPage('people/marc-andreessen', personPage('Marc Andreessen'));
    const hits = await findSimilarEntitySlugs(engine, 'people/ben-horowitz');
    expect(hits).toHaveLength(0);
  });
});
