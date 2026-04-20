/**
 * Unit tests for bi-temporal link semantics (v0.3.0).
 * Runs against PGLite (in-memory, no external DB required).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { EngineConfig } from '../src/core/types.ts';

const config: EngineConfig = { engine: 'pglite' };
let engine: PGLiteEngine;

async function truncateLinks() {
  await (engine as unknown as { db: { query: (s: string) => Promise<unknown> } }).db.query(
    'DELETE FROM links'
  );
}

async function countLinks(): Promise<number> {
  const e = engine as unknown as { db: { query: (s: string) => Promise<{ rows: unknown[] }> } };
  const { rows } = await e.db.query('SELECT COUNT(*)::int AS n FROM links');
  return (rows[0] as { n: number }).n;
}

async function countCurrentLinks(): Promise<number> {
  const e = engine as unknown as { db: { query: (s: string) => Promise<{ rows: unknown[] }> } };
  const { rows } = await e.db.query('SELECT COUNT(*)::int AS n FROM links WHERE valid_until IS NULL');
  return (rows[0] as { n: number }).n;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect(config);
  await engine.initSchema();
  // Seed two pages used across tests
  await engine.putPage('people/alice', { title: 'Alice', compiled_truth: 'Alice', type: 'person' });
  await engine.putPage('people/bob', { title: 'Bob', compiled_truth: 'Bob', type: 'person' });
  await engine.putPage('companies/google', { title: 'Google', compiled_truth: 'Google', type: 'company' });
  await engine.putPage('companies/anthropic', { title: 'Anthropic', compiled_truth: 'Anthropic', type: 'company' });
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await truncateLinks();
});

describe('addLink — bi-temporal basics', () => {
  test('creates row with valid_until IS NULL', async () => {
    await engine.addLink('people/alice', 'companies/google', 'works at', 'works_at');
    const links = await engine.getLinks('people/alice');
    expect(links).toHaveLength(1);
    expect(links[0].to_slug).toBe('companies/google');
    expect(await countLinks()).toBe(1);
    expect(await countCurrentLinks()).toBe(1);
  });

  test('same context twice → 1 row (upsert, no duplicate)', async () => {
    await engine.addLink('people/alice', 'companies/google', 'works at', 'works_at');
    await engine.addLink('people/alice', 'companies/google', 'works at', 'works_at');
    expect(await countLinks()).toBe(1);
    expect(await countCurrentLinks()).toBe(1);
  });

  test('changed context twice → 1 current row (context updated in place)', async () => {
    await engine.addLink('people/alice', 'companies/google', 'works at', 'works_at');
    await engine.addLink('people/alice', 'companies/google', 'leads AI team', 'works_at');
    expect(await countLinks()).toBe(1);
    expect(await countCurrentLinks()).toBe(1);
    const links = await engine.getLinks('people/alice');
    expect(links[0].context).toBe('leads AI team');
  });

  test('valid_from is stored when provided', async () => {
    await engine.addLink('people/alice', 'companies/google', '', 'works_at', '2020-01-15');
    const e = engine as unknown as { db: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> } };
    const { rows } = await e.db.query(
      `SELECT valid_from::text AS vf FROM links WHERE valid_until IS NULL LIMIT 1`
    );
    expect((rows[0] as { vf: string }).vf).toBe('2020-01-15');
  });
});

describe('removeLink — soft delete', () => {
  test('sets valid_until, does not delete row', async () => {
    await engine.addLink('people/alice', 'companies/google', '', 'works_at');
    await engine.removeLink('people/alice', 'companies/google');
    expect(await countLinks()).toBe(1);          // row preserved
    expect(await countCurrentLinks()).toBe(0);   // no longer current
  });

  test('getLinks after removeLink returns 0 results', async () => {
    await engine.addLink('people/alice', 'companies/google', '', 'works_at');
    await engine.removeLink('people/alice', 'companies/google');
    const links = await engine.getLinks('people/alice');
    expect(links).toHaveLength(0);
  });

  test('getBacklinks after removeLink returns 0 results', async () => {
    await engine.addLink('people/alice', 'companies/google', '', 'works_at');
    await engine.removeLink('people/alice', 'companies/google');
    const backlinks = await engine.getBacklinks('companies/google');
    expect(backlinks).toHaveLength(0);
  });

  test('removeLink with no linkType closes all types (empty string normalised to undefined)', async () => {
    await engine.addLink('people/alice', 'companies/google', '', 'works_at');
    await engine.addLink('people/alice', 'companies/google', '', 'invested_in');
    expect(await countCurrentLinks()).toBe(2);
    await engine.removeLink('people/alice', 'companies/google', '');
    expect(await countCurrentLinks()).toBe(0);
    expect(await countLinks()).toBe(2); // both rows preserved as history
  });

  test('removeLink with specific linkType closes only that type', async () => {
    await engine.addLink('people/alice', 'companies/google', '', 'works_at');
    await engine.addLink('people/alice', 'companies/google', '', 'invested_in');
    await engine.removeLink('people/alice', 'companies/google', 'works_at');
    expect(await countCurrentLinks()).toBe(1);
    const links = await engine.getLinks('people/alice');
    expect(links[0].link_type).toBe('invested_in');
  });
});

describe('addLink after removeLink — re-open', () => {
  test('re-adding a removed link creates new current row alongside history', async () => {
    await engine.addLink('people/alice', 'companies/google', 'original', 'works_at');
    await engine.removeLink('people/alice', 'companies/google', 'works_at');
    await engine.addLink('people/alice', 'companies/google', 're-hired', 'works_at');
    expect(await countLinks()).toBe(2);           // 1 historical + 1 current
    expect(await countCurrentLinks()).toBe(1);
    const links = await engine.getLinks('people/alice');
    expect(links[0].context).toBe('re-hired');
  });
});

describe('traverseGraph — only follows current edges', () => {
  test('closed edge is not traversed', async () => {
    // A → B (closed), B → C (open)
    await engine.addLink('people/alice', 'people/bob', '', 'knows');
    await engine.removeLink('people/alice', 'people/bob', 'knows');
    await engine.addLink('people/bob', 'companies/google', '', 'works_at');

    const graph = await engine.traverseGraph('people/alice', 3);
    const slugs = graph.map(n => n.slug);
    expect(slugs).toContain('people/alice');
    expect(slugs).not.toContain('people/bob');      // not reachable via closed edge
    expect(slugs).not.toContain('companies/google');
  });

  test('per-node links array excludes closed edges', async () => {
    await engine.addLink('people/alice', 'companies/google', '', 'works_at');
    await engine.addLink('people/alice', 'companies/anthropic', '', 'works_at');
    await engine.removeLink('people/alice', 'companies/google', 'works_at');

    const graph = await engine.traverseGraph('people/alice', 1);
    const alice = graph.find(n => n.slug === 'people/alice');
    expect(alice).toBeDefined();
    const linkSlugs = alice!.links.map(l => l.to_slug);
    expect(linkSlugs).not.toContain('companies/google');
    expect(linkSlugs).toContain('companies/anthropic');
  });
});

describe('addLinksBatch — partial index conflict handling', () => {
  test('batch where one row exists as current link: no error, no duplicate, count = N-1', async () => {
    // Pre-seed one link
    await engine.addLink('people/alice', 'companies/google', '', 'works_at');

    const batch = [
      { from_slug: 'people/alice', to_slug: 'companies/google', link_type: 'works_at' }, // already current
      { from_slug: 'people/alice', to_slug: 'companies/anthropic', link_type: 'works_at' }, // new
    ];
    const count = await engine.addLinksBatch(batch);
    expect(count).toBe(1);                       // only new row counted
    expect(await countCurrentLinks()).toBe(2);   // alice→google (existing) + alice→anthropic (new)
    expect(await countLinks()).toBe(2);          // no duplicates
  });

  test('empty batch returns 0', async () => {
    const count = await engine.addLinksBatch([]);
    expect(count).toBe(0);
  });
});
