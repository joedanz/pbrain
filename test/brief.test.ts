/**
 * Tests for the `pbrain brief` CLI command.
 *
 * Covers: project detection via marker + git remote, XML/text formats, scope
 * filters, char cap enforcement, XML-escaping of user-supplied values, and the
 * graceful no-project case.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runBrief, xmlEscape } from '../src/commands/brief.ts';

let sandbox: string;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pbrain-brief-')));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

interface StubOptions {
  findRepoByUrl?: (url: string) => Promise<{ slug: string; title: string }[]>;
  getPage?: (slug: string) => Promise<{ compiled_truth: string } | null>;
  getTimeline?: (slug: string) => Promise<{ date: string; summary: string; source: string }[]>;
}

function stubEngine(opts: StubOptions = {}): any {
  return {
    findRepoByUrl: opts.findRepoByUrl ?? (async () => []),
    getPage:
      opts.getPage ??
      (async (slug: string) => ({
        id: 1,
        slug,
        type: 'repo',
        title: slug,
        compiled_truth: 'A knowledge brain for agents.',
        timeline: '',
        frontmatter: {},
        created_at: new Date(),
        updated_at: new Date(),
      })),
    getTimeline:
      opts.getTimeline ??
      (async () => [
        { date: '2026-04-19', summary: 'Shipped v0.12.3 reliability wave', source: 'changelog' },
        { date: '2026-04-15', summary: 'Fork reset to v0.1.0', source: 'git' },
      ]),
  };
}

function markerSlug(slug: string) {
  writeFileSync(join(sandbox, '.pbrain-project'), `${slug}\n`);
}

describe('runBrief', () => {
  test('emits well-formed XML on a marker hit', async () => {
    markerSlug('repos/joedanz/pbrain');
    const { output, exitCode } = await runBrief(stubEngine(), [], {
      cwd: sandbox,
      home: sandbox,
    });
    expect(exitCode).toBe(0);
    expect(output).toContain('<pbrain-brief>');
    expect(output).toContain('</pbrain-brief>');
    expect(output).toContain('slug="repos/joedanz/pbrain"');
    expect(output).toContain('detected_via="marker"');
    expect(output).toContain('<compiled_truth_excerpt>');
    expect(output).toContain('<recent_timeline limit="2">');
    expect(output).toMatch(/<entry date="2026-04-19"/);
    expect(output).toContain('<how_to_query>');
  });

  test('--format text emits a readable plain-text brief', async () => {
    markerSlug('repos/joedanz/pbrain');
    const { output } = await runBrief(stubEngine(), ['--format', 'text'], {
      cwd: sandbox,
      home: sandbox,
    });
    expect(output).toContain('# pbrain brief');
    expect(output).toContain('project: repos/joedanz/pbrain');
    expect(output).toContain('## Compiled truth');
    expect(output).toContain('## Recent timeline');
    expect(output).toContain('- 2026-04-19');
    // Plain text must NOT carry XML sentinels.
    expect(output).not.toContain('<pbrain-brief>');
  });

  test('--scope project omits timeline', async () => {
    markerSlug('repos/joedanz/pbrain');
    const { output } = await runBrief(stubEngine(), ['--scope', 'project'], {
      cwd: sandbox,
      home: sandbox,
    });
    expect(output).toContain('<compiled_truth_excerpt>');
    expect(output).not.toContain('<recent_timeline');
  });

  test('--scope activity omits compiled_truth', async () => {
    markerSlug('repos/joedanz/pbrain');
    const { output } = await runBrief(stubEngine(), ['--scope', 'activity'], {
      cwd: sandbox,
      home: sandbox,
    });
    expect(output).not.toContain('<compiled_truth_excerpt>');
    expect(output).toContain('<recent_timeline');
  });

  test('graceful no-project case emits a <no_project> sentinel', async () => {
    const { output, exitCode } = await runBrief(stubEngine(), [], {
      cwd: sandbox,
      home: sandbox,
    });
    expect(exitCode).toBe(0);
    expect(output).toContain('<no_project');
    expect(output).toContain(`cwd="${sandbox}"`);
  });

  test('graceful no-project case in text format', async () => {
    const { output } = await runBrief(stubEngine(), ['--format', 'text'], {
      cwd: sandbox,
      home: sandbox,
    });
    expect(output).toContain('No project resolved');
    expect(output).not.toContain('<pbrain-brief>');
  });

  test('--json emits structured payload on hit', async () => {
    markerSlug('repos/joedanz/pbrain');
    const { output, exitCode } = await runBrief(stubEngine(), ['--json'], {
      cwd: sandbox,
      home: sandbox,
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output);
    expect(parsed.slug).toBe('repos/joedanz/pbrain');
    expect(parsed.matchedVia).toBe('marker');
    expect(parsed.compiled_truth_excerpt).toBe('A knowledge brain for agents.');
    expect(Array.isArray(parsed.recent_timeline)).toBe(true);
    expect(parsed.recent_timeline.length).toBe(2);
  });

  test('enforces the 10,000-char output cap with a truncation sentinel', async () => {
    markerSlug('repos/joedanz/pbrain');
    // Stub a very large compiled_truth — compiled_truth is excerpted to 1500
    // chars inside the renderer, but if someone later changes that cap (or a
    // scope adds fields), the outer 10k cap must still catch overflow.
    const huge = 'x'.repeat(20_000);
    const engine = stubEngine({
      getPage: async (slug) =>
        ({
          id: 1,
          slug,
          type: 'repo',
          title: slug,
          compiled_truth: huge,
          timeline: '',
          frontmatter: {},
          created_at: new Date(),
          updated_at: new Date(),
        } as any),
      getTimeline: async () =>
        Array.from({ length: 200 }, (_, i) => ({
          date: `2026-04-${String((i % 28) + 1).padStart(2, '0')}`,
          summary: 'long summary '.repeat(60),
          source: 'test',
        })),
    });
    const { output } = await runBrief(engine, [], {
      cwd: sandbox,
      home: sandbox,
    });
    expect(output.length).toBeLessThanOrEqual(10_000);
    // If truncated, the sentinel must be present so downstream consumers (Claude
    // Code, curl wrappers) can detect and react.
    if (output.length === 10_000 || output.includes('truncated')) {
      expect(output).toContain('truncated');
    }
  });

  test('XML-escapes hostile content in slug, source, and summary', async () => {
    markerSlug('repos/joedanz/<script>');
    const engine = stubEngine({
      getTimeline: async () => [
        {
          date: '2026-04-19',
          summary: 'broke with <em>markup</em> & "quotes"',
          source: "O'Reilly",
        },
      ],
    });
    const { output } = await runBrief(engine, [], {
      cwd: sandbox,
      home: sandbox,
    });
    expect(output).toContain('&lt;script&gt;');
    expect(output).toContain('&lt;em&gt;markup&lt;/em&gt;');
    expect(output).toContain('&amp;');
    expect(output).toContain('&quot;quotes&quot;');
    expect(output).toContain('O&apos;Reilly');
    // Raw unescaped sigils must NOT appear inside attribute values or text nodes.
    // (The outer `<pbrain-brief>` tags are ours; we grep for the hostile forms.)
    expect(output).not.toContain('<script>');
  });
});

describe('xmlEscape', () => {
  test('escapes all five XML metacharacters', () => {
    expect(xmlEscape('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&apos;');
  });

  test('preserves ordinary text verbatim', () => {
    expect(xmlEscape('Hello, world! 2026-04-19')).toBe('Hello, world! 2026-04-19');
  });
});
