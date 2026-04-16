/**
 * Obsidian-compatible wikilink emit/parse/resolve.
 *
 * Format: `[[slug]]` or `[[slug|display text]]`. Slug is a path-derived
 * identifier without extension (e.g., `companies/anthropic`, `people/garry-tan`).
 *
 * Obsidian resolves wikilinks through:
 * 1. Exact filename match (case-insensitive)
 * 2. Alias match (from YAML `aliases:` frontmatter)
 * 3. Fuzzy path match
 *
 * PBrain emits the canonical slug. Readers (Obsidian, `pbrain doctor`) resolve it.
 */

const WIKILINK_PATTERN = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;

export interface Wikilink {
  slug: string;
  display?: string;
  raw: string;
}

/**
 * Emit a wikilink. If display differs from the slug tail, use the `|` form.
 *
 *   emitWikilink('companies/anthropic') === '[[companies/anthropic]]'
 *   emitWikilink('companies/anthropic', 'Anthropic') === '[[companies/anthropic|Anthropic]]'
 */
export function emitWikilink(slug: string, display?: string): string {
  const cleanSlug = slug.replace(/^\/+|\/+$/g, '').replace(/\.md$/, '');
  if (!cleanSlug) throw new Error('emitWikilink: empty slug');
  if (display && display !== cleanSlug.split('/').pop()) {
    return `[[${cleanSlug}|${display}]]`;
  }
  return `[[${cleanSlug}]]`;
}

/**
 * Extract every wikilink from content. Order preserved, duplicates included
 * (callers dedupe by slug if they care).
 */
export function parseWikilinks(content: string): Wikilink[] {
  const links: Wikilink[] = [];
  WIKILINK_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_PATTERN.exec(content)) !== null) {
    links.push({
      slug: match[1].trim(),
      display: match[2]?.trim(),
      raw: match[0],
    });
  }
  return links;
}

/**
 * Resolve a wikilink target against a list of known slugs and their aliases.
 *
 * Returns the canonical slug if found, null if unresolved (broken link).
 * Aliases map: alias string -> canonical slug. Used for Obsidian's
 * `aliases:` frontmatter field — a wikilink whose text matches an alias
 * resolves to the aliased page.
 */
export function resolveWikilink(
  target: string,
  knownSlugs: Set<string>,
  aliases: Map<string, string> = new Map(),
): string | null {
  const normalized = target.trim().replace(/\.md$/, '');
  if (knownSlugs.has(normalized)) return normalized;

  const lower = normalized.toLowerCase();
  for (const slug of knownSlugs) {
    if (slug.toLowerCase() === lower) return slug;
  }

  const aliasHit = aliases.get(normalized) ?? aliases.get(lower);
  if (aliasHit) return aliasHit;

  const tail = normalized.split('/').pop() || normalized;
  for (const slug of knownSlugs) {
    if (slug.endsWith('/' + tail) || slug === tail) return slug;
  }

  return null;
}

/**
 * Plain-markdown form for downstream tools that don't resolve wikilinks.
 * Converts `[[slug]]` to `[slug](slug.md)` and `[[slug|text]]` to `[text](slug.md)`.
 */
export function toPlainMarkdown(content: string): string {
  return content.replace(WIKILINK_PATTERN, (_m, slug: string, display?: string) => {
    const cleanSlug = slug.trim();
    const text = (display?.trim()) || cleanSlug;
    return `[${text}](${cleanSlug}.md)`;
  });
}
