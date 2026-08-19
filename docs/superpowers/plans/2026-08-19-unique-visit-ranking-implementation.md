# Unique Visit Ranking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect privacy-preserving product-scoped unique outbound visitors, expose valid visits and unique visitors honestly, and transition only future ranking seasons to the approved unique-first formula after a seven-day warm-up.

**Architecture:** Keep `/go/[slug]` as the only measurement boundary. It derives a product-scoped HMAC before any persistence, stores the hash on accepted visit events, and continues redirecting when measurement fails. Ranking policy snapshots gain a backward-compatible scoring discriminator: old and current seasons remain `valid_visits-v1`, while a separately exported recommended policy uses `unique_visitors-v1`. Active windows count distinct hashes from retained raw events; closed seasons persist final distinct totals in ranking entries.

**Tech Stack:** Next.js 16 Route Handlers, TypeScript, PostgreSQL 17, Drizzle ORM, Zod 4, Vitest

---

## Scope and dependency

This is plan 1 of 3. Complete it before the evidence collector and detail UI plans. It deliberately does not add GitHub facts, media, comments, or the redesigned product page.

The implementation must preserve these contracts:

- `고유 유입자` means distinct accepted first-party browser identifiers through NoMoreVibe, never total product visitors.
- `유효 방문` means accepted outbound events after bot and ten-minute repeat filtering.
- Raw cookie values, IPs, user agents, and visitor hashes never appear in logs.
- Existing closed seasons remain click/valid-visit based and keep their old labels.
- Deploying collection does not silently change the active ranking formula.
- A unique-first policy can be scheduled only after seven full days of collection and applies at a future season boundary.

## Task 1: Add backward-compatible visit and ranking storage

**Files:**

- Modify: `lib/db/schema.ts`
- Create: `drizzle/0013_unique_visits.sql`
- Modify: `drizzle/meta/_journal.json`
- Create: `tests/integration/unique-visit-schema.test.ts`
- Modify: `tests/integration/setup.ts`

- [ ] Write the failing schema integration test first.

The test inserts both a legacy event and a hashed event, verifies nullable compatibility, verifies the singleton collection state exists without inventing a start time, and verifies new ranking fields default to zero:

```ts
await db.insert(clickEvents).values([
  { slug: "legacy" },
  { slug: "hashed", visitorHash: "a".repeat(64) },
]);

const events = await db.select().from(clickEvents).orderBy(clickEvents.slug);
expect(events.map((row) => row.visitorHash)).toEqual(["a".repeat(64), null]);

const state = await db.query.visitCollectionState.findFirst();
expect(state?.id).toBe(1);
expect(state?.uniqueVisitorStartedAt).toBeNull();
```

- [ ] Run `npx vitest run --config vitest.integration.config.ts tests/integration/unique-visit-schema.test.ts` and confirm RED because the columns/table do not exist.

- [ ] Add these Drizzle fields and tables:

```ts
export const clickEvents = pgTable("click_events", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 80 }).notNull(),
  occurredAt: timestamp("occurred_at").notNull().defaultNow(),
  visitorHash: varchar("visitor_hash", { length: 64 }),
}, (table) => [
  index("click_events_slug_time_idx").on(table.slug, table.occurredAt.desc()),
  index("click_events_time_slug_idx").on(table.occurredAt, table.slug),
  index("click_events_slug_visitor_time_idx")
    .on(table.slug, table.visitorHash, table.occurredAt.desc()),
]);

export const productClickDaily = pgTable("product_click_daily", {
  slug: varchar("slug", { length: 80 }).notNull(),
  day: date("day").notNull(),
  clicks: integer("clicks").notNull().default(0),
  uniqueVisitors: integer("unique_visitors").notNull().default(0),
}, (table) => [primaryKey({ columns: [table.slug, table.day] })]);

export const visitCollectionState = pgTable("visit_collection_state", {
  id: integer("id").primaryKey().default(1),
  uniqueVisitorStartedAt: timestamp("unique_visitor_started_at"),
});

export const rankingEntries = pgTable("ranking_entries", {
  seasonId: integer("season_id").notNull().references(() => rankingSeasons.id),
  slug: varchar("slug", { length: 80 }).notNull(),
  validClicks: integer("valid_clicks").notNull().default(0),
  uniqueVisitors: integer("unique_visitors").notNull().default(0),
  cooldownFactorBasisPoints: integer("cooldown_factor_basis_points").notNull().default(10_000),
  scoreUnits: bigint("score_units", { mode: "number" }).notNull().default(0),
  rank: integer("rank").notNull(),
  changePercent: numeric("change_percent", { precision: 12, scale: 1, mode: "number" }),
  recentClicks: integer("recent_clicks").notNull().default(0),
  previousClicks: integer("previous_clicks").notNull().default(0),
  recentUniqueVisitors: integer("recent_unique_visitors").notNull().default(0),
  previousUniqueVisitors: integer("previous_unique_visitors").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  finalizedAt: timestamp("finalized_at"),
}, (table) => [
  primaryKey({ columns: [table.seasonId, table.slug] }),
  index("ranking_entries_rank_idx").on(table.seasonId, table.rank),
]);
```

- [ ] Write `0013_unique_visits.sql` with additive nullable/defaulted changes, the composite index, and:

```sql
INSERT INTO visit_collection_state (id, unique_visitor_started_at)
VALUES (1, NULL)
ON CONFLICT (id) DO NOTHING;
```

Do not backfill legacy `visitor_hash` values, invent historical unique counts, or start the warm-up
clock before the first request that can actually derive a hash.

- [ ] Run the target integration test and expect PASS.

- [ ] Run `npx drizzle-kit check` and `git diff --check`.

- [ ] Commit: `feat: store privacy-safe unique visits`

## Task 2: Hash before rate limiting or persistence

**Files:**

- Create: `lib/domain/products/visitors.ts`
- Modify: `lib/domain/products/clicks.ts`
- Modify: `app/go/[slug]/route.ts`
- Create: `tests/visitor-hash.test.ts`
- Modify: `tests/integration/clicks.test.ts`
- Modify: `.env.example`
- Modify: `compose.yml`

- [ ] Add unit tests for product scoping, determinism, secret separation, invalid/missing secret behavior, and non-disclosure:

```ts
expect(productVisitorHash("alpha", "browser-1", SECRET)).toMatch(/^[a-f0-9]{64}$/);
expect(productVisitorHash("alpha", "browser-1", SECRET))
  .not.toBe(productVisitorHash("beta", "browser-1", SECRET));
expect(productVisitorHash("alpha", "browser-1", "other-secret"))
  .not.toBe(productVisitorHash("alpha", "browser-1", SECRET));
```

- [ ] Extend the click integration test to prove the inserted event contains only the HMAC and the `rate_limits.key` contains neither the raw visitor value nor an IP/user-agent value.

- [ ] Run `npx vitest run tests/visitor-hash.test.ts` and `npx vitest run --config vitest.integration.config.ts tests/integration/clicks.test.ts`; confirm RED.

- [ ] Implement the focused helper:

```ts
import { createHmac } from "node:crypto";

export function productVisitorHash(
  slug: string,
  visitor: string,
  secret = process.env.VISITOR_HASH_SECRET,
): string | null {
  if (!secret || secret.length < 32) return null;
  return createHmac("sha256", secret).update(slug).update("\0").update(visitor).digest("hex");
}
```

- [ ] Change `recordClick(slug, visitor)` so the derived hash is used for both the rate-limit key and `click_events.visitor_hash`:

```ts
const hash = productVisitorHash(slug, visitor);
if (!hash) {
  logger.warn("visit.hash_unavailable", { slug });
  return;
}
await markUniqueCollectionStarted(); // one upsert using coalesce(existing, DB now())
const fresh = await rateLimit(`visit:${slug}:${hash}`, 1, DEDUPE_MS);
if (fresh) await db.insert(clickEvents).values({ slug, visitorHash: hash });
```

The log must not contain `visitor`, `hash`, cookies, IPs, or user agents. Keep the route's `finally`-safe redirect behavior and cookie options unchanged.

- [ ] Add `VISITOR_HASH_SECRET` to `.env.example` and require it in the application service section of `compose.yml`. Document generation as `openssl rand -hex 32`; never reuse `ADMIN_SESSION_SECRET`, `CRON_SECRET`, or edit-token keys.

- [ ] Re-run both target tests and expect PASS.

- [ ] Commit: `feat: anonymize outbound visit identity`

## Task 3: Aggregate valid visits and distinct visitors correctly

**Files:**

- Modify: `lib/domain/products/clicks.ts`
- Modify: `lib/jobs/products/click-rollup.ts`
- Modify: `tests/integration/clicks.test.ts`
- Modify: `tests/ranking-math.test.ts`

- [ ] Add RED integration cases for:

  - two hashes across three accepted rows produce `validVisits: 3`, `uniqueVisitors: 2`;
  - null legacy hashes increase valid visits but not unique visitors;
  - the same hash on two KST days counts once per daily row but cannot be summed and called a multi-day distinct total;
  - rollup reruns overwrite the same daily row idempotently;
  - pruning still removes raw rows after 35 days only after the daily values exist.

- [ ] Rename only public TypeScript terminology, not historical database tables, with this contract:

```ts
export type VisitMetrics = {
  validVisits: number;
  uniqueVisitors: number | null;
  uniqueChangePercent: number | null;
  collectionStartedAt: Date | null;
  collecting: boolean;
};
```

- [ ] Implement one batched `visitMetrics(slugs, options)` query using:

```sql
count(*)
count(distinct visitor_hash) filter (where visitor_hash is not null)
```

for the seven-day total and each adjacent trend window. A product with no hashed observations before warm-up completion returns `uniqueVisitors: null`, not zero.

- [ ] Update `rollupDaily()` to persist both `clicks` and `count(distinct visitor_hash)`, including `unique_visitors = excluded.unique_visitors` on conflict.

- [ ] Keep `topClickedSince()` explicitly click/valid-visit based for historical all-time compatibility. Do not add a function that sums daily unique visitors across days.

- [ ] Run `npx vitest run --config vitest.integration.config.ts tests/integration/clicks.test.ts` and expect PASS.

- [ ] Commit: `feat: aggregate unique outbound visitors`

## Task 4: Version the ranking policy and implement unique-first math

**Files:**

- Modify: `lib/domain/ranking/policy.ts`
- Modify: `lib/domain/ranking/math.ts`
- Modify: `tests/ranking-policy.test.ts`
- Modify: `tests/ranking-math.test.ts`

- [ ] Write RED tests that parse a legacy policy JSON with no `scoring`, retain `valid_visits-v1`, and validate the unique policy bounds.

- [ ] Add a discriminated scoring schema with defaults applied during parsing:

```ts
const scoringSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("valid_visits"), version: z.literal("valid-visits-v1") }),
  z.object({
    mode: z.literal("unique_visitors"),
    version: z.literal("unique-visitors-v1"),
    repeatVisitWeightBasisPoints: z.number().int().min(0).max(10_000),
    maxExtraVisitsPerUnique: z.number().int().min(0).max(10),
    minimumUniqueVisitors: z.number().int().min(1).max(100_000),
  }),
]);
```

Add `scoring` with a legacy default and add `trend.minimumPreviousUniqueVisitors` with a default of 5. Export `parseRankingPolicy(raw)` and ensure every DB JSON read passes through it before use.

- [ ] Keep `DEFAULT_RANKING_POLICY` on `valid-visits-v1`. Export `UNIQUE_FIRST_RANKING_POLICY` with:

```ts
scoring: {
  mode: "unique_visitors",
  version: "unique-visitors-v1",
  repeatVisitWeightBasisPoints: 2_500,
  maxExtraVisitsPerUnique: 1,
  minimumUniqueVisitors: 1,
}
```

- [ ] Add exact RED score examples for 100/150 => 1,125,000 units, 10/100 => 125,000, and 80/80 => 800,000 before cooldown. Cover cap, floor, cooldown, unique/visit/verified/slug ties, and legacy click sorting.

- [ ] Implement formula selection without changing the legacy default:

```ts
const extraVisits = Math.min(
  Math.max(row.validVisits - row.uniqueVisitors, 0),
  row.uniqueVisitors * scoring.maxExtraVisitsPerUnique,
);
const base = row.uniqueVisitors * 10_000
  + extraVisits * scoring.repeatVisitWeightBasisPoints;
const scoreUnits = Math.floor(base * row.factorBasisPoints / 10_000);
```

- [ ] Run `npx vitest run tests/ranking-policy.test.ts tests/ranking-math.test.ts` and expect PASS.

- [ ] Commit: `feat: version unique-first ranking policy`

## Task 5: Refresh and finalize unique-first seasons

**Files:**

- Modify: `lib/domain/ranking/refresh.ts`
- Modify: `tests/integration/ranking-refresh.test.ts`

- [ ] Add RED integration cases for active unique seasons, independent distinct trend windows, minimum unique eligibility, finalization, raw-event pruning survival, legacy policy compatibility, and preview parity.

The finalization case must:

1. create a unique policy season;
2. insert repeated and distinct hashed visits;
3. close the season;
4. prune raw events;
5. assert `ranking_entries.unique_visitors`, `valid_clicks`, and score remain unchanged.

- [ ] Replace click-only aggregate types with:

```ts
type VisitCounts = { validVisits: number; uniqueVisitors: number };
type TrendCounts = {
  recentVisits: number;
  previousVisits: number;
  recentUniqueVisitors: number;
  previousUniqueVisitors: number;
};
```

- [ ] In `calculateRankingSnapshotAt`, parse `season.policySnapshot`, select the aggregate for its scoring mode, and compute trend from the same policy mode. Distinct counts must always use retained raw events; a catch-up unique season older than raw retention must fail with an explicit `unique season raw events unavailable` error instead of summing daily distinct values.

- [ ] Persist and upsert all new ranking entry fields. Keep the existing 1,000-row batching, advisory lock order, transaction boundaries, scheduled-policy boundary checks, and last-known rollback behavior.

- [ ] In unique mode, filter out candidates below `minimumUniqueVisitors` before assigning rank. In legacy mode, preserve zero-click candidates exactly as today.

- [ ] Re-run the full ranking refresh target twice:

`npx vitest run --config vitest.integration.config.ts tests/integration/ranking-refresh.test.ts`

Expected: every test passes on both runs; no clock-dependent flake.

- [ ] Commit: `feat: refresh unique-first ranking seasons`

## Task 6: Preserve labels and read models across old and new seasons

**Files:**

- Modify: `lib/domain/ranking/view.ts`
- Modify: `components/RankingTable.tsx`
- Modify: `components/SeasonPolicy.tsx`
- Modify: `app/page.tsx`
- Modify: `app/rankings/[key]/page.tsx`
- Modify: `tests/integration/ranking-view.test.ts`
- Modify: `tests/ranking-components.test.ts`
- Modify: `tests/ranking-season-page.test.ts`

- [ ] Add RED tests proving:

  - old stored policies render `유효 방문` and old click-based change;
  - unique policies render `고유 유입자`, retain `유효 방문` as a secondary value, and use unique change;
  - category/query filtering preserves stored global rank;
  - all-time remains labelled `누적 유효 방문` and is not falsely relabelled unique;
  - trending excludes null change but includes qualified ranks outside the main leaderboard cap.

- [ ] Extend `RankingListItem` with `uniqueVisitors`, `recentUniqueVisitors`, `previousUniqueVisitors`, and `scoreMode`. Build `SeasonSummary.policy` with `parseRankingPolicy` so pre-migration JSON is normalized at runtime.

- [ ] Make `RankingTable` choose headers from `season.policy.scoring.mode`; do not infer labels from whether unique counts happen to be zero.

- [ ] Keep the mobile core values immediately visible and ensure every newly touched text class is at least `text-[13px]`.

- [ ] Run the three target test files and expect PASS.

- [ ] Commit: `feat: explain season ranking metrics`

## Task 7: Add the seven-day admin transition gate and dual preview

**Files:**

- Modify: `lib/domain/ranking/policies.ts`
- Modify: `lib/domain/ranking/view.ts`
- Modify: `app/admin/ranking/RankingPolicyForm.tsx`
- Modify: `app/admin/ranking/page.tsx`
- Modify: `app/admin/ranking/actions.ts`
- Modify: `tests/admin-ranking.test.ts`
- Modify: `tests/integration/ranking-policies.test.ts`

- [ ] Add RED tests for a collection start less than seven days ago, exactly seven days ago, a future season-only schedule, and a logged-out action.

- [ ] Export:

```ts
export type UniqueCollectionReadiness = {
  startedAt: Date | null;
  readyAt: Date | null;
  ready: boolean;
};
```

`schedulePolicy()` must reject a `unique_visitors` revision when collection has not started or before `readyAt`; legacy policies remain schedulable. Use the injected `now` and database timestamp consistently.

- [ ] Add form controls for scoring mode, repeat weight percent, extra-visit cap, minimum unique visitors, and minimum previous unique visitors. The unique option must start from `UNIQUE_FIRST_RANKING_POLICY`, not mutate the legacy object into a partially valid state.

- [ ] Render two preview columns while the active policy is legacy: current valid-visit rank and proposed unique-first rank. Show collection start, ready date, `집계 중`, and an explicit note that scheduling changes only the next season.

- [ ] Re-run admin unit and policy integration targets. Confirm auth still happens before reads/mutations.

- [ ] Commit: `feat: stage unique ranking transition`

## Task 8: Operational verification and handoff

**Files:**

- Modify: `README.md`
- Modify: `PENDING.md`
- Modify: `docs/CODEX_HANDOFF.md`

- [ ] Document `VISITOR_HASH_SECRET`, public metric definitions, seven-day warm-up, rotation impact, 35-day raw retention, and the prohibition on multi-day sums of daily unique visitors.

- [ ] Add the production secret and scheduler verification to `PENDING.md`; do not claim production collection started without production access.

- [ ] Run the exact matrix:

```sh
npx next typegen
npx tsc --noEmit
npm test
npm run test:integration
npm run lint
npm run build
git diff --check
```

- [ ] Run an independent review over the complete diff. Resolve every actionable P1/P2 with a RED regression test before changing implementation.

- [ ] Update `docs/CODEX_HANDOFF.md` with exact commands/results, migration state, warm-up status, failures, and the next plan path.

- [ ] Commit: `docs: operate unique visitor rankings`

## Completion criteria

- No raw visitor identifier reaches PostgreSQL or logs.
- Hashed and legacy events coexist safely.
- Unique counts are exact for active and finalized supported seasons.
- Old seasons and all-time retain honest valid-visit labels.
- Unique-first math, trend, cooldown, ties, and scheduled activation match the approved spec.
- Admin cannot accidentally activate unique ranking before seven full collection days.
- The full repository test/build matrix has been executed successfully.
