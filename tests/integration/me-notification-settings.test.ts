import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, productUpdates } from "@/lib/db/schema";
import { emailOutbox, notificationSettings, notifications, userFollows } from "@/lib/db/me-schema";
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
      emailConfigured: false, emailAddress: "ha•••@example.com", emailAvailable: false,
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
    expect(first.emailIdentityId).toBeNull();
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
  it("«즉시»이고 주소가 있으면 한 줄, 주간·끔·사이트 안 종류·주소 없음이면 넣지 않는다 — 부른 프로세스의 발신 설정은 보지 않는다", async () => {
    const { notify } = await import("@/lib/me/notify");
    const reader = await member("읽는이", "hanul@example.com");
    const noAddress = await member("주소없음");
    const item = await product("one");
    // 발행·수집·maintenance 처럼 LOGIN_EMAIL_* 가 없는 프로세스가 만든 알림도 줄을 세운다(보낼지는 maintenance 가 정한다)
    expect(await notify({ userId: reader.id, kind: "maker_reply", productId: item.id, dedupeKey: "maker_reply:1" })).toBe(true);
    expect((await rows()).map((row) => row.dedupeKey)).toEqual([`email:${reader.id}:maker_reply:1`]);
    await db.delete(emailOutbox);

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
    const { enqueueNotificationEmails } = await outbox();
    expect(await enqueueNotificationEmails([{ id: 1, userId: 999_999, kind: "maker_reply", dedupeKey: "maker_reply:x" }])).toBe(0);
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

  it("팔로·검토 결과·메이커 새 프로젝트 길도 notify 와 같게 «즉시»인 계정만 줄 세운다", async () => {
    const { notifyCommentReviewed, notifyMakerNewProject, notifyNewReleases } = await import("@/lib/me/notifications");
    const instant = await member("즉시", "instant@example.com");
    const weekly = await member("주간", "weekly@example.com");
    const off = await member("끔", "off@example.com");
    const plain = await member("기본값", "plain@example.com");
    const noEmail = await member("주소없음");
    await put(instant.headers, { followedProject: "instant", followedMaker: "instant" });
    await put(weekly.headers, { followedProject: "weekly", followedMaker: "weekly" });
    await put(off.headers, { followedProject: "off", followedMaker: "off" });
    await put(noEmail.headers, { followedProject: "instant", followedMaker: "instant" });
    const [item] = await db.insert(products).values({ slug: "widget", url: "https://widget.example", name: "Widget", tagline: "T", description: "D", category: "other",
      status: "seeded", source: "crawler", repoUrl: "https://github.com/memo-lab/widget", verifyToken: "v", editTokenHash: "e" }).returning();
    const everyone = [instant, weekly, off, plain, noEmail];
    await db.insert(userFollows).values(everyone.flatMap((who) => [
      { userId: who.id, targetType: "product" as const, targetKey: String(item.id) }, { userId: who.id, targetType: "maker" as const, targetKey: "memo-lab" },
    ]));
    const [update] = await db.insert(productUpdates).values({ slug: item.slug, sourceKind: "github_release", dedupeKey: "r1", title: "v1", observedAt: new Date(), publishedAt: new Date() }).returning();

    // 발신 설정이 없는 프로세스(발행·수집)가 넣어도 «즉시»인 계정은 줄을 선다
    expect(await notifyMakerNewProject(item.slug)).toBe(5);
    expect((await rows()).map((row) => [row.userId, row.kind])).toEqual([[instant.id, "maker_new_project"]]);
    await db.delete(notifications);
    await db.delete(emailOutbox);

    expect(await notifyNewReleases(item.id)).toBe(5);
    expect(await notifyMakerNewProject(item.slug)).toBe(5);
    expect(await notifyCommentReviewed({ id: crypto.randomUUID(), productId: item.id, authorUserId: instant.id }, "accepted")).toBe(1);
    const queued = await rows();
    expect(queued.map((row) => [row.userId, row.kind, row.dedupeKey, row.state]).sort()).toEqual([
      [instant.id, "followed_release", `email:${instant.id}:followed_release:${update.id}`, "pending"],
      [instant.id, "maker_new_project", `email:${instant.id}:maker_new_project:${item.id}`, "pending"],
    ].sort());
    const [release] = await db.select().from(notifications).where(and(eq(notifications.userId, instant.id), eq(notifications.kind, "followed_release")));
    expect(queued.find((row) => row.kind === "followed_release")?.payload).toEqual({ notificationId: release.id, setting: "followedProject", product: { slug: "widget", name: "Widget" } });

    // 다시 돌아도 한 줄, 알림 넣기와 같은 lease 쓰기 안에서 발송함이 실패해도 알림은 남는다
    expect(await notifyNewReleases(item.id)).toBe(0);
    await db.delete(notifications);
    await db.delete(emailOutbox);
    await db.execute(sql`ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_test_block CHECK (kind <> 'followed_release') NOT VALID`);
    try {
      expect(await notifyNewReleases(item.id)).toBe(5);
    } finally {
      await db.execute(sql`ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_test_block`);
    }
    expect(await rows()).toEqual([]);
    expect(await db.select().from(notifications)).toHaveLength(5);
  });

  it("탈퇴한 계정에는 줄을 세우지 않는다", async () => {
    configureEmail();
    const { enqueueNotificationEmails } = await outbox();
    const gone = await member("떠난이", "gone@example.com");
    await db.update(publicUsers).set({ deletedAt: new Date() }).where(eq(publicUsers.id, gone.id));
    expect(await enqueueNotificationEmails([{ id: 1, userId: gone.id, kind: "maker_reply", dedupeKey: "maker_reply:1" }])).toBe(0);
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
    // 한 줄에 단 답장(feedbackId 없음)은 써봤어요 탭에서 보인다 — 메일 링크도 알림함과 같은 곳
    expect(body.text).toContain(`${ORIGIN}/me/tried`);
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

  it("보내는 프로세스에 발신 키·끄기 링크 비밀이 없으면 줄을 건드리지 않고 기다리는 수만 세며 네트워크를 부르지 않는다", async () => {
    await queued();
    const network = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", network);
    const { sendPendingEmails } = await outbox();
    vi.stubEnv("LOGIN_EMAIL_API_KEY", "");
    expect(await sendPendingEmails()).toMatchObject({ waiting: 1, skipped: 0, accepted: 0 });
    configureEmail();
    vi.stubEnv("PUBLIC_AUTH_SECRET", "too-short");
    expect(await sendPendingEmails()).toMatchObject({ waiting: 1, skipped: 0, unknown: 0 });
    expect(network).not.toHaveBeenCalled();
    expect((await rows())[0]).toMatchObject({ state: "pending", attempts: 0, lastError: null });
    // 설정을 고치면 그 줄을 그대로 보낸다
    vi.stubEnv("PUBLIC_AUTH_SECRET", SECRET);
    expect(await sendPendingEmails()).toMatchObject({ accepted: 1, waiting: 0 });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("키·도메인·한도 거절(401·403·429)은 시도로 세지 않고 미루며 그 틱을 멈춘다 — 발송함이 rejected 로 비지 않는다", async () => {
    const { reader } = await queued();
    const { notify } = await import("@/lib/me/notify");
    await notify({ userId: reader.id, kind: "maker_reply", dedupeKey: "maker_reply:2" });
    const { sendPendingEmails } = await outbox();
    for (const status of [401, 403, 429]) {
      await db.update(emailOutbox).set({ nextAttemptAt: new Date(Date.now() - 1_000) });
      const refused = vi.fn(async () => new Response("{}", { status }));
      expect(await sendPendingEmails({ fetcher: refused as unknown as typeof fetch }), String(status)).toMatchObject({ deferred: 1, rejected: 0, retry: 0 });
      expect(refused).toHaveBeenCalledTimes(1);
      const states = await rows();
      expect(states.map((row) => [row.state, row.attempts])).toEqual([["pending", 0], ["pending", 0]]);
      const deferred = states.find((row) => row.lastError === "unavailable")!;
      expect(deferred.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    }
    await db.update(emailOutbox).set({ nextAttemptAt: new Date(Date.now() - 1_000) });
    const fetcher = vi.fn(async () => new Response("{}"));
    expect(await sendPendingEmails({ fetcher: fetcher as unknown as typeof fetch })).toMatchObject({ accepted: 2 });
  });

  it("글을 짓지 못하면(DB·문구) 보내지 않았으므로 시도로 세지 않고 미룬다", async () => {
    await queued();
    const fetcher = vi.fn(async () => new Response("{}"));
    const { sendPendingEmails } = await outbox();
    await db.execute(sql`ALTER TABLE notification_settings RENAME COLUMN locale TO locale_test_moved`);
    try {
      for (let round = 0; round < 6; round += 1) {
        await db.update(emailOutbox).set({ nextAttemptAt: new Date(Date.now() - 1_000) });
        expect(await sendPendingEmails({ fetcher: fetcher as unknown as typeof fetch })).toMatchObject({ deferred: 1, unknown: 0 });
      }
    } finally {
      await db.execute(sql`ALTER TABLE notification_settings RENAME COLUMN locale_test_moved TO locale`);
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect((await rows())[0]).toMatchObject({ state: "pending", attempts: 0, lastError: "compose_failed" });
    await db.update(emailOutbox).set({ nextAttemptAt: new Date(Date.now() - 1_000) });
    expect(await sendPendingEmails({ fetcher: fetcher as unknown as typeof fetch })).toMatchObject({ accepted: 1 });
  });

  it("하루 안에 못 보낸 줄은 보내지 않고 닫고, 30일 지난 닫힌 줄은 지운다 — 발신 설정이 없어도", async () => {
    const reader = await member("읽는이", "hanul@example.com");
    const hours = (value: number) => new Date(Date.now() - value * 3_600_000);
    await db.insert(emailOutbox).values([
      { userId: reader.id, kind: "maker_reply", dedupeKey: "fresh", createdAt: hours(1), nextAttemptAt: hours(1) },
      { userId: reader.id, kind: "maker_reply", dedupeKey: "stale-never-sent", createdAt: hours(25), nextAttemptAt: hours(25) },
      { userId: reader.id, kind: "maker_reply", dedupeKey: "stale-maybe-sent", attempts: 2, createdAt: hours(30), nextAttemptAt: hours(29) },
      { userId: reader.id, kind: "maker_reply", dedupeKey: "old-accepted", state: "accepted", createdAt: hours(31 * 24) },
      { userId: reader.id, kind: "weekly_digest", dedupeKey: "old-empty", state: "skipped", createdAt: hours(31 * 24) },
      { userId: reader.id, kind: "weekly_digest", dedupeKey: "recent-empty", state: "skipped", createdAt: hours(29 * 24) },
    ]);
    const { pruneEmailOutbox, sendPendingEmails } = await outbox();
    // 설정을 늦게 켜도 하루 지난 줄은 잡지 않는다
    configureEmail();
    const fetcher = vi.fn(async () => new Response("{}"));
    expect(await sendPendingEmails({ fetcher: fetcher as unknown as typeof fetch })).toMatchObject({ accepted: 1 });
    vi.stubEnv("LOGIN_EMAIL_API_KEY", "");
    expect(await pruneEmailOutbox()).toEqual({ expired: 2, deleted: 2 });
    const byKey = Object.fromEntries((await rows()).map((row) => [row.dedupeKey, [row.state, row.lastError]]));
    expect(byKey).toEqual({
      fresh: ["accepted", null], "stale-never-sent": ["skipped", "expired"], "stale-maybe-sent": ["unknown", "expired"], "recent-empty": ["skipped", null],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const { runJob } = await import("@/lib/jobs/runner");
    const { queueEmailDigests } = await import("@/lib/jobs/me/email");
    await db.update(emailOutbox).set({ createdAt: hours(31 * 24) });
    expect(await runJob("email-weekly-digest", queueEmailDigests)).toMatchObject({ status: "completed" });
    expect(await rows()).toEqual([]);
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

describe("email-outbox-send 시도 상한", () => {
  it("상한까지 시도한 pending 줄은 잡지 않고 unknown 으로 닫는다 — 다른 줄은 그대로 보낸다", async () => {
    configureEmail();
    const reader = await member("읽는이", "hanul@example.com");
    const past = new Date(Date.now() - 60_000);
    await db.insert(emailOutbox).values([
      { userId: reader.id, kind: "maker_reply", dedupeKey: "poison", payload: {}, attempts: 10, nextAttemptAt: past },
      { userId: reader.id, kind: "maker_reply", dedupeKey: "last-try", payload: {}, attempts: 5, nextAttemptAt: past },
      { userId: reader.id, kind: "maker_reply", dedupeKey: "in-flight", payload: {}, attempts: 5, nextAttemptAt: new Date(Date.now() + 60 * 60_000) },
      { userId: reader.id, kind: "maker_reply", dedupeKey: "good", payload: {}, attempts: 0, nextAttemptAt: past },
    ]);
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    const { sendPendingEmails } = await outbox();
    expect(await sendPendingEmails({ fetcher: fetcher as unknown as typeof fetch })).toMatchObject({ accepted: 1, unknown: 2 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const byKey = Object.fromEntries((await rows()).map((row) => [row.dedupeKey, [row.state, row.attempts, row.lastError]]));
    expect(byKey).toEqual({
      poison: ["unknown", 10, "attempts_exhausted"], "last-try": ["unknown", 5, "attempts_exhausted"],
      "in-flight": ["pending", 5, null], good: ["accepted", 1, null],
    });
    expect(await sendPendingEmails({ fetcher: fetcher as unknown as typeof fetch })).toMatchObject({ accepted: 0, unknown: 0 });
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

describe("분야 묶음과 주간 메일 요약", () => {
  it("분야 묶음은 월요일 0시에 들어가 그날 9시 주간 메일에 담긴다", async () => {
    configureEmail();
    const reader = await member("읽는이", "hanul@example.com");
    await db.insert(userFollows).values({ userId: reader.id, targetType: "category", targetKey: "other" });
    await db.insert(products).values({ slug: "fresh", url: "https://fresh.example", name: "Fresh", tagline: "T", description: "D", category: "Other",
      status: "seeded", verifyToken: "v", editTokenHash: "e", createdAt: new Date("2026-10-16T00:00:00Z") });
    const { sendCategoryDigest } = await import("@/lib/jobs/me/notifications");
    const ctx = { cursor: null, save: async () => {}, hasBudget: () => true, log: () => {} };
    await sendCategoryDigest(ctx as never, new Date("2026-10-18T15:30:00Z")); // 월요일 00:30 KST
    expect((await db.select().from(notifications)).map((row) => row.kind)).toEqual(["category_new"]);
    const { queueWeeklyDigests } = await outbox();
    expect(await queueWeeklyDigests({ now: new Date("2026-10-19T00:00:00Z") })).toEqual({ queued: 1, empty: 0 }); // 월요일 09:00 KST
    const [digest] = await rows();
    expect(digest.payload).toEqual({ week: "2026-W43", total: 1, items: [{ kind: "category_new", product: null,
      detail: { categories: [{ category: "other", count: 1 }], total: 1, others: 0 } }] });
    const fetcher = vi.fn(async () => new Response("{}"));
    expect(await (await outbox()).sendPendingEmails({ fetcher: fetcher as unknown as typeof fetch })).toMatchObject({ accepted: 1 });
    const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.text).toContain("팔로한 분야 기타에 새 프로젝트 1개가 올라왔어요.");
    expect(body.text).toContain(`${ORIGIN}/c/other?sort=recent`);
  });

  it("팔로한 프로젝트가 내려간 까닭(내려감·접속 안 됨)을 메일에 싣는다 — 목록에서 내려간 제품은 팔로 탭으로", async () => {
    configureEmail();
    const { notifyFollowers } = await import("@/lib/me/notifications");
    const reader = await member("읽는이", "hanul@example.com");
    await put(reader.headers, { followedProject: "instant", locale: "en" });
    const item = await product("gone");
    await db.insert(userFollows).values({ userId: reader.id, targetType: "product", targetKey: String(item.id) });
    for (const reason of ["removed", "down"]) {
      await notifyFollowers({ targetType: "product", targetKeys: [String(item.id)], kind: "followed_delisted", productId: item.id, payload: { reason }, dedupeKey: `followed_delisted:${reason}` });
    }
    const queuedRows = await rows();
    expect(queuedRows.map((row) => (row.payload.detail as { reason: string }).reason)).toEqual(["removed", "down"]);
    const fetcher = vi.fn(async () => new Response("{}"));
    expect(await (await outbox()).sendPendingEmails({ fetcher: fetcher as unknown as typeof fetch })).toMatchObject({ accepted: 2 });
    const [removed, down] = fetcher.mock.calls.map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string));
    expect(removed.subject).toBe("Removed from the list: Project gone");
    expect(removed.text).toContain(`${ORIGIN}/en/me/following`);
    expect(removed.text).not.toContain(`/p/gone`);
    expect(down.subject).toBe("Temporarily delisted: Project gone");
    expect(down.text).toContain(`${ORIGIN}/en/p/gone`);
  });

  it("주간 요약 알림 수·줄은 계정마다 따로, 고른 주간 종류만 센다", async () => {
    configureEmail();
    const first = await member("첫째", "first@example.com");
    const second = await member("둘째", "second@example.com");
    await put(second.headers, { makerReply: "weekly", followedProject: "off" });
    const item = await product("one");
    const at = new Date("2026-10-18T00:00:00Z");
    await db.insert(notifications).values([
      ...Array.from({ length: 22 }, (_, index) => ({ userId: first.id, kind: "followed_release" as const, productId: item.id, dedupeKey: `r:${index}`, createdAt: new Date(at.getTime() + index * 1_000) })),
      { userId: first.id, kind: "maker_reply", productId: item.id, dedupeKey: "m:1", createdAt: at },
      { userId: second.id, kind: "maker_reply", productId: item.id, dedupeKey: "m:1", createdAt: at },
      { userId: second.id, kind: "followed_release", productId: item.id, dedupeKey: "r:1", createdAt: at },
    ]);
    expect(await (await outbox()).queueWeeklyDigests({ now: new Date("2026-10-19T01:00:00Z") })).toEqual({ queued: 2, empty: 0 });
    const byUser = new Map((await rows()).map((row) => [row.userId, row.payload as { total: number; items: { kind: string }[] }]));
    expect(byUser.get(first.id)!.total).toBe(22);
    expect(byUser.get(first.id)!.items).toHaveLength(20);
    expect(new Set(byUser.get(first.id)!.items.map((entry) => entry.kind))).toEqual(new Set(["followed_release"]));
    expect(byUser.get(second.id)).toMatchObject({ total: 1, items: [{ kind: "maker_reply" }] });
  });
});

describe("GET·POST /api/me/notification-settings/unsubscribe", () => {
  const call = async (method: "GET" | "POST", token: string, lang = "ko") => {
    const handler = (await unsubscribeRoute())[method];
    return handler(new Request(`${ORIGIN}/api/me/notification-settings/unsubscribe?token=${encodeURIComponent(token)}&lang=${lang}`, {
      method, ...(method === "POST" ? { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" } : {}),
    }));
  };
  it("HEAD(링크 검사기·curl -I)는 GET 처리기로 오지만 끄지 않는다", async () => {
    const { signUnsubscribeToken } = await import("@/lib/me/unsubscribe");
    const reader = await member("읽는이", "hanul@example.com");
    // Next 는 HEAD 에 GET 처리기를 쓰고 request.method 는 "HEAD" 그대로다(next/dist/.../auto-implement-methods)
    const head = await (await unsubscribeRoute()).GET(new Request(`${ORIGIN}/api/me/notification-settings/unsubscribe?token=${encodeURIComponent(signUnsubscribeToken(reader.id, "weekly"))}&lang=ko`, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await db.select().from(notificationSettings)).toEqual([]);
  });

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

  it("끄기 링크가 처음 행을 만들면 그 메일의 언어를 적고, 있던 행의 언어는 그대로 둔다", async () => {
    const { signUnsubscribeToken } = await import("@/lib/me/unsubscribe");
    const fresh = await member("새로", "fresh@example.com");
    const known = await member("있던", "known@example.com");
    await put(known.headers, { locale: "zh-Hant" });
    expect((await call("POST", signUnsubscribeToken(fresh.id, "makerReply"), "en")).status).toBe(200);
    expect((await call("POST", signUnsubscribeToken(known.id, "makerReply"), "en")).status).toBe(200);
    const locales = Object.fromEntries((await db.select().from(notificationSettings)).map((row) => [row.userId, [row.locale, row.makerReply]]));
    expect(locales).toEqual({ [fresh.id]: ["en", "off"], [known.id]: ["zh-Hant", "off"] });
  });

  it("탈퇴한 계정(deleted_at)의 끄기 링크는 설정 행을 다시 만들지 않는다 — 설정 저장도 같다", async () => {
    const { signUnsubscribeToken } = await import("@/lib/me/unsubscribe");
    const { saveNotificationSettings } = await import("@/lib/me/notification-settings");
    const gone = await member("떠난이", "gone@example.com");
    await db.update(publicUsers).set({ deletedAt: new Date() }).where(eq(publicUsers.id, gone.id));
    expect((await call("POST", signUnsubscribeToken(gone.id, "makerReply"))).status).toBe(200);
    expect((await call("POST", signUnsubscribeToken(gone.id, "weekly"))).status).toBe(200);
    await saveNotificationSettings(gone.id, { followedProject: "instant" });
    expect(await db.select().from(notificationSettings)).toEqual([]);
  });
});

describe("메일 글의 언어", () => {
  it("이메일 로그인을 마친 화면(돌아갈 주소)의 언어를 적어, 알림 설정을 열지 않은 계정도 그 언어로 받는다", async () => {
    const { startEmailLogin } = await import("@/lib/domain/accounts/email-login");
    const verify = await import("@/app/api/auth/user/email/verify/route");
    const codes: { challengeId: string; code: string }[] = [];
    const login = async (returnTo: string) => {
      const nonce = newPublicSession().token;
      const started = await startEmailLogin({ email: "reader@example.com", browserNonce: nonce, ip: "192.0.2.1", returnTo }, async (email) => { codes.push(email); return "accepted"; });
      const { code } = codes.find((entry) => entry.challengeId === started.challengeId)!;
      const response = await verify.POST(new Request(`${ORIGIN}/api/auth/user/email/verify`, {
        method: "POST", headers: { origin: ORIGIN, cookie: `nmv_login_nonce=${nonce}`, "content-type": "application/json", "x-csrf-token": csrfForToken(nonce, "login") },
        body: JSON.stringify({ challengeId: started.challengeId, code }),
      }));
      expect(response.status).toBe(200);
      return (await response.json()).user.id as number;
    };
    const userId = await login("/en/p/test");
    expect(await db.select({ locale: notificationSettings.locale }).from(notificationSettings)).toEqual([{ locale: "en" }]);
    await db.insert(notifications).values({ userId, kind: "maker_reply", dedupeKey: "maker_reply:1" });
    const { enqueueNotificationEmails, sendPendingEmails } = await outbox();
    const [row] = await db.select().from(notifications);
    expect(await enqueueNotificationEmails([{ id: row.id, userId, kind: "maker_reply", dedupeKey: row.dedupeKey }])).toBe(1);
    configureEmail();
    const fetcher = vi.fn(async () => new Response("{}"));
    expect(await sendPendingEmails({ fetcher: fetcher as unknown as typeof fetch })).toMatchObject({ accepted: 1 });
    const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.subject).toMatch(/^A maker replied/);
    expect(body.headers["List-Unsubscribe"]).toContain("lang=en");
    // 다음 로그인 화면의 언어가 바뀌면 따라간다(한국어는 접두어 없음)
    expect(await login("/p/test")).toBe(userId);
    expect(await db.select({ locale: notificationSettings.locale }).from(notificationSettings)).toEqual([{ locale: "ko" }]);
  });
});
