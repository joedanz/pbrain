# `pbrain brief` — on-demand project context for coding agents

`pbrain brief` prints a small, XML-wrapped context block describing the current
project: detected slug, a compiled-truth excerpt, recent timeline entries, and
a pointer to `pbrain query` for deeper lookups. Output is capped at 10,000
characters — matching Claude Code's `additionalContext` hook limit — so you can
pipe it straight into any session without worrying about overflow.

## Quick start

From a directory that's onboarded as a PBrain project (has a `.pbrain-project`
marker, or a git remote that matches a `repos/*` page):

```bash
pbrain brief
```

You'll get something like:

```xml
<pbrain-brief>
  <project slug="repos/joedanz/pbrain" detected_via="remote:origin" />
  <compiled_truth_excerpt>
PBrain is a personal knowledge brain and GStack mod...
  </compiled_truth_excerpt>
  <recent_timeline limit="5">
    <entry date="2026-04-19" source="changelog">Shipped v0.12.3 reliability wave</entry>
    ...
  </recent_timeline>
  <how_to_query>Use `pbrain query "<question>"` to fetch more brain context on demand.</how_to_query>
</pbrain-brief>
```

## Flags

| Flag | Values | Default | Effect |
|---|---|---|---|
| `--format` | `xml`, `text` | `xml` | Output format. XML is recommended for agents (Anthropic 2026 guidance shows up-to-30% quality uplift from XML-wrapped, docs-first, query-last structure). Plain text is easier to read in a terminal. |
| `--scope` | `project`, `activity`, `all` | `all` | `project` emits only the compiled-truth excerpt. `activity` emits only the recent timeline. `all` emits both. |
| `--json` | (flag) | off | Emit a JSON payload instead of XML/text. Useful for scripts that want to re-shape the output. |

## Running `brief` manually in a Claude Code session

The simplest path: run `pbrain brief`, copy the output, paste it into the
chat. The agent will reference the project details in follow-up turns.

This is the *recommended* usage. You know when you want context; the command
gives it to you on demand.

## Optional: wire `brief` to SessionStart (user opt-in)

If you want the brief to appear every time you start a Claude Code session
in a pbrain-aware repo, add a SessionStart hook to your
`~/.claude/settings.json`:

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "command": "pbrain brief 2>/dev/null || true",
        "description": "PBrain project brief"
      }
    ]
  }
}
```

The `|| true` makes the hook a no-op in directories PBrain doesn't know about,
so it doesn't fail other sessions. The 10,000-char cap is enforced inside
`pbrain brief`; anything beyond that is truncated with a `<!-- truncated -->`
sentinel, and Claude Code's harness saves overflow to a file automatically.

**Important:** PBrain explicitly does NOT auto-install this hook. The doctrine
([docs/ethos/CONTEXT_ENGINEERING.md](../ethos/CONTEXT_ENGINEERING.md)) draws
a hard line against auto-pushing context via hooks. If you choose to wire
this hook up yourself, that's your opt-in, and you can unwire it any time.

## When `brief` won't produce context

`pbrain brief` emits a `<no_project>` sentinel (or "No project resolved" in
text mode) when it can't resolve the current directory to a brain slug.
Run `pbrain whoami --verbose` to see exactly which layers were attempted
(`.pbrain-project` marker, then git remote URL matching) — the output walks
through each lookup so you can debug missing onboarding.

## How it relates to other commands

- `pbrain whoami` — just resolves the current directory to a slug. `brief`
  uses the same resolver internally, then composes page + timeline context.
- `pbrain query "<question>"` — the canonical way to pull brain context on
  demand during a session. The brief's `<how_to_query>` line reminds the
  agent this exists.
- `pbrain remember "<summary>"` — writes a timeline entry for the current
  project. Output from `pbrain brief` on a later session will reflect
  remembered events.
