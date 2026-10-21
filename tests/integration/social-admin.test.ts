import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, socialPosts, socialTalkDecisions } from "@/lib/db/schema";
import { listTalkPostsPage, setSocialPostsState, setTalkExcluded, setTalkHomeDecision, talkAdminFilter, type TalkAdminFilter } from "@/lib/social/admin";
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

const ALL: TalkAdminFilter = { source: "all", state: "all", link: "all", talk: "all", sort: "recent" };
const site = (id: string, url: string, points: number, extra: Partial<HnTalkPost> = {}): HnTalkPost =>
  hn(id, "unused/unused", points, { linkUrl: url, linkTarget: "site", repositoryKey: null, ...extra });

it("관리자 목록은 모든 상태의 글을 점수순으로, 연결 제품과 저장소 제외 여부를 함께 보여 준다", async () => {
  await product("acme/app");
  await product("acme/gone", "banned");
  await recordSocialPosts("hn", [hn("1", "acme/app", 90), hn("2", "acme/gone", 200), hn("3", "acme/none", 50)], NOW);
  await db.update(socialPosts).set({ state: "gone" }).where(sql`external_id = '3'`);
  await setTalkExcluded("acme/gone", true, "admin", "스팸 캠페인");
  const { rows } = await listTalkPostsPage({ ...ALL, sort: "points" }, { now: NOW, page: 1 });
  expect(rows.map(row => [row.externalId, row.state, row.excluded, row.product?.slug ?? null, row.product?.status ?? null])).toEqual([
    ["2", "visible", true, "acme-gone", "banned"], ["1", "visible", false, "acme-app", "seeded"], ["3", "gone", false, null, null],
  ]);
});

it("보관 중인 글은 HN·X, 저장소 없는 글, 7일 지난 글까지 모두 보이고 글마다 /talk 판정이 붙는다", async () => {
  await product("acme/app");
  await product("acme/banned", "banned");
  await recordSocialPosts("hn", [
    hn("1", "acme/app", 90),
    hn("2", "acme/app", 5, { comments: 0, postedAt: new Date("2026-10-17T10:00:00Z") }),
    hn("3", "acme/banned", 200),
    hn("4", "acme/none", 12, { comments: 3, postedAt: new Date("2026-10-17T11:00:00Z") }),
    // 7일이 지났지만 보관(90일) 안
    hn("5", "acme/app", 300, { postedAt: new Date("2026-09-01T00:00:00Z") }),
    site("6", "https://acme.github.io/app/", 70, { postedAt: new Date("2026-10-17T13:00:00Z") }),
  ], NOW);
  // X 보고는 저장소 없는 글(제품 사이트)도 넣을 수 있다
  await recordSocialPosts("x", [
    site("1900000000000000001", "https://acme.example", 120, { title: "", postedAt: new Date("2026-10-16T20:00:00Z") }),
    hn("1900000000000000002", "acme/app", 80, { postedAt: new Date("2026-10-16T21:00:00Z") }),
  ], new Date("2026-10-17T05:00:00Z"));
  await setSocialPostsState((await db.select({ id: socialPosts.id }).from(socialPosts).where(sql`external_id = '4'`)).map(row => row.id), "hidden", NOW);

  const page = await listTalkPostsPage(ALL, { now: NOW, page: 1 });
  expect(page.total).toBe(8);
  expect(page.rows.map(row => [row.source, row.externalId, row.talk.shown, row.talk.rank, row.talk.reasons.map(reason => reason.code)])).toEqual([
    ["hn", "6", false, null, ["no_repo"]],
    ["hn", "3", false, null, ["not_public"]],
    ["hn", "1", true, 1, []],
    ["hn", "4", false, null, ["hidden", "no_product", "below"]],
    ["hn", "2", true, 1, ["carried"]],
    ["x", "1900000000000000002", false, null, ["x_stale"]],
    ["x", "1900000000000000001", false, null, ["no_repo", "x_stale"]],
    ["hn", "5", false, null, ["old"]],
  ]);
  expect(page.rows.find(row => row.externalId === "3")?.talk.reasons[0].label).toBe("공개 제품 아님 — banned");
  expect(page.rows.find(row => row.externalId === "6")).toMatchObject({ linkUrl: "https://acme.github.io/app/", repositoryKey: null, product: null });
  expect(page.summary).toMatchObject({
    total: 8, source: { hn: 6, x: 2, geeknews: 0 }, state: { visible: 7, hidden: 1, gone: 0 },
    link: { product: 5, none: 1, site: 2 }, talk: { on: 2, off: 6 },
  });
  expect(page.summary.lastSeenAt.x?.toISOString()).toBe("2026-10-17T05:00:00.000Z");

  // 공개 화면은 그대로 — 저장소 없는 글과 X 확인 24시간 지난 글은 오르지 않는다
  const board = await listTalk({ mode: "now", now: NOW });
  expect(board.entries.map(entry => [entry.repositoryKey, entry.posts.map(item => item.externalId)])).toEqual([["acme/app", ["1", "2"]]]);
});

it("출처·상태·제품 연결·/talk 로 거르고, 한 쪽씩 넘긴다", async () => {
  await product("acme/app");
  await recordSocialPosts("hn", [
    hn("1", "acme/app", 90), hn("2", "acme/none", 40), site("3", "https://gist.github.com/acme/1", 20),
    ...Array.from({ length: 5 }, (_, index) => hn(String(10 + index), "acme/none", 10 + index, { postedAt: new Date(`2026-10-0${index + 1}T00:00:00Z`) })),
  ], NOW);
  await recordSocialPosts("x", [site("1900000000000000001", "https://acme.example", 60)], NOW);
  const ids = async (filter: Partial<TalkAdminFilter>, page = 1, pageSize = 50) =>
    (await listTalkPostsPage({ ...ALL, ...filter }, { now: NOW, page, pageSize })).rows.map(row => row.externalId);

  expect(await ids({ source: "x" })).toEqual(["1900000000000000001"]);
  expect(await ids({ link: "product" })).toEqual(["1"]);
  expect(await ids({ link: "site", sort: "points" })).toEqual(["1900000000000000001", "3"]);
  expect((await ids({ link: "none" })).sort()).toEqual(["10", "11", "12", "13", "14", "2"]);
  expect(await ids({ talk: "on" })).toEqual(["1"]);
  expect(await ids({ talk: "off", source: "hn", link: "site" })).toEqual(["3"]);
  expect(await ids({ state: "gone" })).toEqual([]);

  // 최근 게시 순
  const first = await listTalkPostsPage({ ...ALL, link: "none" }, { now: NOW, page: 1, pageSize: 4 });
  expect(first.total).toBe(6);
  expect(first.rows.map(row => row.externalId)).toEqual(["2", "14", "13", "12"]);
  expect(await ids({ link: "none" }, 2, 4)).toEqual(["11", "10"]);
});

it("거르기 값은 모르는 것을 전체로 읽는다", () => {
  expect(talkAdminFilter({ source: "x", state: "hidden", link: "site", talk: "off", sort: "points" }))
    .toEqual({ source: "x", state: "hidden", link: "site", talk: "off", sort: "points" });
  expect(talkAdminFilter({ source: "reddit", state: ["gone"], link: "", talk: "yes", sort: undefined })).toEqual(ALL);
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
