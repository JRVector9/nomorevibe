import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));

const { db } = await import("@/lib/db");
const { productHealth, products } = await import("@/lib/db/schema");
const { categoryCounts, publicListingCounts } = await import("@/lib/domain/products/repository");
const { DOWN_THRESHOLD } = await import("@/lib/domain/products/health");
const { clearAllMemos } = await import("@/lib/cache/memo");

/**
 * 어드민의 공개 상태·목록 노출(publicListingCounts) — 목록 노출은 공개 사이트 「공개 N개」(categoryCounts excludeDown 의 합)와 같은 수다.
 * 빠진 것은 주인 없는 개인 프로필 → 응답 없음 → 감사 보류 → 저장소 사라짐(설치형) 차례의 앞 사유 하나로만 센다.
 */
const daysAgo = (days: number) => sql`now() - ${`${days} days`}::interval` as unknown as Date;

async function product(slug: string, values: Partial<typeof products.$inferInsert> = {}) {
  await db.insert(products).values({
    slug, url: `https://${slug}.example`, repoUrl: `https://github.com/acme/${slug}`, repoStatus: "ok", name: slug,
    tagline: "invoice tracker", description: "invoice tracker", category: "Productivity", status: "seeded", source: "crawler",
    verifyToken: `v-${slug}`, editTokenHash: "e", ...values,
  });
}
const gone = { repoStatus: "not_found", repoMissingSince: daysAgo(3), repoCheckedAt: daysAgo(1) } as const;

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  clearAllMemos();
  await product("plain-tool");
  await product("verified-dev", { category: "Dev", status: "verified", source: "skill", verifiedAt: new Date() });
  // 주인 없는 개인 프로필은 빠지고, 클레임했거나 메이커가 올린 프로필은 실린다
  await product("hidden-profile", { category: "Profile" });
  await product("claimed-profile", { category: "Profile", claimedAt: new Date() });
  await product("registered-profile", { category: "Profile", source: "skill", status: "verified", verifiedAt: new Date() });
  // 응답 없음 — 연속 실패가 문턱에 닿은 것만. 문턱 아래는 실린다
  await product("down-tool");
  await product("flaky-tool");
  // 감사 보류
  await product("held-tool", { auditHoldAt: new Date() });
  // 저장소 사라짐 — 설치형만 빠진다. 웹사이트는 실린다
  await product("gone-installable", { accessMode: "installable", ...gone });
  await product("gone-website", { ...gone });
  // 겹침 — 주인 없는 프로필이면서 응답 없음은 앞 사유(개인 프로필)로만, 응답 없음이면서 감사 보류는 응답 없음으로만
  await product("hidden-profile-down", { category: "Profile" });
  await product("down-held", { category: "Dev", auditHoldAt: new Date() });
  // 공개 상태가 아닌 것은 어느 수에도 들지 않는다
  await product("waiting", { status: "unverified" });
  await product("banned-tool", { status: "banned" });
  await db.insert(productHealth).values([
    { slug: "down-tool", status: 503, failures: DOWN_THRESHOLD, downSince: daysAgo(1) },
    { slug: "flaky-tool", status: 503, failures: DOWN_THRESHOLD - 1 },
    { slug: "hidden-profile-down", status: 503, failures: DOWN_THRESHOLD, downSince: daysAgo(1) },
    { slug: "down-held", status: 503, failures: DOWN_THRESHOLD + 2, downSince: daysAgo(2) },
  ]);
});

const sum = (counts: Record<string, number>) => Object.values(counts).reduce((total, value) => total + value, 0);

describe("publicListingCounts", () => {
  it("목록 노출은 공개 사이트 「공개 N개」(categoryCounts excludeDown 의 합)와 같고, 공개 상태는 상태만 센 수와 같다", async () => {
    const listing = await publicListingCounts();
    const publicTotal = sum(await categoryCounts({ statuses: ["verified", "seeded"], excludeDown: true }));
    expect(listing.listed).toBe(publicTotal);
    expect(listing.listed).toBe(6); // plain·verified-dev·claimed·registered·flaky·gone-website
    expect(listing.publicStatus).toBe(sum(await categoryCounts({ statuses: ["verified", "seeded"] })));
    expect(listing.publicStatus).toBe(12);
  });

  it("빠진 것을 차례의 앞 사유 하나로 세어 공개 상태 = 목록 노출 + 사유 합", async () => {
    const listing = await publicListingCounts();
    expect(listing.excluded).toEqual({ profileUnclaimed: 2, down: 2, auditHeld: 1, repoGone: 1 });
    const excluded = Object.values(listing.excluded).reduce((total, value) => total + value, 0);
    expect(listing.publicStatus).toBe(listing.listed + excluded);
  });

  it("분야마다 공개 상태·목록 노출을 같은 쿼리에서 — 분야 칩의 수와 같다", async () => {
    const listing = await publicListingCounts();
    const listedByCategory = await categoryCounts({ statuses: ["verified", "seeded"], excludeDown: true });
    const statusByCategory = await categoryCounts({ statuses: ["verified", "seeded"] });
    expect(listing.byCategory).toEqual(Object.fromEntries(Object.keys(statusByCategory).map((category) =>
      [category, { publicStatus: statusByCategory[category], listed: listedByCategory[category] ?? 0 }])));
    expect(listing.byCategory.Profile).toEqual({ publicStatus: 4, listed: 2 });
  });

  it("공개 제품이 없으면 모두 0", async () => {
    await resetTables();
    expect(await publicListingCounts()).toEqual({ publicStatus: 0, listed: 0,
      excluded: { profileUnclaimed: 0, down: 0, auditHeld: 0, repoGone: 0 }, byCategory: {} });
  });
});
