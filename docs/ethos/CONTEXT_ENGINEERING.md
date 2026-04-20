---
type: essay
title: "Context Engineering for PBrain"
subtitle: "Why v0.2 Ships Less, Not More"
created: 2026-04-20
updated: 2026-04-20
tags: [context-engineering, doctrine, ethos, agents]
status: published
---

# Context Engineering for PBrain

A personal knowledge brain is a tempting thing to jam into a coding agent's context window. We have the graph. We have the timeline. We have compiled-truth summaries. Why not just inject the relevant subset every time?

Because that's the thing that makes coding agents dumber.

## What the research says

Four independent 2026 sources converge on one uncomfortable finding: **most automated context injection is net-negative**.

- **AGENTbench (Feb 2026, B-Lab / ETH / DeepMind)** — tested LLM-generated `AGENTS.md` / `CLAUDE.md` files on SWE-bench Lite and AGENTbench. Result: a *0.5% to 2% drop in success rates*. Human-written files only helped (+4%) when they *replaced* existing docs — meaning most of them were just paraphrasing what was already in the repo.
- **Chroma context-rot study (2025)** — 18 frontier models. Simple retrieval degraded starting at 2,500 words of input (Claude Opus 4) to 5,000 words (most families). Random-output failures began at 500-750 words (Gemini 2.5). The effect is real, consistent, and independent of content relevance.
- **BFCL tool-use leaderboard (2025)** — tool-count cliffs at 30 tools for frontier models, 19 for smaller. >100 tools is "virtually guaranteed to fail." Context confusion is a function of tool surface, not task difficulty.
- **Anthropic engineering (Sep 2025, Mar 2026)** — official guidance: prefer *just-in-time retrieval* over RAG-style pre-stuffing; prefer *sub-agent quarantine* over inline accumulation; prefer *structured resets* over `/compact`. Named failure mode: "context rot" from n² attention as windows grow.

These are not edge cases. This is how the models you ship against in 2026 actually behave under real load.

## The four principles

PBrain's context engineering discipline is four principles, each triangulated by three or more independent sources.

### 1. Minimalism beats completeness

"The smallest possible set of high-signal tokens that maximize the likelihood of the desired outcome." — Anthropic, *Effective context engineering for AI agents*, Sep 2025.

Hard caps and guidelines:

- `CLAUDE.md` target under 200 lines (Anthropic recommendation, not a hard limit — files load in full regardless).
- Skill file ≤ 500 lines (Cursor guidance; PBrain skills already honor this).
- SessionStart hook `additionalContext` capped at 10,000 chars by Claude Code harness (overflow saved to file + preview automatically).
- Stay under 2,500 words in any single context block. Past that, recall degrades on every model tested in Chroma 2025.

### 2. Just-in-time beats pre-stuffing

Brain pages are the substrate an agent dereferences on demand via MCP tools (`pbrain query`, `get_page`). They are NOT the firehose that auto-fills the context window.

Validated by:

- Anthropic's official recommendation.
- Continue.dev's Jan 2026 deprecation of `@Codebase` and `@Docs` in favor of MCP — the biggest IDE-embedded coding agent outside Cursor moved *away* from pre-indexed retrieval toward just-in-time tool calls.
- Aider's on-demand repo map.
- Breunig 2025 — context offloading to a persistent scratchpad (read/write on demand) drove a +54% benchmark improvement over in-context accumulation.

### 3. Sub-agent quarantine beats inline accumulation

Brain-heavy exploration runs in a subagent whose context is already isolated by default. Only a distilled ~2K-token summary returns. Use `isolation: worktree` when filesystem isolation is also required.

Validated by:

- Anthropic 2026 subagent docs — explicit recommendation for expensive exploration patterns.
- Chroma's distraction threshold: 32K tokens (Llama 3.1 405B) to 100K tokens (Gemini 2.5).
- Breunig's distilled-return pattern — the sub-agent does the ~50K-token exploration, the primary context receives ~2K.

### 4. Structured resets beat compaction

For long coding sessions, prefer explicit handoff (stash state to `progress.txt`-shaped artifacts, start a fresh session) over passive `/compact`.

Validated by:

- Anthropic harness-design post, Mar 2026: "compaction alone wasn't sufficient."
- Cline's `/newtask` distillation pattern — a community-driven confirmation that resets beat rolling summaries.
- Aider's prompt-cache-aware stable-prefix design — if you keep the cached prefix stable and reset the tail, you get correctness AND cache hit rate.

## The anti-patterns

These are durable prohibitions. Every future skill or feature is gated through this list. If a proposal doesn't survive scrutiny against these, it doesn't ship.

**Auto-generating CLAUDE.md / AGENTS.md with project briefings.** AGENTbench Feb 2026: LLM-generated files are net-negative except when they *replace* existing docs. PBrain only ever writes a ≤ 10-line `## pbrain` pointer stanza (already done by the external `project-onboard` skill). We do not maintain richer auto-written content.

**Dumping search results into the system prompt.** Pre-stuffing degrades performance. Always expose brain pages via MCP tools/resources the agent pulls on demand.

**Auto-pushing session context via hooks.** Even a 10,000-char hook payload is auto-push — the same category as the AGENTbench anti-pattern. User-invoked slash commands and tool calls are acceptable; hooks that auto-inject are not. `pbrain brief` is a CLI command; wiring it to a SessionStart hook is a user opt-in, never a default.

**Adding MCP tools without retiring others.** BFCL 2025: 30-tool cliff for frontier models, 19 for smaller. PBrain has 32 ops today; v0.2 moves 8 behind Tool Search to stay under the cliff. Every future addition must retire equal-or-more (or defer an equivalent count).

**"Always read X before Y" meta-rules.** Cursor forum bug #157164 and multiple practitioner reports: agents claim compliance but don't actually read. Use Claude Code's `.claude/rules/*.md` with `paths:` frontmatter (the officially-sanctioned path-scoped auto-load mechanism) instead.

**Monotonic CLAUDE.md / instruction-file growth.** Lint gate (informal, enforced in review): any PR growing `skills/**/SKILL.md` or `CLAUDE.md` without removing equivalent content fails review.

**Edge-case enumeration.** Liu 2023 + Anthropic: laundry lists get ignored in the middle. Prefer 3-5 diverse canonical examples over 30 rules.

**Context-engineering changes that can't be measured.** If we can't say "this session used N fewer turns" or "this retrieval improved P@5 by X%," we don't ship. Where the existing eval harness (`src/core/search/eval.ts`) measures retrieval metrics but not coding-agent KPIs, gate on explicit manual A/B comparison until a proper eval rig exists.

## The measurement contract

PBrain's existing eval harness (`src/core/search/eval.ts`) measures retrieval metrics: P@k, R@k, MRR, nDCG@k. It does not currently measure coding-agent KPIs (turn count, regeneration rate, cross-file consistency). Building a coding-task fixture harness is a larger project than any single wave.

For now:

- Tool-count changes are measured directly: `ListTools` response shape before/after.
- Doctrine changes are measured by *use*: every cut in a wave must be traceable to a specific anti-pattern. If a cut can't be justified by the doctrine, either the cut is wrong or the doctrine is missing a rule.
- A coding-task eval harness is its own wave. Until it exists, we're honest about manual A/B being the ceiling.

## What v0.2 actually ships

A doctrine document (this file) and a net subtraction: **24 always-visible MCP tools, down from 32**. Eight ops move behind Tool Search — they remain fully invokable, but their schemas no longer occupy context by default.

The doctrine's first load-bearing proof is the subtraction.

Plus one small user-invoked primitive: `pbrain brief`, a CLI command that composes existing engine methods into a pastable context block. Not a hook. Not auto-installed. The user pipes it where they want it.

That's it. Any feature that couldn't pass the anti-patterns gate got cut. See the v0.2 plan for the list and the rationale.

## Further reading

- Anthropic: [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), Sep 2025
- Anthropic: [Harness design for long-running applications](https://www.anthropic.com/engineering/harness-design-long-running-apps), Mar 2026
- Chroma: [Context rot](https://www.trychroma.com/research/context-rot), 2025
- Breunig: [How long contexts fail](https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html) / [How to fix your context](https://www.dbreunig.com/2025/06/26/how-to-fix-your-context.html), 2025
- B-Lab / ETH / DeepMind: [Evaluating AGENTS.md](https://b-lab.team/en/content/3496ce92-d0d2-45c8-8534-ddcc4d8a321e), Feb 2026
- Liu et al.: [Lost in the Middle (TACL 2024)](https://arxiv.org/abs/2307.03172)
- Related PBrain ethos: [`THIN_HARNESS_FAT_SKILLS.md`](THIN_HARNESS_FAT_SKILLS.md), [`MARKDOWN_SKILLS_AS_RECIPES.md`](MARKDOWN_SKILLS_AS_RECIPES.md)
