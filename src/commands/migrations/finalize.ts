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
    } catch {
      // Recording is best-effort.
    }
  }
  return { version, status, phases };
}
