/**
 * Ingest-stage runner for the pbrain eval harness.
 *
 * Per-case workflow:
 *   1. Spin up fresh in-memory PGLite (no shared state between cases).
 *   2. importFromContent(engine, slug, source, {noEmbed: true})
 *   3. Query the created page and build a judge-facing "full-page view"
 *      (compiled_truth + frontmatter-as-YAML + timeline).
 *   4. For every required_fact: judge "is this fact expressed?" against the view.
 *   5. For every forbidden_fact: same check — but YES is a failure.
 *   6. Compute case metrics, tear down the engine.
 *
 * Scope honesty: pbrain's current ingest pipeline creates ONE page per
 * `importFromContent` call. There's no LLM-driven entity extraction that
 * splits a source doc into multiple pages — that's enrichment, which runs
 * as a separate post-ingest step. So `expected_pages` for v0.4.0 fixtures
 * is effectively single-page + observability around slug/type match. When
 * enrichment gets wired into the ingest stage, the metric surface stays
 * stable; only `created_pages` grows.
 *
 * Embedding is skipped per case (noEmbed: true). We test ingest fact capture,
 * not embedding quality. Embedding is covered by the retrieval stage.
 */

import { readFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { PGLiteEngine } from '../pglite-engine.ts';
import { importFromContent } from '../import-file.ts';
import { judgeFactExpressed, type JudgeResult } from './judge.ts';
import { slugPrecisionHierarchical, slugRecallHierarchical, f1, mean } from './metrics.ts';
import type { IngestCase, IngestFixture, ForbiddenFact } from './fixtures.ts';

// ─────────────────────────────────────────────────────────────────
// Public metric shapes
// ─────────────────────────────────────────────────────────────────

export interface IngestCaseMetrics {
  case_id: string;
  /** PRIMARY ship-gate metric. |facts_expressed| / |required_facts|. */
  fact_union_recall: number;
  fact_hits: number;
  fact_total: number;
  /** Ship-gate: MUST be 0. |forbidden_facts_expressed| / |forbidden_facts|. */
  forbidden_fact_rate: number;
  forbidden_fact_hits: number;
  forbidden_fact_total: number;
  /** Hierarchical slug precision over created vs expected page slugs. */
  page_precision: number;
  page_recall: number;
  page_f1: number;
  created_pages: string[];
  expected_pages: string[];
  /** 1 if any forbidden_pages slug was created, else 0. Ship-gate: MUST be 0. */
  forbidden_page_rate: number;
  forbidden_pages_hit: string[];
  /** Instrumentation for cost/latency regression tracking. */
  judge_calls: number;
  judge_degraded_count: number;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  /** Populated when import failed; metrics fall back to zeros. */
  import_error?: string;
}

export interface IngestReport {
  cases: IngestCaseMetrics[];
  mean: {
    fact_union_recall: number;
    forbidden_fact_rate: number;
    page_precision: number;
    page_recall: number;
    page_f1: number;
    forbidden_page_rate: number;
  };
  totals: {
    judge_calls: number;
    tokens_in: number;
    tokens_out: number;
    latency_ms: number;
  };
}

export type JudgeFn = (text: string, fact: string) => Promise<JudgeResult>;

export interface IngestEvalOpts {
  /** Inject a fake judge for unit tests. Defaults to the real judgeFactExpressed. */
  judgeFn?: JudgeFn;
  /** Run only the first N cases — dev-loop speed path. */
  sample?: number;
  /** Forwarded to importFromContent. Defaults to true (ingest eval doesn't need embeddings). */
  noEmbed?: boolean;
  /**
   * Directory used to resolve relative `source.path` values in fixture cases.
   * Defaults to cwd. The CLI sets this to the fixture file's directory so
   * `source.path: './sources/x.md'` in a fixture works without absolute paths.
   */
  baseDir?: string;
}

// ─────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────

export async function runIngestEval(
  fixture: IngestFixture,
  opts: IngestEvalOpts = {},
): Promise<IngestReport> {
  const judge = opts.judgeFn ?? judgeFactExpressed;
  const noEmbed = opts.noEmbed ?? true;

  const all = fixture.cases;
  const cases = opts.sample != null ? all.slice(0, opts.sample) : all;

  const baseDir = opts.baseDir ?? process.cwd();
  const results: IngestCaseMetrics[] = [];
  for (const c of cases) {
    results.push(await runSingleCase(c, judge, noEmbed, baseDir));
  }

  return {
    cases: results,
    mean: {
      fact_union_recall: mean(results.map(r => r.fact_union_recall)),
      forbidden_fact_rate: mean(results.map(r => r.forbidden_fact_rate)),
      page_precision: mean(results.map(r => r.page_precision)),
      page_recall: mean(results.map(r => r.page_recall)),
      page_f1: mean(results.map(r => r.page_f1)),
      forbidden_page_rate: mean(results.map(r => r.forbidden_page_rate)),
    },
    totals: {
      judge_calls: sum(results.map(r => r.judge_calls)),
      tokens_in: sum(results.map(r => r.tokens_in)),
      tokens_out: sum(results.map(r => r.tokens_out)),
      latency_ms: sum(results.map(r => r.latency_ms)),
    },
  };
}

async function runSingleCase(
  c: IngestCase,
  judge: JudgeFn,
  noEmbed: boolean,
  baseDir: string,
): Promise<IngestCaseMetrics> {
  const start = Date.now();
  const emptyMetrics = (err?: string): IngestCaseMetrics => ({
    case_id: c.id,
    fact_union_recall: 0,
    fact_hits: 0,
    fact_total: c.required_facts.length,
    forbidden_fact_rate: 0,
    forbidden_fact_hits: 0,
    forbidden_fact_total: c.forbidden_facts?.length ?? 0,
    page_precision: 0,
    page_recall: 0,
    page_f1: 0,
    created_pages: [],
    expected_pages: c.expected_pages.map(p => p.slug),
    forbidden_page_rate: 0,
    forbidden_pages_hit: [],
    judge_calls: 0,
    judge_degraded_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    latency_ms: Date.now() - start,
    import_error: err,
  });

  if (c.expected_pages.length === 0) {
    return emptyMetrics('fixture error: expected_pages must list at least one page');
  }

  const primarySlug = c.expected_pages[0].slug;
  const sourceContent = resolveSourceContent(c, baseDir);
  if (sourceContent == null) {
    return emptyMetrics(`fixture error: source content unreadable for case ${c.id}`);
  }

  const engine = new PGLiteEngine();
  try {
    await engine.connect({ engine: 'pglite' });
    await engine.initSchema();

    const importResult = await importFromContent(engine, primarySlug, sourceContent, { noEmbed });
    if (importResult.status !== 'imported') {
      return emptyMetrics(importResult.error || `import skipped with status ${importResult.status}`);
    }

    const createdPages = (await engine.listPages({ limit: 1000 })).map(p => p.slug);
    const pageViewCache = new Map<string, string>();

    // Judge each required_fact against the union of all created page views.
    // "Union" here is a newline-joined concatenation of full-page views;
    // the judge sees all pages at once and decides if the fact is expressed
    // *somewhere* in the brain, which matches fact_union_recall semantics.
    const unionView = await buildUnionView(engine, createdPages, pageViewCache);

    let factHits = 0;
    let forbiddenHits = 0;
    let judgeCalls = 0;
    let degraded = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    const forbiddenPagesHit: string[] = [];

    for (const rf of c.required_facts) {
      const verdict = await judge(unionView, rf.fact);
      judgeCalls++;
      if (verdict.degraded) degraded++;
      tokensIn += verdict.tokens_in ?? 0;
      tokensOut += verdict.tokens_out ?? 0;
      if (verdict.verdict === 'yes') factHits++;
    }

    for (const ff of c.forbidden_facts ?? []) {
      const scopedView = await resolveForbiddenScope(ff, engine, createdPages, pageViewCache, unionView);
      if (scopedView == null) continue; // scope page doesn't exist → nothing to check
      const verdict = await judge(scopedView, ff.fact);
      judgeCalls++;
      if (verdict.degraded) degraded++;
      tokensIn += verdict.tokens_in ?? 0;
      tokensOut += verdict.tokens_out ?? 0;
      if (verdict.verdict === 'yes') forbiddenHits++;
    }

    // forbidden_pages check: did ingest accidentally create any slug on the blocklist?
    const forbiddenSet = new Set(c.forbidden_pages ?? []);
    for (const created of createdPages) {
      if (forbiddenSet.has(created)) forbiddenPagesHit.push(created);
    }

    const createdSet = new Set(createdPages);
    const expectedSet = new Set(c.expected_pages.map(p => p.slug));
    const pagePrecision = slugPrecisionHierarchical(createdSet, expectedSet);
    const pageRecall = slugRecallHierarchical(createdSet, expectedSet);
    const pageF1 = f1(pagePrecision, pageRecall);

    return {
      case_id: c.id,
      fact_union_recall: c.required_facts.length > 0 ? factHits / c.required_facts.length : 0,
      fact_hits: factHits,
      fact_total: c.required_facts.length,
      forbidden_fact_rate: (c.forbidden_facts?.length ?? 0) > 0
        ? forbiddenHits / c.forbidden_facts!.length
        : 0,
      forbidden_fact_hits: forbiddenHits,
      forbidden_fact_total: c.forbidden_facts?.length ?? 0,
      page_precision: pagePrecision,
      page_recall: pageRecall,
      page_f1: pageF1,
      created_pages: createdPages,
      expected_pages: c.expected_pages.map(p => p.slug),
      forbidden_page_rate: forbiddenPagesHit.length > 0 ? 1 : 0,
      forbidden_pages_hit: forbiddenPagesHit,
      judge_calls: judgeCalls,
      judge_degraded_count: degraded,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      latency_ms: Date.now() - start,
    };
  } finally {
    try { await engine.disconnect(); } catch { /* teardown best-effort */ }
  }
}

// ─────────────────────────────────────────────────────────────────
// Full-page view construction
// ─────────────────────────────────────────────────────────────────

/**
 * Render one page as a judge-facing text block: title + type + frontmatter-as-YAML
 * + compiled_truth + timeline. This is the canonical "what does this page say"
 * view the judge gets — not the raw markdown, since raw markdown would leak
 * the fixture's own wording into the judge prompt.
 *
 * Exported for test coverage; callers normally reach it via runIngestEval.
 */
export async function buildPageView(
  engine: PGLiteEngine,
  slug: string,
): Promise<string> {
  const page = await engine.getPage(slug);
  if (!page) return '';

  const parts: string[] = [];
  parts.push(`# ${page.title || slug}`);
  parts.push(`slug: ${page.slug}`);
  if (page.type) parts.push(`type: ${page.type}`);

  if (page.frontmatter && Object.keys(page.frontmatter).length > 0) {
    parts.push('frontmatter:');
    for (const [k, v] of Object.entries(page.frontmatter)) {
      parts.push(`  ${k}: ${renderScalar(v)}`);
    }
  }

  if (page.compiled_truth?.trim()) {
    parts.push('');
    parts.push('## compiled_truth');
    parts.push(page.compiled_truth.trim());
  }

  if (page.timeline?.trim()) {
    parts.push('');
    parts.push('## timeline');
    parts.push(page.timeline.trim());
  }

  return parts.join('\n');
}

async function buildUnionView(
  engine: PGLiteEngine,
  slugs: string[],
  cache: Map<string, string>,
): Promise<string> {
  const views: string[] = [];
  for (const slug of slugs) {
    let v = cache.get(slug);
    if (v == null) {
      v = await buildPageView(engine, slug);
      cache.set(slug, v);
    }
    if (v) views.push(v);
  }
  return views.join('\n\n---\n\n');
}

async function resolveForbiddenScope(
  ff: ForbiddenFact,
  engine: PGLiteEngine,
  createdPages: string[],
  cache: Map<string, string>,
  unionView: string,
): Promise<string | null> {
  if (ff.page_scope == null) return unionView;
  if (!createdPages.includes(ff.page_scope)) return null;
  let v = cache.get(ff.page_scope);
  if (v == null) {
    v = await buildPageView(engine, ff.page_scope);
    cache.set(ff.page_scope, v);
  }
  return v;
}

function renderScalar(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

// ─────────────────────────────────────────────────────────────────
// Source resolution
// ─────────────────────────────────────────────────────────────────

function resolveSourceContent(c: IngestCase, baseDir: string): string | null {
  const src = c.source;
  if ('content' in src) return src.content;
  if ('path' in src) {
    try {
      const full = isAbsolute(src.path) ? src.path : resolve(baseDir, src.path);
      return readFileSync(full, 'utf-8');
    } catch {
      return null;
    }
  }
  return null;
}

function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}
