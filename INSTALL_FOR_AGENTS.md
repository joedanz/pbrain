# PBrain Installation Guide for AI Agents

Read this entire file, then follow the steps. Ask the user for API keys when needed.
Target: ~30 minutes to a fully working brain.

## Step 1: Install PBrain

```bash
git clone https://github.com/joedanz/pbrain.git ~/pbrain && cd ~/pbrain
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun install && bun link
```

Verify: `pbrain --version` should print a version number. If `pbrain` is not found,
restart the shell or add the PATH export to the shell profile.

## Step 2: API Keys

Ask the user for these:

```bash
export OPENAI_API_KEY=sk-...          # required for vector search
export ANTHROPIC_API_KEY=sk-ant-...   # optional, improves search quality
```

Save to shell profile or `.env`. Without OpenAI, keyword search still works.
Without Anthropic, search works but skips query expansion.

## Step 3: Create the Brain

```bash
pbrain init                           # PGLite, no server needed
pbrain doctor --json                  # verify all checks pass
```

The user's markdown files (notes, docs, brain repo) are SEPARATE from this tool repo.
Ask the user where their files are, or create a new brain repo:

```bash
mkdir -p ~/brain && cd ~/brain && git init
```

Read `~/pbrain/docs/PBRAIN_RECOMMENDED_SCHEMA.md` and set up the MECE directory
structure (people/, companies/, concepts/, etc.) inside the user's brain repo,
NOT inside ~/pbrain.

## Step 4: Import and Index

```bash
pbrain import ~/brain/ --no-embed     # import markdown files
pbrain embed --stale                  # generate vector embeddings
pbrain query "key themes across these documents?"
```

## Step 5: Load Skills

Read `~/pbrain/skills/RESOLVER.md`. This is the skill dispatcher. It tells you which
skill to read for any task. Save this to your memory permanently.

The three most important skills to adopt immediately:

1. **Signal detector** (`skills/signal-detector/SKILL.md`) — fire this on EVERY
   inbound message. It captures ideas and entities in parallel. The brain compounds.

2. **Brain-ops** (`skills/brain-ops/SKILL.md`) — brain-first lookup on every response.
   Check the brain before any external API call.

3. **Conventions** (`skills/conventions/quality.md`) — citation format, back-linking
   iron law, source attribution. These are non-negotiable quality rules.

## Step 6: Identity (optional)

Run the soul-audit skill to customize the agent's identity:

```
Read skills/soul-audit/SKILL.md and follow it.
```

This generates SOUL.md (agent identity), USER.md (user profile), ACCESS_POLICY.md
(who sees what), and HEARTBEAT.md (operational cadence) from the user's answers.

If skipped, minimal defaults are installed automatically.

## Step 7: Recurring Jobs

Set up using your platform's scheduler (OpenClaw cron, Railway cron, crontab):

- **Live sync** (every 15 min): `pbrain sync --repo ~/brain && pbrain embed --stale`
- **Auto-update** (daily): `pbrain check-update --json` (tell user, never auto-install)
- **Dream cycle** (nightly): read `docs/guides/cron-schedule.md` for the full protocol.
  Entity sweep, citation fixes, memory consolidation. This is what makes the brain
  compound. Do not skip it.
- **Weekly**: `pbrain doctor --json && pbrain embed --stale`

## Step 8: Integrations

Run `pbrain integrations list`. Each recipe in `~/pbrain/recipes/` is a self-contained
installer. It tells you what credentials to ask for, how to validate, and what cron
to register. Ask the user which integrations they want (email, calendar, voice, Twitter).

Verify: `pbrain integrations doctor` (after at least one is configured)

## Step 9: Verify

Read `docs/PBRAIN_VERIFY.md` and run all 6 verification checks. Check #4 (live sync
actually works) is the most important.

## Upgrade

```bash
cd ~/pbrain && git pull origin main && bun install
```

Then run `pbrain init` to apply any schema migrations (idempotent, safe to re-run).
