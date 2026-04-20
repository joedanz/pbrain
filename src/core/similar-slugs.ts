/**
 * Cheap "did you mean" hint for entity pages.
 *
 * When an agent creates a page under `people/` or `companies/`, we look for
 * existing pages with similar slug tails and surface them in the `put_page`
 * response. The agent can then choose to use the canonical slug + add an
 * `aliases:` entry rather than create a duplicate.
 *
 * No embeddings. No LLM. No scoring model. Just token-set matching with
 * dash-stripping and initial expansion. Over-flagging is acceptable — the
 * agent decides whether to act on the hint. Under-flagging is the real risk.
 */
import type { BrainEngine } from './engine.ts';
import type { PageType } from './types.ts';

export interface SimilarSlug {
  slug: string;
  title?: string;
  overlap: number;
}

const ENTITY_DIRS: Record<string, PageType> = {
  people: 'person',
  companies: 'company',
};

/** Upper bound on candidate pages we'll score. Entity directories rarely exceed this. */
const MAX_CANDIDATES = 5000;

/** Minimum overlap score to include in the hint. Lenient by design — it's just a hint. */
const MIN_OVERLAP = 0.5;

/**
 * Split a slug like `people/jane-doe` into `[dir, tail]`. Returns null for
 * slugs that don't have a single leading directory segment.
 */
function splitSlug(slug: string): [string, string] | null {
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return null;
  const dir = slug.slice(0, idx);
  const tail = slug.slice(idx + 1);
  if (tail.includes('/')) return null;
  return [dir, tail];
}

/**
 * Score two slug tails for likely-duplicate. Range [0, 1].
 *
 * Pipeline:
 *   1. Identical → 1.0
 *   2. Dash-stripped identical (`openai` ≡ `open-ai`) → 0.95
 *   3. Dash-stripped substring containment (one fully inside the other) → 0.85
 *   4. Token-set matching with initial expansion: `j` matches any token starting with `j`
 */
export function scoreTails(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length < 2 || b.length < 2) return 0;

  const aFlat = a.replace(/-/g, '');
  const bFlat = b.replace(/-/g, '');
  if (aFlat === bFlat) return 0.95;
  if (aFlat.length >= 4 && bFlat.includes(aFlat)) return 0.85;
  if (bFlat.length >= 4 && aFlat.includes(bFlat)) return 0.85;

  const tokensA = a.split('-').filter(t => t.length > 0);
  const tokensB = b.split('-').filter(t => t.length > 0);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const matchedB = new Set<number>();
  let matches = 0;
  for (const ta of tokensA) {
    for (let j = 0; j < tokensB.length; j++) {
      if (matchedB.has(j)) continue;
      const tb = tokensB[j];
      if (ta === tb) {
        matchedB.add(j);
        matches++;
        break;
      }
      // Initial expansion: single-char token matches any multi-char token with same first letter.
      if (ta.length === 1 && tb.length > 1 && tb[0] === ta) {
        matchedB.add(j);
        matches++;
        break;
      }
      if (tb.length === 1 && ta.length > 1 && ta[0] === tb) {
        matchedB.add(j);
        matches++;
        break;
      }
    }
  }

  return matches / Math.max(tokensA.length, tokensB.length);
}

/**
 * Find existing entity pages whose slug tails likely refer to the same entity
 * as the candidate slug. Returns at most `limit` matches, sorted by overlap
 * descending.
 *
 * Only runs for slugs under `people/` or `companies/`. Returns an empty array
 * for any other slug shape (defers to the caller to scope the check).
 */
export async function findSimilarEntitySlugs(
  engine: BrainEngine,
  candidateSlug: string,
  limit = 3,
): Promise<SimilarSlug[]> {
  const split = splitSlug(candidateSlug);
  if (!split) return [];
  const [dir, candidateTail] = split;
  const pageType = ENTITY_DIRS[dir];
  if (!pageType) return [];

  const pages = await engine.listPages({ type: pageType, limit: MAX_CANDIDATES });
  const scored: SimilarSlug[] = [];
  for (const p of pages) {
    if (p.slug === candidateSlug) continue;
    const other = splitSlug(p.slug);
    if (!other || other[0] !== dir) continue;
    const overlap = scoreTails(candidateTail, other[1]);
    if (overlap >= MIN_OVERLAP) {
      scored.push({ slug: p.slug, title: p.title, overlap });
    }
  }
  scored.sort((a, b) => b.overlap - a.overlap);
  return scored.slice(0, limit);
}
