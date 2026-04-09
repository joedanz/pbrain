# GBrain

The memex Vannevar Bush imagined, built for people who think for a living.

**GBrain is a knowledge brain for [OpenClaw](https://openclaw.com) agents.** It gives your agent a searchable, indexed memory over your markdown repos using Postgres + pgvector + hybrid search. Works with any OpenClaw agent. Paste the install instructions into your agent, and it handles the rest.

### What one brain looks like

Here's what one person built with gbrain and a single AI agent over six months:

- **10,000+ markdown files** indexed and searchable
- **3,000+ people** with compiled dossiers and relationship history
- **13 years of calendar data** (21,000+ events)
- **5,800+ Apple Notes** going back to 2009
- **280+ meeting transcripts** with AI analysis
- **300+ captured original ideas** organized by thesis
- **500+ media pages** (video transcripts, books, articles)
- Company profiles, food guides, travel logs

All in Postgres. All searchable by meaning, not just keywords. All maintained by an agent that runs while you sleep.

### Ask it anything

> "Who should I invite to dinner who knows both Pedro and Diana?"
> — cross-references the social graph across 3,000+ people pages

> "What have I said about the relationship between shame and founder performance?"
> — searches YOUR thinking, not the internet

> "What changed with the Series A since Tuesday?"
> — diffs timeline entries across deal and company pages

> "Prep me for my meeting with Jordan in 30 minutes"
> — pulls dossier, shared history, recent activity, open threads

Every meeting, email, tweet, and person enrichment flows back into the brain. Six months from now you know more than any human could retain. Not because you're taking notes — because the system never forgets.

Your markdown repo is the source of truth. GBrain makes it searchable. Your AI agent makes it live.

## Why this exists

Andrej Karpathy's [LLM OS / Knowledge LLM](https://x.com/karpathy/status/1723140519554105733) post sketched the vision: a personal wiki maintained by AI agents, where every page is a living document that gets smarter as the agent processes more information. I started building exactly that. Markdown files in a git repo, one page per entity, compiled truth on top, append-only timeline on the bottom.

It worked. Until I hit thousands of files.

At 500 files, `grep` is fine. At 3,000 people pages, 5,800 Apple Notes, and 13 years of calendar data, `grep` falls apart. You need real search: keyword for exact names, vector for semantic meaning, and something that fuses both. You need an index that updates incrementally when one file changes, not a full directory walk. You need your agent to find "everyone who was at the board dinner last March" in milliseconds, not 30 seconds of grepping.

That's what GBrain is. The search and sync layer I had to build once the brain outgrew `grep`.

GBrain fixes this with hybrid search that combines keyword and vector approaches, plus a knowledge model that treats every page like an intelligence assessment: compiled truth on top (your current best understanding, rewritten when evidence changes), append-only timeline on the bottom (the evidence trail that never gets edited).

AI agents maintain the brain. You ingest a document and the agent updates every entity mentioned, creates cross-reference links, and appends timeline entries. MCP clients query it. The intelligence lives in fat markdown skills, not application code.

## The Compounding Thesis

Most tools help you find things. GBrain makes you smarter over time.

The core loop:

```
Signal arrives (meeting, email, tweet, link)
  → Agent detects entities (people, companies, ideas)
  → READ: check the brain first (gbrain search, gbrain get)
  → Respond with full context
  → WRITE: update brain pages with new information
  → Sync: gbrain indexes changes for next query
```

Every cycle through this loop adds knowledge. The agent enriches a person page after a meeting. Next time that person comes up, the agent already has context — their role, your history, what they care about, what you discussed last time. You never start from zero.

An agent without this loop answers from stale context. An agent with it gets smarter every conversation. The difference compounds daily.

Never do anything twice. If you look someone up once, that lookup lives in the brain forever. If a pattern emerges across three meetings, the agent captures it. If you generate an original idea in conversation, it goes to `originals/` — your searchable intellectual archive.

## Architecture

```
┌──────────────────┐    ┌───────────────┐    ┌──────────────────┐
│   Brain Repo     │    │    GBrain     │    │    AI Agent      │
│   (git)          │    │  (retrieval)  │    │  (read/write)    │
│                  │    │               │    │                  │
│  markdown files  │───>│  Postgres +   │<──>│  skills define   │
│  = source of     │    │  pgvector     │    │  HOW to use the  │
│    truth         │    │               │    │  brain           │
│                  │<───│  hybrid       │    │                  │
│  human can       │    │  search       │    │  entity detect   │
│  always read     │    │  (vector +    │    │  enrich          │
│  & edit          │    │   keyword +   │    │  ingest          │
│                  │    │   RRF)        │    │  brief           │
└──────────────────┘    └───────────────┘    └──────────────────┘
```

The repo is the system of record. GBrain is the retrieval layer. The agent reads and writes through both. Human always wins — you can edit any markdown file directly and `gbrain sync` picks up the changes.

## What a Production Agent Looks Like

The numbers above aren't theoretical. They come from a real deployment documented in [GBRAIN_SKILLPACK.md](docs/GBRAIN_SKILLPACK.md) — a reference architecture for how a production AI agent uses gbrain as its knowledge backbone.

What's in the skillpack:

- **The brain-agent loop** — the read-write cycle that makes knowledge compound
- **Entity detection** — spawn on every message, capture people/companies/original ideas
- **Enrichment pipeline** — 7-step protocol with tiered API spend
- **Meeting ingestion** — transcript to brain pages with entity propagation
- **Source attribution** — every fact traceable to where it came from
- **Reference cron schedule** — 20+ recurring jobs that keep the brain alive

It's a pattern book, not a tutorial. "Here's what works, here's why."

## How gbrain fits with OpenClaw

GBrain is world knowledge — people, companies, deals, meetings, concepts, your original thinking. It's the long-term memory of what you know about the world.

[OpenClaw](https://openclaw.com) agent memory (`memory_search`) is operational state — preferences, decisions, session context, how the agent should behave.

They're complementary:

| Layer | What it stores | How to query |
|-------|---------------|-------------|
| **gbrain** | People, companies, meetings, ideas, media | `gbrain search`, `gbrain query`, `gbrain get` |
| **Agent memory** | Preferences, decisions, operational config | `memory_search` |
| **Session context** | Current conversation | (automatic) |

All three should be checked. GBrain for facts about the world. Memory for agent config. Session for immediate context. Install via `openclaw skills install gbrain`.

## Try it: your files, searchable in 90 seconds

GBrain doesn't ship with demo data. It finds YOUR markdown and makes it searchable.

**Act 1: Discovery.** GBrain scans your machine for markdown repos.

```
=== GBrain Environment Discovery ===

  ~/git/brain (2.3GB, 342 .md files, 87 binary files)
    Type: Plain markdown (ready for import)

  ~/Documents/obsidian-vault (180MB, 1,203 .md files, 0 binary files)
    Type: Obsidian vault (wikilink conversion available)

=== Discovery Complete ===
```

**Act 2: Import.** Your files move from the repo into Supabase.

```bash
gbrain import ~/git/brain/
# Imported 342 files into Supabase (1,847 chunks). Embedding in background...

gbrain stats
# Pages: 342, Chunks: 1,847, Embedded: 0 (embedding...), Links: 0
```

**Act 3: Search.** The agent picks a query from your actual content.

```bash
# The agent reads your corpus and picks a relevant query
gbrain query "what do we know about competitive dynamics?"
# 3 results, scored by hybrid search (vector + keyword + RRF fusion)

# 30 seconds later, embeddings finish:
gbrain stats
# Pages: 342, Chunks: 1,847, Embedded: 1,847, Links: 0

# Now semantic search is live too
gbrain query "what are our biggest risks right now?"
# Finds pages about moats, board prep, and strategy -- by meaning, not keywords
```

Your file count will be different. Your queries will be different. The agent picks them based on what it imported. That's the point: this is YOUR brain, not a demo.

**The compounding effect.** Search for Pedro. The agent pulls his page, his relationship history, his company. Next time Brex comes up in conversation, the agent already knows Pedro co-founded it, what you discussed last, and what's on your open threads. You didn't do anything — the brain already had it.

## Install

### Prerequisites

GBrain needs three things to run:

| Dependency | What it's for | How to get it |
|------------|--------------|---------------|
| **Supabase account** | Postgres + pgvector database | [supabase.com](https://supabase.com) (Pro tier, $25/mo for 8GB) |
| **OpenAI API key** | Embeddings (text-embedding-3-large) | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| **Anthropic API key** | Multi-query expansion + LLM chunking (Haiku) | [console.anthropic.com](https://console.anthropic.com) |

Set the API keys as environment variables:

```bash
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
```

The Supabase connection URL is configured during `gbrain init`. The OpenAI and Anthropic SDKs read their keys from the environment automatically.

Without an OpenAI key, search still works (keyword only, no vector search). Without an Anthropic key, search still works (no multi-query expansion, no LLM chunking).

### With OpenClaw (recommended)

To install, paste this into OpenClaw and we'll work with you to do the rest:

```
Set up gbrain (https://github.com/garrytan/gbrain) as my knowledge brain.
1. Make sure bun is installed (curl -fsSL https://bun.sh/install | bash), then run: bun add github:garrytan/gbrain
2. Run: gbrain init --supabase (follow the wizard to connect my Supabase database)
3. Scan ~/git/ and ~/Documents/ for markdown repos, pick the best one, and run: gbrain import <path> --no-embed
4. Run a query against the imported data to prove search works
5. Read https://github.com/garrytan/gbrain/blob/master/docs/GBRAIN_RECOMMENDED_SCHEMA.md and offer to restructure my knowledge base
```

OpenClaw will install gbrain, walk through Supabase setup, discover your markdown files, import them, and prove search works with a query from your data.

After setup, you talk to your brain through OpenClaw:

```
Search the brain for everything we know about [topic]
Ingest my meeting notes from today
Give me a briefing for my meetings tomorrow
How many pages are in the brain now?
```

GBrain keeps your brain current. After setup, `gbrain sync --watch` polls your git repo and imports only what changed. Binary files (images, PDFs, audio) can be moved to cloud storage with `gbrain files mirror` to slim down your git repo.

> **Supabase settings:** GBrain connects directly to Postgres (not the REST API).
> You need the **Session pooler connection string** (port 6543), not the project URL
> or anon key. Find it: Project Settings > Database > Connection string > URI tab >
> change dropdown to "Session pooler".

### Standalone CLI

```bash
bun add -g github:garrytan/gbrain
```

### As a library

```bash
bun add github:garrytan/gbrain
```

```typescript
import { PostgresEngine } from 'gbrain';
```

All paths require a Postgres database with pgvector. Supabase Pro ($25/mo) is the recommended zero-ops option.

## Upgrade

Upgrade depends on how you installed:

```bash
# Installed via bun (standalone or library)
bun update gbrain

# Installed via ClawHub
clawhub update gbrain

# Compiled binary
# Download the latest from https://github.com/garrytan/gbrain/releases
```

After upgrading, run `gbrain init` again to apply any schema migrations (idempotent, safe to re-run).

## Setup

After installing via CLI or library path, run the setup wizard:

```bash
# Guided wizard: auto-provisions Supabase or accepts a connection URL
gbrain init --supabase

# Or connect to any Postgres with pgvector
gbrain init --url postgresql://user:pass@host:5432/dbname
```

The init wizard:
1. Checks for Supabase CLI, offers auto-provisioning
2. Falls back to manual connection URL if CLI isn't available
3. Runs the full schema migration (tables, indexes, triggers, extensions)
4. Verifies the connection and confirms the database is ready for import

Config is saved to `~/.gbrain/config.json` with 0600 permissions.

OpenClaw users skip this step. The orchestrator runs the wizard for you during install.

## First import

```bash
# Import your markdown wiki (auto-chunks and auto-embeds)
gbrain import /path/to/brain/

# Skip embedding if you want to import fast and embed later
gbrain import /path/to/brain/ --no-embed

# Backfill embeddings for pages that don't have them
gbrain embed --stale
```

Import is idempotent. Re-running it skips unchanged files (compared by SHA-256 content hash). Progress bar shows status. ~30s for text import of 7,000 files, ~10-15 min for embedding.

## The knowledge model

Every page in the brain follows the compiled truth + timeline pattern:

```markdown
---
type: concept
title: Do Things That Don't Scale
tags: [startups, growth, pg-essay]
---

Paul Graham's argument that startups should do unscalable things early on.
The most common: recruiting users manually, one at a time. Airbnb went
door to door in New York photographing apartments. Stripe manually
installed their payment integration for early users.

The key insight: the unscalable effort teaches you what users actually
want, which you can't learn any other way.

---

- 2013-07-01: Published on paulgraham.com
- 2024-11-15: Referenced in batch W25 kickoff talk
- 2025-02-20: Cited in discussion about AI agent onboarding strategies
```

Above the `---` separator: **compiled truth**. Your current best understanding. Gets rewritten when new evidence changes the picture. Below: **timeline**. Append-only evidence trail. Never edited, only added to.

The compiled truth is the answer. The timeline is the proof.

## How search works

```
Query: "when should you ignore conventional wisdom?"
         |
    Multi-query expansion (Claude Haiku)
    "contrarian thinking startups", "going against the crowd"
         |
    +----+----+
    |         |
  Vector    Keyword
  (HNSW     (tsvector +
  cosine)    ts_rank)
    |         |
    +----+----+
         |
    RRF Fusion: score = sum(1/(60 + rank))
         |
    4-Layer Dedup
    1. Best chunk per page
    2. Cosine similarity > 0.85
    3. Type diversity (60% cap)
    4. Per-page chunk cap
         |
    Stale alerts (compiled truth older than latest timeline)
         |
    Results
```

Keyword search alone misses conceptual matches. "Ignore conventional wisdom" won't find an essay titled "The Bus Ticket Theory of Genius" even though it's exactly about that. Vector search alone misses exact phrases when the embedding is diluted by surrounding text. RRF fusion gets both right. Multi-query expansion catches phrasings you didn't think of.

## Database schema

10 tables in Postgres + pgvector:

```
pages                    The core content table
  slug (UNIQUE)          e.g. "concepts/do-things-that-dont-scale"
  type                   person, company, deal, yc, civic, project, concept, source, media
  title, compiled_truth, timeline
  frontmatter (JSONB)    Arbitrary metadata
  search_vector          Trigger-based tsvector (title + compiled_truth + timeline + timeline_entries)
  content_hash           SHA-256 for import idempotency

content_chunks           Chunked content with embeddings
  page_id (FK)           Links to pages
  chunk_text             The chunk content
  chunk_source           'compiled_truth' or 'timeline'
  embedding (vector)     1536-dim from text-embedding-3-large
  HNSW index             Cosine similarity search

links                    Cross-references between pages
  from_page_id, to_page_id
  link_type              knows, invested_in, works_at, founded, references, etc.

tags                     page_id + tag (many-to-many)

timeline_entries         Structured timeline events
  page_id, date, source, summary, detail (markdown)

page_versions            Snapshot history for compiled_truth
  compiled_truth, frontmatter, snapshot_at

raw_data                 Sidecar JSON from external APIs
  page_id, source, data (JSONB)

files                    Binary attachments in Supabase Storage
  page_slug (FK)         Links to pages (ON UPDATE CASCADE)
  storage_path, content_hash, mime_type, metadata (JSONB)

ingest_log               Audit trail of import/ingest operations

config                   Brain-level settings (embedding model, chunk strategy, sync state)
```

Indexes: B-tree on slug/type, GIN on frontmatter/search_vector, HNSW on embeddings, pg_trgm on title for fuzzy slug resolution.

## Chunking

Three strategies, dispatched by content type:

**Recursive** (timeline, bulk import): 5-level delimiter hierarchy (paragraphs, lines, sentences, clauses, words). 300-word chunks with 50-word sentence-aware overlap. Fast, predictable, lossless.

**Semantic** (compiled truth): Embeds each sentence, computes adjacent cosine similarities, applies Savitzky-Golay smoothing to find topic boundaries. Falls back to recursive on failure. Best quality for intelligence assessments.

**LLM-guided** (high-value content, on request): Pre-splits into 128-word candidates, asks Claude Haiku to identify topic shifts in sliding windows. 3 retries per window. Most expensive, best results.

## Commands

```
SETUP
  gbrain init [--supabase|--url <conn>]     Create brain (guided wizard)
  gbrain upgrade                            Self-update

PAGES
  gbrain get <slug>                         Read a page (supports fuzzy slug matching)
  gbrain put <slug> [< file.md]             Write/update a page (auto-versions)
  gbrain delete <slug>                      Delete a page
  gbrain list [--type T] [--tag T] [-n N]   List pages with filters

SEARCH
  gbrain search <query>                     Keyword search (tsvector)
  gbrain query <question>                   Hybrid search (vector + keyword + RRF + expansion)

IMPORT/EXPORT
  gbrain import <dir> [--no-embed]          Import markdown directory (idempotent)
  gbrain sync [--repo <path>] [flags]       Git-to-brain incremental sync
  gbrain export [--dir ./out/]              Export to markdown (round-trip)

FILES
  gbrain files list [slug]                  List stored files
  gbrain files upload <file> --page <slug>  Upload file to storage
  gbrain files sync <dir>                   Bulk upload directory
  gbrain files verify                       Verify all uploads

EMBEDDINGS
  gbrain embed [<slug>|--all|--stale]       Generate/refresh embeddings

LINKS + GRAPH
  gbrain link <from> <to> [--type T]        Create typed link
  gbrain unlink <from> <to>                 Remove link
  gbrain backlinks <slug>                   Incoming links
  gbrain graph <slug> [--depth N]           Traverse link graph (recursive CTE, default depth 5)

TAGS
  gbrain tags <slug>                        List tags
  gbrain tag <slug> <tag>                   Add tag
  gbrain untag <slug> <tag>                 Remove tag

TIMELINE
  gbrain timeline [<slug>]                  View timeline entries
  gbrain timeline-add <slug> <date> <text>  Add timeline entry

ADMIN
  gbrain doctor [--json]                    Health checks (pgvector, RLS, schema, embeddings)
  gbrain stats                              Brain statistics
  gbrain health                             Health dashboard (embed coverage, stale, orphans)
  gbrain history <slug>                     Page version history
  gbrain revert <slug> <version-id>         Revert to previous version
  gbrain config [get|set] <key> [value]     Brain config
  gbrain serve                              MCP server (stdio)
  gbrain call <tool> '<json>'               Raw tool invocation
  gbrain --tools-json                       Tool discovery (JSON)
```

## Using as a library

GBrain is library-first. The CLI and MCP server are thin wrappers over the engine.

```typescript
import { PostgresEngine } from 'gbrain';

const engine = new PostgresEngine();
await engine.connect({ database_url: process.env.DATABASE_URL });
await engine.initSchema();

// Write a page
await engine.putPage('concepts/superlinear-returns', {
  type: 'concept',
  title: 'Superlinear Returns',
  compiled_truth: 'Paul Graham argues that returns in many fields are superlinear...',
  timeline: '- 2023-10-01: Published on paulgraham.com',
});

// Hybrid search
const results = await engine.searchKeyword('startup growth');

// Typed links
await engine.addLink('concepts/superlinear-returns', 'concepts/do-things-that-dont-scale', '', 'references');

// Graph traversal
const graph = await engine.traverseGraph('concepts/superlinear-returns', 3);

// Health check
const health = await engine.getHealth();
// { page_count: 10, embed_coverage: 1.0, stale_pages: 0, orphan_pages: 10 }
```

The `BrainEngine` interface is pluggable. See `docs/ENGINES.md` for how to add backends.

## MCP server

Add to your Claude Code or Cursor MCP config:

```json
{
  "mcpServers": {
    "gbrain": {
      "command": "gbrain",
      "args": ["serve"]
    }
  }
}
```

30 tools generated from the contract-first `operations.ts`: page CRUD, search, tags, links, timeline, admin, sync, raw data, file management, and more.

Every tool is generated from the same operation definitions as the CLI. Parity tests verify structural identity.

## Skills

Fat markdown files that tell AI agents HOW to use gbrain. No skill logic in the binary.

| Skill | What it does |
|-------|-------------|
| **ingest** | Ingest meetings, docs, articles. Updates compiled truth (rewrite, not append), appends timeline, creates cross-reference links across all mentioned entities. |
| **query** | 3-layer search (keyword + vector + structured) with synthesis and citations. Says "the brain doesn't have info on X" rather than hallucinating. |
| **maintain** | Periodic health: find contradictions, stale compiled truth, orphan pages, dead links, tag inconsistency, missing embeddings, overdue threads. |
| **enrich** | Enrich pages from external APIs. Raw data stored separately, distilled highlights go to compiled truth. |
| **briefing** | Daily briefing: today's meetings with participant context, active deals with deadlines, time-sensitive threads, recent changes. |
| **migrate** | Universal migration from Obsidian (wikilinks to gbrain links), Notion (stripped UUIDs), Logseq (block refs), plain markdown, CSV, JSON, Roam. |
| **setup** | Set up GBrain from scratch: auto-provision Supabase via CLI, AGENTS.md injection, import, sync. Target TTHW < 2 min. |

## Engine Architecture

```
CLI / MCP Server
     (thin wrappers, identical operations)
              |
      BrainEngine interface
       (pluggable backend)
              |
     +--------+--------+
     |                  |
PostgresEngine     SQLiteEngine
  (ships v0)       (designed, community PRs welcome)
     |
Supabase Pro ($25/mo)
  Postgres + pgvector + pg_trgm
  connection pooling via Supavisor
```

Embedding, chunking, and search fusion are engine-agnostic. Only raw keyword search (`searchKeyword`) and raw vector search (`searchVector`) are engine-specific. RRF fusion, multi-query expansion, and 4-layer dedup run above the engine on `SearchResult[]` arrays.

## Storage estimates

For a brain with ~7,500 pages:

| Component | Size |
|-----------|------|
| Page text (compiled_truth + timeline) | ~150MB |
| JSONB frontmatter + indexes | ~70MB |
| Content chunks (~22K, text) | ~80MB |
| Embeddings (22K x 1536 floats) | ~134MB |
| HNSW index overhead | ~270MB |
| Links, tags, timeline, versions | ~50MB |
| **Total** | **~750MB** |

Supabase free tier (500MB) won't fit a large brain. Supabase Pro ($25/mo, 8GB) is the starting point.

Initial embedding cost: ~$4-5 for 7,500 pages via OpenAI text-embedding-3-large.

## Docs

- [GBRAIN_SKILLPACK.md](docs/GBRAIN_SKILLPACK.md) -- Reference architecture for production agents: brain-agent loop, entity detection, enrichment pipeline, meeting ingestion, cron schedule
- [GBRAIN_RECOMMENDED_SCHEMA.md](docs/GBRAIN_RECOMMENDED_SCHEMA.md) -- The recommended brain schema: MECE directories, compiled truth + timeline, enrichment pipelines, resolver decision tree
- [GBRAIN_V0.md](docs/GBRAIN_V0.md) -- Full product spec, all architecture decisions, every option considered
- [ENGINES.md](docs/ENGINES.md) -- Pluggable engine interface, capability matrix, how to add backends
- [SQLITE_ENGINE.md](docs/SQLITE_ENGINE.md) -- Complete SQLite engine plan with schema, FTS5, vector search options

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Run `bun test` for unit tests. For E2E tests
against real Postgres+pgvector: `docker compose -f docker-compose.test.yml up -d` then
`DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test bun run test:e2e`.

Welcome PRs for:

- SQLite engine implementation
- New enrichment API integrations
- Performance optimizations
- Docker Compose for self-hosted Postgres

## License

MIT
