import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  applyPlan,
  applyUninstall,
  detectClients,
  enumerateSkills,
  findRepoRoot,
  planInstall,
  planUninstall,
  resolveTargetDirs,
  scanTargets,
  type Skill,
  type Target,
} from '../src/core/skill-installer.ts';

// A scratch directory per-test so we can freely create symlinks without
// touching the real ~/.claude. All tests use absolute paths inside tmpdir().
let scratchDir: string;

beforeEach(() => {
  scratchDir = join(tmpdir(), `pbrain-install-skills-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(scratchDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('findRepoRoot + enumerateSkills', () => {
  test('finds the repo root and reads manifest', () => {
    const root = findRepoRoot();
    expect(root).toBeTruthy();
    const skills = enumerateSkills(root!);
    expect(skills.length).toBeGreaterThan(20);
    // Every source path resolves to an existing SKILL.md.
    for (const s of skills) {
      expect(existsSync(s.srcPath)).toBe(true);
      expect(s.name).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe('resolveTargetDirs', () => {
  test('user scope resolves to ~/.<client>/skills', () => {
    const targets = resolveTargetDirs({ scope: 'user', clients: ['claude', 'cursor'] });
    expect(targets).toHaveLength(2);
    expect(targets[0].client).toBe('claude');
    expect(targets[0].dir).toContain('.claude/skills');
    expect(targets[1].dir).toContain('.cursor/skills');
  });

  test('project scope resolves relative to cwd', () => {
    const targets = resolveTargetDirs({ scope: 'project', clients: ['claude'], cwd: '/tmp/foo' });
    expect(targets[0].dir).toBe('/tmp/foo/.claude/skills');
  });
});

describe('planInstall', () => {
  function makeSkills(): Skill[] {
    const srcA = join(scratchDir, 'src', 'a', 'SKILL.md');
    const srcB = join(scratchDir, 'src', 'b', 'SKILL.md');
    mkdirSync(join(scratchDir, 'src', 'a'), { recursive: true });
    mkdirSync(join(scratchDir, 'src', 'b'), { recursive: true });
    writeFileSync(srcA, 'a');
    writeFileSync(srcB, 'b');
    return [
      { name: 'a', srcPath: srcA },
      { name: 'b', srcPath: srcB },
    ];
  }
  function makeTarget(): Target {
    const dir = join(scratchDir, 'target', 'skills');
    mkdirSync(dir, { recursive: true });
    return { client: 'claude', dir };
  }

  test('missing target → link', () => {
    const skills = makeSkills();
    const target = makeTarget();
    const actions = planInstall(skills, [target]);
    expect(actions.every(a => a.op === 'link')).toBe(true);
  });

  test('symlink pointing at our srcPath → skip-already-linked', () => {
    const skills = makeSkills();
    const target = makeTarget();
    symlinkSync(skills[0].srcPath, join(target.dir, 'a'));
    const actions = planInstall(skills, [target]);
    expect(actions.find(a => a.skill.name === 'a')?.op).toBe('skip-already-linked');
    expect(actions.find(a => a.skill.name === 'b')?.op).toBe('link');
  });

  test('foreign symlink → conflict (without --force)', () => {
    const skills = makeSkills();
    const target = makeTarget();
    const foreignSrc = join(scratchDir, 'elsewhere.md');
    writeFileSync(foreignSrc, 'foreign');
    symlinkSync(foreignSrc, join(target.dir, 'a'));
    const actions = planInstall(skills, [target]);
    expect(actions.find(a => a.skill.name === 'a')?.op).toBe('conflict');
  });

  test('foreign symlink + --force → overwrite', () => {
    const skills = makeSkills();
    const target = makeTarget();
    const foreignSrc = join(scratchDir, 'elsewhere.md');
    writeFileSync(foreignSrc, 'foreign');
    symlinkSync(foreignSrc, join(target.dir, 'a'));
    const actions = planInstall(skills, [target], { force: true });
    expect(actions.find(a => a.skill.name === 'a')?.op).toBe('overwrite');
  });

  test('real file → conflict (without --force)', () => {
    const skills = makeSkills();
    const target = makeTarget();
    writeFileSync(join(target.dir, 'a'), 'real file');
    const actions = planInstall(skills, [target]);
    expect(actions.find(a => a.skill.name === 'a')?.op).toBe('conflict');
  });

  test('real directory + --force → overwrite plan (but applyPlan refuses)', () => {
    const skills = makeSkills();
    const target = makeTarget();
    mkdirSync(join(target.dir, 'a'));
    writeFileSync(join(target.dir, 'a', 'SKILL.md'), 'foreign plugin');
    // Plan produces 'overwrite' because --force was asked for...
    const actions = planInstall(skills, [target], { force: true });
    expect(actions.find(a => a.skill.name === 'a')?.op).toBe('overwrite');
    // ...but apply refuses to blow away a real directory full of other files.
    const result = applyPlan(actions);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].error).toContain('refusing to overwrite directory');
    // Real directory is left intact.
    expect(existsSync(join(target.dir, 'a', 'SKILL.md'))).toBe(true);
  });
});

describe('applyPlan', () => {
  test('dry-run performs no filesystem writes', () => {
    const targetDir = join(scratchDir, 't');
    mkdirSync(targetDir, { recursive: true });
    const srcPath = join(scratchDir, 's', 'SKILL.md');
    mkdirSync(join(scratchDir, 's'), { recursive: true });
    writeFileSync(srcPath, 'x');
    const actions = planInstall([{ name: 'x', srcPath }], [{ client: 'claude', dir: targetDir }]);
    const result = applyPlan(actions, { dryRun: true });
    expect(result.linked).toBe(1);
    expect(existsSync(join(targetDir, 'x'))).toBe(false);
  });

  test('creates target dir if missing', () => {
    const targetDir = join(scratchDir, 'deep', 'nested', 'skills');
    const srcPath = join(scratchDir, 's', 'SKILL.md');
    mkdirSync(join(scratchDir, 's'), { recursive: true });
    writeFileSync(srcPath, 'x');
    const actions = planInstall([{ name: 'x', srcPath }], [{ client: 'claude', dir: targetDir }]);
    const result = applyPlan(actions);
    expect(result.linked).toBe(1);
    expect(lstatSync(join(targetDir, 'x')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(targetDir, 'x'))).toBe(srcPath);
  });
});

describe('uninstall safety', () => {
  test('planUninstall only selects symlinks whose target is inside the repo', () => {
    const repoRoot = join(scratchDir, 'repo');
    const skillSrc = join(repoRoot, 'skills', 'x', 'SKILL.md');
    mkdirSync(join(repoRoot, 'skills', 'x'), { recursive: true });
    writeFileSync(skillSrc, 'x');
    const targetDir = join(scratchDir, 'client', 'skills');
    mkdirSync(targetDir, { recursive: true });
    // Ours: symlink into the fake repo.
    symlinkSync(skillSrc, join(targetDir, 'x'));
    // Foreign: symlink somewhere else entirely.
    const foreignSrc = join(scratchDir, 'elsewhere.md');
    writeFileSync(foreignSrc, 'f');
    symlinkSync(foreignSrc, join(targetDir, 'foreign-link'));
    // Real file and real dir — must never be touched.
    writeFileSync(join(targetDir, 'a-real-file'), 'real');
    mkdirSync(join(targetDir, 'a-real-dir'));

    const targets: Target[] = [{ client: 'claude', dir: targetDir }];
    const plan = planUninstall(targets, repoRoot);
    expect(plan).toHaveLength(1);
    expect(plan[0].name).toBe('x');

    const result = applyUninstall(plan);
    expect(result.removed).toBe(1);
    expect(existsSync(join(targetDir, 'x'))).toBe(false);
    // Everything else survives.
    expect(existsSync(join(targetDir, 'foreign-link'))).toBe(true);
    expect(existsSync(join(targetDir, 'a-real-file'))).toBe(true);
    expect(existsSync(join(targetDir, 'a-real-dir'))).toBe(true);
  });
});

describe('scanTargets', () => {
  test('classifies entries correctly', () => {
    const repoRoot = join(scratchDir, 'repo');
    const skillSrc = join(repoRoot, 'skills', 'x', 'SKILL.md');
    mkdirSync(join(repoRoot, 'skills', 'x'), { recursive: true });
    writeFileSync(skillSrc, 'x');
    const targetDir = join(scratchDir, 'client', 'skills');
    mkdirSync(targetDir, { recursive: true });
    symlinkSync(skillSrc, join(targetDir, 'x'));
    symlinkSync(join(scratchDir, 'nowhere'), join(targetDir, 'broken'));
    const foreignSrc = join(scratchDir, 'elsewhere.md');
    writeFileSync(foreignSrc, 'f');
    symlinkSync(foreignSrc, join(targetDir, 'foreign'));
    writeFileSync(join(targetDir, 'file'), 'data');
    mkdirSync(join(targetDir, 'dir'));

    const entries = scanTargets([{ client: 'claude', dir: targetDir }], repoRoot);
    const byName = new Map(entries.map(e => [e.name, e]));
    expect(byName.get('x')?.state).toBe('ours-ok');
    expect(byName.get('broken')?.state).toBe('foreign-symlink'); // broken + not into repo
    expect(byName.get('foreign')?.state).toBe('foreign-symlink');
    expect(byName.get('file')?.state).toBe('foreign-file');
    expect(byName.get('dir')?.state).toBe('foreign-dir');
  });

  test('broken symlink whose raw target was inside the repo is classified as ours-broken', () => {
    const repoRoot = join(scratchDir, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    const targetDir = join(scratchDir, 'client', 'skills');
    mkdirSync(targetDir, { recursive: true });
    // Point at a path that LOOKS like ours but doesn't exist.
    const phantomSrc = join(repoRoot, 'skills', 'was-deleted', 'SKILL.md');
    symlinkSync(phantomSrc, join(targetDir, 'was-deleted'));
    const entries = scanTargets([{ client: 'claude', dir: targetDir }], repoRoot);
    expect(entries[0].state).toBe('ours-broken');
  });
});

describe('detectClients', () => {
  test('returns a subset of known clients without throwing', () => {
    const clients = detectClients();
    for (const c of clients) {
      expect(['claude', 'cursor', 'windsurf']).toContain(c);
    }
  });
});

describe('CLI integration', () => {
  test('CLI registers install-skills command', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', '--help'],
      cwd: import.meta.dir + '/..',
    });
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain('install-skills');
  });

  test('install-skills --help works', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'install-skills', '--help'],
      cwd: import.meta.dir + '/..',
    });
    const stdout = new TextDecoder().decode(result.stdout);
    expect(stdout).toContain('Usage: pbrain install-skills');
    expect(stdout).toContain('--scope');
    expect(stdout).toContain('--force');
  });

  test('install-skills --dry-run --client claude does not write', () => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'install-skills', '--dry-run', '--client', 'claude', '--json'],
      cwd: import.meta.dir + '/..',
    });
    const stdout = new TextDecoder().decode(result.stdout);
    const parsed = JSON.parse(stdout);
    expect(parsed.dry_run).toBe(true);
    expect(parsed.targets).toHaveLength(1);
    expect(parsed.targets[0].client).toBe('claude');
  });
});
