# Full published catalogue browsing

Goal: remove the 100-item public catalogue ceiling while preserving nine-at-a-time browsing and accurate filtered counts.
User explicitly authorizes the change. Execute inline.

- [ ] Remove parseShown100 cap; validate safe integer and clamp DB requests to actual available count. Add regression beyond100 and invalid huge values.
- [ ] Home counts share repository filters with rows; public lists query only shown rows and pass true totals to ProjectGrid. Ranking keeps its own eligibility, unclaimed fill gets independent full total. Whole-catalogue link targets recent public list. Preserve saved-view behavior while avoiding a smaller candidate pool.
- [ ] Add stable slug tiebreaker for deterministic progressive lists. Browser fixture117public rows verifies9initial,99→108→117end, filter preservation and no duplicate rows.
- [ ] Typecheck/lint/relevant unit/integration/browser; independent ak review; commit/push own files, web2deploy, actualpubliccounts+108+lastpage verification. Handoff/report/journal.
