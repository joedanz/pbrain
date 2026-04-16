import { test, expect } from 'bun:test';
import {
  emitWikilink,
  parseWikilinks,
  resolveWikilink,
  toPlainMarkdown,
} from '../src/core/wikilink.ts';

test('emitWikilink canonical form', () => {
  expect(emitWikilink('companies/anthropic')).toBe('[[companies/anthropic]]');
});

test('emitWikilink with display text', () => {
  expect(emitWikilink('companies/anthropic', 'Anthropic')).toBe('[[companies/anthropic|Anthropic]]');
});

test('emitWikilink omits display when it equals slug tail', () => {
  expect(emitWikilink('people/garry-tan', 'garry-tan')).toBe('[[people/garry-tan]]');
});

test('emitWikilink strips .md and leading/trailing slashes', () => {
  expect(emitWikilink('/companies/anthropic.md/')).toBe('[[companies/anthropic]]');
});

test('emitWikilink rejects empty slug', () => {
  expect(() => emitWikilink('')).toThrow();
});

test('parseWikilinks extracts all links in order', () => {
  const body = 'See [[companies/anthropic]] and [[people/dario|Dario]] for more.';
  const links = parseWikilinks(body);
  expect(links).toHaveLength(2);
  expect(links[0].slug).toBe('companies/anthropic');
  expect(links[0].display).toBeUndefined();
  expect(links[1].slug).toBe('people/dario');
  expect(links[1].display).toBe('Dario');
});

test('parseWikilinks ignores single brackets and non-wikilink syntax', () => {
  const body = 'Link to [regular](foo.md) and array [1, 2, 3] not wikilinks.';
  expect(parseWikilinks(body)).toHaveLength(0);
});

test('resolveWikilink finds exact match', () => {
  const known = new Set(['companies/anthropic', 'people/dario']);
  expect(resolveWikilink('companies/anthropic', known)).toBe('companies/anthropic');
});

test('resolveWikilink is case-insensitive', () => {
  const known = new Set(['companies/Anthropic']);
  expect(resolveWikilink('companies/anthropic', known)).toBe('companies/Anthropic');
});

test('resolveWikilink uses aliases', () => {
  const known = new Set(['companies/anthropic']);
  const aliases = new Map([['Anthropic PBC', 'companies/anthropic']]);
  expect(resolveWikilink('Anthropic PBC', known, aliases)).toBe('companies/anthropic');
});

test('resolveWikilink falls back to slug tail match', () => {
  const known = new Set(['companies/anthropic']);
  expect(resolveWikilink('anthropic', known)).toBe('companies/anthropic');
});

test('resolveWikilink returns null for unresolved', () => {
  const known = new Set(['companies/anthropic']);
  expect(resolveWikilink('companies/openai', known)).toBeNull();
});

test('toPlainMarkdown rewrites wikilinks to standard markdown', () => {
  const body = 'See [[companies/anthropic]] and [[people/dario|Dario]].';
  expect(toPlainMarkdown(body)).toBe(
    'See [companies/anthropic](companies/anthropic.md) and [Dario](people/dario.md).',
  );
});
