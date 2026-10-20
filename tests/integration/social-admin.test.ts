import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, socialPosts, socialTalkDecisions } from "@/lib/db/schema";
import { listTalkPostsForAdmin, setSocialPostsState, setTalkExcluded, setTalkHomeDecision } from "@/lib/social/admin";
import { recordSocialPosts } from "@/lib/social/repository";
import { listTalk } from "@/lib/social/talk";
import type { HnTalkPost } from "@/lib/social/hn-talk-source";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));

const NOW = new Date("2026-10-18T06:00:00Z");
const hn = (id: string, repo: string, points: number, extra: Partial<HnTalkPost> = {}): HnTalkPost => ({
  externalId: id, kind: "link", title: `Post ${id}`, linkUrl: `https://github.com/${repo}`, linkTarget: "repo",
  repositoryKey: repo, postedAt: new Date("2026-10-17T12:00:00Z"), points, comments: 20, frontPage: false, ...extra,
});
async function product(repo: string, status: "seeded" | "banned" = "seeded") {
  const slug = repo.replace("/", "-");
  await db.insert(products).values({ slug, name: slug, url: `https://${slug}.example`, tagline: "t", description: "d", category: "Dev",
    repoUrl: `https://github.com/${repo}`, status, source: "crawler", verifyToken: `v-${slug}`, editTokenHash: "a".repeat(64) });
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.execute(sql`TRUNCATE social_post_observations, social_posts, social_talk_decisions RESTART IDENTITY CASCADE`);
  await resetTables();
});

it("관리자 목록은 모든 상태의 글을 점수순으로, 연결 제품과 저장소 제외 여부를 함께 보여 준다", async () => {
  await product("acme/app");
  await product("acme/gone", "banned");
  await recordSocialPosts("hn", [hn("1", "acme/app", 90), hn("2", "acme/gone", 200), hn("3", "acme/none", 50)], NOW);
  await db.update(socialPosts).set({ state: "gone" }).where(sql`external_id = '3'`);
  await setTalkExcluded("acme/gone", true, "admin", "스팸 캠페인");
  const rows = await listTalkPostsForAdmin(new Date("2026-10-11T00:00:00Z"));
  expect(rows.map(row => [row.externalId, row.state, row.excluded, row.product?.slug ?? null, row.product?.status ?? null])).toEqual([
    ["2", "visible", true, "acme-gone", "banned"], ["1", "visible", false, "acme-app", "seeded"], ["3", "gone", false, null, null],
  ]);
});

it("숨긴 글은 화면에서 빠지고 다시 보이면 돌아온다. 원문이 지워진 글은 바꾸지 않는다", async () => {
  await product("acme/app");
  await recordSocialPosts("hn", [hn("1", "acme/app", 90), hn("2", "acme/app", 40, { postedAt: new Date("2026-10-17T00:00:00Z") })], NOW);
  const ids = (await db.select({ id: socialPosts.id }).from(socialPosts).orderBy(socialPosts.id)).map(row => row.id);
  expect(await setSocialPostsState(ids, "hidden", NOW)).toBe(2);
  expect((await listTalk({ mode: "now", now: NOW })).entries).toEqual([]);
  expect(await setSocialPostsState([ids[0]], "visible", NOW)).toBe(1);
  const [entry] = (await listTalk({ mode: "now", now: NOW })).entries;
  expect(entry.posts.map(item => item.externalId)).toEqual(["1"]);
  await db.update(socialPosts).set({ state: "gone" }).where(sql`id = ${ids[1]}`);
  expect(await setSocialPostsState([ids[1]], "visible", NOW)).toBe(0);
});

it("저장소 빼기와 홈 결정은 한 줄에 함께 남고 서로 지우지 않는다", async () => {
  await setTalkHomeDecision("acme/app", "approved", "admin");
  await setTalkExcluded("acme/app", true, "admin", null);
  await setTalkExcluded("acme/app", false, "admin2", null);
  expect(await db.select({ excluded: socialTalkDecisions.excluded, home: socialTalkDecisions.homeDecision, by: socialTalkDecisions.decidedBy }).from(socialTalkDecisions))
    .toEqual([{ excluded: false, home: "approved", by: "admin2" }]);
  await setTalkHomeDecision("acme/app", null, "admin");
  expect((await db.select().from(socialTalkDecisions))[0].homeDecision).toBeNull();
  await expect(setTalkExcluded("Acme/App", true, "admin", null)).rejects.toThrow("invalid_repository_key");
});
