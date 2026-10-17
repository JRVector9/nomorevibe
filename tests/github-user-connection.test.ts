import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/operations/dr/epoch", async original => ({ ...await original<typeof import("@/lib/operations/dr/epoch")>(), readWriterFence: async () => ({ state: "active" }) })); // PR15e: 웹 쓰기 관문은 dr-web-fence 테스트가 본다(이 fixture 의 요청 흐름 불변)

async function authorization() {
  const loaded = await import("@/lib/domain/github-user/authorization").catch(() => null);
  expect(loaded, "public GitHub authorization is missing").not.toBeNull();
  return loaded!;
}
async function credentials() {
  const loaded = await import("@/lib/domain/github-user/credentials").catch(() => null);
  expect(loaded, "encrypted GitHub user credentials are missing").not.toBeNull();
  return loaded!;
}
beforeEach(() => {
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true");
  vi.stubEnv("GITHUB_STAR_ENABLED", "true");
  vi.stubEnv("PUBLIC_AUTH_SECRET", "unit-public-auth-secret-longer-than-32-characters");
  vi.stubEnv("GITHUB_INTEGRATION_SECRET", "unit-github-integration-secret-longer-than-32-characters");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://nomorevibe.example");
  vi.stubEnv("GITHUB_STAR_APP_CLIENT_ID", "Iv1.star-client-id");
  vi.stubEnv("GITHUB_STAR_APP_CLIENT_SECRET", "star-client-secret");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const tokenResponse = { access_token: `ghu_${"a".repeat(40)}`, refresh_token: `ghr_${"b".repeat(40)}`, expires_in: 1_800, refresh_token_expires_in: 7_200, token_type: "bearer", scope: "" };

describe("public GitHub user authorization", () => {
  it("generates independent opaque state/browser nonce and S256 PKCE", async () => {
    const loaded = await authorization();
    const { createHash } = await import("node:crypto");
    const flow = loaded.newGithubAuthorizationSecrets();
    expect(Buffer.from(flow.state, "base64url")).toHaveLength(32);
    expect(flow.browserNonce).not.toBe(flow.state);
    expect(flow.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.challenge).toBe(createHash("sha256").update(flow.verifier).digest("base64url"));
    expect(loaded.GITHUB_NONCE_COOKIE).toBe("nmv_github_nonce");
  });
  it("authorizes only the dedicated star App with offline access and the fixed callback", async () => {
    const loaded = await authorization();
    const flow = loaded.newGithubAuthorizationSecrets();
    const url = new URL(loaded.githubAuthorizeUrl(flow));
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv1.star-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://nomorevibe.example/api/auth/user/github/callback");
    expect(url.searchParams.get("scope")).toBe("offline_access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(flow.state);
  });
  it("encrypts user credentials under a separate integration secret", async () => {
    const loaded = await credentials();
    const encrypted = loaded.encryptGithubSecret("secret-user-token");
    expect(encrypted).not.toContain("secret-user-token");
    expect(loaded.decryptGithubSecret(encrypted)).toBe("secret-user-token");
    vi.stubEnv("GITHUB_INTEGRATION_SECRET", "different-integration-secret-more-than-32-characters");
    expect(() => loaded.decryptGithubSecret(encrypted)).toThrow();
    vi.stubEnv("GITHUB_INTEGRATION_SECRET", "");
    expect(() => loaded.encryptGithubSecret("token")).toThrow("github_integration_unconfigured");
  });
  it("exchanges code and PKCE verifier once and uses actual provider expiries", async () => {
    const loaded = await credentials();
    const fetcher = vi.fn(async () => Response.json(tokenResponse));
    const before = Date.now();
    const result = await loaded.exchangeGithubCode({ code: "authorization-code", verifier: "v".repeat(43) }, fetcher);
    expect(result.outcome).toBe("confirmed_success");
    if (result.outcome !== "confirmed_success") throw new Error("expected tokens");
    expect(result.tokens.accessToken).toBe(tokenResponse.access_token);
    expect(result.tokens.accessExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 1_800_000);
    expect(result.tokens.accessExpiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_800_000);
    expect(result.tokens.refreshExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 7_200_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(options.redirect).toBe("manual");
    expect(JSON.parse(String(options.body))).toMatchObject({ client_id: "Iv1.star-client-id", code_verifier: "v".repeat(43), redirect_uri: "https://nomorevibe.example/api/auth/user/github/callback" });
  });
  it("rejects non-expiring, malformed, or broad-scope token responses without exposing tokens", async () => {
    const loaded = await credentials();
    for (const response of [{ ...tokenResponse, refresh_token: undefined }, { ...tokenResponse, expires_in: -1 }, { ...tokenResponse, scope: "public_repo" }, { ...tokenResponse, access_token: "legacy-admin-token" }]) {
      const result = await loaded.exchangeGithubCode({ code: "code", verifier: "v".repeat(43) }, async () => Response.json(response));
      expect(result.outcome).toBe("unknown");
      expect(JSON.stringify(result)).not.toContain(tokenResponse.access_token);
    }
  });
  it("never follows OAuth redirects or automatically repeats ambiguous refreshes", async () => {
    const loaded = await credentials();
    for (const fetcher of [vi.fn(async () => new Response("", { status: 302, headers: { location: "https://evil.example" } })), vi.fn(async () => new Response("upstream-sensitive-error", { status: 503 })), vi.fn(async () => { throw new Error("refresh_token-secret"); })]) {
      const result = await loaded.refreshGithubToken(tokenResponse.refresh_token, fetcher);
      expect(result.outcome).toBe("unknown");
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("bounds OAuth body reads and enforces a deadline when fetch ignores AbortSignal", async () => {
    const loaded = await credentials();
    const oversized = await loaded.exchangeGithubCode({ code: "code", verifier: "v".repeat(43) }, async () => new Response("x".repeat(65_537)));
    expect(oversized.outcome).toBe("unknown");
    const timedOut = await loaded.refreshGithubToken(tokenResponse.refresh_token, async () => new Promise<Response>(() => {}), 10);
    expect(timedOut).toMatchObject({ outcome: "unknown", code: "github_oauth_timeout" });
    const bodyTimedOut = await loaded.refreshGithubToken(tokenResponse.refresh_token, async () => new Response(new ReadableStream({ start() {} })), 10);
    expect(bodyTimedOut).toMatchObject({ outcome: "unknown", code: "github_oauth_timeout" });
  });
  it("keeps OAuth HTTP rejections confirmed without echoing provider error text", async () => {
    const loaded = await credentials();
    const result = await loaded.refreshGithubToken(tokenResponse.refresh_token, async () => Response.json({ error: "bad_refresh_token", error_description: "private-token" }, { status: 401 }));
    expect(result).toMatchObject({ outcome: "confirmed_rejection", code: "github_oauth_rejected" });
    expect(JSON.stringify(result)).not.toContain("private-token");
  });
  it("closes authorization and credential access when flags are disabled", async () => {
    const loaded = await authorization();
    vi.stubEnv("GITHUB_STAR_ENABLED", "false");
    expect(() => loaded.requireGithubStarEnabled()).toThrow("github_star_disabled");
    vi.stubEnv("GITHUB_STAR_ENABLED", "true");
    vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "false");
    expect(() => loaded.requireGithubStarEnabled()).toThrow("public_auth_disabled");
  });
  it("shares bounded code exchange with a separately configured maker App", async () => {
    const loaded = await credentials();
    expect(typeof loaded.exchangeGithubAppCode, "separate maker App exchange is missing").toBe("function");
    const fetcher = vi.fn(async () => Response.json(tokenResponse));
    const result = await loaded.exchangeGithubAppCode({ code: "maker-code", verifier: "v".repeat(43), clientId: "Iv1.maker-id", clientSecret: "maker-secret", callbackUrl: "https://nomorevibe.example/api/auth/maker/github/callback" }, fetcher);
    expect(result.outcome).toBe("confirmed_success");
    const [, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(options.body))).toMatchObject({ client_id: "Iv1.maker-id", client_secret: "maker-secret", redirect_uri: "https://nomorevibe.example/api/auth/maker/github/callback" });
  });
  it("closes user GitHub routes behind the star feature flag", async () => {
    const start = await import("@/app/api/auth/user/github/route").catch(() => null);
    const callback = await import("@/app/api/auth/user/github/callback/route").catch(() => null);
    const connection = await import("@/app/api/me/github/route").catch(() => null);
    expect(start, "GitHub start route is missing").not.toBeNull();
    expect(callback, "GitHub callback route is missing").not.toBeNull();
    expect(connection, "GitHub connection route is missing").not.toBeNull();
    vi.stubEnv("GITHUB_STAR_ENABLED", "false");
    const request = new Request("https://nomorevibe.example/api");
    for (const response of [await start!.POST(request), await connection!.GET(request), await connection!.DELETE(request)]) {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    const deniedCallback = await callback!.GET(request);
    expect(deniedCallback.status).toBe(404);
  });
  it("shows the requested personal star permission and separate disconnect behavior", async () => {
    const loaded = await import("@/components/auth/GithubConnection").catch(() => null);
    expect(loaded, "GitHub connection UI is missing").not.toBeNull();
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const markup = renderToStaticMarkup(createElement(loaded!.GithubConnection, { returnTo: "/p/test" }));
    expect(markup).toContain("본인 GitHub 계정");
    expect(markup).toContain("스타");
    expect(markup).not.toContain("이슈 쓰기 권한");
  });
  it("keeps a signed-in user's callback failure visible on the GitHub connection screen", async () => {
    const auth = await import("@/lib/domain/accounts/request-auth");
    vi.spyOn(auth, "getPublicSession").mockResolvedValue({ user: { id: 10, displayName: "참여자-email" }, csrfToken: "session-csrf" });
    const callback = await import("@/app/api/auth/user/github/callback/route");
    const response = await callback.GET(new Request("https://nomorevibe.example/api/auth/user/github/callback?state=forged"));
    const target = new URL(response.headers.get("location")!);
    expect(target.searchParams.get("connectGithub")).toBe("1");
    expect(target.searchParams.get("githubError")).toBe("invalid_github_flow");
  });
});
