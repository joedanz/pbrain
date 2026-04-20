import { describe, test, expect } from 'bun:test';
import { operations, operationsByName } from '../src/core/operations.ts';

// The deferred set is intentionally small and load-bearing. If this list changes,
// the CONTEXT_ENGINEERING doctrine + CHANGELOG should change with it.
// See docs/ethos/CONTEXT_ENGINEERING.md for per-op deferral justifications.
const EXPECTED_DEFERRED = new Set([
  'find_repo_by_url',
  'get_health',
  'get_versions',
  'revert_version',
  'sync_brain',
  'log_ingest',
  'get_ingest_log',
  'file_url',
]);

describe('Operation.agentSurface', () => {
  test('agentSurface defaults to always (unset)', () => {
    const nonDeferred = operations.filter(op => op.agentSurface !== 'deferred');
    for (const op of nonDeferred) {
      expect(op.agentSurface === undefined || op.agentSurface === 'always').toBe(true);
    }
  });

  test('exactly the expected 8 ops are tagged deferred', () => {
    const actual = new Set(
      operations.filter(op => op.agentSurface === 'deferred').map(op => op.name),
    );
    expect(actual).toEqual(EXPECTED_DEFERRED);
  });

  test('always-visible count is 24 after deferral (32 − 8)', () => {
    const alwaysVisible = operations.filter(op => op.agentSurface !== 'deferred');
    expect(alwaysVisible.length).toBe(operations.length - EXPECTED_DEFERRED.size);
    // Guard rail: stay under the BFCL 30-tool cliff.
    expect(alwaysVisible.length).toBeLessThan(30);
  });

  test('deferred ops remain registered and invokable by name', () => {
    for (const name of EXPECTED_DEFERRED) {
      const op = operationsByName[name];
      expect(op).toBeDefined();
      expect(op.name).toBe(name);
      expect(typeof op.handler).toBe('function');
    }
  });

  test('critical working-set ops stay always-visible', () => {
    // These ops are load-bearing for coding agents and MUST remain eager.
    // Regression guard: if anyone marks these deferred, the test fails loudly.
    const ALWAYS_VISIBLE = [
      'query', 'search', 'get_page', 'put_page', 'delete_page', 'list_pages',
      'add_tag', 'remove_tag', 'get_tags',
      'add_link', 'remove_link', 'get_links', 'get_backlinks', 'traverse_graph',
      'add_timeline_entry', 'get_timeline',
      'get_stats', 'resolve_slugs', 'get_chunks', 'find_orphans',
      'file_list', 'file_upload',
      'put_raw_data', 'get_raw_data',
    ];
    for (const name of ALWAYS_VISIBLE) {
      const op = operationsByName[name];
      expect(op, `${name} should be registered`).toBeDefined();
      expect(
        op.agentSurface === undefined || op.agentSurface === 'always',
        `${name} should stay always-visible (not deferred)`,
      ).toBe(true);
    }
  });
});

describe('MCP ListTools shape with agentSurface', () => {
  // Mirror the ListTools handler in src/mcp/server.ts so we can assert its output
  // shape without spinning up the full MCP server.
  function buildToolsList() {
    return operations.map(op => ({
      name: op.name,
      description: op.description,
      inputSchema: {
        type: 'object' as const,
        properties: Object.fromEntries(
          Object.entries(op.params).map(([k, v]) => [k, {
            type: v.type === 'array' ? 'array' : v.type,
            ...(v.description ? { description: v.description } : {}),
            ...(v.enum ? { enum: v.enum } : {}),
            ...(v.items ? { items: { type: v.items.type } } : {}),
          }]),
        ),
        required: Object.entries(op.params)
          .filter(([, v]) => v.required)
          .map(([k]) => k),
      },
      ...(op.agentSurface === 'deferred' ? { defer_loading: true } : {}),
    }));
  }

  test('emits defer_loading: true for exactly the deferred ops', () => {
    const tools = buildToolsList();
    const withDeferFlag = tools.filter(t => (t as { defer_loading?: boolean }).defer_loading === true);
    expect(withDeferFlag.length).toBe(EXPECTED_DEFERRED.size);
    for (const t of withDeferFlag) {
      expect(EXPECTED_DEFERRED.has(t.name)).toBe(true);
    }
  });

  test('always-visible tools have no defer_loading field (not even false)', () => {
    const tools = buildToolsList();
    const alwaysVisible = tools.filter(t => !EXPECTED_DEFERRED.has(t.name));
    for (const t of alwaysVisible) {
      // The exact-omit assertion matters: a spurious `defer_loading: false` would
      // still bloat the tool schema Claude Code indexes. We want the field absent.
      expect('defer_loading' in t).toBe(false);
    }
  });

  test('every tool (deferred or not) still has name, description, inputSchema', () => {
    const tools = buildToolsList();
    for (const t of tools) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.inputSchema.type).toBe('object');
    }
  });
});
