import { beforeAll, beforeEach, expect, it } from "vitest";
import { clearAllMemos } from "@/lib/cache/memo";
import { db } from "@/lib/db";
import {
  agentRepositoryObservations,
  agentRepositoryScans,
  crawlCandidates,
  crawlDocuments,
  productHealth,
  products,
  rankingEntries,
  rankingPolicyRevisions,
  rankingSeasons,
  takedownRequests,
} from "@/lib/db/schema";
import type { AgentObservation } from "@/lib/domain/evidence/agents/types";
import { CATEGORIES } from "@/lib/domain/products/categories";
import { DOWN_THRESHOLD } from "@/lib/domain/products/health";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import { seasonKeysWithEntries } from "@/lib/domain/ranking/season-entries";
import { ensureSchema, resetTables } from "./setup";

const { default: sitemap } = await import("@/app/sitemap");

/**
 * sitemap(UX-08·UX-09, 운영자 결정 D1·D2) — 상세는 색인해도 되는 제품만(indexing.ts), 분야 목록은 가리는 분야를 뺀 전부,
 * 랭킹은 순위에 오른 제품이 있는 시즌만. 주소 수는 파일 하나의 한도(5만) 아래.
 */
beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(takedownRequests);
  clearAllMemos();
});

let serial = 0;
async function product(slug: string, values: Partial<typeof products.$inferInsert> = {}) {
  await db.insert(products).values({
    slug, name: slug, url: `https://${slug}.example`, tagline: "Useful project", description: "Project tools", category: "Dev",
    repoUrl: `https://github.com/acme/${slug}`, status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e",
    createdAt: new Date(Date.UTC(2026, 8, 1) + ++serial * 60_000), ...values,
  });
  if ((values.source ?? "crawler") === "crawler") {
    await db.insert(crawlCandidates).values({ repo: `Acme/${slug}`, state: "published", publishedSlug: slug });
  }
}

/** 저장소 루트 조사 하나에 이름 있는 AI 도구 흔적 — 주인 없는 제품이 색인되는 근거(indexing.ts 4번) */
async function aiEvidence(slug: string) {
  const [scan] = await db.insert(agentRepositoryScans).values({
    githubRepositoryId: BigInt(1), repositoryKey: `acme/${slug}`, commitSha: "c".repeat(40), detectorVersion: "v",
    scopeHash: slug, state: "complete", completedAt: new Date("2026-09-02"),
  }).returning();
  await db.insert(agentRepositoryObservations).values({
    scanId: scan.id, observationKey: "k", facts: { kind: "instruction_file", client: "claude-code" } as AgentObservation,
  });
}

async function seasons() {
  const [revision] = await db.insert(rankingPolicyRevisions).values({
    values: DEFAULT_RANKING_POLICY, state: "applied", createdBy: "test", createdAt: new Date("2026-09-01"), appliedAt: new Date("2026-09-01"),
  }).returning();
  const season = (key: string, startsAt: string, state: "active" | "closed") => ({
    key, cadence: "weekly" as const, startsAt: new Date(startsAt), endsAt: new Date(new Date(startsAt).getTime() + 7 * 86_400_000),
    state, policyRevisionId: revision.id, policySnapshot: DEFAULT_RANKING_POLICY, effectiveLaunchWindowDays: 28, isTransition: false,
    refreshedAt: new Date(startsAt), closedAt: state === "closed" ? new Date(new Date(startsAt).getTime() + 7 * 86_400_000) : null,
  });
  const rows = await db.insert(rankingSeasons).values([
    season("2026-W38", "2026-09-13T15:00:00Z", "closed"),
    season("2026-W39", "2026-09-20T15:00:00Z", "closed"),
    season("2026-W40", "2026-09-27T15:00:00Z", "closed"),
    season("2026-W41", "2026-10-04T15:00:00Z", "active"),
  ]).returning();
  const id = (key: string) => rows.find((row) => row.key === key)!.id;
  const entry = (key: string, slug: string, rank: number) => ({
    seasonId: id(key), slug, validClicks: 10, cooldownFactorBasisPoints: 10_000, scoreUnits: 100_000, rank,
    recentClicks: 1, previousClicks: 1, changePercent: 0,
  });
  await db.insert(rankingEntries).values([
    // W38: 검증 제품이 순위에 있다 → 싣는다
    entry("2026-W38", "owned", 1),
    // W39: 우리가 찾아 올린(검증 아님) 제품뿐 → 순위 화면이 비므로 뺀다
    entry("2026-W39", "seeded-evidence", 1),
    // W40: 검증 제품이지만 지금 응답이 없다 → 순위 화면이 가리므로 뺀다
    entry("2026-W40", "owned-down", 1),
    // W41(진행 중): 순위 있음
    entry("2026-W41", "owned", 1),
  ]);
}

it("색인할 제품·분야 목록·순위가 있는 시즌만 싣는다", async () => {
  await product("owned", { status: "verified", source: "skill" });
  await product("owned-down", { status: "verified", source: "skill" });
  await db.insert(productHealth).values({ slug: "owned-down", status: 0, failures: DOWN_THRESHOLD, downSince: new Date("2026-09-30") });
  await product("seeded-evidence"); await aiEvidence("seeded-evidence");
  await product("seeded-no-evidence");
  await product("seeded-profile", { category: "Profile" }); await aiEvidence("seeded-profile");
  await product("takedown-pending"); await aiEvidence("takedown-pending");
  await db.insert(takedownRequests).values({ slug: "takedown-pending" });
  await product("banned", { status: "banned", source: "skill" });
  await seasons();

  const entries = await sitemap();
  const paths = entries.map((entry) => new URL(entry.url).pathname);

  // 고정 화면
  for (const path of ["/", "/popular", "/launch", "/policy"]) expect(paths).toContain(path);
  // 상세 — 주인 있는 공개 제품(응답 없음은 색인을 끄지 않는다)과 AI 근거가 확인된 주인 없는 제품만
  expect(paths.filter((path) => path.startsWith("/p/")).sort()).toEqual(["/p/owned", "/p/owned-down", "/p/seeded-evidence"]);
  expect(entries.find((entry) => entry.url.endsWith("/p/owned"))?.lastModified).toBeInstanceOf(Date);
  // 분야 — 소문자 주소, 개인 프로필은 뺀다
  const categoryPaths = paths.filter((path) => path.startsWith("/c/"));
  expect(categoryPaths).toHaveLength(CATEGORIES.length - 1);
  expect(categoryPaths).toContain("/c/dev");
  expect(categoryPaths).toContain("/c/finance");
  expect(categoryPaths).not.toContain("/c/profile");
  // 랭킹 — 순위 화면에 줄이 있는 시즌만
  expect(paths.filter((path) => path.startsWith("/rankings/")).sort()).toEqual(["/rankings/2026-W38", "/rankings/2026-W41"]);
  // 한 파일의 한도
  expect(new Set(paths).size).toBe(paths.length);
  expect(paths.length).toBeLessThanOrEqual(50_000);
});

it("색인할 제품 목록은 담아 두었다가 쓴다 — 새 제품은 담은 값이 지난 뒤에 실린다", async () => {
  await product("first", { status: "verified", source: "skill" });
  expect((await sitemap()).some((entry) => entry.url.endsWith("/p/first"))).toBe(true);

  await product("second", { status: "verified", source: "skill" });
  expect((await sitemap()).some((entry) => entry.url.endsWith("/p/second"))).toBe(false);

  clearAllMemos();
  expect((await sitemap()).some((entry) => entry.url.endsWith("/p/second"))).toBe(true);
});

it("시즌 열쇠 중 순위 화면에 줄이 있는 것만 돌려준다", async () => {
  await product("owned", { status: "verified", source: "skill" });
  await product("owned-down", { status: "verified", source: "skill" });
  await db.insert(productHealth).values({ slug: "owned-down", status: 0, failures: DOWN_THRESHOLD, downSince: new Date("2026-09-30") });
  await product("seeded-evidence");
  await seasons();

  expect((await seasonKeysWithEntries(["2026-W38", "2026-W39", "2026-W40", "2026-W41", "2026-W99"])).sort()).toEqual(["2026-W38", "2026-W41"]);
  expect(await seasonKeysWithEntries([])).toEqual([]);
});
