# Codex handoff

## Current objective

Design a click-based discovery ranking that rotates products by season, excludes known bot and rapid
repeat clicks, shows click-based change, and exposes future-season policy controls in the admin.

## Completed work

- Compared the external v2 HTML mockup with the current rendered home.
- Inspected click capture, rollups, ranking queries, market stats, admin settings, and related tests.
- Confirmed that known-bot filtering, first-party visitor identification, 10-minute per-product
  deduplication, raw click storage, and daily rollups already exist.
- Identified that the current `delta24h` is an absolute difference rather than a percentage.
- Agreed with the user on:
  - weekly discovery as the default;
  - configurable weekly/monthly cadence;
  - configurable launch eligibility and soft cooldown;
  - verified-only competitive ranking;
  - click change as display/trending input, not main rank input;
  - current-season policy locking and next-season scheduled edits.
- Produced and user-approved admin and public-home visual prototypes in `/private/tmp`.
- Wrote the approved design at
  `docs/superpowers/specs/2026-08-18-weekly-ranking-design.md`.

## Modified files

- `docs/superpowers/specs/2026-08-18-weekly-ranking-design.md`
- `docs/CODEX_HANDOFF.md`

No application code has been changed.

## Key design decisions

- Season score is valid clicks multiplied by a configurable cooldown factor in basis points.
- Weekly seasons start Monday 00:00 KST; monthly seasons start on the first at 00:00 KST.
- Launch eligibility expands from 28 up to 90 days when needed to reach 20 verified products.
- Click-change default is two adjacent rolling 24-hour windows with a five-click prior minimum.
- Policy revisions are immutable and only apply at season boundaries.
- Season policy snapshots and final entries are immutable historical records.
- The public UI shows raw clicks and cooldown factor together.
- Seeded products appear only in the newly discovered surface, never competitive rankings.

## Test commands and results

No test command was run. This phase changed documentation only.

## Failed approaches

- The brainstorming skill referenced `skills/brainstorming/visual-companion.md`, but that file was
  not present in the installed skill directories. The visual companion was created directly as
  temporary HTML instead.

## Remaining work

1. Ask the user to review the committed design document.
2. After explicit approval, invoke the `writing-plans` skill and write an implementation plan.
3. Do not implement before the implementation plan is approved.
4. Production scheduler registration remains blocked as described in `PENDING.md`; the future
   scheduler setup must include `ranking-refresh`.

## Exact commands for the next agent

```bash
cd /Users/jr/Desktop/projects/nomorevibe
git status --short
sed -n '1,260p' docs/superpowers/specs/2026-08-18-weekly-ranking-design.md
sed -n '261,520p' docs/superpowers/specs/2026-08-18-weekly-ranking-design.md
sed -n '1,220p' docs/CODEX_HANDOFF.md
```

After the user approves the written spec, read the `writing-plans` skill in full and create the
implementation plan it requires.
