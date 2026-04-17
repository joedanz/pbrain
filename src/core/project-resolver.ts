/**
 * Resolve a working directory to a pbrain project slug.
 *
 * Two-layer lookup, first hit wins:
 *   1. `.pbrain-project` marker file in cwd or any ancestor up to $HOME.
 *      Deepest marker wins.
 *   2. Git remote URL → canonicalized → injected `findRepoByUrl` lookup.
 *      Remote precedence: origin, upstream, then any other remote.
 *
 * Pure function aside from filesystem reads. `findRepoByUrl` is injected so
 * callers (CLI, future hooks) control DB lifecycle, and so tests can run
 * without an engine.
 */

import { readFileSync, statSync, realpathSync } from 'fs';
import { join, dirname, isAbsolute, resolve as resolvePath } from 'path';

export interface RepoMatch {
  slug: string;
  title: string;
}

/**
 * Find brain repo pages that reference the given canonical URL.
 * Injected by the caller so the resolver stays engine-agnostic.
 */
export type FindRepoByUrl = (url: string) => Promise<RepoMatch[]>;

export type ResolveResult =
  | {
      slug: string;
      matchedVia: 'marker' | `remote:${string}`;
    }
  | null;

export interface ResolveOptions {
  cwd: string;
  /** $HOME equivalent — ancestor walk stops here (exclusive). Defaults to HOME env. */
  home?: string;
  findRepoByUrl: FindRepoByUrl;
}

const MARKER_FILENAME = '.pbrain-project';
const REMOTE_PRECEDENCE = ['origin', 'upstream'];

// ─────────────────────────────────────────────────────────────────
// URL normalization
// ─────────────────────────────────────────────────────────────────

/**
 * Canonicalize a git remote URL to `https://<lowercase-host>/<lowercase-org>/<lowercase-repo>`.
 * Strips `.git`, userinfo, ports, and trailing slashes. Returns null if the input
 * isn't recognizably a git URL.
 *
 * Lowercasing matches GitHub's case-insensitive URL resolution and keeps lookups
 * stable regardless of how onboard or the user typed the URL originally.
 */
export function normalizeGitUrl(input: string): string | null {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  if (/\s/.test(s)) return null;

  let host: string;
  let path: string;

  // scheme://[user@]host[:port]/path (covers https, http, git, ssh)
  const urlLike = s.match(
    /^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([a-zA-Z0-9.-]+)(?::\d+)?\/(.+?)\/?$/,
  );
  // scp form: [user@]host:path/to/repo — ':' is the separator, no port here
  const scpLike = s.match(/^(?:[^@/]+@)?([a-zA-Z0-9.-]+):([^/].+?)\/?$/);

  if (urlLike) {
    host = urlLike[1];
    path = urlLike[2];
  } else if (scpLike) {
    host = scpLike[1];
    path = scpLike[2];
    // scp form: host is bare (no dot) → probably not a real hostname
    if (!host.includes('.')) return null;
  } else {
    return null;
  }

  path = path.replace(/\.git$/i, '');
  if (!path) return null;

  return `https://${host.toLowerCase()}/${path.toLowerCase()}`;
}

// ─────────────────────────────────────────────────────────────────
// Marker walk
// ─────────────────────────────────────────────────────────────────

/**
 * Walk from cwd upward looking for `.pbrain-project` markers.
 *
 * The $HOME floor blocks a marker in $HOME (e.g. a dotfiles repo) from
 * claiming every subdirectory under $HOME. The floor only applies when cwd
 * starts within $HOME; a cwd outside $HOME walks up to the filesystem root.
 *
 * Returns the slug from the deepest (cwd-nearest) marker, so per-subdir
 * overrides win over monorepo roots.
 */
function findMarkerSlug(startDir: string, home: string): string | null {
  let dir = safeRealpath(startDir);
  if (!dir) return null;

  const homeReal = cwdInsideHome(dir, home) ? safeRealpath(home) : null;

  while (true) {
    const slug = parseMarker(safeReadFile(join(dir, MARKER_FILENAME)));
    if (slug) return slug;
    if (homeReal && dir === homeReal) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    if (homeReal && !withinOrEqual(parent, homeReal)) break;
    dir = parent;
  }
  return null;
}

/** First non-empty, non-comment line of a marker file. */
function parseMarker(raw: string | null): string | null {
  if (!raw) return null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    return trimmed;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────
// Git metadata parsing
// ─────────────────────────────────────────────────────────────────

/**
 * Locate the gitdir for a checkout. Handles `.git` as a directory (normal repo)
 * and `.git` as a file (worktree or submodule — points at the real gitdir).
 * Respects the same $HOME floor as `findMarkerSlug`.
 */
export function findGitDir(startDir: string, home?: string): string | null {
  let dir = safeRealpath(startDir);
  if (!dir) return null;

  const homeResolved = home ?? process.env.HOME ?? '';
  const homeReal = cwdInsideHome(dir, homeResolved) ? safeRealpath(homeResolved) : null;

  while (true) {
    const candidate = join(dir, '.git');
    const content = safeReadFile(candidate);
    if (content !== null) {
      // `.git` exists and is a file — parse the gitdir pointer.
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match) {
        const target = match[1].trim();
        return isAbsolute(target) ? target : resolvePath(dir, target);
      }
      return null;
    }
    // Not a file (or unreadable). Fall back to a stat — existsSync so we can
    // distinguish "it's a directory" from "it's missing".
    const stat = safeStat(candidate);
    if (stat?.isDirectory()) return candidate;

    if (homeReal && dir === homeReal) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    if (homeReal && !withinOrEqual(parent, homeReal)) return null;
    dir = parent;
  }
}

/**
 * Follow `commondir` to the shared gitdir when `gitdir` is a per-worktree dir.
 * For a main checkout this returns `gitdir` unchanged.
 */
function resolveCommonGitDir(gitdir: string): string {
  const target = safeReadFile(join(gitdir, 'commondir'))?.trim();
  if (!target) return gitdir;
  return isAbsolute(target) ? target : resolvePath(gitdir, target);
}

/**
 * Parse `.git/config` and return remotes in precedence order: `origin`,
 * `upstream`, then the rest in file order. An empty list means no remotes
 * were found (or the config was unreadable / unparseable).
 */
export function readRemotes(gitdir: string): { name: string; url: string }[] {
  const content = safeReadFile(join(resolveCommonGitDir(gitdir), 'config'));
  if (!content) return [];

  const raw: Record<string, string> = {};
  let currentRemote: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    const section = line.match(/^\s*\[remote\s+"([^"]+)"\s*\]/);
    if (section) { currentRemote = section[1]; continue; }
    if (/^\s*\[/.test(line)) { currentRemote = null; continue; }
    if (currentRemote) {
      const kv = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
      if (kv) raw[currentRemote] = kv[1];
    }
  }

  const ordered: { name: string; url: string }[] = [];
  for (const name of REMOTE_PRECEDENCE) {
    if (raw[name]) ordered.push({ name, url: raw[name] });
  }
  for (const [name, url] of Object.entries(raw)) {
    if (!REMOTE_PRECEDENCE.includes(name)) ordered.push({ name, url });
  }
  return ordered;
}

// ─────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────

export async function resolveProject(opts: ResolveOptions): Promise<ResolveResult> {
  const home = opts.home ?? process.env.HOME ?? '';
  const cwd = opts.cwd;

  // Layer 1: marker file
  const markerSlug = findMarkerSlug(cwd, home);
  if (markerSlug) {
    return { slug: markerSlug, matchedVia: 'marker' };
  }

  // Layer 2: git remote
  const gitdir = findGitDir(cwd, home);
  if (!gitdir) return null;

  for (const remote of readRemotes(gitdir)) {
    const canonical = normalizeGitUrl(remote.url);
    if (!canonical) continue;
    const matches = await opts.findRepoByUrl(canonical);
    if (matches.length > 0) {
      return { slug: matches[0].slug, matchedVia: `remote:${remote.name}` };
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function safeReadFile(path: string): string | null {
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}

function safeRealpath(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

function safeStat(path: string): ReturnType<typeof statSync> | null {
  try { return statSync(path); } catch { return null; }
}

function withinOrEqual(child: string, ancestor: string): boolean {
  if (child === ancestor) return true;
  const withSep = ancestor.endsWith('/') ? ancestor : ancestor + '/';
  return child.startsWith(withSep);
}

/**
 * Cheap string-only prefix check to decide whether to pay for a `realpath(home)`
 * syscall. Callers still need to call `safeRealpath(home)` themselves if true,
 * but this skips the syscall for cwds that obviously aren't under $HOME.
 */
function cwdInsideHome(cwdReal: string, home: string): boolean {
  if (!home) return false;
  if (cwdReal === home) return true;
  const withSep = home.endsWith('/') ? home : home + '/';
  return cwdReal.startsWith(withSep);
}
