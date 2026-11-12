import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { aiConnections, aiTaskExecutionConfigs, aiTaskModels, aiTaskPoolMembers, crawlCandidates, operationsAudit, products } from "@/lib/db/schema";
import { adminGlobalSearch } from "@/lib/operations/admin-search";
import { ensureSchema, resetTables } from "./setup";

/** 관리자 전역 검색(⌘K, ADM-05) — 실제 쿼리. 작업 로그는 지울 수 없어(0056) 실행마다 고유한 말로 찾는다 */
const TAG = `zq${Date.now().toString(36)}`;
const TASK = `gsearch-${TAG}`;

async function cleanConnections() {
  await db.delete(aiTaskModels).where(eq(aiTaskModels.task, TASK));
  await db.delete(aiTaskExecutionConfigs).where(eq(aiTaskExecutionConfigs.task, TASK));
  await db.delete(aiConnections).where(like(aiConnections.label, `${TAG}%`));
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(crawlCandidates).where(like(crawlCandidates.repo, "gsearch/%"));
  await cleanConnections();
});
afterAll(cleanConnections);

async function product(slug: string, values: Partial<typeof products.$inferInsert> = {}) {
  await db.insert(products).values({ slug, name: slug, url: `https://${slug}.example`, tagline: "t", description: "d", category: "Dev",
    status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e", ...values });
}

describe("adminGlobalSearch", () => {
  it("제품은 이름·slug·주소·저장소로, 꼭 맞는 이름 먼저 그다음 스타 순으로 찾는다", async () => {
    await product(`${TAG}-big`, { name: `${TAG} Big`, stars: 900 });
    await product(`${TAG}`, { name: TAG, stars: 1 });
    await product("by-repo", { repoUrl: `https://github.com/acme/${TAG}-repo`, stars: 5 });
    await product("unrelated");
    const result = await adminGlobalSearch(TAG.toUpperCase());
    expect(result.products.map((p) => p.slug)).toEqual([TAG, `${TAG}-big`, "by-repo"]);
    expect(result.products[0]).toMatchObject({ href: `/admin/products/${TAG}`, publicHref: `/p/${TAG}`, logHref: `/admin/activity?target=${TAG}` });
  });

  it("후보는 저장소·배포 주소로 찾고, 꼭 맞는 저장소 이름 먼저", async () => {
    await db.insert(crawlCandidates).values([
      { repo: `gsearch/${TAG}-tools`, state: "needs_review" },
      { repo: `gsearch/${TAG}`, state: "rejected" },
      { repo: "gsearch/other", state: "new", productUrl: `https://${TAG}.example` },
    ]);
    const result = await adminGlobalSearch(TAG);
    const repos = result.candidates.map((c) => c.repo);
    expect(repos[0]).toBe(`gsearch/${TAG}`);
    expect(repos.slice(1).sort()).toEqual([`gsearch/${TAG}-tools`, "gsearch/other"].sort());
    const rejected = result.candidates.find((c) => c.repo === `gsearch/${TAG}`)!;
    expect(rejected.href).toBe(`/admin/review?state=rejected&q=gsearch%2F${TAG}&focus=${rejected.id}#review-list`);
  });

  it("작업 로그는 대상마다 한 줄 — 건수와 마지막 시각", async () => {
    await db.insert(operationsAudit).values([
      { actor: "jr", action: "product-ban", target: `${TAG}-slug`, detail: {} },
      { actor: "jr", action: "product-unban", target: `${TAG}-slug`, detail: {} },
      { actor: "jr", action: "export", target: `export:${TAG}`, detail: {} },
    ]);
    const result = await adminGlobalSearch(TAG);
    const slugRow = result.targets.find((t) => t.target === `${TAG}-slug`);
    expect(slugRow).toMatchObject({ count: 2, href: `/admin/activity?target=${TAG}-slug` });
    expect(slugRow!.lastAt).toBeInstanceOf(Date);
    expect(result.targets).toHaveLength(2);
  });

  it("% _ 는 글자 그대로, 한 글자는 찾지 않는다", async () => {
    await product("percent-a", { name: "100% real" });
    await product("percent-b", { name: "1000 real" });
    expect((await adminGlobalSearch("0%")).products.map((p) => p.slug)).toEqual(["percent-a"]);
    expect(await adminGlobalSearch("x")).toEqual({ q: "x", products: [], candidates: [], targets: [], engines: [], models: [], destinations: [], commands: [] });
  });

  it("서버·수동 모델·CLI·순위·분산 모델을 찾고 숨긴 모델과 비밀 값은 노출하지 않는다", async () => {
    const api = randomUUID(), cli = randomUUID();
    const options = { contextTokens: 32768, manualModels: [`${TAG}-manual`], hiddenModels: [`${TAG}-hidden`], privateValue: `${TAG}-private-value` };
    await db.insert(aiConnections).values([
      { id: api, label: `${TAG} API`, kind: "api", baseUrl: `https://${TAG}.example/v1`, deviceId: "m1max", updatedBy: "test",
        apiKeyCiphertext: `${TAG}-key-only`, options, models: [{ id: `${TAG}-shared`, maxModelLen: 32768 }, { id: `${TAG}-hidden`, maxModelLen: null }] },
      { id: cli, label: `${TAG} CLI`, kind: "cli", cliTool: "claude", cliModels: [`${TAG}-shared`], deviceId: "cli-device", updatedBy: "test", enabled: false },
    ]);
    await db.insert(aiTaskModels).values({ task: TASK, slot: 1, rank: 1, connectionId: api, model: `${TAG}-shared`, updatedBy: "test" });
    await db.insert(aiTaskExecutionConfigs).values({ task: TASK, slot: 1, mode: "workload_pool", updatedBy: "test" });
    await db.insert(aiTaskPoolMembers).values({ memberId: randomUUID(), task: TASK, slot: 1, position: 1,
      connectionId: api, model: `${TAG}-pool`, canonicalModel: `${TAG}-pool`, deviceId: "m1max", engineKey: "a".repeat(64) });

    const result = await adminGlobalSearch(TAG.toUpperCase());
    expect(result.engines.map(row => row.id).sort()).toEqual([api, cli].sort());
    expect(result.models.map(row => `${row.connectionId}:${row.model}`).sort()).toEqual([
      `${api}:${TAG}-shared`, `${api}:${TAG}-manual`, `${api}:${TAG}-pool`, `${cli}:${TAG}-shared`,
    ].sort());
    expect(result.engines.find(row => row.id === api)).toMatchObject({ contextTokens: 32768, contextHref: `/admin/models/llm?edit=${api}&fix=context#conn-${api}-context` });
    expect(result.models.find(row => row.connectionId === cli)).toMatchObject({ enabled: false, href: `/admin/models/llm?edit=${cli}#conn-${cli}` });
    expect(JSON.stringify(result)).not.toContain(`${TAG}-key-only`);
    expect(JSON.stringify(result)).not.toContain(`${TAG}-private-value`);
    expect((await adminGlobalSearch(`${TAG}-hidden`)).models).toEqual([]);
    expect((await adminGlobalSearch(`${TAG}-key-only`)).engines).toEqual([]);
    expect((await adminGlobalSearch(`${TAG}-pool`)).engines.map(row => row.id)).toEqual([api]);
    expect((await adminGlobalSearch("컨텍스트 상한")).engines.find(row => row.id === api)?.href)
      .toBe(`/admin/models/llm?edit=${api}&fix=context#conn-${api}-context`);
  });

  it("카테고리 검색은 해당 엔진·모델을 찾고 이름의 %와 _도 글자로 취급한다", async () => {
    const percent = randomUUID(), other = randomUUID();
    await db.insert(aiConnections).values([
      { id: percent, label: `${TAG} 100%`, kind: "api", baseUrl: `https://${TAG}-a.example/v1`, deviceId: "m3", updatedBy: "test",
        models: [{ id: `${TAG}-a_b`, maxModelLen: null }] },
      { id: other, label: `${TAG} 1000`, kind: "api", baseUrl: `https://${TAG}-b.example/v1`, deviceId: "m3", updatedBy: "test",
        models: [{ id: `${TAG}-axb`, maxModelLen: null }] },
    ]);
    expect((await adminGlobalSearch("0%")).engines.map(row => row.id)).toEqual([percent]);
    expect((await adminGlobalSearch(`${TAG}-a_b`)).models.map(row => row.connectionId)).toEqual([percent]);
    expect((await adminGlobalSearch("엔진")).engines.map(row => row.id)).toEqual(expect.arrayContaining([percent, other]));
    expect((await adminGlobalSearch("모델")).models.map(row => row.connectionId)).toEqual(expect.arrayContaining([percent, other]));
  });
});
