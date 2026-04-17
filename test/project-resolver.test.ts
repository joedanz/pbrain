/**
 * Tests for the cwd → project-slug resolver.
 *
 * The resolver has two layers (first hit wins):
 *   1. `.pbrain-project` marker file in cwd or any ancestor (up to $HOME floor).
 *      Deepest marker wins.
 *   2. Git remote → canonicalized URL → injected `findRepoByUrl` lookup.
 *      Try remotes in order: origin, upstream, then any other remote.
 *
 * Tests use a temp-directory sandbox so none of them touch real $HOME or real
 * git repos. The `findRepoByUrl` dep is injected as a simple fake so we can
 * assert the normalization flowing into it without standing up a real engine.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveProject,
  normalizeGitUrl,
  type FindRepoByUrl,
  type ResolveResult,
} from '../src/core/project-resolver.ts';

// ─────────────────────────────────────────────────────────────────
// Test sandbox: a temp directory that doubles as $HOME for the
// duration of each test, so ancestor-walks can't escape into real
// filesystem.
// ─────────────────────────────────────────────────────────────────

let sandbox: string;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pbrain-resolver-')));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** Writes a minimal `.git/config` that declares the given remotes. */
function writeGitConfig(repoRoot: string, remotes: Record<string, string>) {
  mkdirSync(join(repoRoot, '.git'), { recursive: true });
  const sections = Object.entries(remotes).map(([name, url]) =>
    `[remote "${name}"]\n\turl = ${url}\n`,
  );
  writeFileSync(
    join(repoRoot, '.git', 'config'),
    '[core]\n\trepositoryformatversion = 0\n' + sections.join(''),
  );
}

/** Writes a `.git` file (for worktrees/submodules) pointing at a gitdir. */
function writeGitFile(checkout: string, gitdir: string) {
  writeFileSync(join(checkout, '.git'), `gitdir: ${gitdir}\n`);
}

/** Build a default fake `findRepoByUrl` that returns one match for a given URL. */
function fakeRepoByUrl(map: Record<string, { slug: string; title?: string }>): FindRepoByUrl {
  return async (url: string) => {
    const hit = map[url];
    return hit ? [{ slug: hit.slug, title: hit.title || hit.slug }] : [];
  };
}

// ─────────────────────────────────────────────────────────────────
// URL normalization
// ─────────────────────────────────────────────────────────────────
describe('normalizeGitUrl', () => {
  test('canonicalizes SSH URL', () => {
    expect(normalizeGitUrl('git@github.com:joedanz/picspot.git'))
      .toBe('https://github.com/joedanz/picspot');
  });

  test('canonicalizes HTTPS URL with .git suffix', () => {
    expect(normalizeGitUrl('https://github.com/joedanz/picspot.git'))
      .toBe('https://github.com/joedanz/picspot');
  });

  test('canonicalizes HTTPS URL without .git suffix', () => {
    expect(normalizeGitUrl('https://github.com/joedanz/picspot'))
      .toBe('https://github.com/joedanz/picspot');
  });

  test('lowercases host and path', () => {
    expect(normalizeGitUrl('git@GitHub.com:JoeDanz/PicSpot.git'))
      .toBe('https://github.com/joedanz/picspot');
  });

  test('canonicalizes ssh:// URL with non-standard port', () => {
    expect(normalizeGitUrl('ssh://git@github.com:2222/joedanz/picspot.git'))
      .toBe('https://github.com/joedanz/picspot');
  });

  test('canonicalizes git:// URL', () => {
    expect(normalizeGitUrl('git://github.com/joedanz/picspot.git'))
      .toBe('https://github.com/joedanz/picspot');
  });

  test('strips trailing slash', () => {
    expect(normalizeGitUrl('https://github.com/joedanz/picspot/'))
      .toBe('https://github.com/joedanz/picspot');
  });

  test('preserves non-GitHub hosts (GitLab)', () => {
    expect(normalizeGitUrl('git@gitlab.com:acme/foo.git'))
      .toBe('https://gitlab.com/acme/foo');
  });

  test('preserves GitHub Enterprise hosts', () => {
    expect(normalizeGitUrl('git@github.mycorp.com:acme/foo.git'))
      .toBe('https://github.mycorp.com/acme/foo');
  });

  test('returns null for unparseable garbage', () => {
    expect(normalizeGitUrl('not a url')).toBeNull();
    expect(normalizeGitUrl('')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// Marker file layer
// ─────────────────────────────────────────────────────────────────
describe('resolveProject — marker file layer', () => {
  test('marker in cwd resolves to that slug', async () => {
    writeFileSync(join(sandbox, '.pbrain-project'), 'projects/myproj\n');
    const result = await resolveProject({
      cwd: sandbox,
      home: sandbox,
      findRepoByUrl: fakeRepoByUrl({}),
    });
    expect(result).toEqual({
      slug: 'projects/myproj',
      repoSlug: null,
      matchedVia: 'marker',
    });
  });

  test('marker in ancestor resolves when cwd has none', async () => {
    const deep = join(sandbox, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(sandbox, '.pbrain-project'), 'projects/root\n');
    const result = await resolveProject({
      cwd: deep,
      home: sandbox,
      findRepoByUrl: fakeRepoByUrl({}),
    });
    expect(result?.slug).toBe('projects/root');
    expect(result?.matchedVia).toBe('marker');
  });

  test('deepest marker wins over ancestor marker', async () => {
    const deep = join(sandbox, 'pkg', 'sub');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(sandbox, '.pbrain-project'), 'projects/monorepo\n');
    writeFileSync(join(deep, '.pbrain-project'), 'projects/submodule\n');
    const result = await resolveProject({
      cwd: deep,
      home: sandbox,
      findRepoByUrl: fakeRepoByUrl({}),
    });
    expect(result?.slug).toBe('projects/submodule');
  });

  test('$HOME floor prevents ancestor-walk escaping upward', async () => {
    // Place a marker ABOVE the home floor — resolver must not find it.
    const parentOfHome = realpathSync(mkdtempSync(join(tmpdir(), 'pbrain-parent-')));
    try {
      const home = join(parentOfHome, 'home');
      const cwd = join(home, 'project');
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(parentOfHome, '.pbrain-project'), 'projects/leaked\n');
      const result = await resolveProject({
        cwd,
        home,
        findRepoByUrl: fakeRepoByUrl({}),
      });
      expect(result).toBeNull();
    } finally {
      rmSync(parentOfHome, { recursive: true, force: true });
    }
  });

  test('malformed marker (empty file) falls through to next layer', async () => {
    writeFileSync(join(sandbox, '.pbrain-project'), '');
    const result = await resolveProject({
      cwd: sandbox,
      home: sandbox,
      findRepoByUrl: fakeRepoByUrl({}),
    });
    expect(result).toBeNull();
  });

  test('marker with whitespace-only content falls through', async () => {
    writeFileSync(join(sandbox, '.pbrain-project'), '   \n\n\t');
    const result = await resolveProject({
      cwd: sandbox,
      home: sandbox,
      findRepoByUrl: fakeRepoByUrl({}),
    });
    expect(result).toBeNull();
  });

  test('marker with multi-line content uses only first non-empty line', async () => {
    writeFileSync(join(sandbox, '.pbrain-project'), '\nprojects/foo\n# a comment\n');
    const result = await resolveProject({
      cwd: sandbox,
      home: sandbox,
      findRepoByUrl: fakeRepoByUrl({}),
    });
    expect(result?.slug).toBe('projects/foo');
  });

  test('marker in cwd resolves even when cwd is outside $HOME', async () => {
    // Common real-world case: user drops a marker in /tmp/scratch while
    // $HOME points at /Users/foo. The resolver should still check cwd.
    writeFileSync(join(sandbox, '.pbrain-project'), 'projects/outside-home\n');
    const result = await resolveProject({
      cwd: sandbox,
      home: '/Users/nobody-home',  // some path that doesn't contain sandbox
      findRepoByUrl: fakeRepoByUrl({}),
    });
    expect(result?.slug).toBe('projects/outside-home');
  });

  test('symlinked cwd resolves via realpath', async () => {
    const real = join(sandbox, 'real');
    const link = join(sandbox, 'linked');
    mkdirSync(real);
    writeFileSync(join(real, '.pbrain-project'), 'projects/sym\n');
    symlinkSync(real, link);
    const result = await resolveProject({
      cwd: link,
      home: sandbox,
      findRepoByUrl: fakeRepoByUrl({}),
    });
    expect(result?.slug).toBe('projects/sym');
  });
});

// ─────────────────────────────────────────────────────────────────
// Git remote layer
// ─────────────────────────────────────────────────────────────────
describe('resolveProject — git remote layer', () => {
  test('resolves via origin remote (HTTPS)', async () => {
    writeGitConfig(sandbox, { origin: 'https://github.com/joedanz/picspot.git' });
    const result = await resolveProject({
      cwd: sandbox,
      home: sandbox,
      findRepoByUrl: fakeRepoByUrl({
        'https://github.com/joedanz/picspot': { slug: 'repos/joedanz-picspot' },
      }),
    });
    expect(result).toEqual({
      slug: 'repos/joedanz-picspot',
      repoSlug: 'repos/joedanz-picspot',
      matchedVia: 'remote:origin',
    });
  });

  test('resolves via origin remote (SSH)', async () => {
    writeGitConfig(sandbox, { origin: 'git@github.com:joedanz/picspot.git' });
    const result = await resolveProject({
      cwd: sandbox,
      home: sandbox,
      findRepoByUrl: fakeRepoByUrl({
        'https://github.com/joedanz/picspot': { slug: 'repos/joedanz-picspot' },
      }),
    });
    expect(result?.matchedVia).toBe('remote:origin');
  });

  test('falls through to upstream when origin is unknown to the brain', async () => {
    writeGitConfig(sandbox, {
      origin: 'git@github.com:joedanz/claude-code.git',           // Joe's fork — not in brain
      upstream: 'https://github.com/anthropics/claude-code.git',   // canonical — in brain
    });
    const result = await resolveProject({
      cwd: sandbox,
      home: sandbox,
      findRepoByUrl: fakeRepoByUrl({
        'https://github.com/anthropics/claude-code': { slug: 'repos/anthropics-claude-code' },
      }),
    });
    expect(result?.matchedVia).toBe('remote:upstream');
    expect(result?.slug).toBe('repos/anthropics-claude-code');
  });

  test('tries any remaining remotes after origin + upstream miss', async () => {
    writeGitConfig(sandbox, {
      origin: 'https://github.com/fork/repo.git',
      upstream: 'https://github.com/other/repo.git',
      heroku: 'https://github.com/acme/thing.git',
    });
    const result = await resolveProject({
      cwd: sandbox,
      home: sandbox,
      findRepoByUrl: fakeRepoByUrl({
        'https://github.com/acme/thing': { slug: 'repos/acme-thing' },
      }),
    });
    expect(result?.matchedVia).toBe('remote:heroku');
  });

  test('returns null when no remote matches any brain repo', async () => {
    writeGitConfig(sandbox, { origin: 'https://github.com/unknown/repo.git' });
    const result = await resolveProject({
      cwd: sandbox,
      home: sandbox,
      findRepoByUrl: fakeRepoByUrl({}),
    });
    expect(result).toBeNull();
  });

  test('returns null when no .git exists (not a git repo)', async () => {
    const result = await resolveProject({
      cwd: sandbox,
      home: sandbox,
      findRepoByUrl: fakeRepoByUrl({}),
    });
    expect(result).toBeNull();
  });

  test('malformed .git/config does not throw; falls through to miss', async () => {
    mkdirSync(join(sandbox, '.git'));
    writeFileSync(join(sandbox, '.git', 'config'), 'garbage that is not ini {]][');
    const result = await resolveProject({
      cwd: sandbox,
      home: sandbox,
      findRepoByUrl: fakeRepoByUrl({}),
    });
    expect(result).toBeNull();
  });

  test('worktree (.git as file pointing to common gitdir) reads remotes from common gitdir', async () => {
    const mainCheckout = join(sandbox, 'main');
    const worktreeCheckout = join(sandbox, 'wt');
    mkdirSync(mainCheckout, { recursive: true });
    mkdirSync(worktreeCheckout, { recursive: true });

    // Main checkout has a real .git directory.
    writeGitConfig(mainCheckout, {
      origin: 'https://github.com/joedanz/picspot.git',
    });

    // Worktree stores a "gitdir:" pointer file, pointing at a per-worktree
    // subdirectory inside the main repo's .git. The per-worktree dir has a
    // `commondir` file linking back to the shared gitdir (the main `.git`).
    const wtGitDir = join(mainCheckout, '.git', 'worktrees', 'wt');
    mkdirSync(wtGitDir, { recursive: true });
    writeFileSync(join(wtGitDir, 'commondir'), '../..\n'); // → main/.git
    writeGitFile(worktreeCheckout, wtGitDir);

    const result = await resolveProject({
      cwd: worktreeCheckout,
      home: sandbox,
      findRepoByUrl: fakeRepoByUrl({
        'https://github.com/joedanz/picspot': { slug: 'repos/joedanz-picspot' },
      }),
    });
    expect(result?.slug).toBe('repos/joedanz-picspot');
    expect(result?.matchedVia).toBe('remote:origin');
  });

  test('submodule (.git file with gitdir pointer) still reads its own remote', async () => {
    const gitdir = join(sandbox, '.git-modules', 'sub');
    const checkout = join(sandbox, 'sub');
    mkdirSync(gitdir, { recursive: true });
    mkdirSync(checkout, { recursive: true });
    writeFileSync(
      join(gitdir, 'config'),
      '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/lib/foo.git\n',
    );
    writeGitFile(checkout, gitdir);

    const result = await resolveProject({
      cwd: checkout,
      home: sandbox,
      findRepoByUrl: fakeRepoByUrl({
        'https://github.com/lib/foo': { slug: 'repos/lib-foo' },
      }),
    });
    expect(result?.slug).toBe('repos/lib-foo');
  });
});

// ─────────────────────────────────────────────────────────────────
// Cross-layer behavior
// ─────────────────────────────────────────────────────────────────
describe('resolveProject — cross-layer', () => {
  test('marker wins over git remote when both are present', async () => {
    writeGitConfig(sandbox, { origin: 'https://github.com/real/repo.git' });
    writeFileSync(join(sandbox, '.pbrain-project'), 'projects/override\n');
    const result = await resolveProject({
      cwd: sandbox,
      home: sandbox,
      findRepoByUrl: fakeRepoByUrl({
        'https://github.com/real/repo': { slug: 'repos/real-repo' },
      }),
    });
    expect(result?.slug).toBe('projects/override');
    expect(result?.matchedVia).toBe('marker');
  });

  test('result type carries enough for a caller to render whoami output', async () => {
    writeGitConfig(sandbox, { origin: 'https://github.com/joedanz/picspot.git' });
    const result = await resolveProject({
      cwd: sandbox,
      home: sandbox,
      findRepoByUrl: fakeRepoByUrl({
        'https://github.com/joedanz/picspot': { slug: 'repos/joedanz-picspot' },
      }),
    });
    // Compile-time guard: result shape satisfies ResolveResult.
    const _typecheck: ResolveResult = result;
    expect(_typecheck).not.toBeNull();
  });
});
