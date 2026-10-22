import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, onReplica } from "@/lib/db";
import { ensureSchema, resetTables } from "./setup";
import { emailLoginChallenges, publicIdentities, publicSessions, publicUsers } from "@/lib/db/public-user-schema";
import { csrfForToken, hashSessionToken, newPublicSession } from "@/lib/domain/accounts/session";
import type { LoginEmail } from "@/lib/domain/accounts/email-delivery";

// /api/me 가 머리 값(lib/me/summary → lib/me/saved)을 읽는다 — 서버 전용 표시는 vitest 에서 비운다
vi.mock("server-only", () => ({}));

async function loginModule() {
  const loaded = await import("@/lib/domain/accounts/email-login").catch(() => null);
  expect(loaded, "transactional email login is not implemented").not.toBeNull();
  return loaded!;
}

const messages: LoginEmail[] = [];
async function deliver(email: LoginEmail) {
  messages.push(email);
  return "accepted" as const;
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true");
  vi.stubEnv("PUBLIC_AUTH_SECRET", "integration-public-auth-secret-at-least-32-characters");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://nomorevibe.example");
  await resetTables();
  messages.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

async function challenge(email = "reader@example.com", browserNonce = newPublicSession().token) {
  const loaded = await loginModule();
  const started = await loaded.startEmailLogin({ email, browserNonce, ip: "192.0.2.1", returnTo: "/p/test" }, deliver);
  const message = messages.find((entry) => entry.challengeId === started.challengeId)!;
  return { ...started, browserNonce, code: message.code };
}

describe("email login with the final migrated PostgreSQL schema", () => {
  it("creates a pseudonymous account only after verifying an email and stores no raw OTP/session", async () => {
    const loaded = await loginModule();
    const attempt = await challenge();
    expect(await db.select().from(publicUsers)).toHaveLength(0);
    expect(await db.select().from(publicIdentities)).toHaveLength(0);
    const login = await loaded.verifyEmailLogin(attempt);
    expect(login.user.id).toBeGreaterThan(0);
    expect(login.user.displayName).not.toContain("reader");
    expect(login.returnTo).toBe("/p/test");
    const [stored] = await db.select().from(emailLoginChallenges);
    expect(stored.codeHash).not.toBe(attempt.code);
    expect(stored.consumedAt).not.toBeNull();
    const [session] = await db.select().from(publicSessions);
    expect(session.tokenHash).toBe(hashSessionToken(login.token));
    expect(JSON.stringify(session)).not.toContain(login.token);
    const [identity] = await db.select().from(publicIdentities);
    expect(identity.provider).toBe("email");
    expect(identity.subject).toBe("reader@example.com");
  });

  it("rejects expired challenges without creating an account", async () => {
    const loaded = await loginModule();
    const attempt = await challenge();
    await db.update(emailLoginChallenges).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(emailLoginChallenges.id, attempt.challengeId));
    await expect(loaded.verifyEmailLogin(attempt)).rejects.toMatchObject({ status: 400, code: "invalid_code" });
    expect(await db.select().from(publicUsers)).toHaveLength(0);
  });

  it("persists wrong attempts and makes the fifth failure final", async () => {
    const loaded = await loginModule();
    const attempt = await challenge();
    const wrong = attempt.code === "00000000" ? "11111111" : "00000000";
    for (let count = 0; count < 5; count++) {
      await expect(loaded.verifyEmailLogin({ ...attempt, code: wrong })).rejects.toMatchObject({ code: "invalid_code" });
    }
    const [stored] = await db.select().from(emailLoginChallenges);
    expect(stored.attempts).toBe(5);
    await expect(loaded.verifyEmailLogin(attempt)).rejects.toMatchObject({ code: "invalid_code" });
    expect(await db.select().from(publicSessions)).toHaveLength(0);
  });

  it("allows only one of two concurrent correct OTP consumers to create a session", async () => {
    const loaded = await loginModule();
    const attempt = await challenge();
    const outcomes = await Promise.allSettled([loaded.verifyEmailLogin(attempt), loaded.verifyEmailLogin(attempt)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(await db.select().from(publicSessions)).toHaveLength(1);
    expect(await db.select().from(publicUsers)).toHaveLength(1);
  });

  it("binds challenges to the requesting browser and replaces earlier challenges atomically", async () => {
    const loaded = await loginModule();
    const first = await challenge();
    await expect(loaded.verifyEmailLogin({ ...first, browserNonce: newPublicSession().token })).rejects.toMatchObject({ code: "invalid_code" });
    const second = await challenge();
    await expect(loaded.verifyEmailLogin(first)).rejects.toMatchObject({ code: "invalid_code" });
    expect((await loaded.verifyEmailLogin(second)).user.id).toBeGreaterThan(0);
  });

  it("serializes concurrent replacements so exactly one new challenge remains usable", async () => {
    const loaded = await loginModule();
    const browserNonce = newPublicSession().token;
    const starts = await Promise.all([loaded.startEmailLogin({ email: "same@example.com", browserNonce, ip: "192.0.2.1" }, deliver), loaded.startEmailLogin({ email: "same@example.com", browserNonce, ip: "192.0.2.1" }, deliver)]);
    const outcomes = await Promise.allSettled(starts.map((started) => loaded.verifyEmailLogin({ challengeId: started.challengeId, browserNonce, code: messages.find((email) => email.challengeId === started.challengeId)!.code })));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(publicIdentities)).toHaveLength(1);
  });

  it("shares the email 15-minute rate limit across concurrent starts", async () => {
    const loaded = await loginModule();
    const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => loaded.startEmailLogin({ email: "limited@example.com", browserNonce: newPublicSession().token, ip: "192.0.2.1" }, deliver)));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(3);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 429, code: "login_rate_limited" });
    const rows = await db.execute<{ key: string }>(sql`select key from rate_limits where key like 'public-auth:%'`);
    expect(rows.every((row) => !row.key.includes("limited@example.com") && !row.key.includes("192.0.2.1"))).toBe(true);
  });

  it("enforces the daily email and trusted IP limits on the shared primary database", async () => {
    const loaded = await loginModule();
    const { privateRateKey } = await import("@/lib/domain/accounts/session");
    await db.execute(sql`insert into rate_limits (key, count, reset_at) values (${privateRateKey("email-day", "daily@example.com")}, 10, now() + interval '1 day')`);
    await expect(loaded.startEmailLogin({ email: "daily@example.com", browserNonce: newPublicSession().token, ip: "192.0.2.1" }, deliver)).rejects.toMatchObject({ status: 429 });
    await db.execute(sql`insert into rate_limits (key, count, reset_at) values (${privateRateKey("ip", "192.0.2.2")}, 20, now() + interval '15 minutes')`);
    await expect(loaded.startEmailLogin({ email: "other@example.com", browserNonce: newPublicSession().token, ip: "192.0.2.2" }, deliver)).rejects.toMatchObject({ status: 429 });
    expect(messages).toHaveLength(0);
  });

  it("permits a possibly delivered code but invalidates confirmed mail rejections", async () => {
    const loaded = await loginModule();
    const browserNonce = newPublicSession().token;
    const uncertain = await loaded.startEmailLogin({ email: "uncertain@example.com", browserNonce, ip: "192.0.2.1" }, async (email) => { messages.push(email); return "unknown"; });
    expect((await loaded.verifyEmailLogin({ challengeId: uncertain.challengeId, browserNonce, code: messages[0].code })).user.id).toBeGreaterThan(0);
    await expect(loaded.startEmailLogin({ email: "rejected@example.com", browserNonce, ip: "192.0.2.1" }, async (email) => { messages.push(email); return "rejected"; })).rejects.toMatchObject({ status: 503 });
    await expect(loaded.verifyEmailLogin({ challengeId: messages[1].challengeId, browserNonce, code: messages[1].code })).rejects.toMatchObject({ code: "invalid_code" });
  });

  it("rotates an existing browser session, retrieves on primary, enforces CSRF and revokes on logout", async () => {
    const loaded = await loginModule();
    const auth = await import("@/lib/domain/accounts/request-auth");
    const repository = await import("@/lib/domain/accounts/repository");
    const first = await loaded.verifyEmailLogin(await challenge());
    const next = await challenge();
    const second = await loaded.verifyEmailLogin({ ...next, previousToken: first.token });
    expect(second.user.id).toBe(first.user.id);
    // 처음 확인만 가입(sign_up), 다음부터는 로그인 — 방문 분석이 이 값으로 가른다
    expect([first.created, second.created]).toEqual([true, false]);
    const headers = { cookie: `nmv_user=${second.token}`, origin: "https://nomorevibe.example", "x-csrf-token": csrfForToken(second.token, "session") };
    expect(await onReplica(() => auth.getPublicSession(new Request("https://nomorevibe.example/api/me", { headers })))).toEqual({ user: second.user, csrfToken: second.csrfToken });
    expect(await auth.getPublicSession(new Request("https://nomorevibe.example/api/me", { headers: { cookie: `nmv_user=${first.token}` } }))).toBeNull();
    expect(await auth.requirePublicMutation(new Request("https://nomorevibe.example/api", { method: "POST", headers }))).toEqual(second.user);
    await expect(auth.requirePublicMutation(new Request("https://nomorevibe.example/api", { method: "POST", headers: { ...headers, "x-csrf-token": "forged" } }))).rejects.toMatchObject({ status: 403, code: "invalid_csrf" });
    await repository.revokePublicSession(second.token);
    expect(await auth.getPublicSession(new Request("https://nomorevibe.example/api/me", { headers }))).toBeNull();
  });

  it("treats expired and unknown well-formed session tokens as unauthenticated", async () => {
    const loaded = await loginModule();
    const auth = await import("@/lib/domain/accounts/request-auth");
    const login = await loaded.verifyEmailLogin(await challenge());
    await db.update(publicSessions).set({ expiresAt: new Date(Date.now() - 1_000) });
    for (const token of [login.token, newPublicSession().token]) {
      expect(await auth.getPublicSession(new Request("https://nomorevibe.example/api/me", { headers: { cookie: `nmv_user=${token}` } }))).toBeNull();
    }
  });

  it("verifies through the HTTP handler, exposes only public identity, and leaves admin auth separate", async () => {
    const attempt = await challenge();
    const verify = await import("@/app/api/auth/user/email/verify/route");
    const me = await import("@/app/api/me/route");
    const logout = await import("@/app/api/auth/user/logout/route");
    const request = new Request("https://nomorevibe.example/api/auth/user/email/verify", {
      method: "POST",
      headers: { origin: "https://nomorevibe.example", cookie: `nmv_login_nonce=${attempt.browserNonce}; nmv_admin=unrelated-admin-cookie`, "content-type": "application/json", "x-csrf-token": csrfForToken(attempt.browserNonce, "login") },
      body: JSON.stringify({ challengeId: attempt.challengeId, code: attempt.code }),
    });
    const response = await verify.POST(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ user: { id: expect.any(Number), displayName: expect.any(String) }, csrfToken: expect.any(String), returnTo: "/p/test" });
    expect(JSON.stringify(body)).not.toContain("reader@example.com");
    expect(response.headers.get("set-cookie")).not.toContain("nmv_admin=");
    const token = response.headers.get("set-cookie")!.match(/nmv_user=([^;]+)/)![1];
    const cookie = `nmv_user=${token}`;
    const current = await me.GET(new Request("https://nomorevibe.example/api/me", { headers: { cookie } }));
    expect(await current.json()).toEqual({ user: body.user, csrfToken: body.csrfToken });
    expect(current.headers.get("cache-control")).toBe("private, no-store");
    const refused = await logout.POST(new Request("https://nomorevibe.example/api/auth/user/logout", { method: "POST", headers: { cookie, origin: "https://evil.example", "x-csrf-token": body.csrfToken } }));
    expect(refused.status).toBe(403);
    const loggedOut = await logout.POST(new Request("https://nomorevibe.example/api/auth/user/logout", { method: "POST", headers: { cookie, origin: "https://nomorevibe.example", "x-csrf-token": body.csrfToken } }));
    expect(loggedOut.status).toBe(200);
    expect(loggedOut.headers.get("set-cookie")).toContain("Max-Age=0");
    const after = await me.GET(new Request("https://nomorevibe.example/api/me", { headers: { cookie } }));
    expect(await after.json()).toEqual({ user: null, csrfToken: null });
  });

  it("refuses missing pre-auth CSRF and missing mail configuration before sending or replacing a code", async () => {
    const start = await import("@/app/api/auth/user/email/start/route");
    const existing = await challenge();
    const request = (headers: Record<string, string>) => new Request("https://nomorevibe.example/api/auth/user/email/start", { method: "POST", headers: { origin: "https://nomorevibe.example", "content-type": "application/json", ...headers }, body: JSON.stringify({ email: "reader@example.com" }) });
    expect((await start.POST(request({}))).status).toBe(403);
    vi.stubEnv("LOGIN_EMAIL_API_KEY", "");
    vi.stubEnv("LOGIN_EMAIL_FROM", "");
    expect((await start.POST(request({ cookie: `nmv_login_nonce=${existing.browserNonce}`, "x-csrf-token": csrfForToken(existing.browserNonce, "login") }))).status).toBe(503);
    const [stored] = await db.select().from(emailLoginChallenges);
    expect(stored.consumedAt).toBeNull();
    expect((await (await loginModule()).verifyEmailLogin(existing)).user.id).toBeGreaterThan(0);
  });

  it("renews the same browser nonce for a full OTP lifetime on every successful issuance", async () => {
    const start = await import("@/app/api/auth/user/email/start/route");
    const nonce = newPublicSession().token;
    vi.stubEnv("LOGIN_EMAIL_API_KEY", "resend-local-adapter-key");
    vi.stubEnv("LOGIN_EMAIL_FROM", "login@example.com");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "local-mail-id" })));
    try {
      const response = await start.POST(new Request("https://nomorevibe.example/api/auth/user/email/start", { method: "POST", headers: { origin: "https://nomorevibe.example", cookie: `nmv_login_nonce=${nonce}`, "x-csrf-token": csrfForToken(nonce, "login"), "content-type": "application/json" }, body: JSON.stringify({ email: "fresh-lifetime@example.com" }) }));
      expect(response.status).toBe(202);
      expect(response.headers.get("set-cookie") ?? "").toContain(`nmv_login_nonce=${nonce}`);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=600");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
