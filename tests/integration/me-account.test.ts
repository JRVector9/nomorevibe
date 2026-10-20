import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { emailLoginChallenges, publicIdentities, publicSessions, publicUsers } from "@/lib/db/public-user-schema";
import { githubAuthFlows, githubUserConnections } from "@/lib/db/github-user-schema";
import { githubProductBindings } from "@/lib/db/github-binding-schema";
import { githubStarOperations } from "@/lib/db/github-star-schema";
import { productFeedback } from "@/lib/db/product-feedback-schema";
import {
  emailOutbox, makerReplies, notifications, notificationSettings, productMakerMembers, productReactions, userFollows, userSavedProducts,
} from "@/lib/db/me-schema";
import { csrfForToken, newPublicSession } from "@/lib/domain/accounts/session";
import type { LoginEmail } from "@/lib/domain/accounts/email-delivery";
import { ensureSchema, resetTables } from "./setup";

/**
 * 마이페이지 계정 탭(MY1) — 닉네임 30일 한도, 기기 목록·로그아웃(남의 세션 id 거절), 내 데이터 받기, 계정 삭제(익명화·연쇄 삭제·다시 로그인·FK).
 * 라우트 처리기를 실제 Request 로 부른다(Origin·CSRF·쿠키까지).
 */
vi.mock("server-only", () => ({}));

const SITE = "https://nomorevibe.example";
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true");
  vi.stubEnv("GITHUB_STAR_ENABLED", "true");
  vi.stubEnv("PUBLIC_AUTH_SECRET", "integration-public-auth-secret-at-least-32-characters");
  vi.stubEnv("GITHUB_INTEGRATION_SECRET", "integration-github-secret-longer-than-32-characters");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  await resetTables();
});
afterEach(() => vi.unstubAllEnvs());

type Login = { token: string; tokenHash: string; cookie: string; csrf: string };
async function user(displayName: string) {
  const [row] = await db.insert(publicUsers).values({ displayName }).returning();
  return row;
}
async function session(userId: number, extra: Partial<typeof publicSessions.$inferInsert> = {}): Promise<Login> {
  const created = newPublicSession();
  await db.insert(publicSessions).values({ tokenHash: created.tokenHash, userId, createdAt: created.createdAt, expiresAt: created.expiresAt, ...extra });
  return { token: created.token, tokenHash: created.tokenHash, cookie: `nmv_user=${created.token}`, csrf: csrfForToken(created.token, "session") };
}
function call(path: string, login: Login | null, init: { method?: string; body?: unknown; origin?: string; csrf?: string | null } = {}) {
  const headers: Record<string, string> = { origin: init.origin ?? SITE };
  if (login) headers.cookie = login.cookie;
  const csrf = init.csrf === undefined ? login?.csrf : init.csrf;
  if (csrf) headers["x-csrf-token"] = csrf;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${SITE}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}
async function product(slug: string) {
  const [row] = await db.insert(products).values({ slug, name: slug.toUpperCase(), url: `https://${slug}.example`, tagline: slug, description: slug,
    category: "Dev", status: "verified", verifyToken: "v", editTokenHash: "e" }).returning();
  return row;
}
const routes = {
  profile: () => import("@/app/api/me/profile/route"),
  sessions: () => import("@/app/api/me/sessions/route"),
  session: () => import("@/app/api/me/sessions/[id]/route"),
  others: () => import("@/app/api/me/sessions/revoke-others/route"),
  exportData: () => import("@/app/api/me/export/route"),
  remove: () => import("@/app/api/me/delete/route"),
  summary: () => import("@/app/api/me/summary/route"),
};
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("닉네임 바꾸기 — PATCH /api/me/profile", () => {
  it("바꾸면 다음 변경일이 30일 뒤, 그 안에는 409 이고 이름은 그대로다", async () => {
    const { PATCH } = await routes.profile();
    const reader = await user("참여자-1234");
    const login = await session(reader.id);
    const first = await PATCH(call("/api/me/profile", login, { method: "PATCH", body: { displayName: "  하늘   코더 " } }));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    const body = await first.json();
    expect(body.displayName).toBe("하늘 코더");
    const days = (Date.parse(body.nextNameChangeAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);

    const again = await PATCH(call("/api/me/profile", login, { method: "PATCH", body: { displayName: "다른 이름" } }));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "display_name_change_limited" });
    // 같은 이름은 한도를 쓰지 않고 그대로 돌려준다
    const same = await PATCH(call("/api/me/profile", login, { method: "PATCH", body: { displayName: "하늘 코더" } }));
    expect(same.status).toBe(200);
    const [stored] = await db.select().from(publicUsers).where(eq(publicUsers.id, reader.id));
    expect(stored.displayName).toBe("하늘 코더");

    // 30일이 지나면 다시 바꿀 수 있다
    await db.update(publicUsers).set({ displayNameChangedAt: sql`now() - interval '31 days'` }).where(eq(publicUsers.id, reader.id));
    const later = await PATCH(call("/api/me/profile", login, { method: "PATCH", body: { displayName: "다른 이름" } }));
    expect(later.status).toBe(200);
    expect((await later.json()).displayName).toBe("다른 이름");
  });

  it("두 요청이 겹쳐도 한 번만 바뀐다", async () => {
    const { PATCH } = await routes.profile();
    const reader = await user("참여자-race");
    const login = await session(reader.id);
    const results = await Promise.all(["이름하나", "이름둘", "이름셋"].map((displayName) => PATCH(call("/api/me/profile", login, { method: "PATCH", body: { displayName } }))));
    expect(results.map((response) => response.status).sort()).toEqual([200, 409, 409]);
  });

  it("모양이 틀린 이름·예약어·Origin·CSRF·로그인 없음은 거절하고 바꾸지 않는다", async () => {
    const { PATCH } = await routes.profile();
    const reader = await user("참여자-guard");
    const login = await session(reader.id);
    const status = async (request: Request) => (await PATCH(request)).status;
    expect(await status(call("/api/me/profile", login, { method: "PATCH", body: { displayName: "a" } }))).toBe(400);
    expect(await status(call("/api/me/profile", login, { method: "PATCH", body: { displayName: "zero​width" } }))).toBe(400);
    expect(await status(call("/api/me/profile", login, { method: "PATCH", body: { displayName: "탈퇴한 사용자" } }))).toBe(400);
    expect(await status(call("/api/me/profile", login, { method: "PATCH", body: { displayName: "관리자" } }))).toBe(400);
    expect(await status(call("/api/me/profile", login, { method: "PATCH", body: { displayName: "좋은이름" }, origin: "https://evil.example" }))).toBe(403);
    expect(await status(call("/api/me/profile", login, { method: "PATCH", body: { displayName: "좋은이름" }, csrf: "forged" }))).toBe(403);
    expect(await status(call("/api/me/profile", null, { method: "PATCH", body: { displayName: "좋은이름" } }))).toBe(401);
    const [stored] = await db.select().from(publicUsers).where(eq(publicUsers.id, reader.id));
    expect(stored).toMatchObject({ displayName: "참여자-guard", displayNameChangedAt: null });
  });
});

describe("로그인된 기기 — GET·DELETE /api/me/sessions", () => {
  async function devices() {
    const owner = await user("주인");
    const stranger = await user("남");
    const current = await session(owner.id, { provider: "github", deviceLabel: "Mac · Chrome", lastSeenAt: new Date() });
    const phone = await session(owner.id, { provider: "email", deviceLabel: "iPhone · Safari" });
    const old = await session(owner.id, { deviceLabel: "Windows · Edge" });
    const revoked = await session(owner.id, { revokedAt: new Date() });
    const theirs = await session(stranger.id, { deviceLabel: "Android · Chrome" });
    return { owner, stranger, current, phone, old, revoked, theirs };
  }

  it("내 살아 있는 세션만, 지금 기기를 먼저, 해시 없이 16자 id 로 보인다", async () => {
    const { GET } = await routes.sessions();
    const { current, phone, old, revoked, theirs } = await devices();
    const response = await GET(call("/api/me/sessions", current));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const { sessions } = await response.json();
    expect(sessions.map((row: { id: string }) => row.id)).toEqual([current.tokenHash.slice(0, 16), expect.any(String), expect.any(String)]);
    expect(sessions[0]).toMatchObject({ current: true, provider: "github", deviceLabel: "Mac · Chrome" });
    expect(sessions.filter((row: { current: boolean }) => row.current)).toHaveLength(1);
    expect(new Set(sessions.map((row: { id: string }) => row.id))).toEqual(new Set([current, phone, old].map((login) => login.tokenHash.slice(0, 16))));
    const text = JSON.stringify(sessions);
    for (const login of [current, phone, old, revoked, theirs]) {
      expect(text).not.toContain(login.tokenHash);
      expect(text).not.toContain(login.token);
    }
    expect(text).not.toContain(theirs.tokenHash.slice(0, 16));
    expect(text).not.toContain(revoked.tokenHash.slice(0, 16));
  });

  it("남의 세션 id·모양이 틀린 id 는 404 이고 아무것도 끊지 않는다", async () => {
    const { DELETE } = await routes.session();
    const auth = await import("@/lib/domain/accounts/request-auth");
    const { current, theirs } = await devices();
    for (const id of [theirs.tokenHash.slice(0, 16), theirs.tokenHash, "ZZZZ", "0".repeat(16)]) {
      const response = await DELETE(call(`/api/me/sessions/${id}`, current, { method: "DELETE" }), params(id));
      expect(response.status).toBe(404);
    }
    expect(await auth.getPublicSession(new Request(SITE, { headers: { cookie: theirs.cookie } }))).not.toBeNull();
    expect(await db.select().from(publicSessions).where(isNull(publicSessions.revokedAt))).toHaveLength(4);
  });

  it("다른 기기 하나를 끊으면 그 토큰만 죽는다. CSRF·Origin 이 틀리면 거절", async () => {
    const { DELETE } = await routes.session();
    const auth = await import("@/lib/domain/accounts/request-auth");
    const { current, phone, old } = await devices();
    const id = phone.tokenHash.slice(0, 16);
    expect((await DELETE(call(`/api/me/sessions/${id}`, current, { method: "DELETE", csrf: phone.csrf }), params(id))).status).toBe(403);
    expect((await DELETE(call(`/api/me/sessions/${id}`, current, { method: "DELETE", origin: "https://evil.example" }), params(id))).status).toBe(403);
    const response = await DELETE(call(`/api/me/sessions/${id}`, current, { method: "DELETE" }), params(id));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, current: false });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await auth.getPublicSession(new Request(SITE, { headers: { cookie: phone.cookie } }))).toBeNull();
    expect(await auth.getPublicSession(new Request(SITE, { headers: { cookie: old.cookie } }))).not.toBeNull();
    expect(await auth.getPublicSession(new Request(SITE, { headers: { cookie: current.cookie } }))).not.toBeNull();
    // 이미 끊은 세션은 다시 끊지 못한다
    expect((await DELETE(call(`/api/me/sessions/${id}`, current, { method: "DELETE" }), params(id))).status).toBe(404);
  });

  it("지금 기기를 끊으면 쿠키도 지운다", async () => {
    const { DELETE } = await routes.session();
    const { current } = await devices();
    const id = current.tokenHash.slice(0, 16);
    const response = await DELETE(call(`/api/me/sessions/${id}`, current, { method: "DELETE" }), params(id));
    expect(await response.json()).toEqual({ ok: true, current: true });
    expect(response.headers.get("set-cookie")).toMatch(/nmv_user=;.*Max-Age=0/);
  });

  it("다른 기기 모두 로그아웃 — 지금 기기와 남의 세션은 남는다", async () => {
    const { POST } = await routes.others();
    const auth = await import("@/lib/domain/accounts/request-auth");
    const { current, phone, old, theirs } = await devices();
    expect((await POST(call("/api/me/sessions/revoke-others", current, { method: "POST", csrf: null }))).status).toBe(403);
    const response = await POST(call("/api/me/sessions/revoke-others", current, { method: "POST" }));
    expect(await response.json()).toEqual({ ok: true, revoked: 2 });
    for (const login of [phone, old]) expect(await auth.getPublicSession(new Request(SITE, { headers: { cookie: login.cookie } }))).toBeNull();
    for (const login of [current, theirs]) expect(await auth.getPublicSession(new Request(SITE, { headers: { cookie: login.cookie } }))).not.toBeNull();
  });

  it("마지막 사용일은 하루 한 번만 고친다", async () => {
    const auth = await import("@/lib/domain/accounts/request-auth");
    const reader = await user("하루");
    const stale = await session(reader.id, { lastSeenAt: new Date(Date.now() - 2 * 86_400_000) });
    const fresh = await session(reader.id, { lastSeenAt: new Date(Date.now() - 3_600_000) });
    await auth.getPublicSession(new Request(SITE, { headers: { cookie: stale.cookie } }));
    await auth.getPublicSession(new Request(SITE, { headers: { cookie: fresh.cookie } }));
    const rows = await db.select().from(publicSessions);
    const seen = (login: Login) => rows.find((row) => row.tokenHash === login.tokenHash)!.lastSeenAt!.getTime();
    expect(Date.now() - seen(stale)).toBeLessThan(60_000);
    expect(Date.now() - seen(fresh)).toBeGreaterThan(3_000_000);
  });

  it("로그인할 때 수단·기기 이름·마지막 사용일을 적고, User-Agent 원문은 남기지 않는다", async () => {
    const login = await import("@/lib/domain/accounts/email-login");
    const verify = await import("@/app/api/auth/user/email/verify/route");
    const messages: LoginEmail[] = [];
    const browserNonce = newPublicSession().token;
    const started = await login.startEmailLogin({ email: "reader@example.com", browserNonce, ip: "192.0.2.1" }, async (email) => { messages.push(email); return "accepted"; });
    const response = await verify.POST(new Request(`${SITE}/api/auth/user/email/verify`, { method: "POST", body: JSON.stringify({ challengeId: started.challengeId, code: messages[0].code }),
      headers: { origin: SITE, cookie: `nmv_login_nonce=${browserNonce}`, "content-type": "application/json", "x-csrf-token": csrfForToken(browserNonce, "login"), "user-agent": MAC_CHROME } }));
    expect(response.status).toBe(200);
    const [stored] = await db.select().from(publicSessions);
    expect(stored).toMatchObject({ provider: "email", deviceLabel: "Mac · Chrome" });
    expect(stored.lastSeenAt).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain("AppleWebKit");
    const [identity] = await db.select().from(publicIdentities);
    expect(identity.lastUsedAt).not.toBeNull();

    // GitHub 로그인은 표시용 login 을 적고, 이름이 바뀌면 다음 로그인 때 고친다
    const github = await import("@/lib/domain/github-user/repository");
    const tokens = { accessToken: `ghu_${"a".repeat(40)}`, refreshToken: `ghr_${"b".repeat(40)}`, accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: new Date(Date.now() + 7_200_000) };
    const first = await github.saveGithubUserConnection({ actorUserId: null, githubUser: { id: 4242, login: "hanulcoder" }, tokens, deviceLabel: "iPhone · Safari" });
    await github.saveGithubUserConnection({ actorUserId: null, githubUser: { id: 4242, login: "hanul-renamed" }, tokens, deviceLabel: null });
    const [gh] = await db.select().from(publicIdentities).where(eq(publicIdentities.provider, "github"));
    expect(gh).toMatchObject({ userId: first.user.id, providerLogin: "hanul-renamed" });
    const ghSessions = await db.select().from(publicSessions).where(eq(publicSessions.userId, first.user.id));
    expect(ghSessions.map((row) => [row.provider, row.deviceLabel]).sort()).toEqual([["github", null], ["github", "iPhone · Safari"]]);
  });
});

/** 계정 둘에 표마다 한 줄씩 — 지울 사람(alice)과 남아야 할 사람(bob) */
async function seedAccount(name: string, githubId: number, email: string) {
  const owner = await user(name);
  const tool = await product(`${name}-tool`);
  const [emailIdentity] = await db.insert(publicIdentities).values({ userId: owner.id, provider: "email", subject: email }).returning();
  await db.insert(publicIdentities).values({ userId: owner.id, provider: "github", subject: String(githubId), providerLogin: `${name}-gh` });
  await db.insert(githubUserConnections).values({ userId: owner.id, githubUserId: githubId, githubLogin: `${name}-gh`, state: "active",
    encryptedAccessToken: `sealed-access-${name}`, encryptedRefreshToken: `sealed-refresh-${name}` });
  await db.insert(githubAuthFlows).values({ id: crypto.randomUUID(), purpose: "star", actorUserId: owner.id, stateHash: String(githubId % 10).repeat(64), browserNonceHash: "b".repeat(64),
    encryptedPkceVerifier: `sealed-pkce-${name}`, expiresAt: new Date(Date.now() + 600_000) });
  await db.insert(githubStarOperations).values({ userId: owner.id, repositoryId: githubId, productId: tool.id, productRepoUrl: `https://github.com/${name}/tool` });
  await db.insert(emailLoginChallenges).values({ id: crypto.randomUUID(), email, codeHash: "c".repeat(64), browserNonceHash: "d".repeat(64), expiresAt: new Date(Date.now() + 600_000) });
  await db.insert(userSavedProducts).values({ userId: owner.id, productId: tool.id });
  await db.insert(userFollows).values({ userId: owner.id, targetType: "product", targetKey: String(tool.id) });
  await db.insert(notifications).values({ userId: owner.id, kind: "maker_reply", productId: tool.id, dedupeKey: `reply:${name}` });
  await db.insert(notificationSettings).values({ userId: owner.id, emailIdentityId: emailIdentity.id });
  await db.insert(emailOutbox).values({ userId: owner.id, kind: "maker_reply", dedupeKey: `mail:${name}`, payload: { to: email } });
  await db.insert(productMakerMembers).values({ productId: tool.id, userId: owner.id, role: "owner", method: "github_repo_owner", githubUserId: githubId });
  const [anonymous] = await db.insert(productReactions).values({ productId: tool.id, userId: owner.id, visitorHash: "e".repeat(63) + String(githubId % 10), verdict: "good", source: "panel", locale: "ko", comment: "좋아요", commentState: "accepted" }).returning();
  const other = await product(`${name}-other`);
  const [accountOnly] = await db.insert(productReactions).values({ productId: other.id, userId: owner.id, verdict: "bad", source: "me", locale: "ko" }).returning();
  await db.insert(makerReplies).values({ productId: other.id, targetType: "reaction", targetId: accountOnly.id, authorUserId: owner.id, body: "답장" });
  const [feedback] = await db.insert(productFeedback).values({ productId: tool.id, authorUserId: owner.id, requestId: crypto.randomUUID(), requestHash: "f".repeat(64),
    normalizedBodyHash: "f".repeat(64), kind: "question", title: `${name} 질문`, body: `${name} 본문`, serviceDisclosureConsent: true, reviewState: "accepted" }).returning();
  const [reply] = await db.insert(makerReplies).values({ productId: tool.id, targetType: "feedback", targetId: feedback.id, authorUserId: owner.id, body: `${name}의 메이커 답장` }).returning();
  await db.insert(githubProductBindings).values({ productId: tool.id, repositoryId: githubId, repositoryFullName: `${name}/tool`, repositoryUrl: `https://github.com/${name}/tool`,
    productRepoUrl: `https://github.com/${name}/tool`, installationId: githubId, consentedByUserId: owner.id });
  const login = await session(owner.id, { provider: "github", deviceLabel: "Mac · Chrome" });
  const second = await session(owner.id, { provider: "email" });
  return { owner, tool, other, login, second, anonymous, accountOnly, feedback, reply };
}

const countFor = async (userId: number) => ({
  identities: (await db.select().from(publicIdentities).where(eq(publicIdentities.userId, userId))).length,
  sessions: (await db.select().from(publicSessions).where(eq(publicSessions.userId, userId))).length,
  github: (await db.select().from(githubUserConnections).where(eq(githubUserConnections.userId, userId))).length,
  flows: (await db.select().from(githubAuthFlows).where(eq(githubAuthFlows.actorUserId, userId))).length,
  stars: (await db.select().from(githubStarOperations).where(eq(githubStarOperations.userId, userId))).length,
  saved: (await db.select().from(userSavedProducts).where(eq(userSavedProducts.userId, userId))).length,
  follows: (await db.select().from(userFollows).where(eq(userFollows.userId, userId))).length,
  notifications: (await db.select().from(notifications).where(eq(notifications.userId, userId))).length,
  settings: (await db.select().from(notificationSettings).where(eq(notificationSettings.userId, userId))).length,
  outbox: (await db.select().from(emailOutbox).where(eq(emailOutbox.userId, userId))).length,
  makers: (await db.select().from(productMakerMembers).where(eq(productMakerMembers.userId, userId))).length,
  reactions: (await db.select().from(productReactions).where(eq(productReactions.userId, userId))).length,
});

describe("내 데이터 받기 — GET /api/me/export", () => {
  it("내 것만 JSON 파일로, 토큰·해시·암호화 값 없이. 하루 2번", async () => {
    const { GET } = await routes.exportData();
    const alice = await seedAccount("alice", 101, "alice@example.com");
    const bob = await seedAccount("bob", 202, "bob@example.com");
    const response = await GET(call("/api/me/export", alice.login));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="nomorevibe-my-data-\d{8}\.json"$/);
    const text = await response.text();
    const data = JSON.parse(text);
    expect(data.profile.displayName).toBe("alice");
    expect(data.identities).toEqual([
      expect.objectContaining({ provider: "email", email: "alice@example.com" }),
      expect.objectContaining({ provider: "github", subject: "101", login: "alice-gh" }),
    ]);
    expect(data.githubStarConnection).toMatchObject({ login: "alice-gh", state: "active" });
    expect(data.sessions).toHaveLength(2);
    expect(data.saved).toEqual([expect.objectContaining({ slug: "alice-tool" })]);
    expect(data.reactions).toHaveLength(2);
    expect(data.feedback).toEqual([expect.objectContaining({ title: "alice 질문", body: "alice 본문" })]);
    expect(data.makerReplies).toHaveLength(2);
    expect(data.follows).toHaveLength(1);
    expect(data.notifications).toHaveLength(1);
    expect(data.notificationSettings).toMatchObject({ makerReply: "instant" });
    expect(data.notificationSettings).not.toHaveProperty("emailIdentityId");
    expect(data.makerMemberships).toEqual([expect.objectContaining({ slug: "alice-tool", role: "owner" })]);
    for (const secret of [alice.login.tokenHash, alice.second.tokenHash, alice.login.token, "sealed-access-alice", "sealed-refresh-alice", "sealed-pkce-alice", "bob", bob.login.tokenHash]) {
      expect(text).not.toContain(secret);
    }
    expect((await GET(call("/api/me/export", alice.login))).status).toBe(200);
    const limited = await GET(call("/api/me/export", alice.login));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "export_rate_limited" });
    expect((await GET(call("/api/me/export", null))).status).toBe(401);
  });
});

describe("계정 삭제 — POST /api/me/delete", () => {
  it("닉네임이 맞지 않으면 아무것도 지우지 않는다", async () => {
    const { POST } = await routes.remove();
    const alice = await seedAccount("alice", 101, "alice@example.com");
    const before = await countFor(alice.owner.id);
    for (const confirm of ["", "Alice", "bob", 1, undefined]) {
      const response = await POST(call("/api/me/delete", alice.login, { method: "POST", body: { confirm } }));
      expect(response.status).toBe(400);
    }
    expect((await POST(call("/api/me/delete", alice.login, { method: "POST", body: { confirm: "alice" }, csrf: "forged" }))).status).toBe(403);
    expect((await POST(call("/api/me/delete", alice.login, { method: "POST", body: { confirm: "alice" }, origin: "https://evil.example" }))).status).toBe(403);
    expect(await countFor(alice.owner.id)).toEqual(before);
    const [stored] = await db.select().from(publicUsers).where(eq(publicUsers.id, alice.owner.id));
    expect(stored).toMatchObject({ displayName: "alice", deletedAt: null });
  });

  it("한 번에 익명화하고 개인 행을 지운다 — 공개 의견·답장·FK 행은 남고, 다른 계정은 그대로다", async () => {
    const { POST } = await routes.remove();
    const auth = await import("@/lib/domain/accounts/request-auth");
    const { getFeedback } = await import("@/lib/domain/feedback/repository");
    const alice = await seedAccount("alice", 101, "alice@example.com");
    const bob = await seedAccount("bob", 202, "bob@example.com");
    const bobBefore = await countFor(bob.owner.id);
    // 공개되지 않은 의견(보류)과 거기 달린 답장, 내가 쓴 보류 답장은 남기지 않는다
    const [held] = await db.insert(productFeedback).values({ productId: bob.tool.id, authorUserId: alice.owner.id, requestId: crypto.randomUUID(), requestHash: "2".repeat(64),
      normalizedBodyHash: "2".repeat(64), kind: "bug", title: "연락처 적은 글", body: "010-0000-0000", serviceDisclosureConsent: true, reviewState: "held" }).returning();
    await db.insert(makerReplies).values({ productId: bob.tool.id, targetType: "feedback", targetId: held.id, authorUserId: bob.owner.id, body: "보류 글 답장" });
    const [heldReply] = await db.insert(makerReplies).values({ productId: bob.tool.id, targetType: "reaction", targetId: bob.anonymous.id, authorUserId: alice.owner.id,
      body: "보류된 내 답장", reviewState: "held" }).returning();

    const response = await POST(call("/api/me/delete", alice.login, { method: "POST", body: { confirm: " alice " } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("set-cookie")).toMatch(/nmv_user=;.*Max-Age=0/);

    const [stored] = await db.select().from(publicUsers).where(eq(publicUsers.id, alice.owner.id));
    expect(stored.displayName).toBe("탈퇴한 사용자");
    expect(stored.deletedAt).not.toBeNull();
    expect(await countFor(alice.owner.id)).toEqual({ identities: 0, sessions: 0, github: 0, flows: 0, stars: 0, saved: 0, follows: 0, notifications: 0, settings: 0, outbox: 0, makers: 0, reactions: 0 });
    expect(await db.select().from(emailLoginChallenges).where(eq(emailLoginChallenges.email, "alice@example.com"))).toHaveLength(0);
    // 써봤어요는 이 브라우저 열쇠가 있어도 모두 지운다(공용 PC 쿠키로 다시 읽히지 않게) — 그 답장도
    expect(await db.select().from(productReactions).where(eq(productReactions.id, alice.anonymous.id))).toHaveLength(0);
    expect(await db.select().from(productReactions).where(eq(productReactions.id, alice.accountOnly.id))).toHaveLength(0);
    expect(await db.select().from(makerReplies).where(eq(makerReplies.targetId, alice.accountOnly.id))).toHaveLength(0);
    // 공개 의견·메이커 답장·저장소 연결 동의는 남고, 작성자는 익명으로 보인다
    expect(await getFeedback(alice.feedback.id)).toMatchObject({ authorUserId: alice.owner.id, authorDisplayName: "탈퇴한 사용자", body: "alice 본문" });
    expect(await db.select().from(makerReplies).where(eq(makerReplies.id, alice.reply.id))).toHaveLength(1);
    expect(await db.select().from(productFeedback).where(eq(productFeedback.id, held.id))).toHaveLength(0);
    expect(await db.select().from(makerReplies).where(eq(makerReplies.targetId, held.id))).toHaveLength(0);
    expect(await db.select().from(makerReplies).where(eq(makerReplies.id, heldReply.id))).toHaveLength(0);
    expect(await db.select().from(githubProductBindings).where(eq(githubProductBindings.consentedByUserId, alice.owner.id))).toHaveLength(1);

    // 옛 쿠키는 어디서도 통하지 않는다
    for (const login of [alice.login, alice.second]) {
      expect(await auth.getPublicSession(new Request(SITE, { headers: { cookie: login.cookie } }))).toBeNull();
    }
    const { GET } = await routes.summary();
    expect(await (await GET(call("/api/me/summary", alice.login))).json()).toMatchObject({ user: null, csrfToken: null });
    expect((await POST(call("/api/me/delete", alice.login, { method: "POST", body: { confirm: "탈퇴한 사용자" } }))).status).toBe(401);

    // 다른 계정은 한 줄도 바뀌지 않는다
    expect(await countFor(bob.owner.id)).toEqual(bobBefore);
    expect(await auth.getPublicSession(new Request(SITE, { headers: { cookie: bob.login.cookie } }))).not.toBeNull();
  });

  it("같은 GitHub·이메일로 다시 로그인하면 새 계정이 생긴다", async () => {
    const { POST } = await routes.remove();
    const alice = await seedAccount("alice", 101, "alice@example.com");
    expect((await POST(call("/api/me/delete", alice.login, { method: "POST", body: { confirm: "alice" } }))).status).toBe(200);

    const github = await import("@/lib/domain/github-user/repository");
    const tokens = { accessToken: `ghu_${"a".repeat(40)}`, refreshToken: `ghr_${"b".repeat(40)}`, accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: new Date(Date.now() + 7_200_000) };
    const again = await github.saveGithubUserConnection({ actorUserId: null, githubUser: { id: 101, login: "alice-gh" }, tokens });
    expect(again.user.id).not.toBe(alice.owner.id);
    expect(again.user.displayName).toMatch(/^참여자-/);

    const login = await import("@/lib/domain/accounts/email-login");
    const messages: LoginEmail[] = [];
    const browserNonce = newPublicSession().token;
    const started = await login.startEmailLogin({ email: "alice@example.com", browserNonce, ip: "192.0.2.9" }, async (email) => { messages.push(email); return "accepted"; });
    const byEmail = await login.verifyEmailLogin({ challengeId: started.challengeId, code: messages[0].code, browserNonce });
    expect(byEmail.user.id).not.toBe(alice.owner.id);
    expect(byEmail.user.id).not.toBe(again.user.id);
    expect(await db.select().from(publicSessions).where(eq(publicSessions.userId, alice.owner.id))).toHaveLength(0);
  });

  it("탈퇴한 계정에는 어떤 길로도 세션이 붙지 않는다", async () => {
    const { POST } = await routes.remove();
    const auth = await import("@/lib/domain/accounts/request-auth");
    const alice = await seedAccount("alice", 101, "alice@example.com");
    expect((await POST(call("/api/me/delete", alice.login, { method: "POST", body: { confirm: "alice" } }))).status).toBe(200);
    // 삭제와 겹쳐 남은 세션(경합)도 읽지 않는다
    const leftover = await session(alice.owner.id);
    expect(await auth.getPublicSession(new Request(SITE, { headers: { cookie: leftover.cookie } }))).toBeNull();
    // 로그인한 채 GitHub 을 잇는 흐름도 탈퇴한 계정이면 거절한다
    const github = await import("@/lib/domain/github-user/repository");
    const tokens = { accessToken: `ghu_${"a".repeat(40)}`, refreshToken: `ghr_${"b".repeat(40)}`, accessExpiresAt: new Date(Date.now() + 3_600_000), refreshExpiresAt: new Date(Date.now() + 7_200_000) };
    await expect(github.saveGithubUserConnection({ actorUserId: alice.owner.id, githubUser: { id: 909, login: "late" }, tokens })).rejects.toMatchObject({ status: 401 });
    // 삭제가 신원을 지우기 전에 읽은 이메일 로그인(경합)도 탈퇴한 계정에는 세션을 만들지 않는다
    await db.insert(publicIdentities).values({ userId: alice.owner.id, provider: "email", subject: "race@example.com" });
    const login = await import("@/lib/domain/accounts/email-login");
    const messages: LoginEmail[] = [];
    const browserNonce = newPublicSession().token;
    const started = await login.startEmailLogin({ email: "race@example.com", browserNonce, ip: "192.0.2.9" }, async (email) => { messages.push(email); return "accepted"; });
    await expect(login.verifyEmailLogin({ challengeId: started.challengeId, code: messages[0].code, browserNonce })).rejects.toMatchObject({ status: 401 });
    expect(await db.select().from(publicSessions).where(and(eq(publicSessions.userId, alice.owner.id), isNull(publicSessions.revokedAt)))).toHaveLength(1);
  });

  it("삭제 뒤 남은 요청은 거절되고, 닉네임 바꾸기와 겹쳐도 결과는 둘 중 하나로 맞는다", async () => {
    const remove = await routes.remove();
    const profile = await routes.profile();
    const exportData = await routes.exportData();
    const alice = await seedAccount("alice", 101, "alice@example.com");
    const [deleted, renamed] = await Promise.all([
      remove.POST(call("/api/me/delete", alice.login, { method: "POST", body: { confirm: "alice" } })),
      profile.PATCH(call("/api/me/profile", alice.second, { method: "PATCH", body: { displayName: "새이름" } })),
    ]);
    const [stored] = await db.select().from(publicUsers).where(eq(publicUsers.id, alice.owner.id));
    // 이름이 먼저 바뀌었으면 확인 글자가 맞지 않아 삭제하지 않는다. 삭제가 먼저면 바꾸기는 로그인 없음
    if (deleted.status === 200) expect(stored).toMatchObject({ displayName: "탈퇴한 사용자", deletedAt: expect.any(Date) });
    else expect([deleted.status, renamed.status, stored.displayName, stored.deletedAt]).toEqual([400, 200, "새이름", null]);

    const bob = await seedAccount("bob", 202, "bob@example.com");
    expect((await remove.POST(call("/api/me/delete", bob.login, { method: "POST", body: { confirm: "bob" } }))).status).toBe(200);
    expect((await profile.PATCH(call("/api/me/profile", bob.second, { method: "PATCH", body: { displayName: "되살리기" } }))).status).toBe(401);
    expect((await exportData.GET(call("/api/me/export", bob.second))).status).toBe(401);
    const [gone] = await db.select().from(publicUsers).where(eq(publicUsers.id, bob.owner.id));
    expect(gone.displayName).toBe("탈퇴한 사용자");
  });
});

describe("머리 숫자·의견 탭", () => {
  it("GET /api/me/summary — 내 표의 개수와 수단, 메이커 여부. 로그아웃이면 user: null", async () => {
    const { GET } = await routes.summary();
    const alice = await seedAccount("alice", 101, "alice@example.com");
    await seedAccount("bob", 202, "bob@example.com");
    const response = await GET(call("/api/me/summary", alice.login));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      user: { id: alice.owner.id, displayName: "alice", createdAt: expect.any(String) },
      counts: { saved: 1, tried: 2, opinions: 1, following: 1, unreadAlerts: 1 },
      isMaker: true,
      providers: [{ provider: "github", login: "alice-gh" }, { provider: "email", login: null }],
      csrfToken: alice.login.csrf,
    });
    await db.update(productMakerMembers).set({ revokedAt: new Date() }).where(eq(productMakerMembers.userId, alice.owner.id));
    await db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.userId, alice.owner.id));
    expect(await (await GET(call("/api/me/summary", alice.login))).json()).toMatchObject({ isMaker: false, counts: { unreadAlerts: 0 } });
    expect(await (await GET(call("/api/me/summary", null))).json()).toEqual({ user: null, csrfToken: null, counts: null, isMaker: false, providers: [] });
  });

  it("의견 목록 — 내 글만, 공개된 메이커 답장만 붙는다", async () => {
    const { listMyOpinions } = await import("@/lib/me/opinions");
    const alice = await seedAccount("alice", 101, "alice@example.com");
    const bob = await seedAccount("bob", 202, "bob@example.com");
    // bob 의 글에 alice 가 메이커로 답했지만 숨김 — 보이지 않는다
    const [held] = await db.insert(productFeedback).values({ productId: bob.tool.id, authorUserId: alice.owner.id, requestId: crypto.randomUUID(), requestHash: "1".repeat(64),
      normalizedBodyHash: "1".repeat(64), kind: "bug", title: "검토 중 글", body: "링크", serviceDisclosureConsent: true, reviewState: "held" }).returning();
    await db.insert(makerReplies).values({ productId: bob.tool.id, targetType: "feedback", targetId: held.id, authorUserId: bob.owner.id, body: "숨긴 답장", reviewState: "held" });
    const opinions = await listMyOpinions(alice.owner.id);
    expect(opinions.map((item) => item.id).sort()).toEqual([alice.feedback.id, held.id].sort());
    expect(opinions.find((item) => item.id === alice.feedback.id)?.reply).toMatchObject({ body: "alice의 메이커 답장", authorDisplayName: "alice" });
    expect(opinions.find((item) => item.id === held.id)?.reply).toBeNull();
    expect(await listMyOpinions(9_999)).toEqual([]);
  });
});
