/**
 * Belt-and-suspenders tag emission.
 *
 * Every PBrain-written page carries tags in TWO places:
 * 1. YAML frontmatter `tags: [foo, bar]` — deterministic parser, Dataview queries
 * 2. Inline `#foo #bar` footer at end of body — Obsidian tag pane, GitHub rendering
 *
 * Both are authoritative; on read, the union wins. The duplication is
 * intentional — different consumers (Obsidian search, Dataview plugin,
 * PBrain's own parser, GitHub's markdown renderer) look in different
 * places, and writing to only one leaves a consumer blind.
 */

const TAG_FOOTER_MARKER = '<!-- pbrain-tags -->';
const TAG_FOOTER_RE = /\n*<!-- pbrain-tags -->\n#[\w#\-/ ]+\n*$/;

/**
 * Normalize a tag: lowercase, strip leading `#`, replace whitespace with dashes.
 */
export function normalizeTag(tag: string): string {
  return tag
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-');
}

/**
 * Append or replace the inline tag footer on a markdown body.
 *
 * Idempotent: re-running with the same tags leaves the body unchanged.
 * Calling with an empty array strips the footer entirely.
 */
export function writeTagFooter(body: string, tags: string[]): string {
  const stripped = body.replace(TAG_FOOTER_RE, '').replace(/\s+$/, '');
  const normalized = Array.from(new Set(tags.map(normalizeTag).filter(Boolean)));
  if (normalized.length === 0) return stripped + '\n';
  const footer = `\n\n${TAG_FOOTER_MARKER}\n${normalized.map(t => `#${t}`).join(' ')}\n`;
  return stripped + footer;
}

/**
 * Parse tags from an inline `#tag` footer, if present.
 * Returns the normalized list. Empty if no footer.
 */
export function parseTagFooter(body: string): string[] {
  const match = body.match(TAG_FOOTER_RE);
  if (!match) return [];
  const line = match[0].split('\n').find(l => l.startsWith('#')) || '';
  return line
    .split(/\s+/)
    .filter(t => t.startsWith('#'))
    .map(t => normalizeTag(t));
}
