# Brain Filing Rules -- MANDATORY for all skills that write to the brain

## The Rule

The PRIMARY SUBJECT of the content determines where it goes. Not the format,
not the source, not the skill that's running.

## Decision Protocol

1. Identify the primary subject (a person? company? concept? policy issue?)
2. File in the directory that matches the subject
3. Cross-link from related directories
4. When in doubt: what would you search for to find this page again?

## Common Misfiling Patterns -- DO NOT DO THESE

| Wrong | Right | Why |
|-------|-------|-----|
| Analysis of a topic -> `sources/` | -> appropriate subject directory | sources/ is for raw data only |
| Article about a person -> `sources/` | -> `people/` | Primary subject is a person |
| Meeting-derived company info -> `meetings/` only | -> ALSO update `companies/` | Entity propagation is mandatory |
| Research about a company -> `sources/` | -> `companies/` | Primary subject is a company |
| Reusable framework/thesis -> `sources/` | -> `concepts/` | It's a mental model |
| Changelog entry for a library -> `sources/` | -> `libraries/<name>.md` timeline | Primary subject is the library |
| Review of an AI tool -> `writing/` | -> `ai-tools/<name>.md` | Primary subject is the tool |
| Code snippet for retry with jitter -> `patterns/p-retry.md` | -> `patterns/retry-with-jitter.md` | Name the pattern, not the package (package gets a `libraries/` page) |
| arxiv paper about attention -> `concepts/attention.md` only | -> `papers/vaswani-2017-attention.md` + cross-link `concepts/attention.md` | Paper is the artifact; concept is what it introduced |

## Tech-domain primary-subject tests

When the subject is tech-flavored, apply these tests in order:

1. **Is it a specific named package or product?** → `libraries/` (code you import) or `ai-tools/` (service you drive). Name the page after the canonical package/product name.
2. **Is it a git repo source tree?** → `repos/`. Filename: `owner-repo.md`.
3. **Is it a reusable idiom or code shape, package-independent?** → `patterns/`. Name after the pattern, not any library that implements it.
4. **Is it a research artifact (paper/talk/book)?** → `papers/` / `talks/` / `books/`. The *idea* it introduces (if durable) also gets a `concepts/` page, cross-linked.
5. **Is it a tech organization?** → `companies/`. PBrain tracks tech orgs (what they ship, what you use, their direction) — not as investment targets. No Stage, no valuation, no investors.

**The 2-question check before creating any tech-domain page:**
- Would I search for this by the package/product name? → that name is the slug.
- Can this be consumed (imported, installed, subscribed to)? → library/ai-tool. Or is this just ideas/patterns about how to use something? → patterns/concepts.

## What `sources/` Is Actually For

`sources/` is ONLY for:
- Bulk data imports (API dumps, CSV exports, snapshots)
- Raw data that feeds multiple brain pages (e.g., a guest export, contact sync)
- Periodic captures (quarterly snapshots, sync exports)

If the content has a clear primary subject (a person, company, concept, policy
issue), it does NOT go in sources/. Period.

## Notability Gate

Not everything deserves a brain page. Before creating a new entity page:
- **People:** Will you interact with them again? Are they relevant to your work?
- **Companies:** Are they relevant to your work or interests?
- **Concepts:** Is this a reusable mental model worth referencing later?
- **When in doubt, DON'T create.** A missing page can be created later.
  A junk page wastes attention and degrades search quality.

## Iron Law: Back-Linking (MANDATORY)

Every mention of a person or company with a brain page MUST create a back-link
FROM that entity's page TO the page mentioning them. This is bidirectional:
the new page links to the entity, AND the entity's page links back.

Format for back-links (append to Timeline or See Also):
```
- **YYYY-MM-DD** | Referenced in [page title](path/to/page.md) -- brief context
```

An unlinked mention is a broken brain. The graph is the intelligence.

## Citation Requirements (MANDATORY)

Every fact written to a brain page must carry an inline `[Source: ...]` citation.

Three formats:
- **Direct attribution:** `[Source: User, {context}, YYYY-MM-DD]`
- **API/external:** `[Source: {provider}, YYYY-MM-DD]` or `[Source: {publication}, {URL}]`
- **Synthesis:** `[Source: compiled from {list of sources}]`

Source precedence (highest to lowest):
1. User's direct statements (highest authority)
2. Compiled truth (pre-existing brain synthesis)
3. Timeline entries (raw evidence)
4. External sources (API enrichment, web search -- lowest)

When sources conflict, note the contradiction with both citations. Don't
silently pick one.

## Raw Source Preservation

Every ingested item should have its raw source preserved for provenance.

**Size routing (automatic via `pbrain files upload-raw`):**
- **< 100 MB text/PDF**: stays in the brain repo (git-tracked) in a `.raw/`
  sidecar directory alongside the brain page
- **>= 100 MB OR media files** (video, audio, images): uploaded to cloud
  storage (Supabase Storage, S3, etc.) with a `.redirect.yaml` pointer left
  in the brain repo. Files >= 100 MB use TUS resumable upload (6 MB chunks
  with retry) for reliability.

**Upload command:**
```bash
pbrain files upload-raw <file> --page <page-slug> --type <type>
```
Returns JSON: `{storage: "git"}` for small files, `{storage: "supabase", storagePath, reference}` for cloud.

**The `.redirect.yaml` pointer format:**
```yaml
target: supabase://brain-files/page-slug/filename.mp4
bucket: brain-files
storage_path: page-slug/filename.mp4
size: 524288000
size_human: 500 MB
hash: sha256:abc123...
mime: video/mp4
uploaded: 2026-04-11T...
type: transcript
```

**Accessing stored files:**
```bash
pbrain files signed-url <storage-path>    # Generate 1-hour signed URL
pbrain files restore <dir>                # Download back to local
```

This ensures any derived brain page can be traced back to its original source,
and large files don't bloat the git repo.
