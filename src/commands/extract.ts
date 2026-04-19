/**
 * pbrain extract — Extract links and timeline entries from brain markdown files.
 *
 * Subcommands:
 *   pbrain extract links [--dir <brain>] [--dry-run] [--json]
 *   pbrain extract timeline [--dir <brain>] [--dry-run] [--json]
 *   pbrain extract all [--dir <brain>] [--dry-run] [--json]
 */

import { readFileSync, readdirSync, lstatSync, existsSync } from 'fs';
import { join, relative, dirname } from 'path';
import type { BrainEngine, LinkBatchInput, TimelineBatchInput } from '../core/engine.ts';
import type { PageType } from '../core/types.ts';
import { parseMarkdown } from '../core/markdown.ts';

// Batch size for addLinksBatch / addTimelineEntriesBatch.
// Postgres bind-parameter limit is 65535. Links use 4 cols/row → 16K hard ceiling;
// timeline uses 5 cols/row → 13K hard ceiling. 100 is conservative on round-trip
// count but safe at any future schema width and keeps per-batch error blast radius
// small (a malformed row aborts at most 100, not thousands).
const BATCH_SIZE = 100;

// --- Types ---

export interface ExtractedLink {
  from_slug: string;
  to_slug: string;
  link_type: string;
  context: string;
}

export interface ExtractedTimelineEntry {
  slug: string;
  date: string;
  source: string;
  summary: string;
  detail?: string;
}

interface ExtractResult {
  links_created: number;
  timeline_entries_created: number;
  pages_processed: number;
}

// --- Shared walker ---

export function walkMarkdownFiles(dir: string): { path: string; relPath: string }[] {
  const files: { path: string; relPath: string }[] = [];
  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      if (entry.startsWith('.')) continue;
      const full = join(d, entry);
      try {
        if (lstatSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith('.md') && !entry.startsWith('_')) {
          files.push({ path: full, relPath: relative(dir, full) });
        }
      } catch { /* skip unreadable */ }
    }
  }
  walk(dir);
  return files;
}

// --- Link extraction ---

/**
 * Extract markdown links to .md files (relative paths only).
 *
 * Handles two syntaxes:
 *   1. Standard markdown:  [text](relative/path.md)
 *   2. Wikilinks:          [[relative/path]] or [[relative/path|Display Text]]
 *
 * Both are resolved relative to the file that contains them. External URLs
 * (containing ://) are always skipped. For wikilinks, the .md suffix is added
 * if absent and section anchors (#heading) are stripped.
 */
export function extractMarkdownLinks(content: string): { name: string; relTarget: string }[] {
  const results: { name: string; relTarget: string }[] = [];

  const mdPattern = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
  let match;
  while ((match = mdPattern.exec(content)) !== null) {
    const target = match[2];
    if (target.includes('://')) continue;
    results.push({ name: match[1], relTarget: target });
  }

  const wikiPattern = /\[\[([^|\]]+?)(?:\|[^\]]*?)?\]\]/g;
  while ((match = wikiPattern.exec(content)) !== null) {
    const rawPath = match[1].trim();
    if (rawPath.includes('://')) continue;
    const hashIdx = rawPath.indexOf('#');
    const pagePath = hashIdx >= 0 ? rawPath.slice(0, hashIdx) : rawPath;
    if (!pagePath) continue;
    const relTarget = pagePath.endsWith('.md') ? pagePath : pagePath + '.md';
    const pipeIdx = match[0].indexOf('|');
    const displayName = pipeIdx >= 0 ? match[0].slice(pipeIdx + 1, -2).trim() : rawPath;
    results.push({ name: displayName, relTarget });
  }

  return results;
}

/**
 * Resolve a wikilink target to a canonical slug, given the directory of the
 * containing page and the set of all known slugs in the brain.
 *
 * Wiki KBs often use inconsistent relative depths. Authors omit one or more
 * leading `../` because they think in "wiki-root-relative" terms. Resolution
 * order (first match wins):
 *   1. Standard `join(fileDir, relTarget)` — exact relative path as written
 *   2. Ancestor search — strip leading path components from fileDir, retry
 *
 * Returns null when no matching slug is found (dangling link).
 */
export function resolveSlug(fileDir: string, relTarget: string, allSlugs: Set<string>): string | null {
  const targetNoExt = relTarget.endsWith('.md') ? relTarget.slice(0, -3) : relTarget;

  const s1 = join(fileDir, targetNoExt);
  if (allSlugs.has(s1)) return s1;

  const parts = fileDir.split('/').filter(Boolean);
  for (let strip = 1; strip <= parts.length; strip++) {
    const ancestor = parts.slice(0, parts.length - strip).join('/');
    const candidate = ancestor ? join(ancestor, targetNoExt) : targetNoExt;
    if (allSlugs.has(candidate)) return candidate;
  }

  return null;
}

/** Infer link type from directory structure */
function inferLinkType(fromDir: string, toDir: string, frontmatter?: Record<string, unknown>): string {
  const from = fromDir.split('/')[0];
  const to = toDir.split('/')[0];
  if (from === 'people' && to === 'companies') {
    if (Array.isArray(frontmatter?.founded)) return 'founded';
    return 'works_at';
  }
  if (from === 'people' && to === 'deals') return 'involved_in';
  if (from === 'deals' && to === 'companies') return 'deal_for';
  if (from === 'meetings' && to === 'people') return 'attendee';
  return 'mention';
}

/** Extract links from frontmatter fields */
function extractFrontmatterLinks(slug: string, fm: Record<string, unknown>): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const fieldMap: Record<string, { dir: string; type: string }> = {
    company: { dir: 'companies', type: 'works_at' },
    companies: { dir: 'companies', type: 'works_at' },
    investors: { dir: 'companies', type: 'invested_in' },
    attendees: { dir: 'people', type: 'attendee' },
    founded: { dir: 'companies', type: 'founded' },
  };
  for (const [field, config] of Object.entries(fieldMap)) {
    const value = fm[field];
    if (!value) continue;
    const slugs = Array.isArray(value) ? value : [value];
    for (const s of slugs) {
      if (typeof s !== 'string') continue;
      const toSlug = `${config.dir}/${s.toLowerCase().replace(/\s+/g, '-')}`;
      links.push({ from_slug: slug, to_slug: toSlug, link_type: config.type, context: `frontmatter.${field}` });
    }
  }
  return links;
}

/** Parse frontmatter using the project's gray-matter-based parser */
function parseFrontmatterFromContent(content: string, relPath: string): Record<string, unknown> {
  try {
    const parsed = parseMarkdown(content, relPath);
    return parsed.frontmatter;
  } catch {
    return {};
  }
}

/** Full link extraction from a single markdown file */
export function extractLinksFromFile(
  content: string, relPath: string, allSlugs: Set<string>,
): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const slug = relPath.replace('.md', '');
  const fileDir = dirname(relPath);
  const fm = parseFrontmatterFromContent(content, relPath);

  for (const { name, relTarget } of extractMarkdownLinks(content)) {
    const resolved = resolveSlug(fileDir, relTarget, allSlugs);
    if (resolved !== null) {
      links.push({
        from_slug: slug, to_slug: resolved,
        link_type: inferLinkType(fileDir, dirname(resolved), fm),
        context: `markdown link: [${name}]`,
      });
    }
  }

  links.push(...extractFrontmatterLinks(slug, fm));
  return links;
}

// --- Timeline extraction ---

/** Extract timeline entries from markdown content */
export function extractTimelineFromContent(content: string, slug: string): ExtractedTimelineEntry[] {
  const entries: ExtractedTimelineEntry[] = [];

  // Format 1: Bullet — - **YYYY-MM-DD** | Source — Summary
  const bulletPattern = /^-\s+\*\*(\d{4}-\d{2}-\d{2})\*\*\s*\|\s*(.+?)\s*[—–-]\s*(.+)$/gm;
  let match;
  while ((match = bulletPattern.exec(content)) !== null) {
    entries.push({ slug, date: match[1], source: match[2].trim(), summary: match[3].trim() });
  }

  // Format 2: Header — ### YYYY-MM-DD — Title
  const headerPattern = /^###\s+(\d{4}-\d{2}-\d{2})\s*[—–-]\s*(.+)$/gm;
  while ((match = headerPattern.exec(content)) !== null) {
    const afterIdx = match.index + match[0].length;
    const nextHeader = content.indexOf('\n### ', afterIdx);
    const nextSection = content.indexOf('\n## ', afterIdx);
    const endIdx = Math.min(
      nextHeader >= 0 ? nextHeader : content.length,
      nextSection >= 0 ? nextSection : content.length,
    );
    const detail = content.slice(afterIdx, endIdx).trim();
    entries.push({ slug, date: match[1], source: 'markdown', summary: match[2].trim(), detail: detail || undefined });
  }

  return entries;
}

// --- Main command ---

export async function runExtract(engine: BrainEngine, args: string[]) {
  const subcommand = args[0];
  const dirIdx = args.indexOf('--dir');
  const brainDir = (dirIdx >= 0 && dirIdx + 1 < args.length) ? args[dirIdx + 1] : '.';
  const dryRun = args.includes('--dry-run');
  const jsonMode = args.includes('--json');

  if (!subcommand || !['links', 'timeline', 'all'].includes(subcommand)) {
    console.error('Usage: pbrain extract <links|timeline|all> [--dir <brain-dir>] [--dry-run] [--json]');
    process.exit(1);
  }

  if (!existsSync(brainDir)) {
    console.error(`Directory not found: ${brainDir}`);
    process.exit(1);
  }

  const result: ExtractResult = { links_created: 0, timeline_entries_created: 0, pages_processed: 0 };

  if (subcommand === 'links' || subcommand === 'all') {
    const r = await extractLinksFromDir(engine, brainDir, dryRun, jsonMode);
    result.links_created = r.created;
    result.pages_processed = r.pages;
  }
  if (subcommand === 'timeline' || subcommand === 'all') {
    const r = await extractTimelineFromDir(engine, brainDir, dryRun, jsonMode);
    result.timeline_entries_created = r.created;
    result.pages_processed = Math.max(result.pages_processed, r.pages);
  }

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!dryRun) {
    console.log(`\nDone: ${result.links_created} links, ${result.timeline_entries_created} timeline entries from ${result.pages_processed} pages`);
  }
}

async function extractLinksFromDir(
  engine: BrainEngine, brainDir: string, dryRun: boolean, jsonMode: boolean,
): Promise<{ created: number; pages: number }> {
  const files = walkMarkdownFiles(brainDir);
  const allSlugs = new Set(files.map(f => f.relPath.replace('.md', '')));

  // Dedup in dry-run only — DB enforces uniqueness via ON CONFLICT in batch writes.
  // Without this, the same link extracted from N files would print N times in --dry-run.
  const dryRunSeen = dryRun ? new Set<string>() : null;

  let created = 0;
  const batch: LinkBatchInput[] = [];
  async function flush() {
    if (batch.length === 0) return;
    try {
      created += await engine.addLinksBatch(batch);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (jsonMode) {
        process.stderr.write(JSON.stringify({ event: 'batch_error', size: batch.length, error: msg }) + '\n');
      } else {
        console.error(`  batch error (${batch.length} link rows lost): ${msg}`);
      }
    } finally {
      batch.length = 0;
    }
  }

  for (let i = 0; i < files.length; i++) {
    try {
      const content = readFileSync(files[i].path, 'utf-8');
      const links = extractLinksFromFile(content, files[i].relPath, allSlugs);
      for (const link of links) {
        if (dryRunSeen) {
          const key = `${link.from_slug}::${link.to_slug}::${link.link_type}`;
          if (dryRunSeen.has(key)) continue;
          dryRunSeen.add(key);
          if (!jsonMode) console.log(`  ${link.from_slug} → ${link.to_slug} (${link.link_type})`);
          created++;
        } else {
          batch.push(link);
          if (batch.length >= BATCH_SIZE) await flush();
        }
      }
    } catch { /* skip unreadable */ }
    if (jsonMode && !dryRun && (i % 100 === 0 || i === files.length - 1)) {
      process.stderr.write(JSON.stringify({ event: 'progress', phase: 'extracting_links', done: i + 1, total: files.length }) + '\n');
    }
  }
  await flush();

  if (!jsonMode) {
    const label = dryRun ? '(dry run) would create' : 'created';
    console.log(`Links: ${label} ${created} from ${files.length} pages`);
  }
  return { created, pages: files.length };
}

async function extractTimelineFromDir(
  engine: BrainEngine, brainDir: string, dryRun: boolean, jsonMode: boolean,
): Promise<{ created: number; pages: number }> {
  const files = walkMarkdownFiles(brainDir);

  // Dedup in dry-run only — DB enforces uniqueness via ON CONFLICT in batch writes.
  const dryRunSeen = dryRun ? new Set<string>() : null;

  let created = 0;
  const batch: TimelineBatchInput[] = [];
  async function flush() {
    if (batch.length === 0) return;
    try {
      created += await engine.addTimelineEntriesBatch(batch);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (jsonMode) {
        process.stderr.write(JSON.stringify({ event: 'batch_error', size: batch.length, error: msg }) + '\n');
      } else {
        console.error(`  batch error (${batch.length} timeline rows lost): ${msg}`);
      }
    } finally {
      batch.length = 0;
    }
  }

  for (let i = 0; i < files.length; i++) {
    try {
      const content = readFileSync(files[i].path, 'utf-8');
      const slug = files[i].relPath.replace('.md', '');
      for (const entry of extractTimelineFromContent(content, slug)) {
        if (dryRunSeen) {
          const key = `${entry.slug}::${entry.date}::${entry.summary}`;
          if (dryRunSeen.has(key)) continue;
          dryRunSeen.add(key);
          if (!jsonMode) console.log(`  ${entry.slug}: ${entry.date} — ${entry.summary}`);
          created++;
        } else {
          batch.push({ slug: entry.slug, date: entry.date, source: entry.source, summary: entry.summary, detail: entry.detail });
          if (batch.length >= BATCH_SIZE) await flush();
        }
      }
    } catch { /* skip unreadable */ }
    if (jsonMode && !dryRun && (i % 100 === 0 || i === files.length - 1)) {
      process.stderr.write(JSON.stringify({ event: 'progress', phase: 'extracting_timeline', done: i + 1, total: files.length }) + '\n');
    }
  }
  await flush();

  if (!jsonMode) {
    const label = dryRun ? '(dry run) would create' : 'created';
    console.log(`Timeline: ${label} ${created} entries from ${files.length} pages`);
  }
  return { created, pages: files.length };
}

// --- Sync integration hooks ---

export async function extractLinksForSlugs(engine: BrainEngine, repoPath: string, slugs: string[]): Promise<number> {
  const allFiles = walkMarkdownFiles(repoPath);
  const allSlugs = new Set(allFiles.map(f => f.relPath.replace('.md', '')));
  let created = 0;
  for (const slug of slugs) {
    const filePath = join(repoPath, slug + '.md');
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, 'utf-8');
      for (const link of extractLinksFromFile(content, slug + '.md', allSlugs)) {
        try { await engine.addLink(link.from_slug, link.to_slug, link.context, link.link_type); created++; } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return created;
}

export async function extractTimelineForSlugs(engine: BrainEngine, repoPath: string, slugs: string[]): Promise<number> {
  let created = 0;
  for (const slug of slugs) {
    const filePath = join(repoPath, slug + '.md');
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, 'utf-8');
      for (const entry of extractTimelineFromContent(content, slug)) {
        try { await engine.addTimelineEntry(entry.slug, { date: entry.date, source: entry.source, summary: entry.summary, detail: entry.detail }); created++; } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return created;
}
