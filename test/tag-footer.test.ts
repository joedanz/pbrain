import { test, expect } from 'bun:test';
import { writeTagFooter, parseTagFooter, normalizeTag } from '../src/core/tag-footer.ts';

test('normalizeTag strips # and lowercases', () => {
  expect(normalizeTag('#Anthropic')).toBe('anthropic');
  expect(normalizeTag('AI Tools')).toBe('ai-tools');
  expect(normalizeTag('  #deep-learning  ')).toBe('deep-learning');
});

test('writeTagFooter appends footer with tags', () => {
  const out = writeTagFooter('body content', ['ai', 'libraries']);
  expect(out).toContain('<!-- pbrain-tags -->');
  expect(out).toContain('#ai #libraries');
});

test('writeTagFooter is idempotent', () => {
  const first = writeTagFooter('body', ['a', 'b']);
  const second = writeTagFooter(first, ['a', 'b']);
  expect(second).toBe(first);
});

test('writeTagFooter replaces existing footer', () => {
  const first = writeTagFooter('body', ['old']);
  const second = writeTagFooter(first, ['new']);
  expect(second).toContain('#new');
  expect(second).not.toContain('#old');
});

test('writeTagFooter strips footer when tags empty', () => {
  const withFooter = writeTagFooter('body', ['a']);
  const stripped = writeTagFooter(withFooter, []);
  expect(stripped).not.toContain('<!-- pbrain-tags -->');
  expect(stripped.trim()).toBe('body');
});

test('writeTagFooter dedupes and normalizes', () => {
  const out = writeTagFooter('body', ['AI', 'ai', '#AI']);
  expect(out.match(/#ai/g)?.length).toBe(1);
});

test('parseTagFooter extracts tags', () => {
  const body = writeTagFooter('hello', ['ai', 'libraries']);
  expect(parseTagFooter(body).sort()).toEqual(['ai', 'libraries']);
});

test('parseTagFooter returns empty when no footer', () => {
  expect(parseTagFooter('no footer here')).toEqual([]);
});
