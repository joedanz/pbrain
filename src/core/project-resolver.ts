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

import { readFileSync, existsSync, statSync, realpathSync } from 'fs';
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
      repoSlug: string | null;
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
 * The $HOME floor prevents the ancestor walk from escaping upward into
 * arbitrary user directories — specifically, it blocks a marker in $HOME
 * (e.g. a dotfiles repo's `.pbrain-project`) from claiming every subdirectory
 * under $HOME. The floor only applies when cwd starts *within* $HOME; a cwd
 * outside $HOME (like /tmp/scratch) walks up to the filesystem root normally.
 *
 * Returns the slug from the DEEPEST marker (cwd-nearest), so per-subdir
 * overrides win over monorepo roots.
 */
function findMarkerSlug(startDir: string, home: string): string | null {
  let dir = safeRealpath(startDir);
  if (!dir) return null;

  const homeReal = safeRealpath(home);
  const honorHomeFloor = homeReal !== null && withinOrEqual(dir, homeReal);

  while (true) {
    const marker = join(dir, MARKER_FILENAME);
    if (existsSync(marker) && safeStat(marker)?.isFile()) {
      const slug = parseMarker(safeReadFile(marker));
      if (slug) return slug;
    }
    if (honorHomeFloor && dir === homeReal) break;
    const parent = dirname(dir);
    if (parent === dir) break;  // filesystem root
    if (honorHomeFloor && !withinOrEqual(parent, homeReal!)) break;
    dir = parent;
  }
  return null;
}

/** Pull the first non-empty, non-comment line out of a marker file. */
function parseMarker(raw: string | null): string | null {
  if (!raw) return null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    return trimmed;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────
// Git metadata parsing
// ─────────────────────────────────────────────────────────────────

/** Locate the gitdir for a checkout. Handles both `.git` dirs and `.git` files (worktrees/submodules). */
function findGitDir(startDir: string): string | null {
  let dir = safeRealpath(startDir);
  if (!dir) return null;
  while (true) {
    const candidate = join(dir, '.git');
    if (existsSync(candidate)) {
      const stat = safeStat(candidate);
      if (!stat) return null;
      if (stat.isDirectory()) return candidate;
      if (stat.isFile()) {
        const pointer = safeReadFile(candidate);
        const match = pointer?.match(/^gitdir:\s*(.+)$/m);
        if (!match) return null;
        const target = match[1].trim();
        return isAbsolute(target) ? target : resolvePath(dir, target);
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve a worktree gitdir to its common gitdir (where `config` actually lives).
 * For the main checkout this returns the same dir. For a linked worktree it follows
 * the `commondir` file.
 */
function resolveCommonGitDir(gitdir: string): string {
  const commondirFile = join(gitdir, 'commondir');
  if (existsSync(commondirFile)) {
    const target = safeReadFile(commondirFile)?.trim();
    if (target) {
      return isAbsolute(target) ? target : resolvePath(gitdir, target);
    }
  }
  return gitdir;
}

/**
 * Parse a `.git/config` INI file and return remotes in precedence order.
 * Precedence: origin first, upstream second, then the rest in file order.
 */
function readRemotes(gitdir: string): { name: string; url: string }[] {
  const common = resolveCommonGitDir(gitdir);
  const configPath = join(common, 'config');
  const content = safeReadFile(configPath);
  if (!content) return [];

  const raw: Record<string, string> = {};
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
      if (kv) raw[currentRemote] = kv[1];
    }
  }

  const ordered: { name: string; url: string }[] = [];
  for (const name of REMOTE_PRECEDENCE) {
    if (raw[name]) ordered.push({ name, url: raw[name] });
  }
  for (const [name, url] of Object.entries(raw)) {
    if (REMOTE_PRECEDENCE.includes(name)) continue;
    ordered.push({ name, url });
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
    return { slug: markerSlug, repoSlug: null, matchedVia: 'marker' };
  }

  // Layer 2: git remote
  const gitdir = findGitDir(cwd);
  if (!gitdir) return null;

  const remotes = readRemotes(gitdir);
  for (const remote of remotes) {
    const canonical = normalizeGitUrl(remote.url);
    if (!canonical) continue;
    const matches = await opts.findRepoByUrl(canonical);
    if (matches.length > 0) {
      // Multiple matches → pick the first deterministically but callers (whoami)
      // can re-query and warn about ambiguity.
      const hit = matches[0];
      return {
        slug: hit.slug,
        repoSlug: hit.slug,
        matchedVia: `remote:${remote.name}`,
      };
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

/** Returns true if `child` is equal to or nested under `ancestor` (realpath'd). */
function withinOrEqual(child: string, ancestor: string): boolean {
  if (child === ancestor) return true;
  const withSep = ancestor.endsWith('/') ? ancestor : ancestor + '/';
  return child.startsWith(withSep);
}
