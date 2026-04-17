/**
 * Tests for `pbrain remember <summary>`.
 *
 * Uses PGLite (in-memory) to run against a real engine end-to-end so we
 * verify the timeline row actually lands on the resolved slug.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runRemember } from '../src/commands/remember.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function truncate() {
  for (const t of ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.query(`DELETE FROM ${t}`);
  }
}

let sandbox: string;

beforeEach(async () => {
  await truncate();
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pbrain-remember-')));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('runRemember', () => {
  test('appends a timeline entry on the resolved slug', async () => {
    // Seed an onboarded repo page whose frontmatter.github_url matches the
    // remote in the sandbox checkout.
    await engine.putPage('repos/joedanz/picspot', {
      type: 'source',
      title: 'joedanz/picspot',
      compiled_truth: 'stub',
      frontmatter: { github_url: 'https://github.com/joedanz/picspot' },
    });
    mkdirSync(join(sandbox, '.git'));
    writeFileSync(
      join(sandbox, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/joedanz/picspot.git\n',
    );

    const { output, exitCode } = await runRemember(
      engine,
      ['Chose Bun over Node for startup speed'],
      { cwd: sandbox, home: sandbox, today: '2026-04-17' },
    );

    expect(exitCode).toBe(0);
    expect(output).toContain('repos/joedanz/picspot');
    expect(output).toContain('2026-04-17');
    expect(output).toContain('Chose Bun over Node for startup speed');

    const timeline = await engine.getTimeline('repos/joedanz/picspot');
    expect(timeline.length).toBe(1);
    // PGLite returns DATE columns as Date objects; normalize to ISO date.
    const storedDate = timeline[0].date instanceof Date
      ? timeline[0].date.toISOString().slice(0, 10)
      : String(timeline[0].date).slice(0, 10);
    expect(storedDate).toBe('2026-04-17');
    expect(timeline[0].summary).toBe('Chose Bun over Node for startup speed');
    expect(timeline[0].source).toBe('pbrain remember');
  });

  test('joins multi-word summary (shell passed unquoted)', async () => {
    await engine.putPage('repos/a/b', {
      type: 'source',
      title: 'a/b',
      compiled_truth: 'stub',
      frontmatter: { github_url: 'https://github.com/a/b' },
    });
    mkdirSync(join(sandbox, '.git'));
    writeFileSync(
      join(sandbox, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/a/b.git\n',
    );

    const { exitCode } = await runRemember(
      engine,
      ['switched', 'auth', 'from', 'Clerk', 'to', 'Better', 'Auth'],
      { cwd: sandbox, home: sandbox, today: '2026-04-17' },
    );

    expect(exitCode).toBe(0);
    const timeline = await engine.getTimeline('repos/a/b');
    expect(timeline[0].summary).toBe('switched auth from Clerk to Better Auth');
  });

  test('exit 1 when cwd is not a pbrain project', async () => {
    // No page seeded; sandbox is a bare temp dir with no .git.
    const { output, stderr, exitCode } = await runRemember(
      engine,
      ['anything'],
      { cwd: sandbox, home: sandbox, today: '2026-04-17' },
    );
    expect(exitCode).toBe(1);
    expect(output).toBe('');
    expect(stderr).toMatch(/not a pbrain project/i);
    expect(stderr).toMatch(/project-onboard/);
  });

  test('exit 1 with usage on empty summary', async () => {
    const { stderr, exitCode } = await runRemember(engine, [], {
      cwd: sandbox,
      home: sandbox,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/usage/i);
  });

  test('exit 1 with usage on flag-only args', async () => {
    const { stderr, exitCode } = await runRemember(engine, ['--help'], {
      cwd: sandbox,
      home: sandbox,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/usage/i);
  });

  test('uses today() fallback when opts.today omitted', async () => {
    await engine.putPage('repos/x/y', {
      type: 'source',
      title: 'x/y',
      compiled_truth: 'stub',
      frontmatter: { github_url: 'https://github.com/x/y' },
    });
    mkdirSync(join(sandbox, '.git'));
    writeFileSync(
      join(sandbox, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/x/y.git\n',
    );

    const { output, exitCode } = await runRemember(engine, ['test'], {
      cwd: sandbox,
      home: sandbox,
    });
    expect(exitCode).toBe(0);
    // Date should be today in ISO YYYY-MM-DD form.
    expect(output).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
