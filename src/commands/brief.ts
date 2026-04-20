/**
 * `pbrain brief` — user-invoked context block for Claude Code and other coding agents.
 *
 * Emits an XML-wrapped bundle the user can paste into a session (or wire to a
 * SessionStart hook as a user-opt-in) to bootstrap a coding agent with project
 * context: the project slug, a compiled_truth excerpt, and recent timeline.
 *
 * The doctrine (docs/ethos/CONTEXT_ENGINEERING.md) draws a hard line: PBrain does
 * NOT auto-push context via hooks. This is a CLI command; if the user wires it to
 * SessionStart themselves that's their opt-in, not a default install action.
 *
 * Output is capped at 10,000 chars (Claude Code's `additionalContext` hook cap).
 * XML structure ordered longform-first, query-last per Anthropic's 2026 prompt-
 * engineering guidance (30% quality uplift).
 */

import type { BrainEngine } from '../core/engine.ts';
import { resolveProject, type ResolveResult } from '../core/project-resolver.ts';

export interface BriefOptions {
  cwd: string;
  home?: string;
}

export interface BriefResult {
  output: string;
  exitCode: number;
}

const MAX_OUTPUT_CHARS = 10_000;
const COMPILED_TRUTH_CHARS = 1_500;
const TIMELINE_LIMIT = 5;

type Format = 'xml' | 'text';
type Scope = 'project' | 'activity' | 'all';

function parseArgs(args: string[]): { format: Format; scope: Scope; json: boolean } {
  let format: Format = 'xml';
  let scope: Scope = 'all';
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--format' && args[i + 1]) {
      const v = args[++i];
      if (v === 'xml' || v === 'text') format = v;
    } else if (a === '--scope' && args[i + 1]) {
      const v = args[++i];
      if (v === 'project' || v === 'activity' || v === 'all') scope = v;
    } else if (a === '--json') {
      json = true;
    }
  }
  return { format, scope, json };
}

/**
 * XML-escape for safe embedding in attributes and text nodes. Covers the minimal
 * five characters required for both contexts; we do not produce CDATA sections.
 */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatXml(params: {
  slug: string;
  matchedVia: string;
  compiledTruth: string | null;
  timeline: { date: string; summary: string; source: string }[];
  scope: Scope;
}): string {
  const { slug, matchedVia, compiledTruth, timeline, scope } = params;
  const lines: string[] = [];
  lines.push('<pbrain-brief>');
  lines.push(`  <project slug="${xmlEscape(slug)}" detected_via="${xmlEscape(matchedVia)}" />`);

  if ((scope === 'project' || scope === 'all') && compiledTruth !== null) {
    const excerpt = compiledTruth.slice(0, COMPILED_TRUTH_CHARS);
    lines.push('  <compiled_truth_excerpt>');
    lines.push(xmlEscape(excerpt));
    lines.push('  </compiled_truth_excerpt>');
  }

  if ((scope === 'activity' || scope === 'all') && timeline.length > 0) {
    lines.push(`  <recent_timeline limit="${timeline.length}">`);
    for (const e of timeline) {
      const src = e.source ? ` source="${xmlEscape(e.source)}"` : '';
      lines.push(`    <entry date="${xmlEscape(e.date)}"${src}>${xmlEscape(e.summary)}</entry>`);
    }
    lines.push('  </recent_timeline>');
  }

  lines.push('  <how_to_query>Use `pbrain query "&lt;question&gt;"` to fetch more brain context on demand.</how_to_query>');
  lines.push('</pbrain-brief>');
  return lines.join('\n') + '\n';
}

function formatText(params: {
  slug: string;
  matchedVia: string;
  compiledTruth: string | null;
  timeline: { date: string; summary: string; source: string }[];
  scope: Scope;
}): string {
  const { slug, matchedVia, compiledTruth, timeline, scope } = params;
  const lines: string[] = [];
  lines.push(`# pbrain brief`);
  lines.push(`project: ${slug} (detected via: ${matchedVia})`);
  if ((scope === 'project' || scope === 'all') && compiledTruth !== null) {
    lines.push('');
    lines.push('## Compiled truth');
    lines.push(compiledTruth.slice(0, COMPILED_TRUTH_CHARS));
  }
  if ((scope === 'activity' || scope === 'all') && timeline.length > 0) {
    lines.push('');
    lines.push(`## Recent timeline (${timeline.length})`);
    for (const e of timeline) {
      const src = e.source ? ` [${e.source}]` : '';
      lines.push(`- ${e.date}${src}  ${e.summary}`);
    }
  }
  lines.push('');
  lines.push('To fetch more: pbrain query "<question>"');
  return lines.join('\n') + '\n';
}

function formatNoProject(cwd: string, format: Format): string {
  if (format === 'xml') {
    return `<pbrain-brief>\n  <no_project cwd="${xmlEscape(cwd)}" />\n  <how_to_query>No project resolved. Run \`pbrain whoami --verbose\` to see what resolution was attempted.</how_to_query>\n</pbrain-brief>\n`;
  }
  return `# pbrain brief\nNo project resolved for cwd: ${cwd}\nRun \`pbrain whoami --verbose\` to see details.\n`;
}

/** Truncate output if over the 10,000-char cap, emitting a minimal sentinel the caller can key on. */
function enforceCap(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  // Reserve headroom for the sentinel line itself.
  const cutoff = MAX_OUTPUT_CHARS - 80;
  return output.slice(0, cutoff) + `\n<!-- pbrain-brief truncated at ${MAX_OUTPUT_CHARS} chars -->\n`;
}

export async function runBrief(
  engine: BrainEngine,
  args: string[],
  opts: BriefOptions,
): Promise<BriefResult> {
  const { format, scope, json } = parseArgs(args);

  const resolved: ResolveResult = await resolveProject({
    cwd: opts.cwd,
    home: opts.home,
    findRepoByUrl: (url) => engine.findRepoByUrl(url),
  });

  if (!resolved) {
    if (json) {
      return { output: JSON.stringify({ slug: null, cwd: opts.cwd }) + '\n', exitCode: 0 };
    }
    return { output: formatNoProject(opts.cwd, format), exitCode: 0 };
  }

  const page = await engine.getPage(resolved.slug);
  const compiledTruth = page?.compiled_truth ?? null;
  const timelineRaw =
    scope === 'project'
      ? []
      : (await engine.getTimeline(resolved.slug, { limit: TIMELINE_LIMIT })).slice(0, TIMELINE_LIMIT);
  const timeline = timelineRaw.map(e => ({
    date: e.date,
    summary: e.summary,
    source: e.source || '',
  }));

  if (json) {
    const payload = {
      slug: resolved.slug,
      matchedVia: resolved.matchedVia,
      cwd: opts.cwd,
      compiled_truth_excerpt: compiledTruth ? compiledTruth.slice(0, COMPILED_TRUTH_CHARS) : null,
      recent_timeline: timeline,
    };
    return { output: JSON.stringify(payload) + '\n', exitCode: 0 };
  }

  const params = {
    slug: resolved.slug,
    matchedVia: resolved.matchedVia,
    compiledTruth,
    timeline,
    scope,
  };
  const raw = format === 'xml' ? formatXml(params) : formatText(params);
  return { output: enforceCap(raw), exitCode: 0 };
}
