import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..');
const PLUGIN_JSON = join(REPO_ROOT, '.claude-plugin', 'plugin.json');
const MARKETPLACE_JSON = join(REPO_ROOT, '.claude-plugin', 'marketplace.json');
const PACKAGE_JSON = join(REPO_ROOT, 'package.json');
const SKILLS_DIR = join(REPO_ROOT, 'skills');

describe('.claude-plugin/plugin.json', () => {
  const manifest = JSON.parse(readFileSync(PLUGIN_JSON, 'utf-8'));

  test('parses as valid JSON with required fields', () => {
    expect(manifest.name).toBe('pbrain');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.description).toBeTruthy();
    expect(manifest.author?.name).toBeTruthy();
    expect(manifest.repository).toContain('github.com');
    expect(manifest.license).toBeTruthy();
    expect(Array.isArray(manifest.keywords)).toBe(true);
    expect(manifest.keywords.length).toBeGreaterThan(0);
  });

  test('plugin version matches package.json version', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'));
    expect(manifest.version).toBe(pkg.version);
  });
});

describe('.claude-plugin/marketplace.json', () => {
  const marketplace = JSON.parse(readFileSync(MARKETPLACE_JSON, 'utf-8'));

  test('declares exactly one plugin named pbrain under the joedanz marketplace', () => {
    // Marketplace name is the owner/namespace shown as "from <name>" in the
    // Claude Code plugin browser. Keep distinct from the plugin name itself.
    expect(marketplace.name).toBe('joedanz');
    expect(Array.isArray(marketplace.plugins)).toBe(true);
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].name).toBe('pbrain');
    expect(marketplace.plugins[0].source).toBe('./');
  });

  test('plugin entry has required metadata', () => {
    const p = marketplace.plugins[0];
    expect(p.description).toBeTruthy();
    expect(p.repository).toContain('github.com');
    expect(p.license).toBeTruthy();
  });
});

describe('skill frontmatter compatibility', () => {
  test('every shipping skill (per manifest.json) has name + description frontmatter', () => {
    const manifest = JSON.parse(readFileSync(join(SKILLS_DIR, 'manifest.json'), 'utf-8'));
    const missing: string[] = [];
    for (const s of manifest.skills || []) {
      if (!s.path) continue;
      const skillMd = join(SKILLS_DIR, s.path);
      if (!existsSync(skillMd)) { missing.push(`${s.name}: missing ${s.path}`); continue; }
      const content = readFileSync(skillMd, 'utf-8');
      const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1];
      if (!fm) { missing.push(`${s.name}: no frontmatter`); continue; }
      if (!/^name:\s*\S/m.test(fm)) missing.push(`${s.name}: missing name`);
      if (!/^description:\s*\S/m.test(fm)) missing.push(`${s.name}: missing description`);
    }
    expect(missing).toEqual([]);
  });
});
