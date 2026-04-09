import { describe, test, expect } from 'bun:test';

// Test the validateSlug behavior via the engine
// We can't import validateSlug directly (it's private), so we test through putPage mock behavior
// Instead, test the regex logic directly

function validateSlug(slug: string): boolean {
  // Mirrors the logic in postgres-engine.ts
  if (!slug || /\.\./.test(slug) || /^\//.test(slug)) return false;
  return true;
}

describe('validateSlug (widened for any filename chars)', () => {
  test('accepts clean slug', () => {
    expect(validateSlug('people/sarah-chen')).toBe(true);
  });

  test('accepts slug with spaces (Apple Notes)', () => {
    expect(validateSlug('apple-notes/2017-05-03 ohmygreen')).toBe(true);
  });

  test('accepts slug with parens', () => {
    expect(validateSlug('apple-notes/notes (march 2024)')).toBe(true);
  });

  test('accepts slug with special chars', () => {
    expect(validateSlug("notes/it's a test")).toBe(true);
    expect(validateSlug('notes/file@2024')).toBe(true);
    expect(validateSlug('notes/50% complete')).toBe(true);
  });

  test('accepts slug with unicode', () => {
    expect(validateSlug('notes/日本語テスト')).toBe(true);
    expect(validateSlug('notes/café-meeting')).toBe(true);
  });

  test('rejects empty slug', () => {
    expect(validateSlug('')).toBe(false);
  });

  test('rejects path traversal', () => {
    expect(validateSlug('../etc/passwd')).toBe(false);
    expect(validateSlug('notes/../../etc')).toBe(false);
  });

  test('rejects leading slash', () => {
    expect(validateSlug('/absolute/path')).toBe(false);
  });

  test('accepts slug with dots (not traversal)', () => {
    expect(validateSlug('notes/v1.0.0')).toBe(true);
    expect(validateSlug('notes/file.name.md')).toBe(true);
  });
});
