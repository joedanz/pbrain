---
name: setup
description: Set up PBrain with auto-provision Supabase or PGLite, AGENTS.md injection, first import
triggers:
  - "set up pbrain"
  - "initialize brain"
  - "pbrain setup"
tools:
  - get_stats
  - get_health
  - sync_brain
  - put_page
mutating: true
---

# Setup PBrain

Set up PBrain from scratch. Target: working brain in under 5 minutes.

## Contract

- Setup completes with a working brain verified by `pbrain doctor --json` (all checks OK).
- The brain-first lookup protocol is injected into the project's AGENTS.md or equivalent.
- Live sync is configured and verified (a test change pushed and found via search).
- Schema state is tracked in `~/.pbrain/update-state.json` so future upgrades know what the user adopted or declined.
- No Supabase anon key is requested; PBrain uses only the database connection string.

## Install (if not already installed)

```bash
bun add github:joedanz/pbrain
```

## How PBrain connects

PBrain connects directly to Postgres over the wire protocol. NOT through the
Supabase REST API. You need the **database connection string** (a `postgresql://` URI),
not the project URL or anon key. The password is embedded in the connection string.

Use the **Shared Pooler** connection string (port 6543), not the direct connection
(port 5432). The direct hostname resolves to IPv6 only, which many environments
can't reach. Find it: go to the project, click **Get Connected** next to the
project URL, then **Direct Connection String** > **Session Pooler**, and copy
the **Shared Pooler** connection string.

**Do NOT ask for the Supabase anon key.** PBrain doesn't use it.

## Why Supabase

Supabase gives you managed Postgres + pgvector (vector search built in) for $25/mo:
- 8GB database + 100GB storage on Pro tier
- No server to manage, automatic backups, dashboard for debugging
- pgvector pre-installed, just works
- Alternative: any Postgres with pgvector extension (self-hosted, Neon, Railway, etc.)

## Prerequisites

- A Supabase account (Pro tier recommended, $25/mo) OR any Postgres with pgvector
- An OpenAI API key (for semantic search embeddings, ~$4-5 for 7,500 pages)
- A git-backed markdown knowledge base (or start fresh)

## Available init options

- `pbrain init --supabase` -- interactive wizard (prompts for connection string)
- `pbrain init --url <connection_string>` -- direct, no prompts
- `pbrain init --non-interactive --url <connection_string>` -- for scripts/agents
- `pbrain doctor --json` -- health check after init

There is no `--local`, `--sqlite`, or offline mode. PBrain requires Postgres + pgvector.

## Phase A: Supabase Setup (recommended)

Guide the user through creating a Supabase project:

1. "Go to https://supabase.com and sign up or log in."
2. "Click 'New Project' in the top left."
   - Name: `pbrain`
   - Region: pick the one closest to you
   - Database password: generate a strong one and save it
3. "Wait about 2 minutes for the project to initialize."
4. "Find the connection string: go to your project, click **Get Connected** next
   to the project URL, then **Direct Connection String** > **Session Pooler**,
   and copy the **Shared Pooler** connection string (port 6543)."
5. Initialize pbrain:
   ```bash
   pbrain init --non-interactive --url "postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres"
   ```
6. Verify: `pbrain doctor --json`

**OpenClaw/Hermes agent instructions:** Store the Supabase access token in your persistent
env as `SUPABASE_ACCESS_TOKEN`. pbrain doesn't store it, you need it for future
`pbrain doctor` runs. Generate at: https://supabase.com/dashboard/account/tokens

## Phase B: BYO Postgres (alternative)

If the user already has Postgres with pgvector:

1. Get the connection string from the user.
2. Run: `pbrain init --non-interactive --url "<connection_string>"`
3. Verify: `pbrain doctor --json`

If the connection fails with ECONNREFUSED and the URL contains `supabase.co`,
the user probably pasted the direct connection (IPv6 only). Guide them to the
Session pooler string instead (see Phase A step 4).

## Phase C: First Import

1. **Discover markdown repos.** Scan the environment for git repos with markdown content.

```bash
echo "=== PBrain Environment Discovery ==="
for dir in /data/* ~/git/* ~/Documents/* 2>/dev/null; do
  if [ -d "$dir/.git" ]; then
    md_count=$(find "$dir" -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$md_count" -gt 10 ]; then
      total_size=$(du -sh "$dir" 2>/dev/null | cut -f1)
      echo "  $dir ($total_size, $md_count .md files)"
    fi
  fi
done
echo "=== Discovery Complete ==="
```

2. **Import the best candidate.** For large imports (>1000 files), use nohup to
   survive session timeouts:
   ```bash
   nohup pbrain import <dir> --no-embed --workers 4 > /tmp/pbrain-import.log 2>&1 &
   ```
   Then check progress: `tail -1 /tmp/pbrain-import.log`

   For smaller imports, run directly:
   ```bash
   pbrain import <dir> --no-embed
   ```

3. **Prove search works.** Pick a semantic query based on what you imported:
   ```bash
   pbrain search "<topic from the imported data>"
   ```
   This is the magical moment: the user sees search finding things grep couldn't.

4. **Start embeddings.** Refresh stale embeddings (runs in background). Keyword
   search works NOW, semantic search improves as embeddings complete.

5. **Offer file migration.** If the repo has binary files (.raw/ directories with
   images, PDFs, audio):
   > "You have N binary files (X GB) in your brain repo. Want to move them to cloud
   > storage? Your git repo will drop from X GB to Y MB. All links keep working."

   If the user agrees, configure storage and run migration:
   ```bash
   # Configure storage backend (Supabase Storage recommended)
   pbrain config set storage.backend supabase
   pbrain config set storage.bucket brain-files
   pbrain config set storage.projectUrl <supabase-url>
   pbrain config set storage.serviceRoleKey <service-role-key>

   # Migrate binary files to cloud (3-step lifecycle)
   pbrain files mirror <brain-dir>       # Upload to cloud, keep local
   pbrain files redirect <brain-dir>     # Replace local with .redirect.yaml pointers
   # (optional) pbrain files clean <brain-dir> --yes   # Remove pointers too
   ```

   After migration, `pbrain files upload-raw` handles new files automatically:
   small text/PDFs stay in git, large/media files go to cloud with `.redirect.yaml`
   pointers. Files >= 100 MB use TUS resumable upload for reliability.

If no markdown repos are found, create a starter brain with a few template pages
(a person page, a company page, a concept page) from docs/PBRAIN_RECOMMENDED_SCHEMA.md.

## Phase D: Brain-First Lookup Protocol

Inject the brain-first lookup protocol into the project's AGENTS.md (or equivalent).
This replaces grep-based knowledge lookups with structured pbrain queries.

### BEFORE (grep) vs AFTER (pbrain)

| Task | Before (grep) | After (pbrain) |
|------|---------------|-----------------|
| Find a person | `grep -r "Pedro" brain/` | `pbrain search "Pedro"` |
| Understand a topic | `grep -rl "deal" brain/ \| head -5 && cat ...` | `pbrain query "what's the status of the deal"` |
| Read a known page | `cat brain/people/pedro.md` | `pbrain get people/pedro` |
| Find connections | `grep -rl "Brex" brain/ \| xargs grep "Pedro"` | `pbrain query "Pedro Brex relationship"` |

### Lookup sequence (MANDATORY for every entity question)

1. `pbrain search "name"` -- keyword match, fast, works without embeddings
2. `pbrain query "what do we know about name"` -- hybrid search, needs embeddings
3. `pbrain get <slug>` -- direct page read when you know the slug from steps 1-2
4. `grep` fallback -- only if pbrain returns zero results AND the file may exist outside the indexed brain

Stop at the first step that gives you what you need. Most lookups resolve at step 1.

### Sync-after-write rule

After creating or updating any brain page in the repo, sync immediately so the
index stays current:

```bash
pbrain sync --no-pull --no-embed
```

This indexes new/changed files without pulling from git or regenerating embeddings.
Embeddings can be refreshed later in batch (`pbrain embed --stale`).

### pbrain vs memory_search

| Layer | What it stores | When to use |
|-------|---------------|-------------|
| **pbrain** | World knowledge: people, companies, deals, meetings, concepts, media | "Who is Pedro?", "What happened at the board meeting?" |
| **memory_search** | Agent operational state: preferences, decisions, session context | "How does the user like formatting?", "What did we decide about X?" |

Both should be checked. pbrain for facts about the world. memory_search for how
the agent should behave.

## Phase E: Load the Production Agent Guide

Read `docs/PBRAIN_SKILLPACK.md`. This is the reference architecture for how a
production agent uses pbrain: the brain-agent loop, entity detection, enrichment
pipeline, meeting ingestion, cron schedules, and the five operational disciplines.

Inject the key patterns into the agent's system context or AGENTS.md:

1. **Brain-agent loop** (Section 2): read before responding, write after learning
2. **Entity detection** (Section 3): spawn on every message, capture people/companies/ideas
3. **Source attribution** (Section 7): every fact needs `[Source: ...]` — see `skills/conventions/quality.md` for the canonical format
4. **Iron law back-linking** (Section 15.4): every mention links back to the entity page — see `skills/conventions/quality.md`

Tell the user: "The production agent guide is at docs/PBRAIN_SKILLPACK.md. It covers
the brain-agent loop, entity detection, enrichment, meeting ingestion, and cron
schedules. Read it when you're ready to go from 'search works' to 'the brain
maintains itself.'"

## Phase F: Health Check

Run `pbrain doctor --json` and report the results. Every check should be OK.
If any check fails, the doctor output tells you exactly what's wrong and how to fix it.

## Error Recovery

**If any pbrain command fails, run `pbrain doctor --json` first.** Report the full
output. It checks connection, pgvector, RLS, schema version, and embeddings.

| What You See | Why | Fix |
|---|---|---|
| Connection refused | Supabase project paused, IPv6, or wrong URL | Use Session pooler (port 6543), or supabase.com/dashboard > Restore |
| Password authentication failed | Wrong password | Project Settings > Database > Reset password |
| pgvector not available | Extension not enabled | Run `CREATE EXTENSION vector;` in SQL Editor |
| OpenAI key invalid | Expired or wrong key | platform.openai.com/api-keys > Create new |
| No pages found | Query before import | Import files into pbrain first |
| RLS not enabled | Security gap | Run `pbrain init` again (auto-enables RLS) |

## Phase G: Auto-Update Check (if not already configured)

If the user's install did NOT include setting up auto-update checks (e.g., they
used the manual install path or an older version of the OpenClaw/Hermes paste), offer it:

> "Would you like daily PBrain update checks? I'll let you know when there's a
> new version worth upgrading to — including new skills and schema recommendations.
> You'll always be asked before anything is installed."

If they agree:
1. Test: `pbrain check-update --json`
2. Register daily cron (see PBRAIN_SKILLPACK.md Section 17)

If already configured or user declines, skip.

## Phase H: Live Sync Setup (MUST ADD)

The brain repo is the source of truth. If sync doesn't run automatically, the
vector DB falls behind and pbrain returns stale answers. This phase is not optional.

Read `docs/PBRAIN_SKILLPACK.md` Section 18 for the full reference. Key points:

1. **Check the connection pooler first.** Sync uses transactions on every import.
   If `DATABASE_URL` uses Supabase's Transaction mode pooler, sync will throw
   `.begin() is not a function` and silently skip most pages. Verify the connection
   string uses Session mode (port 6543, Session mode) or direct (port 5432).

2. **Set up automatic sync.** Choose the approach that fits your environment:
   - **Cron** (recommended for agents): register a cron every 5-30 minutes:
     `pbrain sync --repo /data/brain && pbrain embed --stale`
   - **Watch mode**: `pbrain sync --watch --repo /data/brain` under a process
     manager. Pair with a cron fallback (watch exits after 5 consecutive failures).
   - **Webhook or git hook**: if available in your environment.

3. **Verify sync works.** Don't just check that the command ran. Check that it
   worked:
   - `pbrain stats` should show page count close to syncable file count in the repo.
   - If page count is way too low, the pooler bug is silently skipping pages.
   - Push a test change and confirm it appears in `pbrain search`.

4. **Chain sync + embed.** Always run both: `pbrain sync --repo <path> && pbrain
   embed --stale`. For small syncs, embeddings are generated inline. The `embed
   --stale` is a safety net for any stale chunks.

Tell the user: "Live sync is configured. The brain will stay current automatically.
I'll verify it's working in the next phase."

## Phase I: Full Verification

Run the full verification runbook to confirm the entire installation is working.

1. Read `docs/PBRAIN_VERIFY.md`
2. Execute each check in order
3. Report results to the user
4. Fix any failures before declaring setup complete

Every check in the runbook should pass. The most important one is check 4 (live
sync actually works): push a change, wait for sync, search for the corrected text.
"Sync ran" is not the same as "sync worked."

Tell the user: "I've verified the full PBrain installation. Here's the status of
each check: [list results]. Everything is working / [specific item] needs attention."

If already configured or user declines, skip.

## Schema State Tracking

After presenting the recommended directories (Phase C/E) and the user selects which
ones to create, write `~/.pbrain/update-state.json` recording:
- `schema_version_applied`: current pbrain version
- `skillpack_version_applied`: current pbrain version
- `schema_choices.adopted`: directories the user created
- `schema_choices.declined`: directories the user explicitly skipped
- `schema_choices.custom`: directories the user added that aren't in the recommended schema

This file enables future upgrades to suggest new schema additions without
re-suggesting things the user already declined.

## Anti-Patterns

- **Asking for the Supabase anon key.** PBrain connects directly to Postgres over the wire protocol, not through the REST API. Only the database connection string is needed.
- **Skipping live sync setup.** If sync doesn't run automatically, the vector DB falls behind and search returns stale answers. Phase H is not optional.
- **Declaring setup complete without verification.** "The command ran" is not the same as "it worked." Push a test change, wait for sync, search for the corrected text.
- **Using Transaction mode pooler.** Sync uses transactions on every import. Transaction mode pooler causes `.begin() is not a function` errors and silently skips pages. Always use Session mode (port 6543).
- **Importing without proving search.** The magical moment is the user seeing search find things grep couldn't. Don't skip it.

## Output Format

```
PBRAIN SETUP COMPLETE
=====================

Engine: [PGLite / Supabase Postgres]
Connection: [verified / pooler mode confirmed]
Pages imported: N
Embeddings: N/N (keyword search active, semantic improving)
Live sync: [configured / method]
Health check: all OK / [specific failures]
Verification: [PBRAIN_VERIFY.md results]

Next steps:
- Read docs/PBRAIN_SKILLPACK.md for production agent patterns
- [any pending items]
```

## Tools Used

- `pbrain init --non-interactive --url ...` -- create brain
- `pbrain import <dir> --no-embed [--workers N]` -- import files
- `pbrain search <query>` -- search brain
- `pbrain doctor --json` -- health check
- `pbrain check-update --json` -- check for updates
- `pbrain embed refresh` -- generate embeddings
- `pbrain embed --stale` -- backfill missing embeddings
- `pbrain sync --repo <path>` -- one-shot sync from brain repo
- `pbrain sync --watch --repo <path>` -- continuous sync polling
- `pbrain config get sync.last_run` -- check last sync timestamp
- `pbrain stats` -- page count + embed coverage
