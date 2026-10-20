import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { emailOutbox, notificationSettings, notifications } from "@/lib/db/me-schema";
import { publicIdentities, publicSessions, publicUsers } from "@/lib/db/public-user-schema";
import { csrfForToken, newPublicSession } from "@/lib/domain/accounts/session";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));

const ORIGIN = "https://nomorevibe.example";
const SECRET = "integration-public-auth-secret-longer-than-32-characters";
const route = () => import("@/app/api/me/notification-settings/route");
const unsubscribeRoute = () => import("@/app/api/me/notification-settings/unsubscribe/route");
const outbox = () => import("@/lib/me/email-outbox");

beforeAll(() => ensureSchema());
beforeEach(async () => {
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true");
  vi.stubEnv("PUBLIC_AUTH_SECRET", SECRET);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", ORIGIN);
  vi.stubEnv("LOGIN_EMAIL_API_KEY", "");
  vi.stubEnv("LOGIN_EMAIL_FROM", "");
  await resetTables();
  await db.execute(sql`TRUNCATE email_outbox, notifications, notification_settings RESTART IDENTITY CASCADE`);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const configureEmail = () => { vi.stubEnv("LOGIN_EMAIL_API_KEY", "re_integration"); vi.stubEnv("LOGIN_EMAIL_FROM", "alerts@nomorevibe.example"); };

async function member(name: string, email?: string) {
  const [user] = await db.insert(publicUsers).values({ displayName: name }).returning();
  if (email) await db.insert(publicIdentities).values({ userId: user.id, provider: "email", subject: email });
  const session = newPublicSession();
  await db.insert(publicSessions).values({ userId: user.id, tokenHash: session.tokenHash, createdAt: session.createdAt, expiresAt: session.expiresAt });
  return { id: user.id, headers: { cookie: `nmv_user=${session.token}`, origin: ORIGIN, "x-csrf-token": csrfForToken(session.token, "session"), "content-type": "application/json" } };
}
async function product(slug: string) {
  const [row] = await db.insert(products).values({ slug, url: `https://${slug}.example`, name: `Project ${slug}`, tagline: "A test project", description: "Test", category: "other", status: "seeded", verifyToken: `${slug}-token`, editTokenHash: `${slug}-hash` }).returning();
  return row;
}
const get = async (headers: Record<string, string>) => (await route()).GET(new Request(`${ORIGIN}/api/me/notification-settings`, { headers }));
const put = async (headers: Record<string, string>, body: unknown) => (await route()).PUT(new Request(`${ORIGIN}/api/me/notification-settings`, { method: "PUT", headers, body: JSON.stringify(body) }));
const rows = () => db.select().from(emailOutbox).orderBy(emailOutbox.createdAt);

describe("GET·PUT /api/me/notification-settings", () => {
  it("행이 없으면 기본값, 발신 설정이 없으면 메일을 쓸 수 없다고 답한다", async () => {
    const reader = await member("읽는이", "hanul@example.com");
    const response = await get(reader.headers);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      settings: { makerReply: "instant", followedProject: "weekly", followedMaker: "off", followedCategory: "weekly", newListingMine: "instant", digestWeekday: 1, digestHour: 9, newsOptIn: false, locale: "ko" },
      emailConfigured: false, emailAddress: "ha***@example.com", emailAvailable: false,
    });
    expect((await get({ origin: ORIGIN })).status).toBe(401);
    configureEmail();
    expect(await (await get(reader.headers)).json()).toMatchObject({ emailConfigured: true, emailAvailable: true });
    const github = await member("깃허브만");
    expect(await (await get(github.headers)).json()).toMatchObject({ emailConfigured: true, emailAvailable: false, emailAddress: null });
  });

  it("바꾼 칸만 저장하고, 소식 동의는 처음 동의한 시각을 지키다 끄면 지운다", async () => {
    const reader = await member("읽는이", "hanul@example.com");
    const saved = await put(reader.headers, { makerReply: "weekly", digestWeekday: 3, digestHour: 20, newsOptIn: true, locale: "en" });
    expect(saved.status).toBe(200);
    expect((await saved.json()).settings).toMatchObject({ makerReply: "weekly", followedProject: "weekly", digestWeekday: 3, digestHour: 20, newsOptIn: true, locale: "en" });
    const [first] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, reader.id));
    expect(first.newsOptInAt).toBeInstanceOf(Date);
    expect(first.emailIdentityId).not.toBeNull();
    await db.update(notificationSettings).set({ newsOptInAt: new Date("2026-01-01T00:00:00Z") });
    await put(reader.headers, { newsOptIn: true, followedMaker: "instant" });
    const [second] = await db.select().from(notificationSettings);
    expect(second.newsOptInAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(second).toMatchObject({ followedMaker: "instant", makerReply: "weekly", digestHour: 20 });
    await put(reader.headers, { newsOptIn: false });
    expect((await db.select().from(notificationSettings))[0].newsOptInAt).toBeNull();
  });

  it("고를 수 없는 값·모르는 칸·CSRF·Origin 을 거절하고 남의 행을 건드리지 않는다", async () => {
    const reader = await member("읽는이", "hanul@example.com");
    const other = await member("다른이", "other@example.com");
    for (const body of [{ followedCategory: "instant" }, { newListingMine: "weekly" }, { digestHour: 24 }, { userId: other.id, makerReply: "off" }, {}]) {
      expect((await put(reader.headers, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await put({ ...reader.headers, "x-csrf-token": "0".repeat(64) }, { makerReply: "off" })).status).toBe(403);
    expect((await put({ ...reader.headers, origin: "https://evil.example" }, { makerReply: "off" })).status).toBe(403);
    expect((await put({ origin: ORIGIN, "content-type": "application/json" }, { makerReply: "off" })).status).toBe(401);
    expect(await db.select().from(notificationSettings)).toEqual([]);
    expect((await put(reader.headers, { makerReply: "off" })).status).toBe(200);
    expect((await (await get(other.headers)).json()).settings.makerReply).toBe("instant");
    expect((await db.select().from(notificationSettings)).map((row) => row.userId)).toEqual([reader.id]);
  });

  it("1분에 30번을 넘게 바꾸면 쉰다", async () => {
    const reader = await member("읽는이");
    for (let index = 0; index < 30; index += 1) expect((await put(reader.headers, { digestHour: index % 24 })).status).toBe(200);
    expect((await put(reader.headers, { digestHour: 1 })).status).toBe(429);
  });
});

describe("notify → 발송함", () => {
  it("«즉시»이고 주소가 있으면 한 줄, 주간·끔·사이트 안 종류·발신 설정 없음·주소 없음이면 넣지 않는다", async () => {
    const { notify } = await import("@/lib/me/notify");
    const reader = await member("읽는이", "hanul@example.com");
    const noAddress = await member("주소없음");
    const item = await product("one");
    expect(await notify({ userId: reader.id, kind: "maker_reply", productId: item.id, dedupeKey: "maker_reply:1" })).toBe(true);
    expect(await rows()).toEqual([]);

    configureEmail();
    expect(await notify({ userId: reader.id, kind: "maker_reply", productId: item.id, dedupeKey: "maker_reply:2" })).toBe(true);
    expect(await notify({ userId: reader.id, kind: "maker_reply", productId: item.id, dedupeKey: "maker_reply:2" })).toBe(false);
    await notify({ userId: reader.id, kind: "followed_release", productId: item.id, dedupeKey: "followed_release:1" });
    await notify({ userId: reader.id, kind: "comment_reviewed", productId: item.id, dedupeKey: "comment_reviewed:1" });
    await notify({ userId: noAddress.id, kind: "maker_reply", productId: item.id, dedupeKey: "maker_reply:2" });
    const queued = await rows();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ userId: reader.id, kind: "maker_reply", dedupeKey: `email:${reader.id}:maker_reply:2`, state: "pending", attempts: 0 });
    expect(queued[0].payload).toMatchObject({ setting: "makerReply", product: { slug: "one", name: "Project one" } });

    await put(reader.headers, { makerReply: "off", followedProject: "instant" });
    await notify({ userId: reader.id, kind: "maker_reply", productId: item.id, dedupeKey: "maker_reply:3" });
    await notify({ userId: reader.id, kind: "followed_delisted", productId: item.id, dedupeKey: "followed_delisted:1" });
    expect((await rows()).map((row) => row.kind)).toEqual(["maker_reply", "followed_delisted"]);
    expect(await db.select().from(notifications)).toHaveLength(7);
  });

  it("발송함에 넣다 실패해도 notify 는 던지지 않는다", async () => {
    configureEmail();
    const { enqueueNotificationEmail } = await outbox();
    expect(await enqueueNotificationEmail({ id: 1, userId: 999_999, kind: "maker_reply", dedupeKey: "maker_reply:x" })).toBe(false);
    const reader = await member("읽는이", "hanul@example.com");
    await db.execute(sql`ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_test_block CHECK (kind <> 'maker_reply') NOT VALID`);
    try {
      const { notify } = await import("@/lib/me/notify");
      await expect(notify({ userId: reader.id, kind: "maker_reply", dedupeKey: "maker_reply:9" })).resolves.toBe(true);
    } finally {
      await db.execute(sql`ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_test_block`);
    }
    expect(await rows()).toEqual([]);
  });
});

describe("email-outbox-send", () => {
  async function queued() {
    configureEmail();
    const { notify } = await import("@/lib/me/notify");
    const reader = await member("읽는이", "hanul@example.com");
    const item = await product("one");
    await notify({ userId: reader.id, kind: "maker_reply", productId: item.id, dedupeKey: "maker_reply:1" });
    const [row] = await rows();
    return { reader, row };
  }

  it("받아들이면 accepted, 같은 Idempotency-Key·끄기 머리글·끄기 링크를 담는다", async () => {
    const { reader, row } = await queued();
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    const tick = await (await outbox()).sendPendingEmails({ fetcher: fetcher as unknown as typeof fetch });
    expect(tick).toMatchObject({ accepted: 1, retry: 0 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(`nmv-email-${row.id}`);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ from: "alerts@nomorevibe.example", to: ["hanul@example.com"] });
    expect(body.subject).toContain("Project one");
    expect(body.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(body.headers["List-Unsubscribe"]).toMatch(new RegExp(`^<${ORIGIN}/api/me/notification-settings/unsubscribe\\?token=${reader.id}\\.makerReply\\.`));
    expect(body.text).toContain(`${ORIGIN}/p/one`);
    const [sent] = await rows();
    expect(sent).toMatchObject({ state: "accepted", attempts: 1, lastError: null });
    expect(sent.sentAt).toBeInstanceOf(Date);
  });

  it("5xx 는 1분 뒤 다시, 다섯 번째에도 모르면 unknown, 4xx 는 rejected", async () => {
    const { row } = await queued();
    const failing = vi.fn(async () => new Response("{}", { status: 503 }));
    const { sendPendingEmails } = await outbox();
    expect(await sendPendingEmails({ fetcher: failing as unknown as typeof fetch })).toMatchObject({ retry: 1 });
    const [waiting] = await rows();
    expect(waiting).toMatchObject({ state: "pending", attempts: 1, lastError: "unknown" });
    const delay = waiting.nextAttemptAt.getTime() - Date.now();
    expect(delay).toBeGreaterThan(30_000);
    expect(delay).toBeLessThanOrEqual(61_000);
    expect(await sendPendingEmails({ fetcher: failing as unknown as typeof fetch })).toMatchObject({ retry: 0 });
    expect(failing).toHaveBeenCalledTimes(1);
    await db.update(emailOutbox).set({ attempts: 4, nextAttemptAt: new Date(Date.now() - 1_000) }).where(eq(emailOutbox.id, row.id));
    expect(await sendPendingEmails({ fetcher: failing as unknown as typeof fetch })).toMatchObject({ unknown: 1 });
    expect((await rows())[0]).toMatchObject({ state: "unknown", attempts: 5 });

    await db.update(emailOutbox).set({ state: "pending", attempts: 0, nextAttemptAt: new Date(Date.now() - 1_000) });
    expect(await sendPendingEmails({ fetcher: (async () => new Response("{}", { status: 422 })) as unknown as typeof fetch })).toMatchObject({ rejected: 1 });
    expect((await rows())[0]).toMatchObject({ state: "rejected", lastError: "rejected" });
  });

  it("발신 설정이 없으면 남은 줄을 skipped 로 닫고 네트워크를 부르지 않는다", async () => {
    await queued();
    vi.stubEnv("LOGIN_EMAIL_API_KEY", "");
    const network = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", network);
    expect(await (await outbox()).sendPendingEmails()).toMatchObject({ skipped: 1 });
    expect(network).not.toHaveBeenCalled();
    expect((await rows())[0]).toMatchObject({ state: "skipped", lastError: "email_unconfigured" });
  });

  it("잡 러너의 lease 안에서 보내고 주간 요약 잡도 돈다", async () => {
    await queued();
    const network = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", network);
    const { runJob } = await import("@/lib/jobs/runner");
    const { queueEmailDigests, sendEmailOutbox } = await import("@/lib/jobs/me/email");
    expect(await runJob("email-outbox-send", sendEmailOutbox)).toMatchObject({ status: "completed" });
    expect(network).toHaveBeenCalledTimes(1);
    expect((await rows())[0]).toMatchObject({ state: "accepted" });
    expect(await runJob("email-weekly-digest", queueEmailDigests)).toMatchObject({ status: "completed" });
  });

  it("그사이 설정을 끄면 보내지 않는다", async () => {
    const { reader } = await queued();
    await put(reader.headers, { makerReply: "weekly" });
    const fetcher = vi.fn(async () => new Response("{}"));
    expect(await (await outbox()).sendPendingEmails({ fetcher: fetcher as unknown as typeof fetch })).toMatchObject({ skipped: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("email-weekly-digest", () => {
  const MONDAY_10_KST = new Date("2026-10-19T01:00:00Z");
  it("고른 요일·시각이 지나면 계정마다 한 주 한 통, 지난 7일 안 읽은 주간 종류만 묶는다", async () => {
    configureEmail();
    const reader = await member("읽는이", "hanul@example.com");
    const quiet = await member("조용한이", "quiet@example.com");
    await member("주소없음");
    const item = await product("one");
    const old = await product("old");
    await db.insert(notifications).values([
      { userId: reader.id, kind: "followed_release", productId: item.id, dedupeKey: "followed_release:1", createdAt: new Date("2026-10-18T00:00:00Z") },
      { userId: reader.id, kind: "followed_release", productId: old.id, dedupeKey: "followed_release:2", createdAt: new Date("2026-10-01T00:00:00Z") },
      { userId: reader.id, kind: "followed_delisted", productId: item.id, dedupeKey: "followed_delisted:1", createdAt: new Date("2026-10-18T00:00:00Z"), readAt: new Date() },
      { userId: reader.id, kind: "maker_reply", productId: item.id, dedupeKey: "maker_reply:1", createdAt: new Date("2026-10-18T00:00:00Z") },
    ]);
    const { queueWeeklyDigests, sendPendingEmails } = await outbox();
    expect(await queueWeeklyDigests({ now: new Date("2026-10-18T23:00:00Z") })).toEqual({ queued: 0, empty: 0 });
    expect(await queueWeeklyDigests({ now: new Date("2026-10-18T01:00:00Z") })).toEqual({ queued: 0, empty: 0 });
    expect(await queueWeeklyDigests({ now: MONDAY_10_KST })).toEqual({ queued: 1, empty: 1 });
    expect(await queueWeeklyDigests({ now: MONDAY_10_KST })).toEqual({ queued: 0, empty: 0 });
    expect(await queueWeeklyDigests({ now: new Date("2026-10-19T14:00:00Z") })).toEqual({ queued: 0, empty: 0 });
    const digests = await rows();
    expect(digests.map((row) => [row.userId, row.dedupeKey, row.state])).toEqual(expect.arrayContaining([
      [reader.id, `digest:${reader.id}:2026-W43`, "pending"], [quiet.id, `digest:${quiet.id}:2026-W43`, "skipped"],
    ]));
    const mine = digests.find((row) => row.userId === reader.id)!;
    expect(mine.payload).toEqual({ week: "2026-W43", total: 1, items: [{ kind: "followed_release", product: { slug: "one", name: "Project one" } }] });

    const fetcher = vi.fn(async () => new Response("{}"));
    expect(await sendPendingEmails({ fetcher: fetcher as unknown as typeof fetch })).toMatchObject({ accepted: 1 });
    const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.text).toContain("Project one");
    expect(body.headers["List-Unsubscribe"]).toContain(`token=${reader.id}.weekly.`);
    expect(await queueWeeklyDigests({ now: new Date("2026-10-26T01:00:00Z") })).toEqual({ queued: 0, empty: 2 });
  });

  it("고른 요일·시각을 따르고, 주간 칸이 하나도 없으면 묶지 않는다", async () => {
    configureEmail();
    const evening = await member("저녁", "evening@example.com");
    const none = await member("안받음", "none@example.com");
    await put(evening.headers, { digestWeekday: 5, digestHour: 21 });
    await put(none.headers, { followedProject: "off", followedCategory: "off" });
    const { queueWeeklyDigests } = await outbox();
    expect(await queueWeeklyDigests({ now: new Date("2026-10-23T11:00:00Z") })).toEqual({ queued: 0, empty: 0 });
    expect(await queueWeeklyDigests({ now: new Date("2026-10-23T12:30:00Z") })).toEqual({ queued: 0, empty: 1 });
    expect((await rows()).map((row) => row.userId)).toEqual([evening.id]);
    expect(await queueWeeklyDigests({ now: new Date("2026-10-19T01:00:00Z") })).toEqual({ queued: 0, empty: 0 });
  });
});

describe("GET·POST /api/me/notification-settings/unsubscribe", () => {
  const call = async (method: "GET" | "POST", token: string, lang = "ko") => {
    const handler = (await unsubscribeRoute())[method];
    return handler(new Request(`${ORIGIN}/api/me/notification-settings/unsubscribe?token=${encodeURIComponent(token)}&lang=${lang}`, {
      method, ...(method === "POST" ? { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" } : {}),
    }));
  };
  it("GET 은 확인 화면만, POST 가 서명한 칸 하나를 끈다 — 고친 열쇠는 아무것도 바꾸지 않는다", async () => {
    const { signUnsubscribeToken } = await import("@/lib/me/unsubscribe");
    const reader = await member("읽는이", "hanul@example.com");
    const other = await member("다른이", "other@example.com");
    const token = signUnsubscribeToken(reader.id, "makerReply");
    const tampered = token.replace(`${reader.id}.`, `${other.id}.`);
    const refused = await call("GET", tampered);
    expect(refused.status).toBe(400);
    expect(await db.select().from(notificationSettings)).toEqual([]);

    // 메일 보안 검사기가 링크를 미리 열어도 꺼지지 않는다
    const confirm = await call("GET", token);
    expect(confirm.status).toBe(200);
    expect(confirm.headers.get("content-type")).toContain("text/html");
    expect(confirm.headers.get("cache-control")).toBe("private, no-store");
    expect(confirm.headers.get("referrer-policy")).toBe("no-referrer");
    const form = await confirm.text();
    expect(form).toContain("이 메일 알림을 끌까요?");
    expect(form).toContain('<form method="post" action="/api/me/notification-settings/unsubscribe?token=');
    expect(await db.select().from(notificationSettings)).toEqual([]);

    const done = await call("POST", token);
    expect(done.status).toBe(200);
    const html = await done.text();
    expect(html).toContain("메일 알림을 껐어요");
    expect(html).toContain("«메이커 답장»");
    expect((await db.select().from(notificationSettings))).toMatchObject([{ userId: reader.id, makerReply: "off", followedProject: "weekly" }]);
    expect((await call("POST", token)).status).toBe(200);
  });

  it("주간 요약 열쇠는 주간 칸을 모두 끄고, POST 한 번 끄기도 같다", async () => {
    const { signUnsubscribeToken } = await import("@/lib/me/unsubscribe");
    const reader = await member("읽는이", "hanul@example.com");
    await put(reader.headers, { followedMaker: "weekly", makerReply: "instant" });
    const response = await call("POST", signUnsubscribeToken(reader.id, "weekly"), "en");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Email alert turned off");
    expect((await db.select().from(notificationSettings))[0]).toMatchObject({ makerReply: "instant", followedProject: "off", followedMaker: "off", followedCategory: "off" });
    expect((await call("GET", signUnsubscribeToken(999_999, "news"))).status).toBe(200);
  });
});
