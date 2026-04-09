# CLAUDE.md

GBrain is a personal knowledge brain. Postgres + pgvector + hybrid search in a managed Supabase instance.

## Architecture

Contract-first: `src/core/operations.ts` defines ~30 shared operations. CLI and MCP
server are both generated from this single source. Skills are fat markdown files
(tool-agnostic, work with both CLI and plugin contexts).

## Key files

- `src/core/operations.ts` — Contract-first operation definitions (the foundation)
- `src/core/engine.ts` — Pluggable engine interface (BrainEngine)
- `src/core/postgres-engine.ts` — Postgres + pgvector implementation
- `src/core/db.ts` — Connection management, schema initialization
- `src/core/import-file.ts` — importFromFile + importFromContent (chunk + embed + tags)
- `src/core/sync.ts` — Pure sync functions (manifest parsing, filtering, slug conversion)
- `src/core/storage.ts` — Pluggable storage interface (S3, Supabase Storage, local)
- `src/core/supabase-admin.ts` — Supabase admin API (project discovery, pgvector check)
- `src/core/file-resolver.ts` — MIME detection, content hashing for file uploads
- `src/core/chunkers/` — 3-tier chunking (recursive, semantic, LLM-guided)
- `src/core/search/` — Hybrid search: vector + keyword + RRF + multi-query expansion + dedup
- `src/core/embedding.ts` — OpenAI text-embedding-3-large, batch, retry, backoff
- `src/mcp/server.ts` — MCP stdio server (generated from operations)
- `src/schema.sql` — Full Postgres + pgvector DDL (includes files table)
- `openclaw.plugin.json` — ClawHub bundle plugin manifest

## Commands

Run `gbrain --help` or `gbrain --tools-json` for full command reference.

## Testing

`bun test` runs all tests (19 unit test files + 3 E2E test files). Unit tests run
without a database. E2E tests skip gracefully when `DATABASE_URL` is not set.

Unit tests: `test/markdown.test.ts` (frontmatter parsing), `test/chunkers/recursive.test.ts`
(chunking), `test/sync.test.ts` (sync logic), `test/parity.test.ts` (operations contract
parity), `test/cli.test.ts` (CLI structure), `test/config.test.ts` (config redaction),
`test/files.test.ts` (MIME/hash), `test/import-file.test.ts` (import pipeline),
`test/upgrade.test.ts` (schema migrations), `test/doctor.test.ts` (doctor command),
`test/file-migration.test.ts` (file migration), `test/file-resolver.test.ts` (file resolution),
`test/import-resume.test.ts` (import checkpoints), `test/migrate.test.ts` (migration),
`test/setup-branching.test.ts` (setup flow), `test/slug-validation.test.ts` (slug validation),
`test/storage.test.ts` (storage backends), `test/supabase-admin.test.ts` (Supabase admin),
`test/yaml-lite.test.ts` (YAML parsing).

E2E tests (`test/e2e/`): Run against real Postgres+pgvector. Require `DATABASE_URL`.
- `bun run test:e2e` runs Tier 1 (mechanical, all operations, no API keys)
- Tier 2 (`skills.test.ts`) requires OpenClaw + API keys, runs nightly in CI
- Local setup: `docker compose -f docker-compose.test.yml up -d` then
  `DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test bun run test:e2e`

## Skills

Read the skill files in `skills/` before doing brain operations. They contain the
workflows, heuristics, and quality rules for ingestion, querying, maintenance,
enrichment, and setup. 7 skills: ingest, query, maintain, enrich, briefing,
migrate, setup.

## Build

`bun build --compile --outfile bin/gbrain src/cli.ts`

## Pre-ship requirements

Before shipping (/ship) or reviewing (/review), always run the full test suite:
- `bun test` — unit tests (no database required)
- `docker compose -f docker-compose.test.yml up -d` then
  `DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test bun run test:e2e`
  — E2E tests against real Postgres+pgvector

Both must pass. Do not ship with failing E2E tests.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
