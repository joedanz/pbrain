# Changelog

All notable changes to PBrain will be documented in this file.

> **Fork notice.** PBrain is a fork of [GBrain](https://github.com/garrytan/gbrain) by [Garry Tan](https://github.com/garrytan). All entries below `[0.1.0]` describe work done on the GBrain project under its original name and are preserved for historical context. See [NOTICE](NOTICE) and [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md) for attribution.

<!-- GBRAIN_HISTORICAL_v0.12.1 -->
## [0.12.1] - 2026-04-19

## **Extract no longer hangs on large brains.**
## **v0.12.0 upgrade no longer times out on duplicates.**

Two production-blocking bugs Garry hit on his 47K-page brain on April 18. `gbrain extract` was effectively unusable on any brain with 20K+ existing links or timeline entries — it pre-loaded the entire dedup set with one `getLinks()` call per page over the Supabase pooler, hanging for 10+ minutes producing zero output before any work started. The v0.12.0 schema migration that creates `idx_timeline_dedup` was failing on brains with pre-existing duplicate timeline rows because the `DELETE ... USING` self-join was O(n²) without an index, hitting Supabase Management API's 60-second ceiling on 80K+ duplicates. Both bugs end here.

### The numbers that matter

Measured on the new `test/extract-fs.test.ts` and `test/migrate.test.ts` regression suites, plus 73 E2E tests against real Postgres+pgvector. Reproducible: `bun test` + `bun run test:e2e`.

| Metric                                  | BEFORE v0.12.1     | AFTER v0.12.1     | Δ                  |
|-----------------------------------------|--------------------|--------------------|--------------------|
| extract hang on 47K-page brain          | 10+ min, zero output | immediate work, ~30-60s wall clock | usable            |
| DB round-trips per re-extract           | 47K reads + 235K writes | 0 reads + ~2.4K writes | **~99% fewer** |
| v0.12.0 migration on 80K duplicate rows | timed out at 60s    | completes <1s     | **~60x+ faster**   |
| Re-run on already-extracted brain       | 235K row-writes     | 0 row-writes      | true no-op         |
| Tests                                   | 1297 unit / 105 E2E | **1412 unit / 119 E2E** | +115 unit / +14 E2E |
| `created` counter on re-runs            | "5000 created" (lie) | "0 created" (truth)| accurate           |

Per-batch round-trip math: a re-extract on a 47K-page brain with ~5 links per page used to do 235K sequential round-trips over the Supabase pooler. With 100-row batched INSERTs it does ~2,400. The hang came from the read pre-load (47K serial `getLinks()` calls), which is now gone entirely. The DB enforces uniqueness via `ON CONFLICT DO NOTHING`.

### What this means for GBrain users

If you've been afraid to re-run `gbrain extract` because it might never finish, that's over. The command starts producing output immediately, batch-writes 100 rows per round-trip, and reports a truthful insert count even on re-runs. If your v0.12.0 upgrade got stuck on the timeline migration (or you had to manually run `CREATE TABLE ... AS SELECT DISTINCT ON ...` to unblock it), the next `gbrain init --migrate-only` is sub-second. Run `gbrain extract all` on your largest brain and watch it actually work.

### Itemized changes

#### Performance

- **`gbrain extract` no longer pre-loads the dedup set.** Removed the N+1 read loop in `extractLinksFromDir`, `extractTimelineFromDir`, `extractLinksFromDB`, and `extractTimelineFromDB` that called `engine.getLinks(slug)` (or `getTimeline`) once per page across `engine.listPages({ limit: 100000 })`. On a 47K-page brain that was 47K serial network round-trips before the first file was even read. Both engines already enforced uniqueness at the SQL layer (`UNIQUE(from_page_id, to_page_id, link_type)` on `links`, `idx_timeline_dedup` on `timeline_entries`); the in-memory dedup `Set` was redundant insurance that turned into the bottleneck.
- **Batched multi-row INSERTs replace per-row writes.** All four extract paths now buffer 100 candidates and flush via new `addLinksBatch` / `addTimelineEntriesBatch` engine methods. Round-trips drop ~100x: ~235K → ~2,400 per full re-extract. Each batch uses `INSERT ... SELECT FROM unnest($1::text[], $2::text[], ...) JOIN pages ON CONFLICT DO NOTHING RETURNING 1` — 4 (links) or 5 (timeline) array-typed bound parameters regardless of batch size, sidestepping Postgres's 65535-parameter cap entirely. PGLite uses the same SQL shape with manual `$N` placeholders.

#### Correctness

- **`created` counter is now truthful on re-runs.** Returns count of rows actually inserted (via `RETURNING 1` row count), not "calls that didn't throw." A re-run on a fully-extracted brain prints `Done: 0 links, 0 timeline entries from 47000 pages`. Before this release it would print `Done: 5000 links` while inserting zero new rows.
- **`--dry-run` deduplicates candidates across files.** A link extracted from 3 different markdown files now prints exactly once in `--dry-run` output, matching what the batch insert would actually create. Before this release the dedup was tied to the now-deleted DB pre-load, so dry-run would over-print.
- **Whole-batch errors are visible in both JSON and human modes.** When a batch flush fails (DB connection drop, malformed row), the error prints to stderr in JSON mode AND to console in human mode, with the lost-row count. No more silent loss of 100 rows because of one bad row.

#### Schema migrations — v0.12.0 upgrade is now sub-second on duplicate-heavy brains

- **Migration v9 (timeline_entries) and v8 (links) pre-create a btree helper index** on the dedup columns before the `DELETE ... USING` self-join runs. Turns the O(n²) sequential-scan dedup into O(n log n) index-backed dedup. On 80K+ duplicate rows the migration completes in well under a second instead of timing out at 60s. The helper index is dropped after dedup, leaving the original schema unchanged. Same fix applied defensively to migration v8 — Garry's brain didn't trip it (links had fewer duplicates) but the same trap was loaded.
- **`phaseASchema` timeout in the v0.12.0 orchestrator bumped 60s → 600s.** Belt-and-suspenders: the helper-index fix should make dedup sub-second on most brains, but the outer wall-clock budget shouldn't be the failure mode for unforeseen slowness.

#### New engine API

- **`addLinksBatch(LinkBatchInput[]) → Promise<number>`** and **`addTimelineEntriesBatch(TimelineBatchInput[]) → Promise<number>`** on both `PostgresEngine` and `PGLiteEngine`. Returns count of actually-inserted rows (excluding ON CONFLICT no-ops and JOIN-dropped rows whose slugs don't exist). Per-row `addLink` / `addTimelineEntry` are unchanged — all 10 existing call sites compile and behave identically. Plugin authors building agent integrations on `BrainEngine` can adopt the batch methods at their own pace.

#### Tests

- **Migration regression tests guard the fix structurally + behaviorally.** New `test/migrate.test.ts` cases assert the v8 + v9 SQL literally contains the helper `CREATE INDEX IF NOT EXISTS ... DROP INDEX IF EXISTS` sequence in the right order (deterministic, fast, catches a regression even at 0-row scale where wall-clock can't distinguish O(n²) from O(1)) AND that the migration completes under wall-clock cap on 1000-row fixtures.
- **`test/extract-fs.test.ts` (new file)** covers the FS-source extract path end-to-end on PGLite: first-run inserts, second-run reports zero, dry-run dedups duplicate candidates across 3 files into one printed line, second-run perf regression guard.
- **9 new E2E tests for the postgres-engine batch methods** in `test/e2e/mechanical.test.ts`. The postgres-js bind path is structurally different from PGLite's (array params via `unnest()` vs manual `$N` placeholders) and gets its own coverage against real Postgres+pgvector.
- **11 new PGLite batch method tests** in `test/pglite-engine.test.ts` (empty batch, missing optionals normalize to empty strings, within-batch dedup via ON CONFLICT, missing-slug rows dropped by JOIN, half-existing batch returns count of new only, batch of 100).

#### Pre-ship review

This release was reviewed by `/plan-eng-review` (5 issues, all addressed including a P0 plan reshape that dropped a redundant orchestrator phase in favor of fixing migration v9 directly), `/codex` outside-voice review on the plan (15 findings, all P1 + P2 incorporated — most consequential: forced a cleaner separation between per-row API stability and new batch APIs so all 10 existing `addLink` callers stay untouched), and 5 specialist subagents (testing, maintainability, performance, security, data-migration) at ship time. The testing specialist caught a real bug in the postgres-engine batch SQL: postgres-js's `sql(rows, ...)` helper doesn't compose with `(VALUES) AS v(...)` JOIN syntax the way originally written. Switched to the cleaner `unnest()` array-parameter pattern in both engines, verified end-to-end against a real Postgres+pgvector container.

## [0.12.0] - 2026-04-18

<!-- /GBRAIN_HISTORICAL_v0.12.1 -->

## [Unreleased]

### Integrated from upstream GBrain

Pulling forward security, data-correctness, and reliability fixes that landed in upstream GBrain (`garrytan/gbrain`) after our v0.1.0 fork point. This wave takes only the must-have fixes; large new feature layers (Minions agent orchestration, knowledge graph) are deferred to a separate Wave-2 evaluation. See individual section entries below for per-fix detail.

- **Security — Wave 3 (9 vulnerabilities closed, from upstream #174).** `file_upload` arbitrary-file-read is closed, recipe trust boundary is real, string health_checks are blocked for untrusted recipes, SSRF defense for HTTP health_checks, prompt-injection hardening for query expansion, and `list_pages`/`get_ingest_log` actually cap now. Original fixes contributed by @garagon (#105-#109) and @Hybirdss (#139). See the historical `[0.10.2]` entry below for the full breakdown.
- **Migrations runner infrastructure (subset of upstream #130).** Adds `pbrain apply-migrations` and the `src/commands/migrations/` framework. The runner framework is in place; the actual orchestrators (Minions adoption, knowledge-graph auto-wire) are deferred to Wave-2. Registry begins empty and is populated by the JSONB repair entry below.
- **Data correctness — JSONB double-encode + splitBody + parseEmbedding (from upstream #196).** Fixes the `${JSON.stringify(x)}::jsonb` interpolation bug that silently stored Postgres JSONB columns as quoted strings (broke every `frontmatter->>'key'` query on Postgres-backed brains — PGLite was unaffected). Fixes the `splitBody` greedy `---` match that truncated wiki articles by up to 83%. Fixes `parseEmbedding` returning strings instead of `Float32Array` on Supabase, yielding NaN search scores. Adds `pbrain repair-jsonb`, the `scripts/check-jsonb-pattern.sh` CI grep guard, and an E2E regression test. Original fixes contributed by @knee5 (#187) and @leonardsellem (#175). See the historical `[0.12.2]` entry below for the full breakdown.
- **Perf — extract N+1 hang fix (from upstream #198).** New `addLinksBatch` and `addTimelineEntriesBatch` engine methods that use a single `INSERT ... SELECT FROM unnest(...) ... ON CONFLICT DO NOTHING RETURNING 1` query regardless of batch size. File-source `pbrain extract` now flushes candidates 100 at a time instead of issuing one write per link/entry. Mirrors the same pattern across PGLite and Postgres engines. Original fix was bundled with the Minions work by upstream; here it's isolated to the batch-insert API surface so it stands independent of the knowledge-graph layer. See the historical `[0.12.1]` entry below for the full breakdown.

## [0.12.2] - 2026-04-19

## **Postgres frontmatter queries actually work now.**
## **Wiki articles stop disappearing when you import them.**

This is a data-correctness hotfix for the `v0.12.0`-and-earlier Postgres-backed brains. If you run pbrain on Postgres or Supabase, you've been losing data without knowing it. PGLite users were unaffected. Upgrade auto-repairs your existing rows. Lands on top of v0.12.1 (extract N+1 fix + migration timeout fix) — pull `pbrain upgrade` and you get both.

### What was broken

**Frontmatter columns were silently stored as quoted strings, not JSON.** Every `put_page` wrote `frontmatter` to Postgres via `${JSON.stringify(value)}::jsonb` — postgres.js v3 stringified again on the wire, so the column ended up holding `"\"{\\\"author\\\":\\\"garry\\\"}\""` instead of `{"author":"garry"}`. Every `frontmatter->>'key'` query returned NULL. GIN indexes on JSONB were inert. Same bug on `raw_data.data`, `ingest_log.pages_updated`, `files.metadata`, and `page_versions.frontmatter`. PGLite hid this entirely (different driver path) — which is exactly why it slipped past the existing test suite.

**Wiki articles got truncated by 83% on import.** `splitBody` treated *any* standalone `---` line in body content as a timeline separator. Discovered by @knee5 migrating a 1,991-article wiki where a 23,887-byte article landed in the DB as 593 bytes (4,856 of 6,680 wikilinks lost).

**`/wiki/` subdirectories silently typed as `concept`.** Articles under `/wiki/analysis/`, `/wiki/guides/`, `/wiki/hardware/`, `/wiki/architecture/`, and `/writing/` defaulted to `type='concept'` — type-filtered queries lost everything in those buckets.

**pgvector embeddings sometimes returned as strings → NaN search scores.** Discovered by @leonardsellem on Supabase, where `getEmbeddingsByChunkIds` returned `"[0.1,0.2,…]"` instead of `Float32Array`, producing `[NaN]` query scores.

### What you can do now that you couldn't before

- **`frontmatter->>'author'` returns `garry`, not NULL.** GIN indexes work. Postgres queries by frontmatter key actually retrieve pages.
- **Wiki articles round-trip intact.** Markdown horizontal rules in body text are horizontal rules, not timeline separators.
- **Recover already-truncated pages with `pbrain sync --full`.** Re-import from your source-of-truth markdown rebuilds `compiled_truth` correctly.
- **Search scores stop going `NaN` on Supabase.** Cosine rescoring sees real `Float32Array` embeddings.
- **Type-filtered queries find your wiki articles.** `/wiki/analysis/` becomes type `analysis`, `/writing/` becomes `writing`, etc.

### How to upgrade

```bash
pbrain upgrade
```

The `v0.12.2` orchestrator runs automatically: applies any schema changes, then `pbrain repair-jsonb` rewrites every double-encoded row in place using `jsonb_typeof = 'string'` as the guard. Idempotent — re-running is a no-op. PGLite engines short-circuit cleanly. Batches well on large brains.

If you want to recover pages that were truncated by the splitBody bug:

```bash
pbrain sync --full
```

That re-imports every page from disk, so the new `splitBody` rebuilds the full `compiled_truth` correctly.

### What's new under the hood

- **`pbrain repair-jsonb`** — standalone command for the JSONB fix. Run it manually if needed; the migration runs it automatically. `--dry-run` shows what would be repaired without touching data. `--json` for scripting.
- **CI grep guard** at `scripts/check-jsonb-pattern.sh` — fails the build if anyone reintroduces the `${JSON.stringify(x)}::jsonb` interpolation pattern. Wired into `bun test` so it runs on every CI invocation.
- **New E2E regression test** at `test/e2e/postgres-jsonb.test.ts` — round-trips all four JSONB write sites against real Postgres and asserts `jsonb_typeof = 'object'` plus `->>` returns the expected scalar. The test that should have caught the original bug.
- **Wikilink extraction** — `[[page]]` and `[[page|Display Text]]` syntaxes now extracted alongside standard `[text](page.md)` markdown links. Includes ancestor-search resolution for wiki KBs where authors omit one or more leading `../`.

### Migration scope

The repair touches five JSONB columns:
- `pages.frontmatter`
- `raw_data.data`
- `ingest_log.pages_updated`
- `files.metadata`
- `page_versions.frontmatter` (downstream of `pages.frontmatter` via INSERT...SELECT)

Other JSONB columns in the schema (`minion_jobs.{data,result,progress,stacktrace}`, `minion_inbox.payload`) were always written via the parameterized `$N::jsonb` form so they were never affected.

### Behavior changes (read this if you upgrade)

`splitBody` now requires an explicit sentinel for timeline content. Recognized markers (in priority order):
1. `<!-- timeline -->` (preferred — what `serializeMarkdown` emits)
2. `--- timeline ---` (decorated separator)
3. `---` directly before `## Timeline` or `## History` heading (backward-compat fallback)

If you intentionally used a plain `---` to mark your timeline section in source markdown, add `<!-- timeline -->` above it manually. The fallback covers the common case (`---` followed by `## Timeline`).

### Attribution

Built from community PRs #187 (@knee5) and #175 (@leonardsellem). The original PRs reported the bugs and proposed the fixes; this release re-implements them on top of the v0.12.0 knowledge graph release with expanded migration scope, schema audit (all 5 affected columns vs the 3 originally reported), engine-aware behavior, CI grep guard, and an E2E regression test that should have caught this in the first place. Codex outside-voice review during planning surfaced the missed `page_versions.frontmatter` propagation path and the noisy-truncated-diagnostic anti-pattern that was dropped from this scope. Thanks for finding the bugs and providing the recovery path — both PRs left work to do but the foundation was right.

Co-Authored-By: @knee5 (PR #187 — splitBody, inferType wiki, JSONB triple-fix)
Co-Authored-By: @leonardsellem (PR #175 — parseEmbedding, getEmbeddingsByChunkIds fix)

## [0.12.1] - 2026-04-19

## [0.1.0] - 2026-04-17

The first PBrain release. Adaptation work was phased across four PRs merged to master incrementally; this release tags the final state after all four phases plus the pre-tag polish wave below.

### Pre-tag polish and dogfood fixes

Everything merged between the Phase 4 merge and the v0.1.0 tag actually moving — installer work, doctor false-positive cleanup, project onboarding primitives, and issues that surfaced dogfooding PBrain against a real Obsidian vault on Google Drive.

- **`pbrain doctor` is quiet when there's nothing to fix.** Three more false-positive classes eliminated: (1) the `skill_symlinks` check no longer dumps "shadowed by other plugins: claude:..., cursor:..., windsurf:..." for all 78 entries when your installed symlinks happen to point at a sibling PBrain checkout (e.g. `~/.pbrain-repo` while you're running doctor from a dev clone) — a new `ours-elsewhere` state detects any pbrain tree via `package.json.name === 'pbrain'` and the message now reads `installed — claude: 26, cursor: 26, windsurf: 26 (symlinks resolve to sibling checkout at <path>)`. (2) The `resolver_health` MECE overlap between `maintain` and `citation-fixer` on the trigger `"citation audit"` is gone — removed from `maintain` since `citation-fixer` is the specialized skill for that phrase. (3) Seven skills (`ingest`, `enrich`, `setup`, `signal-detector`, `idea-ingest`, `media-ingest`, `meeting-ingestion`) now reference `skills/conventions/quality.md` alongside their local citation / Iron-Law recap, silencing the DRY-violation warnings while keeping the inline guidance readable. Doctor's health score on a fresh install now reflects only real, user-actionable issues.
- **`pbrain doctor` no longer cries wolf on PGLite or on project/repo pairs that share a name.** The `DUPLICATE_SLUG` check was firing every time you onboarded a project whose repo name matches its product name — `projects/pbrain` + `repos/joedanz/pbrain` always collide on the tail "pbrain," even when every wikilink in the brain is path-qualified and there's no real ambiguity. It now fires only when a bare-slug `[[tail]]` wikilink actually references the ambiguous tail, and the message points at the exact page referencing it so you can fix it in one edit. Separately, the `pgvector` and `rls` checks stop reporting "Could not check ..." for PGLite users — pgvector is bundled with the PGLite WASM runtime and RLS is meaningless for a local embedded DB, so both now report green with an explanatory message. Your doctor health score now reflects real problems, not check-runner noise.
- **`project-onboard` accepts the product name and domain as positional arguments in any order, and infers the repo from your current directory.** Call it with `project-onboard <name> <domain>` from inside a repo and that's all you need — no repo URL, no keyword wrapping. Args are classified by shape, not position: anything with a slash is the repo, anything with a TLD is the domain, everything else is the display name. The project slug resolves in priority order — explicit display name wins, then domain root, then `package.json`, then the repo name with suffixes like `-web` / `-app` / `-monorepo` stripped — so a repo called `<name>-web` still gets filed under `projects/<name>`. Use `project=<value>` as a named escape hatch when a display name itself looks like a domain.
- **Onboard a coding project once, and every future Claude Code session in that project already knows it.** The `project-onboard` skill now installs a short `## pbrain` declaration into the project's own `CLAUDE.md` at the end of its run — slug, brain-query guidance, and the `pbrain remember` recipe. Every subsequent session in that project auto-recognizes it and routes brain lookups to the right slug; the skill's new Phase 0 idempotency gate short-circuits in ~5ms so re-invocation is a free no-op. No machine-wide hook, no `~/.claude/settings.json` edit, no manually-written `.pbrain-project` marker — just one gesture per project, ever. Delete the `## pbrain` section to stop tracking. Per-project opt-in keeps client checkouts and scratch clones out of your brain by default.
- **New: `pbrain remember "<summary>"` records a decision on the current project without you passing a slug.** Run it from inside any onboarded repo and it resolves cwd → brain slug via the resolver PR #18 shipped, then appends a dated timeline entry to `repos/<owner>/<name>`. "Switched auth from Clerk to Better Auth for Convex compatibility" is one command, not an LLM prompt. Exits with a helpful pointer at the `project-onboard` skill when cwd isn't a tracked project.
- **New: `pbrain whoami --json` emits `{slug, matchedVia, cwd}` as machine-readable JSON** so skills and scripts can decide what to do without parsing prose. This is the primitive the `project-onboard` skill's idempotency gate shells out to, and the shape any future SessionStart hook or agent decision-tree can consume.
- **New: `pbrain canonical-url <url>` is the single source of truth for git-URL canonicalization.** Wraps the internal `normalizeGitUrl()` so skills, scripts, and CI shell out for a guaranteed-consistent form (lowercase host/path, `.git` stripped, `https://` scheme) across SSH, HTTPS, scp-form, ssh+port, and `git://` inputs. Hand-rolling normalization in skill prose was fragile; now there's one command that can't drift from the engine's lookup query.
- **Breaking (dev-only): `findRepoByUrl` is now a GIN-indexed `frontmatter.github_url` containment query — body-scan ILIKE path deleted.** Pages written by the `project-onboard` skill now carry `github_url: <canonical>` in frontmatter; the lookup query uses `frontmatter @> jsonb_build_object('github_url', $1)` and hits `idx_pages_frontmatter` directly. Repo-page resolution at session start went from an unindexed sequential `ILIKE '%<url>%'` over every `repos/*` body to a ~1ms indexed containment check. **No backfill is shipped** — PBrain is pre-release and there are no production users with legacy body-scan-only pages to migrate. The `project-onboard` skill has been updated to write `type: source` + canonical `github_url` in frontmatter on every new page, and the repo slug convention moved to collision-free nested `repos/<owner>/<name>` (was `repos/<owner>-<name>`, which could collapse `foo-bar/baz` and `foo/bar-baz` to the same slug).
- **One-line installer — `curl … | bash` and you have a working PBrain.** `curl -fsSL https://raw.githubusercontent.com/joedanz/pbrain/master/scripts/install.sh | bash` now detects or installs Bun, clones the repo into `~/.pbrain-repo`, runs `bun install && bun link`, prompts for your Obsidian vault, runs `pbrain init`, and optionally registers skills into Claude Code / Cursor / Windsurf — in a single pipe. Re-run to upgrade: the installer is idempotent, detects the existing checkout, and runs `git pull && bun install` on top of it. Fully scriptable for agents and CI with `--brain-path`, `--install-dir`, `--branch`, `--yes`, `--skip-skills`, `--skip-init`, and `--dry-run` flags (plus matching `PBRAIN_*` env vars). Refuses to run as root, points Windows users at WSL, and degrades cleanly when piped without a TTY. See [docs/install.md](docs/install.md) for the full reference.
- **`pbrain whoami` tells you which brain project your current directory maps to.** `cd` into a repo, run `pbrain whoami`, and get back the brain slug — either from a `.pbrain-project` marker you dropped (wins on monorepos and sub-projects) or inferred from your git remotes (canonicalized across SSH/HTTPS/ssh+port/GitHub-Enterprise shapes, matched against the `GitHub:` line `project-onboard` writes into each `repos/<owner>-<slug>.md` page). Tries remotes in precedence order — `origin`, then `upstream`, then any others — so if you're in a fork whose canonical lives upstream, it still resolves. Stops the ancestor marker-walk at `$HOME` so a dotfiles repo in `~` can't falsely claim unrelated subdirectories, and handles git worktrees and submodules correctly via `.git`-file gitdir pointers. `--verbose` lists what every layer tried so you can tell exactly why a miss happened. This is the first piece of the auto-brain-inject experience — the primitive a future SessionStart hook or `/pbrain-context` command will use to pull the right project's graph neighborhood into your Claude Code session automatically. Also exposed as the MCP op `find_repo_by_url` for any tool that wants the URL → repo-page lookup on its own.
- **Breaking: Claude Code plugin distribution removed. Install via `git clone && bun install && bun link`.** The plugin was skills-only — it shipped the 26 markdown skill files without the `pbrain` CLI that those skills call. Users who installed it hit "command not found: pbrain" the first time a skill tried to search or write, with no clear path forward. We removed the `.claude-plugin/` manifest and the OpenClaw bundle manifest entirely. The CLI route (README.md Standalone CLI section) is now the canonical install for everyone — humans, agents, IDE users. IDE skill registration still works via `pbrain install-skills` (run it after `bun link`). A follow-up PR will add a one-line bootstrap installer.
- **`pbrain init` now requires `--brain-path` on fresh installs; reuses it on re-init.** Before: bare `pbrain init` wrote a config with no `brain_path`, leaving every skill stranded without a folder to write into. After: fresh installs (no prior `~/.pbrain/config.json`) fail fast with a clear error unless you pass `--brain-path ~/ObsidianVault/MyBrain` or set `PBRAIN_BRAIN_PATH`. Re-runs on already-configured machines reuse the saved path silently, so the `git pull && bun install && pbrain init` upgrade flow still works hands-off. Interactive mode rejects empty input and offers to `mkdir -p` the folder if it doesn't exist.
- **`pbrain install-skills` no longer runs automatically during `pbrain init`.** Before: init prompted inline to symlink skills into Claude Code / Cursor / Windsurf, then shelled out to `pbrain install-skills` mid-init. After: init prints a one-line hint showing the command to run if an IDE is detected, and the user decides when. `pbrain upgrade` still refreshes symlinks automatically since you already opted in the first time.
- **Fixed: `pbrain` binary now launches after `bun link` without manual `chmod +x`.** `src/cli.ts` was tracked at mode 644 in git, so the symlink `bun link` creates pointed at a non-executable file — the MCP server launched by Claude Code / Cursor failed with a silent "permission denied" and the server showed as ✗ failed in the MCP manager. After: the file's executable bit is tracked (mode 755), so a fresh clone + `bun link` produces a working `pbrain serve` immediately. Existing users only need to `git pull` — the mode bit updates with the working tree.
- **Fixed: install-skills now symlinks skill directories, not SKILL.md files.** The initial installer pointed each symlink at `<skill>/SKILL.md` — but Claude Code / Cursor / Windsurf scan for `<skills-dir>/<name>/SKILL.md`, meaning none of the skills were actually discoverable despite appearing to install cleanly. After: symlinks target the skill directory so the discovery path resolves. On upgrade, legacy file-pointing symlinks self-heal without needing `--force`.
- **`pbrain doctor --integrations` surfaces scan failures instead of silently reporting green.** Before: `readdirSync` EPERM/EACCES (macOS CloudStorage without Full Disk Access is the common trigger) was swallowed, and the doctor reported "0 pages, 0 issues" on a vault it couldn't actually read — a false green. After: scan errors emit a new `scan_error` issue with actionable guidance (grant FDA to `~/.bun/bin/bun`).
- **PGLite lock detects PID reuse via process start time, not arg matching.** Before: after an `pbrain serve` process died, the lock's PID could be inherited by an unrelated program and the stale-detection would incorrectly block CLI commands (or, if the heuristic flipped the other way, the CLI would wrongly clobber a live holder's lock). After: lock records `lstart`; liveness check compares stored vs live start time — unambiguous even under PID reuse.
- **Clearer lock-contention error when `pbrain serve` is holding PGLite.** Before: CLI timed out after 30s with "Timed out waiting for PGLite lock" and no guidance. After: fails in ~2s with a specific error calling out the most common cause (a running MCP server from Claude Code / Cursor) and two paths to resolve (stop the MCP server, or `pbrain migrate --to postgres` for multi-process access).
- **`pbrain serve` registers SIGTERM/SIGINT handlers** so Claude Code shutting down the MCP server gracefully releases the lock on disk instead of leaving it for stale-detection to clean up later.

### Attribution

PBrain was forked from [GBrain v0.10.1](https://github.com/garrytan/gbrain) by [Garry Tan](https://github.com/garrytan). Every core engineering decision originates from GBrain: contract-first operations, pluggable engines (PGLite + Postgres), hybrid RAG search, compiled truth + timeline page format, fat markdown skills, the autopilot daemon, the MCP stdio server, and the recipe system. PBrain resets the version to `0.1.0` to mark a product boundary — different audience (senior engineers), different taxonomy (libraries/ai-tools/repos/patterns/papers/talks/books in, VC directories out), different storage semantics (markdown-first, Obsidian-native) — not because GBrain's API is unstable. GBrain's own lineage continues independently at its own cadence. See [NOTICE](NOTICE) and [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md) for the full attribution.

### Phase 1 — Rebrand (merged)

#### Forked
- **Project renamed GBrain → PBrain (Project Brain).** Fork of [garrytan/gbrain](https://github.com/garrytan/gbrain) at v0.10.1. Retargets the same architecture from VC/founder knowledge management to software-engineering knowledge management (coding projects, libraries, AI tools, git repos, code patterns, papers/talks/books, tech companies).
- **Attribution preserved.** Original copyright and LICENSE unchanged. New `NOTICE` file and `docs/ATTRIBUTION.md` credit Garry Tan and all GBrain contributors as the origin of every core engineering decision (contract-first ops, pluggable engines, hybrid RAG, compiled truth, skill resolver, autopilot, MCP server).

#### Changed
- **Binary:** `gbrain` → `pbrain`. The CLI command and MCP server name are now `pbrain`. PBrain is source-distributed (clone + `bun install && bun link`) — no GitHub binary release, matching the upstream GBrain model.
- **Config directory:** `~/.gbrain/` → `~/.pbrain/`. Includes `config.json`, `indexes/`, `update-state.json`. Migration shim in `pbrain init` detects an existing `~/.gbrain/` and offers a one-time consented rename.
- **Environment variables:** `GBRAIN_DATABASE_URL` → `PBRAIN_DATABASE_URL`. The standard `DATABASE_URL` fallback still works (unchanged). All other `GBRAIN_*` env vars similarly renamed to `PBRAIN_*`.
- **TypeScript type:** `GBrainConfig` → `PBrainConfig`.
- **Doc filenames:** `docs/GBRAIN_RECOMMENDED_SCHEMA.md` → `docs/PBRAIN_RECOMMENDED_SCHEMA.md`, `docs/GBRAIN_SKILLPACK.md` → `docs/PBRAIN_SKILLPACK.md`, `docs/GBRAIN_V0.md` → `docs/PBRAIN_V0.md`, `docs/GBRAIN_VERIFY.md` → `docs/PBRAIN_VERIFY.md`.
- **Release check URL:** `pbrain upgrade` / `pbrain check-update` now polls `api.github.com/repos/joedanz/pbrain/releases/latest`, not the upstream GBrain repo.
- **README masthead** rewritten to credit GBrain and Garry Tan directly, replace the Garry-persona builder story with PBrain's engineering focus, and point install URLs at `github.com/joedanz/pbrain`.

#### Not changed (yet)
- **Schema.** Phase 1 is rebrand-only: directory taxonomy, skills, and page templates are still GBrain-shaped (VC-flavored). Phase 2 drops `deals/`/`hiring/`/`civic/`/`org/`/`media/`/`personal/`/`household/`, adds `libraries/`/`ai-tools/`/`repos/`/`patterns/`/`papers/`/`talks/`/`books/`, and re-skins `companies/` for tech organizations.
- **Storage model.** Still DB-first with one-way markdown import. Phase 3 inverts this: markdown files on disk become the source of truth, PGLite becomes a rebuildable index, optimized for use as an Obsidian vault.
- **Version bump.** `package.json` stays at `0.10.1` through Phase 1–3; only bumped to `0.1.0` when Phase 4 merges and the first PBrain release is tagged.

#### Migration path
Existing GBrain users: there is no automated GBrain→PBrain upgrade. PBrain is a separate CLI command (`pbrain`, not `gbrain`) and a separate config directory (`~/.pbrain/`). GBrain v0.10.1 and PBrain v0.1.0 are distinct products.

### Phase 2 — Schema & skills adaptation (merged)

#### Schema taxonomy rebuilt for engineering
- **Seven tech directories added:** `libraries/` (packages you `import`), `ai-tools/` (products you `curl` or drive via CLI/UI), `repos/` (git source trees you own or follow), `patterns/` (reusable code idioms), `papers/` (arxiv/conference), `talks/` (conference/podcast/video), `books/` (long reference works).
- **Eight VC/founder directories dropped** from the recommended schema: `deals/`, `hiring/`, `civic/`, `org/`, `media/`, `personal/`, `household/`, `programs/`. Existing pages there are untouched — the resolver simply stops routing new content to them.
- **`originals/` now documented** in the schema taxonomy (was implicit in skills but undocumented).
- **Resolver decision tree rewritten** (`docs/PBRAIN_RECOMMENDED_SCHEMA.md`) with 20 numbered entries, tech-flavored disambiguation rules (library vs. ai-tool, library vs. repo, pattern vs. library, paper vs. concept, etc.), and a two-question check before any tech-domain page is created.

#### `companies/` template re-skinned for tech orgs
- VC fields removed: Stage (Seed/Series A/Growth), Key metrics (revenue/headcount/funding), Investors/board.
- Tech-org fields added: **What they make**, **Current offerings** (models/APIs/CLIs), **Direction** (roadmap signals), **My usage** (which endpoints, which plan, observed cost), **Key people** (CEO/research lead/head of DX — not investors).
- Seven new page templates added to `docs/PBRAIN_RECOMMENDED_SCHEMA.md` for library/ai-tool/repo/pattern/paper/talk/book.

#### Enrichment sources rewired
- `skills/enrich/SKILL.md` now prioritizes GitHub REST+GraphQL, package registries (npm/PyPI/crates.io/pkg.go.dev), arxiv/Semantic Scholar, and product docs (docs.anthropic.com, OpenAI API reference, model cards) over VC-style LinkedIn/Crunchbase/Crustdata/Happenstance/PitchBook.
- Five new enrichment flows documented: library, AI tool, paper, plus updated flows for person (engineer/maintainer) and tech company.
- Tier table rebuilt: GitHub API / package registry are now first-class Tier 1–3 sources.

#### Routing & filing rules
- `skills/RESOLVER.md` gained a "Tech-domain filing" section mapping each of the seven new directories to its template.
- `skills/_brain-filing-rules.md` gained a "Tech-domain primary-subject tests" section with concrete misfiling patterns (changelog entry → library timeline; tool review → ai-tool page; retry-with-jitter → pattern, not library).

#### Migration
- `skills/migrations/v1.1.0.md` documents the taxonomy change for the eventual v1.0.0 auto-update: non-destructive (no content is touched), updates routing only, rollback-safe.

### Phase 3 — Markdown-first storage (merged)

The inversion: files on disk are authoritative; the database is a rebuildable index on top of them. Obsidian compatibility is first-class.

#### Config
- `PBrainConfig` gains an optional `brain_path` field — the absolute path to your markdown brain folder. Works with any filesystem: local, Google Drive Desktop, iCloud, existing Obsidian vaults.
- `pbrain init` prompts for brain path interactively, or takes `--brain-path <dir>` / `PBRAIN_BRAIN_PATH` env var for scripts. Non-interactive flows without a brain path still work — the field is optional.
- New installs land the PGLite index at `~/.pbrain/indexes/default.pglite` instead of `~/.pbrain/brain.pglite`. Keeps binary index files out of cloud-synced brain folders. Existing installs keep using the legacy path — no migration required.

#### Write primitives
- `src/core/atomic-write.ts` — all PBrain file writes go through `atomicWriteFileSync` (write to `.pbrain-tmp-<uuid>`, `fsync`, rename). Obsidian never sees a half-written file.
- `src/core/wikilink.ts` — emit `[[slug]]`, parse, resolve against known slugs and `aliases:` frontmatter. Exports `toPlainMarkdown` for downstream tools that don't resolve wikilinks.
- `src/core/tag-footer.ts` — writes tags in two places: YAML frontmatter (Dataview, parsers) and an inline `<!-- pbrain-tags -->\n#tag #tag` footer (Obsidian tag pane, GitHub render). Idempotent re-writes.
- `src/core/page-writer.ts` — single chokepoint combining atomic writes + 60-second modification cooldown + tag-footer + frontmatter serialization. If a target file was modified in the last minute, the write defers instead of clobbering the user's in-flight Obsidian edit.

#### CLI
- `pbrain index` is the new verb for rebuilding the index from your brain folder. `pbrain import` stays as an alias — existing scripts keep working. When `brain_path` is set, `pbrain index` with no positional arg walks the configured folder.

#### Migration
- `skills/migrations/v2.0.0.md` documents the config shape change, new index default, and write primitives. Non-destructive — no existing content is touched.

### Phase 4 — Obsidian polish + doctor checks (merged)

Final phase — tags `v0.1.0` and cuts the first PBrain release.

#### Doctor
- `pbrain doctor --integrations` validates the brain folder as an Obsidian-compatible vault. Checks `brain_path` exists and is writable, every YAML frontmatter block parses, every `[[wikilink]]` resolves to a known slug or alias, no duplicate slugs across directories (Obsidian wikilink collision prevention), and no leftover `.pbrain-tmp-*` sentinels from crashed atomic writes.
- Exits non-zero if any issue is found. `--json` for structured output. Filesystem-only — no database required.
- New module `src/core/doctor-integrations.ts` holds the check logic so tests can exercise it without spawning the CLI.

#### Docs
- `docs/integrations/obsidian.md` — complete setup guide covering both paths (point PBrain at an existing vault, or open a brain folder as a new vault), Dataview query examples against PBrain's frontmatter, cloud-sync notes, and troubleshooting.
- Main `README.md` gained a dedicated **Obsidian** section documenting that PBrain is an Obsidian-compatible vault out of the box — no plugins required to read PBrain's output.

#### Recipe
- `recipes/obsidian-vault.md` — new self-installing recipe. Agent-executable setup: pick a path, `pbrain init --brain-path`, `pbrain index`, `pbrain doctor --integrations`. Listed as the first infra recipe in `docs/integrations/README.md`.

#### Version
- `package.json` bumped from `0.10.1` to `0.1.0`. Tagged `v0.1.0`, first PBrain GitHub release cut.

---

## [0.10.2] - 2026-04-17

### Security — Wave 3 (9 vulnerabilities closed)

This wave closes a high-severity arbitrary-file-read in `file_upload`, fixes a fake trust boundary that let any cwd-local recipe execute arbitrary commands, and lays down real SSRF defense for HTTP health checks. If you ran `pbrain` in a directory where someone could drop a `recipes/` folder, this matters.

- **Arbitrary file read via `file_upload` is closed.** Remote (MCP) callers were able to read `/etc/passwd` or any other host file. Path validation now uses `realpathSync` + `path.relative` to catch symlinked-parent traversal, plus an allowlist regex for slugs and filenames (control chars, backslashes, RTL-override Unicode all rejected). Local CLI users still upload from anywhere — only remote callers are confined. Fixes Issue #139, contributed by @Hybirdss; original fix #105 by @garagon.
- **Recipe trust boundary is real now.** `loadAllRecipes()` previously marked every recipe as `embedded=true`, including ones from `./recipes/` in your cwd or `$PBRAIN_RECIPES_DIR`. Anyone who could drop a recipe in cwd could bypass every health-check gate. Now only package-bundled recipes (source install + global install) are trusted. Original fixes #106, #108 by @garagon.
- **String health_checks blocked for untrusted recipes.** Even with the recipe trust fix, the string health_check path ran `execSync` before reaching the typed-DSL switch — a malicious "embedded" recipe could `curl http://169.254.169.254/metadata` and exfiltrate cloud credentials. Non-embedded recipes are now hard-blocked from string health_checks; embedded recipes still get the `isUnsafeHealthCheck` defense-in-depth guard.
- **SSRF defense for HTTP health_checks.** New `isInternalUrl()` blocks loopback, RFC1918, link-local (incl. AWS metadata 169.254.169.254), CGNAT, IPv6 loopback, and IPv4-mapped IPv6 (`[::ffff:127.0.0.1]` canonicalized to hex hextets — both forms blocked). Bypass encodings handled: hex IPs (`0x7f000001`), octal (`0177.0.0.1`), single decimal (`2130706433`). Scheme allowlist rejects `file:`, `data:`, `blob:`, `ftp:`, `javascript:`. `fetch` runs with `redirect: 'manual'` and re-validates every Location header up to 3 hops. Original fix #108 by @garagon.
- **Prompt injection hardening for query expansion.** Restructured the LLM prompt with a system instruction that declares the query as untrusted data, plus an XML-tagged `<user_query>` boundary. Layered with regex sanitization (strips code fences, tags, injection prefixes) and output-side validation on the model's `alternative_queries` array (cap length, strip control chars, dedup, drop empties). The `console.warn` on stripped content never logs the query text itself. Original fix #107 by @garagon.
- **`list_pages` and `get_ingest_log` actually cap now.** Wave 3 found that `clampSearchLimit(limit, default)` was always allowing up to 100 — the second arg was the default, not the cap. Added a third `cap` parameter so `list_pages` caps at 100 and `get_ingest_log` caps at 50. Internal bulk commands (embed --all, export, migrate-engine) bypass the operation layer entirely and remain uncapped. Original fix #109 by @garagon.

### Added

- `OperationContext.remote` flag distinguishes trusted local CLI callers from untrusted MCP callers. Security-sensitive operations (currently `file_upload`) tighten their behavior when `remote=true`. Defaults to strict (treat as remote) when unset.
- Exported security helpers for testing and reuse: `validateUploadPath`, `validatePageSlug`, `validateFilename`, `parseOctet`, `hostnameToOctets`, `isPrivateIpv4`, `isInternalUrl`, `getRecipeDirs`, `sanitizeQueryForPrompt`, `sanitizeExpansionOutput`.
- 49 new tests covering symlink traversal, scheme allowlist, IPv4 bypass forms, IPv6 mapped addresses, prompt injection patterns, and recipe trust boundaries. Plus an E2E regression proving remote callers can't escape cwd.

### Contributors

Wave 3 fixes were contributed by **@garagon** (PRs #105-#109) and **@Hybirdss** (Issue #139). The collector branch re-implemented each fix with additional hardening for the residuals Codex caught during outside-voice review (parent-symlink traversal, fake `isEmbedded` boundary, redirect-following SSRF, scheme bypasses, `clampSearchLimit` semantics).

## [0.10.1] - 2026-04-15

### Fixed

- **`pbrain sync --watch` actually works now.** The watch loop existed but was never called because the CLI routed sync through the operation layer (single-pass only). Now sync routes through the CLI path that knows about `--watch` and `--interval`. Your cron workaround is no longer needed.

- **Sync auto-embeds your pages.** After syncing, pbrain now embeds the changed pages automatically. No more "I synced but search can't find my new page." Opt out with `--no-embed`. Large syncs (100+ pages) defer embedding to `pbrain embed --stale`.

- **First sync no longer repeats forever.** `performFullSync` wasn't saving its checkpoint. Fixed: sync state persists after full import so the next sync is incremental.

- **`dead_links` metric is consistent across engines.** Postgres was counting empty-content chunks instead of dangling links. Now both engines count the same thing: links pointing to non-existent pages.

- **Doctor recommends the right embed command.** Was suggesting `pbrain embed refresh` (doesn't exist). Now correctly says `pbrain embed --stale`.

### Added

- **`pbrain extract links|timeline|all`** builds your link graph and structured timeline from existing markdown. Scans for markdown links, frontmatter fields (company, investors, attendees), and See Also sections. Infers link types from directory structure. Parses both bullet (`- **YYYY-MM-DD** | Source — Summary`) and header (`### YYYY-MM-DD — Title`) timeline formats. Runs automatically after every sync.

- **`pbrain features --json --auto-fix`** scans your brain and tells you what you're not using, with your own numbers. Priority 1 (data quality): missing embeddings, dead links. Priority 2 (unused features): zero links, zero timeline, low coverage, unconfigured integrations. Agents run `--auto-fix` to handle everything automatically.

- **`pbrain autopilot --install`** sets up a persistent daemon that runs sync, extract, and embed in a continuous loop. Health-based scheduling: brain score >= 90 slows down, < 70 speeds up. Installs as a launchd service (macOS) or crontab entry (Linux). One command, brain maintains itself forever.

- **Brain health score (0-100)** in `pbrain health` and `pbrain doctor`. Weighted composite of embed coverage, link density, timeline coverage, orphan pages, and dead links. Agents use it as a health gate.

- **`pbrain embed --slugs`** embeds specific pages by slug. Used internally by sync auto-embed to target just the changed pages.

- **Instruction layer for agents.** RESOLVER.md routing entries, maintain skill sections, and setup skill phase for extract, features, and autopilot. Without these, agents would never discover the new commands.

## [0.10.0] - 2026-04-14

### Added

- **Your agent now has 24 skills, not 8.** 16 new brain skills generalized from a production deployment with 14,700+ pages. Signal detection, brain-first lookup, content ingestion (articles, video, meetings), entity enrichment, task management, cron scheduling, reports, and cross-modal review. All shipped as fat markdown files your agent reads on demand.

- **Signal detector fires on every message.** A cheap sub-agent spawns in parallel to capture original thinking and entity mentions. Ideas get preserved with exact phrasing. Entities get brain pages. The brain compounds on autopilot.

- **RESOLVER.md routes your agent to the right skill.** Modeled on a 215-line production dispatcher. Categorized routing table: always-on, brain ops, ingestion, thinking, operational. Your agent reads it, matches the user's intent, loads the skill. No slash commands needed.

- **Soul-audit builds your agent's identity.** 6-phase interactive interview generates SOUL.md (who the agent is), USER.md (who you are), ACCESS_POLICY.md (who sees what), and HEARTBEAT.md (operational cadence). Re-runnable anytime. Ships with minimal defaults so first boot is instant.

- **Access control out of the box.** 4-tier privacy policy (Full/Work/Family/None) enforced by skill instructions before every response. Template-based, configurable per user.

- **Conventions directory codifies operational discipline.** Brain-first lookup protocol, citation quality standards, model routing table, test-before-bulk rule, and cross-modal review pairs. These are the hard-won patterns that prevent bad bulk runs and silent failures.

- **`pbrain init` detects GStack and reports mod status.** After brain setup, init now shows how many skills are loaded, whether GStack is installed, and where to get it. GStack detection uses `gstack-global-discover` with fallback to known host paths.

- **Conformance standard for all skills.** Every skill now has YAML frontmatter (name, version, description, triggers, tools, mutating) plus Contract, Anti-Patterns, and Output Format sections. Two new test files validate conformance across all 25 skills.

- **Existing 8 skills migrated to conformance format.** Frontmatter added, Workflow renamed to Phases, Contract and Anti-Patterns sections added. Ingest becomes a thin router delegating to specialized ingestion skills.

### The 16 new skills

| Skill | What it does | Why it matters |
|-------|-------------|----------------|
| **signal-detector** | Fires on every message. Spawns a cheap model in parallel to capture original thinking and entity mentions. | Your brain compounds on autopilot. Every conversation is an ingest event. Miss a signal and the brain never learns it. |
| **brain-ops** | Brain-first lookup before any external API. The read-enrich-write loop that makes every response smarter. | Without this, your agent reaches for Google when the answer is already in the brain. Wastes tokens, misses context. |
| **idea-ingest** | Links, articles, tweets go into the brain with analysis, author people pages, and cross-linking. | Every article worth reading is worth remembering. The author gets a people page. The ideas get cross-linked to what you already know. |
| **media-ingest** | Video, audio, PDF, books, screenshots, GitHub repos. Transcripts, entity extraction, backlink propagation. | One skill handles every media format. Absorbs what used to be 3 separate skills (video-ingest, youtube-ingest, book-ingest). |
| **meeting-ingestion** | Transcripts become brain pages. Every attendee gets enriched. Every company discussed gets a timeline entry. | A meeting is NOT fully ingested until every entity is propagated. This is the skill that turns a transcript into 10 updated brain pages. |
| **citation-fixer** | Scans brain pages for missing or malformed `[Source: ...]` citations. Fixes formatting to match the standard. | Without citations, you can't trace facts back to where they came from. Six months later, "who said this?" has an answer. |
| **repo-architecture** | Where new brain files go. Decision protocol: primary subject determines directory, not format or source. | Prevents the #1 misfiling pattern: dumping everything in `sources/` because it came from a URL. |
| **skill-creator** | Create new skills following the conformance standard. MECE check against existing skills. Updates manifest and resolver. | Users who need a capability PBrain doesn't have can create it themselves. The skill teaches the agent how to extend itself. |
| **daily-task-manager** | Add, complete, defer, remove, review tasks with priority levels (P0-P3). Stored as a searchable brain page. | Your tasks live in the brain, not a separate app. The agent can cross-reference tasks with meeting notes and people pages. |
| **daily-task-prep** | Morning preparation. Calendar lookahead with brain context per attendee, open threads from yesterday, active task review. | Walk into every meeting with full context on every person in the room, automatically. |
| **cross-modal-review** | Spawn a different AI model to review the agent's work before committing. Refusal routing: if one model refuses, silently switch. | Two models agreeing is stronger signal than one model being thorough. Refusal routing means the user never sees "I can't do that." |
| **cron-scheduler** | Schedule staggering (5-min offsets), quiet hours (timezone-aware with wake-up override), thin job prompts. | 21 cron jobs at :00 is a thundering herd. Staggering prevents it. Quiet hours mean no 3 AM notifications. Wake-up override releases the backlog. |
| **reports** | Timestamped reports with keyword routing. "What's the latest briefing?" maps to the right report directory. | Cheap replacement for vector search on frequent queries. Don't embed. Load the file. |
| **testing** | Validates every skill has SKILL.md with frontmatter, manifest coverage, resolver coverage. The CI for your skill system. | 3 skills and you need validation. 24 skills and you need it yesterday. Catches dead references, missing sections, MECE violations. |
| **soul-audit** | 6-phase interview that generates SOUL.md, USER.md, ACCESS_POLICY.md, HEARTBEAT.md. Your agent's identity, built from your answers. | What makes Wintermute feel like Wintermute. Without personality and access control, every agent feels the same. |
| **webhook-transforms** | External events (SMS, meetings, social mentions) converted into brain pages with entity extraction. Dead-letter queue for failures. | Your brain ingests signals from everywhere. Not just conversations, but every webhook, every notification, every external event. |

### Infrastructure (new in v0.10.0)

- **Your brain now self-validates its own skill routing.** `checkResolvable()` verifies every skill is reachable from RESOLVER.md, detects MECE overlaps, flags missing triggers, and catches DRY violations. Runs from `bun test`, `pbrain doctor`, and the skill-creator skill. Every issue comes with a machine-readable fix object the agent can act on.

- **`pbrain doctor` got serious.** 8 health checks now (up from 5), plus a composite health score (0-100). Filesystem checks (resolver, conformance) run even without a database. `--fast` skips DB checks. `--json` output includes structured `issues` array with action strings so agents can parse and auto-fix.

- **Batch operations won't melt your machine anymore.** Adaptive load-aware throttling checks CPU and memory before each batch item. Exponential backoff with a 20-attempt safety cap. Active hours multiplier slows batch work during the day. Two concurrent batch process limit.

- **Your agent's classifiers get smarter automatically.** Fail-improve loop: try deterministic code first, fall back to LLM, log every fallback. Over time, the logs reveal which regex patterns are missing. Auto-generates test cases from successful LLM results. Tracks deterministic hit rate in `pbrain doctor` output.

- **Voice notes just work.** Groq Whisper transcription (with OpenAI fallback) via `transcribe_audio` operation. Files over 25MB get ffmpeg-segmented automatically. Transcripts flow through the standard import pipeline, entities get extracted, back-links get created.

- **Enrichment is now a global service, not a per-skill skill.** Every ingest pathway can call `extractAndEnrich()` to detect entities and create/update their brain pages. Tier auto-escalation: entities start at Tier 3, auto-promote to Tier 1 based on mention frequency across sources.

- **Data research: one skill for any email-to-tracker pipeline.** New `data-research` skill with parameterized YAML recipes. Extract investor updates (MRR, ARR, runway, headcount), expense receipts, company metrics from email. Battle-tested regex patterns, extraction integrity rule (save first, report second), dedup with configurable tolerance, canonical tracker pages with running totals.

### For contributors

- `test/skills-conformance.test.ts` validates every skill has valid frontmatter and required sections
- `test/resolver.test.ts` validates RESOLVER.md coverage and routing consistency
- `skills/manifest.json` now has `conformance_version` field and lists all 24 skills
- Identity templates in `templates/` (SOUL.md, USER.md, ACCESS_POLICY.md, HEARTBEAT.md)
## [0.9.3] - 2026-04-12

### Added

- **Search understands what you're asking. +21% page coverage, +29% signal, 100% source accuracy.** A zero-latency intent classifier reads your query and picks the right search mode. "Who is Alice?" surfaces your compiled truth assessment. "When did we last meet?" surfaces timeline entries with dates. No LLM call, just pattern matching. Your agent sees 8.7 relevant pages per query instead of 7.2, and two thirds of returned chunks are now distilled assessments instead of half. Entity lookups always lead with compiled truth. Temporal queries always find the dates. Benchmarked against 29 pages, 20 queries with graded relevance (run `bun run test/benchmark-search-quality.ts` to reproduce). Inspired by Ramp Labs' "Latent Briefing" paper (April 2026).
- **`pbrain query --detail low/medium/high`.** Agents can control how deep search goes. `low` returns compiled truth only. `medium` (default) returns everything with dedup. `high` returns all chunks uncapped. Auto-escalates from low to high if no results found. MCP picks it up automatically.
- **`pbrain eval` measures search quality.** Full retrieval evaluation harness with P@k, R@k, MRR, nDCG@k metrics. A/B comparison mode for parameter tuning: `pbrain eval --qrels queries.json --config-a baseline.json --config-b boosted.json`. Contributed by @4shut0sh.
- **CJK queries expand correctly.** Chinese, Japanese, and Korean text was silently skipping query expansion because word count used space-delimited splitting. Now counts characters for CJK. Contributed by @YIING99.
- **Health checks speak a typed language now.** Recipe `health_checks` use a typed DSL (`http`, `env_exists`, `command`, `any_of`) instead of raw shell strings. No more `execSync(untrustedYAML)`. Your agent runs `pbrain integrations doctor` and gets structured results, not shell injection risk. All 7 first-party recipes migrated. String health checks still work (with deprecation warning) for backward compat.

### Fixed

- **Your storage backend can't be tricked into reading `/etc/passwd`.** `LocalStorage` now validates every path stays within the storage root. `../../etc/passwd` gets "Path traversal blocked" instead of your system files. All 6 methods covered (upload, download, delete, exists, list, getUrl).
- **MCP callers can't read arbitrary files via `file_url`.** `resolveFile()` now validates the requested path stays within the brain root before touching the filesystem. Previously, `../../etc/passwd` would read any file the process could access.
- **`.supabase` marker files can't escape their scope.** Marker prefix validation now rejects `../`, absolute paths, and bare `..`. A crafted `.supabase` file in a shared brain repo can't make storage requests outside the intended prefix.
- **File queries can't blow up memory.** The slug-filtered `file_list` MCP operation now has the same `LIMIT 100` as the unfiltered branch. Also fixed the CLI `pbrain files list` and `pbrain files verify` commands.
- **Symlinks in brain directories can't exfiltrate files.** All 4 file walkers in `files.ts` plus the `init.ts` size counter now use `lstatSync` and skip symlinks. Broken symlinks and `node_modules` directories are also skipped.
- **Recipe health checks can't inject shell commands.** Non-embedded (user-created) recipes with shell metacharacters in health_check strings are blocked. First-party recipes are trusted but migrated to the typed DSL.

## [0.9.2] - 2026-04-12

### Fixed

- **Fresh local installs initialize cleanly again.** `pbrain init` now creates the local PGLite data directory before taking its advisory lock, so first-run setup no longer misreports a missing directory as a lock timeout.

## [0.9.1] - 2026-04-11

### Fixed

- **Your brain can't be poisoned by rogue frontmatter anymore.** Slug authority is now path-derived. A file at `notes/random.md` can't declare `slug: people/admin` and silently overwrite someone else's page. Mismatches are rejected with a clear error telling you exactly what to fix.
- **Symlinks in your notes directory can't exfiltrate files.** The import walker now uses `lstatSync` and refuses to follow symlinks, blocking the attack where a contributor plants a link to `~/.zshrc` in the brain directory. Defense-in-depth: `importFromFile` itself also checks.
- **Giant payloads through MCP can't rack up your OpenAI bill.** `importFromContent` now checks `Buffer.byteLength` before any processing. 10 MB of emoji through `put_page`? Rejected before chunking starts.
- **Search can't be weaponized into a DoS.** `limit` is clamped to 100 across all search paths (keyword, vector, hybrid). `statement_timeout: 8s` on the Postgres connection as defense-in-depth. Requesting `limit: 10000000` now gets you 100 results and a warning.
- **PGLite stops crashing when two processes touch the same brain.** File-based advisory lock using atomic `mkdir` with PID tracking and 5-minute stale detection. Clear error messages tell you which process holds the lock and how to recover.
- **12 data integrity fixes landed.** Orphan chunks cleaned up on empty pages. Write operations (`addLink`, `addTag`, `addTimelineEntry`, `putRawData`, `createVersion`) now throw when the target page doesn't exist instead of silently no-opping. Health metrics (`stale_pages`, `dead_links`, `orphan_pages`) now measure real problems instead of always returning 0. Keyword search moved from JS-side sort-and-splice to a SQL CTE with `LIMIT`. MCP server validates params before dispatch.
- **Stale embeddings can't lie to you anymore.** When chunk text changes but embedding fails, the old vector is now NULL'd out instead of preserved. Previously, search could return results based on outdated vectors attached to new text.
- **Embedding failures are no longer silent.** The `catch { /* non-fatal */ }` is gone. You now get `[pbrain] embedding failed for slug (N chunks): error message` in stderr. Still non-fatal, but you know what happened.
- **O(n^2) chunk lookup in `embedPage` is gone.** Replaced `find() + indexOf()` with a single `Map` lookup. Matches the pattern `embedAll` already uses.
- **Stdin bombs blocked.** `parseOpArgs` now caps stdin at 5 MB before the full buffer is consumed.

### Added

- **`pbrain embed --all` is 30x faster.** Sliding worker pool with 20 concurrent workers (tunable via `PBRAIN_EMBED_CONCURRENCY`). A 20,000-chunk corpus that took 2.5 hours now finishes in ~8 minutes.
- **Search pagination.** Both `search` and `query` now accept `--offset` for paginating through results. Combined with the 100-result ceiling, you can now page through large result sets.
- **`pbrain ask` is an alias for `pbrain query`.** CLI-only, doesn't appear in MCP tools-json.
- **Content hash now covers all page fields.** Title, type, and frontmatter changes trigger re-import. First sync after upgrade will re-import all pages (one-time, expected).
- **Migration file for v0.9.1.** Auto-update agent knows to expect the full re-import and will run `pbrain embed --all` afterward.
- **`pgcrypto` extension added to schema.** Fallback for `gen_random_uuid()` on Postgres < 13.

### Changed

- **Search type and exclude_slugs filters now work.** These were advertised in the API but never implemented. Both `searchKeyword` and `searchVector` now respect `type` and `exclude_slugs` params.
- **Hybrid search no longer double-embeds the query.** `expandQuery` already includes the original, so we use it directly instead of prepending.

## [0.9.0] - 2026-04-11

### Added

- **Large files don't bloat your git repo anymore.** `pbrain files upload-raw`
  auto-routes by size: text and PDFs under 100 MB stay in git, everything larger
  (or any media file) goes to Supabase Storage with a `.redirect.yaml` pointer
  left in the repo. Files over 100 MB use TUS resumable upload (6 MB chunks with
  retry and backoff) so a flaky connection doesn't lose a 2 GB video upload.
  `pbrain files signed-url` generates 1-hour access links for private buckets.

- **The full file migration lifecycle works end to end.** `mirror` uploads to
  cloud and keeps local copies. `redirect` replaces local files with
  `.redirect.yaml` pointers (verifies remote exists first, won't delete data).
  `restore` downloads back from cloud. `clean` removes pointers when you're sure.
  `status` shows where you are. Three states, zero data loss risk.

- **Your brain now enforces its own graph integrity.** The Iron Law of Back-Linking
  is mandatory across all skills. Every mention of a person or company creates
  a bidirectional link. This transforms your brain from a flat file store into a
  traversable knowledge graph.

- **Filing rules prevent the #1 brain mistake.** New `skills/_brain-filing-rules.md`
  stops the most common error: dumping everything into `sources/`. File by primary
  subject, not format. Includes notability gate and citation requirements.

- **Enrichment protocol that actually works.** Rewritten from a 46-line API list to
  a 7-step pipeline with 3-tier system, person/company page templates, pluggable
  data sources, validation rules, and bulk enrichment safety.

- **Ingest handles everything.** Articles, videos, podcasts, PDFs, screenshots,
  meeting transcripts, social media. Each with a workflow that uses real pbrain
  commands (`upload-raw`, `signed-url`) instead of theoretical patterns.

- **Citation requirements across all skills.** Every fact needs inline
  `[Source: ...]` citations. Three formats, source precedence hierarchy.

- **Maintain skill catches what you missed.** Back-link enforcement, citation audit,
  filing violations, file storage health checks, benchmark testing.

- **Voice calls don't crash on em dashes anymore.** Unicode sanitization for Twilio
  WebSocket, PII scrub, identity-first prompt, DIY STT+LLM+TTS pipeline option,
  Smart VAD default, auto-upload call audio via `pbrain files upload-raw`.

- **X-to-Brain gets eyes.** Image OCR, Filtered Stream real-time monitoring,
  6-dimension tweet rating rubric, outbound tweet monitoring, cron staggering.

- **Share brain pages without exposing the brain.** `pbrain publish` generates
  beautiful, self-contained HTML from any brain page. Strips private data
  (frontmatter, citations, confirmations, brain links, timeline) automatically.
  Optional AES-256-GCM password gate with client-side decryption, no server
  needed. Dark/light mode, mobile-optimized typography. This is the first
  code+skill pair: deterministic code does the work, the skill tells the agent
  when and how. See the [Thin Harness, Fat Skills](https://x.com/garrytan/status/2042925773300908103)
  thread for the architecture philosophy.

### Changed

- **Supabase Storage** now auto-selects upload method by file size: standard POST
  for < 100 MB, TUS resumable for >= 100 MB. Signed URL generation for private
  bucket access (1-hour expiry).
- **File resolver** supports both `.redirect.yaml` (v0.9+) and legacy `.redirect`
  (v0.8) formats for backward compatibility.
- **Redirect format** upgraded from `.redirect` (5 fields) to `.redirect.yaml`
  (10 fields: target, bucket, storage_path, size, size_human, hash, mime,
  uploaded, source_url, type).
- **All skills** updated to reference actual `pbrain files` commands instead of
  theoretical patterns.
- **Back-link enforcer closes the loop.** `pbrain check-backlinks check` scans your
  brain for entity mentions without back-links. `pbrain check-backlinks fix` creates
  them. The Iron Law of Back-Linking is in every skill, now the code enforces it.

- **Page linter catches LLM slop.** `pbrain lint` flags "Of course! Here is..."
  preambles, wrapping code fences, placeholder dates, missing frontmatter, broken
  citations, and empty sections. `pbrain lint --fix` auto-strips the fixable ones.
  Every brain that uses AI for ingestion accumulates this. Now it's one command.

- **Audit trail for everything.** `pbrain report --type enrichment-sweep` saves
  timestamped reports to `brain/reports/{type}/YYYY-MM-DD-HHMM.md`. The maintain
  skill references this for enrichment sweeps, meeting syncs, and maintenance runs.

- **Publish skill** added to manifest (8th skill). First code+skill pair.
- Skills version bumped to 0.9.0.
- 67 new unit tests across publish, backlinks, lint, and report. Total: 409 pass.

## [0.8.0] - 2026-04-11

### Added

- **Your AI can answer the phone now.** Voice-to-brain v0.8.0 ships 25 production patterns from a real deployment. WebRTC works in a browser tab with just an OpenAI key, phone number via Twilio is optional. Your agent picks its own name and personality. Pre-computed engagement bids mean it greets you with something specific ("dude, your social radar caught something wild today"), not "how can I help you?" Context-first prompts, proactive advisor mode, caller routing, dynamic noise suppression, stuck watchdog, thinking sounds during tool calls. This is the "Her" experience, out of the box.
- **Upgrade = feature discovery.** When you upgrade to v0.8.0, the CLI tells you what's new and your agent offers to set up voice immediately. WebRTC-first (zero setup), then asks about a phone number. Migration files now have YAML frontmatter with `feature_pitch` so every future version can pitch its headline feature through the upgrade flow.
- **Remote MCP simplified.** The Supabase Edge Function deployment is gone. Remote MCP now uses a self-hosted server + ngrok tunnel. Simpler, more reliable, works with any AI client. All `docs/mcp/` guides updated to reflect the actual production architecture.

### Changed

- **Voice recipe is now 25 production patterns deep.** Identity separation, pre-computed bid system, context-first prompts, proactive advisor mode, conversation timing (the #1 fix), no-repetition rule, radical prompt compression (13K to 4.7K tokens), OpenAI Realtime Prompting Guide structure, auth-before-speech, brain escalation, stuck watchdog, never-hang-up rule, thinking sounds, fallback TwiML, tool set architecture, trusted user auth, caller routing, dynamic VAD, on-screen debug UI, live moment capture, belt-and-suspenders post-call, mandatory 3-step post-call, WebRTC parity, dual API event handling, report-aware query routing.
- **WebRTC session pseudocode updated.** Native FormData, `tools` in session config, `type: 'realtime'` on all session.update calls. WebRTC transcription NOT supported over data channel (use Whisper post-call).
- **MCP docs rewritten.** All per-client guides (Claude Code, Claude Desktop, Cowork, Perplexity) updated from Edge Function URLs to self-hosted + ngrok pattern.

### Removed

- **Supabase Edge Function MCP deployment.** `scripts/deploy-remote.sh`, `supabase/functions/pbrain-mcp/`, `src/edge-entry.ts`, `.env.production.example`, `docs/mcp/CHATGPT.md` all removed. The Edge Function never worked reliably. Self-hosted + ngrok is the path.

## [0.7.0] - 2026-04-11

### Added

- **Your brain now runs locally with zero infrastructure.** PGLite (Postgres 17.5 compiled to WASM) gives you the exact same search quality as Supabase, same pgvector HNSW, same pg_trgm fuzzy matching, same tsvector full-text search. No server, no subscription, no API keys needed for keyword search. `pbrain init` and you're running in 2 seconds.
- **Smart init defaults to local.** `pbrain init` now creates a PGLite brain by default. If your repo has 1000+ markdown files, it suggests Supabase for scale. `--supabase` and `--pglite` flags let you choose explicitly.
- **Migrate between engines anytime.** `pbrain migrate --to supabase` transfers your entire brain (pages, chunks, embeddings, tags, links, timeline) to remote Postgres with manifest-based resume. `pbrain migrate --to pglite` goes the other way. Embeddings copy directly, no re-embedding needed.
- **Pluggable engine factory.** `createEngine()` dynamically loads the right engine from config. PGLite WASM is never loaded for Postgres users.
- **Search works without OpenAI.** `hybridSearch` now checks for `OPENAI_API_KEY` before attempting embeddings. No key = keyword-only search. No more crashes when you just want to search your local brain.
- **Your brain gets new senses automatically.** Integration recipes teach your agent how to wire up voice calls, email, Twitter, and calendar into your brain. Run `pbrain integrations` to see what's available. Your agent reads the recipe, asks for API keys, validates each one, and sets everything up. Markdown is code -- the recipe IS the installer.
- **Voice-to-brain: phone calls create brain pages.** The first recipe: Twilio + OpenAI Realtime voice agent. Call a number, talk, and a structured brain page appears with entity detection, cross-references, and a summary posted to your messaging app. Opinionated defaults: caller screening, brain-first lookup, quiet hours, thinking sounds. The smoke test calls YOU (outbound) so you experience the magic immediately.
- **`pbrain integrations` command.** Six subcommands for managing integration recipes: `list` (dashboard of senses + reflexes), `show` (recipe details), `status` (credential checks with direct links to get missing keys), `doctor` (health checks), `stats` (signal analytics), `test` (recipe validation). `--json` on every subcommand for agent-parseable output. No database connection needed.
- **Health heartbeat.** Integrations log events to `~/.pbrain/integrations/<id>/heartbeat.jsonl`. Status checks detect stale integrations and include diagnostic steps.
- **17 individually linkable SKILLPACK guides.** The 1,281-line monolith is now broken into standalone guides at `docs/guides/`, organized by category. Each guide is individually searchable and linkable. The SKILLPACK index stays at the same URL (backward compatible).
- **"Getting Data In" documentation.** New `docs/integrations/` with a landing page, recipe format documentation, credential gateway guide, and meeting webhook guide. Explains the deterministic collector pattern: code for data, LLMs for judgment.
- **Architecture and philosophy docs.** `docs/architecture/infra-layer.md` documents the shared foundation (import, chunk, embed, search). `docs/ethos/THIN_HARNESS_FAT_SKILLS.md` is Garry's essay on the architecture philosophy with an agent decision guide. `docs/designs/HOMEBREW_FOR_PERSONAL_AI.md` maps the 10-star vision.

### Changed

- **Engine interface expanded.** Added `runMigration()` (replaces internal driver access for schema migrations) and `getChunksWithEmbeddings()` (loads embedding data for cross-engine migration).
- **Shared utilities extracted.** `validateSlug`, `contentHash`, and row mappers moved from `postgres-engine.ts` to `src/core/utils.ts`. Both engines share them.
- **Config infers engine type.** If `database_path` is set but `engine` is missing, config now infers `pglite` instead of defaulting to `postgres`.
- **Import serializes on PGLite.** Parallel workers are Postgres-only. PGLite uses sequential import (single-connection architecture).

## [0.6.1] - 2026-04-10

### Fixed

- **Import no longer silently drops files with "..." in the name.** The path traversal check rejected any filename containing two consecutive dots, killing 1.2% of files in real-world corpora (YouTube transcripts, TED talks, podcast titles). Now only rejects actual traversal patterns like `../`. Community fix wave, 8 contributors.
- **Import no longer crashes on JavaScript/TypeScript projects.** The file walker crashed on `node_modules` directories and broken symlinks. Now skips `node_modules` and handles broken symlinks gracefully with a warning.
- **`pbrain init` exits cleanly after setup.** Previously hung forever because stdin stayed open. Now pauses stdin after reading input.
- **pgvector extension auto-created during init.** No more copy-pasting SQL into the Supabase editor. `pbrain init` now runs `CREATE EXTENSION IF NOT EXISTS vector` automatically, with a clear fallback message if it can't.
- **Supabase connection string hint matches current dashboard UI.** Updated navigation path to match the 2026 Supabase dashboard layout.
- **Hermes Agent link fixed in README.** Pointed to the correct NousResearch GitHub repo.

### Changed

- **Search is faster.** Keyword search now runs in parallel with the embedding pipeline instead of waiting for it. Saves ~200-500ms per hybrid search call.
- **.mdx files are now importable.** The import walker, sync filter, and slug generator all recognize `.mdx` alongside `.md`.

### Added

- **Community PR wave process** documented in CLAUDE.md for future contributor batches.

### Contributors

Thank you to everyone who reported bugs, submitted fixes, and helped make PBrain better:

- **@orendi84** — slug validator ellipsis fix (PR #31)
- **@mattbratos** — import walker resilience + MDX support (PRs #26, #27)
- **@changergosum** — init exit fix + auto pgvector (PRs #17, #18)
- **@eric-hth** — Supabase UI hint update (PR #30)
- **@irresi** — parallel hybrid search (PR #8)
- **@howardpen9** — Hermes Agent link fix (PR #34)
- **@cktang88** — the thorough 12-bug report that drove v0.6.0 (Issue #22)
- **@mvanhorn** — MCP schema handler fix (PR #25)

## [0.6.0] - 2026-04-10

### Added

- **Access your brain from any AI client.** Deploy PBrain as a serverless remote MCP endpoint on your existing Supabase instance. Works with Claude Desktop, Claude Code, Cowork, and Perplexity Computer. One URL, bearer token auth, zero new infrastructure. Clone the repo, fill in 3 env vars, run `scripts/deploy-remote.sh`, done.
- **Per-client setup guides** in `docs/mcp/` for Claude Code, Claude Desktop, Cowork, Perplexity, and ChatGPT (coming soon, requires OAuth 2.1). Also documents Tailscale Funnel and ngrok as self-hosted alternatives.
- **Token management** via standalone `src/commands/auth.ts`. Create, list, revoke per-client bearer tokens. Includes smoke test: `auth.ts test <url> --token <token>` verifies the full pipeline (initialize + tools/list + get_stats) in 3 seconds.
- **Usage logging** via `mcp_request_log` table. Every remote tool call logs token name, operation, latency, and status for debugging and security auditing.
- **Hardened health endpoint** at `/health`. Unauthenticated: 200/503 only (no info disclosure). Authenticated: checks postgres, pgvector, and OpenAI API key status.

### Fixed

- **MCP server actually connects now.** Handler registration used string literals (`'tools/list' as any`) instead of SDK typed schemas. Replaced with `ListToolsRequestSchema` and `CallToolRequestSchema`. Without this fix, `pbrain serve` silently failed to register handlers. (Issue #9)
- **Search results no longer flooded by one large page.** Keyword search returned ALL chunks from matching pages. Now returns one best chunk per page via `DISTINCT ON`. (Issue #22)
- **Search dedup no longer collapses to one chunk per page.** Layer 1 kept only the single highest-scoring chunk per slug. Now keeps top 3, letting later dedup layers (text similarity, cap per page) do their job. (Issue #22)
- **Transactions no longer corrupt shared state.** Both `PostgresEngine.transaction()` and `db.withTransaction()` swapped the shared connection reference, breaking under concurrent use. Now uses scoped engine via `Object.create` with no shared state mutation. (Issue #22)
- **embed --stale no longer wipes valid embeddings.** `upsertChunks()` deleted all chunks then re-inserted, writing NULL for chunks without new embeddings. Now uses UPSERT (INSERT ON CONFLICT UPDATE) with COALESCE to preserve existing embeddings. (Issue #22)
- **Slug normalization is consistent.** `pathToSlug()` preserved case while `inferSlug()` lowercased. Now `validateSlug()` enforces lowercase at the validation layer, covering all entry points. (Issue #22)
- **initSchema no longer reads from disk at runtime.** Both schema loaders used `readFileSync` with `import.meta.url`, which broke in compiled binaries and Deno Edge Functions. Schema is now embedded at build time via `scripts/build-schema.sh`. (Issue #22)
- **file_upload actually uploads content.** The operation wrote DB metadata but never called the storage backend. Fixed in all 3 paths (operation, CLI upload, CLI sync) with rollback semantics. (Issue #22)
- **S3 storage backend authenticates requests.** `signedFetch()` was just unsigned `fetch()`. Replaced with `@aws-sdk/client-s3` for proper SigV4 signing. Supports R2/MinIO via `forcePathStyle`. (Issue #22)
- **Parallel import uses thread-safe queue.** `queue.shift()` had race conditions under parallel workers. Now uses an atomic index counter. Checkpoint preserved on errors for safe resume. (Issue #22)
- **redirect verifies remote existence before deleting local files.** Previously deleted local files unconditionally. Now checks storage backend before removing. (Issue #22)
- **`pbrain call` respects dry_run.** `handleToolCall()` hardcoded `dryRun: false`. Now reads from params. (Issue #22)

### Changed

- Added `@aws-sdk/client-s3` as a dependency for authenticated S3 operations.
- Schema migration v2: unique index on `content_chunks(page_id, chunk_index)` for UPSERT support.
- Schema migration v3: `access_tokens` and `mcp_request_log` tables for remote MCP auth.

## [0.5.1] - 2026-04-10

### Fixed

- **Apple Notes and files with spaces just work.** Paths like `Apple Notes/2017-05-03 ohmygreen.md` now auto-slugify to clean slugs (`apple-notes/2017-05-03-ohmygreen`). Spaces become hyphens, parens and special characters are stripped, accented characters normalize to ASCII. All 5,861+ Apple Notes files import cleanly without manual renaming.
- **Existing brains auto-migrate.** On first run after upgrade, a one-time migration renames all existing slugs with spaces or special characters to their clean form. Links are rewritten automatically. No manual cleanup needed.
- **Import and sync produce identical slugs.** Both pipelines now use the same `slugifyPath()` function, eliminating the mismatch where sync preserved case but import lowercased.

## [0.5.0] - 2026-04-10

### Added

- **Your brain never falls behind.** Live sync keeps the vector DB current with your brain repo automatically. Set up a cron, use `--watch`, hook into GitHub webhooks, or use git hooks. Your agent picks whatever fits its environment. Edit a markdown file, push, and within minutes it's searchable. No more stale embeddings serving wrong answers.
- **Know your install actually works.** New verification runbook (`docs/PBRAIN_VERIFY.md`) catches the silent failures that used to go unnoticed: the pooler bug that skips pages, missing embeddings, stale sync. The real test: push a correction, wait, search for it. If the old text comes back, sync is broken and the runbook tells you exactly why.
- **New installs set up live sync automatically.** The setup skill now includes live sync (Phase H) and full verification (Phase I) as mandatory steps. Agents that install PBrain will configure automatic sync and verify it works before declaring setup complete.
- **Fixes the silent page-skip bug.** If your Supabase connection uses the Transaction mode pooler, sync silently skips most pages. The new docs call this out as a hard prerequisite with a clear fix (switch to Session mode). The verification runbook catches it by comparing page count against file count.

## [0.4.2] - 2026-04-10

### Changed

- All GitHub Actions pinned to commit SHAs across test, e2e, and release workflows. Prevents supply chain attacks via mutable version tags.
- Workflow permissions hardened: `contents: read` on test and e2e workflows limits GITHUB_TOKEN blast radius.
- OpenClaw CI install pinned to v2026.4.9 instead of pulling latest.

### Added

- Gitleaks secret scanning CI job runs on every push and PR. Catches accidentally committed API keys, tokens, and credentials.
- `.gitleaks.toml` config with allowlists for test fixtures and example files.
- GitHub Actions SHA maintenance rule in CLAUDE.md so pins stay fresh on every `/ship` and `/review`.
- S3 Sig V4 TODO for future implementation when S3 storage becomes a deployment path.

## [0.4.1] - 2026-04-09

### Added

- `pbrain check-update` command with `--json` output. Checks GitHub Releases for new versions, compares semver (minor+ only, skips patches), fetches and parses changelog diffs. Fail-silent on network errors.
- SKILLPACK Section 17: Auto-Update Notifications. Full agent playbook for the update lifecycle: check, notify, consent, upgrade, skills refresh, schema sync, report. Never auto-upgrades without user permission.
- Standalone SKILLPACK self-update for users who load the skillpack directly without the pbrain CLI. Version markers in SKILLPACK and RECOMMENDED_SCHEMA headers, with raw GitHub URL fetching.
- Step 7 in the OpenClaw install paste: daily update checks, default-on. User opts into being notified about updates, not into automatic installs.
- Setup skill Phase G: conditional auto-update offer for manual install users.
- Schema state tracking via `~/.pbrain/update-state.json`. Tracks which recommended schema directories the user adopted, declined, or added custom. Future upgrades suggest new additions without re-suggesting declined items.
- `skills/migrations/` directory convention for version-specific post-upgrade agent directives.
- 20 unit tests and 5 E2E tests for the check-update command, covering version comparison, changelog extraction, CLI wiring, and real GitHub API interaction.
- E2E test DB lifecycle documentation in CLAUDE.md: spin up, run tests, tear down. No orphaned containers.

### Changed

- `detectInstallMethod()` exported from `upgrade.ts` for reuse by `check-update`.

### Fixed

- Semver comparison in changelog extraction was missing major-version guard, causing incorrect changelog entries to appear when crossing major version boundaries.

## [0.4.0] - 2026-04-09

### Added

- `pbrain doctor` command with `--json` output. Checks pgvector extension, RLS policies, schema version, embedding coverage, and connection health. Agents can self-diagnose issues.
- Pluggable storage backends: S3, Supabase Storage, and local filesystem. Choose where binary files live independently of the database. Configured via `pbrain init` or environment variables.
- Parallel import with per-worker engine instances. Large brain imports now use multiple database connections concurrently instead of a single serial pipeline.
- Import resume checkpoints. If `pbrain import` is interrupted, it picks up where it left off instead of re-importing everything.
- Automatic schema migration runner. On connect, pbrain detects the current schema version and applies any pending migrations without manual intervention.
- Row-Level Security (RLS) enabled on all tables with `BYPASSRLS` safety check. Every query goes through RLS policies.
- `--json` flag on `pbrain init` and `pbrain import` for machine-readable output. Agents can parse structured results instead of scraping CLI text.
- File migration CLI (`pbrain files migrate`) for moving files between storage backends. Two-way-door: test with `--dry-run`, migrate incrementally.
- Bulk chunk INSERT for faster page writes. Chunks are inserted in a single statement instead of one-at-a-time.
- Supabase smart URL parsing: automatically detects and converts IPv6-only pooler URLs to the correct connection format.
- 56 new unit tests covering doctor, storage backends, file migration, import resume, slug validation, setup branching, Supabase admin, and YAML parsing. Test suite grew from 9 to 19 test files.
- E2E tests for parallel import concurrency and all new features.

### Fixed

- `validateSlug` now accepts any filename characters (spaces, unicode, special chars) instead of rejecting non-alphanumeric slugs. Apple Notes and other real-world filenames import cleanly.
- Import resilience: files over 5MB are skipped with a warning instead of crashing the pipeline. Errors in individual files no longer abort the entire import.
- `pbrain init` detects IPv6-only Supabase URLs and adds the required `pgvector` check during setup.
- E2E test fixture counts, CLI argument parsing, and doctor exit codes cleaned up.

### Changed

- Setup skill and README rewritten for agent-first developer experience.
- Maintain skill updated with RLS verification, schema health checks, and `nohup` hints for large embedding jobs.

## [0.3.0] - 2026-04-08

### Added

- Contract-first architecture: single `operations.ts` defines ~30 shared operations. CLI, MCP, and tools-json all generated from the same source. Zero drift.
- `OperationError` type with structured error codes (`page_not_found`, `invalid_params`, `embedding_failed`, etc.). Agents can self-correct.
- `dry_run` parameter on all mutating operations. Agents preview before committing.
- `importFromContent()` split from `importFile()`. Both share the same chunk+embed+tag pipeline, but `importFromContent` works from strings (used by `put_page`). Wrapped in `engine.transaction()`.
- Idempotency hash now includes ALL fields (title, type, frontmatter, tags), not just compiled_truth + timeline. Metadata-only edits no longer silently skipped.
- `get_page` now supports optional `fuzzy: true` for slug resolution. Returns `resolved_slug` so callers know what happened.
- `query` operation now supports `expand` toggle (default true). Both CLI and MCP get the same control.
- 10 new operations wired up: `put_raw_data`, `get_raw_data`, `resolve_slugs`, `get_chunks`, `log_ingest`, `get_ingest_log`, `file_list`, `file_upload`, `file_url`.
- OpenClaw bundle plugin manifest (`openclaw.plugin.json`) with config schema, MCP server config, and skill listing.
- GitHub Actions CI: test on push/PR, multi-platform release builds (macOS arm64 + Linux x64) on version tags.
- `pbrain init --non-interactive` flag for plugin mode (accepts config via flags/env vars, no TTY required).
- Post-upgrade version verification in `pbrain upgrade`.
- Parity test (`test/parity.test.ts`) verifies structural contract between operations, CLI, and MCP.
- New `setup` skill replacing `install`: auto-provision Supabase via CLI, AGENTS.md injection, target TTHW < 2 min.
- E2E test suite against real Postgres+pgvector. 13 realistic fixtures (miniature brain with people, companies, deals, meetings, concepts), 14 test suites covering all operations, search quality benchmarks, idempotency stress tests, schema validation, and full setup journey verification.
- GitHub Actions E2E workflow: Tier 1 (mechanical) on every PR, Tier 2 (LLM skills via OpenClaw) nightly.
- `docker-compose.test.yml` and `.env.testing.example` for local E2E development.

### Fixed

- Schema loader in `db.ts` broke on PL/pgSQL trigger functions containing semicolons inside `$$` blocks. Replaced per-statement execution with single `conn.unsafe()` call.
- `traverseGraph` query failed with "could not identify equality operator for type json" when using `SELECT DISTINCT` with `json_agg`. Changed to `jsonb_agg`.

### Changed

- `src/mcp/server.ts` rewritten from ~233 to ~80 lines. Tool definitions and dispatch generated from operations[].
- `src/cli.ts` rewritten. Shared operations auto-registered from operations[]. CLI-only commands (init, upgrade, import, export, files, embed) kept as manual registrations.
- `tools-json` output now generated FROM operations[]. Third contract surface eliminated.
- All 7 skills rewritten with tool-agnostic language. Works with both CLI and MCP plugin contexts.
- File schema: `storage_url` column dropped, `storage_path` is the only identifier. URLs generated on demand via `file_url` operation.
- Config loading: env vars (`PBRAIN_DATABASE_URL`, `DATABASE_URL`, `OPENAI_API_KEY`) override config file values. Plugin config injected via env vars.

### Removed

- 12 command files migrated to operations.ts: get.ts, put.ts, delete.ts, list.ts, search.ts, query.ts, health.ts, stats.ts, tags.ts, link.ts, timeline.ts, version.ts.
- `storage_url` column from files table.

## [0.2.0.2] - 2026-04-07

### Changed

- Rewrote recommended brain schema doc with expanded architecture: database layer (entity registry, event ledger, fact store, relationship graph) presented as the core architecture, entity identity and deduplication, enrichment source ordering, epistemic discipline rules, worked examples showing full ingestion chains, concurrency guidance, and browser budget. Smoothed language for open-source readability.

## [0.2.0.1] - 2026-04-07

### Added

- Recommended brain schema doc (`docs/PBRAIN_RECOMMENDED_SCHEMA.md`): full MECE directory structure, compiled truth + timeline pages, enrichment pipeline, resolver decision tree, skill architecture, and cron job recommendations. The OpenClaw paste now links to this as step 5.

### Changed

- First-time experience rewritten. "Try it" section shows your own data, not fictional PG essays. OpenClaw paste references the GitHub repo, includes bun install fallback, and has the agent pick a dynamic query based on what it imported.
- Removed all references to `data/kindling/` (a demo corpus directory that never existed).

## [0.2.0] - 2026-04-05

### Added

- You can now keep your brain current with `pbrain sync`, which uses git's own diff machinery to process only what changed. No more 30-second full directory walks when 3 files changed.
- Watch mode (`pbrain sync --watch`) polls for changes and syncs automatically. Set it and forget it.
- Binary file management with `pbrain files` commands (list, upload, sync, verify). Store images, PDFs, and audio in Supabase Storage instead of clogging your git repo.
- Install skill (`skills/install/SKILL.md`) that walks you through setup from scratch, including Supabase CLI magic path for zero-copy-paste onboarding.
- Import and sync now share a checkpoint. Run `pbrain import`, then `pbrain sync`, and it picks up right where import left off. Zero gap.
- Tag reconciliation on reimport. If you remove a tag from your markdown, it actually gets removed from the database now.
- `pbrain config show` redacts database passwords so you can safely share your config.
- `updateSlug` engine method preserves page identity (page_id, chunks, embeddings) across renames. Zero re-embedding cost.
- `sync_brain` MCP tool returns structured results so agents know exactly what changed.
- 20 new sync tests (39 total across 3 test files)

## [0.1.0] - 2026-04-05

### Added

- Pluggable engine interface (`BrainEngine`) with full Postgres + pgvector implementation
- 25+ CLI commands: init, get, put, delete, list, search, query, import, export, embed, stats, health, link/unlink/backlinks/graph, tag/untag/tags, timeline/timeline-add, history/revert, config, upgrade, serve, call
- MCP stdio server with 20 tools mirroring all CLI operations
- 3-tier chunking: recursive (delimiter-aware), semantic (Savitzky-Golay boundary detection), LLM-guided (Claude Haiku topic shifts)
- Hybrid search with Reciprocal Rank Fusion merging vector + keyword results
- Multi-query expansion via Claude Haiku (2 alternative phrasings per query)
- 4-layer dedup pipeline: by source, cosine similarity, type diversity, per-page cap
- OpenAI embedding service (text-embedding-3-large, 1536 dims) with batch support and exponential backoff
- Postgres schema with pgvector HNSW, tsvector (trigger-based, spans timeline_entries), pg_trgm fuzzy slug matching
- Smart slug resolution for reads (fuzzy match via pg_trgm)
- Page version control with snapshot, history, and revert
- Typed links with recursive CTE graph traversal (max depth configurable)
- Brain health dashboard (embed coverage, stale pages, orphans, dead links)
- Stale alert annotations in search results
- Supabase init wizard with CLI auto-provision fallback
- Slug validation to prevent path traversal on export
- 6 fat markdown skills: ingest, query, maintain, enrich, briefing, migrate
- ClawHub manifest for skill distribution
- Full design docs: PBRAIN_V0 spec, pluggable engine architecture, SQLite engine plan
