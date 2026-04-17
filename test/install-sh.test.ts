import { describe, test, expect } from 'bun:test';
import { mkdtempSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRIPT = new URL('../scripts/install.sh', import.meta.url).pathname;

async function run(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(['bash', SCRIPT, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env, PATH: process.env.PATH || '' },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe('scripts/install.sh', () => {
  test('--help prints usage and exits 0', async () => {
    const { stdout, exitCode } = await run(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('PBrain one-line installer');
    expect(stdout).toContain('--brain-path');
    expect(stdout).toContain('--install-dir');
    expect(stdout).toContain('--yes');
    expect(stdout).toContain('--dry-run');
  });

  test('-h also prints usage', async () => {
    const { stdout, exitCode } = await run(['-h']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('PBrain one-line installer');
  });

  test('--brain-path without a value errors out', async () => {
    const { stderr, exitCode } = await run(['--brain-path']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('--brain-path requires a value');
  });

  test('unknown flag errors with suggestion', async () => {
    const { stderr, exitCode } = await run(['--no-such-flag']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Unknown flag');
    expect(stderr).toContain('--help');
  });

  test('--dry-run touches nothing on disk', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'pbrain-install-test-'));
    const brainPath = join(sandbox, 'vault');
    const installDir = join(sandbox, 'repo');

    try {
      const { stderr, exitCode } = await run([
        '--dry-run',
        '--yes',
        '--skip-skills',
        '--brain-path', brainPath,
        '--install-dir', installDir,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toContain('[dry-run]');
      expect(stderr).toContain('PBrain is installed');
      // Critical: no filesystem writes under sandbox.
      expect(existsSync(brainPath)).toBe(false);
      expect(existsSync(installDir)).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('non-TTY without brain-path or existing config errors clearly', async () => {
    // stdin is not a TTY when Bun.spawn pipes stdout/stderr. If no config
    // exists and no --brain-path is given, the script should die with a
    // flag-suggesting message, not hang.
    const sandbox = mkdtempSync(join(tmpdir(), 'pbrain-install-test-'));
    try {
      const { stderr, exitCode } = await run([
        '--dry-run',
        '--install-dir', join(sandbox, 'repo'),
      ], {
        HOME: sandbox,  // isolate from the developer's real ~/.pbrain/config.json
        PBRAIN_BRAIN_PATH: '',
      });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain('--brain-path');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('refuses to run as root (smoke check via EUID guard presence)', async () => {
    // We can't actually run as root in unit tests. Confirm the guard is in
    // the source so future refactors don't drop it.
    const { readFileSync } = require('fs');
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toContain('EUID');
    expect(src).toContain("Don't run this installer as root");
  });

  test('rejects Windows shells with WSL pointer', async () => {
    const { readFileSync } = require('fs');
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/MINGW\*|MSYS\*|CYGWIN\*/);
    expect(src).toContain('WSL');
  });

  test('installer version is defined', async () => {
    const { readFileSync } = require('fs');
    const src = readFileSync(SCRIPT, 'utf-8');
    expect(src).toMatch(/INSTALL_SCRIPT_VERSION="[0-9]+"/);
  });
});
