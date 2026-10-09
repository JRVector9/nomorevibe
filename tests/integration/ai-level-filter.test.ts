import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import { db } from "@/lib/db";
import { productClickDaily, productHealth, products, rankingEntries, rankingPolicyRevisions, rankingSeasons, repositoryAiLevels } from "@/lib/db/schema";
import { AI_FILTER_LEVELS } from "@/lib/domain/evidence/ai-level-labels";
import { getProductDetail } from "@/lib/domain/products/detail-view";
import { EMBEDDING_MODEL, vectorLiteral } from "@/lib/domain/products/embedding";
import { rankRelevance, relevanceWindow } from "@/lib/domain/products/relevance";
import { aiLevelCounts, countProducts, listProducts } from "@/lib/domain/products/repository";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import { getAllTimeRanking, getSeasonRanking } from "@/lib/domain/ranking/view";
import { ensureSchema, resetTables } from "./setup";

/** 홈 '만든 방식' 필터(products.ai_level, 0063)와 상세의 단계 줄(repository_ai_levels) */

async function product(slug: string, values: Partial<typeof products.$inferInsert> = {}) {
  await db.insert(products).values({
    slug, name: slug, url: `https://${slug}.example`, tagline: "Budget tracker", description: "Budget tracker app",
    category: "Dev", status: "seeded", source: "crawler", verifyToken: `v-${slug}`, editTokenHash: "e",
    createdAt: new Date("2026-09-01"), ...values,
  });
}

const PUBLIC = { statuses: ["verified", "seeded"] as ("verified" | "seeded")[], excludeDown: true };
const MADE = AI_FILTER_LEVELS.made;
const slugs = async (extra: Partial<Parameters<typeof listProducts>[0]> = {}) =>
  (await listProducts({ ...PUBLIC, limit: 50, ...extra })).map((row) => row.slug).sort();

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(repositoryAiLevels);
});

async function seedCatalogue() {
  await product("agent-pr", { aiLevel: 1 });
  await product("signed-commit", { aiLevel: 2 });
  await product("config-file", { aiLevel: 3 });
  await product("finance-made", { aiLevel: 2, category: "Finance" });
  await product("plain");
  // 공개 목록 바깥 — 차단·닿지 않음·주인 없는 개인 프로필은 칩에도 목록에도 세지 않는다
  await product("banned-made", { aiLevel: 1, status: "banned" });
  await product("down-made", { aiLevel: 2 });
  await db.insert(productHealth).values({ slug: "down-made", status: 503, failures: 3 });
  await product("profile-made", { aiLevel: 2, category: "Profile" });
}

describe("만든 방식 목록·개수", () => {
  it("AI로 제작은 1·2·3단계 모두 — 목록과 개수가 같은 조건", async () => {
    await seedCatalogue();
    expect(await slugs({ aiLevels: MADE })).toEqual(["agent-pr", "config-file", "finance-made", "signed-commit"]);
    expect(await countProducts({ ...PUBLIC, aiLevels: MADE })).toBe(4);
    expect(await slugs({ aiLevels: [3] })).toEqual(["config-file"]);
    // 분야·검색과 겹쳐 건다
    expect(await slugs({ aiLevels: MADE, category: "Finance" })).toEqual(["finance-made"]);
    expect(await countProducts({ ...PUBLIC, aiLevels: MADE, category: "Dev", query: ["budget"] })).toBe(3);
    // 걸지 않으면 그대로, 빈 단계 목록은 아무것도 걸리지 않는다
    expect(await slugs()).toEqual(["agent-pr", "config-file", "finance-made", "plain", "signed-commit"]);
    expect(await countProducts({ ...PUBLIC, aiLevels: [] })).toBe(0);
  });

  it("칩의 수는 분야·단계마다 공개 목록과 같은 바탕에서 센다", async () => {
    await seedCatalogue();
    const rows = await aiLevelCounts();
    expect(rows.sort((a, b) => a.category.localeCompare(b.category) || a.level - b.level)).toEqual([
      { category: "Dev", level: 1, count: 1 },
      { category: "Dev", level: 2, count: 1 },
      { category: "Dev", level: 3, count: 1 },
      { category: "Finance", level: 2, count: 1 },
    ]);
  });

  it("관련도순 검색의 낱말 검색·의미 검색·꼬리도 같은 단계로 거른다", async () => {
    await seedCatalogue();
    // 단계 없는 제품이 뜻으로는 질의와 똑같다 — 의미 검색도 걸러야 빠진다
    const query = Array.from({ length: 1024 }, (_, k) => (k === 0 ? 1 : 0));
    const [plain] = await db.select({ id: products.id }).from(products).where(eq(products.slug, "plain"));
    await db.execute(sql`insert into product_embeddings (product_id, model, text_hash, embedding)
      values (${plain.id}, ${EMBEDDING_MODEL}, 'h', ${vectorLiteral(query)}::halfvec)`);
    const servers = { embed: vi.fn(async () => query), rerank: vi.fn(async (_q: string, docs: string[]) => docs.map((_, i) => -i)) };
    expect((await rankRelevance("budget", ["budget"], {}, servers)).head).toContain("plain");
    const ranked = await rankRelevance("budget", ["budget"], { aiLevels: MADE }, servers);
    expect([...ranked.head].sort()).toEqual(["agent-pr", "config-file", "finance-made", "signed-commit"]);
    expect(ranked.total).toBe(4);
    const tail = await relevanceWindow({ ...ranked, head: [] }, ["budget"], { aiLevels: [3] }, 0, 10);
    expect(tail).toEqual(["config-file"]);
  });

  it("시즌·누적 순위도 단계로 거르며 원래 순위 번호는 보존한다", async () => {
    // 1위는 단계가 없다 — 걸면 빠지고 2위는 번호를 그대로 둔다
    await product("rank-one", { status: "verified", source: "skill" });
    await product("rank-two", { status: "verified", source: "skill", aiLevel: 2 });
    const [revision] = await db.insert(rankingPolicyRevisions).values({ values: DEFAULT_RANKING_POLICY, state: "applied", createdBy: "test" }).returning();
    const [season] = await db.insert(rankingSeasons).values({ key: "ai-levels", cadence: "weekly", startsAt: new Date("2026-09-01"), endsAt: new Date("2027-01-01"), state: "active", policyRevisionId: revision.id, policySnapshot: DEFAULT_RANKING_POLICY, effectiveLaunchWindowDays: 28 }).returning();
    await db.insert(rankingEntries).values([{ seasonId: season.id, slug: "rank-one", rank: 1 }, { seasonId: season.id, slug: "rank-two", rank: 2 }]);
    const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    await db.insert(productClickDaily).values([{ slug: "rank-one", day, clicks: 10 }, { slug: "rank-two", day, clicks: 5 }]);
    expect((await getSeasonRanking({ seasonKey: season.key, aiLevels: MADE, limit: 10 })).items.map((row) => [row.slug, row.rank])).toEqual([["rank-two", 2]]);
    expect((await getAllTimeRanking({ aiLevels: MADE, limit: 10 })).map((row) => [row.slug, row.rank])).toEqual([["rank-two", 2]]);
  });
});

describe("상세의 AI 제작 근거 단계", () => {
  const checked = { rulesVersion: "test", checkedAt: new Date("2026-10-09"), nextCheckAt: new Date("2026-10-16") };

  it("검사 전·근거 없음·단계를 저장소 주소로 읽고 근거와 도구 이름은 싣지 않는다", async () => {
    await product("pending", { repoUrl: "https://github.com/acme/pending" });
    await product("none", { repoUrl: "https://github.com/acme/none" });
    await product("level-two", { repoUrl: "https://github.com/Acme/Level-Two.git" });
    await product("gitlab", { repoUrl: "https://gitlab.com/acme/level-two" });
    await db.insert(repositoryAiLevels).values([
      { repositoryKey: "acme/none", level: null, ...checked },
      { repositoryKey: "acme/level-two", level: 2, clients: ["claude-code"], evidence: { commits: [{ sha: "a".repeat(40), client: "claude-code", basis: "coauthor" }] }, ...checked },
    ]);
    expect((await getProductDetail("pending"))?.aiLevel).toEqual({ checked: false, level: null });
    expect((await getProductDetail("none"))?.aiLevel).toEqual({ checked: true, level: null });
    expect((await getProductDetail("level-two"))?.aiLevel).toEqual({ checked: true, level: 2 });
    expect((await getProductDetail("gitlab"))?.aiLevel).toEqual({ checked: false, level: null });
    // 상세 캐시(공유 저장소)에 근거·도구 이름이 실리지 않는다
    expect(JSON.stringify(await getProductDetail("level-two"))).not.toContain("claude-code");
  });
});
