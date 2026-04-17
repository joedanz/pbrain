# PBrain Installation Guide for AI Agents

Read this entire file, then follow the steps. Ask the user for the things you need.
Target: ~30 minutes to a fully working brain.

## Before you start

Confirm the user has these ready. If any are missing, help them set them up before moving on.

- **A brain folder.** This is where PBrain reads and writes markdown. An Obsidian vault is ideal (graph view, backlinks pane, Dataview plugin all work out of the box), but any writable folder works — Logseq, plain markdown, a cloud-synced mount. If the user doesn't have one yet, tell them: "Open Obsidian → Create new vault → pick a path like `~/ObsidianVault/MyBrain`. Then come back with the absolute path."
- **OpenAI API key** (required for vector search).
- **Anthropic API key** (optional, improves search quality via query expansion).

## Step 1: Install PBrain

### Fast path (recommended)

Ask the user for their brain folder first (Obsidian vault root or any writable markdown folder), then run the one-line installer with that path. The installer handles Bun, clone, `bun install && bun link`, and `pbrain init` in one shot.

```bash
BRAIN_PATH="/absolute/path/the/user/gave/you"
curl -fsSL https://raw.githubusercontent.com/joedanz/pbrain/master/scripts/install.sh \
  | bash -s -- --brain-path "$BRAIN_PATH" --yes
```

`--yes` accepts all prompts (creates the brain folder if missing, runs `pbrain install-skills` if an IDE is detected). After it finishes, `export PATH="$HOME/.bun/bin:$PATH"` so `pbrain` is on PATH for subsequent steps.

Verify:

```bash
export PATH="$HOME/.bun/bin:$PATH"
pbrain --version
```

If this succeeds, **skip to Step 2 (API Keys)**. Steps 3 and 4 are already done.

### Manual path (fallback)

Use if the one-line installer fails (no `curl`, restricted filesystem, corporate proxy).

```bash
git clone https://github.com/joedanz/pbrain.git ~/pbrain && cd ~/pbrain
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun install && bun link
```

Verify: `pbrain --version` should print a version number. If `pbrain` is not found,
restart the shell or add the PATH export to the shell profile. Then continue with Step 3 below to wire up the brain folder.

## Step 2: API Keys

Ask the user for these:

```bash
export OPENAI_API_KEY=sk-...          # required for vector search
export ANTHROPIC_API_KEY=sk-ant-...   # optional, improves search quality
```

Save to shell profile or `.env`. Without OpenAI, keyword search still works.
Without Anthropic, search works but skips query expansion.

## Step 3: Ask for the brain folder

Do not run `pbrain init` yet. First, ask the user:

> "Where is your brain folder? This is the absolute path PBrain will read and write markdown into. If it's an Obsidian vault, give me the vault root (e.g. `~/ObsidianVault/MyBrain`)."

Wait for a concrete path. Expand `~` to `$HOME`. Verify the directory exists and is writable:

```bash
BRAIN_PATH="/absolute/path/the/user/gave/you"
test -d "$BRAIN_PATH" -a -w "$BRAIN_PATH" || {
  echo "Not a writable directory: $BRAIN_PATH"
  exit 1
}
```

If the directory doesn't exist yet, ask the user to confirm they want it created, then `mkdir -p "$BRAIN_PATH"`.

## Step 4: Create the Brain

```bash
pbrain init --brain-path "$BRAIN_PATH"   # writes brain_path to ~/.pbrain/config.json
pbrain doctor --json                      # verify all checks pass
```

If the user wants the MECE directory structure (`people/`, `companies/`, `concepts/`,
etc.) inside their vault, read `~/pbrain/docs/PBRAIN_RECOMMENDED_SCHEMA.md` and
create those subdirectories inside `$BRAIN_PATH`, NOT inside `~/pbrain`.

## Step 5: Import and Index

```bash
pbrain import "$BRAIN_PATH" --no-embed   # import existing markdown files
pbrain embed --stale                      # generate vector embeddings
pbrain query "key themes across these documents?"
```

## Step 6: Load Skills

**Dedicated agent platforms (OpenClaw, Hermes):** read `~/pbrain/skills/RESOLVER.md`
directly. This is the skill dispatcher — it tells you which skill to read for any
task. Save it to memory permanently. The agent reads skill files straight from the
cloned repo.

**Claude Code / Cursor / Windsurf users:** register the skills into your client's
discovery directory so they auto-fire without you having to remember to load them:

```bash
pbrain install-skills
```

Re-run this after `pbrain upgrade` to pick up new skills. The command symlinks
every skill in `~/pbrain/skills/` into the skill dirs (`~/.claude/skills/`,
`~/.cursor/skills/`, `~/.windsurf/skills/`) that exist on your machine.
Name collisions are never overwritten silently — if another plugin already owns
a skill name (e.g., `ingest`), PBrain warns and skips it unless you pass `--force`.

The three most important skills to adopt immediately:

1. **Signal detector** (`skills/signal-detector/SKILL.md`) — fire this on EVERY
   inbound message. It captures ideas and entities in parallel. The brain compounds.

2. **Brain-ops** (`skills/brain-ops/SKILL.md`) — brain-first lookup on every response.
   Check the brain before any external API call.

3. **Conventions** (`skills/conventions/quality.md`) — citation format, back-linking
   iron law, source attribution. These are non-negotiable quality rules.

## Step 7: Identity (optional)

Run the soul-audit skill to customize the agent's identity:

```
Read skills/soul-audit/SKILL.md and follow it.
```

This generates SOUL.md (agent identity), USER.md (user profile), ACCESS_POLICY.md
(who sees what), and HEARTBEAT.md (operational cadence) from the user's answers.

If skipped, minimal defaults are installed automatically.

## Step 8: Recurring Jobs

Set up using your platform's scheduler (OpenClaw cron, Railway cron, crontab):

- **Live sync** (every 15 min): `pbrain sync --repo "$BRAIN_PATH" && pbrain embed --stale`
- **Auto-update** (daily): `pbrain check-update --json` (tell user, never auto-install)
- **Dream cycle** (nightly): read `docs/guides/cron-schedule.md` for the full protocol.
  Entity sweep, citation fixes, memory consolidation. This is what makes the brain
  compound. Do not skip it.
- **Weekly**: `pbrain doctor --json && pbrain embed --stale`

## Step 9: Integrations

Run `pbrain integrations list`. Each recipe in `~/pbrain/recipes/` is a self-contained
installer. It tells you what credentials to ask for, how to validate, and what cron
to register. Ask the user which integrations they want (email, calendar, voice, Twitter).

Verify: `pbrain integrations doctor` (after at least one is configured)

## Step 10: Verify

Read `docs/PBRAIN_VERIFY.md` and run all 6 verification checks. Check #4 (live sync
actually works) is the most important.

## Upgrade

```bash
cd ~/pbrain && git pull origin main && bun install
pbrain init                   # idempotent — reuses saved brain_path, applies schema migrations
pbrain install-skills         # refresh IDE skill symlinks if Claude Code / Cursor / Windsurf is in use
```

Re-running `pbrain init` with no flags on an already-configured machine reuses the
`brain_path` saved in `~/.pbrain/config.json` — no re-prompt.
