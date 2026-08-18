# Weekly Discovery Ranking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build configurable weekly/monthly discovery seasons whose verified products rank by valid clicks with transparent soft cooldowns, click-change metrics, admin scheduling, and historical results.

**Architecture:** Keep pure policy, period, and score calculations in `lib/domain/ranking/`; persist immutable policy revisions, season snapshots, and materialized ranking entries in PostgreSQL; and refresh the materialized view through the existing job runner. Server Components read ranking view models, while authenticated Server Actions schedule the next policy revision without mutating the active season.

**Tech Stack:** Next.js 16.3 App Router, React 19 Server Components and Server Actions, TypeScript, Drizzle ORM/PostgreSQL 17, Zod 4, Vitest, Tailwind CSS 4.

---

## File map

New focused modules:

- `lib/domain/ranking/policy.ts` — policy schema, defaults, validation, warnings.
- `lib/domain/ranking/period.ts` — KST weekly/monthly boundaries and cadence transitions.
- `lib/domain/ranking/math.ts` — percentage, cooldown, score, and deterministic sort calculations.
- `lib/domain/ranking/policies.ts` — immutable revision scheduling and cancellation.
- `lib/domain/ranking/refresh.ts` — transactional season rollover and entry materialization.
- `lib/domain/ranking/view.ts` — public/admin ranking read models and preview queries.
- `lib/jobs/products/ranking-refresh.ts` — job-runner adapter only.
- `components/DiscoveryBoards.tsx` — four public discovery boards.
- `components/RankingTable.tsx` — transparent season/trending/all-time result rows.
- `components/SeasonPolicy.tsx` — reusable active/historical methodology display.
- `app/admin/ranking/RankingPolicyForm.tsx` — client form state and scheduled-policy UX.
- `app/admin/ranking/actions.ts` — authenticated policy Server Actions.
- `app/admin/ranking/page.tsx` — administrator ranking page.
- `app/rankings/[key]/page.tsx` — current or historical season results and locked policy.

Existing files remain responsible for their current concerns. Do not move crawl settings into the
ranking modules and do not fold ranking refresh logic into the generic job runner.

### Task 1: Ranking policy contract and validation

**Files:**

- Create: `lib/domain/ranking/policy.ts`
- Create: `tests/ranking-policy.test.ts`

- [ ] **Step 1: Re-read the repository-specific Next.js references before application edits**

Run:

```bash
sed -n '1,510p' node_modules/next/dist/docs/01-app/02-guides/forms.md
sed -n '1,220p' node_modules/next/dist/docs/01-app/02-guides/server-actions.md
sed -n '1,420p' node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md
```

Expected: the docs confirm `params`/`searchParams` are promises, every Server Action must authorize
inside the action, and `useActionState` actions receive `(previousState, formData)`.

- [ ] **Step 2: Write failing policy tests**

Create `tests/ranking-policy.test.ts` with these cases:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RANKING_POLICY,
  rankingPolicySchema,
  rankingPolicyWarnings,
} from "@/lib/domain/ranking/policy";

describe("ranking policy", () => {
  it("accepts the approved default", () => {
    expect(rankingPolicySchema.parse(DEFAULT_RANKING_POLICY)).toEqual(DEFAULT_RANKING_POLICY);
  });

  it("rejects overlapping cooldown tiers", () => {
    const result = rankingPolicySchema.safeParse({
      ...DEFAULT_RANKING_POLICY,
      cooldown: {
        enabled: true,
        tiers: [
          { rankFrom: 1, rankTo: 3, factorsBasisPoints: [3500] },
          { rankFrom: 3, rankTo: 10, factorsBasisPoints: [6500] },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a decreasing recovery curve", () => {
    const result = rankingPolicySchema.safeParse({
      ...DEFAULT_RANKING_POLICY,
      cooldown: {
        enabled: true,
        tiers: [{ rankFrom: 1, rankTo: 10, factorsBasisPoints: [7000, 5000] }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("keeps the leaderboard inside the minimum pool", () => {
    expect(rankingPolicySchema.safeParse({
      ...DEFAULT_RANKING_POLICY,
      eligibility: { ...DEFAULT_RANKING_POLICY.eligibility, minimumProducts: 5 },
      leaderboard: { limit: 10 },
    }).success).toBe(false);
  });

  it("warns when a monthly launch window is shorter than a calendar month", () => {
    const policy = rankingPolicySchema.parse({
      ...DEFAULT_RANKING_POLICY,
      season: { ...DEFAULT_RANKING_POLICY.season, cadence: "monthly" },
      eligibility: { ...DEFAULT_RANKING_POLICY.eligibility, launchWindowDays: 14 },
    });
    expect(rankingPolicyWarnings(policy).join(" ")).toContain("월간");
  });
});
```

- [ ] **Step 3: Run the test and verify the missing module failure**

Run: `npx vitest run tests/ranking-policy.test.ts`

Expected: FAIL because `@/lib/domain/ranking/policy` does not exist.

- [ ] **Step 4: Implement the policy schema and defaults**

Create `lib/domain/ranking/policy.ts`. Use this public contract and these refinements:

```ts
import { z } from "zod";

const factorSchema = z.number().int().min(1).max(10_000);

const cooldownTierSchema = z.object({
  rankFrom: z.number().int().min(1).max(100),
  rankTo: z.number().int().min(1).max(100),
  factorsBasisPoints: z.array(factorSchema).min(1).max(52),
}).superRefine((tier, ctx) => {
  if (tier.rankTo < tier.rankFrom) {
    ctx.addIssue({ code: "custom", path: ["rankTo"], message: "끝 순위는 시작 순위 이상이어야 합니다" });
  }
  tier.factorsBasisPoints.slice(1).forEach((factor, index) => {
    if (factor < tier.factorsBasisPoints[index]) {
      ctx.addIssue({ code: "custom", path: ["factorsBasisPoints", index + 1], message: "쿨다운 배율은 시간이 갈수록 낮아질 수 없습니다" });
    }
  });
});

export const rankingPolicySchema = z.object({
  season: z.object({
    cadence: z.enum(["weekly", "monthly"]),
    timezone: z.literal("Asia/Seoul"),
  }),
  eligibility: z.object({
    launchWindowDays: z.number().int().min(1).max(3650),
    minimumProducts: z.number().int().min(1).max(50_000),
    maximumWindowDays: z.number().int().min(1).max(3650),
  }),
  leaderboard: z.object({ limit: z.number().int().min(1).max(100) }),
  cooldown: z.object({ enabled: z.boolean(), tiers: z.array(cooldownTierSchema).max(20) }),
  trend: z.object({
    windowHours: z.number().int().min(1).max(168),
    minimumPreviousClicks: z.number().int().min(1).max(100_000),
    limit: z.number().int().min(1).max(20),
  }),
  boards: z.object({
    weeklyLimit: z.number().int().min(1).max(20),
    verifiedNewLimit: z.number().int().min(1).max(20),
    discoveredNewLimit: z.number().int().min(1).max(20),
  }),
}).superRefine((policy, ctx) => {
  if (policy.eligibility.maximumWindowDays < policy.eligibility.launchWindowDays) {
    ctx.addIssue({ code: "custom", path: ["eligibility", "maximumWindowDays"], message: "최대 기간은 기본 참가 기간 이상이어야 합니다" });
  }
  if (policy.leaderboard.limit > policy.eligibility.minimumProducts) {
    ctx.addIssue({ code: "custom", path: ["leaderboard", "limit"], message: "표시 순위는 최소 참가 제품 수 이하여야 합니다" });
  }
  const tiers = [...policy.cooldown.tiers].sort((a, b) => a.rankFrom - b.rankFrom);
  let expected = 1;
  for (const [index, tier] of tiers.entries()) {
    if (tier.rankFrom !== expected) {
      ctx.addIssue({ code: "custom", path: ["cooldown", "tiers", index], message: "쿨다운 순위 범위는 1위부터 빈틈과 겹침 없이 이어져야 합니다" });
    }
    if (tier.rankTo > policy.leaderboard.limit) {
      ctx.addIssue({ code: "custom", path: ["cooldown", "tiers", index, "rankTo"], message: "쿨다운 범위는 공개 랭킹 안이어야 합니다" });
    }
    expected = tier.rankTo + 1;
  }
});

export type RankingPolicy = z.infer<typeof rankingPolicySchema>;

export const DEFAULT_RANKING_POLICY: RankingPolicy = rankingPolicySchema.parse({
  season: { cadence: "weekly", timezone: "Asia/Seoul" },
  eligibility: { launchWindowDays: 28, minimumProducts: 20, maximumWindowDays: 90 },
  leaderboard: { limit: 10 },
  cooldown: {
    enabled: true,
    tiers: [
      { rankFrom: 1, rankTo: 3, factorsBasisPoints: [3500, 5500, 7500, 9000] },
      { rankFrom: 4, rankTo: 10, factorsBasisPoints: [6500, 8000, 9000, 10_000] },
    ],
  },
  trend: { windowHours: 24, minimumPreviousClicks: 5, limit: 4 },
  boards: { weeklyLimit: 3, verifiedNewLimit: 3, discoveredNewLimit: 3 },
});

export function rankingPolicyWarnings(policy: RankingPolicy): string[] {
  const warnings: string[] = [];
  if (policy.season.cadence === "monthly" && policy.eligibility.launchWindowDays < 28) {
    warnings.push("월간 시즌보다 출시 참가 기간이 짧아 후보가 빨리 줄 수 있습니다.");
  }
  const longestCooldown = Math.max(0, ...policy.cooldown.tiers.map((tier) => tier.factorsBasisPoints.length));
  const approximateSeasonDays = policy.season.cadence === "weekly" ? 7 : 31;
  if (longestCooldown * approximateSeasonDays > policy.eligibility.maximumWindowDays) {
    warnings.push("쿨다운이 끝나기 전에 제품의 출시 참가 기간이 끝날 수 있습니다.");
  }
  return warnings;
}
```

- [ ] **Step 5: Run policy tests and commit**

Run: `npx vitest run tests/ranking-policy.test.ts`

Expected: PASS, 5 tests.

```bash
git add lib/domain/ranking/policy.ts tests/ranking-policy.test.ts
git commit -m "feat: define ranking policy"
```

### Task 2: KST periods, cooldowns, and click-change math

**Files:**

- Create: `lib/domain/ranking/period.ts`
- Create: `lib/domain/ranking/math.ts`
- Create: `tests/ranking-period.test.ts`
- Create: `tests/ranking-math.test.ts`

- [ ] **Step 1: Write failing period and score tests**

Create `tests/ranking-period.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nextSeasonPeriod, periodContaining } from "@/lib/domain/ranking/period";

describe("KST season periods", () => {
  it("starts a weekly season on Monday 00:00 KST", () => {
    const period = periodContaining(new Date("2026-08-18T03:00:00.000Z"), "weekly");
    expect(period).toMatchObject({ key: "2026-W34", isTransition: false });
    expect(period.startsAt.toISOString()).toBe("2026-08-16T15:00:00.000Z");
    expect(period.endsAt.toISOString()).toBe("2026-08-23T15:00:00.000Z");
  });

  it("uses first-to-first calendar months", () => {
    const period = periodContaining(new Date("2026-08-18T03:00:00.000Z"), "monthly");
    expect(period.startsAt.toISOString()).toBe("2026-07-31T15:00:00.000Z");
    expect(period.endsAt.toISOString()).toBe("2026-08-31T15:00:00.000Z");
  });

  it("creates a short transition when cadence changes off-boundary", () => {
    const current = periodContaining(new Date("2026-08-18T03:00:00.000Z"), "weekly");
    const next = nextSeasonPeriod(current.endsAt, "monthly");
    expect(next.isTransition).toBe(true);
    expect(next.startsAt).toEqual(current.endsAt);
    expect(next.endsAt.toISOString()).toBe("2026-08-31T15:00:00.000Z");
  });
});
```

Create `tests/ranking-math.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import { clickChangePercent, cooldownFactor, rankRows } from "@/lib/domain/ranking/math";

describe("ranking math", () => {
  it("calculates click percentage and refuses a small baseline", () => {
    expect(clickChangePercent(12, 8, 5)).toBe(50);
    expect(clickChangePercent(3, 1, 5)).toBeNull();
    expect(clickChangePercent(0, 5, 5)).toBe(-100);
  });

  it("uses the strongest overlapping cooldown", () => {
    expect(cooldownFactor(DEFAULT_RANKING_POLICY.cooldown, [
      { rank: 2, seasonsAgo: 2 },
      { rank: 7, seasonsAgo: 1 },
    ])).toBe(5500);
  });

  it("sorts by adjusted score, clicks, verified time, then slug", () => {
    const rows = rankRows([
      { slug: "older", validClicks: 20, factorBasisPoints: 5000, verifiedAt: new Date("2026-01-01") },
      { slug: "newer", validClicks: 10, factorBasisPoints: 10_000, verifiedAt: new Date("2026-02-01") },
    ]);
    expect(rows.map((row) => [row.slug, row.rank])).toEqual([["newer", 1], ["older", 2]]);
  });
});
```

- [ ] **Step 2: Run both files and verify missing-module failures**

Run: `npx vitest run tests/ranking-period.test.ts tests/ranking-math.test.ts`

Expected: FAIL because `period.ts` and `math.ts` do not exist.

- [ ] **Step 3: Implement KST boundaries**

Create `lib/domain/ranking/period.ts` with `KST_OFFSET_MS = 9 * 60 * 60 * 1000`, UTC-only
date operations, and this contract:

```ts
export type SeasonCadence = "weekly" | "monthly";
export type SeasonPeriod = {
  key: string;
  cadence: SeasonCadence;
  startsAt: Date;
  endsAt: Date;
  isTransition: boolean;
};

export function periodContaining(now: Date, cadence: SeasonCadence): SeasonPeriod;
export function nextSeasonPeriod(after: Date, cadence: SeasonCadence): SeasonPeriod;
```

For weekly keys, calculate the ISO week from the shifted KST calendar date. For monthly keys, use
`YYYY-MM`. In `nextSeasonPeriod`, return the natural period when `after` equals its start; otherwise
return `[after, natural.endsAt)` with `isTransition: true` and key
`${natural.key}-transition-${YYYYMMDD}`. Reject an `after` at or beyond `natural.endsAt` as a coding
error instead of creating a zero-length season.

- [ ] **Step 4: Implement ranking math**

Create `lib/domain/ranking/math.ts` with these exact exported types and functions:

```ts
import type { RankingPolicy } from "./policy";

export type PriorFinish = { rank: number; seasonsAgo: number };
export type ScoreInput = {
  slug: string;
  validClicks: number;
  factorBasisPoints: number;
  verifiedAt: Date;
};
export type RankedScore = ScoreInput & { scoreUnits: number; rank: number };

export function clickChangePercent(recent: number, previous: number, minimumPrevious: number) {
  if (previous < minimumPrevious) return null;
  return Math.round((((recent - previous) / previous) * 100) * 10) / 10;
}

export function cooldownFactor(
  cooldown: RankingPolicy["cooldown"],
  finishes: PriorFinish[],
): number {
  if (!cooldown.enabled) return 10_000;
  return finishes.reduce((strongest, finish) => {
    const tier = cooldown.tiers.find((item) => finish.rank >= item.rankFrom && finish.rank <= item.rankTo);
    const factor = tier?.factorsBasisPoints[finish.seasonsAgo - 1] ?? 10_000;
    return Math.min(strongest, factor);
  }, 10_000);
}

export function rankRows(rows: ScoreInput[]): RankedScore[] {
  return rows
    .map((row) => ({ ...row, scoreUnits: row.validClicks * row.factorBasisPoints }))
    .sort((a, b) =>
      b.scoreUnits - a.scoreUnits ||
      b.validClicks - a.validClicks ||
      b.verifiedAt.getTime() - a.verifiedAt.getTime() ||
      a.slug.localeCompare(b.slug),
    )
    .map((row, index) => ({ ...row, rank: index + 1 }));
}
```

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run tests/ranking-period.test.ts tests/ranking-math.test.ts`

Expected: PASS, 6 tests.

```bash
git add lib/domain/ranking/period.ts lib/domain/ranking/math.ts tests/ranking-period.test.ts tests/ranking-math.test.ts
git commit -m "feat: calculate ranking seasons and scores"
```

### Task 3: Ranking persistence and KST daily rollups

**Files:**

- Modify: `lib/db/schema.ts:1-150`
- Modify: `lib/domain/products/clicks.ts:145-190`
- Modify: `tests/integration/setup.ts:25-31`
- Create: `tests/integration/ranking-schema.test.ts`
- Create: `drizzle/0012_ranking_seasons.sql`
- Create: `drizzle/meta/0012_snapshot.json`
- Modify: `drizzle/meta/_journal.json`

- [ ] **Step 1: Add a failing schema integration test**

Create `tests/integration/ranking-schema.test.ts` that inserts one policy revision, one season, and
one entry, then asserts a second scheduled revision and a second active season violate the partial
unique indexes. Import the new tables from `@/lib/db/schema` and call `ensureSchema()` in `beforeAll`.
Use this successful row shape:

```ts
const [revision] = await db.insert(rankingPolicyRevisions).values({
  values: DEFAULT_RANKING_POLICY,
  state: "applied",
  createdBy: "test",
  appliedAt: new Date(),
}).returning();

const [season] = await db.insert(rankingSeasons).values({
  key: "2026-W34",
  cadence: "weekly",
  startsAt: new Date("2026-08-16T15:00:00Z"),
  endsAt: new Date("2026-08-23T15:00:00Z"),
  state: "active",
  policyRevisionId: revision.id,
  policySnapshot: DEFAULT_RANKING_POLICY,
  effectiveLaunchWindowDays: 28,
  isTransition: false,
}).returning();

await db.insert(rankingEntries).values({
  seasonId: season.id,
  slug: "product",
  validClicks: 10,
  cooldownFactorBasisPoints: 3500,
  scoreUnits: 35_000,
  rank: 1,
  recentClicks: 3,
  previousClicks: 2,
  changePercent: 50,
});
```

- [ ] **Step 2: Run the schema test and verify it fails**

Prerequisite, only if the test DB is not already running:

```bash
docker run -d --name nomorevibe-test-db -e POSTGRES_USER=nomorevibe -e POSTGRES_PASSWORD=nomorevibe -e POSTGRES_DB=nomorevibe_test -p 55435:5432 postgres:17
```

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/ranking-schema.test.ts`

Expected: FAIL because the ranking table exports do not exist.

- [ ] **Step 3: Add the Drizzle table definitions**

Extend `lib/db/schema.ts` imports with `boolean`, `bigint`, `numeric`, and `uniqueIndex`. Define:

```ts
export type RankingPolicyRevisionState = "scheduled" | "applied" | "cancelled";
export type RankingSeasonState = "active" | "closed";

export const rankingPolicyRevisions = pgTable("ranking_policy_revisions", {
  id: serial("id").primaryKey(),
  values: jsonb("values").$type<import("@/lib/domain/ranking/policy").RankingPolicy>().notNull(),
  state: varchar("state", { length: 20 }).$type<RankingPolicyRevisionState>().notNull(),
  createdBy: varchar("created_by", { length: 120 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  appliedAt: timestamp("applied_at"),
  cancelledAt: timestamp("cancelled_at"),
}, (table) => [
  uniqueIndex("ranking_policy_one_scheduled_idx").on(table.state).where(sql`${table.state} = 'scheduled'`),
]);

export const rankingSeasons = pgTable("ranking_seasons", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 48 }).notNull().unique(),
  cadence: varchar("cadence", { length: 10 }).$type<"weekly" | "monthly">().notNull(),
  startsAt: timestamp("starts_at").notNull(),
  endsAt: timestamp("ends_at").notNull(),
  state: varchar("state", { length: 10 }).$type<RankingSeasonState>().notNull(),
  policyRevisionId: integer("policy_revision_id").notNull().references(() => rankingPolicyRevisions.id),
  policySnapshot: jsonb("policy_snapshot").$type<import("@/lib/domain/ranking/policy").RankingPolicy>().notNull(),
  effectiveLaunchWindowDays: integer("effective_launch_window_days").notNull(),
  isTransition: boolean("is_transition").notNull().default(false),
  refreshedAt: timestamp("refreshed_at"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  closedAt: timestamp("closed_at"),
}, (table) => [
  uniqueIndex("ranking_seasons_one_active_idx").on(table.state).where(sql`${table.state} = 'active'`),
  index("ranking_seasons_dates_idx").on(table.startsAt, table.endsAt),
]);

export const rankingEntries = pgTable("ranking_entries", {
  seasonId: integer("season_id").notNull().references(() => rankingSeasons.id),
  slug: varchar("slug", { length: 80 }).notNull(),
  validClicks: integer("valid_clicks").notNull().default(0),
  cooldownFactorBasisPoints: integer("cooldown_factor_basis_points").notNull().default(10_000),
  scoreUnits: bigint("score_units", { mode: "number" }).notNull().default(0),
  rank: integer("rank").notNull(),
  changePercent: numeric("change_percent", { precision: 12, scale: 1, mode: "number" }),
  recentClicks: integer("recent_clicks").notNull().default(0),
  previousClicks: integer("previous_clicks").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  finalizedAt: timestamp("finalized_at"),
}, (table) => [
  primaryKey({ columns: [table.seasonId, table.slug] }),
  index("ranking_entries_rank_idx").on(table.seasonId, table.rank),
]);

export type RankingPolicyRevision = typeof rankingPolicyRevisions.$inferSelect;
export type RankingSeason = typeof rankingSeasons.$inferSelect;
export type RankingEntry = typeof rankingEntries.$inferSelect;
```

Add `index("click_events_time_slug_idx").on(t.occurredAt, t.slug)` beside the existing slug/time
index. Do not add a product foreign key to ranking entries: banned/deleted product traces are cleaned
explicitly by the existing product removal path.

Change the `productClickDaily.day` schema comment from UTC to KST so future maintenance does not
silently restore the old boundary.

- [ ] **Step 4: Generate and inspect the migration**

Run: `npx drizzle-kit generate --name=ranking_seasons`

Expected: creates `drizzle/0012_ranking_seasons.sql`, `drizzle/meta/0012_snapshot.json`, and updates
the journal. Open the SQL and verify it contains all three tables, both partial unique indexes, and
the new click time/slug index.

Append these statements to `drizzle/0012_ranking_seasons.sql` so recent daily data is rebuilt on KST
calendar days before the first season:

```sql
DELETE FROM "product_click_daily"
WHERE "day" >= ((now() AT TIME ZONE 'Asia/Seoul')::date - 35);

INSERT INTO "product_click_daily" ("slug", "day", "clicks")
SELECT
  "slug",
  timezone('Asia/Seoul', "occurred_at" AT TIME ZONE 'UTC')::date,
  count(*)::int
FROM "click_events"
WHERE "occurred_at" >= now() - interval '35 days'
GROUP BY 1, 2
ON CONFLICT ("slug", "day") DO UPDATE SET "clicks" = excluded."clicks";
```

- [ ] **Step 5: Make runtime rollups use the same KST day and reset test tables safely**

In `rollupDaily()` replace the day expression with:

```ts
day: sql<string>`timezone('Asia/Seoul', ${clickEvents.occurredAt} AT TIME ZONE 'UTC')::date`,
```

In `tests/integration/setup.ts`, change the reset SQL to:

```ts
await db.execute(sql`
  TRUNCATE ranking_entries, ranking_seasons, ranking_policy_revisions,
           products, og_images RESTART IDENTITY CASCADE
`);
```

Also add `rankingEntries` deletion to `removeTraces(slug)` in
`lib/domain/products/repository.ts` so slug reuse cannot inherit historical rows.

- [ ] **Step 6: Run schema, click, and migration tests and commit**

Run:

```bash
npx vitest run --config vitest.integration.config.ts tests/integration/ranking-schema.test.ts tests/integration/clicks.test.ts
git diff --check
```

Expected: PASS for both files and no whitespace errors.

```bash
git add lib/db/schema.ts lib/domain/products/clicks.ts lib/domain/products/repository.ts tests/integration/setup.ts tests/integration/ranking-schema.test.ts drizzle
git commit -m "feat: persist ranking seasons"
```

### Task 4: Immutable policy scheduling

**Files:**

- Create: `lib/domain/ranking/policies.ts`
- Create: `tests/integration/ranking-policies.test.ts`

- [ ] **Step 1: Write failing scheduling tests**

Create integration tests that assert:

```ts
const initial = await ensureDefaultPolicy("system", now);
expect(initial.state).toBe("applied");
expect(initial.values).toEqual(DEFAULT_RANKING_POLICY);

const first = await schedulePolicy({
  ...DEFAULT_RANKING_POLICY,
  eligibility: { ...DEFAULT_RANKING_POLICY.eligibility, launchWindowDays: 21 },
}, "jr", now);
expect(first.ok).toBe(true);

const second = await schedulePolicy({
  ...DEFAULT_RANKING_POLICY,
  trend: { ...DEFAULT_RANKING_POLICY.trend, minimumPreviousClicks: 8 },
}, "jr", new Date(now.getTime() + 1000));
expect(second.ok).toBe(true);
expect((await listPolicyRevisions()).map((row) => row.state)).toEqual([
  "applied", "cancelled", "scheduled",
]);

await cancelScheduledPolicy("jr", new Date(now.getTime() + 2000));
expect(await getScheduledPolicy()).toBeUndefined();
```

Also assert invalid input returns `{ ok: false, issues }` and inserts no revision.

- [ ] **Step 2: Run and verify the missing module failure**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/ranking-policies.test.ts`

Expected: FAIL because `policies.ts` does not exist.

- [ ] **Step 3: Implement policy revision operations**

Create `lib/domain/ranking/policies.ts` with these exports:

```ts
export type PolicySaveResult =
  | { ok: true; revision: RankingPolicyRevision; warnings: string[] }
  | { ok: false; issues: string[] };

export async function ensureDefaultPolicy(createdBy = "system", now = new Date()): Promise<RankingPolicyRevision>;
export async function getAppliedPolicy(): Promise<RankingPolicyRevision | undefined>;
export async function getScheduledPolicy(): Promise<RankingPolicyRevision | undefined>;
export async function listPolicyRevisions(): Promise<RankingPolicyRevision[]>;
export async function schedulePolicy(raw: unknown, createdBy: string, now = new Date()): Promise<PolicySaveResult>;
export async function cancelScheduledPolicy(cancelledBy: string, now = new Date()): Promise<void>;
```

Implementation rules:

- Parse with `rankingPolicySchema.safeParse()` before opening a transaction.
- Start every mutating transaction with
  `tx.execute(sql\`select pg_advisory_xact_lock(hashtext('ranking-policy'))\`)` so concurrent first
  use and admin saves cannot create duplicate defaults or race the partial scheduled index.
- `ensureDefaultPolicy` returns the latest applied row or inserts one applied default revision.
- `schedulePolicy` updates any scheduled row to `cancelled`, then inserts the parsed row as
  `scheduled` in the same transaction.
- `cancelScheduledPolicy` updates only `state = 'scheduled'`; log `cancelledBy` through the existing
  logger because the table records the original author.
- Order `listPolicyRevisions()` by `createdAt` ascending for deterministic admin history.
- Never return raw Zod objects or database errors to a Server Action caller.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/ranking-policies.test.ts`

Expected: PASS.

```bash
git add lib/domain/ranking/policies.ts tests/integration/ranking-policies.test.ts
git commit -m "feat: schedule ranking policies"
```

### Task 5: Transactional season refresh and rollover

**Files:**

- Create: `lib/domain/ranking/refresh.ts`
- Create: `lib/jobs/products/ranking-refresh.ts`
- Modify: `lib/jobs/registry.ts:1-55`
- Create: `tests/integration/ranking-refresh.test.ts`

- [ ] **Step 1: Write failing refresh tests**

Use a fixed `now = new Date("2026-08-18T03:00:00Z")`. Insert verified products with explicit
`verifiedAt`, one seeded product, and click events inside/outside the season. Assert:

```ts
const first = await refreshRanking(now);
expect(first).toMatchObject({ createdSeason: true, entries: 2 });

const season = await db.query.rankingSeasons.findFirst();
expect(season).toMatchObject({ key: "2026-W34", state: "active", isTransition: false });

const entries = await db.select().from(rankingEntries).orderBy(rankingEntries.rank);
expect(entries.map((entry) => entry.slug)).toEqual(["verified-a", "verified-b"]);
expect(entries.some((entry) => entry.slug === "seeded-one")).toBe(false);

await refreshRanking(now);
expect(await db.$count(rankingSeasons)).toBe(1);
expect(await db.$count(rankingEntries)).toBe(2);
```

Add a rollover test that schedules a monthly policy, refreshes just after the weekly end, and
asserts the old season is closed/finalized, the new season is a monthly transition ending September
1 KST, and the scheduled revision becomes applied exactly once. Add a cooldown test by finalizing a
Top 3 entry and asserting the next season factor is 3500.

- [ ] **Step 2: Run and verify failure**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/ranking-refresh.test.ts`

Expected: FAIL because `refreshRanking` does not exist.

- [ ] **Step 3: Implement a shared snapshot calculator**

In `lib/domain/ranking/refresh.ts`, define:

```ts
export type CalculatedEntry = {
  slug: string;
  validClicks: number;
  cooldownFactorBasisPoints: number;
  scoreUnits: number;
  rank: number;
  recentClicks: number;
  previousClicks: number;
  changePercent: number | null;
};

export async function calculateRankingSnapshot(
  executor: RankingExecutor,
  season: RankingSeason,
  at: Date,
  policy: RankingPolicy = season.policySnapshot,
): Promise<CalculatedEntry[]>;
```

Define the executor once so both the top-level database and a transaction satisfy the same helper:

```ts
type RankingTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type RankingExecutor = typeof db | RankingTransaction;
```

The query must:

- select only `products.status = 'verified'`;
- constrain `verifiedAt` to `[season.startsAt - effectiveWindow, min(at, season.endsAt))`;
- count season clicks in `[season.startsAt, min(at, season.endsAt))`;
- count recent and previous rolling windows with SQL `filter` clauses;
- fetch closed-season finishes no further back than the longest factor array;
- pass every product through `cooldownFactor`, `clickChangePercent`, and `rankRows`;
- return all eligible products, including zero-click products.

Put season click aggregation behind `aggregateSeasonClicks(executor, startsAt, endsAt, slugs)`. Use
raw events when the entire range is still retained. For missed closed seasons older than raw-event
retention, sum `product_click_daily` because every season and transition boundary is KST midnight.
Trend windows always use raw events because the maximum configured pair is 14 days, inside the
35-day retention period.

Put eligibility-window selection in a private helper that fetches verified dates inside the maximum
window, uses the configured window when it already reaches the minimum, otherwise expands to the
smallest whole-day window containing the minimum-th newest product, capped at the maximum.

- [ ] **Step 4: Implement refresh and rollover in one transaction**

Export:

```ts
export type RankingRefreshResult = {
  createdSeason: boolean;
  closedSeasons: number;
  entries: number;
  seasonKey: string;
};

export async function refreshRanking(now = new Date()): Promise<RankingRefreshResult>;
export async function previewRanking(policy: RankingPolicy, now = new Date()): Promise<CalculatedEntry[]>;
```

Inside `db.transaction()`:

1. Ensure the default applied revision exists.
2. Load the single active season.
3. While `now >= active.endsAt`, recalculate at exactly `active.endsAt`, upsert and finalize entries,
   close the season, choose the scheduled or inherited revision, call `nextSeasonPeriod`, create the
   next season, and mark the scheduled revision applied.
4. If there was no active season, create `periodContaining(now, applied.values.season.cadence)`.
5. Calculate the current snapshot, delete active entries whose slugs are no longer eligible, upsert
   the calculated entries, and update `rankingSeasons.refreshedAt = now`.

Use the `(season_id, slug)` primary key for `onConflictDoUpdate`. Empty candidate arrays must delete
all current entries without calling `notInArray([])`. Keep finalized entries untouched outside the
explicit close step.

Parse a scheduled revision's stored JSON again before applying it. If parsing fails, log
`ranking.policy_invalid`, mark that revision cancelled, and inherit the last applied policy. Add an
integration case that corrupts a scheduled JSON row directly and proves rollover still creates the
next season from the known-good active snapshot.

Add a failure regression by making snapshot aggregation throw after a successful refresh; assert the
transaction rolls back and the earlier entries plus `refreshedAt` remain unchanged while the job
runner records the error.

`previewRanking` creates an in-memory season-shaped object for the next period and calls the same
calculator without inserting, updating, closing, or applying revisions.

- [ ] **Step 5: Add the job adapter and registry entry**

Create `lib/jobs/products/ranking-refresh.ts`:

```ts
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { refreshRanking } from "@/lib/domain/ranking/refresh";

export async function refreshRankings(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const result = await refreshRanking();
  ctx.log("ranking.refreshed", result);
  return { done: true };
}
```

Import it in `lib/jobs/registry.ts` and add `"ranking-refresh": refreshRankings` immediately after
`click-rollup`.

- [ ] **Step 6: Run refresh and job regressions and commit**

Run:

```bash
npx vitest run --config vitest.integration.config.ts tests/integration/ranking-refresh.test.ts tests/integration/job-runner.test.ts
npm test
```

Expected: all selected integration tests and the unit suite PASS.

```bash
git add lib/domain/ranking/refresh.ts lib/jobs/products/ranking-refresh.ts lib/jobs/registry.ts tests/integration/ranking-refresh.test.ts
git commit -m "feat: refresh seasonal rankings"
```

### Task 6: Ranking read models and corrected click percentages

**Files:**

- Create: `lib/domain/ranking/view.ts`
- Modify: `lib/domain/products/clicks.ts:90-145`
- Modify: `lib/domain/products/stats.ts:15-65`
- Modify: `lib/domain/products/view.ts:25-105`
- Modify: `tests/integration/clicks.test.ts`
- Create: `tests/integration/ranking-view.test.ts`

- [ ] **Step 1: Change tests to require percentages, qualified trending, and global ranks**

In `tests/integration/clicks.test.ts`, insert 12 recent clicks and 8 previous clicks, then assert:

```ts
const metrics = await clickMetrics(["app"], { windowHours: 24, minimumPreviousClicks: 5 });
expect(metrics.get("app")).toEqual({ clicks: 20, changePercent: 50 });
```

Add a low-baseline case asserting `changePercent: null`. Update the market-stats test to assert the
aggregate change percentage.

In `tests/integration/ranking-view.test.ts`, materialize ranks 1-3 in two categories and assert:

```ts
const dev = await getSeasonRanking({ seasonKey: "2026-W34", category: "Dev", limit: 10 });
expect(dev.items.map((item) => item.rank)).toEqual([2]);
expect(dev.items[0]).toMatchObject({ validClicks: 20, cooldownFactorBasisPoints: 8000 });
```

Also assert trending excludes `changePercent = null`, newly discovered returns seeded products, and
the competitive list never does.

- [ ] **Step 2: Run and verify assertion/type failures**

Run:

```bash
npx vitest run --config vitest.integration.config.ts tests/integration/clicks.test.ts tests/integration/ranking-view.test.ts
```

Expected: FAIL because `clickMetrics` returns `delta24h` and ranking view functions do not exist.

- [ ] **Step 3: Correct the click metric contract**

Change the product click metric to:

```ts
export type ClickMetricOptions = { windowHours: number; minimumPreviousClicks: number };
export type ClickMetrics = { clicks: number; changePercent: number | null };

export async function clickMetrics(
  slugs: string[],
  options: ClickMetricOptions = { windowHours: 24, minimumPreviousClicks: 5 },
): Promise<Map<string, ClickMetrics>>;
```

Count recent and previous windows in the existing grouped SQL and call `clickChangePercent` for the
percentage. Preserve the seven-day `clicks` total for non-season recent cards. Rename
`ProductListItem.metrics.delta24h` to `changePercent` and render a `%` sign in `ProductCard`.

Extend `MarketStats` with `clicksChangePercent: number | null`; change `marketStats()` to accept
`{ windowHours?: number }`, count both adjacent windows in one query, and use `clickChangePercent`
with a minimum of one aggregate click.

- [ ] **Step 4: Implement ranking public/admin view models**

Create `lib/domain/ranking/view.ts` with:

```ts
export type RankingListItem = ProductListItem & {
  rank: number;
  validClicks: number;
  changePercent: number | null;
  cooldownFactorBasisPoints: number;
  previousRank: number | null;
};

export type SeasonSummary = {
  key: string;
  cadence: "weekly" | "monthly";
  startsAt: Date;
  endsAt: Date;
  isTransition: boolean;
  effectiveLaunchWindowDays: number;
  policy: RankingPolicy;
  refreshedAt: Date | null;
  state: "active" | "closed";
};

export async function getCurrentSeason(): Promise<SeasonSummary | null>;
export async function getSeasonRanking(options: {
  seasonKey?: string;
  order?: "rank" | "trending";
  category?: Category;
  query?: string;
  limit: number;
}): Promise<{ season: SeasonSummary | null; items: RankingListItem[] }>;
export async function getDiscoveryBoards(): Promise<{
  weekly: RankingListItem[];
  trending: RankingListItem[];
  verifiedNew: ProductListItem[];
  discoveredNew: ProductListItem[];
}>;
export async function getSeasonHistory(limit?: number): Promise<SeasonSummary[]>;
export async function getAllTimeRanking(options: {
  category?: Category;
  query?: string;
  limit: number;
}): Promise<RankingListItem[]>;
export async function getRankingAdminState(now?: Date): Promise<{
  active: SeasonSummary | null;
  scheduled: RankingPolicyRevision | null;
  revisions: RankingPolicyRevision[];
  preview: CalculatedEntry[];
}>;
```

Join entries to products in SQL so category/query filtering does not renumber stored global ranks.
Map products through the existing `toListItem`, then attach health in one batch. Extract and export
`withProductHealth(items)` from `products/view.ts`; keep `withMetrics(items)` private so ranking reads
do not query raw clicks a second time. Add `getVerifiedList()` for the verified-only recent tab and
keep `getPublicList()` for the separate discovery board. `getAllTimeRanking()` maps
`topClickedSince()` into rank rows with a 100% factor and null change, then resolves products in one
query instead of one slug at a time.

For `previousRank`, look up the most recent closed season before the displayed season and map its
entries by slug. If there is no preceding season or no entry for that product, return null.

Export `RANKING_STALE_MS = 2 * 60 * 60 * 1000`; UI consumers use it only to label snapshot age and
never to discard the last good snapshot.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npx vitest run --config vitest.integration.config.ts tests/integration/clicks.test.ts tests/integration/ranking-view.test.ts
npm test
```

Expected: PASS.

```bash
git add lib/domain/ranking/view.ts lib/domain/products/clicks.ts lib/domain/products/stats.ts lib/domain/products/view.ts components/ProductCard.tsx tests/integration/clicks.test.ts tests/integration/ranking-view.test.ts
git commit -m "feat: expose ranking read models"
```

### Task 7: Ranking administrator page and Server Actions

**Files:**

- Create: `app/admin/ranking/actions.ts`
- Create: `app/admin/ranking/RankingPolicyForm.tsx`
- Create: `app/admin/ranking/page.tsx`
- Modify: `app/admin/AdminNav.tsx:3-10`
- Modify: `app/admin/status/page.tsx:65-150`

- [ ] **Step 1: Implement authenticated actions before wiring the client**

Create `app/admin/ranking/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { cancelScheduledPolicy, schedulePolicy } from "@/lib/domain/ranking/policies";

export type RankingPolicyActionState = {
  ok?: true;
  issues?: string[];
  warnings?: string[];
} | null;

export async function saveRankingPolicy(
  _previous: RankingPolicyActionState,
  form: FormData,
): Promise<RankingPolicyActionState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };

  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get("policy") ?? ""));
  } catch {
    return { issues: ["설정 형식을 읽을 수 없습니다."] };
  }
  const result = await schedulePolicy(raw, admin.login);
  if (!result.ok) return { issues: result.issues };
  revalidatePath("/admin/ranking");
  return { ok: true, warnings: result.warnings };
}

export async function cancelRankingPolicy(): Promise<void> {
  const admin = await currentAdmin();
  if (!admin) return;
  await cancelScheduledPolicy(admin.login);
  revalidatePath("/admin/ranking");
}
```

Do not trust the hidden JSON; `schedulePolicy` must parse it again with Zod. Do not expose database
rows in the action state.

- [ ] **Step 2: Build the client form with editable cooldown rows**

Create `RankingPolicyForm.tsx` as a Client Component using `useState<RankingPolicy>` and
`useActionState(saveRankingPolicy, null)`. Render the approved sections:

- cadence select;
- launch/minimum/maximum windows;
- leaderboard and board limits;
- cooldown toggle;
- tier rows with editable rank bounds and comma-separated percentages;
- trend hours, baseline, and limit;
- hidden `<input name="policy" value={JSON.stringify(policy)} />`;
- pending-disabled `다음 시즌에 예약` button;
- `aria-live="polite"` success/error/warning blocks.

When parsing a factor input, use:

```ts
function percentList(value: string): number[] {
  return value.split(",").map((item) => Math.round(Number(item.trim()) * 100));
}
```

Keep the previous valid client state when an input parses to `NaN`; the server remains authoritative.
Provide `+ 구간` and `구간 삭제` buttons that update the tier array without submitting the form.

- [ ] **Step 3: Build the Server Component page**

Create `app/admin/ranking/page.tsx` with `export const dynamic = "force-dynamic"`. Authorize with
`currentAdmin()` and `redirect("/admin/login")`. Load `getRankingAdminState()` and render:

- active season dates, eligible count, valid clicks, last refresh;
- active policy as read-only `SeasonPolicy`;
- scheduled-vs-active summary;
- `RankingPolicyForm` seeded with scheduled values or the active/default policy;
- preview rows labelled `예상 결과`;
- a separate cancellation form using `cancelRankingPolicy` when scheduled settings exist.

Add `{ href: "/admin/ranking", label: "랭킹" }` to `AdminNav`. In `/admin/status`, leave the generic
jobs table as the source of ranking-refresh status and add a ranking panel showing current season
and snapshot age; do not add a second job-status query.

- [ ] **Step 4: Run lint and build, then manually verify auth**

Run:

```bash
npm run lint
npm run build
```

Expected: both commands exit 0. While logged out, requesting `/admin/ranking` redirects to
`/admin/login`; every action also returns without mutation because it calls `currentAdmin()`.

- [ ] **Step 5: Commit**

```bash
git add app/admin/ranking app/admin/AdminNav.tsx app/admin/status/page.tsx
git commit -m "feat: manage ranking policy"
```

### Task 8: Weekly discovery home and transparent ranking table

**Files:**

- Create: `components/DiscoveryBoards.tsx`
- Create: `components/RankingTable.tsx`
- Modify: `components/BrowseFilters.tsx:10-88`
- Modify: `components/MarketStats.tsx:11-40`
- Modify: `app/page.tsx:1-104`
- Create: `tests/home-sort.test.ts`

- [ ] **Step 1: Write a failing compatibility test for the public sort**

Create `tests/home-sort.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseHomeSort } from "@/components/BrowseFilters";

describe("home sort", () => {
  it("defaults to weekly and keeps the old popular URL compatible", () => {
    expect(parseHomeSort(undefined)).toBe("weekly");
    expect(parseHomeSort("popular")).toBe("weekly");
  });

  it("accepts only the four public sorts", () => {
    expect(parseHomeSort("trending")).toBe("trending");
    expect(parseHomeSort("recent")).toBe("recent");
    expect(parseHomeSort("all-time")).toBe("all-time");
    expect(parseHomeSort("unknown")).toBe("weekly");
  });
});
```

- [ ] **Step 2: Run the sort test and verify it fails**

Run: `npx vitest run tests/home-sort.test.ts`

Expected: FAIL because `parseHomeSort` is not exported.

- [ ] **Step 3: Extend filter parsing without breaking `?sort=popular`**

Use this public sort type in `BrowseFilters.tsx` and `app/page.tsx`:

```ts
export type HomeSort = "weekly" | "trending" | "recent" | "all-time";

export function parseHomeSort(value: string | undefined): HomeSort {
  if (value === "popular") return "weekly";
  if (value === "trending" || value === "recent" || value === "all-time") return value;
  return "weekly";
}
```

Render `이번 주`, `급상승`, `최신`, and `역대 인기` links. Omit the `sort` query only for the
weekly default. Preserve category/query parameters exactly as the current `hrefWith` helper does.

- [ ] **Step 4: Build the discovery board component**

`DiscoveryBoards` receives the return type of `getDiscoveryBoards()`. Render four responsive panels:

- weekly rank and valid clicks;
- qualified trend percentage;
- verified-new relative date;
- discovered-new relative date and unclaimed badge.

Each product name links to `/p/<slug>`; outbound click counts still happen only when the detail page
links through `/go/<slug>`. Do not make board cards link directly to external product URLs.

- [ ] **Step 5: Build the ranking table**

`RankingTable` receives `RankingListItem[]` and displays:

```text
# | 제품 | 이번 시즌 클릭 | <window> 변동률 | 순위 반영 | 상태
```

Use the stored `item.rank`, never `index + 1`. Format factor as
`${factorBasisPoints / 100}%`; render it in warning color below 100%; render `신규` when change is
null; render prior rank or `첫 시즌` in the status cell. On narrow screens keep identity, clicks,
and change visible and allow the remaining columns to scroll horizontally.

- [ ] **Step 6: Recompose the home Server Component**

Keep `export const dynamic = "force-dynamic"`. Load the active season first, then load boards,
`marketStats({ windowHours: active?.policy.trend.windowHours ?? 24 })`, verified-only category counts,
and the requested list in parallel. Use:

- `getSeasonRanking({ order: "rank" })` for weekly;
- `getSeasonRanking({ order: "trending" })` for trending;
- `getVerifiedList()` for recent;
- `getAllTimeRanking()` for all-time.

If no active season exists, log `home.ranking_unavailable`, switch the effective sort to recent,
and render the latest verified products. Do not show seeded products in the primary list. Continue
showing seeded products only in `새로 발견됨`.

Above the boards show season key, exact dates, remaining time computed from the server render, and
snapshot age. Link `현재 규칙 보기` to `/rankings/<season.key>`.

Update `MarketStats` to show the aggregate click percentage beside `유효 클릭 <window>h`; omit the
percentage when it is null.

- [ ] **Step 7: Run all tests, lint, and build**

Run:

```bash
npm test
npm run test:integration
npm run lint
npm run build
```

Expected: all tests PASS, lint exits 0, and the production build succeeds.

- [ ] **Step 8: Commit**

```bash
git add app/page.tsx components/DiscoveryBoards.tsx components/RankingTable.tsx components/BrowseFilters.tsx components/MarketStats.tsx tests/home-sort.test.ts
git commit -m "feat: show weekly discovery rankings"
```

### Task 9: Historical seasons and methodology

**Files:**

- Create: `components/SeasonPolicy.tsx`
- Create: `app/rankings/[key]/page.tsx`
- Modify: `lib/domain/ranking/view.ts`
- Modify: `app/layout.tsx:29-50`
- Modify: `tests/integration/ranking-view.test.ts`

- [ ] **Step 1: Add a failing historical lookup test**

Finalize a season in `ranking-view.test.ts`, then assert:

```ts
const history = await getSeasonByKey("2026-W34");
expect(history?.season).toMatchObject({ key: "2026-W34", state: "closed" });
expect(history?.items.map((item) => item.rank)).toEqual([1, 2]);
expect(history?.season.policy).toEqual(policyUsedWhenSeasonStarted);
```

Run the file and expect FAIL because `getSeasonByKey` does not exist.

- [ ] **Step 2: Add the read function and reusable policy component**

Export:

```ts
export async function getSeasonByKey(
  key: string,
): Promise<{ season: SeasonSummary; items: RankingListItem[] } | null>;
```

It must read the stored `policySnapshot`, not the current default or latest revision. Create
`SeasonPolicy.tsx` to show cadence, exact KST date range, effective launch window, click definition,
cooldown tiers, trend window/minimum, transition status, and `refreshedAt`.

- [ ] **Step 3: Implement the dynamic route using Next.js 16 async params**

Create `app/rankings/[key]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { getSeasonByKey } from "@/lib/domain/ranking/view";
import { RankingTable } from "@/components/RankingTable";
import { SeasonPolicy } from "@/components/SeasonPolicy";

export const dynamic = "force-dynamic";

export default async function RankingSeasonPage({ params }: PageProps<"/rankings/[key]">) {
  const { key } = await params;
  const result = await getSeasonByKey(key);
  if (!result) notFound();
  return (
    <main className="mx-auto max-w-[1280px] px-6 pb-20 pt-9">
      <h1 className="text-[26px] font-extrabold">{result.season.key} 랭킹</h1>
      <SeasonPolicy season={result.season} />
      <div className="mt-6"><RankingTable items={result.items} /></div>
    </main>
  );
}
```

Add an `역대 인기` link to `/?sort=all-time` in the existing `<nav>` in `app/layout.tsx`. The home
season heading separately links `지난 시즌` to the actual latest closed season returned by
`getSeasonHistory(1)`. Do not make the root layout query the database and do not extract a new
navigation component in this change.

- [ ] **Step 4: Run the test and build, then commit**

Run:

```bash
npx vitest run --config vitest.integration.config.ts tests/integration/ranking-view.test.ts
npm run build
```

Expected: PASS and build exit 0.

```bash
git add app/rankings components/SeasonPolicy.tsx lib/domain/ranking/view.ts app/page.tsx
git commit -m "feat: publish ranking history"
```

### Task 10: Scheduler, operational docs, and full verification

**Files:**

- Modify: `scripts/scheduler.sh:35-70`
- Modify: `README.md`
- Modify: `PENDING.md`
- Modify: `docs/CODEX_HANDOFF.md`

- [ ] **Step 1: Schedule ranking refresh after click rollup**

In `scripts/scheduler.sh`, use the existing hourly condition and run in this order:

```sh
if [ $((tick % 60)) -eq 30 ]; then
  run click-rollup
  run ranking-refresh
fi
```

Update the header comment to say ranking snapshots refresh hourly. Do not register production
external cron jobs; that remains blocked by the deployment-access item in `PENDING.md`.

- [ ] **Step 2: Update operational documentation**

In `README.md`, replace the rolling-seven-day ranking description with the season rules, valid-click
definition, next-season setting behavior, `ranking-refresh` job, and `/admin/ranking` location.

In `PENDING.md` B1, add:

```text
0 * * * *   click-rollup       KST 일별 클릭 집계
5 * * * *   ranking-refresh    시즌 경계·쿨다운·공개 순위 스냅샷
```

State that `ranking-refresh` should run after click rollup and remains unregistered in production.

- [ ] **Step 3: Run the complete verification matrix**

Run:

```bash
git diff --check
npm test
npm run test:integration
npm run lint
npm run build
```

Expected: no whitespace errors; every test passes; lint and build exit 0. Do not claim any command
passed unless its output was observed.

- [ ] **Step 4: Smoke-test the pages and scheduled job locally**

With the development DB migrated and `npm run dev` running, execute:

```bash
npm run job ranking-refresh
npx playwright screenshot --device="Desktop Chrome" --full-page http://127.0.0.1:3000/ /private/tmp/nomorevibe-ranking-home.png
```

Expected: the job reports `status: completed`; the home screenshot contains the season header, four
boards, valid clicks, change percentage or `신규`, and factor column. Log in as an administrator and
inspect `/admin/ranking` at desktop and mobile widths; save a draft and verify only the scheduled
policy changes while the active season key and policy remain unchanged.

- [ ] **Step 5: Update handoff and commit the release-ready implementation**

Update `docs/CODEX_HANDOFF.md` with the actual modified files, exact observed test output, failed
approaches, unresolved production scheduler dependency, and the next commands. Then commit:

```bash
git add scripts/scheduler.sh README.md PENDING.md docs/CODEX_HANDOFF.md
git commit -m "docs: operate seasonal rankings"
```

Finish with `git status --short`; expected output is empty.
