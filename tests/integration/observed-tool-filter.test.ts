import { beforeAll, beforeEach, expect, it } from "vitest";
import { db } from "@/lib/db";
import { agentRepositoryObservations, agentRepositoryScans, crawlCandidates, crawlDocuments, productClickDaily, productHealth, products, rankingEntries, rankingPolicyRevisions, rankingSeasons } from "@/lib/db/schema";
import type { AgentObservation } from "@/lib/domain/evidence/agents/types";
import { countProducts, listProducts } from "@/lib/domain/products/repository";
import { getAllTimeRanking, getSeasonRanking } from "@/lib/domain/ranking/view";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import { ensureSchema, resetTables } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
});

async function product(slug: string, values: Partial<typeof products.$inferInsert> = {}) {
  await db.insert(products).values({ slug, name: slug, url: `https://${slug}.example`, tagline: "Useful project", description: "Project tools", category: "Dev", status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e", createdAt: new Date("2026-09-01"), ...values });
  await db.insert(crawlCandidates).values({ repo: `Acme/${slug}`, state: "published", publishedSlug: slug });
}

async function scan(slug: string, clients: string[], values: Partial<typeof agentRepositoryScans.$inferInsert> = {}) {
  const [row] = await db.insert(agentRepositoryScans).values({ githubRepositoryId: BigInt(1), repositoryKey: `acme/${slug}`, commitSha: "c".repeat(40), detectorVersion: "v", scopeHash: `${slug}-${Math.random()}`, state: "complete", completedAt: new Date("2026-09-02"), ...values }).returning();
  for (const [index, client] of clients.entries()) {
    await db.insert(agentRepositoryObservations).values({ scanId: row.id, observationKey: `k${index}`, facts: { kind: "instruction_file", client } as AgentObservation });
  }
}

const options = { statuses: ["seeded", "verified"] as ("seeded" | "verified")[], observedTool: "Claude Code", excludeDown: true };
const slugs = async (extra = {}) => (await listProducts({ ...options, limit: 20, ...extra })).map(row => row.slug);

it("신고값이 아니라 마지막 완료·부분 루트 조사의 흔적만 쓰며 중복·비공개·접속 실패는 제외한다", async () => {
  for (const slug of ["matched", "changed", "failed", "scoped", "builder-only", "banned", "down"]) await product(slug, slug === "builder-only" ? { builder: "Claude Code", source: "skill" } : slug === "banned" ? { status: "banned" } : {});
  await scan("matched", ["claude-code", "claude-code"]);
  await scan("changed", ["claude-code"]);
  await scan("changed", ["codex"], { state: "partial", completedAt: new Date("2026-09-03") });
  await scan("failed", ["claude-code"]);
  await scan("failed", ["codex"], { state: "failed", completedAt: new Date("2026-09-03") });
  await scan("scoped", ["codex"]);
  await scan("scoped", ["claude-code"], { scope: "subdir", completedAt: new Date("2026-09-03") });
  await scan("banned", ["claude-code"]);
  await scan("down", ["claude-code"]);
  await db.insert(productHealth).values({ slug: "down", status: 503, failures: 3 });
  expect(await slugs()).toEqual(["failed", "matched"]);
  expect(await countProducts(options)).toBe(2);
  expect(await slugs({ observedTool: "Codex" })).toEqual(["changed", "scoped"]);
});

it("같은 표시 이름의 도구 키 별칭도 함께 거르고 알 수 없는 값은 다른 도구를 보여주지 않는다", async () => {
  await product("old-roo"); await product("new-roo"); await product("other");
  await scan("old-roo", ["roo"]); await scan("new-roo", ["roo-code"]); await scan("other", ["codex"]);
  expect(await slugs({ observedTool: "Roo Code" })).toEqual(["new-roo", "old-roo"]);
  expect(await slugs({ observedTool: "not-a-tool" })).toEqual([]);
});

it("검색·분야·신고값과 겹쳐 걸어도 목록·개수·페이지가 같은 조건을 쓴다", async () => {
  for (const slug of ["match-a", "match-b", "match-c"]) {
    await product(slug, { source: "skill", builder: "Codex" }); await scan(slug, ["claude-code"]);
  }
  await product("design", { category: "Design", source: "skill", builder: "Codex" }); await scan("design", ["claude-code"]);
  await product("other-builder", { source: "skill", builder: "Cursor" }); await scan("other-builder", ["claude-code"]);
  const filter = { ...options, category: "Dev" as const, query: "match", builder: "Codex" };
  expect((await listProducts({ ...filter, limit: 2 })).map(row => row.slug)).toEqual(["match-a", "match-b"]);
  expect((await listProducts({ ...filter, limit: 2, offset: 2 })).map(row => row.slug)).toEqual(["match-c"]);
  expect(await countProducts(filter)).toBe(3);
});

it("시즌·누적 순위도 도구로 거르며 원래 전체 순위 번호는 보존한다", async () => {
  await product("rank-one", { status: "verified", source: "skill" });
  await product("rank-two", { status: "verified", source: "skill" });
  await scan("rank-one", ["codex"]); await scan("rank-two", ["claude-code"]);
  const [revision] = await db.insert(rankingPolicyRevisions).values({ values: DEFAULT_RANKING_POLICY, state: "applied", createdBy: "test" }).returning();
  const [season] = await db.insert(rankingSeasons).values({ key: "observed-tools", cadence: "weekly", startsAt: new Date("2026-09-01"), endsAt: new Date("2027-01-01"), state: "active", policyRevisionId: revision.id, policySnapshot: DEFAULT_RANKING_POLICY, effectiveLaunchWindowDays: 28 }).returning();
  await db.insert(rankingEntries).values([{ seasonId: season.id, slug: "rank-one", rank: 1 }, { seasonId: season.id, slug: "rank-two", rank: 2 }]);
  const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  await db.insert(productClickDaily).values([{ slug: "rank-one", day, clicks: 10 }, { slug: "rank-two", day, clicks: 5 }]);
  expect((await getSeasonRanking({ seasonKey: season.key, observedTool: "Claude Code", limit: 10 })).items.map(row => [row.slug, row.rank])).toEqual([["rank-two", 2]]);
  expect((await getAllTimeRanking({ observedTool: "Claude Code", limit: 10 })).map(row => [row.slug, row.rank])).toEqual([["rank-two", 2]]);
});
