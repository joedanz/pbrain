import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { atomicWriteFileSync, isWithinCooldown } from '../src/core/atomic-write.ts';

function mkTmp() {
  return mkdtempSync(join(tmpdir(), 'pbrain-atomic-'));
}

test('atomicWriteFileSync writes content and leaves no temp files', () => {
  const dir = mkTmp();
  const target = join(dir, 'page.md');
  atomicWriteFileSync(target, 'hello world');
  expect(readFileSync(target, 'utf-8')).toBe('hello world');
  const leftovers = readdirSync(dir).filter(n => n.startsWith('.pbrain-tmp-'));
  expect(leftovers).toEqual([]);
  rmSync(dir, { recursive: true });
});

test('atomicWriteFileSync overwrites existing file', () => {
  const dir = mkTmp();
  const target = join(dir, 'page.md');
  writeFileSync(target, 'old');
  atomicWriteFileSync(target, 'new');
  expect(readFileSync(target, 'utf-8')).toBe('new');
  rmSync(dir, { recursive: true });
});

test('atomicWriteFileSync creates parent directories', () => {
  const dir = mkTmp();
  const target = join(dir, 'nested', 'deep', 'page.md');
  atomicWriteFileSync(target, 'hello');
  expect(existsSync(target)).toBe(true);
  rmSync(dir, { recursive: true });
});

test('isWithinCooldown returns true for freshly written files', () => {
  const dir = mkTmp();
  const target = join(dir, 'page.md');
  writeFileSync(target, 'x');
  expect(isWithinCooldown(target, 60_000)).toBe(true);
  rmSync(dir, { recursive: true });
});

test('isWithinCooldown returns false for missing files', () => {
  expect(isWithinCooldown('/tmp/pbrain-does-not-exist-xyz', 60_000)).toBe(false);
});
