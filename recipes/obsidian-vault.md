---
id: obsidian-vault
name: Obsidian Vault
version: 1.0.0
description: Point PBrain at an Obsidian vault (or make your PBrain brain folder openable as one). Zero code coupling.
category: infra
requires: []
secrets: []
health_checks:
  - type: command
    argv: ["pbrain", "doctor", "--integrations", "--json"]
    label: "doctor integrations"
setup_time: 5 min
cost_estimate: "Free. Obsidian Sync is $4/mo if you want their cloud; iCloud/GDrive/Dropbox work fine as alternatives."
---

# Obsidian Vault: Open Your Brain in Obsidian

PBrain already writes standard markdown with `[[wikilinks]]`, YAML frontmatter,
and inline `#tag` footers. No conversion needed — you just need to decide
whether to:

1. **Point PBrain at an existing Obsidian vault**, or
2. **Open a PBrain brain folder as a new vault in Obsidian**.

Either path takes about 5 minutes.

## IMPORTANT: Instructions for the Agent

**You are the installer.** The user doesn't need to edit any config files or
install any Obsidian plugins for PBrain to work — Obsidian reads PBrain's output
natively. Only install Dataview (optional but recommended) if the user asks for
structured query examples.

**Do not skip verification.** After each step, run `pbrain doctor --integrations`
and confirm the report is clean. A duplicate slug or broken wikilink left
unfixed will cause confusion later.

## Setup Flow

### Step 1: Decide which vault

Ask the user:
"Do you already have an Obsidian vault you want PBrain to use? Or should we
create a fresh brain folder and open that in Obsidian?"

- **Existing vault:** note the absolute path.
- **Fresh brain:** suggest `~/PBrain` or `~/Documents/PBrain`.

### Step 2: Point PBrain at the brain path

```bash
pbrain init --brain-path "<absolute-path-to-vault>"
```

This writes `brain_path` into `~/.pbrain/config.json` and ensures the folder
exists. The binary index lives at `~/.pbrain/indexes/default.pglite` — never
inside the vault — so Obsidian sync and iCloud/GDrive won't corrupt it.

### Step 3: Index the existing contents

```bash
pbrain index
```

This walks the vault, chunks every `.md` file, embeds, and loads the index. If
the vault is empty, this is a no-op.

### Step 4: Open the folder in Obsidian

Tell the user:
"Open Obsidian. Click 'Open folder as vault' and pick the path you just set. If
Obsidian asks about trust, say yes — everything in here is your content."

### Step 5: Verify

```bash
pbrain doctor --integrations
```

Expected output:
- brain_path prints the correct absolute path
- pages_scanned is ≥ 1 (or 0 for a fresh vault — that's fine)
- wikilinks_checked matches what the user has written
- `[OK] All integration checks passed.`

If any issues show up, fix them **before** telling the user setup is complete.
Common issues:
- **broken_wikilink** — the wikilink target doesn't exist. Either create the
  page or add the broken text as an `aliases:` entry on an existing page.
- **duplicate_slug** — two files share a filename tail. Rename one so
  wikilinks are unambiguous.
- **leftover_tmp** — a sentinel from a crashed atomic write. Safe to delete
  with `find "$BRAIN_PATH" -name '.pbrain-tmp-*' -delete`.

### Step 6 (optional): Recommend Dataview

If the user wants structured queries over frontmatter (e.g. "all libraries
tagged `#ai-sdk` sorted by last-updated"), point them at
[docs/integrations/obsidian.md](../docs/integrations/obsidian.md) for Dataview
query examples. Dataview is not required for PBrain to work.

## Troubleshooting

**"File changed externally" prompt during PBrain writes.**
Your vault is probably on a network or cloud-synced volume where `rename(2)`
isn't atomic. Move the vault to a local disk and use Obsidian Sync or a
separate GDrive copy if you need cross-machine access.

**Autopilot doesn't pick up edits made from another machine.**
Filesystem watchers don't fire reliably on cloud-synced mounts. PBrain's
autopilot falls back to a cron poll, but the interval may be longer than
you expect. Run `pbrain index` manually if you need the index up to date
immediately after a sync.

**PBrain and Obsidian both writing to the same file.**
PBrain defers any write to a file modified in the last 60 seconds. If you're
actively editing in Obsidian, PBrain will skip that file until you stop
typing. If you want PBrain to win anyway, pass `--force` on the write-side
command.
