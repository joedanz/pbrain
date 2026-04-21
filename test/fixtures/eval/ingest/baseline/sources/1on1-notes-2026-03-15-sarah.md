---
slug: meetings/2026-03-15-sarah-chen
type: meeting-note
title: "1:1 with Sarah Chen — 2026-03-15"
date: 2026-03-15
attendees:
  - joe
  - sarah-chen
duration_min: 30
---

# 1:1 with Sarah Chen — 2026-03-15

## Topics

- v0.4 eval-harness scope pushback
- Her team's sprint commitments for Q2
- Frontend hiring status
- Personal: Sarah mentioned she's moving to NYC in June

## Discussion

**v0.4 eval-harness scope.** Sarah thinks our plan is trying to do three things
in one release — ingest, retrieval, answer — and each deserves its own shipping
cycle. She's not wrong on the principle. I pushed back: the three stages are
coupled in practice (you can't evaluate answer quality without known-good
retrieval, and retrieval is measured against the pages ingest produced). She
agreed the coupling is real but wants us to commit to shipping one stage per
release cycle going forward. I'll take that into v0.5 planning.

**Q2 sprint commitments.** Her team is taking on the background sync daemon
rewrite. Three weeks estimate, with a mid-sprint demo gate. I flagged that the
adaptive-backoff code path has tricky CPU/memory thresholds and offered to pair
on the trickier bits. She accepted for the first week specifically.

**Frontend hiring.** Three candidates in the pipeline. One — Priya Menon —
cleared both Sarah's tech screen and Joe's design-sense interview. Moving to
final round next Monday. Sarah's concern: Priya's last job was 18 months at a
failed Series A, red flag or unlucky? I pushed back — she built the thing
that shipped, and the company failed for go-to-market reasons Priya couldn't
control. Sarah conceded.

**Personal.** Sarah is moving to NYC in June. Partner's job. She'll stay on
the team remote, no schedule change for us. I'd been meaning to ask if she
wanted me to sponsor her green card renewal — she said she was working on it
separately and didn't need that. Noted.

## Action items

- Joe: draft v0.5 doctrine on "one stage per release cycle" and share with Sarah
  before the next 1:1.
- Sarah: own the final-round loop for Priya next Monday. Loop Joe in for the
  design-sense component.
- Joe: pair with Sarah Tuesday 10am on the adaptive-backoff thresholds in the
  sync daemon rewrite.

## Timeline

- **2026-03-15** | 1:1 — Met with Sarah Chen for weekly 1:1; discussed v0.4
  scope, Q2 sprint commitments, frontend hiring status
