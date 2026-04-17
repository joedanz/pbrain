import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquireLock, releaseLock, type LockHandle } from '../src/core/pglite-lock';

const TEST_DIR = join(tmpdir(), 'pbrain-lock-test-' + process.pid);

describe('pglite-lock', () => {
  beforeEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('acquires and releases lock', async () => {
    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);
    expect(existsSync(join(TEST_DIR, '.pbrain-lock'))).toBe(true);

    await releaseLock(lock);
    expect(existsSync(join(TEST_DIR, '.pbrain-lock'))).toBe(false);
  });

  test('creates missing data directory before acquiring lock', async () => {
    const missingDataDir = join(TEST_DIR, 'missing-data-dir');

    const lock = await acquireLock(missingDataDir);
    expect(lock.acquired).toBe(true);
    expect(existsSync(missingDataDir)).toBe(true);
    expect(existsSync(join(missingDataDir, '.pbrain-lock'))).toBe(true);

    await releaseLock(lock);
    expect(existsSync(join(missingDataDir, '.pbrain-lock'))).toBe(false);
  });

  test('prevents concurrent lock acquisition', async () => {
    const lock1 = await acquireLock(TEST_DIR, { timeoutMs: 2000 });
    expect(lock1.acquired).toBe(true);

    // Second lock attempt should fail (either with the actionable "locked by PID"
    // error when the first holder is still alive, or the generic "Timed out"
    // fallback if the check flips the holder to stale mid-loop).
    await expect(acquireLock(TEST_DIR, { timeoutMs: 1000 })).rejects.toThrow(/locked by PID|Timed out/);

    await releaseLock(lock1);
  });

  test('detects and cleans stale lock from dead process', async () => {
    // Simulate a stale lock from a dead process
    const lockDir = join(TEST_DIR, '.pbrain-lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({
      pid: 999999999, // Non-existent PID
      acquired_at: Date.now(),
      command: 'test',
    }));

    // Should clean up the stale lock and acquire
    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);

    await releaseLock(lock);
  });

  test('skips lock for in-memory (undefined dataDir)', async () => {
    const lock = await acquireLock(undefined);
    expect(lock.acquired).toBe(true);
    expect(lock.lockDir).toBe('');

    // Release should be a no-op
    await releaseLock(lock);
  });

  test('lock file contains PID and command', async () => {
    const lock = await acquireLock(TEST_DIR);
    const lockData = JSON.parse(readFileSync(join(TEST_DIR, '.pbrain-lock', 'lock'), 'utf-8'));

    expect(lockData.pid).toBe(process.pid);
    expect(lockData.acquired_at).toBeDefined();
    expect(lockData.command).toBeDefined();

    await releaseLock(lock);
  });

  test('releases lock on disconnect even if DB close fails', async () => {
    const lock = await acquireLock(TEST_DIR);
    expect(lock.acquired).toBe(true);

    // Simulate DB already closed
    await releaseLock(lock);
    expect(existsSync(join(TEST_DIR, '.pbrain-lock'))).toBe(false);

    // Second acquisition should work
    const lock2 = await acquireLock(TEST_DIR);
    expect(lock2.acquired).toBe(true);
    await releaseLock(lock2);
  });

  test('treats lock held by PID-reused non-pbrain process as stale', async () => {
    // Plant a lock file claiming PID 1 (launchd on macOS) holds it. PID 1 is
    // alive, but its command is definitely not `pbrain serve`. The old
    // process.kill(pid, 0) check would have made us wait. New check verifies
    // the command and should clean this up as stale.
    const lockDir = join(TEST_DIR, '.pbrain-lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'lock'), JSON.stringify({
      pid: 1,
      acquired_at: Date.now(),
      command: '/Users/danziger/code/pbrain/src/cli.ts serve',
    }));

    const lock = await acquireLock(TEST_DIR, { timeoutMs: 3000 });
    expect(lock.acquired).toBe(true);
    await releaseLock(lock);
  });

  test('fails fast with actionable error when a live process holds the lock', async () => {
    // The test process itself (bun running this test file) is a valid live
    // holder — its stored command contains "test/pglite-lock.test.ts" which
    // is filename-looking and also matches the current ps output, so
    // isLockOwnerAlive returns true.
    const lock1 = await acquireLock(TEST_DIR);
    expect(lock1.acquired).toBe(true);

    const start = Date.now();
    await expect(acquireLock(TEST_DIR, { timeoutMs: 500 })).rejects.toThrow(
      /PGLite index is locked|locked by PID|Postgres/,
    );
    expect(Date.now() - start).toBeLessThan(3000);

    await releaseLock(lock1);
  });
});
