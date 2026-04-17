/**
 * `pbrain remember "<summary>"` — append a timeline entry to the current
 * project's brain page.
 *
 * Project resolution is automatic: walks up from cwd via the same two-layer
 * resolver `pbrain whoami` uses (marker file → git remote URL → findRepoByUrl).
 * On miss, exits 1 with a pointer at the `project-onboard` skill.
 *
 * Success output (single line, stdout):
 *   remembered on {slug}: {YYYY-MM-DD} — {summary}
 */

import type { BrainEngine } from '../core/engine.ts';
import { resolveProject } from '../core/project-resolver.ts';

export interface RememberOptions {
  cwd: string;
  home?: string;
  /** Override today's date for deterministic tests. */
  today?: string;
}

export interface RememberResult {
  output: string;
  stderr?: string;
  exitCode: number;
}

export async function runRemember(
  engine: BrainEngine,
  args: string[],
  opts: RememberOptions,
): Promise<RememberResult> {
  // Everything after the command name is the summary. Quoting is the user's
  // shell's job; we just join whatever we got with spaces so both
  // `pbrain remember foo bar` and `pbrain remember "foo bar"` work.
  const summary = args.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!summary) {
    return {
      output: '',
      stderr: 'usage: pbrain remember "<summary>"\n',
      exitCode: 1,
    };
  }

  const resolved = await resolveProject({
    cwd: opts.cwd,
    home: opts.home,
    findRepoByUrl: (url) => engine.findRepoByUrl(url),
  });

  if (!resolved) {
    return {
      output: '',
      stderr:
        'not a pbrain project — invoke the `project-onboard` skill first to onboard this repo.\n',
      exitCode: 1,
    };
  }

  const date = opts.today ?? new Date().toISOString().slice(0, 10);
  await engine.addTimelineEntry(resolved.slug, {
    date,
    source: 'pbrain remember',
    summary,
    detail: '',
  });

  return {
    output: `remembered on ${resolved.slug}: ${date} — ${summary}\n`,
    exitCode: 0,
  };
}
