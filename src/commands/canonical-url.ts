/**
 * `pbrain canonical-url <url>` — print the canonical form of a git remote URL.
 *
 * Thin wrapper around `normalizeGitUrl()` so external callers (the
 * `project-onboard` skill, scripts) get exactly the same canonicalization
 * the engine's `findRepoByUrl` containment query expects. Hand-rolling this
 * in skill prose is fragile; this command is the single source of truth.
 *
 * Exit 0 with canonical URL on stdout on success.
 * Exit 1 with a short error on stderr when the input isn't a recognizable git URL.
 */

import { normalizeGitUrl } from '../core/project-resolver.ts';

export interface CanonicalUrlResult {
  output: string;
  exitCode: number;
  stderr?: string;
}

export function runCanonicalUrl(args: string[]): CanonicalUrlResult {
  const input = args[0];
  if (!input || input.startsWith('-')) {
    return {
      output: '',
      stderr: 'usage: pbrain canonical-url <url>\n',
      exitCode: 1,
    };
  }

  const canonical = normalizeGitUrl(input);
  if (!canonical) {
    return {
      output: '',
      stderr: `not a recognizable git URL: ${input}\n`,
      exitCode: 1,
    };
  }

  return { output: canonical + '\n', exitCode: 0 };
}
