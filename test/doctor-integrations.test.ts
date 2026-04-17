import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkIntegrations } from '../src/core/doctor-integrations.ts';

function mkBrain() {
  return mkdtempSync(join(tmpdir(), 'pbrain-brain-'));
}

function writePage(brain: string, slug: string, body: string) {
  const path = join(brain, `${slug}.md`);
  mkdirSync(join(brain, slug.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
  writeFileSync(path, body);
  return path;
}

test('checkIntegrations reports missing brain when unset', () => {
  const report = checkIntegrations(null);
  expect(report.ok).toBe(false);
  expect(report.issues[0].type).toBe('missing_brain');
});

test('checkIntegrations reports missing brain for nonexistent path', () => {
  const report = checkIntegrations('/tmp/does-not-exist-pbrain-xyz');
  expect(report.ok).toBe(false);
  expect(report.issues[0].type).toBe('missing_brain');
});

test('checkIntegrations green path on empty brain', () => {
  const brain = mkBrain();
  const report = checkIntegrations(brain);
  expect(report.ok).toBe(true);
  expect(report.stats.pages_scanned).toBe(0);
  rmSync(brain, { recursive: true });
});

test('checkIntegrations green path with valid wikilinks and aliases', () => {
  const brain = mkBrain();
  writePage(brain, 'companies/anthropic', '---\naliases: ["Anthropic PBC"]\ntags: [company, ai]\n---\nMakes Claude.');
  writePage(brain, 'people/dario', '---\ntags: [person]\n---\nCEO of [[companies/anthropic]].');
  writePage(brain, 'notes/misc', 'See [[Anthropic PBC]] and [[dario]].');

  const report = checkIntegrations(brain);
  expect(report.ok).toBe(true);
  expect(report.stats.pages_scanned).toBe(3);
  expect(report.stats.wikilinks_checked).toBe(3);
  rmSync(brain, { recursive: true });
});

test('checkIntegrations detects broken wikilinks', () => {
  const brain = mkBrain();
  writePage(brain, 'notes/a', 'link to [[companies/openai]] which does not exist.');
  const report = checkIntegrations(brain);
  expect(report.ok).toBe(false);
  const broken = report.issues.find(i => i.type === 'broken_wikilink');
  expect(broken).toBeDefined();
  expect(broken!.detail).toContain('companies/openai');
  rmSync(brain, { recursive: true });
});

test('checkIntegrations does NOT flag tail collision when all refs are path-qualified', () => {
  const brain = mkBrain();
  // Classic project-onboard case: projects/pbrain + repos/joedanz/pbrain
  writePage(brain, 'projects/pbrain', 'The PBrain project.\n\nRepo: [[repos/joedanz/pbrain]].');
  writePage(brain, 'repos/joedanz/pbrain', 'Project: [[projects/pbrain]].');
  const report = checkIntegrations(brain);
  const dup = report.issues.find(i => i.type === 'duplicate_slug');
  expect(dup).toBeUndefined();
  expect(report.ok).toBe(true);
  rmSync(brain, { recursive: true });
});

test('checkIntegrations flags duplicate slug only when bare-slug wikilink references it', () => {
  const brain = mkBrain();
  writePage(brain, 'libraries/react', 'the JS library.');
  writePage(brain, 'concepts/react', 'the pattern of reacting.');
  writePage(brain, 'notes/a', 'I used [[react]] yesterday.'); // bare-slug → ambiguous
  const report = checkIntegrations(brain);
  expect(report.ok).toBe(false);
  const dup = report.issues.find(i => i.type === 'duplicate_slug');
  expect(dup).toBeDefined();
  expect(dup!.path).toContain('libraries/react');
  expect(dup!.path).toContain('concepts/react');
  expect(dup!.detail).toContain('notes/a');
  rmSync(brain, { recursive: true });
});

test('checkIntegrations detects leftover .pbrain-tmp- sentinels', () => {
  const brain = mkBrain();
  writePage(brain, 'notes/a', 'ok');
  writeFileSync(join(brain, '.pbrain-tmp-notes-a.md-deadbeef'), 'partial');
  const report = checkIntegrations(brain);
  expect(report.ok).toBe(false);
  expect(report.stats.leftover_tmp).toBe(1);
  const leftover = report.issues.find(i => i.type === 'leftover_tmp');
  expect(leftover).toBeDefined();
  rmSync(brain, { recursive: true });
});

test('checkIntegrations detects malformed tags frontmatter', () => {
  const brain = mkBrain();
  writePage(brain, 'notes/bad', '---\ntags: 123\n---\nbody');
  const report = checkIntegrations(brain);
  expect(report.ok).toBe(false);
  const yamlIssue = report.issues.find(i => i.type === 'yaml_error');
  expect(yamlIssue).toBeDefined();
  expect(yamlIssue!.detail).toContain('tags:');
  rmSync(brain, { recursive: true });
});

test('checkIntegrations accepts tags as list or string', () => {
  const brain = mkBrain();
  writePage(brain, 'notes/a', '---\ntags: [a, b]\n---\nbody');
  writePage(brain, 'notes/b', '---\ntags: "a b"\n---\nbody');
  const report = checkIntegrations(brain);
  expect(report.issues.filter(i => i.type === 'yaml_error')).toHaveLength(0);
  rmSync(brain, { recursive: true });
});

test('checkIntegrations surfaces scan_error on unreadable subdir, does not silently pass', () => {
  const brain = mkBrain();
  // readable sibling so the root walk succeeds
  writePage(brain, 'ok/page', 'body');
  // create an unreadable subdir (mode 000)
  const unreadable = join(brain, 'locked');
  mkdirSync(unreadable);
  writeFileSync(join(unreadable, 'hidden.md'), 'body');
  chmodSync(unreadable, 0o000);

  try {
    const report = checkIntegrations(brain);
    // Must flag the scan failure rather than silently reporting green
    const scanErr = report.issues.find(i => i.type === 'scan_error');
    expect(scanErr).toBeDefined();
    expect(scanErr!.path).toBe(unreadable);
    expect(report.ok).toBe(false);
  } finally {
    chmodSync(unreadable, 0o755);
    rmSync(brain, { recursive: true });
  }
});
