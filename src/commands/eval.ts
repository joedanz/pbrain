/**
 * pbrain eval — Unified eval harness CLI (v0.4.0)
 *
 * Subcommand surface:
 *   pbrain eval retrieve --fixtures <path>   # new envelope format
 *   pbrain eval ingest   --fixtures <path>   # stub until PR 3 lands
 *   pbrain eval answer   --fixtures <path>   # stub until PR 4 lands
 *   pbrain eval all      --fixtures-dir <d>  # stub until PR 5 lands
 *
 * Backward-compat (preserved EXACTLY):
 *   pbrain eval --qrels <path|json> [--config-a ...] [--config-b ...] ...
 *
 * Routing rule: if the first non-flag arg is a known subcommand name,
 * consume it and dispatch. Otherwise fall through to legacy retrieval
 * behavior (which requires --qrels). The legacy code path is unchanged
 * from its v0.3.x form — the retrieve subcommand shares the same runner
 * via a different fixture loader.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import {
  runEval,
  parseQrels,
  type EvalConfig,
  type EvalQrel,
  type EvalReport,
} from '../core/search/eval.ts';
import { loadRetrievalFixture } from '../core/eval/retrieval.ts';
import {
  FixtureParseError,
  parseFixture,
  type AnswerFixture,
  type IngestFixture,
} from '../core/eval/fixtures.ts';
import { runIngestEval, type IngestReport } from '../core/eval/ingest.ts';
import { runAnswerEval, type AnswerReport } from '../core/eval/answer.ts';
import { mean, stdev } from '../core/eval/metrics.ts';

type Subcommand = 'retrieve' | 'ingest' | 'answer' | 'all';
const SUBCOMMANDS: ReadonlySet<Subcommand> = new Set(['retrieve', 'ingest', 'answer', 'all']);

export async function runEvalCommand(engine: BrainEngine, args: string[]): Promise<void> {
  // Unified help path (covers bare `pbrain eval`, `--help`, `-h`)
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    return;
  }

  // Subcommand dispatch: first token without a leading `-` picks a stage.
  const first = args[0];
  if (!first.startsWith('-') && SUBCOMMANDS.has(first as Subcommand)) {
    const sub = first as Subcommand;
    const rest = args.slice(1);
    switch (sub) {
      case 'retrieve':
        await runRetrieveSubcommand(engine, rest);
        return;
      case 'ingest':
        await runIngestSubcommand(rest);
        return;
      case 'answer':
        await runAnswerSubcommand(rest);
        return;
      case 'all':
        await runAllSubcommand(engine, rest);
        return;
    }
  }

  // Fallthrough: legacy `pbrain eval --qrels ...` behavior, unchanged.
  await runLegacyQrelsMode(engine, args);
}

// ─────────────────────────────────────────────────────────────────
// ingest subcommand — stage 1 of the v0.4 eval harness
// ─────────────────────────────────────────────────────────────────

async function runIngestSubcommand(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  if (opts.help) { printHelp(); return; }

  if (!opts.fixtures) {
    console.error('Error: `pbrain eval ingest` requires --fixtures <path|json>\n');
    printHelp();
    process.exit(1);
  }

  // Preflight: the judge runs against Anthropic. Surface the missing-key
  // condition here rather than letting the first case crash mid-migration.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY is required for `pbrain eval ingest` (judge calls Anthropic).');
    console.error('Set the env var, or export EVAL_JUDGE_MODEL to override which model the judge uses.');
    process.exit(1);
  }

  let fixture: IngestFixture;
  try {
    const env = parseFixture(opts.fixtures);
    if (env.kind !== 'ingest') {
      console.error(`Error: fixture kind is "${env.kind}"; expected "ingest" (use \`pbrain eval ${env.kind}\` instead)`);
      process.exit(1);
    }
    fixture = env;
  } catch (err) {
    if (err instanceof FixtureParseError) {
      console.error(`Error loading fixture: ${err.message}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error loading fixture: ${msg}`);
    }
    process.exit(1);
  }

  const baseDir = fixturePathBaseDir(opts.fixtures);
  const report = await runIngestEval(fixture, {
    sample: opts.sample,
    baseDir,
  });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printIngestTable(report);
  }
}

function fixturePathBaseDir(input: string): string {
  // If the caller passed inline JSON (leading `{` or `[`), relative source.path
  // values don't make sense; anchor to cwd for that case.
  const trimmed = input.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return process.cwd();
  return dirname(input);
}

function printIngestTable(report: IngestReport): void {
  const cases = report.cases;
  console.log(`\npbrain eval ingest — ${cases.length} case${cases.length === 1 ? '' : 's'}\n`);

  const COL_ID = 40;
  const COL_NUM = 9;
  const header =
    padR('Case', COL_ID) +
    padL('recall', COL_NUM) +
    padL('forbid', COL_NUM) +
    padL('pageF1', COL_NUM) +
    padL('judge', COL_NUM);
  const divider = '─'.repeat(header.length);
  console.log(header);
  console.log(divider);

  for (const m of cases) {
    const recall = m.import_error ? 'ERR' : fmt(m.fact_union_recall);
    const forbid = m.import_error ? '—' : fmt(m.forbidden_fact_rate);
    const pf1 = m.import_error ? '—' : fmt(m.page_f1);
    const judge = String(m.judge_calls);
    console.log(
      padR(truncate(m.case_id, COL_ID - 1), COL_ID) +
      padL(recall, COL_NUM) +
      padL(forbid, COL_NUM) +
      padL(pf1, COL_NUM) +
      padL(judge, COL_NUM),
    );
    if (m.import_error) {
      console.log(`    ↳ ${m.import_error}`);
    }
  }

  console.log(divider);
  console.log(
    padR('Mean', COL_ID) +
    padL(fmt(report.mean.fact_union_recall), COL_NUM) +
    padL(fmt(report.mean.forbidden_fact_rate), COL_NUM) +
    padL(fmt(report.mean.page_f1), COL_NUM) +
    padL(String(report.totals.judge_calls), COL_NUM),
  );

  console.log('');
  console.log(`Totals: judge_calls=${report.totals.judge_calls} tokens_in=${report.totals.tokens_in} tokens_out=${report.totals.tokens_out} latency_ms=${report.totals.latency_ms}`);
  console.log('');
}

// ─────────────────────────────────────────────────────────────────
// answer subcommand — stage 3 of the v0.4 eval harness
// ─────────────────────────────────────────────────────────────────

async function runAnswerSubcommand(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  if (opts.help) { printHelp(); return; }

  if (!opts.fixtures) {
    console.error('Error: `pbrain eval answer` requires --fixtures <path|json>\n');
    printHelp();
    process.exit(1);
  }

  // Preflight: both generator + judge call Anthropic. Fail fast, not mid-case.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY is required for `pbrain eval answer` (generator + judge both call Anthropic).');
    console.error('Set the env var, or export EVAL_GENERATOR_MODEL / EVAL_JUDGE_MODEL to override models.');
    process.exit(1);
  }

  let fixture: AnswerFixture;
  try {
    const env = parseFixture(opts.fixtures);
    if (env.kind !== 'answer') {
      console.error(`Error: fixture kind is "${env.kind}"; expected "answer" (use \`pbrain eval ${env.kind}\` instead)`);
      process.exit(1);
    }
    fixture = env;
  } catch (err) {
    if (err instanceof FixtureParseError) {
      console.error(`Error loading fixture: ${err.message}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error loading fixture: ${msg}`);
    }
    process.exit(1);
  }

  // v0.4.0 PR 4 ships inline-context only. Fail loud if any case is missing
  // retrieved_context — PR 5's orchestrator fills this in from retrieval.
  for (const c of fixture.cases) {
    if (c.retrieved_context === undefined) {
      console.error(`Error: case "${c.id}" is missing retrieved_context. v0.4.0 \`pbrain eval answer\` requires inline retrieved_context on every case. Live retrieval wiring lands in the \`pbrain eval all\` orchestrator (PR 5).`);
      process.exit(1);
    }
  }

  const report = await runAnswerEval(fixture, { sample: opts.sample });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printAnswerTable(report);
  }
}

function printAnswerTable(report: AnswerReport): void {
  const cases = report.cases;
  console.log(`\npbrain eval answer — ${cases.length} case${cases.length === 1 ? '' : 's'}\n`);

  const COL_ID = 36;
  const COL_NUM = 9;
  const header =
    padR('Case', COL_ID) +
    padL('factCov', COL_NUM) +
    padL('forbid', COL_NUM) +
    padL('hallRate', COL_NUM) +
    padL('citF1', COL_NUM) +
    padL('refusal', COL_NUM);
  const divider = '─'.repeat(header.length);
  console.log(header);
  console.log(divider);

  for (const m of cases) {
    const refusal = m.refusal_correctness === -1 ? '—' : fmt(m.refusal_correctness);
    console.log(
      padR(truncate(m.case_id, COL_ID - 1), COL_ID) +
      padL(fmt(m.answer_fact_coverage), COL_NUM) +
      padL(fmt(m.forbidden_fact_rate), COL_NUM) +
      padL(fmt(m.citation_hallucination_rate), COL_NUM) +
      padL(fmt(m.citation_f1_hierarchical), COL_NUM) +
      padL(refusal, COL_NUM),
    );
    if (m.generator_degraded) {
      console.log('    ↳ generator returned degraded (tool_use fallback)');
    }
    if (m.citation_hallucinations.length > 0) {
      console.log(`    ↳ hallucinated citations: ${m.citation_hallucinations.join(', ')}`);
    }
    if (m.forbidden_citation_hits.length > 0) {
      console.log(`    ↳ forbidden citations hit: ${m.forbidden_citation_hits.join(', ')}`);
    }
  }

  console.log(divider);
  const meanRefusal = Number.isFinite(report.mean.refusal_correctness)
    ? fmt(report.mean.refusal_correctness)
    : '—';
  console.log(
    padR('Mean', COL_ID) +
    padL(fmt(report.mean.answer_fact_coverage), COL_NUM) +
    padL(fmt(report.mean.forbidden_fact_rate), COL_NUM) +
    padL(fmt(report.mean.citation_hallucination_rate), COL_NUM) +
    padL(fmt(report.mean.citation_f1_hierarchical), COL_NUM) +
    padL(meanRefusal, COL_NUM),
  );

  console.log('');
  console.log(`Totals: judge_calls=${report.totals.judge_calls} tokens_in=${report.totals.tokens_in} tokens_out=${report.totals.tokens_out} latency_ms=${report.totals.latency_ms}`);
  console.log('');
}

// ─────────────────────────────────────────────────────────────────
// all subcommand — composite orchestrator (v0.4.0 PR 5)
// ─────────────────────────────────────────────────────────────────

/**
 * `pbrain eval all` — composite orchestrator across ingest + retrieval + answer.
 *
 * Discovery model: for `--fixtures-dir <path>`, we look for:
 *   <path>/ingest/baseline.json   OR any <path>/ingest/*.json
 *   <path>/retrieval/baseline.json OR any <path>/retrieval/*.json
 *   <path>/answer/baseline.json    OR any <path>/answer/*.json
 * Missing stages are skipped with a notice — the composite report lists
 * what ran so CI can fail loudly if an expected stage is silently absent.
 *
 * `--runs N` (default 1) runs each stage N times and reports mean + stdev
 * per metric. `--runs 3` is the ship-gate variance-aware path per the v0.4
 * plan. `--sample N` and `--json` forward to each stage.
 *
 * v0.4.0 scope honesty: retrieval runs against the BrainEngine passed in
 * by the CLI (i.e. the user's live brain by default). A frozen seed brain
 * for hermetic retrieval/answer eval is deferred to v0.4.x. Answer eval
 * uses inline retrieved_context from fixtures today (PR 4), which keeps
 * answer decoupled from whatever retrieval returned.
 */
async function runAllSubcommand(engine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseArgs(args);
  if (opts.help) { printHelp(); return; }

  if (!opts.fixturesDir) {
    console.error('Error: `pbrain eval all` requires --fixtures-dir <path>\n');
    printHelp();
    process.exit(1);
  }
  if (!existsSync(opts.fixturesDir) || !statSync(opts.fixturesDir).isDirectory()) {
    console.error(`Error: --fixtures-dir ${opts.fixturesDir} is not a directory`);
    process.exit(1);
  }

  const runs = opts.runs && opts.runs > 0 ? opts.runs : 1;

  const ingestPath = discoverStageFixture(opts.fixturesDir, 'ingest');
  const retrievalPath = discoverStageFixture(opts.fixturesDir, 'retrieval');
  const answerPath = discoverStageFixture(opts.fixturesDir, 'answer');

  if (!ingestPath && !retrievalPath && !answerPath) {
    console.error(`Error: no stage fixtures found under ${opts.fixturesDir}. Expected ingest/ retrieval/ answer/ subdirectories with *.json.`);
    process.exit(1);
  }

  // Preflight API keys only for stages we actually have fixtures for.
  if ((ingestPath || answerPath) && !process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY is required for ingest + answer stages (judge + generator call Anthropic).');
    process.exit(1);
  }

  const composite: CompositeReport = {
    runs,
    stages: {
      ingest: ingestPath ? { fixture_path: ingestPath, runs: [] } : null,
      retrieval: retrievalPath ? { fixture_path: retrievalPath, runs: [] } : null,
      answer: answerPath ? { fixture_path: answerPath, runs: [] } : null,
    },
  };

  for (let i = 0; i < runs; i++) {
    if (ingestPath) {
      const fixture = parseIngestFixtureOrExit(ingestPath);
      const report = await runIngestEval(fixture, {
        sample: opts.sample,
        baseDir: dirname(ingestPath),
      });
      composite.stages.ingest!.runs.push(report);
    }
    if (retrievalPath) {
      const qrels = loadRetrievalFixtureOrExit(retrievalPath);
      const config = buildConfig(opts, 'a');
      const report = await runEval(engine, qrels, config, opts.k ?? 5);
      composite.stages.retrieval!.runs.push(report);
    }
    if (answerPath) {
      const fixture = parseAnswerFixtureOrExit(answerPath);
      // Orchestrator-mode answer eval still uses inline retrieved_context.
      // Live-retrieval wiring lands in v0.4.x once the seed brain is committed.
      for (const c of fixture.cases) {
        if (c.retrieved_context === undefined) {
          console.error(`Error: answer case "${c.id}" is missing retrieved_context. v0.4.0 \`pbrain eval all\` requires inline retrieved_context on every answer case.`);
          process.exit(1);
        }
      }
      const report = await runAnswerEval(fixture, { sample: opts.sample });
      composite.stages.answer!.runs.push(report);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(composite, null, 2));
  } else {
    printCompositeReport(composite);
  }
}

// ─────────────────────────────────────────────────────────────────
// Orchestrator helpers — fixture discovery + parse-or-exit
// ─────────────────────────────────────────────────────────────────

/**
 * Look for a stage fixture under `<dir>/<stage>/`. Preference order:
 *   1. `<dir>/<stage>/baseline.json`
 *   2. `<dir>/<stage>/baseline/baseline.json` (nested pattern PR 3 uses for ingest)
 *   3. First *.json in `<dir>/<stage>/` (sorted)
 * Returns undefined if none found. Does NOT follow symlinks, doesn't recurse.
 *
 * Exported for unit testing — the orchestrator's file-discovery behavior is
 * the novel logic worth pinning down.
 */
export function discoverStageFixture(dir: string, stage: 'ingest' | 'retrieval' | 'answer'): string | undefined {
  const stageDir = join(dir, stage);
  if (!existsSync(stageDir) || !statSync(stageDir).isDirectory()) return undefined;

  const direct = join(stageDir, 'baseline.json');
  if (existsSync(direct) && statSync(direct).isFile()) return direct;

  const nested = join(stageDir, 'baseline', 'baseline.json');
  if (existsSync(nested) && statSync(nested).isFile()) return nested;

  const jsons = readdirSync(stageDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (jsons.length > 0) return join(stageDir, jsons[0]);

  return undefined;
}

function parseIngestFixtureOrExit(path: string): IngestFixture {
  try {
    const env = parseFixture(path);
    if (env.kind !== 'ingest') {
      console.error(`Error: ${path} kind is "${env.kind}"; expected "ingest"`);
      process.exit(1);
    }
    return env;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error loading ingest fixture ${path}: ${msg}`);
    process.exit(1);
  }
}

function parseAnswerFixtureOrExit(path: string): AnswerFixture {
  try {
    const env = parseFixture(path);
    if (env.kind !== 'answer') {
      console.error(`Error: ${path} kind is "${env.kind}"; expected "answer"`);
      process.exit(1);
    }
    return env;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error loading answer fixture ${path}: ${msg}`);
    process.exit(1);
  }
}

function loadRetrievalFixtureOrExit(path: string): EvalQrel[] {
  try {
    return loadRetrievalFixture(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error loading retrieval fixture ${path}: ${msg}`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────
// Composite report shape + rendering
// ─────────────────────────────────────────────────────────────────

interface StageSlot<R> {
  fixture_path: string;
  runs: R[];
}

interface CompositeReport {
  runs: number;
  stages: {
    ingest: StageSlot<IngestReport> | null;
    retrieval: StageSlot<EvalReport> | null;
    answer: StageSlot<AnswerReport> | null;
  };
}

/**
 * Render a composite report. For --runs N with N > 1, we emit mean ± stdev
 * on the ship-gate metrics so regression detection can distinguish noise
 * from signal (plan: "require (baseline_mean - candidate_mean) > 2 * candidate_stdev").
 */
function printCompositeReport(c: CompositeReport): void {
  const header = c.runs === 1
    ? 'pbrain eval all'
    : `pbrain eval all — ${c.runs} runs (mean ± stdev on ship-gate metrics)`;
  console.log(`\n${header}\n`);

  if (c.stages.ingest) {
    console.log('── ingest ──');
    const metric = (pick: (r: IngestReport) => number) => c.stages.ingest!.runs.map(pick);
    renderMetricLine('fact_union_recall', metric((r) => r.mean.fact_union_recall), c.runs);
    renderMetricLine('forbidden_fact_rate', metric((r) => r.mean.forbidden_fact_rate), c.runs);
    renderMetricLine('page_f1', metric((r) => r.mean.page_f1), c.runs);
    console.log(`  fixture: ${c.stages.ingest.fixture_path}`);
    console.log('');
  }

  if (c.stages.retrieval) {
    console.log('── retrieval ──');
    const metric = (pick: (r: EvalReport) => number) => c.stages.retrieval!.runs.map(pick);
    renderMetricLine('precision', metric((r) => r.mean_precision), c.runs);
    renderMetricLine('recall', metric((r) => r.mean_recall), c.runs);
    renderMetricLine('mrr', metric((r) => r.mean_mrr), c.runs);
    renderMetricLine('ndcg', metric((r) => r.mean_ndcg), c.runs);
    console.log(`  fixture: ${c.stages.retrieval.fixture_path}`);
    console.log('');
  }

  if (c.stages.answer) {
    console.log('── answer ──');
    const metric = (pick: (r: AnswerReport) => number) => c.stages.answer!.runs.map(pick);
    renderMetricLine('answer_fact_coverage', metric((r) => r.mean.answer_fact_coverage), c.runs);
    renderMetricLine('forbidden_fact_rate', metric((r) => r.mean.forbidden_fact_rate), c.runs);
    renderMetricLine('citation_hallucination_rate', metric((r) => r.mean.citation_hallucination_rate), c.runs);
    renderMetricLine('citation_f1_hierarchical', metric((r) => r.mean.citation_f1_hierarchical), c.runs);
    const refusalPerRun = c.stages.answer.runs.map((r) => r.mean.refusal_correctness);
    renderMetricLine('refusal_correctness', refusalPerRun, c.runs);
    console.log(`  fixture: ${c.stages.answer.fixture_path}`);
    console.log('');
  }
}

function renderMetricLine(name: string, values: number[], runs: number): void {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) {
    console.log(`  ${padR(name, 32)} —`);
    return;
  }
  const m = mean(finite);
  if (runs === 1) {
    console.log(`  ${padR(name, 32)} ${fmt(m)}`);
  } else {
    const s = stdev(finite);
    console.log(`  ${padR(name, 32)} ${fmt(m)} ± ${fmt(s)}`);
  }
}

// ─────────────────────────────────────────────────────────────────
// retrieve subcommand — new fixture envelope entry point
// ─────────────────────────────────────────────────────────────────

async function runRetrieveSubcommand(engine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseArgs(args);

  if (opts.help) {
    printHelp();
    return;
  }

  const fixturePath = opts.fixtures;
  if (!fixturePath) {
    console.error('Error: `pbrain eval retrieve` requires --fixtures <path|json>\n');
    printHelp();
    process.exit(1);
  }

  let qrels: EvalQrel[];
  try {
    qrels = loadRetrievalFixture(fixturePath);
  } catch (err) {
    if (err instanceof FixtureParseError) {
      console.error(`Error loading fixture: ${err.message}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error loading fixture: ${msg}`);
    }
    process.exit(1);
  }

  if (qrels.length === 0) {
    console.error('Error: fixture contains no retrieval cases');
    process.exit(1);
  }

  await runRetrievalReports(engine, qrels, opts);
}

// ─────────────────────────────────────────────────────────────────
// Legacy --qrels mode — unchanged behavior
// ─────────────────────────────────────────────────────────────────

async function runLegacyQrelsMode(engine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseArgs(args);

  if (opts.help) {
    printHelp();
    return;
  }

  if (!opts.qrels) {
    console.error('Error: --qrels <path|json> is required\n');
    printHelp();
    process.exit(1);
  }

  let qrels: EvalQrel[];
  try {
    qrels = parseQrels(opts.qrels);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error loading qrels: ${msg}`);
    process.exit(1);
  }

  if (qrels.length === 0) {
    console.error('Error: qrels file contains no queries');
    process.exit(1);
  }

  await runRetrievalReports(engine, qrels, opts);
}

// ─────────────────────────────────────────────────────────────────
// Shared retrieval runner — used by both retrieve subcommand + legacy mode
// ─────────────────────────────────────────────────────────────────

async function runRetrievalReports(
  engine: BrainEngine,
  qrels: EvalQrel[],
  opts: ParsedArgs,
): Promise<void> {
  const k = opts.k ?? 5;
  const configA = buildConfig(opts, 'a');

  if (opts.configBPath) {
    const configB = buildConfig(opts, 'b');
    const [reportA, reportB] = await Promise.all([
      runEval(engine, qrels, configA, k),
      runEval(engine, qrels, configB, k),
    ]);
    printABTable(reportA, reportB, k);
  } else {
    const report = await runEval(engine, qrels, configA, k);
    printSingleTable(report);
  }
}

// ─────────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────────

interface ParsedArgs {
  help: boolean;
  qrels?: string;
  fixtures?: string;
  /** `pbrain eval all --fixtures-dir <path>`: discovers per-stage fixtures. */
  fixturesDir?: string;
  configAPath?: string;
  configBPath?: string;
  strategy?: EvalConfig['strategy'];
  rrfK?: number;
  expand?: boolean;
  dedupCosine?: number;
  dedupTypeRatio?: number;
  dedupMaxPerPage?: number;
  limit?: number;
  k?: number;
  /** Ingest/answer: run only the first N cases. */
  sample?: number;
  /**
   * Orchestrator: re-run each stage this many times, report mean ± stdev on
   * ship-gate metrics. Default 1. `--runs 3` is the ship-gate variance-aware
   * path per the v0.4 plan.
   */
  runs?: number;
  /** Emit machine-readable JSON instead of the text table. */
  json?: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const opts: ParsedArgs = { help: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--help': case '-h': opts.help = true; break;
      case '--qrels': opts.qrels = next; i++; break;
      case '--fixtures': opts.fixtures = next; i++; break;
      case '--config-a': opts.configAPath = next; i++; break;
      case '--config-b': opts.configBPath = next; i++; break;
      case '--strategy': opts.strategy = next as EvalConfig['strategy']; i++; break;
      case '--rrf-k': opts.rrfK = parseInt(next, 10); i++; break;
      case '--expand': opts.expand = true; break;
      case '--no-expand': opts.expand = false; break;
      case '--dedup-cosine': opts.dedupCosine = parseFloat(next); i++; break;
      case '--dedup-type-ratio': opts.dedupTypeRatio = parseFloat(next); i++; break;
      case '--dedup-max-per-page': opts.dedupMaxPerPage = parseInt(next, 10); i++; break;
      case '--limit': opts.limit = parseInt(next, 10); i++; break;
      case '--k': opts.k = parseInt(next, 10); i++; break;
      case '--sample': opts.sample = parseInt(next, 10); i++; break;
      case '--runs': opts.runs = parseInt(next, 10); i++; break;
      case '--fixtures-dir': opts.fixturesDir = next; i++; break;
      case '--json': opts.json = true; break;
    }
  }

  return opts;
}

function buildConfig(opts: ParsedArgs, side: 'a' | 'b'): EvalConfig {
  const pathOpt = side === 'a' ? opts.configAPath : opts.configBPath;

  let base: EvalConfig = {};
  if (pathOpt) {
    base = loadConfigFile(pathOpt);
  }

  if (side === 'a') {
    if (opts.strategy !== undefined) base.strategy = opts.strategy;
    if (opts.rrfK !== undefined) base.rrf_k = opts.rrfK;
    if (opts.expand !== undefined) base.expand = opts.expand;
    if (opts.dedupCosine !== undefined) base.dedup_cosine_threshold = opts.dedupCosine;
    if (opts.dedupTypeRatio !== undefined) base.dedup_type_ratio = opts.dedupTypeRatio;
    if (opts.dedupMaxPerPage !== undefined) base.dedup_max_per_page = opts.dedupMaxPerPage;
    if (opts.limit !== undefined) base.limit = opts.limit;

    if (!base.name) base.name = 'Config A';
    if (!base.strategy) base.strategy = 'hybrid';
  } else {
    if (!base.name) base.name = 'Config B';
    if (!base.strategy) base.strategy = 'hybrid';
  }

  return base;
}

function loadConfigFile(pathOrJson: string): EvalConfig {
  const trimmed = pathOrJson.trimStart();
  if (trimmed.startsWith('{')) {
    return JSON.parse(pathOrJson) as EvalConfig;
  }
  if (!existsSync(pathOrJson)) {
    console.error(`Config file not found: ${pathOrJson}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(pathOrJson, 'utf-8')) as EvalConfig;
}

// ─────────────────────────────────────────────────────────────────
// Output formatting
// ─────────────────────────────────────────────────────────────────

function printSingleTable(report: EvalReport): void {
  const { config, k, queries } = report;
  const label = config.name ?? config.strategy ?? 'hybrid';

  console.log(`\npbrain eval — ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'} · strategy: ${label} · k=${k}\n`);

  const COL_QUERY = 36;
  const COL_NUM = 7;
  const header = padR('Query', COL_QUERY) + padL(`P@${k}`, COL_NUM) + padL(`R@${k}`, COL_NUM) + padL('MRR', COL_NUM) + padL(`nDCG@${k}`, COL_NUM);
  const divider = '─'.repeat(header.length);

  console.log(header);
  console.log(divider);

  for (const q of queries) {
    console.log(
      padR(truncate(q.query, COL_QUERY - 1), COL_QUERY) +
      padL(fmt(q.precision_at_k), COL_NUM) +
      padL(fmt(q.recall_at_k), COL_NUM) +
      padL(fmt(q.mrr), COL_NUM) +
      padL(fmt(q.ndcg_at_k), COL_NUM),
    );
  }

  console.log(divider);
  console.log(
    padR('Mean', COL_QUERY) +
    padL(fmt(report.mean_precision), COL_NUM) +
    padL(fmt(report.mean_recall), COL_NUM) +
    padL(fmt(report.mean_mrr), COL_NUM) +
    padL(fmt(report.mean_ndcg), COL_NUM),
  );
  console.log('');
}

function printABTable(reportA: EvalReport, reportB: EvalReport, k: number): void {
  const labelA = reportA.config.name ?? 'Config A';
  const labelB = reportB.config.name ?? 'Config B';
  const n = reportA.queries.length;

  console.log(`\npbrain eval — ${n} quer${n === 1 ? 'y' : 'ies'} · A/B comparison · k=${k}\n`);

  const COL_QUERY = 34;
  const COL_METRIC = 8;
  const COLS_PER_SIDE = 3;

  const aLabel = ` ${labelA} `.slice(0, COL_METRIC * COLS_PER_SIDE - 2);
  const bLabel = ` ${labelB} `.slice(0, COL_METRIC * COLS_PER_SIDE - 2);
  const line1 =
    ' '.repeat(COL_QUERY) +
    padR(`── ${aLabel} `, COL_METRIC * COLS_PER_SIDE) +
    padR(`── ${bLabel} `, COL_METRIC * COLS_PER_SIDE) +
    `  Δ nDCG`;
  console.log(line1);

  const metricHeader = () =>
    padL(`P@${k}`, COL_METRIC) + padL('MRR', COL_METRIC) + padL(`nDCG@${k}`, COL_METRIC);

  const line2 =
    padR('Query', COL_QUERY) +
    metricHeader() +
    '  ' + metricHeader() +
    '  ' + padL('Δ nDCG', 10);
  console.log(line2);
  console.log('─'.repeat(line2.length));

  for (let i = 0; i < reportA.queries.length; i++) {
    const qa = reportA.queries[i];
    const qb = reportB.queries[i];
    const delta = qb.ndcg_at_k - qa.ndcg_at_k;
    const deltaStr = delta > 0 ? `+${fmt(delta)}` : fmt(delta);

    console.log(
      padR(truncate(qa.query, COL_QUERY - 1), COL_QUERY) +
      padL(fmt(qa.precision_at_k), COL_METRIC) +
      padL(fmt(qa.mrr), COL_METRIC) +
      padL(fmt(qa.ndcg_at_k), COL_METRIC) +
      '  ' +
      padL(fmt(qb.precision_at_k), COL_METRIC) +
      padL(fmt(qb.mrr), COL_METRIC) +
      padL(fmt(qb.ndcg_at_k), COL_METRIC) +
      '  ' + padL(deltaStr, 10),
    );
  }

  const divider = '─'.repeat(line2.length);
  console.log(divider);

  const meanDelta = reportB.mean_ndcg - reportA.mean_ndcg;
  const meanDeltaStr = (meanDelta > 0 ? '+' : '') + fmt(meanDelta);
  const winner = meanDelta > 0 ? ' ✓ B wins' : meanDelta < 0 ? ' ✓ A wins' : ' tie';

  console.log(
    padR('Mean', COL_QUERY) +
    padL(fmt(reportA.mean_precision), COL_METRIC) +
    padL(fmt(reportA.mean_mrr), COL_METRIC) +
    padL(fmt(reportA.mean_ndcg), COL_METRIC) +
    '  ' +
    padL(fmt(reportB.mean_precision), COL_METRIC) +
    padL(fmt(reportB.mean_mrr), COL_METRIC) +
    padL(fmt(reportB.mean_ndcg), COL_METRIC) +
    '  ' + padL(meanDeltaStr + winner, 10),
  );
  console.log('');
}

// ─────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return n.toFixed(2);
}

function padR(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

function padL(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : ' '.repeat(width - s.length) + s;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function printHelp(): void {
  console.log(`
pbrain eval — measure and compare retrieval, ingest, and answer quality

USAGE
  pbrain eval retrieve --fixtures <path>     measure search quality (v0.4 form)
  pbrain eval ingest   --fixtures <path>     measure markdown-ingest fact capture
  pbrain eval answer   --fixtures <path>     measure answer-generation quality + citation accuracy
  pbrain eval all      --fixtures-dir <dir>  run ingest + retrieval + answer in one pass
  pbrain eval --qrels <path>                  legacy alias for \`retrieve\`

RETRIEVE / LEGACY OPTIONS
  --qrels <path|json>         Legacy qrels file (aliases \`retrieve\`)
                              Or inline JSON: '[{"query":"...","relevant":["slug"]}]'
  --fixtures <path|json>      v0.4 retrieval fixture (envelope: kind=retrieval)
  --config-a <path|json>      Config for strategy A (default: hybrid with defaults)
  --config-b <path|json>      Config for strategy B (triggers A/B mode)
  --strategy <s>              Search strategy: hybrid | keyword | vector
  --rrf-k <n>                 Override RRF K constant (default: 60)
  --expand / --no-expand      Enable/disable multi-query expansion
  --dedup-cosine <f>          Override cosine dedup threshold (default: 0.85)
  --dedup-type-ratio <f>      Override type ratio cap (default: 0.6)
  --dedup-max-per-page <n>    Override max chunks per page (default: 2)
  --limit <n>                 Max results to fetch per query (default: 10)
  --k <n>                     Metric cutoff depth (default: 5)

INGEST OPTIONS
  --fixtures <path|json>      v0.4 ingest fixture (envelope: kind=ingest)
  --sample <n>                Run only the first N cases (dev-loop speed)
  --json                      Machine-readable JSON output

ANSWER OPTIONS
  --fixtures <path|json>      v0.4 answer fixture (envelope: kind=answer)
                              Each case must carry retrieved_context inline.
  --sample <n>                Run only the first N cases (dev-loop speed)
  --json                      Machine-readable JSON output

ALL (ORCHESTRATOR) OPTIONS
  --fixtures-dir <dir>        Directory containing ingest/ retrieval/ answer/
                              subdirs with baseline.json fixtures. Missing
                              stages are skipped with a notice.
  --sample <n>                Forwarded to each stage (dev-loop speed)
  --runs <n>                  Re-run each stage N times; report mean ± stdev
                              on ship-gate metrics (default 1). --runs 3 is
                              the variance-aware ship-gate path.
  --json                      Machine-readable JSON output
  --strategy/--rrf-k/...      Retrieval config flags forward into the
                              retrieval stage (same as \`pbrain eval retrieve\`)

LEGACY QRELS FORMAT (--qrels)
  {
    "version": 1,
    "queries": [
      {
        "query": "who founded NovaMind",
        "relevant": ["people/sarah-chen", "companies/novamind"],
        "grades": { "people/sarah-chen": 3, "companies/novamind": 2 }
      }
    ]
  }

V0.4 FIXTURE ENVELOPE (--fixtures)
  {
    "version": 1,
    "kind": "retrieval",
    "meta": { "description": "..." },
    "cases": [{ "query": "...", "relevant": ["slug"], "grades": { "slug": 3 } }]
  }

CONFIG FORMAT
  { "name": "rrf-k-30", "strategy": "hybrid", "rrf_k": 30, "expand": false }

EXAMPLES
  pbrain eval --qrels ./legacy.json
  pbrain eval retrieve --fixtures ./fixtures/retrieval/baseline.json
  pbrain eval retrieve --fixtures ./baseline.json --config-a a.json --config-b b.json
  pbrain eval retrieve --fixtures ./baseline.json --strategy keyword
  pbrain eval ingest   --fixtures ./fixtures/ingest/baseline/baseline.json --sample 1
  pbrain eval ingest   --fixtures ./baseline.json --json > runs/ingest.json
  pbrain eval answer   --fixtures ./fixtures/answer/baseline.json --sample 1
  pbrain eval answer   --fixtures ./baseline.json --json > runs/answer.json
  pbrain eval all      --fixtures-dir ./test/fixtures/eval/ --sample 3
  pbrain eval all      --fixtures-dir ./test/fixtures/eval/ --runs 3 --json > runs/candidate.json
`.trim());
}
