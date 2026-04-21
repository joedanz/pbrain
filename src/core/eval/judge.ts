/**
 * Asymmetric-tier LLM judge for the pbrain eval harness.
 *
 * Default generator = Haiku-tier (used by pbrain's ingest + answer stages).
 * Default judge = Sonnet-tier via EVAL_JUDGE_MODEL env. Exact snapshot pin,
 * NOT a family alias, so calibration drift is loud when the pin changes.
 *
 * Scope honesty (from the v0.4.0 plan review): Haiku and Sonnet are the same
 * family. This is tier-only decorrelation (~30% bias reduction per Zheng 2023),
 * not true cross-family separation. Cross-family judge is deferred to v0.4.x.
 */

import Anthropic from '@anthropic-ai/sdk';

// ─────────────────────────────────────────────────────────────────
// Model pin (centralized — referenced by calibration artifact too)
// ─────────────────────────────────────────────────────────────────

export const DEFAULT_JUDGE_MODEL = 'claude-sonnet-4-5-20250929';

/**
 * Resolve the judge model from env with fallback to the pinned default.
 * Centralized so tests + drift-detector + calibration artifact can align.
 */
export function getJudgeModel(): string {
  return process.env.EVAL_JUDGE_MODEL || DEFAULT_JUDGE_MODEL;
}

// ─────────────────────────────────────────────────────────────────
// Anthropic client (lazy singleton — same pattern as search/expansion.ts)
// ─────────────────────────────────────────────────────────────────

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

/** Reset the client singleton — test-only escape hatch. */
export function __resetJudgeClientForTests(): void {
  anthropicClient = null;
}

// ─────────────────────────────────────────────────────────────────
// Judge verdict shape
// ─────────────────────────────────────────────────────────────────

export type Verdict = 'yes' | 'no';

export interface JudgeResult {
  verdict: Verdict;
  reason: string;
  judge_model: string;
  /** Raw tokens for cost accounting. */
  tokens_in?: number;
  tokens_out?: number;
  /** True when structured-output parsing fell back to heuristic extraction. */
  degraded?: boolean;
}

// ─────────────────────────────────────────────────────────────────
// Core judge call — single-fact yes/no with rationale
// ─────────────────────────────────────────────────────────────────

/**
 * Ask the judge whether TEXT expresses FACT. Uses tool_use to get structured
 * output deterministically. Temperature 0, 5-token output cap on verdict
 * via schema constraint — the reason token budget lives separately.
 *
 * The prompt decomposes "normalize then check" per Liu 2023 (G-Eval). Dates
 * and names get normalized before equivalence is judged, which dramatically
 * reduces false-negatives on surface-form mismatches ("last year" vs 2025).
 */
export async function judgeFactExpressed(text: string, fact: string, opts?: {
  model?: string;
  systemOverride?: string;
}): Promise<JudgeResult> {
  const model = opts?.model || getJudgeModel();
  const systemText = opts?.systemOverride || DEFAULT_JUDGE_SYSTEM;

  const response = await getClient().messages.create({
    model,
    max_tokens: 200,
    temperature: 0,
    system: systemText,
    tools: [
      {
        name: 'record_verdict',
        description: 'Record whether the TEXT expresses the FACT.',
        input_schema: {
          type: 'object' as const,
          properties: {
            reason: {
              type: 'string',
              description: 'One-sentence rationale for the verdict.',
            },
            verdict: {
              type: 'string',
              enum: ['yes', 'no'],
              description: 'yes if TEXT expresses FACT; no otherwise.',
            },
          },
          required: ['reason', 'verdict'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'record_verdict' },
    messages: [
      {
        role: 'user',
        content: `TEXT:\n${text}\n\nFACT:\n${fact}`,
      },
    ],
  });

  const tokensIn = response.usage?.input_tokens;
  const tokensOut = response.usage?.output_tokens;

  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'record_verdict') {
      const input = block.input as { reason?: unknown; verdict?: unknown };
      const verdict = input.verdict === 'yes' ? 'yes' : input.verdict === 'no' ? 'no' : null;
      const reason = typeof input.reason === 'string' ? input.reason : '';
      if (verdict !== null) {
        return {
          verdict,
          reason,
          judge_model: model,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
        };
      }
    }
  }

  // Degraded fallback: the tool_use block didn't parse cleanly. This should
  // be rare with tool_choice forcing the tool. Treat as 'no' with a warning
  // so an unparseable response never silently credits a fact.
  return {
    verdict: 'no',
    reason: 'judge returned unparseable response; defaulted to no',
    judge_model: model,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    degraded: true,
  };
}

// ─────────────────────────────────────────────────────────────────
// Judge system prompt (versioned constant)
// ─────────────────────────────────────────────────────────────────

export const DEFAULT_JUDGE_SYSTEM = `You judge whether a TEXT expresses a specific FACT about a pbrain knowledge page.

Follow two steps before deciding:
1. NORMALIZE. Internally rewrite both TEXT and FACT in canonical form. Resolve relative dates ("last Thursday") to absolute dates when inferable. Expand abbreviated names to their fullest form used in TEXT.
2. CHECK. Does TEXT say the normalized FACT is true? Consider all of the page content given (compiled_truth, timeline, frontmatter, linked pages).

Answer "yes" only if TEXT explicitly states or directly entails FACT. Answer "no" if FACT is absent, ambiguous, contradicted, or only indirectly implied.

Bias against false positives: when unsure, answer "no". Do not infer facts not present in TEXT.

Call the record_verdict tool with a one-sentence reason and your verdict.`;

// ─────────────────────────────────────────────────────────────────
// Calibration artifact + agreement computation
// ─────────────────────────────────────────────────────────────────

/** One row of a committed judge-calibration JSONL file. */
export interface CalibrationRow {
  input: {
    text: string;
    fact: string;
  };
  human_label: Verdict;
  judge_verdict: Verdict;
  judge_model: string;
  /** Free-form note from the curator; not used in agreement math. */
  note?: string;
}

/**
 * Compute agreement between two label arrays, in [0, 1]. Used for the
 * committed calibration test: re-run the judge on stored inputs and compare.
 */
export function computeAgreement(
  humanLabels: Verdict[],
  judgeLabels: Verdict[],
): number {
  if (humanLabels.length !== judgeLabels.length) {
    throw new Error(
      `calibration mismatch: human labels (${humanLabels.length}) vs judge labels (${judgeLabels.length})`,
    );
  }
  if (humanLabels.length === 0) return 0;
  let agree = 0;
  for (let i = 0; i < humanLabels.length; i++) {
    if (humanLabels[i] === judgeLabels[i]) agree++;
  }
  return agree / humanLabels.length;
}

/**
 * Parse a calibration file (JSONL; one row per line). Returns the rows.
 * Validation is strict: every row must have the full shape or the file is rejected.
 */
export function parseCalibrationFile(raw: string): CalibrationRow[] {
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  return lines.map((line, idx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new Error(
        `calibration line ${idx + 1}: invalid JSON (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    return validateCalibrationRow(parsed, idx);
  });
}

function validateCalibrationRow(raw: unknown, idx: number): CalibrationRow {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`calibration row ${idx + 1}: must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.input !== 'object' || obj.input === null) {
    throw new Error(`calibration row ${idx + 1}: input must be an object`);
  }
  const input = obj.input as Record<string, unknown>;
  if (typeof input.text !== 'string' || typeof input.fact !== 'string') {
    throw new Error(`calibration row ${idx + 1}: input.text and input.fact must be strings`);
  }
  const hl = obj.human_label;
  const jv = obj.judge_verdict;
  if (hl !== 'yes' && hl !== 'no') {
    throw new Error(`calibration row ${idx + 1}: human_label must be "yes" or "no"`);
  }
  if (jv !== 'yes' && jv !== 'no') {
    throw new Error(`calibration row ${idx + 1}: judge_verdict must be "yes" or "no"`);
  }
  if (typeof obj.judge_model !== 'string' || obj.judge_model.length === 0) {
    throw new Error(`calibration row ${idx + 1}: judge_model must be a non-empty string`);
  }
  return {
    input: { text: input.text, fact: input.fact },
    human_label: hl,
    judge_verdict: jv,
    judge_model: obj.judge_model,
    note: typeof obj.note === 'string' ? obj.note : undefined,
  };
}
