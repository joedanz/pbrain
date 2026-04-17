/**
 * `pbrain whoami` — resolve the current directory to a brain project slug.
 *
 * Uses the two-layer resolver (marker file, git remote) and prints a tiny
 * human-readable report. Always exits 0 on a resolved miss ("not a pbrain
 * project") so scripts can rely on the output without checking exit codes.
 * Only unexpected errors produce a non-zero exit.
 */

import type { BrainEngine } from '../core/engine.ts';
import { resolveProject } from '../core/project-resolver.ts';
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

  const findRepoByUrl = (url: string) => engine.findRepoByUrl(url);

  const result: ResolveResult = await resolveProject({
    cwd: opts.cwd,
    home: opts.home,
    findRepoByUrl,
  });

  if (result) {
    const lines = [
      `slug:        ${result.slug}`,
      ...(result.repoSlug && result.repoSlug !== result.slug
        ? [`repo:        ${result.repoSlug}`]
        : []),
      `matched via: ${result.matchedVia}`,
      `cwd:         ${opts.cwd}`,
    ];
    return { output: lines.join('\n') + '\n', exitCode: 0 };
  }

  // Miss — always verbose on miss in this first cut. The flag exists so
  // scripts can request rich diagnostics; plain runs get a short message.
  const lines: string[] = [`not a pbrain project`, `cwd: ${opts.cwd}`];

  if (verbose) {
    lines.push(``, `tried:`);
    lines.push(`  - marker file:   no .pbrain-project found up to $HOME`);

    // Re-check the git layer so the verbose log is honest about what was
    // attempted, without re-structuring the resolver to return reasons.
    const remotes = await readRemotesForReport(opts.cwd);
    if (remotes.length === 0) {
      lines.push(`  - git remote:    directory is not a git repo, or has no configured remotes`);
    } else {
      for (const { name, url, canonical } of remotes) {
        const canonicalNote = canonical ?? '(unparseable URL)';
        lines.push(`  - git remote:    ${name} → ${url}  [canonical: ${canonicalNote}]`);
      }
    }
  }

  return { output: lines.join('\n') + '\n', exitCode: 0 };
}

// ─────────────────────────────────────────────────────────────────
// Verbose diagnostics — re-reads what the resolver would have read,
// only when `--verbose` is requested.
// ─────────────────────────────────────────────────────────────────

async function readRemotesForReport(cwd: string): Promise<
  { name: string; url: string; canonical: string | null }[]
> {
  const { readFileSync, existsSync, statSync, realpathSync } = await import('fs');
  const { join, dirname, isAbsolute, resolve: resolvePath } = await import('path');
  const { normalizeGitUrl } = await import('../core/project-resolver.ts');

  let dir: string;
  try {
    dir = realpathSync(cwd);
  } catch {
    return [];
  }

  // Find `.git` (dir or file) walking up from cwd.
  let gitdir: string | null = null;
  while (true) {
    const candidate = join(dir, '.git');
    if (existsSync(candidate)) {
      const s = statSync(candidate);
      if (s.isDirectory()) {
        gitdir = candidate;
        break;
      }
      if (s.isFile()) {
        const pointer = readFileSync(candidate, 'utf-8');
        const match = pointer.match(/^gitdir:\s*(.+)$/m);
        if (match) {
          const target = match[1].trim();
          gitdir = isAbsolute(target) ? target : resolvePath(dir, target);
          break;
        }
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return [];
    dir = parent;
  }
  if (!gitdir) return [];

  // Follow commondir to find the real config.
  const commondirFile = join(gitdir, 'commondir');
  let commonGit = gitdir;
  if (existsSync(commondirFile)) {
    const target = readFileSync(commondirFile, 'utf-8').trim();
    if (target) commonGit = isAbsolute(target) ? target : resolvePath(gitdir, target);
  }

  const configPath = join(commonGit, 'config');
  if (!existsSync(configPath)) return [];
  const content = readFileSync(configPath, 'utf-8');

  const out: { name: string; url: string; canonical: string | null }[] = [];
  let currentRemote: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    const section = line.match(/^\s*\[remote\s+"([^"]+)"\s*\]/);
    if (section) {
      currentRemote = section[1];
      continue;
    }
    if (/^\s*\[/.test(line)) {
      currentRemote = null;
      continue;
    }
    if (currentRemote) {
      const kv = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
      if (kv) {
        out.push({ name: currentRemote, url: kv[1], canonical: normalizeGitUrl(kv[1]) });
      }
    }
  }
  return out;
}
