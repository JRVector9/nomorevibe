import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, socialPosts } from "@/lib/db/schema";
import { listTalkPostsPage, setSocialPostsState, talkAdminFilter, type TalkAdminFilter } from "@/lib/social/admin";
import type { BlueskyTalkPost } from "@/lib/social/bluesky-talk-source";
import {
  blueskyPostsToRecheck, heavyBlueskyAccounts, holdBotPosts, markBlueskyPostsGone, purgeGoneBlueskyPosts, recordBlueskyPosts,
} from "@/lib/social/bluesky-talk-store";
import { listTalk, productTalk } from "@/lib/social/talk";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));

const NOW = new Date("2026-10-21T23:30:00Z");
const HOUR = 3_600_000;
const BOT = "did:plc:hzebgrkbc42iyxsrmwsdjnej";
const HUMAN = "did:plc:ltjj43huonogytm4szn5hzkx";
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);
const repoLink = (repo: string) => ({ repositoryKey: repo, linkUrl: `https://github.com/${repo}`, linkTarget: "repo" as const });
const bsky = (rkey: string, repo: string | null, points: number, extra: Partial<BlueskyTalkPost> = {}): BlueskyTalkPost => ({
  externalId: `${extra.did ?? HUMAN}/${rkey}`, kind: "link", title: "",
  linkUrl: repo ? `https://github.com/${repo}` : "https://acme.github.io/", linkTarget: repo ? "repo" : "site", repositoryKey: repo,
  postedAt: ago(10), points, comments: 1, frontPage: false, did: HUMAN, labelHold: null,
  candidates: repo ? [{ repositoryKey: repo, linkUrl: `https://github.com/${repo}`, linkTarget: "repo" }] : [], ...extra,
});
async function product(repo: string) {
  const slug = repo.replace("/", "-");
  await db.insert(products).values({ slug, name: slug, url: `https://${slug}.example`, tagline: "t", description: "d", category: "Dev",
    repoUrl: `https://github.com/${repo}`, status: "seeded", source: "crawler", verifyToken: `v-${slug}`, editTokenHash: "a".repeat(64) });
}
const states = async () => Object.fromEntries((await db.select({ id: socialPosts.externalId, state: socialPosts.state, reason: socialPosts.stateReason })
  .from(socialPosts).where(sql`source = 'bluesky'`)).map(row => [row.id.split("/")[1], `${row.state}:${row.reason ?? ""}`]));
const idOf = async (rkey: string) => (await db.select({ id: socialPosts.id }).from(socialPosts).where(sql`external_id like ${"%/" + rkey}`))[0].id;

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.execute(sql`TRUNCATE social_post_observations, social_posts, social_talk_decisions RESTART IDENTITY CASCADE`);
  await resetTables();
});

it("출처 제약은 bluesky 를 받고, 모르는 출처는 그대로 막는다(0115)", async () => {
  expect(await recordBlueskyPosts([bsky("3mygaaaaaaaa1", "acme/app", 3)], NOW)).toMatchObject({ inserted: 1, held: 0, released: 0 });
  await expect(db.execute(sql`INSERT INTO social_posts (source, external_id, kind, title, link_url, link_target, posted_at)
    VALUES ('mastodon', '1', 'link', '', 'https://github.com/acme/app', 'site', now())`)).rejects.toThrow();
  // 본문·작성자 칸은 없다 — 글 ID(주소)·주소·점수·시각만
  const [row] = await db.select().from(socialPosts);
  expect(row).toMatchObject({ source: "bluesky", externalId: `${HUMAN}/3mygaaaaaaaa1`, title: "", points: 3, comments: 1 });
});

it("관측은 값이 바뀔 때만 남긴다 — 같은 값을 6시간마다 다시 쌓지 않는다", async () => {
  await recordBlueskyPosts([bsky("3mygaaaaaaaa1", "acme/app", 3)], ago(20));
  await recordBlueskyPosts([bsky("3mygaaaaaaaa1", "acme/app", 3)], ago(10));
  await recordBlueskyPosts([bsky("3mygaaaaaaaa1", "acme/app", 7)], NOW);
  const rows = await db.execute<{ points: number }>(sql`SELECT points FROM social_post_observations ORDER BY observed_at`);
  expect(rows.map(row => row.points)).toEqual([3, 7]);
  expect((await db.select({ lastSeenAt: socialPosts.lastSeenAt }).from(socialPosts))[0].lastSeenAt).toEqual(NOW);
});

it("라벨 숨김은 회차마다 다시 정하고, 관리자가 숨긴 글은 건드리지 않는다", async () => {
  await recordBlueskyPosts([
    bsky("3mygaaaaaaaa1", "acme/a", 9, { labelHold: "label:porn" }), bsky("3mygaaaaaaaa2", "acme/b", 9), bsky("3mygaaaaaaaa3", "acme/c", 9),
  ], ago(1));
  await setSocialPostsState([await idOf("3mygaaaaaaaa3")], "hidden", ago(0.5));
  expect(await states()).toEqual({ "3mygaaaaaaaa1": "hidden:label:porn", "3mygaaaaaaaa2": "visible:", "3mygaaaaaaaa3": "hidden:admin" });

  const second = await recordBlueskyPosts([
    bsky("3mygaaaaaaaa1", "acme/a", 9), bsky("3mygaaaaaaaa2", "acme/b", 9, { labelHold: "label:!no-unauthenticated" }),
    bsky("3mygaaaaaaaa3", "acme/c", 9, { labelHold: "label:spam" }),
  ], NOW);
  expect(second).toMatchObject({ held: 1, released: 1 });
  expect(await states()).toEqual({ "3mygaaaaaaaa1": "visible:", "3mygaaaaaaaa2": "hidden:label:!no-unauthenticated", "3mygaaaaaaaa3": "hidden:admin" });
});

it("봇 숨김은 창 안의 그 계정 글을 숨기고, 관리자가 다시 보이게 한 글은 다시 숨기지 않으며, 라벨이 풀리면 봇으로 돌아간다", async () => {
  const botPosts = Array.from({ length: 15 }, (_, i) => bsky(`3mygb${String(i).padStart(8, "0")}`, `acme/r${i}`, 6, { did: BOT, externalId: `${BOT}/3mygb${String(i).padStart(8, "0")}` }));
  await recordBlueskyPosts([...botPosts, bsky("3mygaaaaaaaa1", "acme/app", 9), bsky("3mygaaaaaaaa2", "acme/app", 9)], ago(1));
  const since = ago(72);
  const heavy = await heavyBlueskyAccounts(since, 15);
  expect(heavy).toEqual([BOT]);
  expect(await holdBotPosts(heavy, since, ago(1))).toBe(15);
  expect(Object.values(await states()).filter(value => value === "hidden:bot_suspected")).toHaveLength(15);

  // 관리자가 하나를 다시 보이게 했다 — 다음 회차에 다시 숨기지 않는다
  await setSocialPostsState([await idOf("3mygb00000000")], "visible", ago(0.5));
  expect(await holdBotPosts(heavy, since, NOW)).toBe(0);
  expect((await states())["3mygb00000000"]).toBe("visible:");

  // 봇 글에 라벨이 붙으면 라벨이 까닭이 되고, 떼어지면 같은 회차에 다시 봇 숨김
  await recordBlueskyPosts([{ ...botPosts[1], labelHold: "label:porn" }], ago(0.4));
  expect((await states())["3mygb00000001"]).toBe("hidden:label:porn");
  await recordBlueskyPosts([botPosts[1]], NOW);
  expect((await states())["3mygb00000001"]).toBe("visible:");
  expect(await holdBotPosts(heavy, since, NOW)).toBe(1);
  expect((await states())["3mygb00000001"]).toBe("hidden:bot_suspected");
});

it("다시 물을 글은 제품에 이어진 보이는 글(7일)이 먼저, 그다음 창 안의 오래 확인 못 한 글 — 관리자가 숨긴 글·이번에 본 글은 빼고", async () => {
  await product("acme/app");
  await recordBlueskyPosts([bsky("3mygaaaaaaaa1", "acme/app", 9, { postedAt: ago(5 * 24) })], ago(20));
  await recordBlueskyPosts([bsky("3mygaaaaaaaa2", null, 9, { postedAt: ago(24) })], ago(30));
  await recordBlueskyPosts([bsky("3mygaaaaaaaa3", "acme/app", 9, { postedAt: ago(24), labelHold: "label:porn" })], ago(40));
  await recordBlueskyPosts([bsky("3mygaaaaaaaa4", "acme/x", 9, { postedAt: ago(24) })], ago(50));
  await recordBlueskyPosts([bsky("3mygaaaaaaaa5", "acme/y", 9, { postedAt: ago(24) })], NOW);
  // 창(72시간) 밖이고 제품에도 이어지지 않은 글
  await recordBlueskyPosts([bsky("3mygaaaaaaaa6", "acme/z", 9, { postedAt: ago(4 * 24) })], ago(60));
  await setSocialPostsState([await idOf("3mygaaaaaaaa4")], "hidden", ago(1));

  const rows = await blueskyPostsToRecheck(ago(72), ago(7 * 24), NOW, 10);
  expect(rows.map(row => row.external_id.split("/")[1])).toEqual(["3mygaaaaaaaa1", "3mygaaaaaaaa3", "3mygaaaaaaaa2"]);
  expect(await blueskyPostsToRecheck(ago(72), ago(7 * 24), NOW, 1)).toHaveLength(1);
});

it("다시 물어 없던 글은 내리고(수집기가 숨긴 글도), 다시 보이면 되살려 라벨을 다시 걸며, 내린 지 7일이 지나면 행째 지운다", async () => {
  await recordBlueskyPosts([
    bsky("3mygaaaaaaaa1", "acme/a", 9), bsky("3mygaaaaaaaa2", "acme/b", 9, { labelHold: "label:porn" }), bsky("3mygaaaaaaaa3", "acme/c", 9),
  ], ago(48));
  await setSocialPostsState([await idOf("3mygaaaaaaaa3")], "hidden", ago(47));
  const ids = await Promise.all(["3mygaaaaaaaa1", "3mygaaaaaaaa2", "3mygaaaaaaaa3"].map(idOf));
  expect(await markBlueskyPostsGone(ids, ago(24 * 8))).toBe(2);
  expect(await states()).toEqual({ "3mygaaaaaaaa1": "gone:source_missing", "3mygaaaaaaaa2": "gone:source_missing", "3mygaaaaaaaa3": "hidden:admin" });

  await recordBlueskyPosts([bsky("3mygaaaaaaaa2", "acme/b", 9, { labelHold: "label:porn" })], NOW);
  expect((await states())["3mygaaaaaaaa2"]).toBe("hidden:label:porn");
  expect(await purgeGoneBlueskyPosts(ago(7 * 24))).toBe(1);
  expect(Object.keys(await states()).sort()).toEqual(["3mygaaaaaaaa2", "3mygaaaaaaaa3"]);
});

it("/talk 에는 공개 제품에 이어진 보이는 Bluesky 글만 반응 5부터·확인 24시간 안에서 오르고, 관리자 목록은 막힌 까닭을 단다", async () => {
  for (const repo of ["acme/app", "acme/low", "acme/bot", "acme/stale"]) await product(repo);
  await recordBlueskyPosts([
    bsky("3mygaaaaaaaa1", "acme/app", 12),
    bsky("3mygaaaaaaaa2", "acme/low", 4),
    bsky("3mygaaaaaaaa3", "acme/bot", 50, { did: BOT, externalId: `${BOT}/3mygaaaaaaaa3` }),
    bsky("3mygaaaaaaaa4", null, 40, { linkUrl: "https://github.com/acme/one", linkTarget: "site", candidates: [repoLink("acme/one"), repoLink("acme/two")] }),
    // 여러 저장소 중 공개 제품(acme/app)이 있으면 그 저장소에 붙는다(X 보고와 같은 규칙)
    bsky("3mygaaaaaaaa6", null, 8, { linkUrl: "https://github.com/acme/none", linkTarget: "site", candidates: [repoLink("acme/none"), repoLink("acme/app")] }),
  ], ago(1));
  await recordBlueskyPosts([bsky("3mygaaaaaaaa5", "acme/stale", 30, { postedAt: ago(40) })], ago(30));
  await holdBotPosts([BOT], ago(72), ago(1));

  const board = await listTalk({ mode: "now", now: NOW });
  expect(board.entries.map(entry => [entry.repositoryKey, entry.sources, entry.posts.map(post => post.externalId)])).toEqual([
    ["acme/app", ["bluesky"], [`${HUMAN}/3mygaaaaaaaa1`, `${HUMAN}/3mygaaaaaaaa6`]],
  ]);
  expect((await productTalk(board.entries[0].product.id, "https://github.com/acme/app", NOW))?.posts.map(post => post.source)).toEqual(["bluesky", "bluesky"]);

  // ?source=bluesky 를 거르기로 읽는다(모르는 출처는 전체)
  expect(talkAdminFilter({ source: "bluesky" }).source).toBe("bluesky");
  expect(talkAdminFilter({ source: "mastodon" }).source).toBe("all");
  const filter: TalkAdminFilter = { ...talkAdminFilter({ source: "bluesky" }), sort: "points" };
  const page = await listTalkPostsPage(filter, { now: NOW, page: 1 });
  expect(page.summary.source.bluesky).toBe(6);
  expect(page.rows.map(row => [row.externalId.split("/")[1], row.talk.shown, row.talk.reasons.map(reason => reason.code)])).toEqual([
    ["3mygaaaaaaaa3", false, ["bot"]],
    ["3mygaaaaaaaa4", false, ["multi_repo"]],
    ["3mygaaaaaaaa5", false, ["bluesky_stale"]],
    ["3mygaaaaaaaa1", true, []],
    ["3mygaaaaaaaa6", true, []],
    ["3mygaaaaaaaa2", false, ["below"]],
  ]);
  expect(page.rows.find(row => row.externalId.endsWith("/3mygaaaaaaaa6"))).toMatchObject({
    repositoryKey: "acme/app", linkUrl: "https://github.com/acme/app", linkTarget: "repo", product: { slug: "acme-app" },
  });
  // 다른 출처를 고르면 Bluesky 글은 빠진다
  expect((await listTalkPostsPage({ ...filter, source: "hn" }, { now: NOW, page: 1 })).total).toBe(0);
});
