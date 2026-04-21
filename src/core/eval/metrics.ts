/**
 * Shared metric primitives for the pbrain eval harness.
 *
 * Pure functions, zero dependencies. Consumed by eval/{ingest,retrieval,answer}.ts.
 * Retrieval-specific IR metrics (P@k / R@k / MRR / nDCG) live in
 * src/core/search/eval.ts and are intentionally not duplicated here — the
 * retrieval stage wraps that module without reshaping it.
 */

// ─────────────────────────────────────────────────────────────────
// Set-based classification metrics (ingest page-match, answer citations)
// ─────────────────────────────────────────────────────────────────

/**
 * Precision over a classification: |predicted ∩ actual| / |predicted|.
 * Returns 0 when |predicted| = 0 to avoid NaN — no predictions = no precision.
 */
export function precision(predicted: Set<string>, actual: Set<string>): number {
  if (predicted.size === 0) return 0;
  let hits = 0;
  for (const p of predicted) if (actual.has(p)) hits++;
  return hits / predicted.size;
}

/**
 * Recall over a classification: |predicted ∩ actual| / |actual|.
 * Returns 0 when |actual| = 0 — nothing to recall.
 */
export function recall(predicted: Set<string>, actual: Set<string>): number {
  if (actual.size === 0) return 0;
  let hits = 0;
  for (const p of predicted) if (actual.has(p)) hits++;
  return hits / actual.size;
}

/** F1 = harmonic mean of precision + recall. Returns 0 when either is 0. */
export function f1(precisionVal: number, recallVal: number): number {
  if (precisionVal === 0 || recallVal === 0) return 0;
  return (2 * precisionVal * recallVal) / (precisionVal + recallVal);
}

// ─────────────────────────────────────────────────────────────────
// String-distance primitives
// ─────────────────────────────────────────────────────────────────

/**
 * Levenshtein edit distance between two strings. Classic DP; O(n·m) time, O(min(n,m)) space.
 * Used for slug near-match classification in ingest/answer stages.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Keep the shorter string as the column dimension to minimize memory.
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let prev = new Array(shorter.length + 1);
  let curr = new Array(shorter.length + 1);
  for (let j = 0; j <= shorter.length; j++) prev[j] = j;

  for (let i = 1; i <= longer.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= shorter.length; j++) {
      const cost = longer[i - 1] === shorter[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,       // insertion
        prev[j] + 1,           // deletion
        prev[j - 1] + cost,    // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[shorter.length];
}

// ─────────────────────────────────────────────────────────────────
// Slug matching (hierarchical + near-match)
// ─────────────────────────────────────────────────────────────────

/**
 * Slug match result. Reports the strongest match mode found.
 * Weight conveys how confidently we count this as a hit:
 *   - exact: 1.0
 *   - descendant (citing more specific than expected): 1.0
 *   - ancestor (citing less specific than expected): 0.75
 *   - near (Levenshtein ≤ threshold on tail): 0.5
 *   - none: 0
 */
export type SlugMatchKind = 'exact' | 'descendant' | 'ancestor' | 'near' | 'none';

export interface SlugMatch {
  kind: SlugMatchKind;
  weight: number;
  candidate: string;
  expected: string;
}

/**
 * Classify the relationship between a candidate slug and an expected slug.
 * Slugs are path-segmented by `/`. "descendant" means candidate is more specific
 * than expected (e.g. `companies/novamind/series-a` vs expected `companies/novamind`).
 * "ancestor" is the opposite. "near" only applies within the same domain prefix
 * (first segment) and checks the tail for small Levenshtein distance.
 */
export function classifySlugMatch(
  candidate: string,
  expected: string,
  nearThreshold = 2,
): SlugMatch {
  if (candidate === expected) {
    return { kind: 'exact', weight: 1.0, candidate, expected };
  }

  const candSegs = candidate.split('/').filter(Boolean);
  const expSegs = expected.split('/').filter(Boolean);

  // Candidate is a strict descendant of expected.
  if (
    candSegs.length > expSegs.length &&
    expSegs.every((seg, i) => candSegs[i] === seg)
  ) {
    return { kind: 'descendant', weight: 1.0, candidate, expected };
  }

  // Candidate is a strict ancestor of expected.
  if (
    expSegs.length > candSegs.length &&
    candSegs.every((seg, i) => expSegs[i] === seg)
  ) {
    return { kind: 'ancestor', weight: 0.75, candidate, expected };
  }

  // Same domain (first segment), Levenshtein-close on the tail.
  if (
    candSegs.length > 0 &&
    expSegs.length > 0 &&
    candSegs[0] === expSegs[0]
  ) {
    const candTail = candSegs.slice(1).join('/');
    const expTail = expSegs.slice(1).join('/');
    if (candTail.length > 0 && expTail.length > 0) {
      const dist = levenshtein(candTail, expTail);
      if (dist > 0 && dist <= nearThreshold) {
        return { kind: 'near', weight: 0.5, candidate, expected };
      }
    }
  }

  return { kind: 'none', weight: 0, candidate, expected };
}

/**
 * Best match for a candidate against a set of expected slugs. Returns the
 * strongest classification found (exact > descendant > ancestor > near > none).
 */
export function bestSlugMatch(
  candidate: string,
  expected: Iterable<string>,
  nearThreshold = 2,
): SlugMatch {
  let best: SlugMatch = {
    kind: 'none',
    weight: 0,
    candidate,
    expected: '',
  };
  const order: Record<SlugMatchKind, number> = {
    exact: 4, descendant: 3, ancestor: 2, near: 1, none: 0,
  };
  for (const exp of expected) {
    const m = classifySlugMatch(candidate, exp, nearThreshold);
    if (order[m.kind] > order[best.kind]) {
      best = m;
      if (m.kind === 'exact') break;
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────
// Hierarchical-aware P/R for slug sets
// ─────────────────────────────────────────────────────────────────

/**
 * Precision over slug sets with hierarchical + near match crediting.
 * Each predicted slug earns at most its best match weight against `actual`.
 * Returns weighted precision in [0, 1].
 */
export function slugPrecisionHierarchical(
  predicted: Set<string>,
  actual: Set<string>,
  nearThreshold = 2,
): number {
  if (predicted.size === 0) return 0;
  let total = 0;
  for (const p of predicted) {
    total += bestSlugMatch(p, actual, nearThreshold).weight;
  }
  return total / predicted.size;
}

/**
 * Recall over slug sets with hierarchical + near match crediting.
 * For each actual slug, find the best-matching predicted slug by classifying
 * each predicted `p` against actual `a`. Semantics are the reverse of precision:
 * if a predicted slug is an ancestor of the expected actual (less specific
 * than hoped), that's partial credit (0.75); a descendant (more specific than
 * hoped) still covers the actual and earns full credit.
 *
 * Note the deliberate asymmetry with precision: we iterate predicted×actual
 * here (O(|predicted|·|actual|)) rather than reusing bestSlugMatch, because
 * bestSlugMatch's classify orientation is precision-shaped and applying it
 * naively here would flip descendant/ancestor credit.
 */
export function slugRecallHierarchical(
  predicted: Set<string>,
  actual: Set<string>,
  nearThreshold = 2,
): number {
  if (actual.size === 0) return 0;
  const order: Record<SlugMatchKind, number> = {
    exact: 4, descendant: 3, ancestor: 2, near: 1, none: 0,
  };
  let total = 0;
  for (const a of actual) {
    let bestKind: SlugMatchKind = 'none';
    let bestWeight = 0;
    for (const p of predicted) {
      const m = classifySlugMatch(p, a, nearThreshold);
      if (order[m.kind] > order[bestKind]) {
        bestKind = m.kind;
        bestWeight = m.weight;
        if (m.kind === 'exact') break;
      }
    }
    total += bestWeight;
  }
  return total / actual.size;
}

// ─────────────────────────────────────────────────────────────────
// Aggregate helpers (mean, stdev — used for --runs N variance reporting)
// ─────────────────────────────────────────────────────────────────

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * Sample standard deviation (Bessel-corrected, n-1 denominator). Returns 0
 * when fewer than 2 samples are present.
 */
export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let ss = 0;
  for (const x of xs) ss += (x - m) ** 2;
  return Math.sqrt(ss / (xs.length - 1));
}
