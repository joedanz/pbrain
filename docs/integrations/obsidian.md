# Obsidian

PBrain is an Obsidian-compatible vault out of the box. Every page PBrain writes is
standard markdown with `[[wikilinks]]`, YAML frontmatter (`tags:`, `aliases:`), and
inline `#tag` footers — so Obsidian's graph view, backlinks pane, Dataview plugin,
and mobile app read PBrain's output natively without any Obsidian-specific code
in PBrain.

You have two paths:

1. **Point PBrain at an existing vault** — your vault stays where it is; PBrain
   reads, writes, and indexes the same files.
2. **Open a PBrain brain as a vault** — open `~/my-brain` (or wherever `brain_path`
   points) in Obsidian. No data migration needed.

## Quick Setup

```bash
# 1. Tell PBrain where your brain lives
pbrain init --brain-path ~/ObsidianVault/MyBrain

# 2. Index the existing contents
pbrain index

# 3. Confirm Obsidian compatibility
pbrain doctor --integrations
```

The last command validates:

- `brain_path` exists and is writable
- No leftover `.pbrain-tmp-*` sentinels from crashed writes
- Every YAML frontmatter block parses deterministically
- Every `[[wikilink]]` resolves to a known slug or alias
- No duplicate slugs across directories (Obsidian wikilink collisions)

Green output means Obsidian, GitHub, Dataview, and PBrain's own parser all see
the same brain.

## How PBrain writes pages

Every page PBrain produces carries tags in **two places** — YAML frontmatter and
an inline `#tag` footer at the end of the body. That's intentional: Obsidian's
tag pane reads the inline form; Dataview queries read the frontmatter; PBrain's
own parser reads both. Removing one leaves a consumer blind.

Links are emitted as canonical slugs — `[[companies/anthropic]]`, not
`[companies/anthropic](companies/anthropic.md)`. Obsidian renders them as
clickable backlinks; the graph view picks them up automatically; Dataview can
query them as `file.outlinks`.

Writes are atomic. PBrain writes to a sibling `.pbrain-tmp-<uuid>` file, fsyncs,
then renames into place. Obsidian never sees a half-written file, so you won't
get spurious "file changed externally" prompts during long enrich runs.

## Concurrent-edit safety

If you're editing a page in Obsidian and PBrain's autopilot tries to enrich the
same file, the write is **deferred** until the file has been untouched for 60
seconds. Your edits win. This matters most during background jobs like
`pbrain autopilot` and `pbrain enrich` batches.

If you want to force a write regardless of cooldown, pass `--force` on the
write-side command.

## Recommended plugins

These Obsidian plugins pair well with PBrain but aren't required:

| Plugin | Why | Required? |
|--------|-----|-----------|
| [Dataview](https://github.com/blacksmithgu/obsidian-dataview) | Query PBrain's frontmatter (`type:`, `tags:`, `aliases:`) as a database | Recommended |
| [Templater](https://github.com/SilentVoid13/Templater) | Create new pages that match PBrain's page shape | Optional |
| [Obsidian Git](https://github.com/denolehov/obsidian-git) | Version your vault (PBrain doesn't) | Optional |

## Dataview query examples

Once Dataview is installed, you can query PBrain's structured data directly in
any note. A few useful patterns:

**All libraries sorted by last updated:**

````markdown
```dataview
TABLE file.mtime AS "Updated"
FROM "libraries"
SORT file.mtime DESC
```
````

**Companies tagged as AI foundation labs:**

````markdown
```dataview
LIST
FROM "companies"
WHERE contains(tags, "foundation-model")
```
````

**Pages tagged `#ai-tools` with no timeline entries yet (leads for enrichment):**

````markdown
```dataview
LIST
FROM #ai-tools
WHERE !contains(file.outlinks.path, "timeline")
```
````

**Every page that mentions a given library:**

````markdown
```dataview
LIST FROM [[libraries/convex]]
```
````

## Cloud sync (GDrive, iCloud)

PBrain keeps the binary index (`~/.pbrain/indexes/default.pglite`) **outside**
the brain folder on purpose — PGLite files corrupt under cloud sync. The
markdown brain folder itself syncs fine.

If you keep `brain_path` on a cloud-synced mount, PBrain's autopilot falls back
to a cron poll when filesystem events don't fire (they often don't on
GDrive Desktop or iCloud). This still catches cross-machine edits; it just runs
on an interval instead of instantly.

## What PBrain does NOT do

- **Version control.** PBrain doesn't commit, push, or track history — use
  Obsidian Git or plain `git` if you want that. PBrain's continuous autopilot
  writes would make for very noisy history anyway.
- **Own your vault layout.** If you open a PBrain folder in Obsidian, you're
  free to rearrange, rename, and add files — PBrain's `pbrain index` rebuilds
  the index from whatever it finds.
- **Conflict resolution.** If two machines write the same file under cloud
  sync, whichever write wins at the filesystem level wins. Use a real
  version-control plugin if that's a concern for you.

## Troubleshooting

**`pbrain doctor --integrations` reports broken wikilinks.**
Fix the target filename, or add the broken-link target as an `aliases:` entry
on an existing page. Obsidian resolves wikilinks through aliases.

**`pbrain doctor --integrations` reports duplicate slugs.**
Two files share the same tail (e.g., `libraries/react.md` and
`concepts/react.md`). Rename one so `[[react]]` is unambiguous, or always
use the full path — `[[libraries/react]]`.

**`pbrain doctor --integrations` reports leftover `.pbrain-tmp-*` files.**
These are sentinels from a crashed atomic write. Safe to delete:
`find <brain-path> -name '.pbrain-tmp-*' -delete`.

**Obsidian shows "file changed externally" while PBrain writes.**
This shouldn't happen with atomic writes on a local filesystem. If it does,
your brain is probably on a network or cloud-synced volume where rename
isn't atomic — move the brain to a local disk and sync a separate copy.
