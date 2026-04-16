import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writePageFile } from '../src/core/page-writer.ts';

function mkBrain() {
  return mkdtempSync(join(tmpdir(), 'pbrain-brain-'));
}

test('writePageFile writes a page atomically with frontmatter and footer', () => {
  const brain = mkBrain();
  const result = writePageFile({
    brainPath: brain,
    slug: 'companies/anthropic',
    type: 'company',
    title: 'Anthropic',
    tags: ['ai', 'foundation-model'],
    frontmatter: {},
    compiled_truth: 'Makes Claude. Founded by Dario and Daniela Amodei.',
    timeline: '- **2026-04-16** | Referenced [Source: user, 2026-04-16]',
  });
  expect(result.status).toBe('written');

  const content = readFileSync(result.path, 'utf-8');
  expect(content).toContain('title: Anthropic');
  expect(content).toContain('type: company');
  expect(content).toContain('Makes Claude');
  expect(content).toContain('<!-- pbrain-tags -->');
  expect(content).toContain('#ai #foundation-model');
  rmSync(brain, { recursive: true });
});

test('writePageFile defers when file was recently modified', () => {
  const brain = mkBrain();
  const slug = 'companies/anthropic';
  const filePath = join(brain, `${slug}.md`);
  mkdirSync(join(brain, 'companies'), { recursive: true });
  writeFileSync(filePath, 'user-edit');

  const result = writePageFile({
    brainPath: brain,
    slug,
    type: 'company',
    title: 'Anthropic',
    tags: [],
    frontmatter: {},
    compiled_truth: 'new content',
    timeline: '',
  });
  expect(result.status).toBe('deferred');
  expect(readFileSync(filePath, 'utf-8')).toBe('user-edit');
  rmSync(brain, { recursive: true });
});

test('writePageFile with force:true overrides cooldown', () => {
  const brain = mkBrain();
  const slug = 'companies/anthropic';
  const filePath = join(brain, `${slug}.md`);
  mkdirSync(join(brain, 'companies'), { recursive: true });
  writeFileSync(filePath, 'user-edit');

  const result = writePageFile(
    {
      brainPath: brain,
      slug,
      type: 'company',
      title: 'Anthropic',
      tags: [],
      frontmatter: {},
      compiled_truth: 'forced content',
      timeline: '',
    },
    { force: true },
  );
  expect(result.status).toBe('written');
  expect(readFileSync(filePath, 'utf-8')).toContain('forced content');
  rmSync(brain, { recursive: true });
});

test('writePageFile writes when file is older than cooldown', () => {
  const brain = mkBrain();
  const slug = 'companies/anthropic';
  const filePath = join(brain, `${slug}.md`);
  mkdirSync(join(brain, 'companies'), { recursive: true });
  writeFileSync(filePath, 'old content');
  // Backdate the mtime by two minutes
  const old = new Date(Date.now() - 2 * 60 * 1000);
  utimesSync(filePath, old, old);

  const result = writePageFile({
    brainPath: brain,
    slug,
    type: 'company',
    title: 'Anthropic',
    tags: [],
    frontmatter: {},
    compiled_truth: 'new content',
    timeline: '',
  });
  expect(result.status).toBe('written');
  rmSync(brain, { recursive: true });
});
