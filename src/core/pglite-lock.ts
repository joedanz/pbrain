/**
 * PGLite File Lock — prevents concurrent process access to the same data directory.
 *
 * PGLite uses embedded Postgres (WASM) which only supports one connection at a time.
 * When `pbrain embed` (which can take minutes) is running and another process tries
 * to connect, PGLite throws `Aborted()` because it can't handle concurrent access.
 *
 * This module implements a simple advisory lock using a lock file next to the data
 * directory. It uses atomic `mkdir` (which is POSIX-atomic) combined with PID tracking
 * for stale lock detection.
 *
 * Usage:
 *   const lock = await acquireLock(dataDir);
 *   try { ... } finally { await releaseLock(lock); }
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const LOCK_DIR_NAME = '.pbrain-lock';
const LOCK_FILE = 'lock';
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes — embed jobs can be long

/**
 * Get the start time of process `pid` as a string (stable across ps invocations,
 * unique per process instance). Returns null if ps fails or pid doesn't exist.
 * We use this — not arg matching — to detect PID reuse. macOS and Linux reuse
 * PIDs, but a reused PID always has a different start time than the original.
 */
function getProcessStartTime(pid: number): string | null {
  try {
    const out = execSync(`ps -p ${pid} -o lstart=`, { encoding: 'utf-8', timeout: 1000 }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Verify that the process at `pid` is the exact process instance that wrote the
 * lock file — not an unrelated program that inherited the PID. Compares stored
 * start time (written at lock acquisition) to the current start time for `pid`.
 */
function isLockOwnerAlive(pid: number, expectedStartTime: string | undefined): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (!expectedStartTime) {
    // Lock was written by an older PBrain that didn't store start time.
    // Best-effort: treat as live so we don't clobber a possibly-live writer,
    // but the STALE_THRESHOLD_MS cap still applies.
    return true;
  }
  const liveStart = getProcessStartTime(pid);
  return liveStart !== null && liveStart === expectedStartTime;
}

export interface LockHandle {
  lockDir: string;
  acquired: boolean;
}

function getLockDir(dataDir: string | undefined): string {
  // Use the parent of the data dir for the lock, or a temp location for in-memory
  if (!dataDir) {
    // In-memory PGLite — no concurrent access possible since it's process-scoped
    // Return a sentinel that we skip
    return '';
  }
  return join(dataDir, LOCK_DIR_NAME);
}


/**
 * Attempt to acquire an exclusive lock on the PGLite data directory.
 * Returns { acquired: true } if the lock was obtained, { acquired: false } otherwise.
 * Stale locks (from dead processes) are automatically cleaned up.
 */
export async function acquireLock(dataDir: string | undefined, opts?: { timeoutMs?: number }): Promise<LockHandle> {
  const lockDir = getLockDir(dataDir);

  // In-memory PGLite — no lock needed (process-scoped, can't be shared)
  if (!lockDir) {
    return { lockDir: '', acquired: true };
  }

  mkdirSync(dataDir, { recursive: true });

  // Default timeout is short (2s): a live holder won't release, waiting longer
  // just delays the inevitable error. Callers that legitimately need to wait
  // (e.g. batch jobs queued behind a known-short operation) can override.
  const timeoutMs = opts?.timeoutMs ?? 2_000;
  const startTime = Date.now();
  let lastLiveHolder: { pid: number; command: string; acquiredAt: number } | null = null;

  while (Date.now() - startTime < timeoutMs) {
    // Check for stale lock first
    if (existsSync(lockDir)) {
      const lockPath = join(lockDir, LOCK_FILE);
      try {
        const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
        const lockPid = lockData.pid as number;
        const lockStartTime = lockData.start_time as string | undefined;
        const lockCommand = (lockData.command as string) || '';
        const lockTime = lockData.acquired_at as number;

        // Is the locking process still alive AND still the same process instance
        // that wrote the lock? Bare PID-alive is not enough — the OS reuses PIDs,
        // so we compare the stored start time against the live one.
        if (!isLockOwnerAlive(lockPid, lockStartTime)) {
          lastLiveHolder = null;
          try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* race condition, try again */ }
        } else if (Date.now() - lockTime > STALE_THRESHOLD_MS) {
          // Lock held for too long — assume stale (e.g., process hung)
          // Still alive but probably stuck — force remove
          lastLiveHolder = null;
          try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* race condition */ }
        } else {
          // Lock is held by a live PBrain process — remember it so we can
          // surface a helpful error if we time out, then wait and retry.
          lastLiveHolder = { pid: lockPid, command: lockCommand, acquiredAt: lockTime };
          await new Promise(r => setTimeout(r, 250));
          continue;
        }
      } catch {
        // Corrupt lock file — remove it
        try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* race condition */ }
      }
    }

    // Try to acquire lock (atomic mkdir)
    try {
      mkdirSync(lockDir, { recursive: false });
      // We got the lock — write our PID plus start time so later checks can
      // tell our process apart from an unrelated one that later inherits the PID.
      const lockPath = join(lockDir, LOCK_FILE);
      writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        start_time: getProcessStartTime(process.pid),
        acquired_at: Date.now(),
        command: process.argv.slice(1).join(' '),
      }), { mode: 0o644 });

      return { lockDir, acquired: true };
    } catch (e: unknown) {
      // mkdir failed — someone else grabbed it between our check and mkdir
      // This is fine, we'll retry
      if (Date.now() - startTime >= timeoutMs) {
        // Timeout — report which process holds the lock, with actionable guidance
        const lockPath = join(lockDir, LOCK_FILE);
        try {
          const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
          const cmd = String(lockData.command || '');
          const looksLikeMcp = /\bserve\b/.test(cmd);
          const hint = looksLikeMcp
            ? `\n  This is almost certainly a running \`pbrain serve\` (MCP server) — probably from Claude Code, Cursor, or another client with PBrain registered.\n  PGLite is single-writer. Options:\n    - Stop the MCP server: claude mcp remove pbrain -s local   (or quit the client)\n    - Switch to Postgres for multi-process access: pbrain migrate --to postgres`
            : `\n  Another PBrain process is using the PGLite index. Wait for it to finish, or switch to Postgres for multi-process access (\`pbrain migrate --to postgres\`).`;
          throw new Error(
            `PBrain: PGLite index is locked by PID ${lockData.pid} since ${new Date(lockData.acquired_at).toISOString()} (command: ${cmd}).${hint}\n  If that process is actually dead, remove ${lockDir} and try again.`
          );
        } catch (readErr) {
          if (readErr instanceof Error && readErr.message.startsWith('PBrain')) throw readErr;
          throw new Error(
            `PBrain: Timed out waiting for PGLite lock. Remove ${lockDir} and try again.`
          );
        }
      }
      // Brief wait before retry
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Timed out while waiting on a live holder — surface the actionable error
  // here too (not only from the mkdir-catch path).
  if (lastLiveHolder) {
    const cmd = lastLiveHolder.command;
    const looksLikeMcp = /\bserve\b/.test(cmd);
    const hint = looksLikeMcp
      ? `\n  This is almost certainly a running \`pbrain serve\` (MCP server) — probably from Claude Code, Cursor, or another client with PBrain registered.\n  PGLite is single-writer. Options:\n    - Stop the MCP server: claude mcp remove pbrain -s local   (or quit the client)\n    - Switch to Postgres for multi-process access: pbrain migrate --to postgres`
      : `\n  Another PBrain process is using the PGLite index. Wait for it to finish, or switch to Postgres for multi-process access (\`pbrain migrate --to postgres\`).`;
    throw new Error(
      `PBrain: PGLite index is locked by PID ${lastLiveHolder.pid} since ${new Date(lastLiveHolder.acquiredAt).toISOString()} (command: ${cmd}).${hint}`,
    );
  }
  throw new Error(`PBrain: Timed out waiting for PGLite lock.`);
}

/**
 * Release a previously acquired lock.
 */
export async function releaseLock(lock: LockHandle): Promise<void> {
  if (!lock.lockDir || !lock.acquired) return;

  try {
    rmSync(lock.lockDir, { recursive: true, force: true });
  } catch {
    // Lock file already removed (e.g., by stale cleanup) — that's fine
  }
}
