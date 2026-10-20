import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { operationsObservations, socialPostObservations, socialPosts } from "@/lib/db/schema";
import { clearAllMemos } from "@/lib/cache/memo";
import { POST } from "@/app/api/ops/x-posts/route";
import { signXPosts, X_POSTS_KEY } from "@/lib/operations/x-posts";
import { signXStatus, X_STATUS_PREVIOUS_SECRET_ENV, X_STATUS_SECRET_ENV } from "@/lib/operations/x-status";
import { ensureSchema } from "./setup";

/*
 * SNS 화제 C안 T18: X 수집기의 게시물 보고를 실제 PostgreSQL 로 받는다.
 * 관측 표의 x-posts 한 줄(단조·60초 속도)과 social_posts(source=x)·관측이 한 트랜잭션에 쓰인다.
 */
const SECRET = "x-status-current-secret-0123456789abcdef", OLD = "x-status-previous-secret-0123456789abcdef";
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const post = (id: string, like = 40, patch: Record<string, unknown> = {}) => ({ id, createdAt: minutesAgo(120), repository: "Acme/Tool",
  metrics: { like, reply: 6, repost: 9, quote: 2 }, ...patch });
const body = (patch: Record<string, unknown> = {}) => ({ v: 1, observedAt: minutesAgo(1), posts: [post("1980000000000000001")], unavailable: [], ...patch });
function signed(value: unknown, timestamp: number, options: { secret?: string; sign?: typeof signXPosts } = {}) {
  const raw = JSON.stringify(value);
  return new Request("https://nomorevibe.test/api/ops/x-posts", { method: "POST", body: raw, headers: {
    "content-type": "application/json", "x-nmv-timestamp": String(timestamp),
    "x-nmv-signature": (options.sign ?? signXPosts)(options.secret ?? SECRET, timestamp, raw) } });
}
const claim = async () => (await db.select({ value: operationsObservations.value })
  .from(operationsObservations).where(eq(operationsObservations.key, X_POSTS_KEY)))[0];
const posts = () => db.select().from(socialPosts).orderBy(socialPosts.externalId);
const observations = () => db.select().from(socialPostObservations);
const now = () => Math.floor(Date.now() / 1000);
const ageClaim = () => db.update(operationsObservations).set({ observedAt: sql`(now() at time zone 'utc') - interval '61 seconds'` })
  .where(eq(operationsObservations.key, X_POSTS_KEY));

async function reset() {
  await db.delete(operationsObservations).where(eq(operationsObservations.key, X_POSTS_KEY));
  await db.execute(sql`TRUNCATE social_post_observations, social_posts RESTART IDENTITY CASCADE`);
}

beforeAll(ensureSchema);
beforeEach(async () => {
  await reset();
  clearAllMemos();
  vi.stubEnv(X_STATUS_SECRET_ENV, SECRET);
  vi.stubEnv(X_STATUS_PREVIOUS_SECRET_ENV, OLD);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await reset();
});

it("꺼진 주소는 404 이고 아무것도 쓰지 않는다", async () => {
  vi.stubEnv(X_STATUS_SECRET_ENV, "");
  expect((await POST(signed(body(), now()))).status).toBe(404);
  expect(await claim()).toBeUndefined();
  expect(await posts()).toEqual([]);
});

it("서명한 보고의 게시물을 source=x 로 넣고 관측을 남긴다 — 같은 보고를 다시 보내면 409", async () => {
  const sentAt = now();
  const response = await POST(signed(body(), sentAt));
  expect([response.status, await response.json()]).toEqual([200, { accepted: true, inserted: 1, updated: 0, gone: 0 }]);
  const [row] = await posts();
  expect(row).toMatchObject({ source: "x", externalId: "1980000000000000001", kind: "link", title: "", linkUrl: "https://github.com/Acme/Tool",
    linkTarget: "repo", repositoryKey: "acme/tool", points: 58, comments: 6, frontPage: false, state: "visible" });
  expect(await observations()).toEqual([expect.objectContaining({ postId: row.id, points: 58, comments: 6 })]);
  expect((await claim()).value).toMatchObject({ v: 1, sentAt, signedWith: "current", posts: 1, unavailable: 0 });
  const replay = await POST(signed(body(), sentAt));
  expect([replay.status, await replay.json()]).toEqual([409, { error: "x_posts_not_newer" }]);
});

it("60초 안의 새 보고는 429 로 아무것도 쓰지 않고, 지나면 값을 덮고 관측을 더한다", async () => {
  const sentAt = now() - 10;
  expect((await POST(signed(body(), sentAt))).status).toBe(200);
  const limited = await POST(signed(body({ posts: [post("1980000000000000001", 90)] }), sentAt + 1));
  expect([limited.status, limited.headers.get("retry-after")]).toEqual([429, "60"]);
  expect((await posts())[0].points).toBe(58);
  await ageClaim();
  const later = await POST(signed(body({ posts: [post("1980000000000000001", 90)] }), sentAt + 2, { secret: OLD }));
  expect([later.status, await later.json()]).toEqual([200, { accepted: true, inserted: 0, updated: 1, gone: 0 }]);
  expect((await posts())[0].points).toBe(108);
  expect(await observations()).toHaveLength(2);
  expect((await claim()).value).toMatchObject({ signedWith: "previous", sentAt: sentAt + 2 });
});

it("사용할 수 없다고 온 글은 내리고, 관리자가 숨긴 글은 그대로 둔다", async () => {
  const sentAt = now() - 10;
  expect((await POST(signed(body({ posts: [post("1980000000000000001"), post("1980000000000000002")] }), sentAt))).status).toBe(200);
  await db.update(socialPosts).set({ state: "hidden", stateReason: "admin" }).where(eq(socialPosts.externalId, "1980000000000000002"));
  await ageClaim();
  const response = await POST(signed(body({ posts: [], unavailable: ["1980000000000000001", "1980000000000000002", "1980000000000000003"] }), sentAt + 1));
  expect([response.status, await response.json()]).toEqual([200, { accepted: true, inserted: 0, updated: 0, gone: 1 }]);
  expect((await posts()).map(row => [row.externalId, row.state, row.stateReason])).toEqual([
    ["1980000000000000001", "gone", "source_unavailable"], ["1980000000000000002", "hidden", "admin"]]);
});

it("하루 보고의 서명이나 틀린 형식은 DB 앞에서 거절한다", async () => {
  expect((await POST(signed(body(), now(), { sign: signXStatus }))).status).toBe(401);
  expect((await POST(signed(body({ posts: [post("1980000000000000001", 40, { text: "private" })] }), now()))).status).toBe(400);
  expect(await claim()).toBeUndefined();
  expect(await posts()).toEqual([]);
});
