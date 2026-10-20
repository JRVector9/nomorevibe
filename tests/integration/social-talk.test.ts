import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, productHealth, productStarObservationRuns, productStarObservations, products, socialTalkDecisions } from "@/lib/db/schema";
import { homeTalkLineup, listTalk, productTalk } from "@/lib/social/talk";
import { recordSocialPosts } from "@/lib/social/repository";
import type { HnTalkPost } from "@/lib/social/hn-talk-source";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));

const NOW = new Date("2026-10-18T06:00:00Z");
let serial = 0;

async function product(repo: string, extra: Partial<typeof products.$inferInsert> = {}) {
  const slug = `talk-${++serial}`;
  const [row] = await db.insert(products).values({
    slug, name: repo.split("/")[1], url: `https://${slug}.example`, tagline: "A useful product", description: "d", category: "Dev",
    repoUrl: `https://github.com/${repo}`, stars: 1000, status: "seeded", source: "crawler", verifyToken: `v-${slug}`, editTokenHash: "a".repeat(64), ...extra,
  }).returning();
  return row;
}
const hn = (id: string, repo: string, points: number, comments: number, postedAt: string, extra: Partial<HnTalkPost> = {}): HnTalkPost => ({
  externalId: id, kind: "link", title: `Post ${id}`, linkUrl: `https://github.com/${repo}`, linkTarget: "repo",
  repositoryKey: repo.toLowerCase(), postedAt: new Date(postedAt), points, comments, frontPage: false, ...extra,
});
async function stars(productId: number, values: [string, number][]) {
  for (const [at, count] of values) {
    const cycle = new Date(at);
    const [run] = await db.insert(productStarObservationRuns).values({
      cycleAt: cycle, windowStartsAt: new Date(cycle.getTime() - 8 * 3_600_000), deadlineAt: cycle, status: "closed", policyVersion: "test", policy: {} as never,
    }).onConflictDoUpdate({ target: productStarObservationRuns.cycleAt, set: { status: "closed" } }).returning();
    await db.insert(productStarObservations).values({
      runId: run.id, productId, slug: `p${productId}`, repoUrl: "https://github.com/x/y", repositoryKey: "x/y", repositoryId: "R_1",
      repoLinkVersion: 1, status: "ok", stars: count, observedAt: cycle, archived: false,
    });
  }
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.execute(sql`TRUNCATE social_post_observations, social_posts, social_talk_decisions, product_star_observations, product_star_observation_runs RESTART IDENTITY CASCADE`);
  await db.delete(crawlCandidates);
  await resetTables();
});

it("공개 제품에 이어진 자격 글만 줄 세우고, 지금은 최근 글이, 이번 주는 큰 글이 앞선다", async () => {
  const doory = await product("shaongitbd/doory");
  const konnect = await product("mixelpixx/Konnect");
  const banned = await product("acme/banned", { status: "banned" });
  const down = await product("acme/down");
  await db.insert(productHealth).values({ slug: down.slug, status: 503, failures: 3 });
  await recordSocialPosts("hn", [
    hn("1", "shaongitbd/doory", 230, 80, "2026-10-12T00:48:00Z"),
    hn("2", "mixelpixx/konnect", 143, 52, "2026-10-14T10:51:00Z"),
    hn("3", "acme/banned", 300, 10, "2026-10-17T00:00:00Z"),
    hn("4", "acme/down", 300, 10, "2026-10-17T00:00:00Z"),
    // 자격 미달(30점·댓글 15 아래)
    hn("5", "acme/quiet", 12, 3, "2026-10-17T00:00:00Z"),
    // 이슈 글은 순위에 세지 않는다
    hn("6", "shaongitbd/doory", 500, 200, "2026-10-17T00:00:00Z", { linkTarget: "issue", linkUrl: "https://github.com/shaongitbd/doory/issues/1" }),
    // 아직 공개 제품이 아닌 화제 저장소 — 하나는 심사 중, 하나는 모름
    hn("7", "acme/reviewing", 90, 20, "2026-10-17T00:00:00Z"),
    hn("8", "acme/unknown", 90, 20, "2026-10-17T00:00:00Z"),
  ], new Date("2026-10-18T05:30:00Z"));
  await db.insert(crawlCandidates).values({ repo: "acme/Reviewing", state: "needs_review" });

  const now = await listTalk({ mode: "now", now: NOW });
  expect(now.entries.map(entry => [entry.rank, entry.product.slug])).toEqual([[1, konnect.slug], [2, doory.slug]]);
  expect(now.entries[1].posts.map(item => item.externalId)).toEqual(["1"]);
  expect(now.unlisted).toEqual({ active: 1, unknown: 1 });
  expect(now.checkedAt?.toISOString()).toBe("2026-10-18T05:30:00.000Z");
  expect((await listTalk({ mode: "week", now: NOW })).entries.map(entry => entry.product.slug)).toEqual([doory.slug, konnect.slug]);
  expect(banned.id).toBeGreaterThan(0);
});

it("7일이 지난 글은 목록에서 빠지고, 관리자가 뺀 저장소도 빠진다", async () => {
  const old = await product("acme/old");
  const fresh = await product("acme/fresh");
  await recordSocialPosts("hn", [hn("1", "acme/old", 300, 90, "2026-10-10T00:00:00Z"), hn("2", "acme/fresh", 60, 10, "2026-10-17T00:00:00Z")], NOW);
  expect((await listTalk({ mode: "week", now: NOW })).entries.map(entry => entry.product.id)).toEqual([fresh.id]);
  await db.insert(socialTalkDecisions).values({ repositoryKey: "acme/fresh", excluded: true, decidedBy: "admin" });
  expect((await listTalk({ mode: "week", now: NOW })).entries).toEqual([]);
  expect(old.id).toBeGreaterThan(0);
});

it("글 뒤 스타는 첫 글 직전 관측부터, 직전 관측이 없으면 첫 글 뒤 첫 관측부터 잰다", async () => {
  const konnect = await product("acme/konnect");
  const doory = await product("acme/doory");
  await stars(konnect.id, [["2026-10-14T08:00:00Z", 963], ["2026-10-16T08:00:00Z", 1000], ["2026-10-18T00:00:00Z", 1256]]);
  await stars(doory.id, [["2026-10-13T00:00:00Z", 771], ["2026-10-18T00:00:00Z", 1563]]);
  await recordSocialPosts("hn", [hn("1", "acme/konnect", 143, 52, "2026-10-14T10:51:00Z"), hn("2", "acme/doory", 230, 80, "2026-10-12T00:48:00Z")], NOW);
  const board = await listTalk({ mode: "week", now: NOW });
  const growth = Object.fromEntries(board.entries.map(entry => [entry.product.id, entry.starGrowth]));
  expect(growth[konnect.id]).toMatchObject({ delta: 293, basis: "mention", from: 963, to: 1256 });
  expect(growth[doory.id]).toMatchObject({ delta: 792, basis: "observation", from: 771, to: 1563 });
});

it("홈 1위는 관리자가 허용한 저장소만, /talk 에만 두기로 한 저장소는 홈에서 빠진다", async () => {
  await product("acme/a");
  await product("acme/b");
  await product("acme/c");
  await recordSocialPosts("hn", [
    hn("1", "acme/a", 300, 50, "2026-10-17T20:00:00Z"), hn("2", "acme/b", 200, 50, "2026-10-17T20:00:00Z"), hn("3", "acme/c", 100, 50, "2026-10-17T20:00:00Z"),
  ], NOW);
  await db.insert(socialTalkDecisions).values([
    { repositoryKey: "acme/a", homeDecision: "talk_only", decidedBy: "admin" },
    { repositoryKey: "acme/c", homeDecision: "approved", decidedBy: "admin" },
  ]);
  const board = await listTalk({ mode: "now", now: NOW });
  const lineup = homeTalkLineup(board.entries);
  expect(lineup.lead?.repositoryKey).toBe("acme/c");
  expect(lineup.rest.map(entry => entry.repositoryKey)).toEqual(["acme/b"]);
  // c 보다 순위가 높은데 아직 정하지 않은 저장소는 확인 대기
  expect(lineup.waiting.map(entry => entry.repositoryKey)).toEqual(["acme/b"]);
});

it("상세 화제 기록은 90일 안의 글을 이슈 글까지 보여 주고, 지금 순위를 붙인다", async () => {
  const doory = await product("shaongitbd/doory");
  await recordSocialPosts("hn", [
    hn("1", "shaongitbd/doory", 230, 80, "2026-10-12T00:48:00Z"),
    hn("2", "shaongitbd/doory", 40, 20, "2026-10-17T00:00:00Z", { linkTarget: "issue", linkUrl: "https://github.com/shaongitbd/doory/issues/2" }),
    hn("3", "shaongitbd/doory", 50, 10, "2026-06-01T00:00:00Z"),
  ], NOW);
  const talk = await productTalk(doory.id, "https://github.com/ShaonGitBD/Doory.git", NOW);
  expect(talk?.posts.map(item => item.externalId)).toEqual(["1", "2"]);
  expect(talk).toMatchObject({ qualifies: true, rank: 1, sources: ["hn"] });
  expect(await productTalk(doory.id, "https://doory.art", NOW)).toBeNull();
  expect(await productTalk(doory.id, "https://github.com/acme/silent", NOW)).toBeNull();
});

it("X 게시물은 마지막으로 확인한 뒤 24시간만 목록·상세·대기 수에 든다", async () => {
  const tool = await product("acme/tool");
  const x = (id: string, repo: string) => ({ ...hn(id, repo, 80, 4, "2026-10-17T00:00:00Z"), title: "" });
  await recordSocialPosts("x", [x("1980000000000000001", "acme/tool"), x("1980000000000000002", "acme/waiting")], new Date("2026-10-17T07:00:00Z"));
  const board = await listTalk({ mode: "now", now: NOW });
  expect(board.entries.map(entry => [entry.product.slug, entry.posts.map(item => item.source)])).toEqual([[tool.slug, ["x"]]]);
  expect(board.unlisted).toEqual({ active: 0, unknown: 1 });
  expect((await productTalk(tool.id, "https://github.com/acme/tool", NOW))?.sources).toEqual(["x"]);

  const later = new Date("2026-10-18T07:00:01Z");
  expect((await listTalk({ mode: "now", now: later })).entries).toEqual([]);
  expect((await listTalk({ mode: "now", now: later })).unlisted).toEqual({ active: 0, unknown: 0 });
  expect(await productTalk(tool.id, "https://github.com/acme/tool", later)).toBeNull();
  // 다시 확인되면 돌아온다
  await recordSocialPosts("x", [x("1980000000000000001", "acme/tool")], new Date("2026-10-18T07:00:00Z"));
  expect((await listTalk({ mode: "now", now: later })).entries.map(entry => entry.product.slug)).toEqual([tool.slug]);
});
