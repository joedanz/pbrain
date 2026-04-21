/**
 * Answer-stage runner for the pbrain eval harness.
 *
 * Per-case workflow:
 *   1. Take QUERY + retrieved_context (inline from fixture in v0.4.0 PR 4;
 *      produced by retrieval pass in PR 5 orchestrator).
 *   2. Call generator (Haiku-tier) with a fixed, versioned answer-gen prompt.
 *      Use tool_use to get structured {answer, citations, refused}.
 *   3. Validate each cited slug appears in retrieved_context — slugs not in
 *      context are hallucinations (ship-gate: rate must = 0).
 *   4. Judge each required_answer_fact / forbidden_answer_fact against the
 *      generated answer text.
 *   5. On expected_refusal=true cases, flip the check: MUST refuse, MUST NOT cite.
 *   6. Compute hierarchical citation F1 using the same slug-match primitives
 *      the ingest stage uses for page-precision.
 *
 * Scope honesty: v0.4.0 ships inline retrieved_context only. The fixture
 * format reserves a slot for live retrieval (PR 5 orchestrator) without
 * requiring it here. This keeps PR 4 hermetically testable and keeps
 * regression failures scoped to a single stage — ingest regressions don't
 * silently blow up answer metrics because answer uses frozen context.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { AnswerCase, AnswerFixture, RetrievedChunk } from './fixtures.ts';
import { judgeFactExpressed, type JudgeResult } from './judge.ts';
import {
  slugPrecisionHierarchical,
  slugRecallHierarchical,
  f1,
  precision,
  recall,
  mean,
} from './metrics.ts';

// ─────────────────────────────────────────────────────────────────
// Generator model pin (centralized)
// ─────────────────────────────────────────────────────────────────

export const DEFAULT_GENERATOR_MODEL = 'claude-haiku-4-5-20251001';

export function getGeneratorModel(): string {
  return process.env.EVAL_GENERATOR_MODEL || DEFAULT_GENERATOR_MODEL;
}

// ─────────────────────────────────────────────────────────────────
// Generator shape + default Anthropic client
// ─────────────────────────────────────────────────────────────────

export interface AnswerGenResult {
  answer: string;
  citations: string[];
  refused: boolean;
  tokens_in?: number;
  tokens_out?: number;
  /** True when tool_use didn't produce a usable schema-valid block. */
  degraded?: boolean;
}

export type AnswerGeneratorFn = (
  query: string,
  context: RetrievedChunk[],
) => Promise<AnswerGenResult>;

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) anthropicClient = new Anthropic();
  return anthropicClient;
}

/** Reset the singleton — test-only escape hatch. */
export function __resetAnswerClientForTests(): void {
  anthropicClient = null;
}

/**
 * Fixed, versioned generator prompt. See plan: "JSON output (via prefill or
 * tool-use) eliminates the fragile regex-parse-from-prose problem." We use
 * tool_use to force schema-valid output.
 */
export const DEFAULT_GENERATOR_SYSTEM =
  `You answer questions using PBrain context. You receive a QUERY and CONTEXT
(retrieved page chunks, each prefixed with its slug). Call the record_answer
tool with a structured response.

Rules:
- Use ONLY facts from CONTEXT. Do not invent.
- If CONTEXT does not support an answer, set refused=true, put
  "I don't have that information" in answer, and return an empty citations array.
- Every slug in citations MUST appear in CONTEXT. Never cite what isn't shown.
- Cite the most specific page that supports each claim.
- Keep the answer concise — one to three sentences.`;

function formatContext(context: RetrievedChunk[]): string {
  if (context.length === 0) return '(no retrieved chunks)';
  return context
    .map((c) => `[[${c.slug}]]\n${c.text}`)
    .join('\n\n---\n\n');
}

/**
 * Default live generator — calls Anthropic with tool_use for structured output.
 * Tests inject their own AnswerGeneratorFn via IngestEvalOpts.generatorFn.
 */
export async function generateAnswerLive(
  query: string,
  context: RetrievedChunk[],
): Promise<AnswerGenResult> {
  const model = getGeneratorModel();
  const response = await getClient().messages.create({
    model,
    max_tokens: 500,
    temperature: 0,
    system: DEFAULT_GENERATOR_SYSTEM,
    tools: [
      {
        name: 'record_answer',
        description: 'Record the structured answer, citations, and refusal flag.',
        input_schema: {
          type: 'object' as const,
          properties: {
            answer: {
              type: 'string',
              description: 'Concise answer prose (1-3 sentences).',
            },
            citations: {
              type: 'array',
              items: { type: 'string' },
              description: 'Slugs cited, each of which MUST appear in CONTEXT.',
            },
            refused: {
              type: 'boolean',
              description: 'True when CONTEXT does not support an answer.',
            },
          },
          required: ['answer', 'citations', 'refused'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'record_answer' },
    messages: [
      {
        role: 'user',
        content: `QUERY:\n${query}\n\nCONTEXT:\n${formatContext(context)}`,
      },
    ],
  });

  const tokensIn = response.usage?.input_tokens;
  const tokensOut = response.usage?.output_tokens;

  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'record_answer') {
      const input = block.input as {
        answer?: unknown;
        citations?: unknown;
        refused?: unknown;
      };
      const answer = typeof input.answer === 'string' ? input.answer : '';
      const refused = typeof input.refused === 'boolean' ? input.refused : false;
      const citations = Array.isArray(input.citations)
        ? input.citations.filter((x): x is string => typeof x === 'string')
        : [];
      return {
        answer, citations, refused,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
      };
    }
  }

  // Degraded fallback: tool_use didn't return a parseable block. Synthesize a
  // safe refusal so the case doesn't silently credit anything.
  return {
    answer: '',
    citations: [],
    refused: true,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    degraded: true,
  };
}

// ─────────────────────────────────────────────────────────────────
// Judge injection (same pattern as ingest.ts)
// ─────────────────────────────────────────────────────────────────

export type AnswerJudgeFn = (text: string, fact: string) => Promise<JudgeResult>;

// ─────────────────────────────────────────────────────────────────
// Public metric shapes
// ─────────────────────────────────────────────────────────────────

export interface AnswerCaseMetrics {
  case_id: string;
  /** PRIMARY ship-gate: fraction of required_answer_facts the judge says YES on. */
  answer_fact_coverage: number;
  fact_hits: number;
  fact_total: number;
  /** Ship-gate: MUST be 0. Fraction of forbidden_answer_facts YES'd by the judge. */
  forbidden_fact_rate: number;
  forbidden_fact_hits: number;
  forbidden_fact_total: number;
  /** Ship-gate: MUST be 0. Fraction of citations pointing at slugs NOT in retrieved_context. */
  citation_hallucination_rate: number;
  citation_hallucinations: string[];
  /** Exact set match. */
  citation_precision_exact: number;
  citation_recall_exact: number;
  citation_f1_exact: number;
  /** Hierarchical (exact/descendant/ancestor/near). */
  citation_precision_hierarchical: number;
  citation_recall_hierarchical: number;
  citation_f1_hierarchical: number;
  /** Ship-gate: MUST be 1 on expected_refusal=true cases, else N/A (reported as -1). */
  refusal_correctness: number;
  /** Whether the generator returned a valid tool_use block. */
  generator_degraded: boolean;
  /** Whether the model's citations included any forbidden_citations entries. */
  forbidden_citation_hits: string[];
  citations: string[];
  answer: string;
  refused: boolean;
  judge_calls: number;
  judge_degraded_count: number;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
}

export interface AnswerReport {
  cases: AnswerCaseMetrics[];
  mean: {
    answer_fact_coverage: number;
    forbidden_fact_rate: number;
    citation_hallucination_rate: number;
    citation_f1_exact: number;
    citation_f1_hierarchical: number;
    /**
     * Mean over cases where expected_refusal=true. NaN when there are no
     * refusal cases — consumers should check isFinite().
     */
    refusal_correctness: number;
  };
  totals: {
    judge_calls: number;
    tokens_in: number;
    tokens_out: number;
    latency_ms: number;
  };
}

export interface AnswerEvalOpts {
  generatorFn?: AnswerGeneratorFn;
  judgeFn?: AnswerJudgeFn;
  /** Run only the first N cases — dev-loop speed path. */
  sample?: number;
}

// ─────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────

export async function runAnswerEval(
  fixture: AnswerFixture,
  opts: AnswerEvalOpts = {},
): Promise<AnswerReport> {
  const generatorFn = opts.generatorFn ?? generateAnswerLive;
  const judgeFn = opts.judgeFn ?? judgeFactExpressed;

  const allCases = fixture.cases;
  const cases = opts.sample !== undefined ? allCases.slice(0, opts.sample) : allCases;

  const caseMetrics: AnswerCaseMetrics[] = [];
  for (const c of cases) {
    caseMetrics.push(await runSingleCase(c, generatorFn, judgeFn));
  }

  // Mean refusal_correctness is only meaningful on cases that expected_refusal.
  const refusalCases = caseMetrics.filter((m) => m.refusal_correctness !== -1);
  const meanRefusal = refusalCases.length === 0
    ? NaN
    : mean(refusalCases.map((m) => m.refusal_correctness));

  return {
    cases: caseMetrics,
    mean: {
      answer_fact_coverage: mean(caseMetrics.map((m) => m.answer_fact_coverage)),
      forbidden_fact_rate: mean(caseMetrics.map((m) => m.forbidden_fact_rate)),
      citation_hallucination_rate: mean(caseMetrics.map((m) => m.citation_hallucination_rate)),
      citation_f1_exact: mean(caseMetrics.map((m) => m.citation_f1_exact)),
      citation_f1_hierarchical: mean(caseMetrics.map((m) => m.citation_f1_hierarchical)),
      refusal_correctness: meanRefusal,
    },
    totals: {
      judge_calls: sum(caseMetrics.map((m) => m.judge_calls)),
      tokens_in: sum(caseMetrics.map((m) => m.tokens_in)),
      tokens_out: sum(caseMetrics.map((m) => m.tokens_out)),
      latency_ms: sum(caseMetrics.map((m) => m.latency_ms)),
    },
  };
}

async function runSingleCase(
  c: AnswerCase,
  generatorFn: AnswerGeneratorFn,
  judgeFn: AnswerJudgeFn,
): Promise<AnswerCaseMetrics> {
  const startedAt = Date.now();
  const context: RetrievedChunk[] = c.retrieved_context ?? [];
  const contextSlugs = new Set(context.map((r) => r.slug));

  let tokensIn = 0;
  let tokensOut = 0;
  let judgeCalls = 0;
  let judgeDegraded = 0;

  // 1. Generate
  const gen = await generatorFn(c.query, context);
  tokensIn += gen.tokens_in ?? 0;
  tokensOut += gen.tokens_out ?? 0;

  // 2. Citation analysis
  const citations = gen.citations;
  const hallucinations = citations.filter((s) => !contextSlugs.has(s));
  const citationHallucinationRate = citations.length === 0
    ? 0
    : hallucinations.length / citations.length;

  const expectedCitationSet = new Set(c.required_citations ?? []);
  const citationSet = new Set(citations);
  const citationPrecisionExact = precision(citationSet, expectedCitationSet);
  const citationRecallExact = recall(citationSet, expectedCitationSet);
  const citationF1Exact = f1(citationPrecisionExact, citationRecallExact);
  const citationPrecisionHier = slugPrecisionHierarchical(citationSet, expectedCitationSet);
  const citationRecallHier = slugRecallHierarchical(citationSet, expectedCitationSet);
  const citationF1Hier = f1(citationPrecisionHier, citationRecallHier);

  const forbiddenCitationSet = new Set(c.forbidden_citations ?? []);
  const forbiddenCitationHits = citations.filter((s) => forbiddenCitationSet.has(s));

  // 3. Fact judging — skip when expected_refusal=true (the question flips to
  // "did the model refuse" and we don't want the judge to pass YES on facts
  // that appear elsewhere in a refusal preamble).
  let factHits = 0;
  let factTotal = c.required_answer_facts.length;
  let forbiddenFactHits = 0;
  let forbiddenFactTotal = (c.forbidden_answer_facts ?? []).length;
  let answerFactCoverage = 0;
  let forbiddenFactRate = 0;

  if (!c.expected_refusal) {
    for (const fact of c.required_answer_facts) {
      const result = await judgeFn(gen.answer, fact);
      judgeCalls++;
      if (result.degraded) judgeDegraded++;
      tokensIn += result.tokens_in ?? 0;
      tokensOut += result.tokens_out ?? 0;
      if (result.verdict === 'yes') factHits++;
    }
    answerFactCoverage = factTotal === 0 ? 0 : factHits / factTotal;

    for (const forb of c.forbidden_answer_facts ?? []) {
      const result = await judgeFn(gen.answer, forb);
      judgeCalls++;
      if (result.degraded) judgeDegraded++;
      tokensIn += result.tokens_in ?? 0;
      tokensOut += result.tokens_out ?? 0;
      if (result.verdict === 'yes') forbiddenFactHits++;
    }
    forbiddenFactRate = forbiddenFactTotal === 0 ? 0 : forbiddenFactHits / forbiddenFactTotal;
  }

  // 4. Refusal correctness (only meaningful on expected_refusal=true cases)
  let refusalCorrectness = -1;
  if (c.expected_refusal) {
    // Must refuse AND must emit no citations. Hallucinated citations on a
    // refusal case are double-penalized: they count in citation_hallucination_rate
    // AND they fail refusal_correctness.
    const refusedOk = gen.refused === true && citations.length === 0;
    refusalCorrectness = refusedOk ? 1 : 0;
  }

  const latencyMs = Date.now() - startedAt;

  return {
    case_id: c.id,
    answer_fact_coverage: answerFactCoverage,
    fact_hits: factHits,
    fact_total: factTotal,
    forbidden_fact_rate: forbiddenFactRate,
    forbidden_fact_hits: forbiddenFactHits,
    forbidden_fact_total: forbiddenFactTotal,
    citation_hallucination_rate: citationHallucinationRate,
    citation_hallucinations: hallucinations,
    citation_precision_exact: citationPrecisionExact,
    citation_recall_exact: citationRecallExact,
    citation_f1_exact: citationF1Exact,
    citation_precision_hierarchical: citationPrecisionHier,
    citation_recall_hierarchical: citationRecallHier,
    citation_f1_hierarchical: citationF1Hier,
    refusal_correctness: refusalCorrectness,
    generator_degraded: gen.degraded === true,
    forbidden_citation_hits: forbiddenCitationHits,
    citations,
    answer: gen.answer,
    refused: gen.refused,
    judge_calls: judgeCalls,
    judge_degraded_count: judgeDegraded,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    latency_ms: latencyMs,
  };
}

function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}
