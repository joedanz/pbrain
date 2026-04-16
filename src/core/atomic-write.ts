import {
  openSync,
  fsyncSync,
  closeSync,
  writeSync,
  renameSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from 'fs';
import { dirname, join, basename } from 'path';
import { randomBytes } from 'crypto';

/**
 * Write to path atomically: write to a sibling `.pbrain-tmp-<uuid>` file,
 * fsync, rename into place. A reader on the target path sees either the old
 * contents or the new contents — never a half-written file.
 *
 * Matters for PBrain because Obsidian watches the vault and reacts to
 * mid-write files. Partial writes show up as "file changed externally"
 * prompts and sometimes corrupt views that are open during the write.
 *
 * The temp file lives next to the target so the rename stays on one
 * filesystem (cross-fs rename falls back to copy+delete, which is neither
 * atomic nor fast). The `.pbrain-tmp-` prefix is what `pbrain doctor`
 * scans for to detect leftover sentinels from crashed writes.
 */
export function atomicWriteFileSync(filePath: string, content: string | Buffer): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tmpName = `.pbrain-tmp-${basename(filePath)}-${randomBytes(8).toString('hex')}`;
  const tmpPath = join(dir, tmpName);

  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, 'w', 0o644);
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    writeSync(fd, buf);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
    throw err;
  }
}

/**
 * True if the file was modified within the last `cooldownMs` milliseconds.
 * Used by autopilot to defer writes to files the user is likely editing in
 * Obsidian. Returns false if the file doesn't exist.
 */
export function isWithinCooldown(filePath: string, cooldownMs: number): boolean {
  try {
    const { statSync } = require('fs');
    const stat = statSync(filePath);
    return Date.now() - stat.mtimeMs < cooldownMs;
  } catch {
    return false;
  }
}

export const DEFAULT_COOLDOWN_MS = 60_000;
