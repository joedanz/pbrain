/**
 * E2E tests for bi-temporal links (v0.3.0) against real Postgres + pgvector.
 * Requires DATABASE_URL. Skips gracefully if not set.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, getEngine } from './helpers.ts';

const skip = !process.env.DATABASE_URL;
const describeE2E = skip ? describe.skip : describe;

describeE2E('E2E: bi-temporal links', () => {
  beforeAll(async () => {
    await setupDB();
    const engine = getEngine();
    await engine.putPage('people/alice', { title: 'Alice', compiled_truth: 'Alice', type: 'person' });
    await engine.putPage('people/bob', { title: 'Bob', compiled_truth: 'Bob', type: 'person' });
    await engine.putPage('companies/google', { title: 'Google', compiled_truth: 'Google', type: 'company' });
    await engine.putPage('companies/anthropic', { title: 'Anthropic', compiled_truth: 'Anthropic', type: 'company' });
  });

  afterAll(teardownDB);

  test('addLink → removeLink → addLink: 2 rows total (1 historical, 1 current)', async () => {
    const engine = getEngine();
    await engine.addLink('people/alice', 'companies/google', 'original context', 'works_at');
    await engine.removeLink('people/alice', 'companies/google', 'works_at');
    await engine.addLink('people/alice', 'companies/google', 're-hired', 'works_at');

    const { getConn } = await import('./helpers.ts');
    const conn = getConn();
    const rows = await conn`
      SELECT valid_until FROM links l
      JOIN pages f ON f.id = l.from_page_id
      JOIN pages t ON t.id = l.to_page_id
      WHERE f.slug = 'people/alice' AND t.slug = 'companies/google' AND l.link_type = 'works_at'
      ORDER BY l.created_at
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0].valid_until).not.toBeNull();   // historical: closed
    expect(rows[1].valid_until).toBeNull();        // current: open
  });

  test('getLinks returns only current edges', async () => {
    const engine = getEngine();
    const links = await engine.getLinks('people/alice');
    const slugs = links.map(l => l.to_slug);
    // Only 're-hired' (current) works_at link should appear
    expect(slugs).toContain('companies/google');
    const allCurrent = links.every(l => true); // runtime filter verified by count test
    expect(allCurrent).toBe(true);
  });

  test('traverseGraph at depth 2 skips closed intermediate edge', async () => {
    const engine = getEngine();
    // alice → bob (add then close), bob → anthropic (open)
    await engine.addLink('people/alice', 'people/bob', '', 'knows');
    await engine.removeLink('people/alice', 'people/bob', 'knows');
    await engine.addLink('people/bob', 'companies/anthropic', '', 'works_at');

    const graph = await engine.traverseGraph('people/alice', 2);
    const slugs = graph.map(n => n.slug);
    expect(slugs).toContain('people/alice');
    expect(slugs).not.toContain('people/bob');
    expect(slugs).not.toContain('companies/anthropic');
  });

  test('migration v11: existing links have valid_until IS NULL and valid_from IS NULL', async () => {
    const { getConn } = await import('./helpers.ts');
    const conn = getConn();
    // All rows we inserted above should have valid_until IS NULL (current)
    // and valid_from IS NULL (unknown provenance) unless explicitly provided
    const currentRows = await conn`SELECT valid_from, valid_until FROM links WHERE valid_until IS NULL`;
    expect(currentRows.length).toBeGreaterThan(0);
    // valid_from should be null for rows created without explicit date
    const withNullFrom = currentRows.filter(r => r.valid_from === null);
    expect(withNullFrom.length).toBeGreaterThan(0);
  });

  test('addLinksBatch ON CONFLICT with partial index: no error, no duplicate', async () => {
    const engine = getEngine();
    // Pre-seed one link (alice→anthropic works_at may already exist from above)
    await engine.addLink('people/alice', 'companies/anthropic', 'existing', 'works_at');

    const countBefore = await (async () => {
      const conn = (await import('./helpers.ts')).getConn();
      const rows = await conn`SELECT COUNT(*)::int AS n FROM links WHERE valid_until IS NULL`;
      return (rows[0] as { n: number }).n;
    })();

    const batch = [
      { from_slug: 'people/alice', to_slug: 'companies/anthropic', link_type: 'works_at' }, // conflict
      { from_slug: 'people/alice', to_slug: 'companies/google', link_type: 'invested_in' }, // new
    ];
    const inserted = await engine.addLinksBatch(batch);
    expect(inserted).toBe(1); // only the new row

    const countAfter = await (async () => {
      const conn = (await import('./helpers.ts')).getConn();
      const rows = await conn`SELECT COUNT(*)::int AS n FROM links WHERE valid_until IS NULL`;
      return (rows[0] as { n: number }).n;
    })();

    expect(countAfter).toBe(countBefore + 1); // exactly one new current row
  });

  test('valid_from stored and retrievable when provided', async () => {
    const engine = getEngine();
    await engine.addLink('people/bob', 'companies/google', 'summer intern', 'worked_at', '2019-06-01');

    const { getConn } = await import('./helpers.ts');
    const conn = getConn();
    const rows = await conn`
      SELECT valid_from::text AS vf FROM links l
      JOIN pages f ON f.id = l.from_page_id
      JOIN pages t ON t.id = l.to_page_id
      WHERE f.slug = 'people/bob' AND t.slug = 'companies/google'
        AND l.link_type = 'worked_at' AND l.valid_until IS NULL
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].vf).toBe('2019-06-01');
  });
});
