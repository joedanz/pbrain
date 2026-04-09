# Setup GBrain

Set up GBrain from scratch. Target: working brain in under 5 minutes.

## Install (if not already installed)

```bash
bun add github:garrytan/gbrain
```

## How GBrain connects

GBrain connects directly to Postgres over the wire protocol. NOT through the
Supabase REST API. You need the **database connection string** (a `postgresql://` URI),
not the project URL or anon key. The password is embedded in the connection string.

Use the **Session pooler** connection string (port 6543), not the direct connection
(port 5432). The direct hostname resolves to IPv6 only, which many environments
can't reach.

**Do NOT ask for the Supabase anon key.** GBrain doesn't use it.

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

- `gbrain init --supabase` -- interactive wizard (prompts for connection string)
- `gbrain init --url <connection_string>` -- direct, no prompts
- `gbrain init --non-interactive --url <connection_string>` -- for scripts/agents
- `gbrain doctor --json` -- health check after init

There is no `--local`, `--sqlite`, or offline mode. GBrain requires Postgres + pgvector.

## Phase A: Supabase Setup (recommended)

Guide the user through creating a Supabase project:

1. "Go to https://supabase.com and sign up or log in."
2. "Click 'New Project' in the top left."
   - Name: `gbrain`
   - Region: pick the one closest to you
   - Database password: generate a strong one and save it
3. "Wait about 2 minutes for the project to initialize."
4. "Find the connection string: click the **gear icon** (Project Settings) in the
   left sidebar, then **Database**, scroll to **Connection string**, click the
   **URI** tab, change the dropdown from **Direct connection** to **Session pooler**
   (port 6543), and copy the full string."
5. Initialize gbrain:
   ```bash
   gbrain init --non-interactive --url "postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres"
   ```
6. Verify: `gbrain doctor --json`

**OpenClaw agent instructions:** Store the Supabase access token in your persistent
env as `SUPABASE_ACCESS_TOKEN`. gbrain doesn't store it, you need it for future
`gbrain doctor` runs. Generate at: https://supabase.com/dashboard/account/tokens

## Phase B: BYO Postgres (alternative)

If the user already has Postgres with pgvector:

1. Get the connection string from the user.
2. Run: `gbrain init --non-interactive --url "<connection_string>"`
3. Verify: `gbrain doctor --json`

If the connection fails with ECONNREFUSED and the URL contains `supabase.co`,
the user probably pasted the direct connection (IPv6 only). Guide them to the
Session pooler string instead (see Phase A step 4).

## Phase C: First Import

1. **Discover markdown repos.** Scan the environment for git repos with markdown content.

```bash
echo "=== GBrain Environment Discovery ==="
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
   nohup gbrain import <dir> --no-embed --workers 4 > /tmp/gbrain-import.log 2>&1 &
   ```
   Then check progress: `tail -1 /tmp/gbrain-import.log`

   For smaller imports, run directly:
   ```bash
   gbrain import <dir> --no-embed
   ```

3. **Prove search works.** Pick a semantic query based on what you imported:
   ```bash
   gbrain search "<topic from the imported data>"
   ```
   This is the magical moment: the user sees search finding things grep couldn't.

4. **Start embeddings.** Refresh stale embeddings (runs in background). Keyword
   search works NOW, semantic search improves as embeddings complete.

5. **Offer file migration.** If the repo has binary files (.raw/ directories with
   images, PDFs, audio):
   > "You have N binary files (X GB) in your brain repo. Want to move them to cloud
   > storage? Your git repo will drop from X GB to Y MB. All links keep working."

If no markdown repos are found, create a starter brain with a few template pages
(a person page, a company page, a concept page) from docs/GBRAIN_RECOMMENDED_SCHEMA.md.

## Phase D: Brain-First Lookup Protocol

Inject the brain-first lookup protocol into the project's AGENTS.md (or equivalent).
This replaces grep-based knowledge lookups with structured gbrain queries.

### BEFORE (grep) vs AFTER (gbrain)

| Task | Before (grep) | After (gbrain) |
|------|---------------|-----------------|
| Find a person | `grep -r "Pedro" brain/` | `gbrain search "Pedro"` |
| Understand a topic | `grep -rl "deal" brain/ \| head -5 && cat ...` | `gbrain query "what's the status of the deal"` |
| Read a known page | `cat brain/people/pedro.md` | `gbrain get people/pedro` |
| Find connections | `grep -rl "Brex" brain/ \| xargs grep "Pedro"` | `gbrain query "Pedro Brex relationship"` |

### Lookup sequence (MANDATORY for every entity question)

1. `gbrain search "name"` -- keyword match, fast, works without embeddings
2. `gbrain query "what do we know about name"` -- hybrid search, needs embeddings
3. `gbrain get <slug>` -- direct page read when you know the slug from steps 1-2
4. `grep` fallback -- only if gbrain returns zero results AND the file may exist outside the indexed brain

Stop at the first step that gives you what you need. Most lookups resolve at step 1.

### Sync-after-write rule

After creating or updating any brain page in the repo, sync immediately so the
index stays current:

```bash
gbrain sync --no-pull --no-embed
```

This indexes new/changed files without pulling from git or regenerating embeddings.
Embeddings can be refreshed later in batch (`gbrain embed --stale`).

### gbrain vs memory_search

| Layer | What it stores | When to use |
|-------|---------------|-------------|
| **gbrain** | World knowledge: people, companies, deals, meetings, concepts, media | "Who is Pedro?", "What happened at the board meeting?" |
| **memory_search** | Agent operational state: preferences, decisions, session context | "How does the user like formatting?", "What did we decide about X?" |

Both should be checked. gbrain for facts about the world. memory_search for how
the agent should behave.

## Phase E: Health Check

Run `gbrain doctor --json` and report the results. Every check should be OK.
If any check fails, the doctor output tells you exactly what's wrong and how to fix it.

## Error Recovery

**If any gbrain command fails, run `gbrain doctor --json` first.** Report the full
output. It checks connection, pgvector, RLS, schema version, and embeddings.

| What You See | Why | Fix |
|---|---|---|
| Connection refused | Supabase project paused, IPv6, or wrong URL | Use Session pooler (port 6543), or supabase.com/dashboard > Restore |
| Password authentication failed | Wrong password | Project Settings > Database > Reset password |
| pgvector not available | Extension not enabled | Run `CREATE EXTENSION vector;` in SQL Editor |
| OpenAI key invalid | Expired or wrong key | platform.openai.com/api-keys > Create new |
| No pages found | Query before import | Import files into gbrain first |
| RLS not enabled | Security gap | Run `gbrain init` again (auto-enables RLS) |

## Tools Used

- `gbrain init --non-interactive --url ...` -- create brain
- `gbrain import <dir> --no-embed [--workers N]` -- import files
- `gbrain search <query>` -- search brain
- `gbrain doctor --json` -- health check
- `gbrain embed refresh` -- generate embeddings
