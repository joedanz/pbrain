/**
 * Unit tests for the v0.3.0 orchestrator migration.
 * Follows the v0_12_2 test pattern: phase isolation via __testing export.
 * Phases that call execSync are mocked to avoid requiring a live pbrain binary.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock execSync before importing the module under test.
const execSyncMock = mock((_cmd: string, _opts?: unknown): string => '');

mock.module('child_process', () => ({
  execSync: execSyncMock,
}));

mock.module('../../src/core/preferences.ts', () => ({
  appendCompletedMigration: mock(() => {}),
}));

const { __testing, v0_3_0 } = await import('../src/commands/migrations/v0_3_0.ts');
const { phaseASchema, phaseBVerify } = __testing;

beforeEach(() => {
  execSyncMock.mockReset();
  execSyncMock.mockImplementation(() => '');
});

describe('v0_3_0: phaseASchema', () => {
  test('dry-run → skipped', () => {
    const result = phaseASchema({ dryRun: true, yes: false, noAutopilotInstall: false });
    expect(result.status).toBe('skipped');
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  test('success → complete', () => {
    const result = phaseASchema({ dryRun: false, yes: false, noAutopilotInstall: false });
    expect(result.status).toBe('complete');
    expect(execSyncMock).toHaveBeenCalledWith(
      'pbrain init --migrate-only',
      expect.objectContaining({ timeout: 60_000 })
    );
  });

  test('execSync throws → failed', () => {
    execSyncMock.mockImplementation(() => { throw new Error('schema error'); });
    const result = phaseASchema({ dryRun: false, yes: false, noAutopilotInstall: false });
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('schema error');
  });

  test('idempotent: called twice both return complete', () => {
    const r1 = phaseASchema({ dryRun: false, yes: false, noAutopilotInstall: false });
    const r2 = phaseASchema({ dryRun: false, yes: false, noAutopilotInstall: false });
    expect(r1.status).toBe('complete');
    expect(r2.status).toBe('complete');
  });
});

describe('v0_3_0: phaseBVerify', () => {
  test('dry-run → skipped', () => {
    const result = phaseBVerify({ dryRun: true, yes: false, noAutopilotInstall: false });
    expect(result.status).toBe('skipped');
  });

  test('success → complete', () => {
    const result = phaseBVerify({ dryRun: false, yes: false, noAutopilotInstall: false });
    expect(result.status).toBe('complete');
  });
});

describe('v0_3_0: full orchestrator', () => {
  test('complete run → overall status complete', async () => {
    const result = await v0_3_0.orchestrator({ dryRun: false, yes: true, noAutopilotInstall: false });
    expect(result.status).toBe('complete');
    expect(result.version).toBe('0.3.0');
    expect(result.phases.map(p => p.name)).toEqual(['schema', 'verify']);
  });

  test('dry-run → all phases skipped, status complete', async () => {
    const result = await v0_3_0.orchestrator({ dryRun: true, yes: true, noAutopilotInstall: false });
    expect(result.status).toBe('complete');
    expect(result.phases.every(p => p.status === 'skipped')).toBe(true);
  });

  test('schema phase fails → overall failed, verify not reached', async () => {
    execSyncMock.mockImplementationOnce(() => { throw new Error('db conn failed'); });
    const result = await v0_3_0.orchestrator({ dryRun: false, yes: true, noAutopilotInstall: false });
    expect(result.status).toBe('failed');
    expect(result.phases).toHaveLength(1); // only schema phase ran
  });

  test('double invocation: both runs return complete (idempotency)', async () => {
    const r1 = await v0_3_0.orchestrator({ dryRun: false, yes: true, noAutopilotInstall: false });
    const r2 = await v0_3_0.orchestrator({ dryRun: false, yes: true, noAutopilotInstall: false });
    expect(r1.status).toBe('complete');
    expect(r2.status).toBe('complete');
  });
});

describe('v0_3_0: metadata', () => {
  test('version is 0.3.0', () => {
    expect(v0_3_0.version).toBe('0.3.0');
  });

  test('featurePitch headline is non-empty', () => {
    expect(v0_3_0.featurePitch.headline.length).toBeGreaterThan(10);
  });

  test('__testing exports all phase functions', () => {
    expect(typeof phaseASchema).toBe('function');
    expect(typeof phaseBVerify).toBe('function');
  });
});
