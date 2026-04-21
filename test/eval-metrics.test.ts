/**
 * Unit tests for src/core/eval/metrics.ts — pure primitives. No API keys, no DB.
 */

import { describe, test, expect } from 'bun:test';
import {
  precision,
  recall,
  f1,
  levenshtein,
  classifySlugMatch,
  bestSlugMatch,
  slugPrecisionHierarchical,
  slugRecallHierarchical,
  mean,
  stdev,
} from '../src/core/eval/metrics.ts';

// ─────────────────────────────────────────────────────────────────
// precision / recall / f1
// ─────────────────────────────────────────────────────────────────

describe('precision', () => {
  test('all predicted are actual → 1.0', () => {
    expect(precision(new Set(['a', 'b']), new Set(['a', 'b', 'c']))).toBe(1);
  });

  test('half of predicted are actual → 0.5', () => {
    expect(precision(new Set(['a', 'x']), new Set(['a', 'b']))).toBe(0.5);
  });

  test('empty predicted → 0 (no predictions = no precision, avoid NaN)', () => {
    expect(precision(new Set(), new Set(['a']))).toBe(0);
  });

  test('empty actual + nonempty predicted → 0', () => {
    expect(precision(new Set(['a']), new Set())).toBe(0);
  });
});

describe('recall', () => {
  test('all actual are predicted → 1.0', () => {
    expect(recall(new Set(['a', 'b', 'c']), new Set(['a', 'b']))).toBe(1);
  });

  test('half of actual captured → 0.5', () => {
    expect(recall(new Set(['a']), new Set(['a', 'b']))).toBe(0.5);
  });

  test('empty actual → 0 (nothing to recall)', () => {
    expect(recall(new Set(['a']), new Set())).toBe(0);
  });
});

describe('f1', () => {
  test('p=1 r=1 → 1', () => { expect(f1(1, 1)).toBe(1); });
  test('p=0 r=1 → 0 (short-circuit on either zero)', () => { expect(f1(0, 1)).toBe(0); });
  test('p=1 r=0 → 0', () => { expect(f1(1, 0)).toBe(0); });
  test('p=0.5 r=0.5 → 0.5', () => { expect(f1(0.5, 0.5)).toBe(0.5); });
  test('p=0.8 r=0.4 → 0.533... (harmonic mean)', () => {
    expect(f1(0.8, 0.4)).toBeCloseTo(0.5333, 3);
  });
});

// ─────────────────────────────────────────────────────────────────
// levenshtein
// ─────────────────────────────────────────────────────────────────

describe('levenshtein', () => {
  test('identical strings → 0', () => { expect(levenshtein('abc', 'abc')).toBe(0); });
  test('empty vs non-empty → length', () => { expect(levenshtein('', 'abc')).toBe(3); });
  test('single substitution → 1', () => { expect(levenshtein('cat', 'bat')).toBe(1); });
  test('single insertion → 1', () => { expect(levenshtein('cat', 'cats')).toBe(1); });
  test('single deletion → 1', () => { expect(levenshtein('cats', 'cat')).toBe(1); });
  test('multiple edits', () => { expect(levenshtein('kitten', 'sitting')).toBe(3); });
  test('symmetric — order does not matter', () => {
    expect(levenshtein('abcdef', 'xyz')).toBe(levenshtein('xyz', 'abcdef'));
  });
});

// ─────────────────────────────────────────────────────────────────
// slug matching — the core correctness surface for ingest + answer
// ─────────────────────────────────────────────────────────────────

describe('classifySlugMatch', () => {
  test('exact match', () => {
    const m = classifySlugMatch('people/alice-chen', 'people/alice-chen');
    expect(m.kind).toBe('exact');
    expect(m.weight).toBe(1.0);
  });

  test('descendant — candidate more specific than expected', () => {
    const m = classifySlugMatch('companies/novamind/series-a', 'companies/novamind');
    expect(m.kind).toBe('descendant');
    expect(m.weight).toBe(1.0);
  });

  test('ancestor — candidate less specific than expected', () => {
    const m = classifySlugMatch('companies/novamind', 'companies/novamind/series-a');
    expect(m.kind).toBe('ancestor');
    expect(m.weight).toBe(0.75);
  });

  test('near match on tail within same domain', () => {
    const m = classifySlugMatch('people/alice-c-chen', 'people/alice-chen');
    expect(m.kind).toBe('near');
    expect(m.weight).toBe(0.5);
  });

  test('near match respects threshold', () => {
    // Tail distance 4; default threshold is 2 → must be 'none'.
    const m = classifySlugMatch('people/totally-different', 'people/alice-chen');
    expect(m.kind).toBe('none');
  });

  test('different domain → none, even when tail is identical', () => {
    const m = classifySlugMatch('decisions/alice', 'people/alice');
    expect(m.kind).toBe('none');
  });

  test('custom near-threshold raises tolerance', () => {
    const tail1 = 'people/alice-chen-jr';
    const tail2 = 'people/alice-chen';
    const tight = classifySlugMatch(tail1, tail2, 2);
    expect(tight.kind).toBe('none');
    const loose = classifySlugMatch(tail1, tail2, 3);
    expect(loose.kind).toBe('near');
  });
});

describe('bestSlugMatch', () => {
  test('prefers exact over descendant over near', () => {
    const best = bestSlugMatch('people/alice-chen', [
      'people/alice-chen-jr',    // near
      'people/alice-chen',       // exact — should win
    ]);
    expect(best.kind).toBe('exact');
  });

  test('descendant beats near when exact is absent', () => {
    const best = bestSlugMatch('companies/novamind/series-a', [
      'companies/novamind-inc',  // near on tail
      'companies/novamind',      // ancestor-of-candidate = descendant match
    ]);
    expect(best.kind).toBe('descendant');
  });

  test('no matches → none', () => {
    const best = bestSlugMatch('deals/foo', ['people/alice']);
    expect(best.kind).toBe('none');
    expect(best.weight).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// hierarchical P/R
// ─────────────────────────────────────────────────────────────────

describe('slugPrecisionHierarchical', () => {
  test('mix of exact + descendant + none', () => {
    const predicted = new Set([
      'people/alice-chen',                // exact hit on expected
      'companies/novamind/series-a',      // descendant of expected companies/novamind
      'deals/unknown',                    // miss
    ]);
    const expected = new Set(['people/alice-chen', 'companies/novamind']);
    // Weights: 1.0 + 1.0 + 0 = 2.0 over 3 predicted = 0.6667
    expect(slugPrecisionHierarchical(predicted, expected)).toBeCloseTo(2 / 3, 4);
  });

  test('empty predicted → 0', () => {
    expect(slugPrecisionHierarchical(new Set(), new Set(['x']))).toBe(0);
  });
});

describe('slugRecallHierarchical', () => {
  test('expected fully covered by exact matches', () => {
    const predicted = new Set(['people/alice', 'companies/foo']);
    const expected = new Set(['people/alice', 'companies/foo']);
    expect(slugRecallHierarchical(predicted, expected)).toBe(1);
  });

  test('expected covered only via ancestor match from predicted', () => {
    // Expected companies/novamind/series-a; predicted has companies/novamind (ancestor).
    // From each expected slug's POV: best predicted match is ancestor → weight 0.75.
    const predicted = new Set(['companies/novamind']);
    const expected = new Set(['companies/novamind/series-a']);
    expect(slugRecallHierarchical(predicted, expected)).toBeCloseTo(0.75, 4);
  });
});

// ─────────────────────────────────────────────────────────────────
// mean / stdev
// ─────────────────────────────────────────────────────────────────

describe('mean', () => {
  test('empty → 0', () => { expect(mean([])).toBe(0); });
  test('single value', () => { expect(mean([5])).toBe(5); });
  test('average of a few values', () => { expect(mean([1, 2, 3, 4])).toBe(2.5); });
});

describe('stdev', () => {
  test('empty → 0', () => { expect(stdev([])).toBe(0); });
  test('single value → 0 (need 2+)', () => { expect(stdev([5])).toBe(0); });
  test('identical values → 0', () => { expect(stdev([3, 3, 3])).toBe(0); });
  test('sample stdev (Bessel) of [2,4,4,4,5,5,7,9]', () => {
    // Standard textbook example; sample stdev ≈ 2.138
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 2);
  });
});
