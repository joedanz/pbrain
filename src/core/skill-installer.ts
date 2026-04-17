/**
 * Skill installer — symlinks PBrain's skills/<name>/SKILL.md into the
 * discovery directories used by Claude Code, Cursor, and Windsurf so they
 * auto-fire in those clients without the user hand-registering anything.
 *
 * Pure functions here; the CLI wrapper in src/commands/install-skills.ts
 * handles flag parsing and stdout. No DB access.
 *
 * Collision policy: we never silently overwrite. A target that already exists
 * and does NOT resolve into the PBrain repo is left alone and reported as a
 * conflict (exit code 2 unless --force). This keeps us from stomping skills
 * other plugins installed.
 *
 * Uninstall only removes symlinks whose resolved target lives inside the
 * PBrain repo. Real files and foreign symlinks are never touched.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

export type Client = 'claude' | 'cursor' | 'windsurf';
export const ALL_CLIENTS: Client[] = ['claude', 'cursor', 'windsurf'];

export type Scope = 'user' | 'project';

export interface Skill {
  name: string;
  /** Absolute path to the SKILL.md file we want to symlink. */
  srcPath: string;
  description?: string;
}

export interface Target {
  client: Client;
  /** Directory where skill symlinks go (e.g., ~/.claude/skills). */
  dir: string;
}

export type ActionOp = 'link' | 'skip-already-linked' | 'overwrite' | 'conflict';

export interface Action {
  op: ActionOp;
  skill: Skill;
  target: Target;
  /** The symlink path we'd create: <target.dir>/<skill.name>. */
  dst: string;
  /** Human-readable reason (for status output). */
  reason: string;
}

export interface InstallOptions {
  force?: boolean;
}

export interface ApplyOptions {
  dryRun?: boolean;
}

export interface ApplyResult {
  linked: number;
  overwritten: number;
  skipped: number;
  conflicts: number;
  errors: Array<{ action: Action; error: string }>;
}

// ---------------------------------------------------------------------------
// Repo + skill discovery
// ---------------------------------------------------------------------------

/**
 * Find the PBrain repo root. Walks up from this source file's directory so
 * it works whether the CLI was launched via `bun link`, a compiled binary,
 * or `bun run src/cli.ts` during dev.
 */
export function findRepoRoot(startDir?: string): string | null {
  let dir = startDir;
  if (!dir) {
    try {
      dir = dirname(fileURLToPath(import.meta.url));
    } catch {
      dir = process.cwd();
    }
  }
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'skills', 'manifest.json'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Read skills/manifest.json and return absolute skill source paths.
 * srcPath points at the skill *directory* (containing SKILL.md), not the
 * SKILL.md file itself — Claude Code / Cursor / Windsurf discover skills by
 * scanning for `<skills-dir>/<name>/SKILL.md`, so the symlink target must be
 * the directory.
 */
export function enumerateSkills(repoRoot: string): Skill[] {
  const manifestPath = join(repoRoot, 'skills', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const skills: Skill[] = [];
  for (const s of manifest.skills || []) {
    if (!s.name || !s.path) continue;
    // manifest paths are "<name>/SKILL.md" — we want the directory.
    const skillDir = join(repoRoot, 'skills', dirname(s.path));
    skills.push({
      name: s.name,
      srcPath: skillDir,
      description: s.description,
    });
  }
  return skills;
}

// ---------------------------------------------------------------------------
// Target (client) detection
// ---------------------------------------------------------------------------

/** Base config dirs per client. Presence = client is installed for this user. */
function clientBaseDir(client: Client): string {
  const home = homedir();
  switch (client) {
    case 'claude': return join(home, '.claude');
    case 'cursor': return join(home, '.cursor');
    case 'windsurf': return join(home, '.windsurf');
  }
}

/** Return the list of clients whose base config directory exists. */
export function detectClients(): Client[] {
  return ALL_CLIENTS.filter(c => existsSync(clientBaseDir(c)));
}

/**
 * Resolve target directories for the given scope and client list.
 * User scope: ~/.<client>/skills.
 * Project scope: $cwd/.<client>/skills.
 */
export function resolveTargetDirs(opts: { scope: Scope; clients: Client[]; cwd?: string }): Target[] {
  const cwd = opts.cwd ?? process.cwd();
  return opts.clients.map(client => {
    const base = opts.scope === 'user' ? clientBaseDir(client) : join(cwd, `.${client}`);
    return { client, dir: join(base, 'skills') };
  });
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Build an action plan. Never touches the filesystem beyond reads.
 *
 * Per-skill logic for each target:
 *   1. dst does not exist → link
 *   2. dst is a symlink already pointing at skill.srcPath → skip-already-linked
 *   3. dst exists (file, dir, or other symlink) and --force → overwrite
 *   4. otherwise → conflict
 */
export function planInstall(skills: Skill[], targets: Target[], opts: InstallOptions = {}): Action[] {
  const actions: Action[] = [];
  for (const target of targets) {
    for (const skill of skills) {
      const dst = join(target.dir, skill.name);
      const classification = classifyDst(dst, skill.srcPath);
      if (classification === 'missing') {
        actions.push({ op: 'link', skill, target, dst, reason: 'new symlink' });
      } else if (classification === 'ours') {
        actions.push({ op: 'skip-already-linked', skill, target, dst, reason: 'already linked' });
      } else if (opts.force) {
        actions.push({ op: 'overwrite', skill, target, dst, reason: `--force: replacing ${classification}` });
      } else {
        actions.push({ op: 'conflict', skill, target, dst, reason: `existing ${classification} (use --force to replace)` });
      }
    }
  }
  return actions;
}

type DstClassification = 'missing' | 'ours' | 'symlink-elsewhere' | 'file' | 'directory';

function classifyDst(dst: string, ourSrc: string): DstClassification {
  let stat;
  try {
    stat = lstatSync(dst);
  } catch {
    return 'missing';
  }
  if (stat.isSymbolicLink()) {
    try {
      const raw = readlinkSync(dst);
      const resolved = resolve(isAbsolute(raw) ? raw : resolve(dirname(dst), raw));
      const want = resolve(ourSrc);
      if (resolved === want) return 'ours';
    } catch {
      // broken symlink — treat as not-ours; overwriting is safe with --force
    }
    return 'symlink-elsewhere';
  }
  if (stat.isDirectory()) return 'directory';
  return 'file';
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/** Execute an action plan. dryRun returns the summary without touching disk. */
export function applyPlan(actions: Action[], opts: ApplyOptions = {}): ApplyResult {
  const result: ApplyResult = { linked: 0, overwritten: 0, skipped: 0, conflicts: 0, errors: [] };

  for (const action of actions) {
    try {
      if (action.op === 'skip-already-linked') {
        result.skipped++;
        continue;
      }
      if (action.op === 'conflict') {
        result.conflicts++;
        continue;
      }
      if (!opts.dryRun) {
        mkdirSync(dirname(action.dst), { recursive: true });
        if (action.op === 'overwrite') {
          unlinkSyncRecursive(action.dst);
        }
        symlinkSync(action.skill.srcPath, action.dst);
      }
      if (action.op === 'overwrite') result.overwritten++;
      else result.linked++;
    } catch (e) {
      result.errors.push({ action, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}

/**
 * Remove a path. If it's a directory (not a symlink to one), we don't recurse
 * — we only ever overwrite things that are our own symlinks or --force-targeted
 * files/symlinks, never full directory trees. Fall back to unlink + fail-open.
 */
function unlinkSyncRecursive(p: string) {
  try {
    const stat = lstatSync(p);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      // Refuse to recursively delete a real directory. Caller will see a symlink
      // failure downstream and record it in errors[].
      throw new Error(`refusing to overwrite directory: ${p}`);
    }
    unlinkSync(p);
  } catch (e) {
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Status + uninstall
// ---------------------------------------------------------------------------

export interface StatusEntry {
  target: Target;
  /** Skill name at that dir. */
  name: string;
  dst: string;
  /**
   * - `ours-ok`: symlink resolves into the current repo root.
   * - `ours-broken`: symlink was clearly ours but now dangles.
   * - `ours-elsewhere`: symlink resolves into a *different* PBrain checkout
   *   (e.g., `~/.pbrain-repo` when doctor is run from a dev clone). Still a
   *   valid install — just not pointing at this tree.
   * - `foreign-*`: a real other-plugin file / symlink / directory.
   */
  state: 'ours-ok' | 'ours-broken' | 'ours-elsewhere' | 'foreign-symlink' | 'foreign-file' | 'foreign-dir';
  /** Where the symlink points (resolved). */
  resolvedTo?: string;
}

/**
 * Walk up from `pathInside` looking for a `package.json` whose `name` field
 * is `pbrain`. Used to classify symlinks that land in a different PBrain
 * checkout (e.g. the global `~/.pbrain-repo` install) as `ours-elsewhere`
 * rather than `foreign-symlink` — they're valid installs, just not this tree.
 */
function isPbrainCheckout(pathInside: string): boolean {
  let dir = pathInside;
  for (let i = 0; i < 12; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg && pkg.name === 'pbrain') return true;
      } catch { /* malformed — keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/**
 * Inspect every entry under each target dir and classify it. Used by
 * `install-skills status` and by the doctor check.
 */
export function scanTargets(targets: Target[], repoRoot: string): StatusEntry[] {
  // Collect all plausible forms of the repo root. On macOS, /tmp resolves via
  // realpath to /private/tmp, so the symlink's resolved target may not share
  // a string prefix with resolve(repoRoot). Check against both.
  const roots = new Set<string>();
  roots.add(resolve(repoRoot));
  try { roots.add(realpathSync(repoRoot)); } catch { /* missing is fine */ }
  const rootList = [...roots];
  const entries: StatusEntry[] = [];
  for (const target of targets) {
    if (!existsSync(target.dir)) continue;
    let names: string[];
    try {
      names = readdirSync(target.dir);
    } catch { continue; }
    for (const name of names) {
      const dst = join(target.dir, name);
      let stat;
      try {
        stat = lstatSync(dst);
      } catch { continue; }
      if (!stat.isSymbolicLink()) {
        if (stat.isDirectory()) entries.push({ target, name, dst, state: 'foreign-dir' });
        else entries.push({ target, name, dst, state: 'foreign-file' });
        continue;
      }
      let resolved: string | undefined;
      try {
        resolved = realpathSync(dst);
      } catch {
        // Broken symlink — check the raw target so we can tell if it was ours
        try {
          const raw = readlinkSync(dst);
          const guess = isAbsolute(raw) ? raw : resolve(dirname(dst), raw);
          if (rootList.some(r => pathInsideRoot(guess, r))) {
            entries.push({ target, name, dst, state: 'ours-broken', resolvedTo: guess });
            continue;
          }
        } catch { /* fall through */ }
        entries.push({ target, name, dst, state: 'foreign-symlink' });
        continue;
      }
      if (rootList.some(r => pathInsideRoot(resolved!, r))) {
        entries.push({ target, name, dst, state: 'ours-ok', resolvedTo: resolved });
      } else if (isPbrainCheckout(resolved!)) {
        entries.push({ target, name, dst, state: 'ours-elsewhere', resolvedTo: resolved });
      } else {
        entries.push({ target, name, dst, state: 'foreign-symlink', resolvedTo: resolved });
      }
    }
  }
  return entries;
}

/**
 * Build a removal list: only symlinks that currently resolve into the repo
 * (or were clearly ours but are now broken). Foreign symlinks, files, and
 * directories are never removed — even with --force, since that belongs to
 * something else.
 */
export function planUninstall(targets: Target[], repoRoot: string): StatusEntry[] {
  return scanTargets(targets, repoRoot).filter(e => e.state === 'ours-ok' || e.state === 'ours-broken');
}

/**
 * Comparison-safe containment test. `candidate` is considered inside `root`
 * when, after realpath-normalization of `root`, candidate matches root or is
 * a strict path-boundary descendant (not just a string prefix — so
 * `/repo-other/...` is NOT inside `/repo`).
 */
function pathInsideRoot(candidate: string, root: string): boolean {
  const a = resolve(candidate);
  const b = resolve(root);
  if (a === b) return true;
  const sep = b.endsWith('/') ? b : b + '/';
  return a.startsWith(sep);
}

export function applyUninstall(entries: StatusEntry[], opts: ApplyOptions = {}): { removed: number; errors: Array<{ entry: StatusEntry; error: string }> } {
  const out = { removed: 0, errors: [] as Array<{ entry: StatusEntry; error: string }> };
  for (const entry of entries) {
    try {
      if (!opts.dryRun) unlinkSync(entry.dst);
      out.removed++;
    } catch (e) {
      out.errors.push({ entry, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
