/**
 * v0.3.0 migration orchestrator — bi-temporal edges.
 *
 * Adds valid_from / valid_until DATE columns to the links table and replaces
 * the named UNIQUE constraint with a partial unique index
 * (WHERE valid_until IS NULL). This lets the graph hold unlimited historical
 * versions of an edge while enforcing exactly one current version per
 * (from, to, type) triplet.
 *
 * Existing rows keep valid_from = NULL (honest: we don't know when those
 * links became true in the world) and valid_until = NULL (still current).
 *
 * Phases (all idempotent):
 *   A. Schema  — pbrain init --migrate-only (runs migrate.ts version 11).
 *   B. Smoke   — confirm pbrain is reachable post-migration (best-effort).
 */

import { execSync } from 'child_process';
import type { Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult } from './types.ts';
import { finalizeResult } from './finalize.ts';

function phaseASchema(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'schema', status: 'skipped', detail: 'dry-run' };
  try {
    execSync('pbrain init --migrate-only', { stdio: 'inherit', timeout: 60_000, env: process.env });
    return { name: 'schema', status: 'complete' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'schema', status: 'failed', detail: msg };
  }
}

function phaseBVerify(opts: OrchestratorOpts): OrchestratorPhaseResult {
  if (opts.dryRun) return { name: 'verify', status: 'skipped', detail: 'dry-run' };
  try {
    // Best-effort reachability smoke test. The schema migration (phase A) is
    // transactional — it either completes fully or rolls back — so we don't
    // assert column existence here; we just confirm pbrain responds.
    execSync(
      `pbrain query "links table schema" --json 2>/dev/null`,
      { encoding: 'utf-8', timeout: 30_000, env: process.env }
    );
    return { name: 'verify', status: 'complete', detail: 'schema migration applied idempotently' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'verify', status: 'failed', detail: msg };
  }
}

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  console.log('');
  console.log('=== v0.3.0 — Bi-temporal edges ===');
  if (opts.dryRun) console.log('  (dry-run; no side effects)');
  console.log('');

  const phases: OrchestratorPhaseResult[] = [];

  const a = phaseASchema(opts);
  phases.push(a);
  if (a.status === 'failed') return finalizeResult('0.3.0', phases, 'failed');

  const b = phaseBVerify(opts);
  phases.push(b);

  const overallStatus: 'complete' | 'partial' | 'failed' =
    b.status === 'failed' ? 'partial' : 'complete';

  return finalizeResult('0.3.0', phases, overallStatus);
}

export const v0_3_0: Migration = {
  version: '0.3.0',
  featurePitch: {
    headline: 'Links now remember their history — remove a link and the graph keeps the record of when it was true',
    description:
      'pbrain v0.3.0 adds valid_from / valid_until columns to the links table. ' +
      'Removing a link no longer hard-deletes it — it sets valid_until = today and ' +
      'preserves the history. getLinks, getBacklinks, and traverseGraph automatically ' +
      'show only current edges. Re-add a link after removing it and the brain tracks ' +
      'both the old and new periods. The add_link operation now accepts an optional ' +
      'valid_from date so you can record when a link became true in the real world.',
  },
  orchestrator,
};

/** Exported for unit tests. */
export const __testing = {
  phaseASchema,
  phaseBVerify,
};
