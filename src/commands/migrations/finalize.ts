import type { OrchestratorPhaseResult, OrchestratorResult } from './types.ts';
import { appendCompletedMigration } from '../../core/preferences.ts';

export function finalizeResult(
  version: string,
  phases: OrchestratorPhaseResult[],
  status: 'complete' | 'partial' | 'failed',
): OrchestratorResult {
  if (status !== 'failed') {
    try {
      appendCompletedMigration({ version, status: status as 'complete' | 'partial' });
    } catch (e) {
      // Recording is best-effort — a disk/permissions failure here should not
      // surface as a migration failure. Log so repeated re-runs are traceable.
      console.warn(`[pbrain] Warning: could not record migration ${version} completion: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { version, status, phases };
}
