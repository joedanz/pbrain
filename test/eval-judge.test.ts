/**
 * Tests for src/core/eval/judge.ts.
 *
 * Two layers:
 *   1. Pure unit tests — parseCalibrationFile, computeAgreement, getJudgeModel.
 *      No network, always run.
 *   2. Calibration integration tests — re-run the judge on committed rows,
 *      require agreement >= 0.9. Gated on ANTHROPIC_API_KEY; skips cleanly
 *      when absent (dev) and fails CI when the key is present.
 *
 * The committed calibration JSONL artifacts don't exist yet (they ship in
 * PRs 3 + 4 with the ingest/answer stages that need them). The Layer-2
 * test framework is present here so the judge contract is testable before
 * the calibration data lands.
 */

import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  getJudgeModel,
  DEFAULT_JUDGE_MODEL,
  parseCalibrationFile,
  computeAgreement,
  type Verdict,
  type CalibrationRow,
} from '../src/core/eval/judge.ts';

// ─────────────────────────────────────────────────────────────────
// Layer 1: pure unit tests
// ─────────────────────────────────────────────────────────────────

describe('getJudgeModel', () => {
  test('falls back to DEFAULT_JUDGE_MODEL when env unset', () => {
    const saved = process.env.EVAL_JUDGE_MODEL;
    delete process.env.EVAL_JUDGE_MODEL;
    try {
      expect(getJudgeModel()).toBe(DEFAULT_JUDGE_MODEL);
    } finally {
      if (saved !== undefined) process.env.EVAL_JUDGE_MODEL = saved;
    }
  });

  test('honors EVAL_JUDGE_MODEL when set', () => {
    const saved = process.env.EVAL_JUDGE_MODEL;
    process.env.EVAL_JUDGE_MODEL = 'claude-opus-4-1-20251120';
    try {
      expect(getJudgeModel()).toBe('claude-opus-4-1-20251120');
    } finally {
      if (saved === undefined) delete process.env.EVAL_JUDGE_MODEL;
      else process.env.EVAL_JUDGE_MODEL = saved;
    }
  });

  test('DEFAULT_JUDGE_MODEL is a pinned snapshot, not a family alias', () => {
    // Protects against reverting the pin to "sonnet" or similar.
    // The whole point of the pin is that judge drift is loud.
    expect(DEFAULT_JUDGE_MODEL).toMatch(/^claude-.+-\d{8}$/);
  });
});

describe('computeAgreement', () => {
  test('100% agreement → 1.0', () => {
    expect(computeAgreement(['yes', 'no', 'yes'], ['yes', 'no', 'yes'])).toBe(1);
  });

  test('no agreement → 0.0', () => {
    expect(computeAgreement(['yes', 'no'], ['no', 'yes'])).toBe(0);
  });

  test('half agreement → 0.5', () => {
    expect(computeAgreement(['yes', 'no', 'yes', 'no'], ['yes', 'yes', 'no', 'no'])).toBe(0.5);
  });

  test('empty arrays → 0 (avoid NaN)', () => {
    expect(computeAgreement([], [])).toBe(0);
  });

  test('length mismatch throws', () => {
    expect(() => computeAgreement(['yes'], ['yes', 'no'])).toThrow(/calibration mismatch/);
  });
});

describe('parseCalibrationFile', () => {
  const validRow = (label: Verdict, judge: Verdict) => JSON.stringify({
    input: { text: 'some page content', fact: 'a fact about it' },
    human_label: label,
    judge_verdict: judge,
    judge_model: 'claude-sonnet-4-5-20250929',
    note: 'curator note',
  });

  test('parses a well-formed 3-row file', () => {
    const raw = [validRow('yes', 'yes'), validRow('no', 'no'), validRow('yes', 'no')].join('\n');
    const rows = parseCalibrationFile(raw);
    expect(rows).toHaveLength(3);
    expect(rows[0].human_label).toBe('yes');
    expect(rows[2].judge_verdict).toBe('no');
  });

  test('skips blank lines at end of file', () => {
    const raw = validRow('yes', 'yes') + '\n\n\n';
    expect(parseCalibrationFile(raw)).toHaveLength(1);
  });

  test('rejects invalid JSON on a specific line', () => {
    const raw = validRow('yes', 'yes') + '\n{ not json }';
    expect(() => parseCalibrationFile(raw)).toThrow(/line 2/);
  });

  test('rejects missing input.text', () => {
    const bad = JSON.stringify({
      input: { fact: 'x' },
      human_label: 'yes', judge_verdict: 'yes', judge_model: 'm',
    });
    expect(() => parseCalibrationFile(bad)).toThrow(/input\.text/);
  });

  test('rejects invalid verdict value', () => {
    const bad = JSON.stringify({
      input: { text: 't', fact: 'f' },
      human_label: 'maybe', judge_verdict: 'yes', judge_model: 'm',
    });
    expect(() => parseCalibrationFile(bad)).toThrow(/human_label/);
  });

  test('rejects missing judge_model', () => {
    const bad = JSON.stringify({
      input: { text: 't', fact: 'f' },
      human_label: 'yes', judge_verdict: 'yes',
    });
    expect(() => parseCalibrationFile(bad)).toThrow(/judge_model/);
  });

  test('note field is optional', () => {
    const minimal = JSON.stringify({
      input: { text: 't', fact: 'f' },
      human_label: 'yes', judge_verdict: 'yes',
      judge_model: 'claude-sonnet-4-5-20250929',
    });
    const rows = parseCalibrationFile(minimal);
    expect(rows[0].note).toBeUndefined();
  });

  test('round-trips a human-label-vs-judge-verdict disagreement pair', () => {
    const raw = [validRow('yes', 'no'), validRow('no', 'yes')].join('\n');
    const rows = parseCalibrationFile(raw);
    const agreement = computeAgreement(
      rows.map(r => r.human_label),
      rows.map(r => r.judge_verdict),
    );
    expect(agreement).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// Layer 2: calibration integration tests (API-key-gated)
// ─────────────────────────────────────────────────────────────────
//
// When test/fixtures/eval/judge-calibration/<stage>.jsonl exists AND
// ANTHROPIC_API_KEY is set, re-run the judge on each row and assert
// agreement ≥ 0.9 per the plan's ship-gate contract.
//
// When either is absent, these tests skip cleanly (so `bun test` stays
// fast in dev without keys, while CI with keys exercises the full gate).

const CALIBRATION_DIR = 'test/fixtures/eval/judge-calibration';
const CALIBRATION_STAGES = ['ingest', 'answer'] as const;
const MIN_AGREEMENT = 0.9;

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
const describeCalibration = hasKey ? describe : describe.skip;

describeCalibration('calibration artifacts (API-key-gated)', () => {
  for (const stage of CALIBRATION_STAGES) {
    const path = join(CALIBRATION_DIR, `${stage}.jsonl`);
    const fileExists = existsSync(path);
    const testOrSkip = fileExists ? test : test.skip;

    testOrSkip(`${stage}.jsonl: judge agreement ≥ ${MIN_AGREEMENT}`, async () => {
      const raw = readFileSync(path, 'utf-8');
      const rows = parseCalibrationFile(raw);
      expect(rows.length).toBeGreaterThanOrEqual(50);

      // Re-run the judge on each row and compare verdicts.
      // Imported lazily so the network-free test pass doesn't touch the SDK.
      const { judgeFactExpressed } = await import('../src/core/eval/judge.ts');
      const freshVerdicts: Verdict[] = [];
      for (const row of rows) {
        const result = await judgeFactExpressed(row.input.text, row.input.fact);
        freshVerdicts.push(result.verdict);
      }
      const agreement = computeAgreement(
        rows.map((r: CalibrationRow) => r.human_label),
        freshVerdicts,
      );
      expect(agreement).toBeGreaterThanOrEqual(MIN_AGREEMENT);
    }, 120_000); // generous timeout; 50 judge calls at T=0 sonnet ≈ 30-60s
  }
});
