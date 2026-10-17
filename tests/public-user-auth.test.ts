import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/operations/dr/epoch", async original => ({ ...await original<typeof import("@/lib/operations/dr/epoch")>(), readWriterFence: async () => ({ state: "active" }) })); // PR15e: 웹 쓰기 관문은 dr-web-fence 테스트가 본다(이 fixture 의 요청 흐름 불변)
vi.mock("next/navigation", async () => ({
  ...await vi.importActual<typeof import("next/navigation")>("next/navigation"),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

async function sessionModule() {
  const loaded = await import("@/lib/domain/accounts/session").catch(() => null);
  expect(loaded, "opaque public session helpers are missing").not.toBeNull();
  return loaded!;
}

async function authModule() {
  const loaded = await import("@/lib/domain/accounts/request-auth").catch(() => null);
  expect(loaded, "public request authorization is missing").not.toBeNull();
  return loaded!;
}

beforeEach(() => {
  vi.stubEnv("PUBLIC_AUTH_SECRET", "unit-public-auth-secret-with-more-than-32-characters");
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://nomorevibe.example");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("public account authentication", () => {
  it("provides separate public session and email login security helpers", async () => {
    expect((await sessionModule()).PUBLIC_SESSION_COOKIE).toBe("nmv_user");
  });

  it("generates opaque 32-byte sessions and stores a one-way SHA256 hash", async () => {
    const session = await sessionModule();
    const first = session.newPublicSession();
    const second = session.newPublicSession();
    expect(Buffer.from(first.token, "base64url")).toHaveLength(32);
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.tokenHash).not.toBe(first.token);
    expect(session.hashSessionToken(first.token)).toBe(first.tokenHash);
    expect(first.expiresAt.getTime() - first.createdAt.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    expect(session.publicSessionCookieOptions()).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 30 * 24 * 60 * 60 });
    vi.stubEnv("NODE_ENV", "production");
    expect(session.publicSessionCookieOptions().secure).toBe(true);
  });

  it("uses keyed challenge-specific OTP hashes and independent CSRF nonces", async () => {
    const session = await sessionModule();
    expect(session.newEmailCode()).toMatch(/^\d{8}$/);
    const hash = session.hashEmailCode("challenge-one", "00123456");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(session.hashEmailCode("challenge-two", "00123456")).not.toBe(hash);
    expect(session.matchesSecretHash(hash, session.hashEmailCode("challenge-one", "00123456"))).toBe(true);
    expect(session.matchesSecretHash(hash, "not-a-hash")).toBe(false);
    expect(session.csrfForToken("one", "login")).not.toBe(session.csrfForToken("one", "session"));
    vi.stubEnv("PUBLIC_AUTH_SECRET", "short");
    expect(() => session.hashEmailCode("one", "00123456")).toThrow("public_auth_unconfigured");
  });

  it("normalizes email while rejecting malformed and oversized addresses", async () => {
    const loaded = await import("@/lib/domain/accounts/email-login").catch(() => null);
    expect(loaded, "email validation is missing").not.toBeNull();
    expect(loaded!.normalizeLoginEmail(" Participant@Example.com ")).toBe("participant@example.com");
    for (const email of ["", "a\nb@example.com", "no-at-sign", "a@@example.com", `${"a".repeat(250)}@example.com`]) {
      expect(() => loaded!.normalizeLoginEmail(email)).toThrow("invalid_email");
    }
  });

  it("rejects external or parser-ambiguous return URLs", async () => {
    const auth = await authModule();
    expect(auth.safeReturnUrl("/p/project?tab=feedback#form")).toBe("/p/project?tab=feedback#form");
    for (const url of ["https://evil.example", "//evil.example", "/x/..//evil.example", "/x/%2e%2e//evil.example", "/\\evil.example", "/%2f%2fevil.example", "/%5cevil.example", "/\nevil", "javascript:alert(1)"]) {
      expect(auth.safeReturnUrl(url)).toBe("/");
    }
  });

  it("requires the configured exact Origin and never trusts a request Host", async () => {
    const auth = await authModule();
    for (const origin of [undefined, "null", "https://evil.example", "https://nomorevibe.example.evil"]) {
      expect(() => auth.requirePublicOrigin(new Request("https://evil.example/api", {
        headers: origin ? { origin } : {},
      }))).toThrow("invalid_origin");
    }
    expect(() => auth.requirePublicOrigin(new Request("https://internal.example/api", {
      headers: { origin: "https://nomorevibe.example" },
    }))).not.toThrow();
  });

  it("binds pre-login CSRF to a separate opaque browser cookie", async () => {
    const auth = await authModule();
    const session = await sessionModule();
    const nonce = session.newPublicSession().token;
    const valid = new Request("https://nomorevibe.example/api/auth/user/email/start", {
      headers: { origin: "https://nomorevibe.example", cookie: `nmv_login_nonce=${nonce}`, "x-csrf-token": session.csrfForToken(nonce, "login") },
    });
    expect(auth.requireLoginMutation(valid)).toBe(nonce);
    expect(() => auth.requireLoginMutation(new Request(valid, { headers: { origin: "https://nomorevibe.example", cookie: `nmv_login_nonce=${nonce}`, "x-csrf-token": "forged" } }))).toThrow("invalid_csrf");
  });

  it("does not treat admin cookies or forged public cookies as a public account", async () => {
    const auth = await authModule();
    for (const cookie of ["nmv_admin=admin-signed-token", "nmv_user=forged", "nmv_user=one; nmv_user=two"]) {
      expect(await auth.getPublicSession(new Request("https://nomorevibe.example/api/me", { headers: { cookie } }))).toBeNull();
    }
  });

  it("defaults every new integration flag to false", async () => {
    const flags = await import("@/lib/domain/github-integration/flags").catch(() => null);
    expect(flags, "feature flags are missing").not.toBeNull();
    vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "");
    vi.stubEnv("PRODUCT_FEEDBACK_ENABLED", "false");
    vi.stubEnv("GITHUB_STAR_ENABLED", "1");
    vi.stubEnv("GITHUB_FEEDBACK_DELIVERY_ENABLED", "");
    expect(flags!.publicUserAuthEnabled()).toBe(false);
    expect(flags!.productFeedbackEnabled()).toBe(false);
    expect(flags!.githubStarEnabled()).toBe(false);
    expect(flags!.githubFeedbackDeliveryEnabled()).toBe(false);
  });

  it("sends one Resend request with the challenge idempotency key", async () => {
    const loaded = await import("@/lib/domain/accounts/email-delivery").catch(() => null);
    expect(loaded, "email transport is missing").not.toBeNull();
    vi.stubEnv("LOGIN_EMAIL_API_KEY", "resend-test-secret");
    vi.stubEnv("LOGIN_EMAIL_FROM", "NoMoreVibe <login@example.com>");
    const fetcher = vi.fn(async () => Response.json({ id: "mail-id" }));
    expect(await loaded!.sendLoginEmail({ challengeId: "challenge-id", email: "private@example.com", code: "00123456" }, fetcher)).toBe("accepted");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(new Headers(options.headers).get("Idempotency-Key")).toBe("challenge-id");
    expect(options.redirect).toBe("error");
    expect(JSON.parse(String(options.body)).text).toContain("00123456");
  });

  it("keeps ambiguous email delivery unknown and never retries or exposes upstream errors", async () => {
    const loaded = await import("@/lib/domain/accounts/email-delivery").catch(() => null);
    expect(loaded, "email transport is missing").not.toBeNull();
    vi.stubEnv("LOGIN_EMAIL_API_KEY", "resend-test-secret");
    vi.stubEnv("LOGIN_EMAIL_FROM", "login@example.com");
    for (const fetcher of [vi.fn(async () => { throw new Error("private@example.com secret 00123456"); }), vi.fn(async () => new Response("secret", { status: 503 }))]) {
      expect(await loaded!.sendLoginEmail({ challengeId: "id", email: "private@example.com", code: "00123456" }, fetcher)).toBe("unknown");
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    expect(await loaded!.sendLoginEmail({ challengeId: "id", email: "private@example.com", code: "00123456" }, async () => new Response("secret", { status: 422 }))).toBe("rejected");
  });

  it("sanitizes errors and adds private no-store headers", async () => {
    const auth = await authModule();
    const response = auth.publicAuthErrorResponse(new Error("private@example.com secret 00123456"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "public_auth_unavailable" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const rejected = auth.publicAuthErrorResponse(new auth.PublicAuthError(403, "invalid_csrf"));
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({ error: "invalid_csrf" });
  });

  it("bootstraps login with an HttpOnly nonce and refuses cross-site bootstrap requests", async () => {
    const route = await import("@/app/api/auth/user/email/start/route").catch(() => null);
    expect(route, "login bootstrap route is missing").not.toBeNull();
    const response = await route!.GET(new Request("https://nomorevibe.example/api/auth/user/email/start"));
    expect(response.status).toBe(200);
    expect((await response.json()).csrfToken).toMatch(/^[a-f0-9]{64}$/);
    expect(response.headers.get("set-cookie")).toContain("nmv_login_nonce=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const refused = await route!.GET(new Request("https://nomorevibe.example/api/auth/user/email/start", { headers: { "sec-fetch-site": "cross-site" } }));
    expect(refused.status).toBe(403);
  });

  it("closes public API routes behind the default-off auth flag", async () => {
    vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "false");
    const start = await import("@/app/api/auth/user/email/start/route").catch(() => null);
    const verify = await import("@/app/api/auth/user/email/verify/route").catch(() => null);
    const logout = await import("@/app/api/auth/user/logout/route").catch(() => null);
    const me = await import("@/app/api/me/route").catch(() => null);
    expect(start, "start route is missing").not.toBeNull();
    expect(verify, "verify route is missing").not.toBeNull();
    expect(logout, "logout route is missing").not.toBeNull();
    expect(me, "me route is missing").not.toBeNull();
    const request = new Request("https://nomorevibe.example/api", { method: "POST" });
    for (const response of [await start!.GET(request), await start!.POST(request), await verify!.POST(request), await logout!.POST(request), await me!.GET(request)]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  it("bounds login JSON bodies and rejects non-JSON input", async () => {
    const auth = await authModule();
    expect(typeof auth.readLoginJson, "login body limit is missing").toBe("function");
    const request = (body: string, contentType = "application/json") => new Request("https://nomorevibe.example/api", { method: "POST", headers: { "content-type": contentType }, body });
    await expect(auth.readLoginJson(request("{}"))).resolves.toEqual({});
    await expect(auth.readLoginJson(request("{}", "text/plain"))).rejects.toMatchObject({ status: 415 });
    await expect(auth.readLoginJson(request("{"))).rejects.toMatchObject({ status: 400 });
    await expect(auth.readLoginJson(request(`{"email":"${"x".repeat(4_000)}"}`))).rejects.toMatchObject({ status: 413 });
  });

  it("renders a separate public email login form without administrator OAuth", async () => {
    const loaded = await import("@/components/auth/EmailLoginForm").catch(() => null);
    expect(loaded, "public email form is missing").not.toBeNull();
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const markup = renderToStaticMarkup(createElement(loaded!.EmailLoginForm, { returnTo: "/" }));
    expect(markup).toContain("이메일");
    expect(markup).toContain('type="email"');
    expect(markup).not.toContain("/api/auth/github");
  });

  it("renders the public account login entry without exposing private user state in initial HTML", async () => {
    const loaded = await import("@/components/auth/AccountMenu").catch(() => null);
    expect(loaded, "public account menu is missing").not.toBeNull();
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    expect(renderToStaticMarkup(createElement(loaded!.AccountMenu))).toContain('href="/login?returnTo=%2F"');
  });

  it("refreshes pre-login CSRF from the browser nonce bootstrap before a replacement code request", async () => {
    const loaded = await import("@/components/auth/EmailLoginForm");
    expect(typeof loaded.bootstrapLoginCsrf, "fresh nonce bootstrap before issuance is missing").toBe("function");
    const fetcher = vi.fn(async () => Response.json({ csrfToken: "fresh-csrf" }));
    vi.stubGlobal("fetch", fetcher);
    expect(await loaded.bootstrapLoginCsrf()).toBe("fresh-csrf");
    expect(fetcher).toHaveBeenCalledWith("/api/auth/user/email/start", { cache: "no-store", signal: undefined });
  });
});
