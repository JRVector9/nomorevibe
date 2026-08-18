# Weekly discovery ranking design

Status: approved

Date: 2026-08-18

Scope: public click metrics, rotating discovery ranking, ranking administration

## Objective

Make NoMoreVibe's home page a rotating discovery surface instead of a permanent list of the
same high-volume products. Rank products by clicks that NoMoreVibe can measure, exclude known
bots and rapid repeat clicks, show click-based change clearly, and let an administrator schedule
ranking-policy changes without changing a season already in progress.

The default experience is a weekly discovery season. The administrator may switch future seasons
to a monthly cadence, change launch eligibility, and configure soft cooldown schedules.

## Existing behavior

The repository already provides most of the click-capture foundation:

- Product links leave through `GET /go/<slug>`.
- Known bots and link-preview user agents do not create click events.
- The same first-party visitor and product are counted at most once per 10-minute window.
- A redirect still succeeds when click recording fails.
- Raw `click_events` are retained for 35 days and rolled into `product_click_daily`.
- The current popular sort uses a rolling seven-day click count and includes verified products
  only.
- `delta24h` currently contains an absolute click difference, although the UI presents it like a
  change metric. It is not yet a percentage.

This design preserves the redirect and click-capture behavior. It replaces the rolling popular
sort with explicit seasons and corrects the 24-hour metric.

## Product decisions

1. The default public ranking is the current weekly season.
2. Only verified products can appear in weekly, monthly, or trending rankings.
3. Seeded, unclaimed products can appear in the separate "newly discovered" board only.
4. The main season rank is based on valid clicks multiplied by a soft-cooldown factor.
5. The click-change percentage is displayed and drives the trending board, but it never changes
   the main season score.
6. Raw clicks and the applied cooldown factor are shown together so a lower-click product ranking
   above a higher-click product is explainable.
7. Ranking-policy edits apply at the next season boundary. An active season's rules are immutable.
8. Historical season rules and final results remain queryable.
9. Uptime does not automatically remove a product from ranking. Existing down-state badges and
   administrative product controls remain responsible for that decision.

## Default policy

The first ranking policy has these values:

```json
{
  "season": {
    "cadence": "weekly",
    "timezone": "Asia/Seoul"
  },
  "eligibility": {
    "launchWindowDays": 28,
    "minimumProducts": 20,
    "maximumWindowDays": 90
  },
  "leaderboard": {
    "limit": 10
  },
  "cooldown": {
    "enabled": true,
    "tiers": [
      {
        "rankFrom": 1,
        "rankTo": 3,
        "factorsBasisPoints": [3500, 5500, 7500, 9000]
      },
      {
        "rankFrom": 4,
        "rankTo": 10,
        "factorsBasisPoints": [6500, 8000, 9000, 10000]
      }
    ]
  },
  "trend": {
    "windowHours": 24,
    "minimumPreviousClicks": 5,
    "limit": 4
  },
  "boards": {
    "weeklyLimit": 3,
    "verifiedNewLimit": 3,
    "discoveredNewLimit": 3
  }
}
```

`trend.windowHours` is configurable. The label is generated from the configured value; at the
default it reads "24시간 변동률." The comparison period always has the same length and immediately
precedes the recent period.

The timezone is fixed to `Asia/Seoul` in the first version. It is part of every season snapshot so
the boundary remains explicit, but it is not an editable field.

## Definitions

### Valid click

A valid click is a row accepted by the existing `/go/<slug>` capture path:

- the request user agent does not match the known bot, crawler, monitoring, or link-preview list;
- the visitor and product have not already produced a counted click in the preceding 10 minutes;
- recording succeeded.

The visitor cookie distinguishes browsers, not people. The system does not claim to defeat a bot
that deliberately impersonates a normal browser. More advanced fraud scoring and manual event
exclusion are outside this version.

Bot exclusion, the deduplication interval, and raw-event retention are integrity controls rather
than casual ranking knobs, so `/admin/ranking` does not edit them.

### Season boundaries

- Weekly seasons use Monday 00:00 KST through the next Monday 00:00 KST.
- Monthly seasons normally use the first day of the month 00:00 KST through the first day of the
  next month 00:00 KST.
- All ranges are half-open: `[startsAt, endsAt)`.
- Database comparisons use UTC instants derived from the KST boundary, rather than relying on the
  database session timezone.

When cadence changes, the first season under the new cadence begins at the active season's end. If
that instant is not a natural boundary for the new cadence, the system creates one explicitly
labelled transition season ending at the next natural boundary. Later seasons use normal boundaries.
The transition is a real, closed season and therefore advances cooldown history; the admin preview
shows its shorter dates before the change is scheduled.

The season key is stable and human-readable: for example, `2026-W34` or `2026-08`.

### Eligibility

A product is eligible for the competitive ranking when all of these are true:

- its current status is `verified`;
- its `verifiedAt` is before the snapshot time and before the season end;
- its `verifiedAt` is on or after `season.startsAt - effectiveLaunchWindowDays`.

At season creation, the system begins with `launchWindowDays`. If that window contains fewer than
`minimumProducts`, it selects the shortest whole-day window that reaches the minimum, capped at
`maximumWindowDays`. The resulting `effectiveLaunchWindowDays` is saved on the season and does not
change during that season. Products verified after the season starts can enter immediately.

If the maximum window still has fewer products than the leaderboard limit, the page shows the
available products. It does not add unverified or seeded products as a fallback.

### Season score

```text
scoreUnits = validClicks * cooldownFactorBasisPoints
```

The score uses integers. A product with 61 clicks and a 35% factor has `213500` score units. The
public page shows 61 clicks and 35% applied, not the internal score-unit value.

Sort order is deterministic:

1. score units descending;
2. valid clicks descending;
3. `verifiedAt` descending;
4. slug ascending.

### Cooldown

Each closed-season finish inside a configured tier creates a cooldown schedule for subsequent
seasons. Index zero applies to the immediately following season. After the array ends, that finish
contributes a 100% factor.

When schedules overlap because a cooled product finishes in a cooldown tier again, the strongest
active penalty wins: the applied factor is the minimum factor contributed by all still-active
schedules. A new Top 1-3 finish therefore starts at 35% next season even when an older, weaker
schedule is still active.

Cooldown history advances by completed seasons, not elapsed days. Switching from weekly to monthly
does not retroactively reinterpret completed seasons. The administrator preview warns when the
eligibility window is so short that some configured cooldown stages are unlikely to be used.

### Click change

At snapshot time:

```text
recent   = valid clicks in [now - window, now)
previous = valid clicks in [now - 2 * window, now - window)
change   = ((recent - previous) / previous) * 100
```

- If `previous < minimumPreviousClicks`, change is `null`, the UI shows `신규`, and the product is
  excluded from percentage-based trending order.
- If `previous` meets the minimum and `recent` is zero, change is `-100%`.
- The UI rounds to one decimal place.
- Trending sorts by percentage descending, then recent clicks descending, then slug ascending.
- The aggregate market click change uses the same two-window formula. It omits the percentage when
  the previous aggregate is zero.

## Persistence

### `ranking_policy_revisions`

Immutable administrator-authored policy versions:

- `id`
- `values` JSONB
- `state`: `scheduled`, `applied`, or `cancelled`
- `created_by`
- `created_at`
- `applied_at`, nullable
- `cancelled_at`, nullable

Only one revision may be scheduled. Saving again cancels the older scheduled revision and creates a
new immutable revision. Cancelling the pending revision makes the next season inherit the current
season's policy.

### `ranking_seasons`

One row per season:

- `id`
- `key`, unique
- `cadence`
- `starts_at`
- `ends_at`
- `state`: `active` or `closed`
- `policy_revision_id`
- `policy_snapshot` JSONB
- `effective_launch_window_days`
- `is_transition`
- `refreshed_at`, nullable
- `started_at`
- `closed_at`, nullable

The full policy snapshot is stored even though the revision is referenced. Historical ranking
interpretation must not depend on a later application merge or default value.

### `ranking_entries`

One row per season and product:

- `season_id`
- `slug`
- `valid_clicks`
- `cooldown_factor_basis_points`
- `score_units`
- `rank`
- `change_percent`, nullable
- `recent_clicks`
- `previous_clicks`
- `updated_at`
- `finalized_at`, nullable

The primary key is `(season_id, slug)`. Refreshes upsert rows, which makes a repeated job run
idempotent. Once the season closes, entries are finalized and no longer updated.

Raw `click_events` and `product_click_daily` remain the source records. Add an index that supports
the season time-range aggregation. The public home reads `ranking_entries`, not raw events.

`product_click_daily.day` is defined as a KST calendar day for this feature. Before the first season
is enabled, rebuild the most recent daily rows from retained raw events using an explicit
`Asia/Seoul` conversion. This avoids mixing database-session or UTC day boundaries with KST season
boundaries. Seasons begin only after that rebuild, so older ambiguous rollups are never presented as
historical season results.

## Jobs and lifecycle

Add a `ranking-refresh` job to the existing job registry and scheduler. It runs hourly and also
performs rollover whenever it observes a crossed boundary.

In one job run:

1. Acquire the existing name-based job lock.
2. If this is the first run, create an applied revision from the code default policy.
3. Validate the scheduled revision; an invalid revision is logged and ignored rather than replacing
   a known-good active policy.
4. Close every crossed season in chronological order using its exact `[start, end)` click range.
5. Finalize its entries.
6. Create the current season, applying the scheduled revision to the first new season only, or
   inheriting the previous policy.
7. Determine and save the effective eligibility window.
8. Aggregate current-season clicks, calculate cooldowns and change percentages, and upsert entries.
9. Record success or the actionable error in the existing job-state table.

A database uniqueness constraint on the season key and a transaction around rollover prevent two
workers from creating the same season. If several boundaries were missed, the next successful run
creates and finalizes them in order. Historical daily rollups are used when raw events have already
been pruned.

The production scheduler work already recorded in `PENDING.md` must include `ranking-refresh` when
deployment access is available. Until it is registered, ranking refreshes will not happen in
production.

## Administrator experience

Add `/admin/ranking`, protected by `currentAdmin()` both on page load and in every server action.
Keep it separate from crawl settings because ranking policy and collection policy have different
failure modes and release timing.

The page contains:

- current season key, dates, remaining time, eligible products, valid clicks, and last refresh;
- the active, locked policy;
- one editable next-season policy;
- a diff between active and scheduled values;
- a current-data preview using the scheduled policy;
- save, replace, and cancel-scheduled-change actions;
- author and timestamp for every revision.

The preview is labeled as an estimate. It cannot promise the next result because clicks and eligible
products will change before the boundary.

### Validation

Reject a save atomically when any condition fails:

- cadence is not `weekly` or `monthly`;
- launch window is outside 1-3650 days;
- maximum window is smaller than the launch window or exceeds 3650 days;
- minimum products is outside 1-50,000;
- leaderboard limit is outside 1-100 or exceeds minimum products;
- a board limit is outside 1-20;
- trend window is outside 1-168 hours;
- minimum previous clicks is outside 1-100,000;
- cooldown rank ranges overlap, have gaps before the highest configured tier, begin below one, or
  end above the leaderboard limit;
- a factor is outside 1-10,000 basis points;
- factors within a tier decrease over time;
- a cooldown schedule exceeds 52 seasons.

Warnings do not block a save. Examples include a monthly cadence with an eligibility window shorter
than one month or a cooldown schedule likely to outlast launch eligibility.

Saving never mutates the active season. There is no "apply immediately" action in this version.

## Public experience

The home defaults to the current season and presents four discovery boards:

1. `이번 주 Top`: ranked verified products;
2. `<window> 급상승`: verified products with a qualified click-change percentage;
3. `새로 검증됨`: recently verified products;
4. `새로 발견됨`: recent seeded and verified discoveries, with unclaimed state visible.

The primary list supports:

- current season;
- trending;
- latest;
- all-time popular.

Each season row shows product identity and trust badges, valid season clicks, click change or `신규`,
the applied rank factor, and the prior finish or first-season state. Category and query filters remain
available. Filtering preserves the saved global season rank; it does not renumber the filtered
subset as if it were a separate competition.

Add a methodology view linked as `현재 규칙 보기`. It displays the active season's exact snapshot,
including dates, click definition, eligibility window, cooldown tiers, change threshold, and last
refresh. Past-season pages show their own locked policy and final results.

The existing `?sort=popular` URL should remain compatible by mapping to the current season during
the transition.

## Failure behavior

- Click-recording failure never blocks the outbound redirect.
- Ranking-refresh failure leaves the last successful snapshot intact.
- A stale snapshot remains visible with `마지막 집계 N시간 전`; it is not replaced with an empty
  leaderboard.
- If no season has ever been created, the home falls back to the latest-products list and logs a
  ranking-unavailable warning.
- An invalid stored scheduled revision is skipped; the last applied policy remains authoritative.
- A season with fewer products than the requested limit renders the smaller list.
- Database errors continue to use the existing home-level unavailable state rather than leaking
  internal details.

## Testing strategy

### Unit tests

- KST weekly and monthly boundary calculation, including year and month changes;
- eligibility-window expansion and maximum-window exhaustion;
- integer score and deterministic tie order;
- cooldown progression, overlapping penalties, repeat finishes, disabled cooldown, and expiry;
- click-change positive, negative, zero, missing baseline, configurable window, and rounding cases;
- policy validation errors and non-blocking warnings.

### Integration tests

- known bot requests redirect without inserting an event;
- rapid repeat clicks count once while different visitors count independently;
- only verified products enter competitive ranking entries;
- seeded products can enter newly discovered results but not ranking entries;
- a scheduled revision does not change the active season;
- rollover applies the scheduled revision exactly once;
- repeated refresh and rollover calls are idempotent;
- missed boundaries are recovered chronologically;
- finalized entries and season snapshots do not change;
- refresh failure retains the prior snapshot and records a job error;
- all-time results still read daily rollups after raw-event pruning.

### UI tests

- raw clicks, percentage or `신규`, and cooldown factor appear together;
- active and pending policy differences are visible to the administrator;
- invalid settings show field-specific errors and write nothing;
- the public list exposes the reason for rank/click inversions;
- stale refresh state and the no-season fallback render clearly;
- desktop and mobile layouts keep metrics readable.

## Out of scope

- Votes, watchlists, maker-connected analytics, or a composite NMR score;
- impression tracking and CTR-based ranking;
- machine-learning bot or fraud scoring;
- manual deletion or reclassification of individual click events;
- changing the active season's rules;
- public voting on ranking-policy values.

These can be evaluated after the site has enough real traffic to measure whether season resets and
cooldowns solve discovery concentration.
