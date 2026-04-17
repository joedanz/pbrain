---
name: project-onboard
description: Onboard a coding project (repo URL or local path) into the brain — creates projects/ + repos/ pages and auto-stubs notable libraries, ai-tools, and companies, linked correctly.
triggers:
  - "onboard this repo"
  - "onboard this project"
  - "add this project to the brain"
  - "import this repo into pbrain"
tools:
  - search
  - get_page
  - put_page
mutating: true
---

# Project Onboard Skill

Onboards a coding project into the brain. Produces a **complete graph**: project page, repo page, and auto-stubbed library / ai-tool / company pages for every notable dependency. The user should never have to hand-create taxonomy pages.

> **Filing rule:** Read `skills/_brain-filing-rules.md` before creating any new page.

## Contract

1. **One project page** per project, slug = project's common name (lowercase-hyphen). Path-qualified wikilinks only.
2. **One repo page** per repo, slug = `<owner>-<name>` (owner-prefixed to avoid colliding with the project page).
3. **Libraries / ai-tools link from project pages only** — not from repo pages. Repo pages describe code structure, scripts, and monorepo layout in plain prose.
4. **Companies** link from their libraries and ai-tools (as vendor). Never from projects directly.
5. **Library vs. company disambiguation:** create a `libraries/X.md` page when X is 1:1 with its vendor (Stripe, Sentry, Resend, Convex, Drizzle, Neon). Create a `companies/X.md` page only when X ships multiple tracked products (Anthropic → Claude + Claude Code + APIs; Vercel → AI SDK + Next.js + Turborepo; Cloudflare → R2 + Workers + D1).
6. **ai-tools are model families**, not vendors: `ai-tools/claude`, `ai-tools/gpt`, `ai-tools/gemini`, `ai-tools/grok`. Each links to its vendor company.
7. **Never trust GitHub's `homepage` field as the real domain** — it's often a `*.vercel.app` preview. Ask the user to confirm the real domain.
8. **All wikilinks path-qualified** (`[[projects/picspot]]`, not `[[picspot]]`). Doctor will flag ambiguous bare slugs.
9. **Atomic-safe writes:** use the file-write pathway PBrain provides — never leave half-written files visible to Obsidian.
10. **Fork → upstream tracking:** if the repo is a fork, stub the upstream repo at `repos/<upstream-owner>-<upstream-name>.md` and link it from the fork's repo page via an `Upstream:` field. The upstream stub is a thin pointer (no `Used by`, no full stack breakdown) — it exists so the ancestry shows up in the graph.

## Inputs

- **repo** (required) — `https://github.com/owner/name`, `owner/name`, or a local path.
- **owner** (optional) — derived from the URL; override if the canonical owner differs.
- **real_domain** (optional) — the production domain. If omitted, skill will ask the user.

## Phases

### Phase 1 — Fetch

Fetch in parallel:
- Repo metadata: `gh api repos/<owner>/<name> --jq '{name,description,language,topics,homepage,default_branch,pushed_at,fork,parent:(.parent // null) | if . then {owner:.owner.login, name:.name, url:.html_url} else null end}'` — `fork: true` triggers the upstream-tracking path; `parent` holds the upstream repo's `owner`/`name`
- README: `gh api repos/<owner>/<name>/readme --jq '.content' | base64 -d`
- Dependency manifest — try in order:
  - `gh api repos/<owner>/<name>/contents/package.json` (JS / TS)
  - `gh api repos/<owner>/<name>/contents/pyproject.toml` (Python)
  - `gh api repos/<owner>/<name>/contents/Cargo.toml` (Rust)
  - `gh api repos/<owner>/<name>/contents/go.mod` (Go)
- Root file listing: `gh api repos/<owner>/<name>/contents --jq '.[].name'` (detects monorepo layout, `.claude/`, `CLAUDE.md`, etc.)

If README is 404 or a generic scaffold (e.g. Google AI Studio boilerplate), fall back to package.json + root listing for facts.

### Phase 2 — Confirm domain

If GitHub's `homepage` field matches `*.vercel.app`, `*.netlify.app`, `*.fly.dev`, `*.onrender.com`, `*.github.io`, or is missing: **ask the user** for the real production domain before writing.

Never silently use a preview URL.

### Phase 3 — Classify dependencies

Walk the dependency manifest. Bucket every dep into exactly one of:

**ai-tools** — model families identified by package name:
- `@ai-sdk/anthropic`, `anthropic` → `ai-tools/claude`
- `@ai-sdk/openai`, `openai` → `ai-tools/gpt`
- `@ai-sdk/google`, `@google/genai` → `ai-tools/gemini`
- `@ai-sdk/xai` → `ai-tools/grok`

**libraries** — frameworks, DBs, ORMs, auth, styling, mobile runtimes, monorepo tools, storage, monitoring, email, payments, charting. Rule of thumb: if it has its own major release cadence worth tracking, it's a library. Skip micro-utilities (`clsx`, `class-variance-authority`, `lucide-react`, `date-fns`) and test libs (`@testing-library/*`, `vitest`, `jest`, `playwright`) unless the user has an existing page for them.

**companies** — the org behind the tool. Only create a company page if the org ships multiple tracked products. Otherwise the library page IS the org page.

**skip** — everything else. Mention in prose on the repo page if architecturally notable (e.g., `@hebcal/core` for a Jewish calendar app) but don't stub.

### Phase 4 — Materialize pages

For each classified entity:

**If the page exists:**
- Read it.
- Append the current project to its "Used by" section (for libraries / ai-tools) or "Makes" section (for companies).
- If already listed, skip (idempotent).
- Write atomically.

**If the page is missing:**
- Create a stub using the templates below.
- Path-qualified wikilinks in "Used by" and "Vendor" sections.

Write the **project page** and **repo page** last, with wikilinks to every library and ai-tool classified above.

### Phase 5 — Verify

Run `pbrain doctor --integrations`. Required: green (no broken wikilinks, no duplicate slugs, no leftover `.pbrain-tmp-*` files). If red, fix before reporting done.

### Phase 6 — Report

Output a concise summary:
- Pages created / updated (counts by type)
- Cross-project hubs that grew (e.g., "convex now has 5 users")
- Anything that looked off (missing real domain, README scaffold detected, skipped deps worth reviewing)

## Templates

### `projects/<slug>.md`

```markdown
---
aliases: ["<Display Name>", "<Alt name if any>"]
tags: [project, <status>, <domain-tag>]
---

# <Display Name>

<One-line description from README or user.>

## Status
Active — deployed at https://<real-domain>

## Repo
[[repos/<owner>-<slug>]]

## Stack
<Inline prose with every notable library/ai-tool wikilinked path-qualified.>

## Notable integrations
- <Prose for skipped-but-notable deps (Hebcal, kosher-zmanim, Leaflet, etc.)>

#project #<status> #<domain-tag>
```

### `repos/<owner>-<slug>.md`

```markdown
---
aliases: ["<Display Name> repo", "<repo-package-name>"]
tags: [repo, <language>, <arch-tag>]
---

# <Display Name> (repo)

GitHub: https://github.com/<owner>/<name>
Project: [[projects/<slug>]]
Upstream: [[repos/<upstream-owner>-<upstream-name>]]   <!-- only if this repo is a fork; also create a stub for the upstream repo -->

## Stack
<Prose describing framework, build tool, test stack. NO library wikilinks — those live on the project page.>

## Structure
- <Monorepo layout if applicable>

## Scripts
<Dev / build / test / other notable scripts from package.json>

#repo #<language> #<arch-tag>
```

### `libraries/<slug>.md`

```markdown
---
aliases: ["<Display Name>", "<Alt>"]
tags: [library, <category>]
---

# <Display Name>

<One-line description.>

## Used by
- [[projects/<a>]]
- [[projects/<b>]]

## Vendor
[[companies/<vendor>]]   <!-- only if a company page exists -->

#library #<category>
```

### `ai-tools/<slug>.md`

```markdown
---
aliases: ["<Display Name>"]
tags: [ai-tool, model, <vendor>]
---

# <Display Name>

<One-line description.>

## Used by
- [[projects/<a>]]

## Vendor
[[companies/<vendor>]]

#ai-tool #model
```

### `companies/<slug>.md`

```markdown
---
aliases: ["<Display Name>"]
tags: [company, <category>]
---

# <Display Name>

<One-line description of what they make.>

## Makes
- [[libraries/<a>]]
- [[ai-tools/<b>]]

#company #<category>
```

## Cross-cutting rules

- **Never create `libraries/X.md` AND `companies/X.md` with the same slug** — Obsidian's wikilink resolver will treat them as ambiguous. If both are warranted semantically, rename (e.g., `companies/convex-dev.md`).
- **Repo pages are thin.** The project page is where the user goes to learn about the tool stack. The repo page is where they go to learn how to build and run the code.
- **Idempotency is mandatory.** Running the skill twice on the same repo should not create duplicate "Used by" entries. Always read-then-merge.
- **Preview-URL detection is a hard gate.** If `homepage` matches the preview-URL pattern, never write the page without user confirmation.

## Known limitations

- Monorepos with per-app package.jsons require walking `apps/*/package.json` and `packages/*/package.json` — Phase 3 should recurse when root package.json has no meaningful deps (only `turbo` + `typescript`).
- Python / Rust / Go projects have less-structured dep info than `package.json`. Fall back to README + heuristics.
- First-party internal packages (e.g., `@repo/db` in a monorepo) are not libraries — skip them.

## Anti-Patterns

- **Trusting `homepage` as the real domain.** GitHub's homepage field is often a Vercel preview. Always confirm with the user before writing the project page.
- **Bare-slug wikilinks.** Always path-qualify: `[[projects/picspot]]`, never `[[picspot]]`. Obsidian resolver will flag ambiguity if two files share a tail.
- **Matching repo slug to project slug.** `repos/picspot.md` + `projects/picspot.md` collide. Always owner-prefix repo slugs.
- **Re-linking libraries from repo pages.** Creates triangle edges in the graph. Libraries link from project pages only.
- **Stubbing every dep.** Skip micro-utilities and test harnesses. The "Used by" graph is only useful for tools with real independent state.
- **Creating both `libraries/X.md` and `companies/X.md` with the same slug.** Pick one. If the company ships multiple tracked products, rename the company page (`companies/X-inc.md`) or keep the library page only.
- **Non-idempotent re-runs.** If the page already lists this project under "Used by", don't duplicate. Read-then-merge.
- **Skipping `pbrain doctor --integrations` at the end.** The skill is not done until doctor is green.
- **Literal double-bracket strings in page prose.** Doctor's wikilink scanner matches `[[...]]` anywhere in the body, even inside backticks or code spans. If you need to describe wikilink syntax in prose, spell it out ("wikilinks" / "double-bracket links") instead of using the literal characters. The scanner cannot distinguish documentation from intent.

## Output Format

Return a concise run report in this shape:

```
Onboarded <owner>/<name> → projects/<slug>

Created:
  projects/<slug>.md
  repos/<owner>-<slug>.md
  libraries/<new-lib-1>.md, libraries/<new-lib-2>.md  (N new)
  ai-tools/<new-tool>.md                               (N new)
  companies/<new-company>.md                           (N new)

Updated (Used by appended):
  libraries/<existing>.md, ai-tools/<existing>.md      (N updated)

Cross-project hubs now at:
  libraries/convex  ── N projects
  ai-tools/claude   ── N projects

Doctor: [OK] <pages> pages, <wikilinks> wikilinks, 0 issues

Notes:
  - Real domain: <value> (confirmed with user | from README | from vercel.json)
  - Skipped N deps (list inline if interesting)
  - Any warnings worth reviewing
```

End-of-run verification is part of the output — if doctor is red, the output must show the failing check and the fix applied before reporting success.
