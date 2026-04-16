import { join } from 'path';
import { atomicWriteFileSync, isWithinCooldown, DEFAULT_COOLDOWN_MS } from './atomic-write.ts';
import { serializeMarkdown } from './markdown.ts';
import { writeTagFooter } from './tag-footer.ts';
import type { PageType } from './types.ts';

export interface PageWriteInput {
  brainPath: string;
  slug: string;
  type: PageType;
  title: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  compiled_truth: string;
  timeline: string;
}

export interface PageWriteResult {
  path: string;
  status: 'written' | 'deferred';
  reason?: string;
}

/**
 * Single chokepoint for writing a brain page to disk.
 *
 * Guarantees (enforced here, not by callers):
 * 1. Atomic rename-based write — Obsidian never sees a half-written file.
 * 2. 60-second cooldown — if the target file was modified in the last minute,
 *    the user is probably editing it in Obsidian. Defer the write; the next
 *    autopilot cycle picks it up after the user stops typing.
 * 3. Tag duplication — tags appear both in YAML frontmatter (deterministic
 *    parser) and as inline `#tag` footer (Obsidian tag pane, GitHub render).
 * 4. Wikilinks pass through verbatim. Emission happens earlier in the
 *    pipeline (wherever the caller constructs compiled_truth/timeline).
 *
 * Returns `{ status: 'deferred' }` when cooldown blocks the write. Callers
 * decide whether to surface that to the user or silently retry later. Never
 * throws for cooldown — that's expected and idempotent.
 */
export function writePageFile(
  input: PageWriteInput,
  opts: { cooldownMs?: number; force?: boolean } = {},
): PageWriteResult {
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const filePath = join(input.brainPath, `${input.slug}.md`);

  if (!opts.force && cooldownMs > 0 && isWithinCooldown(filePath, cooldownMs)) {
    return {
      path: filePath,
      status: 'deferred',
      reason: `File modified within the last ${Math.round(cooldownMs / 1000)}s — likely being edited by the user`,
    };
  }

  const serialized = serializeMarkdown(
    input.frontmatter,
    input.compiled_truth,
    input.timeline,
    { type: input.type, title: input.title, tags: input.tags },
  );
  const withFooter = writeTagFooter(serialized, input.tags);

  atomicWriteFileSync(filePath, withFooter);
  return { path: filePath, status: 'written' };
}
