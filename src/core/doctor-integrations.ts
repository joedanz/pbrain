/**
 * Integration health checks: validate that a PBrain brain folder is still a
 * well-formed Obsidian-compatible vault.
 *
 * Runs filesystem-only — no database required. Called by `pbrain doctor --integrations`.
 *
 * Checks:
 *   1. brain_path exists and is writable
 *   2. No leftover `.pbrain-tmp-*` sentinels (crashed atomic writes)
 *   3. Every YAML frontmatter block parses
 *   4. Every `[[wikilink]]` resolves to a known slug or alias
 *   5. No duplicate slugs across directories (Obsidian wikilink collision)
 */

import matter from 'gray-matter';
import { readFileSync, existsSync, statSync, accessSync, constants, readdirSync, lstatSync } from 'fs';
import { join, relative } from 'path';
import { parseWikilinks, resolveWikilink } from './wikilink.ts';

export interface IntegrationIssue {
  type: 'missing_brain' | 'unwritable_brain' | 'leftover_tmp' | 'yaml_error' | 'broken_wikilink' | 'duplicate_slug' | 'scan_error';
  path: string;
  detail: string;
}

export interface IntegrationReport {
  brain_path: string;
  ok: boolean;
  stats: {
    pages_scanned: number;
    wikilinks_checked: number;
    leftover_tmp: number;
  };
  issues: IntegrationIssue[];
}

/**
 * Walk the brain folder and collect every .md file plus any .pbrain-tmp-* sentinels.
 * Symlinks are skipped for the same reason collectMarkdownFiles() skips them.
 *
 * Scan failures (EPERM, EACCES — common on macOS CloudStorage without Full Disk
 * Access) are surfaced as scan_errors so doctor doesn't silently pass on a vault
 * it couldn't actually read.
 */
function walk(root: string): { pages: string[]; tmpFiles: string[]; scanErrors: Array<{ path: string; code: string; message: string }> } {
  const pages: string[] = [];
  const tmpFiles: string[] = [];
  const scanErrors: Array<{ path: string; code: string; message: string }> = [];

  function recurse(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      scanErrors.push({
        path: dir,
        code: err.code || 'UNKNOWN',
        message: err.message || String(e),
      });
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules') continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;

      // .pbrain-tmp-* sentinels: leftover from a crashed atomic write
      if (entry.startsWith('.pbrain-tmp-')) {
        tmpFiles.push(full);
        continue;
      }
      if (entry.startsWith('.')) continue;

      if (stat.isDirectory()) {
        recurse(full);
      } else if (entry.endsWith('.md') || entry.endsWith('.mdx')) {
        pages.push(full);
      }
    }
  }

  recurse(root);
  return { pages: pages.sort(), tmpFiles, scanErrors };
}

/** Convert an absolute file path under brainPath to a slug (drop `.md`, use forward slashes). */
function pathToSlug(absPath: string, brainPath: string): string {
  const rel = relative(brainPath, absPath).replace(/\\/g, '/');
  return rel.replace(/\.(md|mdx)$/, '');
}

export function checkIntegrations(brainPath: string | undefined | null): IntegrationReport {
  const issues: IntegrationIssue[] = [];
  const report: IntegrationReport = {
    brain_path: brainPath || '',
    ok: true,
    stats: { pages_scanned: 0, wikilinks_checked: 0, leftover_tmp: 0 },
    issues,
  };

  if (!brainPath) {
    issues.push({
      type: 'missing_brain',
      path: '',
      detail: 'brain_path not configured. Run `pbrain init` to pick a brain folder.',
    });
    report.ok = false;
    return report;
  }

  if (!existsSync(brainPath)) {
    issues.push({
      type: 'missing_brain',
      path: brainPath,
      detail: 'Brain folder does not exist.',
    });
    report.ok = false;
    return report;
  }

  try {
    const s = statSync(brainPath);
    if (!s.isDirectory()) {
      issues.push({ type: 'missing_brain', path: brainPath, detail: 'Brain path is not a directory.' });
      report.ok = false;
      return report;
    }
  } catch (e) {
    issues.push({ type: 'missing_brain', path: brainPath, detail: (e as Error).message });
    report.ok = false;
    return report;
  }

  try {
    accessSync(brainPath, constants.W_OK);
  } catch {
    issues.push({ type: 'unwritable_brain', path: brainPath, detail: 'Brain folder is not writable.' });
    report.ok = false;
  }

  const { pages, tmpFiles, scanErrors } = walk(brainPath);
  report.stats.pages_scanned = pages.length;
  report.stats.leftover_tmp = tmpFiles.length;

  for (const err of scanErrors) {
    const detail = err.code === 'EPERM' || err.code === 'EACCES'
      ? `Cannot read ${err.path}: ${err.code}. On macOS this usually means bun lacks Full Disk Access. Grant it at System Settings > Privacy & Security > Full Disk Access for /Users/$(whoami)/.bun/bin/bun and restart your terminal.`
      : `Cannot read ${err.path}: ${err.code}. ${err.message}`;
    issues.push({ type: 'scan_error', path: err.path, detail });
  }

  for (const tmp of tmpFiles) {
    issues.push({
      type: 'leftover_tmp',
      path: tmp,
      detail: 'Leftover atomic-write sentinel from a crashed write. Safe to delete.',
    });
  }

  const knownSlugs = new Set<string>();
  const tailIndex = new Map<string, string[]>();
  const aliases = new Map<string, string>();
  const pageBodies = new Map<string, { body: string; slug: string }>();

  for (const p of pages) {
    const slug = pathToSlug(p, brainPath);
    knownSlugs.add(slug);
    const tail = slug.split('/').pop() || slug;
    const list = tailIndex.get(tail) || [];
    list.push(slug);
    tailIndex.set(tail, list);

    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(readFileSync(p, 'utf-8'));
    } catch (e) {
      issues.push({
        type: 'yaml_error',
        path: p,
        detail: `YAML frontmatter unparseable: ${(e as Error).message}`,
      });
      continue;
    }

    const aliasField = parsed.data?.aliases;
    if (Array.isArray(aliasField)) {
      for (const a of aliasField) {
        if (typeof a === 'string' && a.trim()) aliases.set(a.trim(), slug);
      }
    }

    const tagsField = parsed.data?.tags;
    if (tagsField !== undefined && !Array.isArray(tagsField) && typeof tagsField !== 'string') {
      issues.push({
        type: 'yaml_error',
        path: p,
        detail: `tags: frontmatter is ${typeof tagsField}, expected list or string.`,
      });
    }

    pageBodies.set(p, { body: parsed.content, slug });
  }

  // Tail collisions are only a real problem when a bare-slug wikilink [[tail]] is
  // actually used somewhere — path-qualified links ([[projects/foo]]) are unambiguous
  // per Contract rule 2 of project-onboard. Track bare-slug usage during the wikilink
  // scan, then emit duplicate_slug only for tails that have bare-slug referents.
  const bareSlugUsage = new Map<string, string[]>();

  for (const [absPath, { body, slug }] of pageBodies) {
    const links = parseWikilinks(body);
    report.stats.wikilinks_checked += links.length;
    for (const link of links) {
      if (resolveWikilink(link.slug, knownSlugs, aliases) === null) {
        issues.push({
          type: 'broken_wikilink',
          path: absPath,
          detail: `${slug}.md → [[${link.slug}]] does not resolve.`,
        });
        continue;
      }

      const normalized = link.slug.trim().replace(/\.md$/, '');
      if (normalized.includes('/')) continue;
      if (knownSlugs.has(normalized)) continue;
      const lower = normalized.toLowerCase();
      if (aliases.has(normalized) || aliases.has(lower)) continue;

      const candidates = tailIndex.get(normalized);
      if (candidates && candidates.length > 1) {
        const refs = bareSlugUsage.get(normalized) || [];
        refs.push(absPath);
        bareSlugUsage.set(normalized, refs);
      }
    }
  }

  for (const [tail, refs] of bareSlugUsage) {
    const slugs = tailIndex.get(tail) || [];
    const refList = refs.map(p => relative(brainPath, p)).join(', ');
    const suggestion = slugs[0] ? `e.g. [[${slugs[0]}]]` : '';
    issues.push({
      type: 'duplicate_slug',
      path: slugs.join(', '),
      detail: `Multiple files share the tail "${tail}" and a bare-slug wikilink [[${tail}]] references it from: ${refList}. Path-qualify the reference ${suggestion}.`.trim(),
    });
  }

  report.ok = issues.length === 0;
  return report;
}
