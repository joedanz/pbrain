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

import { readFileSync, existsSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';
import {
  runEval,
  parseQrels,
  type EvalConfig,
  type EvalQrel,
  type EvalReport,
} from '../core/search/eval.ts';
import { loadRetrievalFixture } from '../core/eval/retrieval.ts';
import { FixtureParseError } from '../core/eval/fixtures.ts';

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
      case 'answer':
      case 'all':
        printStubSubcommand(sub);
        process.exit(2);
    }
  }

  // Fallthrough: legacy `pbrain eval --qrels ...` behavior, unchanged.
  await runLegacyQrelsMode(engine, args);
}

// ─────────────────────────────────────────────────────────────────
// Stub subcommands — land in PRs 3/4/5
// ─────────────────────────────────────────────────────────────────

function printStubSubcommand(sub: 'ingest' | 'answer' | 'all'): void {
  const planRef = { ingest: 'PR 3', answer: 'PR 4', all: 'PR 5' }[sub];
  console.error(`\`pbrain eval ${sub}\` is not yet implemented (lands in v0.4.0 ${planRef}).`);
  console.error('See the v0.4.0 eval-harness plan for the full stage surface.');
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
  pbrain eval ingest   --fixtures <path>     coming in v0.4.0 PR 3
  pbrain eval answer   --fixtures <path>     coming in v0.4.0 PR 4
  pbrain eval all      --fixtures-dir <dir>  coming in v0.4.0 PR 5
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
`.trim());
}
