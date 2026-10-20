import { beforeAll, beforeEach, expect, it } from "vitest";
import { sql } from "drizzle-orm";

const { db } = await import("@/lib/db");
const { socialPosts, socialPostObservations } = await import("@/lib/db/schema");
const { recordSocialPosts, postsMissingSince, markSocialPostsGone, deleteExpiredSocialPosts } = await import("@/lib/social/repository");
const { ensureSchema } = await import("./setup");

type Post = import("@/lib/social/hn-talk-source").HnTalkPost;

const at = (iso: string) => new Date(iso);
const post = (id: string, extra: Partial<Post> = {}): Post => ({
  externalId: id, kind: "link", title: `Post ${id}`, linkUrl: `https://github.com/acme/p${id}`, linkTarget: "repo",
  repositoryKey: `acme/p${id}`, postedAt: at("2026-10-18T00:00:00Z"), points: 12, comments: 3, frontPage: false, ...extra,
});
const rows = () => db.select().from(socialPosts).orderBy(socialPosts.externalId);
const observations = () => db.select().from(socialPostObservations).orderBy(socialPostObservations.postId, socialPostObservations.observedAt);

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.execute(sql`TRUNCATE social_post_observations, social_posts RESTART IDENTITY CASCADE`);
});

it("처음 본 글은 넣고 관측을 한 줄 남긴다", async () => {
  const first = await recordSocialPosts("hn", [post("1"), post("2", { kind: "show", frontPage: true })], at("2026-10-18T01:00:00Z"));
  expect(first).toEqual({ inserted: 2, updated: 0, observed: 2 });
  expect((await rows()).map(row => [row.externalId, row.kind, row.frontPage, row.state, row.repositoryKey])).toEqual([
    ["1", "link", false, "visible", "acme/p1"], ["2", "show", true, "visible", "acme/p2"],
  ]);
  expect(await observations()).toHaveLength(2);
});

it("값이 같으면 관측을 더하지 않고, 바뀌거나 6시간이 지나면 더한다", async () => {
  await recordSocialPosts("hn", [post("1")], at("2026-10-18T01:00:00Z"));
  expect(await recordSocialPosts("hn", [post("1")], at("2026-10-18T01:30:00Z"))).toEqual({ inserted: 0, updated: 1, observed: 0 });
  expect(await recordSocialPosts("hn", [post("1", { points: 40, comments: 9 })], at("2026-10-18T02:00:00Z")))
    .toEqual({ inserted: 0, updated: 1, observed: 1 });
  expect(await recordSocialPosts("hn", [post("1", { points: 40, comments: 9 })], at("2026-10-18T08:00:00Z")))
    .toEqual({ inserted: 0, updated: 1, observed: 1 });
  const [row] = await rows();
  expect([row.points, row.comments, row.firstSeenAt.toISOString(), row.lastSeenAt.toISOString()])
    .toEqual([40, 9, "2026-10-18T01:00:00.000Z", "2026-10-18T08:00:00.000Z"]);
  expect((await observations()).map(o => [o.points, o.observedAt.toISOString()])).toEqual([
    [12, "2026-10-18T01:00:00.000Z"], [40, "2026-10-18T02:00:00.000Z"], [40, "2026-10-18T08:00:00.000Z"],
  ]);
});

it("한 번 첫 화면에 오른 글은 표시가 남는다", async () => {
  await recordSocialPosts("hn", [post("1", { frontPage: true })], at("2026-10-18T01:00:00Z"));
  await recordSocialPosts("hn", [post("1", { frontPage: false })], at("2026-10-18T02:00:00Z"));
  expect((await rows())[0].frontPage).toBe(true);
});

it("창 안에서 이번에 돌아오지 않은 글을 찾고, 내리면 다시 보일 때 되살린다", async () => {
  await recordSocialPosts("hn", [post("1"), post("2")], at("2026-10-18T01:00:00Z"));
  await recordSocialPosts("hn", [post("2")], at("2026-10-18T02:00:00Z"));
  const missing = await postsMissingSince("hn", at("2026-10-17T00:00:00Z"), at("2026-10-18T02:00:00Z"));
  expect(missing.map(row => row.externalId)).toEqual(["1"]);
  // 창 밖(게시가 since 보다 이른) 글은 대상이 아니다
  expect(await postsMissingSince("hn", at("2026-10-18T00:00:01Z"), at("2026-10-18T02:00:00Z"))).toEqual([]);

  expect(await markSocialPostsGone(missing.map(row => row.id), at("2026-10-18T02:00:00Z"))).toBe(1);
  expect((await rows()).map(row => [row.externalId, row.state, row.stateReason])).toEqual([["1", "gone", "source_missing"], ["2", "visible", null]]);
  // 내린 글은 다시 묻는 대상에서 빠진다
  expect(await postsMissingSince("hn", at("2026-10-17T00:00:00Z"), at("2026-10-18T03:00:00Z"))).toEqual([expect.objectContaining({ externalId: "2" })]);

  await recordSocialPosts("hn", [post("1")], at("2026-10-18T03:00:00Z"));
  expect((await rows())[0]).toMatchObject({ state: "visible", stateReason: null });
});

it("관리자가 숨긴 글은 다시 보여도 숨긴 채로 두고, 지워진 글로 덮지 않는다", async () => {
  await recordSocialPosts("hn", [post("1")], at("2026-10-18T01:00:00Z"));
  await db.update(socialPosts).set({ state: "hidden", stateReason: "admin", stateChangedAt: at("2026-10-18T01:10:00Z") });
  await recordSocialPosts("hn", [post("1", { points: 99 })], at("2026-10-18T02:00:00Z"));
  const [id] = (await rows()).map(row => row.id);
  expect(await markSocialPostsGone([id], at("2026-10-18T03:00:00Z"))).toBe(0);
  expect((await rows())[0]).toMatchObject({ state: "hidden", stateReason: "admin", points: 99 });
});

it("보관 기간이 지난 글은 관측과 함께 지운다", async () => {
  await recordSocialPosts("hn", [post("1", { postedAt: at("2026-07-01T00:00:00Z") }), post("2")], at("2026-10-18T01:00:00Z"));
  expect(await deleteExpiredSocialPosts(at("2026-07-20T00:00:00Z"))).toBe(1);
  expect((await rows()).map(row => row.externalId)).toEqual(["2"]);
  expect(await observations()).toHaveLength(1);
});

it("저장소 열쇠는 소문자 owner/repo 만, 제품 사이트 글은 열쇠 없이만 받는다", async () => {
  await expect(recordSocialPosts("hn", [post("1", { repositoryKey: "Acme/App" })], at("2026-10-18T01:00:00Z"))).rejects.toThrow();
  await expect(recordSocialPosts("hn", [post("2", { linkTarget: "site" })], at("2026-10-18T01:00:00Z"))).rejects.toThrow();
});
