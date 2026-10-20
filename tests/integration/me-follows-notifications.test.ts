import { eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { jobs, productHealth, products, productUpdates, rateLimits } from "@/lib/db/schema";
import { notifications, userFollows } from "@/lib/db/me-schema";
import { publicSessions, publicUsers } from "@/lib/db/public-user-schema";
import { productFeedback } from "@/lib/db/product-feedback-schema";
import { csrfForToken, newPublicSession } from "@/lib/domain/accounts/session";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));

const ORIGIN = "https://nomorevibe.example";
beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true");
  vi.stubEnv("PUBLIC_AUTH_SECRET", "integration-public-auth-secret-at-least-32-characters");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", ORIGIN);
  vi.stubEnv("GITHUB_FEEDBACK_DELIVERY_ENABLED", "false");
});

let slugSeq = 0;
async function product(change: Partial<typeof products.$inferInsert> = {}) {
  slugSeq += 1;
  const [row] = await db.insert(products).values({ slug: `p-${slugSeq}`, name: `Product ${slugSeq}`, url: `https://p${slugSeq}.example`,
    tagline: "Tagline", description: "Description", category: "Design", status: "seeded", source: "crawler",
    repoUrl: `https://github.com/Memo-Lab/repo-${slugSeq}`, verifyToken: "v", editTokenHash: "e", ...change }).returning();
  return row;
}

async function user(displayName = "사용자") {
  const [row] = await db.insert(publicUsers).values({ displayName }).returning();
  const session = newPublicSession();
  await db.insert(publicSessions).values({ tokenHash: session.tokenHash, userId: row.id, expiresAt: session.expiresAt });
  const cookie = `nmv_user=${session.token}`;
  return { ...row, cookie, headers: { cookie, origin: ORIGIN, "x-csrf-token": csrfForToken(session.token, "session"), "content-type": "application/json" } };
}
type User = Awaited<ReturnType<typeof user>>;

const followsRoute = () => import("@/app/api/me/follows/route");
const stateRoute = () => import("@/app/api/me/follows/state/route");
const listRoute = () => import("@/app/api/me/notifications/route");
const readRoute = () => import("@/app/api/me/notifications/read/route");
const unreadRoute = () => import("@/app/api/me/notifications/unread/route");

async function put(who: User, body: unknown, headers: Record<string, string> = who.headers) {
  return (await followsRoute()).PUT(new Request(`${ORIGIN}/api/me/follows`, { method: "PUT", headers, body: JSON.stringify(body) }));
}
async function remove(who: User, body: unknown) {
  return (await followsRoute()).DELETE(new Request(`${ORIGIN}/api/me/follows`, { method: "DELETE", headers: who.headers, body: JSON.stringify(body) }));
}
async function state(who: User, query: string) {
  return (await (await stateRoute()).GET(new Request(`${ORIGIN}/api/me/follows/state?${query}`, { headers: { cookie: who.cookie } }))).json();
}
async function list(who: User) {
  const response = await (await followsRoute()).GET(new Request(`${ORIGIN}/api/me/follows?locale=en`, { headers: { cookie: who.cookie } }));
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return response.json();
}
async function read(who: User, body: unknown) {
  return (await readRoute()).POST(new Request(`${ORIGIN}/api/me/notifications/read`, { method: "POST", headers: who.headers, body: JSON.stringify(body) }));
}
async function inbox(who: User, query = "") {
  return (await (await listRoute()).GET(new Request(`${ORIGIN}/api/me/notifications${query}`, { headers: { cookie: who.cookie } }))).json();
}
const ctx = <C>(cursor: C | null = null) => {
  const saved: { cursor: C | null } = { cursor };
  return { saved, ctx: { cursor, save: async (next: C) => { saved.cursor = next; }, hasBudget: () => true, log: () => {} } };
};

describe("팔로 API", () => {
  it("프로젝트·메이커·분야를 팔로하고 풀며, 단추 상태와 목록 표시 값을 돌려준다", async () => {
    const a = await user();
    const p = await product({ name: "메모장X", ogImage: "/og/memo.png" });
    await db.insert(productUpdates).values({ slug: p.slug, sourceKind: "github_release", dedupeKey: "r1", title: "v2.0.0", observedAt: new Date(), publishedAt: new Date() });
    expect((await put(a, { targetType: "product", targetKey: String(p.id) })).status).toBe(200);
    expect((await put(a, { targetType: "product", targetKey: String(p.id) })).status).toBe(200);
    expect(await (await put(a, { targetType: "maker", targetKey: "memo-lab" })).json()).toEqual({ targetType: "maker", targetKey: "memo-lab", following: true });
    expect((await put(a, { targetType: "category", targetKey: "design" })).status).toBe(200);
    expect(await state(a, `product=${p.id}&maker=memo-lab&category=dev`)).toEqual({ product: true, maker: true, category: false });

    const follows = await list(a);
    expect(follows.products).toEqual([expect.objectContaining({ productId: p.id, slug: p.slug, name: "메모장X", ogImage: "/og/memo.png", category: "Design", listed: true,
      latest: { title: "v2.0.0", at: expect.any(String) } })]);
    expect(follows.makers).toEqual([expect.objectContaining({ key: "memo-lab", login: "Memo-Lab", projects: 1 })]);
    expect(follows.categories).toEqual([expect.objectContaining({ slug: "design", category: "Design", label: "Design", newThisWeek: 1 })]);

    expect(await (await remove(a, { targetType: "maker", targetKey: "memo-lab" })).json()).toMatchObject({ following: false });
    expect(await state(a, "maker=memo-lab")).toEqual({ maker: false });
    expect(await db.select().from(userFollows)).toHaveLength(2);
  });

  it("없는 대상·틀린 모양·인증 없는 요청은 막는다", async () => {
    const a = await user();
    const banned = await product({ status: "banned" });
    const cases: Array<[unknown, number, string]> = [
      [{ targetType: "product", targetKey: "999999" }, 404, "follow_not_found"],
      [{ targetType: "product", targetKey: String(banned.id) }, 404, "follow_not_found"],
      [{ targetType: "maker", targetKey: "nobody-here" }, 404, "follow_not_found"],
      [{ targetType: "category", targetKey: "Design" }, 400, "invalid_request"],
      [{ targetType: "category", targetKey: "nope" }, 400, "invalid_request"],
      [{ targetType: "maker", targetKey: "Memo-Lab" }, 400, "invalid_request"],
      [{ targetType: "user", targetKey: "1" }, 400, "invalid_request"],
    ];
    for (const [body, status, error] of cases) {
      const response = await put(a, body);
      expect([response.status, (await response.json()).error]).toEqual([status, error]);
    }
    const body = { targetType: "category", targetKey: "design" };
    expect((await put(a, body, { ...a.headers, "x-csrf-token": "forged" })).status).toBe(403);
    expect((await put(a, body, { ...a.headers, origin: "https://evil.example" })).status).toBe(403);
    expect((await put(a, body, { origin: ORIGIN, "content-type": "application/json" })).status).toBe(401);
    expect((await (await stateRoute()).GET(new Request(`${ORIGIN}/api/me/follows/state?category=design`))).status).toBe(401);
    expect(await db.select().from(userFollows)).toHaveLength(0);
  });

  it("한 계정 500개까지 — 동시에 눌러도 넘지 않고, 이미 팔로한 것은 다시 눌러도 된다", async () => {
    const a = await user();
    await db.insert(userFollows).values(Array.from({ length: 498 }, (_, index) => ({ userId: a.id, targetType: "maker" as const, targetKey: `maker-${index}` })));
    await db.insert(userFollows).values({ userId: a.id, targetType: "category", targetKey: "dev" });
    const results = await Promise.all(["design", "games", "health"].map((key) => put(a, { targetType: "category", targetKey: key })));
    expect(results.map((response) => response.status).sort()).toEqual([200, 409, 409]);
    expect((await put(a, { targetType: "category", targetKey: "dev" })).status).toBe(200);
    const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(userFollows).where(eq(userFollows.userId, a.id));
    expect(total).toBe(500);
  });

  it("다른 계정의 팔로는 읽지도 풀지도 못한다", async () => {
    const [a, b] = [await user(), await user()];
    const p = await product();
    await put(a, { targetType: "product", targetKey: String(p.id) });
    expect((await list(b)).products).toEqual([]);
    expect(await state(b, `product=${p.id}`)).toEqual({ product: false });
    expect((await remove(b, { targetType: "product", targetKey: String(p.id) })).status).toBe(200);
    expect(await state(a, `product=${p.id}`)).toEqual({ product: true });
  });

  it("계정마다 1분 60번까지", async () => {
    const a = await user();
    await db.insert(rateLimits).values({ key: `me-follow:${a.id}`, count: 60, resetAt: new Date(Date.now() + 60_000) });
    expect((await put(a, { targetType: "category", targetKey: "dev" })).status).toBe(429);
  });
});

describe("알림함 API", () => {
  async function seed() {
    const [a, b] = [await user(), await user()];
    const p = await product({ name: "메모장X" });
    const rows = await db.insert(notifications).values([
      { userId: a.id, kind: "followed_release", productId: p.id, payload: { title: "v1" }, dedupeKey: "a1" },
      { userId: a.id, kind: "followed_release", productId: p.id, payload: { title: "v2" }, dedupeKey: "a2" },
      { userId: a.id, kind: "category_new", payload: { total: 3, categories: [{ category: "design", count: 3 }] }, dedupeKey: "a3" },
      { userId: b.id, kind: "followed_release", productId: p.id, payload: { title: "v2" }, dedupeKey: "b1" },
    ]).returning();
    return { a, b, p, rows };
  }

  it("최근 것부터 쪽으로 읽고, 한 줄은 요청한 말로 짓는다", async () => {
    const { a, rows } = await seed();
    const first = await inbox(a, "?limit=2&locale=en");
    expect(first.items.map((item: { id: number }) => item.id)).toEqual([rows[2].id, rows[1].id]);
    expect(first.unread).toBe(3);
    expect(first.items[1]).toMatchObject({ kind: "followed_release", label: "Followed project", href: expect.stringMatching(/^\/en\/p\/p-\d+$/), read: false });
    expect(first.items[1].parts).toEqual([{ text: "메모장X", strong: true }, { text: " released v2" }]);
    const second = await inbox(a, `?limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((item: { id: number }) => item.id)).toEqual([rows[0].id]);
    expect(second.nextCursor).toBeNull();
    expect((await (await listRoute()).GET(new Request(`${ORIGIN}/api/me/notifications?cursor=abc`, { headers: { cookie: a.cookie } }))).status).toBe(400);
  });

  it("남의 알림은 목록에도 커서로도 보이지 않는다", async () => {
    const { a, b, rows } = await seed();
    expect((await inbox(b)).items.map((item: { id: number }) => item.id)).toEqual([rows[3].id]);
    expect((await inbox(b, `?cursor=${rows[2].id}`)).items).toEqual([]);
    expect((await inbox(a)).items).toHaveLength(3);
  });

  it("읽음은 내 줄만 — 남의 id 는 무시하고, 모두 읽음도 내 것만", async () => {
    const { a, b, rows } = await seed();
    expect(await (await read(a, { ids: [rows[0].id, rows[3].id] })).json()).toEqual({ updated: 1, unread: 2 });
    expect(await (await (await unreadRoute()).GET(new Request(`${ORIGIN}/api/me/notifications/unread`, { headers: { cookie: b.cookie } }))).json()).toEqual({ unread: 1 });
    expect(await (await read(a, { all: true })).json()).toEqual({ updated: 2, unread: 0 });
    const [other] = await db.select().from(notifications).where(eq(notifications.id, rows[3].id));
    expect(other.readAt).toBeNull();
    for (const body of [{}, { ids: [] }, { ids: [0] }, { ids: ["1"] }, { all: true, ids: [1] }, { ids: Array.from({ length: 101 }, (_, i) => i + 1) }]) {
      expect((await read(a, body)).status).toBe(400);
    }
    expect((await (await listRoute()).GET(new Request(`${ORIGIN}/api/me/notifications`))).status).toBe(401);
  });
});

describe("알림 만들기", () => {
  it("notifyFollowers — 같은 dedupe_key 는 한 줄, 탈퇴한 계정·그 뒤 팔로한 계정은 빼고", async () => {
    const { notifyFollowers } = await import("@/lib/me/notifications");
    const [a, b, gone] = [await user(), await user(), await user()];
    const p = await product();
    await db.insert(userFollows).values([a, b, gone].map((who) => ({ userId: who.id, targetType: "product" as const, targetKey: String(p.id) })));
    await db.update(publicUsers).set({ deletedAt: new Date() }).where(eq(publicUsers.id, gone.id));
    await db.update(userFollows).set({ createdAt: new Date(Date.now() + 60_000) }).where(eq(userFollows.userId, b.id));
    const input = { targetType: "product" as const, targetKeys: [String(p.id)], kind: "followed_delisted" as const, productId: p.id, payload: { reason: "down" }, dedupeKey: "k1" };
    expect(await notifyFollowers({ ...input, followedBefore: new Date(Date.now() + 1_000) })).toBe(1);
    expect(await notifyFollowers(input)).toBe(1);
    expect(await notifyFollowers(input)).toBe(0);
    expect((await db.select().from(notifications)).map((row) => row.userId).sort()).toEqual([a.id, b.id].sort());
  });

  it("comment_reviewed — 보류한 글을 공개·거절하면 작성자에게 한 번", async () => {
    const { submitFeedback } = await import("@/lib/domain/feedback/submit");
    const { reviewFeedback } = await import("@/lib/domain/feedback/review");
    const author = await user();
    const p = await product({ status: "verified" });
    const held = await submitFeedback(p.slug, author.id, { requestId: crypto.randomUUID(), kind: "bug", title: "링크", body: "https://a.test https://b.test http://c.test https://d.test",
      serviceDisclosureConsent: true, sendToGithub: false, githubDisclosureConsent: false });
    expect(held.feedback.reviewState).toBe("held");
    await reviewFeedback({ id: held.feedback.id, expectedReviewState: "held", decision: "accepted", reason: "확인", adminLogin: "admin" });
    await reviewFeedback({ id: held.feedback.id, expectedReviewState: "accepted", decision: "rejected", reason: "숨김", adminLogin: "admin" });
    const rows = await db.select().from(notifications);
    expect(rows).toEqual([expect.objectContaining({ userId: author.id, kind: "comment_reviewed", productId: p.id,
      payload: { decision: "accepted", feedbackId: held.feedback.id }, dedupeKey: `comment_reviewed:${held.feedback.id}:accepted` })]);
    const [stored] = await db.select().from(productFeedback);
    expect(stored.reviewState).toBe("rejected");
  });

  it("followed_release — 메이커 업데이트를 쓰면 팔로한 사람에게 업데이트마다 한 줄, 오래된 릴리스는 알리지 않는다", async () => {
    const { createMakerUpdate } = await import("@/lib/domain/evidence/maker");
    const { notifyNewReleases } = await import("@/lib/me/notifications");
    const [a, stranger] = [await user(), await user()];
    const p = await product({ status: "verified" });
    await db.insert(userFollows).values({ userId: a.id, targetType: "product", targetKey: String(p.id) });
    await db.insert(productUpdates).values({ slug: p.slug, sourceKind: "github_release", dedupeKey: "old", title: "v0.1", observedAt: new Date(), publishedAt: new Date(Date.now() - 30 * 86_400_000) });
    const id = await createMakerUpdate({ slug: p.slug, update: { title: "v2.0.0" }, actor: "maker:test" });
    expect(await notifyNewReleases(p.id)).toBe(0);
    const rows = await db.select().from(notifications);
    expect(rows).toEqual([expect.objectContaining({ userId: a.id, kind: "followed_release", productId: p.id, payload: { title: "v2.0.0", updateId: id }, dedupeKey: `followed_release:${id}` })]);
    expect(rows.some((row) => row.userId === stranger.id)).toBe(false);
  });

  it("알림 넣기가 실패해도 부른 쪽(메이커 업데이트·심사)은 그대로 끝난다", async () => {
    const { createMakerUpdate } = await import("@/lib/domain/evidence/maker");
    const { notifyCommentReviewed } = await import("@/lib/me/notifications");
    const a = await user();
    const p = await product({ status: "verified" });
    await db.insert(userFollows).values({ userId: a.id, targetType: "product", targetKey: String(p.id) });
    await db.execute(sql`create or replace function test_notifications_down() returns trigger language plpgsql as $$ begin raise exception 'notifications down'; end $$`);
    await db.execute(sql`create trigger test_notifications_down before insert on notifications for each row execute function test_notifications_down()`);
    try {
      const id = await createMakerUpdate({ slug: p.slug, update: { title: "v3" }, actor: "maker:test" });
      expect(await db.select().from(productUpdates).where(eq(productUpdates.id, id))).toHaveLength(1);
      await expect(notifyCommentReviewed({ id: crypto.randomUUID(), productId: p.id, authorUserId: a.id }, "accepted")).resolves.toBe(0);
    } finally {
      await db.execute(sql`drop trigger test_notifications_down on notifications`);
      await db.execute(sql`drop function test_notifications_down()`);
    }
    expect(await db.select().from(notifications)).toEqual([]);
  });

  it("maker_new_project — 그 GitHub 주인을 팔로한 사람에게, 기본 목록에서 빼는 개인 프로필은 빼고", async () => {
    const { notifyMakerNewProject } = await import("@/lib/me/notifications");
    const a = await user();
    await db.insert(userFollows).values({ userId: a.id, targetType: "maker", targetKey: "memo-lab" });
    const p = await product({ name: "위젯" });
    const profile = await product({ category: "Profile" });
    expect(await notifyMakerNewProject(p.slug)).toBe(1);
    expect(await notifyMakerNewProject(p.slug)).toBe(0);
    expect(await notifyMakerNewProject(profile.slug)).toBe(0);
    expect(await db.select().from(notifications)).toEqual([expect.objectContaining({ userId: a.id, kind: "maker_new_project", productId: p.id, payload: { maker: "Memo-Lab" } })]);
  });
});

describe("알림 잡", () => {
  it("notification-delisted — 차단(cdn_purges 를 따라)과 연속 실패를 팔로한 사람에게 한 번씩", async () => {
    const { sendDelistedNotifications } = await import("@/lib/jobs/me/notifications");
    const [a, late] = [await user(), await user()];
    const [banned, down, before] = [await product(), await product(), await product()];
    await db.update(products).set({ status: "banned" }).where(eq(products.id, before.id));
    const since = new Date(Date.now() - 2 * 86_400_000);
    await db.insert(userFollows).values([banned, down, before].map((p) => ({ userId: a.id, targetType: "product" as const, targetKey: String(p.id), createdAt: new Date(since.getTime() - 86_400_000) })));
    await db.insert(userFollows).values({ userId: late.id, targetType: "product", targetKey: String(down.id) });

    // 처음에는 지금 끝에서 시작한다 — 그 전에 내려간 것(before)은 알리지 않는다
    const start = await sendDelistedNotifications(ctx<{ purgeId: number }>().ctx);
    expect(start.cursor).toEqual({ purgeId: expect.any(Number) });
    expect(await db.select().from(notifications)).toEqual([]);

    await db.update(products).set({ status: "banned" }).where(eq(products.id, banned.id));
    await db.insert(productHealth).values({ slug: down.slug, status: 0, failures: 3, downSince: since, checkedAt: new Date() });
    await sendDelistedNotifications(ctx(start.cursor ?? null).ctx);
    const rows = await db.select().from(notifications);
    expect(rows.map((row) => [row.userId, row.productId, row.payload]).sort()).toEqual([
      [a.id, banned.id, { reason: "removed" }], [a.id, down.id, { reason: "down" }],
    ].sort());
  });

  it("notification-delisted — 커서 뒤의 차단만 보고 다시 돌아도 한 줄", async () => {
    const { sendDelistedNotifications } = await import("@/lib/jobs/me/notifications");
    const a = await user();
    const p = await product();
    await db.insert(userFollows).values({ userId: a.id, targetType: "product", targetKey: String(p.id) });
    const start = await sendDelistedNotifications(ctx<{ purgeId: number }>().ctx);
    await db.update(products).set({ status: "banned" }).where(eq(products.id, p.id));
    const next = await sendDelistedNotifications(ctx(start.cursor ?? null).ctx);
    await sendDelistedNotifications(ctx(start.cursor ?? null).ctx);
    expect(next.cursor?.purgeId).toBeGreaterThan(start.cursor?.purgeId ?? 0);
    expect(await db.select().from(notifications)).toHaveLength(1);
  });

  it("notification-category-digest — 월요일 09:00 뒤 하루 안에, 계정마다 그 주 한 줄", async () => {
    const { sendCategoryDigest } = await import("@/lib/jobs/me/notifications");
    const [a, b, idle] = [await user(), await user(), await user()];
    const sendAt = new Date("2026-10-19T00:00:00Z"); // 월요일 09:00 KST
    const inWindow = new Date(sendAt.getTime() - 2 * 86_400_000);
    await product({ category: "Design", createdAt: inWindow });
    await product({ category: "Design", createdAt: inWindow });
    await product({ category: "Dev", createdAt: inWindow });
    await product({ category: "Dev", createdAt: new Date(sendAt.getTime() - 8 * 86_400_000) });
    await product({ category: "Dev", createdAt: inWindow, status: "banned" });
    await db.insert(userFollows).values([
      { userId: a.id, targetType: "category", targetKey: "design" }, { userId: a.id, targetType: "category", targetKey: "dev" },
      { userId: b.id, targetType: "category", targetKey: "dev" }, { userId: idle.id, targetType: "category", targetKey: "games" },
    ]);
    const early = ctx<{ week: string; afterUserId: number; done: boolean }>();
    expect(await sendCategoryDigest(early.ctx, new Date(sendAt.getTime() - 60_000))).toEqual({ done: true, cursor: null });
    const run = ctx<{ week: string; afterUserId: number; done: boolean }>();
    const result = await sendCategoryDigest(run.ctx, new Date(sendAt.getTime() + 3_600_000));
    expect(result.cursor).toMatchObject({ week: "2026-W43", done: true });
    await sendCategoryDigest(ctx<{ week: string; afterUserId: number; done: boolean }>().ctx, new Date(sendAt.getTime() + 7_200_000));
    const rows = await db.select().from(notifications);
    expect(rows.map((row) => [row.userId, row.dedupeKey, row.payload]).sort()).toEqual([
      [a.id, "category_new:2026-W43", { week: "2026-W43", total: 3, categories: [{ category: "design", count: 2 }, { category: "dev", count: 1 }], others: 1 }],
      [b.id, "category_new:2026-W43", { week: "2026-W43", total: 1, categories: [{ category: "dev", count: 1 }], others: 0 }],
    ].sort());
    expect(await sendCategoryDigest(ctx<{ week: string; afterUserId: number; done: boolean }>().ctx, new Date(sendAt.getTime() + 25 * 3_600_000))).toMatchObject({ done: true, cursor: null });
  });

  it("notification-prune — 90일 지난 알림만, 잡 이름으로 돌린다", async () => {
    const { runJob } = await import("@/lib/jobs/runner");
    const { JOBS } = await import("@/lib/jobs/registry");
    const a = await user();
    await db.insert(notifications).values([
      { userId: a.id, kind: "inbox_new", dedupeKey: "old", createdAt: new Date(Date.now() - 91 * 86_400_000) },
      { userId: a.id, kind: "inbox_new", dedupeKey: "new", createdAt: new Date(Date.now() - 10 * 86_400_000) },
    ]);
    await db.delete(jobs).where(eq(jobs.name, "notification-prune"));
    expect(await runJob("notification-prune", JOBS["notification-prune"])).toMatchObject({ status: "completed", done: true });
    expect((await db.select().from(notifications)).map((row) => row.dedupeKey)).toEqual(["new"]);
  });
});
