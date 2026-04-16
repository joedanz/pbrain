<!-- schema-version: 0.5.0 -->
<!-- source: https://raw.githubusercontent.com/joedanz/pbrain/master/docs/PBRAIN_RECOMMENDED_SCHEMA.md -->
# Brain: The LLM-Maintained Knowledge Base

A system prompt for any AI agent that wants to build and maintain a personal knowledge base. This describes the pattern, the architecture, and the operational discipline that makes it work.

Drop this into your agent's workspace as a skill or system prompt. Your agent will build the rest.

---

## What this is

A personal intelligence system where your AI agent builds and maintains an interlinked wiki of everything you know about your technical world — people, tech companies, software libraries, AI tools, git repos, code patterns, papers, talks, books, projects, meetings, ideas — as structured, cross-referenced markdown files. The agent writes and maintains all of it. You direct, curate, and think.

PBrain is optimized for senior software engineers who want their knowledge base to compound across coding projects, model comparisons, library upgrades, and tech-industry context — not deal flow or hiring pipelines.

This is Karpathy's LLM wiki pattern, but extended from research notes into a full operational knowledge base — one that integrates with your calendar, email, meetings, social media, and contacts to stay continuously current.

The key insight: **knowledge management has failed for 30 years because maintenance falls on humans. LLM agents change the equation — they don't get bored, don't forget to update cross-references, and can touch 50 files in one pass.** Your wiki stays alive because the cost of maintenance is near zero.

## Three Founding Principles

### 1. Every Piece of Knowledge Has a Primary Home (MECE Directories)

Every piece of knowledge passes through a decision tree and lands in exactly one directory. No duplicated pages, no ambiguity about where something goes.

This is the single most important structural decision. Without it, knowledge bases rot — the same fact lives in three places with three different versions, nobody knows which is current, and the agent (or human) stops trusting the system. MECE directories with explicit resolver rules prevent this.

Every directory has a `README.md` (the resolver) that answers two questions:
1. **What goes here** — a positive definition with a concrete test
2. **What does NOT go here** — the key distinctions from neighboring directories that the agent might confuse

The brain also has a top-level `RESOLVER.md` — a numbered decision tree the agent walks when filing anything. When two directories seem to fit, disambiguation rules break the tie. When nothing fits, the item goes in `inbox/` — which is itself a signal the schema needs to evolve.

**The agent must read the resolver before creating any new page.** This is not optional.

**Important nuance: MECE applies to directories, not to reality.** Real people and entities are multi-faceted — a political founder can also be a friend, donor, media actor, and hiring candidate. The resolver picks the *primary home* for their page (people/), but the page itself uses typed backlinks and cross-references to surface all their facets. The MECE rule prevents duplicate pages, not duplicate relationships. Cross-references are how adjacency is preserved without breaking the one-page-per-entity rule.

### 2. Compiled Truth + Timeline (Two-Layer Pages)

Every brain page has two layers, separated by a horizontal rule (`---`):

**Above the line — Compiled Truth.** Always current, always rewritten when new information arrives. Starts with a one-paragraph executive summary. If you read only this, you know the state of play. Followed by structured State fields, Open Threads (active items — removed when resolved), and See Also (cross-links).

**Below the line — Timeline.** Append-only, never rewritten. Reverse-chronological evidence log. Each entry: date, source, what happened. When an open thread gets resolved, it moves here with its resolution.

If someone asks "what's the current state?" — read above the line. If someone asks "what happened?" — read below the line. The top is the current summary. The bottom is the source log.

This is the Karpathy wiki pattern's killer feature: **the synthesis is pre-computed.** Unlike RAG, where the LLM re-derives knowledge from scratch every query, your brain has already done the work. The cross-references are already there. The contradictions have already been flagged.

### 3. Enrichment Fires on Every Signal

Every time any signal touches a person or company — meeting, email, tweet, calendar event, contact sync, conversation mention — the enrichment pipeline fires. The brain grows as a side effect of normal operations, not as a separate task you remember to do.

This is what distinguishes an operational brain from Karpathy's research wiki. He describes ingesting sources you manually add. An operational brain goes further — every pipeline (meetings, email, social media, contacts) automatically triggers enrichment on every entity it touches. You never have to remember to update someone's page. The system does it because the plumbing is wired correctly.

## Wiring It Into Your Agent

The brain must be referenced in your agent's configuration (AGENTS.md or equivalent) as a hard rule, not a suggestion. Specifically:

1. **Before creating any brain page → read RESOLVER.md.** This should be in your agent's operational rules, not buried in documentation.
2. **Before answering any question about people, companies, deals, or strategy → search the brain first.** Even if the agent thinks it knows the answer. File contents are current; the agent's memory of them goes stale.
3. **The enrich skill fires on every signal.** Every ingest pathway — meeting processing, email triage, social monitoring, contact sync — should call the enrichment pipeline when it encounters a person or company. This is wiring, not discipline. If it depends on the agent remembering, it will eventually be forgotten.
4. **Corrections are the highest-value data.** If the user corrects the agent about a person, company, deal, or decision — it gets written to the brain immediately. No batching, no deferring.

The chain of authority: **Agent config (AGENTS.md) says "read RESOLVER.md" → RESOLVER.md is the decision tree → each directory README.md is the local resolver → schema.md defines page structure → the enrich skill defines the enrichment protocol.**

## Architecture

Three layers:

**Raw sources** — meeting transcripts, emails, tweets, web research, API responses, calendar events, contact data. Immutable. The agent reads from these but never modifies them. Stored in `sources/` and `.raw/` sidecar directories.

**The brain** — a directory of interlinked markdown files. People pages, company pages, deal pages, meeting pages, project pages, concept pages. The agent owns this layer entirely. It creates pages, updates them when new information arrives, maintains cross-references, and keeps everything consistent. You read it; the agent writes it.

**The schema** — a document (this one, plus `schema.md` and `RESOLVER.md`) that tells the agent how the brain is structured, what the conventions are, and what workflows to follow. This is the key configuration file — it makes your agent a disciplined knowledge maintainer rather than a generic chatbot.

## The Database + Markdown Architecture

The markdown wiki is the human-facing layer — the primary interface for humans and LLMs. But it's not the sole source of truth. A structured database layer provides the foundation, and the markdown is generated from it.

### The Four Database Primitives

**Entity registry** — canonical ID, all aliases, all external IDs (LinkedIn member ID, X user ID, email addresses, phone numbers) in one table. This is the single source of truth for "is this the same person?" When you merge two entities, it's a database operation (point both IDs at the same canonical record), not a file-merge operation with cross-reference fixups.

**Event ledger** — every signal that touches the brain is an immutable event: meeting attended, email received, tweet published, enrichment completed, user correction applied. Events have provenance: source, timestamp, confidence, raw payload reference. The timeline section of markdown pages is generated from this ledger. You never lose events because a page rewrite went wrong.

**Fact store** — structured claims with provenance. "Jane Doe is CTO of Acme" with `source=crustdata, confidence=high, observed_at=2026-04-07`. When two sources disagree (LinkedIn says CTO, company website says VP Engineering), the conflict is visible as two facts for the same field with different values. The compiled truth section above the line is generated from the fact store's latest-confident values. Contradictions become data, not bugs.

**Relationship graph** — typed edges between entities. Person→Company (role: CTO, started: 2024-01), Person→Person (relationship: co-founded company together), Company→Deal (type: Series A, date: 2025-03). Enables graph queries that markdown grep can't answer: "who do I know who's invested in AI infrastructure companies?" becomes a traversal, not a prayer.

### Why This Matters

- **Identity resolution** becomes a database operation (merge entity IDs), not a file-merge operation with manual cross-reference fixups
- **Contradictions are structural** (two facts with different values for the same field and different sources) rather than textual (hoping the LLM notices a discrepancy buried in prose)
- **Concurrency is solved** — events append to a ledger, facts upsert to a store, markdown is rebuilt. No more merge conflicts on shared files
- **Graph queries work** — "who do I know at this company?" and "what companies has this investor backed that I also know the founders of?" become database queries, not impossible grep chains

### File-Layer Conventions

The markdown layer uses conventions that map directly to the database primitives:

1. **Use frontmatter for structured metadata** — anything you'd want to query (role, company, stage, score, tags) goes in YAML frontmatter, not buried in prose. These map to the fact store.
2. **Use `.raw/` for provenance** — save every API response with source and timestamp. These map to provenance records in the fact store.
3. **Treat the timeline as an event stream** — dated, sourced, append-only. These map to the event ledger.
4. **Keep compiled truth conceptually separate from evidence** — above the line is synthesis; below the line is evidence. The synthesis is a generated view; the evidence is queryable records.
5. **Use canonical slugs consistently** — every cross-reference uses the filename slug. These are the entity IDs in the registry.

## Directory Structure

```
brain/
├── RESOLVER.md        — master decision tree for filing (agent reads this first)
├── schema.md          — page conventions, templates, workflows
├── index.md           — content catalog with one-line summaries
├── log.md             — chronological record of all ingests/updates
├── people/            — one page per human being (maintainers, researchers, authors)
│   ├── README.md      — resolver: what goes here, what doesn't
│   └── .raw/          — raw API responses per person (JSON sidecars)
├── companies/         — one page per tech organization (Anthropic, OpenAI, Vercel, xAI…)
│   ├── README.md
│   └── .raw/
├── libraries/         — one page per software library you use or track (React, Convex, Zod…)
│   └── README.md
├── ai-tools/          — one page per AI product/model/agent (Claude Code, Cursor, GPT-5…)
│   └── README.md
├── repos/             — one page per git repo you own or closely follow
│   └── README.md
├── patterns/          — reusable code patterns, idioms, snippets
│   └── README.md
├── papers/            — research papers (arxiv, conference proceedings)
│   └── README.md
├── talks/             — conference talks, podcasts, video lectures
│   └── README.md
├── books/             — technical books, long-form reference material
│   └── README.md
├── projects/          — things you're actively building (has a repo, spec, or team)
│   └── README.md
├── meetings/          — records of specific events with transcripts
│   └── README.md
├── ideas/             — raw possibilities nobody is building yet
│   └── README.md
├── concepts/          — mental models and frameworks you'd teach (not tied to a specific lib)
│   └── README.md
├── originals/         — your own original thinking (theses, frameworks, observations you generated)
│   └── README.md
├── writing/           — prose artifacts (essays, blog drafts, design docs)
│   └── README.md
├── prompts/           — reusable LLM prompt library
├── sources/           — raw data imports and archived snapshots
│   └── README.md
├── agent/             — briefings, digests, research produced by your agent
│   └── README.md
├── inbox/             — unsorted quick captures (temporary)
├── archive/           — dead pages, historical record
└── templates/         — page templates (structural, not content)
```

Every knowledge directory has a README.md resolver. Adapt directories to your work — add or remove domains as needed. Not everyone needs `books/` or `talks/` if they rarely track those. The invariant is: **one directory per knowledge domain, one file per entity, every directory has a resolver, and RESOLVER.md is the master decision tree that guarantees MECE filing.**

### The seven tech-specific directories

GBrain (upstream) is built for VCs and founders — its taxonomy emphasizes `deals/`, `hiring/`, `civic/`, `org/`, `media/`, `household/`. PBrain drops all of those and adds seven directories that matter to a working engineer:

- **`libraries/`** — software packages you depend on. One page per lib. Track version pinned, upgrade notes, gotchas, why you chose it.
- **`ai-tools/`** — AI products, models, agent runtimes. One page per tool. Track capabilities, pricing, your actual usage pattern, known failure modes.
- **`repos/`** — git repositories (your own, plus upstream projects you follow closely). One page per repo. Track architecture, key files, active work, PR hygiene.
- **`patterns/`** — reusable code patterns (auth flows, error-handling idioms, testing shapes). Small, tactical, portable across projects.
- **`papers/`** — research papers you've read or want to read. Abstract + your notes + cross-links to concepts the paper introduces.
- **`talks/`** — conference talks, podcasts, video essays. Timestamped highlights + takeaways.
- **`books/`** — technical books, long reference material. Chapter-level notes + recurring ideas.

## Entity Identity and Deduplication

In a system fed by meetings, email, social media, contacts, and APIs, **entity identity is the first real failure mode.** Without a canonical identity layer, you will end up with subtle split-brain pages — "Jane Smith" from a meeting transcript and "J. Smith" from an email and "jsmith" from Twitter all creating separate pages for the same person.

### Canonical slugs

Every entity gets a canonical slug that serves as its stable ID:
- People: `first-last.md` (all lowercase, hyphens for spaces)
- Companies: `company-name.md`
- If collisions arise, disambiguate: `david-liu-crustdata.md`, `david-liu-meta.md`

The filename IS the identity. All references, cross-links, and .raw/ sidecars use this slug.

### Aliases

People have many names across sources. The frontmatter `aliases` field captures all known variants:

```yaml
aliases: ["Jenny Shao", "Jenny G. Shao", "JennyGShao", "jennifer.shao@company.com"]
```

Aliases include: misspellings from meeting transcripts, maiden names, nicknames, email addresses, social handles, and phonetic variants. When the enrich skill encounters a new name variant for a known entity, it adds the variant to aliases — it does NOT create a new page.

### Deduplication protocol

Before creating any new page, the agent must:
1. Search existing pages by name (exact and fuzzy)
2. Search aliases across all pages: `grep -rl "NAME_VARIANT" /data/brain/people/ --include="*.md"`
3. Check .raw/ sidecars for matching email addresses or social handles
4. If a match is found → UPDATE the existing page (add alias if the name variant is new)
5. If no match → CREATE a new page

### Merge protocol

When you discover two pages are the same person:
1. Pick the more complete page as the survivor
2. Merge all timeline entries from the duplicate into the survivor (chronological order)
3. Merge all aliases
4. Update all cross-references that pointed to the duplicate
5. Delete the duplicate
6. Commit with message: `merge: [duplicate] into [survivor]`

During weekly lint, actively look for potential duplicates: similar names, same company, same email across different pages.

## Key Disambiguation Rules

The most common filing confusions and how to resolve them:

- **Concept vs. Idea:** Could you *teach* it as a framework? → concept. Could you *build* it? → idea.
- **Concept vs. Pattern:** A concept is a mental model you'd teach ("eventual consistency"). A pattern is a concrete code shape you'd copy ("optimistic UI with rollback").
- **Idea vs. Project:** Is anyone working on it? Yes → project. No → idea. The graduation moment is when work starts.
- **Library vs. AI-tool:** A library is code you import (`npm install zod`). An AI-tool is a product/service you interact with (Claude Code, Cursor, OpenAI API). If you `curl` it, it's an ai-tool; if you `import` it, it's a library. When something is both (e.g., Vercel AI SDK is a library that wraps AI-tool providers), file under the one you primarily *use it as*.
- **Library vs. Repo:** Libraries are what you consume. Repos are what you build, own, or closely follow as source trees. Your own `pbrain` repo → `repos/`. `react` (the thing you `npm install`) → `libraries/`. If you're contributing upstream, cross-link both.
- **Pattern vs. Library:** Patterns are language/framework-agnostic shapes (retry-with-jitter, idempotent handlers). Libraries are named packages. If you find yourself writing "this is how `zod` does it", file under `libraries/zod.md` not `patterns/`.
- **Paper vs. Concept:** A paper is *the artifact* (Vaswani et al. 2017). A concept is *the idea the paper introduced* (attention mechanism). The paper page links to the concept page.
- **Talk vs. Paper:** Talks are performances; papers are written artifacts. A conference talk adapted from a paper gets both pages, cross-linked.
- **Book vs. Paper:** Books are long reference works (Designing Data-Intensive Applications). Papers are short self-contained research. If in doubt: did it get a DOI or an ISBN?
- **Writing vs. Concepts:** A concept page is distilled (200 words of compiled truth). An essay is developed prose (argument, narrative, story).
- **Person vs. Company:** Is it about *them as a human*? → people/. Is it about *the organization*? → companies/. Both pages link to each other.
- **Sources vs. .raw/ sidecars:** Per-entity enrichment data → .raw/ sidecar. Bulk multi-entity imports → sources/.

When nothing fits, file in inbox/ and flag it. That's a signal the schema needs to evolve.

## Page Types and Templates

### Person

The most important page type. A great person page is a well-researched briefing — not a LinkedIn scrape.

```markdown
# Person Name

> Executive summary: who they are, why they matter, what you should
> know walking into any interaction with them.

## State
- **Role:** Current title
- **Company:** Current org
- **Relationship:** To you (friend, colleague, investor, etc.)
- **Key context:** 2-4 bullets of what matters right now

## What They Believe
Worldview, positions, first principles. The hills they die on.
Every claim must cite its source and type:
- [Belief] — observed: [tweet/meeting/article, date]
- [Belief] — self-described: [interview/bio, date]
- [Belief] — inferred: [pattern across N interactions, confidence: high/medium/low]

## What They're Building
Current projects, recent ships, product direction.

## What Motivates Them
Ambition drivers, career arc, what gets them out of bed.
Distinguish between what they say motivates them (self-described) and
what their behavior suggests (observed/inferred).

## Communication Style
How they prefer to communicate. How they handle disagreement.
What energizes them in conversation.
This section is high-value but requires careful sourcing.
Rules: only write here from direct observation (meeting behavior,
language in emails/tweets, visible patterns). Never generalize
from a single data point. Mark confidence level.

## Hobby Horses
Topics they return to obsessively. Recurring themes in their public voice.

## Assessment
- **Strengths:** What they're great at. Be specific.
- **Gaps:** Where they could grow. Be specific and fair.
- **Net read:** One-line synthesis.
- **Confidence:** high (5+ interactions) / medium (2-4) / low (1 or inferred)
- **Last assessed:** YYYY-MM-DD

## Trajectory
Ascending, plateauing, pivoting, declining? Evidence.

## Relationship
History of interactions, temperature, dynamic.

## Contact
- Email, phone, LinkedIn, X handle, location

## Network
- **Close to:** People they're frequently seen with
- **Crew:** Which cluster they belong to

## Open Threads
- Active items, pending intros, follow-ups

---

## Timeline
- **YYYY-MM-DD** | Source — What happened.
```

All sections are optional — include what you have, leave empty sections as `[No data yet]` rather than omitting them. **The structure itself is a prompt for future enrichment.** When a section says `[No data yet]`, the agent knows what to look for next time it encounters this person.

The principle: facts are table stakes. Context is the value.

### Epistemic discipline on people pages

The context sections (Beliefs, Motivations, Communication Style, Assessment) are the highest-value parts of the system but also the most prone to hallucination. An agent can over-generalize from sparse evidence or overfit to one recent interaction. Rules:

- **Every claim cites its source.** Not "she's aggressive" but "she pushed back hard on pricing in the March 15 meeting (observed)."
- **Three source types:** `observed` (you saw it happen), `self-described` (they said it about themselves), `inferred` (you're reading between lines). Label each.
- **Confidence tracks interaction count.** One meeting = low confidence. Five meetings = high. Don't write definitive assessments from thin data.
- **Recency matters.** A belief from 2 years ago may not be current. Mark dates.
- **Never generalize from a single data point.** "She seemed frustrated in one meeting" is a timeline entry. Patterns require multiple observations.
- **The user's corrections override everything.** If the user says "that's wrong about her," update immediately — that correction is the highest-confidence signal in the system.

### Company (tech-org perspective)

PBrain tracks companies as tech organizations, not investment targets. No Stage, no
valuation, no investors. What matters: what they ship, what you use, where they're
going.

```markdown
# Company Name

> One-line summary: what they make, why you care, what's shipping now.

## What they make
Product / service line. Bullet the actual offerings (models, APIs, CLIs,
hosted services). Each offering links to the relevant `ai-tools/`, `libraries/`,
or `repos/` page if one exists.

## Current offerings
- **[Offering name]** — what it does, pricing tier if relevant, what you use it for
- …

## Direction
Where they're going. Recent announcements, roadmap signals, public strategy statements.
Cite sources — blog posts, interviews, release notes. Don't speculate.

## My usage
How YOU actually use this company's products. Be specific: which endpoints, which
model, typical request volume, what you'd switch to if they disappeared tomorrow.
If you don't use them, say so and explain why they're tracked anyway.

## Key people
Links to `people/` pages for the CEO, research lead, head of DX, notable ICs. Not
investors, not board members.
- [Name](../people/slug.md) — role, why they matter to you

## Open Threads
- Things to watch, API changes to test, pricing shifts to model

---

## Timeline
- **YYYY-MM-DD** | Source — What happened.
```

### Library

```markdown
# Library Name

> What it does, why you use it, version you're on.

## State
- **Package:** `@scope/name` (npm) / `package-name` (PyPI/crates.io/etc.)
- **Version pinned:** X.Y.Z (as of YYYY-MM-DD)
- **Role in your stack:** One line — auth, validation, state, etc.
- **Language/runtime:** TypeScript, Python, Rust, etc.
- **License:** MIT / Apache-2.0 / etc.
- **Home:** Repo URL, docs URL

## Why you chose it
The 2–3 reasons you picked this over alternatives. Include the alternatives you
rejected and why, so future-you doesn't re-litigate the decision.

## How you use it
Concrete patterns: which APIs, which config, common call shapes. Link to
`patterns/` pages for reusable idioms.

## Gotchas
Known sharp edges. Bugs you've hit. Version-specific issues. Workarounds.

## Upgrade notes
Outstanding upgrades. Breaking changes in newer versions. Migration checklist if
you're mid-upgrade.

## Alternatives considered
Libraries you rejected or might switch to. One line each on why.

## Open Threads

---

## Timeline
```

### AI-tool

```markdown
# Tool Name

> What it does, what you use it for, pricing tier.

## State
- **Provider:** [Company](../companies/slug.md)
- **Type:** Model / IDE extension / CLI / hosted service / agent runtime
- **Tier:** Free / Pro / Team / Enterprise (and what YOU pay)
- **Access method:** API, CLI, web, IDE plugin
- **Current version/model:** exact identifier

## Capabilities
What it can actually do — specific, not marketing. Test your assumptions.

## My usage
Real workflow: when you reach for it, which tasks, rough daily/weekly volume.
What you'd switch to if it disappeared.

## Pricing model
Tokens, seats, requests — whichever axis. Your observed cost per month.

## Known failure modes
Where it fails for you. Tasks it refuses, hallucinates on, or handles worse
than alternatives.

## Alternatives
Competing tools you've tried or could switch to.

## Open Threads

---

## Timeline
- **YYYY-MM-DD** | Release — New capability, pricing change, deprecation.
```

### Repo

```markdown
# owner/repo

> What it is, your relationship to it (owner / contributor / watcher).

## State
- **URL:** github.com/owner/repo
- **Relationship:** owner / contributor / follower
- **Primary language:** Language
- **License:** SPDX id
- **Stars / last release:** as of YYYY-MM-DD (context, not vanity)

## Architecture
High-level map. What directories matter, what the entry points are, where business
logic lives. Link to `patterns/` for idioms used.

## Key files
- `path/to/file.ts` — what lives here, why it matters
- …

## Active work
What's in-flight. Current branch focus. Open PRs you care about.

## Contributions
If you contribute upstream: PRs merged, open issues you've filed, maintainer
relationships.

## Open Threads

---

## Timeline
```

### Pattern

```markdown
# Pattern Name

> One-line description of the shape.

## Problem
The situation this pattern solves. Be concrete — describe a scenario where you'd
reach for this.

## Shape
The essence of the pattern — pseudocode, diagram, or minimal code. Keep it small.

```lang
// minimal illustrative code
```

## When to use
Situations where this fits. Scale, concurrency, consistency requirements.

## When not to use
Situations where the pattern is overkill or actively wrong.

## Variations
Named variants. Which situation each fits.

## Seen in
Concrete instances — libraries, repos, papers where this pattern appears.
Cross-link to them.

## Open Threads

---

## Timeline
```

### Paper

```markdown
# Paper Title

> One-line: what they proved, why it matters, year.

## Citation
Full reference. DOI or arxiv ID. Authors as links to `people/` pages if they have
brain pages.

## Abstract
Author's abstract, verbatim. Don't paraphrase.

## My summary
YOUR take. What the paper actually says in plain terms. What surprised you. What
you'd cite it for.

## Key ideas
- **[Idea]** — what it means, where it shows up later. Link to `concepts/` page.

## Relevance to your work
Why this matters to what you're building. Be specific.

## Related
- Papers it builds on
- Papers it was later superseded by
- Concepts it introduced

## Open Threads

---

## Timeline
- **YYYY-MM-DD** | Read / re-read / cited — context.
```

### Talk

```markdown
# Talk Title — Speaker

> One-line: what the talk argues, venue/year.

## Source
- **Speaker:** [Name](../people/slug.md)
- **Venue:** Conference, podcast, YouTube
- **Date:** YYYY-MM-DD
- **URL:** link to recording

## My notes
Timestamped highlights. Skip the intro; capture the substantive arguments.
- **[MM:SS]** — what's being said, what's worth remembering

## Takeaways
3–5 durable ideas you'd bring into your own work.

## Follow-ups
- Things mentioned you want to investigate
- Libraries or tools they reference

---

## Timeline
```

### Book

```markdown
# Book Title — Author

> One-line argument of the book, why it's durable.

## State
- **Author:** [Name](../people/slug.md)
- **Edition / year:** as it matters
- **ISBN:** if tracking
- **Status:** reading / finished / reference

## Structure
Chapter map or section outline. Useful when returning to the book.

## My notes
Chapter-level or section-level notes. Direct quotes you'd cite — mark with > and
page number.

## Recurring ideas
Themes that show up across chapters. Link to `concepts/` pages.

## Related
- Books that pair with this one
- Papers / talks by the same author

## Open Threads

---

## Timeline
```

### Meeting

```markdown
# Meeting Title

> YOUR analysis — not a copy of the AI meeting notes.
> What matters given everything else going on.
> What was decided. What was left unsaid.

## Attendees
## Key Decisions
## Action Items
## Connections to other brain pages

---

## Full Transcript
```

### Deal, Project, Concept — same pattern. Compiled truth on top, timeline on bottom.

## The Enrichment Pipeline

**This is the most important operational pattern.** Every time your agent encounters a person or company — in a meeting, email, tweet, calendar event, contact sync — it should enrich the corresponding brain page.

Enrichment is not just "look up their LinkedIn." It's:

- **What they believe** — positions, worldview, public stances
- **What they're building** — current projects, what's shipping
- **What motivates them** — ambition, career trajectory
- **Their communication style** — how they engage, what energizes them
- **Their relationship to you** — history, context, open threads
- **Hard facts** — role, company, contact info, funding (table stakes)

Facts are table stakes. Context is the value.

### When to enrich

**Any time** a person or company signal appears:
- Someone is mentioned in a meeting transcript → enrich
- Someone emails you → enrich
- Someone interacts with you on social media → enrich
- A new contact appears → enrich
- You mention someone in conversation and their page is thin → enrich
- A company announces funding, ships a product, makes news → enrich

### Enrichment sources (in order of value)

1. **Your own interactions** — what you said about them, what they said to you (highest signal)
2. **Meeting transcripts** — richest context source
3. **Email threads** — tone, urgency, relationship dynamics
4. **Social media** — beliefs, public positioning, who they engage with
5. **Web search** — background, press, talks
6. **People APIs** — structured profile data (career history, education, skills, contact info)
7. **Company APIs** — funding, investors, valuations, headcount, financials
8. **Contact data** — email, phone, location

### Data source skills

Each external data source should be its own named skill with full API documentation, auth patterns, and usage notes. The enrich skill orchestrates them — it decides *which* sources to call based on tier, then delegates to the individual skill for *how* to call the API.

This keeps things DRY: the enrich skill owns the logic (when to enrich, what tier, what to extract), and each data source skill owns the API contract (endpoints, auth, rate limits, gotchas, validation rules).

Recommended data source skills (tech-focused):

- **Web search** — broad keyword search (Brave, Google, etc.). Quick background, release notes, changelogs.
- **Semantic search** — better than keyword for finding technical writing, blog posts, design docs. (Exa, Perplexity, etc.)
- **Social search** — X/Twitter, Bluesky, Mastodon for public voice: what maintainers are saying, release announcements, debate threads.
- **GitHub API** — for repos and libraries: stars, releases, recent commits, open PRs/issues, contributor list, CODEOWNERS. The single most valuable source for engineering context.
- **Package registries** — `npm registry`, `PyPI`, `crates.io`, `pkg.go.dev`: version history, dependency trees, download stats, maintainer identity, security advisories.
- **arxiv.org / Semantic Scholar** — for papers: abstract, citations, related work, author profiles.
- **Product docs** — `docs.anthropic.com`, OpenAI API reference, model cards, changelog pages. These are primary sources for what an AI tool can actually do.
- **Conference / podcast feeds** — curated talk indexes (InfoQ, GOTO, Strange Loop archives), podcast RSS, YouTube channels for tech talks.
- **Meeting history** — search past meetings for interactions with this entity. (Circleback, Otter, Fireflies, etc.)

The typical enrichment flow for a new person (engineer/researcher/maintainer):
1. **Web search** → find personal site, blog, employer, public role
2. **GitHub API** → their repos, contributions, PRs to notable projects, language mix
3. **Social search** → their technical voice, what they engage with, recent takes
4. **Semantic search** → long-form writing, conference talks, podcast appearances
5. **Meeting history** → past interactions with you

For a new tech company:
1. **Web search** → product page, pricing, blog, model/release pages
2. **Product docs** → what their API/tool actually does, capability surface
3. **GitHub API** → if they have public repos, open-source strategy, release cadence
4. **Social search** → public positioning, CEO/research-lead posts, launch reactions
5. **People enrichment** → enrich their founders/research leads/head of DX (triggers person enrichment)

For a new library:
1. **Package registry** → version history, dependencies, maintainer, license
2. **GitHub API** → repo health, recent activity, open issues, CODEOWNERS
3. **Product docs** → API surface, examples, migration guides
4. **Web search** → blog posts about using it, comparison articles, known gotchas
5. **People enrichment** → enrich the primary maintainer(s) (triggers person enrichment)

For a new AI tool:
1. **Product docs** → current model/version, capability surface, pricing
2. **Web search** → recent announcements, release notes, benchmark comparisons
3. **Social search** → what users are saying, failure modes reported publicly
4. **People enrichment** → enrich the provider company (triggers company enrichment)

For a new paper:
1. **arxiv.org / Semantic Scholar** → abstract, authors, citations
2. **Web search** → blog posts explaining the paper, author Twitter threads, discussion
3. **People enrichment** → authors with notable work (triggers person enrichment)

### Enrichment tiers (don't over-enrich)

- **Tier 1 (key people):** Full pipeline — all sources. Inner circle, business partners, important collaborators.
- **Tier 2 (notable):** Web search + social + brain cross-reference. People you interact with occasionally.
- **Tier 3 (minor mentions):** Extract signal from source only, append to timeline. Everyone else worth tracking.

A thin page with real interaction data is better than a fat page stuffed with generic web results. Don't waste 10 API calls on someone with no public presence.

### Raw data sidecars

Every enrichment API response gets saved as a JSON sidecar:

```
people/jane-doe.md              ← brain page (curated, readable)
people/.raw/jane-doe.json       ← raw API responses
```

The JSON is keyed by source with fetch timestamps:

```json
{
  "sources": {
    "crustdata": { "fetched_at": "2026-04-05T...", "data": { ... } },
    "web_search": { "fetched_at": "...", "data": { ... } }
  }
}
```

The brain page is the distilled version. Raw data is the archive.

What goes in the brain page (distilled): location, current title, company, headline, education (one line), career arc (condensed), top skills, social handles, profile picture permalink.

What stays in .raw/ only: full work history with job descriptions, complete skill lists, company descriptions for each employer, platform-specific IDs, follower/connection counts, full API response bodies.

When re-enriching: overwrite the source key with fresh data + new timestamp. Don't append — replace.

### Validation rules

When auto-enriching from people/company APIs:
- **Low connection/follower count (e.g., <20):** Likely wrong person. Save to .raw/ with a `"validation": "low_connections"` flag. Don't auto-write to the brain page.
- **Name mismatch:** If the returned name doesn't share a last name with the entity, skip.
- **Obviously joke profiles:** Career arcs mentioning absurd titles — skip.
- **When in doubt:** Save raw data but don't update the brain page. Wrong data is worse than no data.

### Browser budget

If enrichment involves browser-based lookups (LinkedIn, authenticated pages), set a daily budget (e.g., 20 lookups/day) to avoid account flagging. Prefer API-based enrichment services for bulk work — they don't touch the user's browser session.

## Entry Criteria — Who Gets a Page

Not everyone deserves a brain page. Scale page creation to relationship importance:

**Always create a page for:**
- Anyone you've had a 1:1 or small-group meeting with
- Key colleagues, partners, and direct collaborators
- Anyone with a strong working relationship or better
- Family, close friends, inner circle

**Create if signal exists:**
- People from contacts with recent interaction
- Anyone mentioned by name in conversation with context
- Event contacts with multiple shared events

**Do NOT create:**
- Random names from mass event guest lists with no interaction
- Single-name entries with no identifying context
- Contacts with no relationship signal at all

When in doubt: does the user benefit from this entry existing? If no, skip it.

## The Skill Architecture

Skills are the modular building blocks of the system. There are three types, and understanding how they compose is critical.

### 1. Data source skills (leaf nodes)

Each external API or data source gets its own named skill. The skill owns the API contract: endpoints, authentication, rate limits, error handling, validation rules, and what the response looks like.

Examples:
- **People enrichment** (Crustdata, Proxycurl, People Data Labs) — structured LinkedIn-like data
- **Network search** (Happenstance, Clay) — search professional network, find mutual connections
- **Company intelligence** (Captain API/Pitchbook, Crunchbase) — funding, investors, financials
- **Semantic search** (Exa, Perplexity) — find LinkedIn URLs, personal sites, writing
- **Meeting history** (Circleback, Otter, Fireflies) — past meeting transcripts and notes
- **Calendar/contacts** (Google Calendar, Google Contacts via integration tools) — schedule, contact info
- **Social media** (X API, Bluesky API) — public posts, engagement, follower data
- **Workspace tools** (Gmail, Slack, Drive via integration tools) — email threads, messages, documents

Data source skills are **never called directly by the user.** They're called by orchestration skills (below).

### 2. Orchestration skills (coordinators)

These skills contain the *logic* — they decide what to do, then delegate to data source skills for how to do it.

**The enrich skill** is the most important orchestration skill. It decides:
- Is this a CREATE (new page) or UPDATE (new signal)?
- What tier is this entity? (determines which data sources to call)
- What signal types to extract from the source material?
- Which data source skills to call, in what order?
- How to write the results to the brain?

Other orchestration skills:
- **Meeting ingestion** — pulls meetings from a meeting tool, creates brain meeting pages with analysis, then calls enrich for every attendee and company discussed
- **Email triage / executive assistant** — processes inbox, handles scheduling, then calls enrich when it encounters people or companies
- **Social monitoring** — scans public social media for mentions and engagement, then calls enrich for notable accounts

### 3. Pipeline skills (end-to-end workflows)

These are the user-facing skills that chain multiple orchestration and data source skills together:
- **Morning briefing** — reads calendar + tasks + brain state + recent signals → produces a briefing
- **Person research** — given a name, runs full Tier 1 enrichment and presents the result
- **Weekly brain maintenance** — runs lint, flags stale pages, suggests enrichment targets

### How they compose

```
User says "tell me about Jane Doe"
  → Agent searches brain (grep/index)
  → Page is thin → calls enrich skill (orchestration)
    → enrich determines Tier 1
    → calls happenstance skill (data source) → gets LinkedIn URL
    → calls crustdata skill (data source) → gets full profile
    → calls exa skill (data source) → finds personal writing
    → calls web_search (built-in tool) → gets press coverage
    → calls meeting history (data source) → finds past meetings
    → writes brain page, saves .raw/ sidecar, cross-references
  → Agent presents the enriched page to user
```

```
Cron fires "meeting ingestion" every afternoon
  → meeting-ingestion skill (orchestration) pulls new meetings
  → for each meeting: creates brain meeting page
  → for each attendee: calls enrich skill (orchestration)
    → enrich calls relevant data source skills based on tier
  → for each company discussed: calls enrich skill
  → extracts tasks, commits brain repo
```

The key insight: **data source skills are stateless and reusable.** The enrich skill can call Crustdata whether the trigger was a meeting, an email, a social mention, or a direct user request. The data source skill doesn't care where the request came from.

## How Enrich Wires Into Everything

The enrich skill is the central hub. Every ingest pathway converges on it:

```
Meeting ingestion ───────┬─────────────────────────┬─── people enrichment API
Email triage ────────────┤                         ├─── company intelligence API
Social monitoring ───────┤    ENRICH SKILL         ├─── network search API
Contact sync ────────────┤   (orchestration)       ├─── semantic search API
Manual conversation ─────┤                         ├─── social search API
Calendar events ─────────┤                         ├─── web search
Webhooks ────────────────┴─────────────────────────┴─── meeting history API
                              │
                              ▼
                         BRAIN REPO
                    (people/, companies/,
                     meetings/, deals/)
```

Every arrow into the enrich skill carries a **signal** (the raw information from the source) and an **entity** (the person or company to enrich). The enrich skill:

1. **Checks brain state** — does a page exist? Is it thin?
2. **Determines tier** — Tier 1 (full pipeline), Tier 2 (web + social + cross-ref), Tier 3 (source extraction only)
3. **Extracts signal** from the source material (beliefs, motivations, trajectory, facts)
4. **Calls data source skills** based on tier (each skill is a named, documented module)
5. **Writes to brain** — CREATE (via RESOLVER.md) or UPDATE (append timeline, update compiled truth)
6. **Cross-references** — updates all linked entity pages
7. **Saves raw data** to `.raw/` sidecar
8. **Commits** to the brain repo

The critical wiring rule: **every ingest skill must call enrich.** This is not optional or aspirational. It's structural. If a new ingest pathway is added (say, a Slack monitoring skill), its implementation must include "for each person/company mentioned, call the enrich skill." If that line is missing, the brain stops compounding from that source.

## Automated Cron Jobs

The brain doesn't just grow when you're actively using it. Cron jobs make the system autonomous — the brain is maintained, the inbox is triaged, meetings are ingested, and mentions are monitored even while you sleep.

### The cron architecture

Cron jobs run as **isolated agent sessions** — they get their own context, read their own skills, and don't block the main conversation thread. They can post to specific notification channels (Telegram topics, Slack channels, Discord threads) or work silently.

Each cron job is essentially: "wake up, read a skill, do the work, post results (or stay silent if nothing happened), go back to sleep."

### Recommended cron jobs for a brain-powered system

**High frequency (every 10-30 minutes):**
- **Email monitor** — scan inbox, classify by priority, post digest to a notification channel. Handle low-risk items (scheduling, acknowledgments) directly.
- **Message monitor** — check key communication channels for unreplied messages from important contacts. Surface them with suggested responses.

**Medium frequency (every 1-3 hours):**
- **Social radar** — scan public social media for mentions of you or your organization, engagement, emerging narratives. Alert on items that need attention. Call enrich for notable new accounts engaging with you.
- **Heartbeat** — the omnibus check. Calendar lookahead, task review, email scan, brain state review. Post if something needs attention; stay silent if not.

**Daily:**
- **Morning briefing** — calendar + tasks + urgent items + overnight signals → one notification. The "here's your day" message.
- **Task prep** — archive yesterday's completed tasks, build today's list from calendar + backlog + recurring items.
- **Meeting ingestion** — pull all new meetings from your meeting tool, run full ingestion (create meeting pages, propagate to entity pages, extract tasks). This is the heaviest cron job — it touches the most brain pages.
- **Social media collection** — archive your own posts, track engagement velocity, detect deletions. Feed into media/ pages.

**Weekly:**
- **Brain lint** — run the full maintenance pass: contradictions, stale pages, orphans, missing cross-references, MECE filing violations. Post a report.
- **Enrichment sweep** — find brain pages that haven't been enriched in 90+ days, or pages with many `[No data yet]` sections. Queue them for re-enrichment.
- **Contact sync** — pull recent additions from your contacts, cross-reference with brain. Create pages for significant new contacts.

### How crons feed the brain

The key insight: **cron jobs are the autonomous enrichment engine.** Without them, the brain only grows when you're actively talking to the agent. With them:

- The email monitor encounters a person → calls enrich → brain grows
- The meeting ingestion processes a transcript → calls enrich for every attendee → brain grows
- The social radar detects a new notable account → calls enrich → brain grows
- The contact sync finds a new contact → calls enrich → brain grows
- The enrichment sweep finds stale pages → calls enrich with fresh data → brain stays current

The brain compounds 24/7 because the cron jobs are wired to call enrich. The user sleeps; the brain doesn't.

### Cron job design rules

1. **Silent when nothing happens.** If a cron finds nothing new, it should produce no output. No "nothing to report" messages. This is critical — noisy crons get disabled.
2. **Post to specific channels.** Each cron posts to its designated notification channel (e.g., email cron → Emails topic, social radar → Social Alerts topic). Don't mix signals.
3. **Spawn sub-agents for heavy work.** The cron session should stay lightweight. If meeting ingestion needs to process 5 meetings and update 30 entity pages, spawn sub-agents for the entity propagation.
4. **Idempotent and checkpoint-aware.** Every cron should track what it's already processed (in a state file like `meeting-notes-state.json`) so it doesn't redo work on the next run.
5. **Respect quiet hours.** Don't post between 11 PM and 7 AM unless something is genuinely urgent. Crons should check the time before posting.
6. **Every ingest cron must call enrich.** This is the structural rule. A cron that processes meetings but doesn't enrich attendees is a bug, not a feature.

### Example: how it all fits together

A typical afternoon in an autonomous brain system:

1. **3:00 PM** — Email monitor cron fires. Scans inbox. Finds 3 new emails: a scheduling request, a funding announcement, and a founder asking for advice.
   - Handles the scheduling request directly (checks calendar, replies with available times)
   - Calls enrich on the company in the funding announcement → updates company page with new round
   - Posts the founder's email to notification channel for the user to handle

2. **3:15 PM** — Meeting ingestion cron fires. Finds 2 new meetings from today.
   - Creates 2 brain meeting pages with analysis
   - Calls enrich for 8 attendees across both meetings → updates 8 people pages
   - Calls enrich for 3 companies discussed → updates 3 company pages
   - Extracts 4 action items → adds to task list

3. **3:30 PM** — Social radar cron fires. Detects a journalist writing a thread about the user's organization.
   - Posts alert to Social Alerts channel
   - Calls enrich on the journalist → creates/updates their people page with recent activity

4. **4:00 PM** — Heartbeat fires. Calendar shows a meeting in 1 hour. Brain page for the attendee was last enriched 3 months ago.
   - Triggers a fresh enrichment pass on the attendee
   - Posts a prep note: "Meeting with X in 1 hour. Here's what's changed since you last met."

The user didn't ask for any of this. The brain grew by 12 pages and the user walked into their 4:00 PM meeting fully prepared — because the plumbing is wired correctly.

## Worked Examples From a Production System

These examples show how the architecture operates end-to-end. Names and specifics are genericized, but the skill chains are exact — every skill call, every file write, every cron trigger is how it actually works.

### Example 1: Meeting Ingestion — The Full Chain

A cron job fires at 3:00 PM daily with the prompt: "Read skills/meeting-ingestion/SKILL.md and process today's meetings."

**Step 1: Skill chain loads.** The meeting-ingestion skill's preamble says "Read skills/enrich/SKILL.md" — so the agent loads the enrichment protocol before touching any data. This is critical: it means the agent knows how to handle every person and company it encounters.

**Step 2: Pull new meetings.** The agent calls the meeting history data source skill (in this system, Circleback). It checks a state file (`memory/meeting-notes-state.json`) that tracks the last processed meeting ID. Finds 2 new meetings since last run.

**Step 3: Process Meeting 1 — "Product Review with Sarah Chen and Mike Torres."**

The agent creates `brain/meetings/2026-04-07-product-review.md` with:
- Its own analysis above the line (not a copy of the AI summary — reframed through what the brain already knows about the attendees and the project)
- Key decisions, action items, and connections to other brain pages
- Full transcript below the line

**Step 4: Enrich attendees.**

For **Sarah Chen** — the agent searches the brain: `grep -rl "Sarah Chen" /data/brain/people/`. Finds `people/sarah-chen.md`. Reads it. Page was last enriched 2 weeks ago and has good coverage. → **Tier 3**: extract signal from this meeting only. Appends to her timeline: "2026-04-07 | Meeting — Pushed back on timeline for launch, wants more QA. Concerned about API stability." Updates her Open Threads with the new follow-up item.

For **Mike Torres** — brain search finds `people/mike-torres.md`. Page exists but is thin: just a name, title, and one previous meeting entry. → **Tier 2**: web search + social + brain cross-reference. Agent finds his recent blog posts (feeds into What They Believe), his X activity (feeds into Hobby Horses), and cross-references him with two other brain pages that mention him. Updates compiled truth above the line.

For **"Alex from Meridian Labs"** (mentioned in the meeting but not an attendee) — brain search finds nothing. → **CREATE path**:
1. Reads RESOLVER.md: "a specific named person" → `people/`
2. Creates `people/alex-rivera.md` using the person template from schema.md
3. Runs **Tier 1 enrichment** (full pipeline): network search → finds LinkedIn URL. People enrichment API → full structured profile. Semantic search → finds a conference talk. Web search → finds press coverage of Meridian Labs' recent funding.
4. Saves raw API responses to `people/.raw/alex-rivera.json`
5. Cross-references: updates `companies/meridian-labs.md` to link to Alex's page

**Step 5: Enrich companies discussed.** Meridian Labs was discussed extensively. Agent checks `companies/meridian-labs.md` — exists but funding data is 4 months stale. Calls company intelligence API → gets fresh round data. Updates the page.

**Step 6: Extract action items.** Finds 3 action items in the transcript → appends to `ops/tasks.md`.

**Step 7: Repeat for Meeting 2.** Same flow.

**Step 8: Commit and notify.**
```bash
cd /data/brain && git add -A && git commit -m "meetings: 2026-04-07 product review, investor sync" && git push
```
Posts summary to the Meetings notification channel: "Processed 2 meetings. Created 1 new person page (Alex Rivera). Updated 4 entity pages. 5 action items extracted."

**Files touched in this run:**
```
brain/
├── meetings/
│   ├── 2026-04-07-product-review.md          (CREATED)
│   └── 2026-04-07-investor-sync.md           (CREATED)
├── people/
│   ├── sarah-chen.md                          (UPDATED — timeline + open threads)
│   ├── mike-torres.md                         (UPDATED — Tier 2 enrichment)
│   ├── alex-rivera.md                         (CREATED — Tier 1 enrichment)
│   └── .raw/
│       └── alex-rivera.json                   (CREATED — raw API responses)
├── companies/
│   └── meridian-labs.md                       (UPDATED — fresh funding data)
ops/
└── tasks.md                                   (UPDATED — 5 new action items)
memory/
└── meeting-notes-state.json                   (UPDATED — checkpoint)
```

### Example 2: Email Triage — Resolver + Enrichment in Action

An email monitor cron fires at 12:00 PM. Its prompt: "Read skills/executive-assistant/SKILL.md and skills/gmail/SKILL.md. Triage the inbox."

**Step 1: Pull inbox.** The agent calls the Gmail data source skill via its workspace integration. Gets 8 new emails since last check.

**Step 2: Classify and handle.** Most emails are routine: 2 scheduling confirmations (handled directly — checks calendar, sends confirmations), 3 newsletters (archived), 1 internal FYI (noted). But one stands out:

**An email from "Priya Nair <priya@convex.dev>"** — subject: "Heads up — breaking change in Convex 1.20 that affects your usage pattern." The agent has never seen this person before.

**Step 3: Enrich the unknown sender.**

The agent calls the enrich skill. Enrich searches the brain:
```bash
grep -rl "Priya Nair" /data/brain/people/ --include="*.md"  # no results
grep -rl "priya@convex" /data/brain/people/ --include="*.md"  # no results (alias search)
grep -rl "convex" /data/brain/libraries/ --include="*.md"    # finds libraries/convex.md
grep -rl "convex" /data/brain/companies/ --include="*.md"    # finds companies/convex.md
```

Person: no match. Library and company: already tracked. → **CREATE path for the person.**

1. Reads RESOLVER.md: "a specific named person" → `people/`
2. Runs **Tier 2 enrichment** (maintainer of a library you depend on — worth real context):
   - Web search: finds her profile on the Convex team page. DX engineer. Previously at a major DB vendor.
   - GitHub API: finds `priya-n` account. Top contributor to `get-convex/convex-backend`. Recent commits on the reactor module.
   - Social search: finds her X. Posts about DX, query engines, the Convex 1.20 migration thread.
   - Brain cross-reference: already links to `libraries/convex.md` and `companies/convex.md`. Updates those pages' Key people sections to list her.
3. Creates `people/priya-nair.md` with role, focus area, GitHub handle, Convex connection.

**Step 4: Back in the EA skill.** Now the agent has context. It classifies the email:
- Priority: High (breaking change affecting a library you depend on)
- Context: Priya is a Convex DX engineer. You pin Convex at 1.19 in `repos/pbrain/package.json`. Your `libraries/convex.md` has a known-gotcha about the reactor module she committed to.
- Action needed: User should read the migration steps before upgrading

Posts to the Emails notification channel:
> **Convex 1.20 breaking change — affects your usage**
> From: Priya Nair (DX at Convex)
> She's flagging a reactor-module change between 1.19 (what you're on) and 1.20. Your `libraries/convex.md` already tracks a known gotcha in this area.
> Related: `libraries/convex.md` → upgrade notes, `companies/convex.md` → direction.
> [Open in Gmail](link)

**The email monitor didn't just triage — it grew the brain by one person page** and cross-linked her to two existing pages (the library and the company), so the next time Convex ships a release note, enrich already knows who's behind it.

### Example 3: The Compound Effect — How Context Builds Before a Meeting

This example shows how a completely unknown person becomes a rich brain page across 4 autonomous cron runs over 48 hours, with zero manual intervention. The result: you walk into a meeting fully prepared.

**Hour 0 — Social radar cron (Tuesday, 3:00 PM)**

The social radar cron scans for mentions and engagement on X. It detects a reply to one of the user's posts from an account named `@lena_builds` — a thoughtful, technical response about developer tooling that got 50+ likes.

The agent calls enrich. Brain search: no match for "Lena" or "lena_builds." → **CREATE, Tier 3** (minor mention — just a social interaction, not a relationship yet).

Creates `people/lena-kovac.md` with minimal data: X handle, display name, the reply text, and a note that she seems technical. No API calls — Tier 3 is source-extraction only.

```markdown
# Lena Kovac

> Technical builder. Engaged with a post about developer tooling on X.

## State
- **X:** @lena_builds
- **Relationship:** None yet — social interaction only
- **Confidence:** low (1 interaction)

---

## Timeline
- **2026-04-07** | X reply — Replied to post about developer tools.
  Thoughtful technical take on compiler-driven UX. 50+ likes.
```

**Hour 18 — Email monitor cron (Wednesday, 9:00 AM)**

The morning email sweep finds an email from `lena@kovac.dev` — subject: "Loved your talk at the devtools summit — would love to chat about what we're building."

The agent calls enrich. Searches the brain:
```bash
grep -rl "lena" /data/brain/people/ --include="*.md"  # finds people/lena-kovac.md
grep -rl "kovac.dev" /data/brain/people/ --include="*.md"  # no alias match yet
```

Finds the existing page. Reads it — it's thin (Tier 3, just the X reply). The email adds a new signal AND an email address. → **Upgrade to Tier 2.**

- Adds `lena@kovac.dev` to aliases in frontmatter
- Web search: finds her personal site (`kovac.dev`) — she's building a developer tools startup called Lattice. Previously at a major tech company on their compiler team.
- Social search: deeper X dive. She posts regularly about developer experience, compilers, and Rust. Has 3K followers.
- Brain cross-reference: searches for "Lattice" and "compiler" — finds a concept page about developer tooling that links to 2 companies in the same space.
- Updates `people/lena-kovac.md` with real substance: career history, what she's building, what she believes about developer tooling, her public voice.

**Hour 26 — Executive assistant cron (Wednesday, 5:00 PM)**

The afternoon EA sweep processes scheduling requests. One of the emails it triages is Lena's — she asked to chat. The user's calendar is open Thursday at 2 PM.

But the EA skill also checks: is there a calendar event already scheduled with this person? It searches the calendar — finds that Lena's email (`lena@kovac.dev`) appears in a calendar event for Thursday at 2 PM (she booked through the user's public booking link).

The EA skill sees the meeting is tomorrow. Calls enrich again. Page exists and is now Tier 2 with decent coverage, but there's a meeting tomorrow. → **Upgrade to Tier 1.**

- Network search: finds her LinkedIn URL. She has 2 mutual connections with the user.
- People enrichment API: full structured profile — Stanford CS, 4 years at a major tech company, founded Lattice 8 months ago.
- Semantic search: finds a conference talk she gave on "Why Developer Tools Are Stuck in 2015."
- Saves everything to `people/.raw/lena-kovac.json`
- Updates the brain page with full Tier 1 depth: beliefs, trajectory, what she's building, assessment, network connections.

**Hour 40 — Morning briefing cron (Thursday, 7:30 AM)**

The morning briefing cron builds the daily prep. It reads the calendar: meeting with Lena Kovac at 2 PM. It reads `people/lena-kovac.md` — which is now a rich page.

Produces a prep note in the daily briefing:

> **2:00 PM — Lena Kovac (Lattice)**
> Building a developer tools startup focused on compiler-driven UX. Stanford CS, 4 years on compilers at [major tech co]. Founded Lattice 8 months ago.
> She replied to your devtools post on X last Tuesday (the technical one about compiler-driven UX that got traction). Then emailed the next morning — "loved your talk, want to chat about what we're building."
> Her public writing argues that developer tools are stuck in a 2015 paradigm and that compiler intelligence should drive the entire editing experience. She gave a talk on this at DevTools Summit.
> 2 mutual connections. She's technical, has founder energy, and is building in a space you care about.

**The compound effect:** Lena went from unknown → thin Tier 3 page → substantive Tier 2 page → rich Tier 1 page → meeting prep note. Four cron runs over 48 hours. Zero manual enrichment requests. The user walks into the meeting knowing exactly who Lena is, what she cares about, and why she reached out — because every pipeline is wired to call enrich, and enrich knows how to escalate tier based on relationship signals.

This is the core insight of the brain system: **knowledge compounds autonomously when the plumbing is wired correctly.** Each cron job doesn't just do its own job — it feeds the enrichment pipeline, which feeds every future cron job. The meeting ingestion cron creates pages that the morning briefing cron reads. The email monitor enriches people that the social radar first detected. The whole system is a flywheel.

## Ingest Workflows

These are the specific ingest patterns. Each one calls enrich as its terminal step.

### Meeting ingestion

After every meeting (via Circleback, Otter, Fireflies, or manual notes):

1. Pull meeting notes + full transcript
2. Create a brain meeting page with **your own analysis** (not just regurgitated AI summary) — reframe through what you know about the attendees' world
3. **Propagate to entity pages** — call enrich for every person and company discussed. A meeting is NOT fully ingested until entity pages are updated.
4. Extract action items to task list
5. Commit

### Email ingestion

When processing email:
- Extract people and companies mentioned
- Call enrich with email context (tone, requests, relationship signals)
- Note scheduling, commitments, follow-ups

### Social media ingestion

When monitoring social media:
- Capture what people you track are saying publicly (beliefs, projects, opinions)
- Detect engagement patterns (who's replying to you, who's amplifying you)
- Call enrich for notable accounts → feed into "What They Believe" and "Hobby Horses" sections

### Manual ingestion

When you mention someone or something in conversation:
- Your own comments are the highest-value signal — always capture these
- "Really sharp on the technical side, could be a good advisor for the infra project" → that goes in the person's page immediately
- If the brain page is thin, trigger a full enrichment

## Navigation and Concurrency

**index.md** — content catalog. Every page listed with a one-line summary. Useful for navigation and query routing.

**log.md** — chronological record of ingests and updates. Append-only.

At scale (500+ pages), add search tooling (embeddings, BM25, or tools like pbrain). At moderate scale, grep works well.

### Write hotspots and concurrency

Once you have cron jobs, ingest jobs, and sub-agents all touching the brain repo, **index.md and log.md become merge-conflict magnets.** Every workflow wants to append to log.md and update index.md on every commit.

Practical mitigations:
- **Treat index.md as derived, not hand-maintained.** Instead of updating it in every ingest workflow, rebuild it periodically (daily or on-demand) by scanning the directory tree. This eliminates it as a write hotspot.
- **Make log.md append-safe.** Each entry is a self-contained line with a timestamp prefix. Concurrent appends to the end of the file rarely conflict. If they do, both sides are correct — just keep both lines.
- **Commit in batches, not per-page.** When an ingest job updates 10 entity pages, commit once at the end, not 10 times. This reduces conflict surface.
- **Pull before push.** Every workflow should `git pull --rebase` before pushing. With append-only log and independent entity pages, rebases almost always auto-resolve.
- **Entity pages rarely conflict.** Two workflows updating `people/jane-doe.md` at the same time is rare because they're triggered by different signals about different people. The real conflict hotspots are the shared files (index.md, log.md), which is why those should be append-only or derived.

## Maintenance (Lint)

Periodically (weekly), the agent should:
- **Deduplication scan:** Look for potential duplicate pages — similar names, same company, same email across different pages. Merge when confirmed.
- **Contradictions:** Check for conflicting facts between pages (e.g., two pages listing different roles for the same person at the same company).
- **Staleness:** Flag State sections superseded by newer Timeline entries.
- **Orphans:** Find pages with no inbound links.
- **Open Threads:** Check for items that seem resolved but weren't moved to Timeline.
- **Missing cross-references:** Entity A mentions Entity B but doesn't link to their page.
- **Missing pages:** Entities mentioned frequently but lacking their own page.
- **MECE filing:** Flag any pages that seem to be in the wrong directory.
- **Source audit:** Check people pages for unsourced claims in high-value sections (Beliefs, Motivations, Assessment). Flag claims without source type or date.
- **Alias coverage:** Check if recent meeting transcripts or emails contain name variants not yet in any page's aliases field.

## What makes this different from RAG

RAG re-derives knowledge from scratch on every query. The brain pre-computes synthesis and keeps it current. Specifically:

- **Cross-references are pre-built.** You don't need the LLM to discover that Person A works at Company B and was in Meeting C — that's already linked.
- **Contradictions are pre-flagged.** When new data conflicts with old data, the agent resolves or flags it during ingest, not at query time.
- **The compilation is persistent.** Each source ingested makes the brain richer. Nothing is thrown away or re-derived.
- **The structure itself is a prompt.** Empty sections ("What They Believe: [No data yet]") tell the agent what to look for next.

## Page Lifecycle

Brain pages can have implicit lifecycle states:

- **Active:** Current, recently updated, ongoing relationship or relevance
- **Dormant:** Not updated in 6+ months, relationship cooled, but still potentially relevant
- **Archived:** Moved to `archive/` — dead companies, ended relationships, resolved deals. Historical record only.
- **Graduated:** For ideas that became projects, or projects that became programs — the old page links to the new one

During lint passes, flag pages that haven't been updated in 6+ months for review. Some should be archived; others just need a fresh enrichment pass.

## What makes a great brain

A great brain lets you walk into any meeting, call, or decision already knowing:
1. Who this person is and what they care about (30 seconds of reading)
2. What the company's actual state is (not what they said 6 months ago)
3. What open threads exist between you (promises, follow-ups, deals)
4. What changed recently (latest timeline entries)
5. What to watch for (patterns, concerns, opportunities)

A bad brain is a pile of LinkedIn scrapes and meeting transcripts nobody reads. A good brain is compiled context that makes you more effective in every interaction.

## The Resolver

When creating or filing a new page, walk this decision tree. Every piece of knowledge has exactly one home.

### Decision Tree

**Start here: what is the primary subject?**

1. **A specific named person** (engineer, researcher, author, maintainer) → `people/`
2. **A specific tech organization** (Anthropic, OpenAI, Vercel, xAI, a foundation, a standards body) → `companies/`
3. **A software library you consume** (npm, PyPI, crates.io, go modules…) → `libraries/`
4. **An AI product / model / agent runtime** you interact with → `ai-tools/`
5. **A git repo you own or closely follow** (source tree, not package) → `repos/`
6. **A reusable code pattern or idiom** (language/framework-agnostic shape) → `patterns/`
7. **A research paper** (arxiv, conference proceedings) → `papers/`
8. **A conference talk, podcast, or video lecture** → `talks/`
9. **A technical book or long reference work** → `books/`
10. **A record of a specific meeting/call** that happened at a specific time → `meetings/`
11. **Something you're actively building** (has a repo, spec, team, or active work) → `projects/`
12. **A raw possibility** that nobody is building yet → `ideas/`
13. **A reusable mental model or thesis** about how the world works → `concepts/`
14. **Your own original thinking** (thesis, framework, observation you generated) → `originals/`
15. **A piece of prose** that could be published as a standalone work → `writing/`
16. **A reusable LLM prompt** — templates for getting specific outputs from models → `prompts/`
17. **A raw data import or snapshot** — bulk exports, API dumps, periodic captures → `sources/`
18. **Agent deliverables** — briefings, digests, and research produced by your agent → `agent/`
19. **Unsorted / quick capture** — you don't know where it goes yet → `inbox/`
20. **Dead / no longer relevant** — historical pages with no active references → `archive/`

### Disambiguation Rules

When two directories seem to fit, apply these tiebreakers:

- **Person vs. Company:** If the page is about *them as a human* (beliefs, trajectory, relationship), it's people/. If it's about *the organization they work at*, it's companies/. Both pages link to each other.
- **Library vs. AI-tool:** If you `import` it from your code, it's a library. If you `curl` it or drive it through a CLI/UI, it's an ai-tool. Vercel AI SDK = library. Claude Code = ai-tool. If genuinely both, file under how you *primarily* use it.
- **Library vs. Repo:** Libraries are what you *consume* (as a package). Repos are what you *build on* (as a source tree). Your own `pbrain` → repos. `react` installed from npm → libraries. Upstream contributor? Cross-link both.
- **Pattern vs. Library:** Patterns are portable shapes. Libraries are named packages. "Retry with exponential jitter" = pattern. "p-retry" = library. If it has a package name, it's a library.
- **Pattern vs. Concept:** Concept is the mental model ("eventual consistency"). Pattern is the code shape ("optimistic UI with server reconciliation"). Concept teaches; pattern implements.
- **Paper vs. Concept:** Paper is the artifact. Concept is the idea the paper introduced. "Attention Is All You Need" → paper. "Attention mechanism" → concept.
- **Talk vs. Paper:** Talks are performances; papers are written. Same material in both forms = two pages, cross-linked.
- **Book vs. Paper:** ISBN → book. DOI/arxiv → paper.
- **Concept vs. Idea:** Could you *teach* it? Concept. Could you *build* it? Idea.
- **Idea vs. Project:** Is anyone working on it? If yes, project. If no, idea.
- **Writing vs. Concepts:** Concepts are distilled (~200 words of compiled truth). Writing is developed prose (argument, narrative, story).
- **Sources vs. .raw/ sidecars:** Per-entity enrichment data → .raw/ sidecar next to the entity. Bulk multi-entity imports → sources/.
- **Agent vs. Sources:** Sources feed *into* the brain. Agent deliverables are synthesized output that feeds *into your reading*.

### Special directories (not knowledge)

These exist in the brain repo but aren't knowledge directories:

- **templates/** — page templates for each type (structural, not content)
- **attachments/** — binary attachments (images, PDFs). Managed by your editor, not by the agent.

### MECE Check

Every piece of knowledge should pass through the decision tree above and land in exactly one directory. If you find something that genuinely doesn't fit any category, file it in inbox/ and flag it — that's a signal the schema needs to evolve.

## Getting started

1. Create the directory structure above (or let your agent create it)
2. Write a `RESOLVER.md` decision tree and a `README.md` resolver for each directory
3. Write a `schema.md` with your page conventions and templates
4. Add the brain rules to your agent's config (AGENTS.md or equivalent) as hard rules
5. Start with one meeting transcript or one person you want to track
6. Let the agent build the first few pages, review them, and iterate on the schema
7. Wire up your meeting tool to trigger ingestion
8. Wire up enrichment to fire on every new person/company signal
9. The brain compounds from there

The human's job: curate sources, direct analysis, ask good questions, and think about what it all means. The agent's job: everything else.
