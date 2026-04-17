/**
 * `pbrain whoami` — resolve the current directory to a brain project slug.
 *
 * Uses the two-layer resolver (marker file, git remote) and prints a tiny
 * human-readable report. Exits 0 on a resolved miss so scripts can rely on
 * the output without checking exit codes; only unexpected errors exit non-zero.
 */

import type { BrainEngine } from '../core/engine.ts';
import {
  resolveProject,
  findGitDir,
  readRemotes,
  normalizeGitUrl,
} from '../core/project-resolver.ts';
import type { ResolveResult } from '../core/project-resolver.ts';

export interface WhoamiOptions {
  cwd: string;
  home?: string;
}

export interface WhoamiResult {
  output: string;
  exitCode: number;
}

export async function runWhoami(
  engine: BrainEngine,
  args: string[],
  opts: WhoamiOptions,
): Promise<WhoamiResult> {
  const verbose = args.includes('--verbose') || args.includes('-v');

  const result: ResolveResult = await resolveProject({
    cwd: opts.cwd,
    home: opts.home,
    findRepoByUrl: (url) => engine.findRepoByUrl(url),
  });

  if (result) {
    const lines = [
      `slug:        ${result.slug}`,
      `matched via: ${result.matchedVia}`,
      `cwd:         ${opts.cwd}`,
    ];
    return { output: lines.join('\n') + '\n', exitCode: 0 };
  }

  const lines: string[] = [`not a pbrain project`, `cwd: ${opts.cwd}`];

  if (verbose) {
    lines.push(``, `tried:`);
    lines.push(`  - marker file:   no .pbrain-project found up to $HOME`);

    const gitdir = findGitDir(opts.cwd, opts.home);
    const remotes = gitdir ? readRemotes(gitdir) : [];
    if (remotes.length === 0) {
      lines.push(`  - git remote:    directory is not a git repo, or has no configured remotes`);
    } else {
      for (const { name, url } of remotes) {
        const canonical = normalizeGitUrl(url) ?? '(unparseable URL)';
        lines.push(`  - git remote:    ${name} → ${url}  [canonical: ${canonical}]`);
      }
    }
  }

  return { output: lines.join('\n') + '\n', exitCode: 0 };
}
