/**
 * Tests for the `pbrain eval all` orchestrator's novel logic.
 *
 * The orchestrator's per-stage execution is thin glue over the already-tested
 * stage runners (ingest, retrieval, answer). The NOVEL logic is the fixture
 * discovery: given a fixtures-dir, how do we find each stage's baseline?
 *
 * These tests pin that discovery behavior against a tmp directory, so
 * reorganizing fixtures on disk produces a loud test failure rather than
 * silent "stage not found" skips.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discoverStageFixture } from '../src/commands/eval.ts';

let scratch = '';

beforeAll(() => {
  scratch = join(tmpdir(), `pbrain-eval-orch-${Date.now()}`);
  mkdirSync(scratch, { recursive: true });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function subdir(name: string): string {
  const d = join(scratch, name);
  mkdirSync(d, { recursive: true });
  return d;
}

describe('discoverStageFixture', () => {
  test('prefers direct baseline.json at stage root', () => {
    const root = subdir('prefer-direct');
    mkdirSync(join(root, 'ingest'), { recursive: true });
    writeFileSync(join(root, 'ingest', 'baseline.json'), '{}');
    writeFileSync(join(root, 'ingest', 'alt.json'), '{}');

    const found = discoverStageFixture(root, 'ingest');
    expect(found).toBe(join(root, 'ingest', 'baseline.json'));
  });

  test('falls back to nested baseline/baseline.json (PR 3 ingest layout)', () => {
    const root = subdir('nested');
    mkdirSync(join(root, 'ingest', 'baseline'), { recursive: true });
    writeFileSync(join(root, 'ingest', 'baseline', 'baseline.json'), '{}');

    const found = discoverStageFixture(root, 'ingest');
    expect(found).toBe(join(root, 'ingest', 'baseline', 'baseline.json'));
  });

  test('falls back to first *.json when no baseline exists', () => {
    const root = subdir('first-json');
    mkdirSync(join(root, 'answer'), { recursive: true });
    writeFileSync(join(root, 'answer', 'aaa.json'), '{}');
    writeFileSync(join(root, 'answer', 'zzz.json'), '{}');

    const found = discoverStageFixture(root, 'answer');
    expect(found).toBe(join(root, 'answer', 'aaa.json'));
  });

  test('returns undefined when stage dir has no JSON files', () => {
    const root = subdir('empty-stage');
    mkdirSync(join(root, 'retrieval'), { recursive: true });
    writeFileSync(join(root, 'retrieval', 'readme.md'), '# not JSON');

    const found = discoverStageFixture(root, 'retrieval');
    expect(found).toBeUndefined();
  });

  test('returns undefined when stage dir is missing', () => {
    const root = subdir('no-stage-dir');
    // no subdir created

    const found = discoverStageFixture(root, 'answer');
    expect(found).toBeUndefined();
  });

  test('returns undefined when stage name collides with a file (not a dir)', () => {
    const root = subdir('stage-is-file');
    writeFileSync(join(root, 'ingest'), 'not a directory');

    const found = discoverStageFixture(root, 'ingest');
    expect(found).toBeUndefined();
  });

  test('direct baseline.json beats nested baseline/baseline.json when both exist', () => {
    const root = subdir('both-layouts');
    mkdirSync(join(root, 'ingest', 'baseline'), { recursive: true });
    writeFileSync(join(root, 'ingest', 'baseline.json'), '{"at":"root"}');
    writeFileSync(join(root, 'ingest', 'baseline', 'baseline.json'), '{"at":"nested"}');

    const found = discoverStageFixture(root, 'ingest');
    expect(found).toBe(join(root, 'ingest', 'baseline.json'));
  });
});
