/**
 * Tests for `pbrain canonical-url <url>`.
 *
 * The command is a thin wrapper over `normalizeGitUrl()`; thorough URL-format
 * coverage lives in test/project-resolver.test.ts. Here we only verify the
 * CLI wrapper's contract: valid URL → stdout canonical + exit 0;
 * invalid URL → stderr error + exit 1; missing arg → usage + exit 1.
 */

import { describe, test, expect } from 'bun:test';
import { runCanonicalUrl } from '../src/commands/canonical-url.ts';

describe('runCanonicalUrl', () => {
  test('canonicalizes https URL with .git suffix', () => {
    const { output, exitCode, stderr } = runCanonicalUrl([
      'https://github.com/JoeDanz/PicSpot.git',
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBeUndefined();
    expect(output).toBe('https://github.com/joedanz/picspot\n');
  });

  test('canonicalizes ssh scp-form URL', () => {
    const { output, exitCode } = runCanonicalUrl([
      'git@github.com:joedanz/picspot.git',
    ]);
    expect(exitCode).toBe(0);
    expect(output).toBe('https://github.com/joedanz/picspot\n');
  });

  test('canonicalizes git:// URL', () => {
    const { output, exitCode } = runCanonicalUrl([
      'git://github.com/joedanz/picspot.git',
    ]);
    expect(exitCode).toBe(0);
    expect(output).toBe('https://github.com/joedanz/picspot\n');
  });

  test('exit 1 with usage on missing arg', () => {
    const { output, stderr, exitCode } = runCanonicalUrl([]);
    expect(exitCode).toBe(1);
    expect(output).toBe('');
    expect(stderr).toMatch(/usage/i);
  });

  test('exit 1 with usage on flag-only arg', () => {
    const { stderr, exitCode } = runCanonicalUrl(['--help']);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/usage/i);
  });

  test('exit 1 on unparseable input', () => {
    const { output, stderr, exitCode } = runCanonicalUrl(['not a url']);
    expect(exitCode).toBe(1);
    expect(output).toBe('');
    expect(stderr).toMatch(/not a recognizable git URL/i);
  });
});
