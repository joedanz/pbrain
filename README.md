# PBrain

> **Project Brain** — a personal knowledge brain for coding projects, software libraries, AI tools, git repos, code patterns, papers/talks/books, and tech companies.
>
> Forked from [**GBrain**](https://github.com/garrytan/gbrain) by [Garry Tan](https://github.com/garrytan), President & CEO of Y Combinator. See [NOTICE](NOTICE) and [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md) for the full story and credits. The core engine — contract-first operations, pluggable PGLite/Postgres engines, hybrid RAG search with RRF, compiled-truth + timeline pages, the skill resolver, the autopilot daemon, the MCP server — is entirely Garry's work. PBrain adapts it for a senior software engineer instead of a venture investor.

Your AI agent is smart but forgetful. PBrain gives it a brain — one that remembers which version of Vercel AI SDK you're on, what Convex mutation pattern you settled on last month, how Claude Opus 4.7 compares to GPT-5 for your specific task, and which library you bookmarked after that Anthropic cookbook talk. The agent ingests meetings, emails, tweets, voice calls, and original ideas while you sleep. It enriches every library, tool, company, and person it encounters. It fixes its own citations and consolidates memory overnight. You wake up and the brain is smarter than when you went to bed.

PBrain is GBrain's patterns, retargeted at software engineering knowledge. 25 skills. Install in 30 minutes. Your agent does the work.

> **~30 minutes to a fully working brain.** Database ready in 2 seconds (PGLite, no server). You just answer questions about API keys.

## Install

Before you start: **pick your brain folder.** PBrain reads and writes markdown into a folder on disk. If you already have an Obsidian vault, use it. If not, create one now — open Obsidian, "Create new vault", and pick a path like `~/ObsidianVault/MyBrain`. Any writable folder works (Logseq, plain markdown, a cloud-synced mount), but an Obsidian vault gets you the graph view for free.

### One-line install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/joedanz/pbrain/master/scripts/install.sh | bash
```

Installs Bun if needed, clones the repo to `~/.pbrain-repo`, runs `bun install && bun link`, asks for your brain folder, runs `pbrain init`, and (optionally) registers skills with Claude Code / Cursor / Windsurf. Idempotent — re-run to upgrade.

Want to audit first? `curl -fsSL https://raw.githubusercontent.com/joedanz/pbrain/master/scripts/install.sh -o install.sh && less install.sh && bash install.sh`.

Non-interactive / scripted:

```bash
curl -fsSL https://raw.githubusercontent.com/joedanz/pbrain/master/scripts/install.sh \
  | bash -s -- --brain-path ~/ObsidianVault/MyBrain --yes
```

See [`docs/install.md`](docs/install.md) for flags, env vars, and troubleshooting. macOS and Linux only; Windows users run this inside WSL.

### Manual install

```bash
# 1. Install Bun (once per machine)
curl -fsSL https://bun.sh/install | bash

# 2. Clone, install, link
git clone https://github.com/joedanz/pbrain.git && cd pbrain && bun install && bun link

# 3. Point PBrain at your brain folder
pbrain init --brain-path ~/ObsidianVault/MyBrain   # absolute path to your vault
pbrain import ~/ObsidianVault/MyBrain              # index existing notes
pbrain query "what themes show up across my notes?"
```

`--brain-path` is saved to `~/.pbrain/config.json` as `brain_path`. Every skill and command resolves the vault from here. Override per-session with `PBRAIN_BRAIN_PATH=/path pbrain …`. Re-running `pbrain init` later reuses the saved path unless you pass `--brain-path` again.

### Upgrading

Re-run the one-line installer (idempotent — detects the existing clone and runs `git pull && bun install`), or do it by hand:

```bash
cd ~/.pbrain-repo && git pull && bun install
```

### On an agent platform

PBrain is designed to be installed and operated by an AI agent. If you don't have one running yet:

- **[OpenClaw](https://openclaw.ai)** ... Deploy [AlphaClaw on Render](https://render.com/deploy?repo=https://github.com/chrysb/alphaclaw) (one click, 8GB+ RAM)
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** ... Deploy on [Railway](https://github.com/praveen-ks-2001/hermes-agent-template) (one click)

Paste this into your agent:

```
Retrieve and follow the instructions at:
https://raw.githubusercontent.com/joedanz/pbrain/master/INSTALL_FOR_AGENTS.md
```

The agent will ask for your Obsidian vault path, clone the repo, install PBrain, set up the brain, load 25 skills, and configure recurring jobs. You answer a few questions about API keys. ~30 minutes.

```
3 results (hybrid search, 0.12s):

1. concepts/do-things-that-dont-scale (score: 0.94)
   PG's argument that unscalable effort teaches you what users want.
   [Source: paulgraham.com, 2013-07-01]

2. originals/founder-mode-observation (score: 0.87)
   Deep involvement isn't micromanagement if it expands the team's thinking.

3. concepts/build-something-people-want (score: 0.81)
   The YC motto. Connected to 12 other brain pages.
```

### MCP server (Claude Code, Cursor, Windsurf)

PBrain exposes 30+ MCP tools via stdio:

```json
{
  "mcpServers": {
    "pbrain": { "command": "pbrain", "args": ["serve"] }
  }
}
```

Add to `~/.claude/server.json` (Claude Code), Settings > MCP Servers (Cursor), or your client's MCP config.

Then register the 25 skills in your client's skill discovery:

```bash
pbrain install-skills
```

Symlinks every PBrain skill into `~/.claude/skills/`, `~/.cursor/skills/`, and
`~/.windsurf/skills/` (whichever of those dirs exist). Idempotent — re-run after
`pbrain upgrade` to pick up new skills. Never silently overwrites skills owned
by other plugins — pass `--force` to replace conflicts. See `pbrain install-skills
--help` for scope (`--project` for per-repo), client filtering (`--client claude`),
and `status`/`uninstall` subcommands.

### Remote MCP (Claude Desktop, Cowork, Perplexity)

```bash
ngrok http 8787 --url your-brain.ngrok.app
bun run src/commands/auth.ts create "claude-desktop"
claude mcp add pbrain -t http https://your-brain.ngrok.app/mcp -H "Authorization: Bearer TOKEN"
```

Per-client guides: [`docs/mcp/`](docs/mcp/DEPLOY.md). ChatGPT requires OAuth 2.1 (not yet implemented).

## The 25 Skills

PBrain ships 25 skills organized by `skills/RESOLVER.md`. The resolver tells your agent which skill to read for any task.

[Skill files are code.](https://x.com/garrytan/status/2042925773300908103) They're the most powerful way to get knowledge work done. A skill file is a fat markdown document that encodes an entire workflow: when to fire, what to check, how to chain with other skills, what quality bar to enforce. The agent reads the skill and executes it. Skills can also call deterministic TypeScript code bundled in PBrain (search, import, embed, sync) for the parts that shouldn't be left to LLM judgment. [Thin harness, fat skills](docs/ethos/THIN_HARNESS_FAT_SKILLS.md): the intelligence lives in the skills, not the runtime.

### Always-on

| Skill | What it does |
|-------|-------------|
| **signal-detector** | Fires on every message. Spawns a cheap model in parallel to capture original thinking and entity mentions. The brain compounds on autopilot. |
| **brain-ops** | Brain-first lookup before any external API. The read-enrich-write loop that makes every response smarter. |

### Content ingestion

| Skill | What it does |
|-------|-------------|
| **ingest** | Thin router. Detects input type and delegates to the right ingestion skill. |
| **idea-ingest** | Links, articles, tweets become brain pages with analysis, author people pages, and cross-linking. |
| **media-ingest** | Video, audio, PDF, books, screenshots, GitHub repos. Transcripts, entity extraction, backlink propagation. |
| **meeting-ingestion** | Transcripts become brain pages. Every attendee gets enriched. Every company gets a timeline entry. |

### Brain operations

| Skill | What it does |
|-------|-------------|
| **enrich** | Tiered enrichment (Tier 1/2/3). Creates and updates person/company pages with compiled truth and timelines. |
| **query** | 3-layer search with synthesis and citations. Says "the brain doesn't have info on X" instead of hallucinating. |
| **maintain** | Periodic health: stale pages, orphans, dead links, citation audit, back-link enforcement, tag consistency. |
| **citation-fixer** | Scans pages for missing or malformed citations. Fixes format to match the standard. |
| **repo-architecture** | Where new brain files go. Decision protocol: primary subject determines directory, not format. |
| **publish** | Share brain pages as password-protected HTML. Zero LLM calls. |
| **data-research** | Structured data research with parameterized YAML recipes. Extract investor updates, expenses, company metrics from email. |

### Operational

| Skill | What it does |
|-------|-------------|
| **daily-task-manager** | Task lifecycle with priority levels (P0-P3). Stored as searchable brain pages. |
| **daily-task-prep** | Morning prep: calendar lookahead with brain context per attendee, open threads, task review. |
| **cron-scheduler** | Schedule staggering (5-min offsets), quiet hours (timezone-aware with wake-up override), idempotency. |
| **reports** | Timestamped reports with keyword routing. "What's the latest briefing?" finds it instantly. |
| **cross-modal-review** | Quality gate via second model. Refusal routing: if one model refuses, silently switch. |
| **webhook-transforms** | External events (SMS, meetings, social mentions) converted into brain pages with entity extraction. |
| **testing** | Validates every skill has SKILL.md with frontmatter, manifest coverage, resolver coverage. |
| **skill-creator** | Create new skills following the conformance standard. MECE check against existing skills. |

### Identity and setup

| Skill | What it does |
|-------|-------------|
| **soul-audit** | 6-phase interview generating SOUL.md (agent identity), USER.md (user profile), ACCESS_POLICY.md (4-tier privacy), HEARTBEAT.md (operational cadence). |
| **setup** | Auto-provision PGLite or Supabase. First import. GStack detection. |
| **migrate** | Universal migration from Obsidian, Notion, Logseq, markdown, CSV, JSON, Roam. |
| **briefing** | Daily briefing with meeting context, active deals, and citation tracking. |

### Conventions

Cross-cutting rules in `skills/conventions/`:
- **quality.md** ... citations, back-links, notability gate, source attribution
- **brain-first.md** ... 5-step lookup before any external API call
- **model-routing.md** ... which model for which task
- **test-before-bulk.md** ... test 3-5 items before any batch operation
- **cross-modal.yaml** ... review pairs and refusal routing chain

## How It Works

```
Signal arrives (meeting, email, tweet, link)
  -> Signal detector captures ideas + entities (parallel, never blocks)
  -> Brain-ops: check the brain first (pbrain search, pbrain get)
  -> Respond with full context
  -> Write: update brain pages with new information + citations
  -> Sync: pbrain indexes changes for next query
```

Every cycle adds knowledge. The agent enriches a person page after a meeting. Next time that person comes up, the agent already has context. The difference compounds daily.

The system gets smarter on its own. Entity enrichment auto-escalates: a person mentioned once gets a stub page (Tier 3). After 3 mentions across different sources, they get web + social enrichment (Tier 2). After a meeting or 8+ mentions, full pipeline (Tier 1). The brain learns who matters without being told. Deterministic classifiers improve over time via a fail-improve loop that logs every LLM fallback and generates better regex patterns from the failures. `pbrain doctor` shows the trajectory: "intent classifier: 87% deterministic, up from 40% in week 1."

> "Prep me for my meeting with Jordan in 30 minutes"
> ... pulls dossier, shared history, recent activity, open threads

> "What have I said about the relationship between shame and founder performance?"
> ... searches YOUR thinking, not the internet

## Getting Data In

PBrain ships integration recipes that your agent sets up for you. Each recipe tells the agent what credentials to ask for, how to validate, and what cron to register.

| Recipe | Requires | What It Does |
|--------|----------|-------------|
| [Obsidian Vault](recipes/obsidian-vault.md) | — | Point PBrain at an Obsidian vault (or open your brain folder as one) |
| [Public Tunnel](recipes/ngrok-tunnel.md) | — | Fixed URL for MCP + voice (ngrok Hobby $8/mo) |
| [Credential Gateway](recipes/credential-gateway.md) | — | Gmail + Calendar access |
| [Voice-to-Brain](recipes/twilio-voice-brain.md) | ngrok-tunnel | Phone calls to brain pages (Twilio + OpenAI Realtime) |
| [Email-to-Brain](recipes/email-to-brain.md) | credential-gateway | Gmail to entity pages |
| [X-to-Brain](recipes/x-to-brain.md) | — | Twitter timeline + mentions + deletions |
| [Calendar-to-Brain](recipes/calendar-to-brain.md) | credential-gateway | Google Calendar to searchable daily pages |
| [Meeting Sync](recipes/meeting-sync.md) | — | Circleback transcripts to brain pages with attendees |

**Data research recipes** extract structured data from email into tracked brain pages. Built-in recipes for investor updates (MRR, ARR, runway, headcount), expense tracking, and company metrics. Create your own with `pbrain research init`.

Run `pbrain integrations` to see status.

## Obsidian

PBrain is an Obsidian-compatible vault out of the box. Every page PBrain writes is standard markdown with `[[wikilinks]]`, YAML frontmatter (`tags:`, `aliases:`), and inline `#tag` footers — so Obsidian's graph view, backlinks pane, and Dataview plugin read PBrain's output natively. No Obsidian-specific code in PBrain, no conversion step.

```bash
pbrain init --brain-path ~/ObsidianVault/MyBrain
pbrain index
pbrain doctor --integrations
```

`pbrain doctor --integrations` validates brain-folder writability, no broken `[[wikilinks]]`, parseable `tags:` frontmatter, no duplicate slugs (Obsidian wikilink collisions), and no leftover `.pbrain-tmp-*` sentinels.

Writes are atomic and respect a 60-second cooldown on files you're actively editing in Obsidian, so PBrain's autopilot never clobbers your in-progress edits. Setup guide and Dataview query examples: [docs/integrations/obsidian.md](docs/integrations/obsidian.md).

## PBrain + GStack

[GStack](https://github.com/garrytan/gstack) is the engine. PBrain is the mod.

- **[GStack](https://github.com/garrytan/gstack)** = coding skills (ship, review, QA, investigate, office-hours, retro). 70,000+ stars, 30,000 developers per day. When your agent codes on itself, it uses GStack.
- **PBrain** = everything-else skills (brain ops, signal detection, ingestion, enrichment, cron, reports, identity). When your agent remembers, thinks, and operates, it uses PBrain.
- **`hosts/pbrain.ts`** = the bridge. Tells GStack's coding skills to check the brain before coding.

`pbrain init` detects if GStack is installed and reports mod status. If GStack isn't there, it tells you how to get it.

## Architecture

```
┌──────────────────┐    ┌───────────────┐    ┌──────────────────┐
│   Brain Repo     │    │    PBrain     │    │    AI Agent      │
│   (git)          │    │  (retrieval)  │    │  (read/write)    │
│                  │    │               │    │                  │
│  markdown files  │───>│  Postgres +   │<──>│  25 skills       │
│  = source of     │    │  pgvector     │    │  define HOW to   │
│    truth         │    │               │    │  use the brain   │
│                  │<───│  hybrid       │    │                  │
│  human can       │    │  search       │    │  RESOLVER.md     │
│  always read     │    │  (vector +    │    │  routes intent   │
│  & edit          │    │   keyword +   │    │  to skill        │
│                  │    │   RRF)        │    │                  │
└──────────────────┘    └───────────────┘    └──────────────────┘
```

The repo is the system of record. PBrain is the retrieval layer. The agent reads and writes through both. Human always wins... edit any markdown file and `pbrain sync` picks up the changes.

## The Knowledge Model

Every page follows the compiled truth + timeline pattern:

```markdown
---
type: concept
title: Do Things That Don't Scale
tags: [startups, growth, pg-essay]
---

Paul Graham's argument that startups should do unscalable things early on.
The key insight: the unscalable effort teaches you what users actually
want, which you can't learn any other way.

---

- 2013-07-01: Published on paulgraham.com
- 2024-11-15: Referenced in batch W25 kickoff talk
```

Above the `---`: **compiled truth**. Your current best understanding. Gets rewritten when new evidence changes the picture. Below: **timeline**. Append-only evidence trail. Never edited, only added to.

## Search

Hybrid search: vector + keyword + RRF fusion + multi-query expansion + 4-layer dedup.

```
Query
  -> Intent classifier (entity? temporal? event? general?)
  -> Multi-query expansion (Claude Haiku)
  -> Vector search (HNSW cosine) + Keyword search (tsvector)
  -> RRF fusion: score = sum(1/(60 + rank))
  -> Cosine re-scoring + compiled truth boost
  -> 4-layer dedup + compiled truth guarantee
  -> Results
```

Keyword alone misses conceptual matches. Vector alone misses exact phrases. RRF gets both. Search quality is benchmarked and reproducible: `pbrain eval --qrels queries.json` measures P@k, Recall@k, MRR, and nDCG@k. A/B test config changes before deploying them.

## Voice

Call a phone number. Your AI answers. It knows who's calling, pulls their full context from the brain, and responds like someone who actually knows your world. When the call ends, a brain page appears with the transcript, entity detection, and cross-references.

<p align="center">
  <img src="docs/images/voice-client.png" alt="Voice client connected" width="300" />
</p>

> [See it in action](https://x.com/garrytan/status/2043022208512172263)

The voice recipe ships with PBrain: [Voice-to-Brain](recipes/twilio-voice-brain.md). WebRTC works in a browser tab with zero setup. A real phone number is optional.

## Engine Architecture

```
CLI / MCP Server
     (thin wrappers, identical operations)
              |
      BrainEngine interface (pluggable)
              |
     +--------+--------+
     |                  |
PGLiteEngine       PostgresEngine
  (default)          (Supabase)
     |                  |
~/.pbrain/           Supabase Pro ($25/mo)
brain.pglite         Postgres + pgvector
embedded PG 17.5

     pbrain migrate --to supabase|pglite
         (bidirectional migration)
```

PGLite: embedded Postgres, no server, zero config. When your brain outgrows local (1000+ files, multi-device), `pbrain migrate --to supabase` moves everything.

## File Storage

Brain repos accumulate binaries. PBrain has a three-stage migration:

```bash
pbrain files mirror <dir>       # copy to cloud, local untouched
pbrain files redirect <dir>     # replace local with .redirect pointers
pbrain files clean <dir>        # remove pointers, cloud only
pbrain files restore <dir>      # download everything back (undo)
```

Storage backends: S3-compatible (AWS, R2, MinIO), Supabase Storage, or local.

## Commands

```
SETUP
  pbrain init [--supabase|--url]        Create brain (PGLite default)
  pbrain migrate --to supabase|pglite   Bidirectional engine migration
  pbrain upgrade                        Self-update with feature discovery

PAGES
  pbrain get <slug>                     Read a page (fuzzy slug matching)
  pbrain put <slug> [< file.md]         Write/update (auto-versions)
  pbrain delete <slug>                  Delete a page
  pbrain list [--type T] [--tag T]      List with filters

SEARCH
  pbrain search <query>                 Keyword search (tsvector)
  pbrain query <question>              Hybrid search (vector + keyword + RRF)

IMPORT
  pbrain import <dir> [--no-embed]      Import markdown (idempotent)
  pbrain sync [--repo <path>]           Git-to-brain incremental sync
  pbrain export [--dir ./out/]          Export to markdown

FILES
  pbrain files list|upload|sync|verify  File storage operations

EMBEDDINGS
  pbrain embed [<slug>|--all|--stale]   Generate/refresh embeddings

LINKS + GRAPH
  pbrain link|unlink|backlinks|graph    Cross-reference management

ADMIN
  pbrain doctor [--json] [--fast]       Health checks (resolver, skills, DB, embeddings)
  pbrain doctor --fix                   Auto-fix resolver issues
  pbrain stats                          Brain statistics
  pbrain whoami [--verbose]             Resolve current directory to a brain project
  pbrain serve                          MCP server (stdio)
  pbrain integrations                   Integration recipe dashboard
  pbrain check-backlinks check|fix      Back-link enforcement
  pbrain lint [--fix]                   LLM artifact detection
  pbrain transcribe <audio>             Transcribe audio (Groq Whisper)
  pbrain research init <name>           Scaffold a data-research recipe
  pbrain research list                  Show available recipes
```

Run `pbrain --help` for the full reference.

## Origin

PBrain is a fork of [GBrain](https://github.com/garrytan/gbrain) by Garry Tan. GBrain was built by Garry in 12 days to run his personal AI agents — ingesting his meetings, emails, voice calls, and reading notes, enriching every person and company he encountered, producing compiled-truth + timeline pages with source citations. GBrain's production brain powers 17,888 pages, 4,383 people, 723 companies, and 21 autonomous cron jobs across his OpenClaw and Hermes deployments.

PBrain adapts that architecture for a different subject: software engineering. Same compiled-truth + timeline pages, same autopilot daemon, same hybrid RAG search — but tracking libraries you depend on, AI tools and models you evaluate, git repos you reference, code patterns you reuse, and tech companies (Anthropic, OpenAI, xAI, Vercel, Convex) as technical organizations rather than investment targets.

See [NOTICE](NOTICE) and [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md) for the full attribution. Thank you to Garry Tan and all GBrain contributors.

## Docs

**For agents:**
- **[skills/RESOLVER.md](skills/RESOLVER.md)** ... Start here. The skill dispatcher.
- [Individual skill files](skills/) ... 25 standalone instruction sets
- [PBRAIN_SKILLPACK.md](docs/PBRAIN_SKILLPACK.md) ... Legacy reference architecture
- [Getting Data In](docs/integrations/README.md) ... Integration recipes and data flow
- [PBRAIN_VERIFY.md](docs/PBRAIN_VERIFY.md) ... Installation verification

**For humans:**
- [PBRAIN_RECOMMENDED_SCHEMA.md](docs/PBRAIN_RECOMMENDED_SCHEMA.md) ... Brain repo directory structure
- [Thin Harness, Fat Skills](docs/ethos/THIN_HARNESS_FAT_SKILLS.md) ... Architecture philosophy
- [ENGINES.md](docs/ENGINES.md) ... Pluggable engine interface

**Reference:**
- [PBRAIN_V0.md](docs/PBRAIN_V0.md) ... Full product spec
- [CHANGELOG.md](CHANGELOG.md) ... Version history

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Run `bun test` for unit tests. E2E tests: spin up Postgres with pgvector, run `bun run test:e2e`, tear down.

PRs welcome for: new enrichment APIs, performance optimizations, additional engine backends, new skills following the conformance standard in `skills/skill-creator/SKILL.md`.

## License

MIT
