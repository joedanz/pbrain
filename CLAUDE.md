# CLAUDE.md

PBrain is a personal knowledge brain and GStack mod for agent platforms. Pluggable
engines: PGLite (embedded Postgres via WASM, zero-config default) or Postgres + pgvector
+ hybrid search in a managed Supabase instance. `pbrain init` defaults to PGLite;
suggests Supabase for 1000+ files. GStack teaches agents how to code. PBrain teaches
agents everything else: brain ops, signal detection, content ingestion, enrichment,
cron scheduling, reports, identity, and access control.

## Architecture

Contract-first: `src/core/operations.ts` defines ~30 shared operations (adds `find_orphans` from the upstream v0.12.3 reliability wave). CLI and MCP
server are both generated from this single source. Engine factory (`src/core/engine-factory.ts`)
dynamically imports the configured engine (`'pglite'` or `'postgres'`). Skills are fat
markdown files (tool-agnostic, work with the CLI and MCP server contexts).

**Trust boundary:** `OperationContext.remote` distinguishes trusted local CLI callers
(`remote: false` set by `src/cli.ts`) from untrusted agent-facing callers
(`remote: true` set by `src/mcp/server.ts`). Security-sensitive operations like
`file_upload` tighten filesystem confinement when `remote=true` and default to
strict behavior when unset.

**Agent surface (v0.2):** `Operation.agentSurface` is `'always'` (default) or `'deferred'`.
Deferred ops emit `defer_loading: true` in the MCP `ListTools` response so Claude Code's
Tool Search gates their full schema until the agent searches by keyword or invokes them
by exact name. As of v0.2, 24 ops are always-visible and 8 are deferred
(`find_repo_by_url`, `get_health`, `get_versions`, `revert_version`, `sync_brain`,
`log_ingest`, `get_ingest_log`, `file_url`) — under the BFCL 30-tool cliff.

## Context Engineering Doctrine

PBrain's context engineering discipline is four evidence-backed principles. Every new
skill, feature, or MCP op is gated through them. Full reasoning and citations live in
`docs/ethos/CONTEXT_ENGINEERING.md`; this section is the shortform reference.

### Principles

1. **Minimalism beats completeness.** Smallest set of high-signal tokens. CLAUDE.md
   under 200 lines (Anthropic guideline). Skill file ≤ 500 lines. SessionStart hook
   `additionalContext` caps at 10,000 chars (Claude Code harness).
2. **Just-in-time beats pre-stuffing.** Brain pages are dereferenced on demand via MCP
   tools (`pbrain query`, `get_page`) — never auto-injected via RAG-style pre-stuffing.
3. **Sub-agent quarantine beats inline accumulation.** Brain-heavy exploration runs in
   subagents (their context is already isolated by default). Use `isolation: worktree`
   for filesystem isolation.
4. **Structured resets beat compaction.** For long sessions, prefer explicit handoff
   (stash state, fresh session) over passive `/compact`.

### Anti-patterns (explicit prohibitions)

- **Auto-generating CLAUDE.md / AGENTS.md with project briefings.** AGENTbench Feb 2026:
  LLM-generated files are net-negative except when they replace existing docs. PBrain
  only writes a ≤ 10-line `## pbrain` pointer stanza (via `project-onboard`).
- **Dumping search results into the system prompt.** Always expose brain pages via
  tools the agent pulls on demand.
- **Auto-pushing session context via hooks.** `pbrain brief` is a CLI command; wiring
  it to SessionStart is a user opt-in, never a default. Auto-push is the same
  category as the AGENTbench anti-pattern.
- **Adding MCP tools without retiring others.** BFCL: 30-tool cliff for frontier
  models. Every addition must retire equal-or-more (or defer via `agentSurface`).
- **"Always read X before Y" meta-rules.** Practitioner-reported failure: agents claim
  compliance but don't read. Use `.claude/rules/*.md` with `paths:` frontmatter
  (Claude Code's officially-sanctioned path-scoped auto-load).
- **Monotonic CLAUDE.md growth.** Any PR growing `skills/**/SKILL.md` or `CLAUDE.md`
  without removing equivalent content fails review.
- **Edge-case enumeration.** 3-5 canonical examples beat 30 rules (Liu 2023 + Anthropic).
- **Context-engineering changes that can't be measured.** If we can't say "N fewer
  turns" or "P@5 improved X%," we don't ship. Until a coding-task eval harness exists,
  gate on explicit manual A/B.

## Key files

- `src/core/operations.ts` — Contract-first operation definitions (the foundation). Also exports upload validators: `validateUploadPath`, `validatePageSlug`, `validateFilename`. `OperationContext.remote` flags untrusted callers.
- `src/core/engine.ts` — Pluggable engine interface (BrainEngine). `clampSearchLimit(limit, default, cap)` takes an explicit cap so per-operation caps can be tighter than `MAX_SEARCH_LIMIT`. Exports `LinkBatchInput` / `TimelineBatchInput` for the v0.12.1 bulk-insert API (`addLinksBatch` / `addTimelineEntriesBatch`).
- `src/core/engine-factory.ts` — Engine factory with dynamic imports (`'pglite'` | `'postgres'`)
- `src/core/pglite-engine.ts` — PGLite (embedded Postgres 17.5 via WASM) implementation. `addLinksBatch` / `addTimelineEntriesBatch` use multi-row `unnest()` with manual `$N` placeholders.
- `src/core/pglite-schema.ts` — PGLite-specific DDL (pgvector, pg_trgm, triggers)
- `src/core/postgres-engine.ts` — Postgres + pgvector implementation (Supabase / self-hosted). `addLinksBatch` / `addTimelineEntriesBatch` use `INSERT ... SELECT FROM unnest($1::text[], ...) JOIN pages ON CONFLICT DO NOTHING RETURNING 1` — 4-5 array params regardless of batch size, sidesteps the 65535-parameter cap. As of v0.12.3, `searchKeyword` / `searchVector` scope `statement_timeout` via `sql.begin` + `SET LOCAL` so the GUC dies with the transaction instead of leaking across the pooled postgres.js connection (contributed by @garagon). `getEmbeddingsByChunkIds` uses `tryParseEmbedding` so one corrupt row skips+warns instead of killing the query.
- `src/core/utils.ts` — Shared SQL utilities extracted from postgres-engine.ts. Exports `parseEmbedding(value)` (throws on unknown input, used by migration + ingest paths where data integrity matters) and as of v0.12.3 `tryParseEmbedding(value)` (returns `null` + warns once per process, used by search/rescore paths where availability matters more than strictness).
- `src/core/db.ts` — Connection management, schema initialization
- `src/commands/migrate-engine.ts` — Bidirectional engine migration (`pbrain migrate --to supabase/pglite`)
- `src/core/import-file.ts` — importFromFile + importFromContent (chunk + embed + tags)
- `src/core/sync.ts` — Pure sync functions (manifest parsing, filtering, slug conversion)
- `src/core/storage.ts` — Pluggable storage interface (S3, Supabase Storage, local)
- `src/core/supabase-admin.ts` — Supabase admin API (project discovery, pgvector check)
- `src/core/file-resolver.ts` — File resolution with fallback chain (local -> .redirect.yaml -> .redirect -> .supabase)
- `src/core/chunkers/` — 3-tier chunking (recursive, semantic, LLM-guided)
- `src/core/search/` — Hybrid search: vector + keyword + RRF + multi-query expansion + dedup
- `src/core/search/intent.ts` — Query intent classifier (entity/temporal/event/general → auto-selects detail level)
- `src/core/search/eval.ts` — Retrieval eval harness: P@k, R@k, MRR, nDCG@k metrics + runEval() orchestrator
- `src/commands/eval.ts` — `pbrain eval` command: single-run table + A/B config comparison
- `src/core/embedding.ts` — OpenAI text-embedding-3-large, batch, retry, backoff
- `src/core/check-resolvable.ts` — Resolver validation: reachability, MECE overlap, DRY checks, structured fix objects
- `src/core/backoff.ts` — Adaptive load-aware throttling: CPU/memory checks, exponential backoff, active hours multiplier
- `src/core/fail-improve.ts` — Deterministic-first, LLM-fallback loop with JSONL failure logging and auto-test generation
- `src/core/transcription.ts` — Audio transcription: Groq Whisper (default), OpenAI fallback, ffmpeg segmentation for >25MB
- `src/core/enrichment-service.ts` — Global enrichment service: entity slug generation, tier auto-escalation, batch throttling
- `src/core/data-research.ts` — Recipe validation, field extraction (MRR/ARR regex), dedup, tracker parsing, HTML stripping
- `src/commands/extract.ts` — `pbrain extract links|timeline|all`: batch link/timeline extraction from markdown files. As of the v0.12.1 N+1 fix, candidates are buffered 100 at a time and flushed via `addLinksBatch` / `addTimelineEntriesBatch`; `ON CONFLICT DO NOTHING` enforces uniqueness at the DB layer, and the `created` counter returns real rows inserted (truthful on re-runs). The DB-source extractor (`--source db`) remains deferred with the knowledge-graph layer.
- `src/commands/features.ts` — `pbrain features --json --auto-fix`: usage scan + feature adoption salesman
- `src/commands/autopilot.ts` — `pbrain autopilot --install`: self-maintaining brain daemon (sync+extract+embed)
- `src/mcp/server.ts` — MCP stdio server (generated from operations)
- `src/commands/auth.ts` — Standalone token management (create/list/revoke/test)
- `src/commands/upgrade.ts` — Self-update CLI with post-upgrade feature discovery + features hook
- `src/commands/apply-migrations.ts` — `pbrain apply-migrations [--list] [--dry-run] [--migration vX.Y.Z]`: runs pending migration orchestrators from the TS registry.
- `src/commands/migrations/` — TS migration registry (compiled into the binary; no filesystem walk of `skills/migrations/*.md` needed at runtime). `index.ts` lists migrations in semver order. `v0_12_2.ts` = JSONB double-encode repair orchestrator (4 phases: schema → repair-jsonb → verify → record). All orchestrators are idempotent and resumable from `partial` status. Upstream's v0.11.0 (Minions) and v0.12.0 (knowledge-graph) orchestrators are intentionally NOT registered in this fork.
- `src/commands/repair-jsonb.ts` — `pbrain repair-jsonb [--dry-run] [--json]`: rewrites `jsonb_typeof='string'` rows in place across 5 affected columns (pages.frontmatter, raw_data.data, ingest_log.pages_updated, files.metadata, page_versions.frontmatter). Fixes v0.12.0 double-encode bug on Postgres; PGLite no-ops. Idempotent.
- `src/commands/orphans.ts` — `pbrain orphans [--json] [--count] [--include-pseudo]`: surfaces pages with zero inbound wikilinks, grouped by domain. Auto-generated/raw/pseudo pages filtered by default. Also exposed as `find_orphans` MCP operation. Integrated from upstream's v0.12.3 reliability wave (contributed by @knee5).
- `src/commands/doctor.ts` — `pbrain doctor [--json] [--fast] [--fix]`: health checks. v0.12.3 adds two reliability detection checks: `jsonb_integrity` (scans pages.frontmatter, raw_data.data, ingest_log.pages_updated, files.metadata for `jsonb_typeof='string'` rows left over from v0.12.0) and `markdown_body_completeness` (flags pages whose compiled_truth is <30% of raw source when raw has multiple H2/H3 boundaries). Fix hints point at `pbrain repair-jsonb` and `pbrain sync --force`.
- `src/core/markdown.ts` — Frontmatter parsing + body splitter. `splitBody` requires an explicit timeline sentinel (`<!-- timeline -->`, `--- timeline ---`, or `---` immediately before `## Timeline`/`## History`). Plain `---` in body text is a markdown horizontal rule, not a separator. `inferType` auto-types `/wiki/analysis/` → analysis, `/wiki/guides/` → guide, `/wiki/hardware/` → hardware, `/wiki/architecture/` → architecture, `/writing/` → writing (plus the existing people/companies/deals/etc heuristics).
- `scripts/check-jsonb-pattern.sh` — CI grep guard. Fails the build if anyone reintroduces the `${JSON.stringify(x)}::jsonb` interpolation pattern (which postgres.js v3 double-encodes). Wired into `bun test`.
- `src/core/schema-embedded.ts` — AUTO-GENERATED from schema.sql (run `bun run build:schema`)
- `src/schema.sql` — Full Postgres + pgvector DDL (source of truth, generates schema-embedded.ts)
- `src/commands/integrations.ts` — Standalone integration recipe management (no DB needed). Exports `getRecipeDirs()` (trust-tagged recipe sources), SSRF helpers (`isInternalUrl`, `parseOctet`, `hostnameToOctets`, `isPrivateIpv4`). Only package-bundled recipes are `embedded=true`; `$PBRAIN_RECIPES_DIR` and cwd `./recipes/` are untrusted and cannot run `command`/`http`/string health checks.
- `src/core/search/expansion.ts` — Multi-query expansion via Haiku. Exports `sanitizeQueryForPrompt` + `sanitizeExpansionOutput` (prompt-injection defense-in-depth). Sanitized query is only used for the LLM channel; original query still drives search.
- `src/core/similar-slugs.ts` — Duplicate-page prevention hint. `findSimilarEntitySlugs(engine, slug, limit)` scans `people/`/`companies/` for slugs with close token overlap (identical, dash-stripped equal, substring, or initial-expansion match on `-`-split tokens). Pure function, no embeddings, no LLM. `put_page` wires this into the response as `similar: [...]` on fresh creates so agents can merge into the canonical page instead of accumulating variants.
- `recipes/` — Integration recipe files (YAML frontmatter + markdown setup instructions)
- `docs/guides/` — Individual SKILLPACK guides (broken out from monolith)
- `docs/integrations/` — "Getting Data In" guides and integration docs
- `docs/architecture/infra-layer.md` — Shared infrastructure documentation
- `docs/ethos/THIN_HARNESS_FAT_SKILLS.md` — Architecture philosophy essay
- `docs/ethos/MARKDOWN_SKILLS_AS_RECIPES.md` — "Homebrew for Personal AI" essay
- `docs/guides/repo-architecture.md` — Two-repo pattern (agent vs brain)
- `docs/guides/sub-agent-routing.md` — Model routing table for sub-agents
- `docs/guides/skill-development.md` — 5-step skill development cycle + MECE
- `docs/guides/idea-capture.md` — Originality distribution, depth test, cross-linking
- `docs/guides/quiet-hours.md` — Notification hold + timezone-aware delivery
- `docs/guides/diligence-ingestion.md` — Data room to brain pages pipeline
- `docs/designs/HOMEBREW_FOR_PERSONAL_AI.md` — 10-star vision for integration system
- `docs/mcp/` — Per-client setup guides (Claude Desktop, Code, Cowork, Perplexity)
- `docs/benchmarks/` — Search quality benchmark results (reproducible, fictional data)
- `skills/_brain-filing-rules.md` — Cross-cutting brain filing rules (referenced by all brain-writing skills)
- `skills/RESOLVER.md` — Skill routing table (modeled on Wintermute's AGENTS.md)
- `skills/conventions/` — Cross-cutting rules (quality, brain-first, model-routing, test-before-bulk, cross-modal)
- `skills/_output-rules.md` — Output quality standards (deterministic links, no slop, exact phrasing)
- `skills/signal-detector/SKILL.md` — Always-on idea+entity capture on every message
- `skills/brain-ops/SKILL.md` — Brain-first lookup, read-enrich-write loop, source attribution
- `skills/idea-ingest/SKILL.md` — Links/articles/tweets with author people page mandatory
- `skills/media-ingest/SKILL.md` — Video/audio/PDF/book with entity extraction
- `skills/meeting-ingestion/SKILL.md` — Transcripts with attendee enrichment chaining
- `skills/citation-fixer/SKILL.md` — Citation format auditing and fixing
- `skills/repo-architecture/SKILL.md` — Filing rules by primary subject
- `skills/skill-creator/SKILL.md` — Create conforming skills with MECE check
- `skills/daily-task-manager/SKILL.md` — Task lifecycle with priority levels
- `skills/daily-task-prep/SKILL.md` — Morning prep with calendar context
- `skills/cross-modal-review/SKILL.md` — Quality gate via second model
- `skills/cron-scheduler/SKILL.md` — Schedule staggering, quiet hours, idempotency
- `skills/reports/SKILL.md` — Timestamped reports with keyword routing
- `skills/testing/SKILL.md` — Skill validation framework
- `skills/soul-audit/SKILL.md` — 6-phase interview for SOUL.md, USER.md, ACCESS_POLICY.md, HEARTBEAT.md
- `skills/webhook-transforms/SKILL.md` — External events to brain signals
- `skills/data-research/SKILL.md` — Structured data research: email-to-tracker pipeline with parameterized YAML recipes
- `templates/` — SOUL.md, USER.md, ACCESS_POLICY.md, HEARTBEAT.md templates
- `skills/migrations/` — Version migration files with feature_pitch YAML frontmatter
- `src/commands/publish.ts` — Deterministic brain page publisher (code+skill pair, zero LLM calls)
- `src/commands/backlinks.ts` — Back-link checker and fixer (enforces Iron Law)
- `src/commands/lint.ts` — Page quality linter (catches LLM artifacts, placeholder dates)
- `src/commands/report.ts` — Structured report saver (audit trail for maintenance/enrichment)
- `scripts/install.sh` — One-line bootstrap installer (Bun detect/install, clone, `bun link`, brain-path prompt, optional install-skills). Idempotent; re-run to upgrade. See `docs/install.md`.

## Commands

Run `pbrain --help` or `pbrain --tools-json` for full command reference.

Key commands added in v0.7:
- `pbrain init` — defaults to PGLite (no Supabase needed), scans repo size, suggests Supabase for 1000+ files
- `pbrain migrate --to supabase` / `pbrain migrate --to pglite` — bidirectional engine migration

Key commands added in v0.12.2:
- `gbrain repair-jsonb [--dry-run] [--json]` — repair double-encoded JSONB rows left over from v0.12.0-and-earlier Postgres writes. Idempotent; PGLite no-ops. The `v0_12_2` migration runs this automatically on `gbrain upgrade`.

Key commands added in v0.12.3:
- `gbrain orphans [--json] [--count] [--include-pseudo]` — surface pages with zero inbound wikilinks, grouped by domain. Auto-generated/raw/pseudo pages filtered by default. Also exposed as `find_orphans` MCP operation. The natural consumer of the v0.12.0 knowledge graph layer: once edges are captured, find the gaps.
- `gbrain doctor` gains two new reliability detection checks: `jsonb_integrity` (v0.12.0 Postgres double-encode damage) and `markdown_body_completeness` (pages truncated by the old splitBody bug). Detection only; fix hints point at `gbrain repair-jsonb` and `gbrain sync --force`.

## Testing

`bun test` runs all tests. Unit tests run
without a database. E2E tests skip gracefully when `DATABASE_URL` is not set.

Unit tests: `test/markdown.test.ts` (frontmatter parsing), `test/chunkers/recursive.test.ts`
(chunking), `test/parity.test.ts` (operations contract
parity), `test/cli.test.ts` (CLI structure), `test/config.test.ts` (config redaction),
`test/files.test.ts` (MIME/hash), `test/import-file.test.ts` (import pipeline),
`test/upgrade.test.ts` (schema migrations),
`test/file-migration.test.ts` (file migration), `test/file-resolver.test.ts` (file resolution),
`test/import-resume.test.ts` (import checkpoints), `test/migrate.test.ts` (migration; v8/v9 helper-btree-index SQL structural assertions + 1000-row wall-clock fixtures that guard the O(n²)→O(n log n) fix),
`test/setup-branching.test.ts` (setup flow), `test/slug-validation.test.ts` (slug validation),
`test/storage.test.ts` (storage backends), `test/supabase-admin.test.ts` (Supabase admin),
`test/yaml-lite.test.ts` (YAML parsing), `test/check-update.test.ts` (version check + update CLI),
`test/pglite-engine.test.ts` (PGLite engine, all 40 BrainEngine methods including 11 cases for `addLinksBatch` / `addTimelineEntriesBatch`: empty batch, missing optionals, within-batch dedup via ON CONFLICT, missing-slug rows dropped by JOIN, half-existing batch, batch of 100),
`test/engine-factory.test.ts` (engine factory + dynamic imports),
`test/integrations.test.ts` (recipe parsing, CLI routing, recipe validation),
`test/publish.test.ts` (content stripping, encryption, password generation, HTML output),
`test/backlinks.test.ts` (entity extraction, back-link detection, timeline entry generation),
`test/lint.test.ts` (LLM artifact detection, code fence stripping, frontmatter validation),
`test/report.test.ts` (report format, directory structure),
`test/skills-conformance.test.ts` (skill frontmatter + required sections validation),
`test/resolver.test.ts` (RESOLVER.md coverage, routing validation),
`test/search.test.ts` (RRF normalization, compiled truth boost, cosine similarity, dedup key),
`test/dedup.test.ts` (source-aware dedup, compiled truth guarantee, layer interactions),
`test/intent.test.ts` (query intent classification: entity/temporal/event/general),
`test/eval.test.ts` (retrieval metrics: precisionAtK, recallAtK, mrr, ndcgAtK, parseQrels),
`test/check-resolvable.test.ts` (resolver reachability, MECE overlap, gap detection, DRY checks),
`test/backoff.test.ts` (load-aware throttling, concurrency limits, active hours),
`test/fail-improve.test.ts` (deterministic/LLM cascade, JSONL logging, test generation, rotation),
`test/transcription.test.ts` (provider detection, format validation, API key errors),
`test/enrichment-service.test.ts` (entity slugification, extraction, tier escalation),
`test/data-research.test.ts` (recipe validation, MRR/ARR extraction, dedup, tracker parsing, HTML stripping),
`test/extract.test.ts` (link extraction, timeline extraction, frontmatter parsing, directory type inference),
`test/extract-fs.test.ts` (pbrain extract: first-run inserts + second-run reports zero, dry-run dedups candidates across files, second-run perf regression guard — the v0.12.1 N+1 dedup bug),
`test/features.test.ts` (feature scanning, brain_score calculation, CLI routing, persistence),
`test/file-upload-security.test.ts` (symlink traversal, cwd confinement, slug + filename allowlists, remote vs local trust),
`test/query-sanitization.test.ts` (prompt-injection stripping, output sanitization, structural boundary),
`test/search-limit.test.ts` (clampSearchLimit default/cap behavior across list_pages and get_ingest_log),
`test/repair-jsonb.test.ts` (v0.12.2 JSONB repair: TARGETS list, idempotency, engine-awareness),
`test/migrations-v0_12_2.test.ts` (v0.12.2 orchestrator phases: schema → repair → verify → record),
`test/markdown.test.ts` (splitBody sentinel precedence, horizontal-rule preservation, inferType wiki subtypes),
`test/orphans.test.ts` (v0.12.3 orphans command: detection, pseudo filtering, text/json/count outputs, MCP op),
`test/postgres-engine.test.ts` (v0.12.3 statement_timeout scoping: `sql.begin` + `SET LOCAL` shape, source-level grep guardrail against reintroduced bare `SET statement_timeout`),
`test/sync.test.ts` (sync logic + v0.12.3 regression guard asserting top-level `engine.transaction` is not called),
`test/doctor.test.ts` (doctor command + v0.12.3 assertions that `jsonb_integrity` scans the four v0.12.0 write sites and `markdown_body_completeness` is present),
`test/utils.test.ts` (shared SQL utilities + `tryParseEmbedding` null-return and single-warn semantics).

E2E tests (`test/e2e/`): Run against real Postgres+pgvector. Require `DATABASE_URL`.
- `bun run test:e2e` runs Tier 1 (mechanical, all operations, no API keys). Includes 9 dedicated cases for the postgres-engine `addLinksBatch` / `addTimelineEntriesBatch` bind path — postgres-js's `unnest()` binding is structurally different from PGLite's and gets its own coverage.
- `test/e2e/search-quality.test.ts` runs search quality E2E against PGLite (no API keys, in-memory)
- `test/e2e/postgres-jsonb.test.ts` — v0.12.2 regression test. Round-trips all 5 JSONB write sites (pages.frontmatter, raw_data.data, ingest_log.pages_updated, files.metadata, page_versions.frontmatter) against real Postgres and asserts `jsonb_typeof='object'` plus `->>'key'` returns the expected scalar. The test that should have caught the original double-encode bug.
- `test/e2e/jsonb-roundtrip.test.ts` — v0.12.3 companion regression against the 4 doctor-scanned JSONB sites. Assertion-level overlap with `postgres-jsonb.test.ts` is intentional defense-in-depth: if doctor's scan surface ever drifts from the actual write surface, one of these tests catches it.
- `test/e2e/upgrade.test.ts` runs check-update E2E against real GitHub API (network required)
- Tier 2 (`skills.test.ts`) requires OpenClaw + API keys, runs nightly in CI
- If `.env.testing` doesn't exist in this directory, check sibling worktrees for one:
  `find ../  -maxdepth 2 -name .env.testing -print -quit` and copy it here if found.
- Always run E2E tests when they exist. Do not skip them just because DATABASE_URL
  is not set. Start the test DB, run the tests, then tear it down.

### API keys and running ALL tests

ALWAYS source the user's shell profile before running tests:

```bash
source ~/.zshrc 2>/dev/null || true
```

This loads `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. Without these, Tier 2 tests
skip silently. Do NOT skip Tier 2 tests just because they require API keys — load
the keys and run them.

When asked to "run all E2E tests" or "run tests", that means ALL tiers:
- Tier 1: `bun run test:e2e` (mechanical, sync, upgrade — no API keys needed)
- Tier 2: `test/e2e/skills.test.ts` (requires OpenAI + Anthropic + openclaw CLI)
- Always spin up the test DB, source zshrc, run everything, tear down.

### E2E test DB lifecycle (ALWAYS follow this)

You are responsible for spinning up and tearing down the test Postgres container.
Do not leave containers running after tests. Do not skip E2E tests.

1. **Check for `.env.testing`** — if missing, copy from sibling worktree.
   Read it to get the DATABASE_URL (it has the port number).
2. **Check if the port is free:**
   `docker ps --filter "publish=PORT"` — if another container is on that port,
   pick a different port (try 5435, 5436, 5437) and start on that one instead.
3. **Start the test DB:**
   ```bash
   docker run -d --name pbrain-test-pg \
     -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
     -e POSTGRES_DB=pbrain_test \
     -p PORT:5432 pgvector/pgvector:pg16
   ```
   Wait for ready: `docker exec pbrain-test-pg pg_isready -U postgres`
4. **Run E2E tests:**
   `DATABASE_URL=postgresql://postgres:postgres@localhost:PORT/pbrain_test bun run test:e2e`
5. **Tear down immediately after tests finish (pass or fail):**
   `docker stop pbrain-test-pg && docker rm pbrain-test-pg`

Never leave `pbrain-test-pg` running. If you find a stale one from a previous run,
stop and remove it before starting a new one.

## Skills

Read the skill files in `skills/` before doing brain operations. PBrain ships 25 skills
organized by `skills/RESOLVER.md`:

**Original 8 (conformance-migrated):** ingest (thin router), query, maintain, enrich,
briefing, migrate, setup, publish.

**Brain skills (from Wintermute):** signal-detector, brain-ops, idea-ingest, media-ingest,
meeting-ingestion, citation-fixer, repo-architecture, skill-creator, daily-task-manager.

**Operational + identity:** daily-task-prep, cross-modal-review, cron-scheduler, reports,
testing, soul-audit, webhook-transforms.

**Conventions:** `skills/conventions/` has cross-cutting rules (quality, brain-first,
model-routing, test-before-bulk, cross-modal). `skills/_brain-filing-rules.md` and
`skills/_output-rules.md` are shared references.

## Build

`bun build --compile --outfile bin/pbrain src/cli.ts`

## Pre-ship requirements

Before shipping (/ship) or reviewing (/review), always run the full test suite:
- `bun test` — unit tests (no database required)
- Follow the "E2E test DB lifecycle" steps above to spin up the test DB,
  run `bun run test:e2e`, then tear it down.

Both must pass. Do not ship with failing E2E tests. Do not skip E2E tests.

## Post-ship requirements (MANDATORY)

After EVERY /ship, you MUST run /document-release. This is NOT optional. Do NOT
skip it. Do NOT say "docs look fine" without running it. The skill reads every .md
file in the project, cross-references the diff, and updates anything that drifted.

If /ship's Step 8.5 triggers document-release automatically, that counts. But if
it gets skipped for ANY reason (timeout, error, oversight), you MUST run it manually
before considering the ship complete.

Files that MUST be checked on every ship:
- README.md — does it reflect new features, commands, or setup steps?
- CLAUDE.md — does it reflect new files, test files, or architecture changes?
- CHANGELOG.md — does it cover every commit?
- TODOS.md — are completed items marked done?
- docs/ — do any guides need updating?

A ship without updated docs is an incomplete ship. Period.

## CHANGELOG voice

CHANGELOG.md is read by agents during auto-update (Section 17). The agent summarizes
the changelog to convince the user to upgrade. Write changelog entries that sell the
upgrade, not document the implementation.

- Lead with what the user can now DO that they couldn't before
- Frame as benefits and capabilities, not files changed or code written
- Make the user think "hell yeah, I want that"
- Bad: "Added PBRAIN_VERIFY.md installation verification runbook"
- Good: "Your agent now verifies the entire PBrain installation end-to-end, catching
  silent sync failures and stale embeddings before they bite you"
- Bad: "Setup skill Phase H and Phase I added"
- Good: "New installs automatically set up live sync so your brain never falls behind"
- **Always credit community contributions.** When a CHANGELOG entry includes work from
  a community PR, name the contributor with `Contributed by @username`. Contributors
  did real work. Thank them publicly every time, no exceptions.

## Version migrations

Create a migration file at `skills/migrations/v[version].md` when a release
includes changes that existing users need to act on. The auto-update agent
reads these files post-upgrade (Section 17, Step 4) and executes them.

**You need a migration file when:**
- New setup step that existing installs don't have (e.g., v0.5.0 added live sync,
  existing users need to set it up, not just new installs)
- New SKILLPACK section with a MUST ADD setup requirement
- Schema changes that require `pbrain init` or manual SQL
- Changed defaults that affect existing behavior
- Deprecated commands or flags that need replacement
- New verification steps that should run on existing installs
- New cron jobs or background processes that should be registered

**You do NOT need a migration file when:**
- Bug fixes with no behavior changes
- Documentation-only improvements (the agent re-reads docs automatically)
- New optional features that don't affect existing setups
- Performance improvements that are transparent

**The key test:** if an existing user upgrades and does nothing else, will their
brain work worse than before? If yes, migration file. If no, skip it.

Write migration files as agent instructions, not technical notes. Tell the agent
what to do, step by step, with exact commands. See `skills/migrations/v0.5.0.md`
for the pattern.

## Schema state tracking

`~/.pbrain/update-state.json` tracks which recommended schema directories the user
adopted, declined, or added custom. The auto-update agent (SKILLPACK Section 17)
reads this during upgrades to suggest new schema additions without re-suggesting
things the user already declined. The setup skill writes the initial state during
Phase C/E. Never modify a user's custom directories or re-suggest declined ones.

## GitHub Actions SHA maintenance

All GitHub Actions in `.github/workflows/` are pinned to commit SHAs. Before shipping
(`/ship`) or reviewing (`/review`), check for stale pins and update them:

```bash
for action in actions/checkout oven-sh/setup-bun actions/upload-artifact actions/download-artifact softprops/action-gh-release gitleaks/gitleaks-action; do
  tag=$(grep -r "$action@" .github/workflows/ | head -1 | grep -o '#.*' | tr -d '# ')
  [ -n "$tag" ] && echo "$action@$tag: $(gh api repos/$action/git/ref/tags/$tag --jq .object.sha 2>/dev/null)"
done
```

If any SHA differs from what's in the workflow files, update the pin and version comment.

## Community PR wave process

Never merge external PRs directly into master. Instead, use the "fix wave" workflow:

1. **Categorize** — group PRs by theme (bug fixes, features, infra, docs)
2. **Deduplicate** — if two PRs fix the same thing, pick the one that changes fewer
   lines. Close the other with a note pointing to the winner.
3. **Collector branch** — create a feature branch (e.g. `garrytan/fix-wave-N`), cherry-pick
   or manually re-implement the best fixes from each PR. Do NOT merge PR branches directly —
   read the diff, understand the fix, and write it yourself if needed.
4. **Test the wave** — verify with `bun test && bun run test:e2e` (full E2E lifecycle).
   Every fix in the wave must have test coverage.
5. **Close with context** — every closed PR gets a comment explaining why and what (if
   anything) supersedes it. Contributors did real work; respect that with clear communication
   and thank them.
6. **Ship as one PR** — single PR to master with all attributions preserved via
   `Co-Authored-By:` trailers. Include a summary of what merged and what closed.

**Community PR guardrails:**
- Always AskUserQuestion before accepting commits that touch voice, tone, or
  promotional material (README intro, CHANGELOG voice, skill templates).
- Never auto-merge PRs that remove YC references or "neutralize" the founder perspective.
- Preserve contributor attribution in commit messages.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

**NEVER hand-roll ship operations.** Do not manually run git commit + push + gh pr
create when /ship is available. /ship handles VERSION bump, CHANGELOG, document-release,
pre-landing review, test coverage audit, and adversarial review. Manually creating a PR
skips all of these. If the user says "commit and ship", "push and ship", "bisect and
ship", or any combination that ends with shipping — invoke /ship and let it handle
everything including the commits. If the branch name contains a version (e.g.
`v0.5-live-sync`), /ship should use that version for the bump.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR, "commit and ship", "push and ship" → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health

## pbrain

This project is tracked in pbrain as `repos/joedanz/pbrain`.

- Before answering questions about architecture, dependencies, stack
  history, or past decisions, query the brain: `pbrain query "<question>"`.
- When a significant decision is made, record it with
  `pbrain remember "<summary>"` — the command auto-detects the current
  project and appends a timeline entry to `repos/joedanz/pbrain`.
- To re-onboard (e.g. after a brain wipe), run the `project-onboard` skill.
