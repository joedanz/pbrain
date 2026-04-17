/**
 * Tests for the `pbrain whoami` CLI command.
 *
 * Whoami is a thin wrapper around `resolveProject`. We only verify the shape of
 * the human-readable output + exit code behavior here; layer logic is covered
 * by test/project-resolver.test.ts.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runWhoami } from '../src/commands/whoami.ts';

let sandbox: string;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pbrain-whoami-')));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** A stub engine that only exposes the one method whoami calls. */
function stubEngine(findRepoByUrl = async (_: string) => [] as { slug: string; title: string }[]) {
  return { findRepoByUrl } as any;
}

describe('runWhoami', () => {
  test('prints slug + matchedVia on a marker hit', async () => {
    writeFileSync(join(sandbox, '.pbrain-project'), 'projects/picspot\n');
    const { output, exitCode } = await runWhoami(stubEngine(), [], {
      cwd: sandbox,
      home: sandbox,
    });
    expect(exitCode).toBe(0);
    expect(output).toContain('projects/picspot');
    expect(output).toContain('marker');
  });

  test('prints slug + matchedVia on a git-remote hit', async () => {
    mkdirSync(join(sandbox, '.git'));
    writeFileSync(
      join(sandbox, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/joedanz/picspot.git\n',
    );
    const engine = stubEngine(async (url) =>
      url === 'https://github.com/joedanz/picspot'
        ? [{ slug: 'repos/joedanz-picspot', title: 'joedanz/picspot' }]
        : [],
    );
    const { output, exitCode } = await runWhoami(engine, [], {
      cwd: sandbox,
      home: sandbox,
    });
    expect(exitCode).toBe(0);
    expect(output).toContain('repos/joedanz-picspot');
    expect(output).toContain('remote:origin');
  });

  test('returns exit 0 with friendly message on no match', async () => {
    const { output, exitCode } = await runWhoami(stubEngine(), [], {
      cwd: sandbox,
      home: sandbox,
    });
    expect(exitCode).toBe(0);
    expect(output).toMatch(/not a pbrain project/i);
  });

  test('--verbose adds layer-by-layer diagnostics on miss', async () => {
    mkdirSync(join(sandbox, '.git'));
    writeFileSync(
      join(sandbox, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/unknown/repo.git\n',
    );
    const { output } = await runWhoami(stubEngine(), ['--verbose'], {
      cwd: sandbox,
      home: sandbox,
    });
    // Verbose on miss should describe what was attempted so the user can debug.
    expect(output).toMatch(/marker/i);
    expect(output).toMatch(/remote/i);
    expect(output).toContain('https://github.com/unknown/repo');
  });
});
