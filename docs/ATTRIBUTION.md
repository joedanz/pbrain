# Attribution

PBrain is a fork of [GBrain](https://github.com/garrytan/gbrain) by
[Garry Tan](https://github.com/garrytan), President and CEO of Y Combinator.

## What PBrain inherits from GBrain

Nearly everything, including:

- **Contract-first operation design** — `src/core/operations.ts` defines ~30 shared
  operations from which both the CLI and the MCP server are generated.
- **Pluggable engine layer** — PGLite (embedded Postgres via WASM) for zero-config
  local use, or Postgres + pgvector for managed/hosted use, behind a common
  `BrainEngine` interface.
- **Hybrid RAG search** — vector similarity + keyword full-text + Reciprocal Rank
  Fusion (RRF) + multi-query expansion + dedup, with intent-aware detail selection.
- **Compiled Truth + Timeline page format** — above-the-line pre-synthesized truth,
  below-the-line append-only evidence log.
- **Fat markdown skills** — tool-agnostic, single-source-of-truth workflow docs that
  work in both CLI and plugin contexts.
- **Autopilot daemon** — self-maintaining brain with sync + extract + embed loops.
- **Recipe system** — pluggable integration recipes (`src/commands/integrations.ts`).
- **Doctor command** — health checks for the brain.
- **Skill resolver** (`skills/RESOLVER.md`) — single routing table modeled on
  Wintermute's AGENTS.md.
- **MCP stdio server** — exposes the brain over Model Context Protocol.

## What PBrain changes

- **Audience**: senior software engineer (not VC / founder).
- **Schema**: drops `deals/`, `hiring/`, `civic/`, `org/`, `media/`, `personal/`,
  `household/`; adds `libraries/`, `ai-tools/`, `repos/`, `patterns/`, `papers/`,
  `talks/`, `books/`.
- **`companies/` page re-skin**: tech-organization fields (models, APIs, direction,
  my usage) instead of VC fields (stage, valuation, investors).
- **Storage model** (coming in v2.0.0): markdown-first — files on disk become the
  source of truth, PGLite becomes a rebuildable index. Optimized for use as an
  Obsidian vault.
- **Rebrand only**: the `v1.0.0-pbrain-rebrand` release (current) is a naming and
  config-dir change with zero functional differences from GBrain v0.10.1. Schema,
  storage, and integration changes land in v1.1.0, v2.0.0, and v2.1.0 respectively.

## Contribution-back policy

PBrain tracks GBrain upstream loosely. Bug fixes and improvements to the core
engine (chunking, search, embedding, sync, MCP, operations) that are not
PBrain-specific should be contributed back to
[garrytan/gbrain](https://github.com/garrytan/gbrain) where reasonable.

PBrain-specific changes (new schema directories, re-skinned company pages,
markdown-first storage inversion, Obsidian optimizations) stay in PBrain.

## Thank you

Thank you to Garry Tan and all GBrain contributors. This fork exists because
the original work is excellent and the architecture is legitimately adaptable
to adjacent domains. PBrain would not exist without GBrain.
