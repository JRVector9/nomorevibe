import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFeedbackInstallationToken, verifyFeedbackAppCredentials, verifyFeedbackInstallation } from "@/lib/domain/github-installations/credentials";
import type { GithubProductBinding } from "@/lib/db/github-binding-schema";
import { verifyMakerGithubRepository, verifyMakerInstallationAccess } from "@/lib/domain/github-installations/authorization";
vi.mock("@/lib/operations/dr/epoch", async original => ({ ...await original<typeof import("@/lib/operations/dr/epoch")>(), readWriterFence: async () => ({ state: "active" }) })); // PR15e: 웹 쓰기 관문은 dr-web-fence 테스트가 본다(이 fixture 의 요청 흐름 불변)
vi.mock("server-only", () => ({}));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const installation = { id: 12, app_id: 123, repository_selection: "selected", suspended_at: null, permissions: { issues: "write", metadata: "read" } };
const repository = { id: 42, name: "Repo", owner: { login: "Owner" }, full_name: "Owner/Repo", html_url: "https://github.com/Owner/Repo", private: false, archived: false, has_issues: true, permissions: { admin: true } };
const binding: GithubProductBinding = { productId: 1, repositoryId: 42, installationId: 12, repositoryFullName: "Owner/Repo", repositoryUrl: "https://github.com/Owner/Repo", productRepoUrl: "https://github.com/Owner/Repo", consentedByUserId: 1, revision: 1, enabled: true, blockedReason: null, lastVerifiedAt: new Date(), verificationRetryAt: null, createdAt: new Date(), updatedAt: new Date() };
const credential = () => ({ token: "ghs_123_test_installation_1234567890", expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: { issues: "write", metadata: "read" }, repository_selection: "selected", repositories: [{ id: 42 }] });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function github(responses: Response[]) { const fetch = vi.fn(); for (const response of responses) fetch.mockResolvedValueOnce(response); vi.stubGlobal("fetch", fetch); return fetch; }
beforeEach(() => { vi.stubEnv("GITHUB_FEEDBACK_APP_ID", "123"); vi.stubEnv("GITHUB_FEEDBACK_APP_PRIVATE_KEY", privateKeyPem); vi.stubEnv("GITHUB_FEEDBACK_APP_SLUG", "nmv-feedback"); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("provides separately scoped Feedback installation credentials and verification", async () => {
  const loadedModule = await import("@/lib/domain/github-installations/credentials").catch(() => ({}));
  expect(loadedModule).toHaveProperty("getFeedbackInstallationToken", expect.any(Function));
  expect(loadedModule).toHaveProperty("verifyFeedbackInstallation", expect.any(Function));
});

it("provides the numeric product binding schema for outbox snapshots", async () => {
  const loadedModule = await import("@/lib/db/github-binding-schema").catch(() => ({}));
  expect(loadedModule).toHaveProperty("githubProductBindings");
});

it("provides one-shot maker authorization and authoritative user installation checks", async () => {
  const loadedModule = await import("@/lib/domain/github-installations/authorization").catch(() => ({}));
  expect(loadedModule).toHaveProperty("startMakerGithubAuthorization", expect.any(Function));
  expect(loadedModule).toHaveProperty("verifyMakerGithubRepository", expect.any(Function));
  expect(loadedModule).toHaveProperty("verifyMakerInstallationAccess", expect.any(Function));
});

it("provides binding revision invalidation for delivery workers", async () => {
  const loadedModule = await import("@/lib/domain/github-installations/bindings").catch(() => ({}));
  expect(loadedModule).toHaveProperty("getProductGithubBinding", expect.any(Function));
  expect(loadedModule).toHaveProperty("disableProductGithubBinding", expect.any(Function));
});

describe("Feedback App credential boundary", () => {
  it("mints only the exact repository with Issues write and verifies token scope and expiry", async () => {
    const fetch = github([json(installation), json(credential(), 201)]);
    const result = await getFeedbackInstallationToken({ installationId: 12, repositoryId: 42 });
    expect(result.token).toBe(credential().token);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(fetch.mock.calls.map(call => call[0])).toEqual(["https://api.github.com/app/installations/12", "https://api.github.com/app/installations/12/access_tokens"]);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ repository_ids: [42], permissions: { issues: "write", metadata: "read" } });
    const jwtPayload = JSON.parse(Buffer.from(fetch.mock.calls[0][1].headers.Authorization.slice(7).split(".")[1], "base64url").toString());
    expect(jwtPayload.iss).toBe("123");
  });

  it("does not require web-only App slug or OAuth client secrets in a delivery worker", async () => {
    vi.stubEnv("GITHUB_FEEDBACK_APP_SLUG", "");
    vi.stubEnv("GITHUB_FEEDBACK_APP_CLIENT_ID", "");
    vi.stubEnv("GITHUB_FEEDBACK_APP_CLIENT_SECRET", "");
    github([json(installation), json(credential(), 201)]);
    await expect(getFeedbackInstallationToken({ installationId: 12, repositoryId: 42 })).resolves.toMatchObject({ token: credential().token });
  });

  it.each([
    [{ id: 13 }, "github_installation_mismatch"], [{ app_id: 999 }, "github_installation_mismatch"],
    [{ suspended_at: "2026-10-11T00:00:00Z" }, "github_installation_suspended"],
    [{ repository_selection: "all" }, "github_installation_selection_required"],
    [{ permissions: { issues: "read", metadata: "read" } }, "github_installation_permission_missing"],
    [{ permissions: { issues: "write" } }, "github_installation_permission_missing"],
  ])("rejects an unapproved, suspended or mismatched installation before minting", async (changed, code) => {
    const fetch = github([json({ ...installation, ...changed })]);
    await expect(getFeedbackInstallationToken({ installationId: 12, repositoryId: 42 })).rejects.toMatchObject({ code });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ expires_at: "2000-01-01T00:00:00Z" }, "github_installation_token_invalid"],
    [{ expires_at: new Date(Date.now() + 48 * 3_600_000).toISOString() }, "github_installation_token_invalid"],
    [{ token: "not-a-token" }, "github_installation_token_invalid"],
    [{ repositories: [{ id: 43 }] }, "github_installation_token_scope_mismatch"],
    [{ repositories: [{ id: 42 }, { id: 43 }] }, "github_installation_token_scope_mismatch"],
    [{ permissions: { issues: "write", contents: "write" } }, "github_installation_token_scope_mismatch"],
  ])("rejects a token with wrong repository scope, excessive permissions or invalid expiry", async (changed, code) => {
    github([json(installation), json({ ...credential(), ...changed }, 201)]);
    await expect(getFeedbackInstallationToken({ installationId: 12, repositoryId: 42 })).rejects.toMatchObject({ code });
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])("rejects invalid numeric installation or repository IDs %s without a request", async id => {
    const fetch = github([]);
    await expect(getFeedbackInstallationToken({ installationId: id, repositoryId: 42 })).rejects.toMatchObject({ code: "github_invalid_request" });
    await expect(getFeedbackInstallationToken({ installationId: 12, repositoryId: id })).rejects.toMatchObject({ code: "github_invalid_request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps missing installation and upstream ambiguity to safe failures", async () => {
    github([json({ message: "secret-token-value" }, 404)]);
    await expect(getFeedbackInstallationToken({ installationId: 12, repositoryId: 42 })).rejects.toMatchObject({ code: "github_installation_missing" });
    github([json({}, 502)]);
    await expect(getFeedbackInstallationToken({ installationId: 12, repositoryId: 42 })).rejects.toMatchObject({ code: "github_installation_unknown" });
  });

  it("verifies the bound repository by numeric ID with the separately minted token", async () => {
    const fetch = github([json(installation), json(credential(), 201), json(repository)]);
    expect(await verifyFeedbackInstallation(binding)).toMatchObject({ repository: { id: 42, fullName: "Owner/Repo", private: false, archived: false, hasIssues: true } });
    expect(fetch.mock.calls[2][0]).toBe("https://api.github.com/repositories/42");
    expect(fetch.mock.calls[2][1].headers.Authorization).toBe(`Bearer ${credential().token}`);
  });

  it.each([
    [{ id: 43 }, "github_repository_changed"], [{ private: true }, "github_repository_private"],
    [{ archived: true }, "github_repository_archived"], [{ has_issues: false }, "github_repository_issues_disabled"],
  ])("rejects a changed or ineligible bound repository", async (changed, code) => {
    github([json(installation), json(credential(), 201), json({ ...repository, ...changed })]);
    await expect(verifyFeedbackInstallation(binding)).rejects.toMatchObject({ code });
  });
});

describe("maker GitHub authorization evidence", () => {
  const userToken = "ghu_feedback_maker_12345678901234567890";
  it("requires admin permission on the server-selected repository and preserves its numeric identity", async () => {
    const fetch = github([json(repository)]);
    expect(await verifyMakerGithubRepository(userToken, binding.productRepoUrl, 42)).toMatchObject({ id: 42, permissions: { admin: true } });
    expect(fetch.mock.calls[0][0]).toBe("https://api.github.com/repositories/42");
  });

  it.each([
    [{ permissions: { admin: false, maintain: true, push: true } }, "github_repository_admin_required"],
    [{ id: 43 }, "github_repository_changed"], [{ private: true }, "github_repository_private"],
    [{ archived: true }, "github_repository_archived"], [{ has_issues: false }, "github_repository_issues_disabled"],
  ])("rejects repo replacement and insufficient maker authority", async (changed, code) => {
    github([json({ ...repository, ...changed })]);
    await expect(verifyMakerGithubRepository(userToken, binding.productRepoUrl, 42)).rejects.toMatchObject({ code });
  });

  it("does not dispatch a browser-provided or malformed repository target", async () => {
    const fetch = github([]);
    await expect(verifyMakerGithubRepository(userToken, "https://evil.example/Owner/Repo")).rejects.toMatchObject({ code: "github_repository_invalid" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("finds the same installation and repository on later server-read pages", async () => {
    const installations = Array.from({ length: 100 }, (_, index) => ({ ...installation, id: index + 100, app_id: 999 }));
    const repositories = Array.from({ length: 100 }, (_, index) => ({ id: index + 100 }));
    const fetch = github([json({ total_count: 101, installations }), json({ total_count: 101, installations: [installation] }),
      json({ total_count: 101, repositories }), json({ total_count: 101, repositories: [repository] })]);
    await expect(verifyMakerInstallationAccess(userToken, 12, 42)).resolves.toBeUndefined();
    expect(fetch.mock.calls.map(call => call[0])).toEqual([
      "https://api.github.com/user/installations?per_page=100&page=1", "https://api.github.com/user/installations?per_page=100&page=2",
      "https://api.github.com/user/installations/12/repositories?per_page=100&page=1", "https://api.github.com/user/installations/12/repositories?per_page=100&page=2",
    ]);
  });

  it("rejects a callback installation belonging to another user or App", async () => {
    github([json({ total_count: 1, installations: [{ ...installation, app_id: 999 }] })]);
    await expect(verifyMakerInstallationAccess(userToken, 12, 42)).rejects.toMatchObject({ code: "github_installation_access_denied" });
  });

  it("rejects a selected installation whose repositories omit the exact numeric target", async () => {
    github([json({ total_count: 1, installations: [installation] }), json({ total_count: 1, repositories: [{ ...repository, id: 43 }] })]);
    await expect(verifyMakerInstallationAccess(userToken, 12, 42)).rejects.toMatchObject({ code: "github_installation_repository_missing" });
  });
});

it("refuses maker connection without explicit delivery consent before DB or GitHub calls", async () => {
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true");
  vi.stubEnv("PRODUCT_FEEDBACK_ENABLED", "true");
  const fetch = github([]);
  const { startMakerGithubAuthorization } = await import("@/lib/domain/github-installations/authorization");
  await expect(startMakerGithubAuthorization({ actorUserId: 1, slug: "github-maker", editToken: "key", deliveryConsent: false, sessionTokenHash: "a".repeat(64) })).rejects.toMatchObject({ code: "github_feedback_consent_required" });
  expect(fetch).not.toHaveBeenCalled();
});

it("refuses maker connection while public participation or feedback is disabled", async () => {
  const { startMakerGithubAuthorization } = await import("@/lib/domain/github-installations/authorization");
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "false");
  await expect(startMakerGithubAuthorization({ actorUserId: 1, slug: "github-maker", editToken: "key", deliveryConsent: true, sessionTokenHash: "a".repeat(64) })).rejects.toMatchObject({ code: "public_auth_disabled" });
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true");
  vi.stubEnv("PRODUCT_FEEDBACK_ENABLED", "false");
  await expect(startMakerGithubAuthorization({ actorUserId: 1, slug: "github-maker", editToken: "key", deliveryConsent: true, sessionTokenHash: "a".repeat(64) })).rejects.toMatchObject({ code: "github_feedback_disabled" });
});

it("maker start route requires a public session mutation and edit key header before reading a target", async () => {
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true");
  vi.stubEnv("PRODUCT_FEEDBACK_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://nomorevibe.test");
  const loadedModule = await import("@/app/api/auth/maker/github/route").catch(() => null);
  expect(loadedModule).not.toBeNull();
  if (!loadedModule) return;
  const wrongOrigin = await loadedModule.POST(new Request("https://nomorevibe.test/api/auth/maker/github", { method: "POST", headers: { origin: "https://evil.test", "content-type": "application/json" }, body: JSON.stringify({ slug: "github-maker", deliveryConsent: true }) }));
  expect(wrongOrigin.status).toBe(403);
  expect(await wrongOrigin.json()).toEqual({ error: "invalid_origin" });
  expect(wrongOrigin.headers.get("cache-control")).toBe("private, no-store");
  const noSession = await loadedModule.POST(new Request("https://nomorevibe.test/api/auth/maker/github", { method: "POST", headers: { origin: "https://nomorevibe.test", "content-type": "application/json" }, body: JSON.stringify({ slug: "github-maker", deliveryConsent: true }) }));
  expect(noSession.status).toBe(401);
});

it("maker settings route rejects anonymous settings changes", async () => {
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true");
  vi.stubEnv("PRODUCT_FEEDBACK_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://nomorevibe.test");
  const loadedModule = await import("@/app/api/products/[slug]/github-integration/route").catch(() => null);
  expect(loadedModule).not.toBeNull();
  if (!loadedModule) return;
  const response = await loadedModule.PUT(new Request("https://nomorevibe.test/api/products/github-maker/github-integration", { method: "PUT", headers: { origin: "https://nomorevibe.test", "content-type": "application/json" }, body: JSON.stringify({ enabled: false, expectedRevision: 1 }) }), { params: Promise.resolve({ slug: "github-maker" }) });
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "login_required" });
});

it("settings screen asks for an in-memory edit key and explicit public bot Issue consent", async () => {
  const loadedModule = await import("@/components/product-detail/GithubIntegrationSettings").catch(() => null);
  expect(loadedModule).not.toBeNull();
  if (!loadedModule) return;
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = renderToStaticMarkup(createElement(loadedModule.GithubIntegrationSettings, { slug: "github-maker", csrfToken: "csrf-fixture" }));
  expect(html).toContain('type="password"');
  expect(html).toContain('autoComplete="off"');
  expect(html).toContain("앱 봇");
  expect(html).toContain("공개 이슈");
  expect(html).toContain('type="checkbox"');
});

it("settings screen explains pending organization approval and reconnection after approval", async () => {
  const { GithubIntegrationSettings } = await import("@/components/product-detail/GithubIntegrationSettings");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = renderToStaticMarkup(createElement(GithubIntegrationSettings, { slug: "github-maker", csrfToken: "csrf", installationPending: true }));
  expect(html).toContain("조직 관리자");
  expect(html).toContain("승인 후");
  expect(html).toContain("다시 연결");
  expect(html).toContain('role="status"');
});

it.each([403, 429])("preserves proven installation rate limits and provider retry time for HTTP %s", async status => {
  const retryAt = Math.floor(Date.now() / 1000 + 3600) * 1000;
  github([new Response(JSON.stringify({ message: "sensitive-upstream-body" }), { status, headers: { "retry-after": "1800", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(retryAt / 1000) } })]);
  await expect(getFeedbackInstallationToken({ installationId: 12, repositoryId: 42 })).rejects.toMatchObject({ status: 503, providerCode: "github_rate_limited", retryAt });
});

it("does not begin installation reads or minting after a provider deadline or abort", async () => {
  const fetch = github([]);
  await expect(getFeedbackInstallationToken({ installationId: 12, repositoryId: 42 }, { deadlineAt: Date.now() - 1 })).rejects.toMatchObject({ providerCode: "github_timeout" });
  const controller = new AbortController(); controller.abort();
  await expect(verifyFeedbackInstallation(binding, { deadlineAt: Date.now() + 1000, signal: controller.signal })).rejects.toMatchObject({ providerCode: "github_timeout" });
  expect(fetch).not.toHaveBeenCalled();
});

it("never chains a late installation read into token minting after cancellation", async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async () => { controller.abort(); return json(installation); });
  vi.stubGlobal("fetch", fetch);
  await expect(getFeedbackInstallationToken({ installationId: 12, repositoryId: 42 }, { deadlineAt: Date.now() + 1000, signal: controller.signal })).rejects.toMatchObject({ providerCode: "github_timeout" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

/**
 * App 자격 거절 — 개인 키가 폐기되거나 잘못 바뀌면 App JWT 요청이 401 이다. 그 설치·연동의 문제가 아니라 모든 연동이 같이 실패하므로
 * 연동을 끄는 확정 실패(우리 쪽 403)로 보지 않고 github_app_credentials_rejected(503)로 던진다. 설치 토큰의 401·403 은 그대로다.
 */
describe("Feedback App 자격 거절", () => {
  it("설치 조회·토큰 발급(App JWT)의 401 은 App 자격 거절(503)이다", async () => {
    github([json({ message: "A JSON web token could not be decoded" }, 401)]);
    await expect(getFeedbackInstallationToken({ installationId: 12, repositoryId: 42 }))
      .rejects.toMatchObject({ status: 503, code: "github_app_credentials_rejected", providerCode: "github_unauthorized" });
    github([json(installation), json({ message: "Bad credentials" }, 401)]);
    await expect(getFeedbackInstallationToken({ installationId: 12, repositoryId: 42 })).rejects.toMatchObject({ status: 503, code: "github_app_credentials_rejected" });
  });

  it("설치의 403(정지·권한)과 설치 토큰의 401 은 지금처럼 그 연동의 확정 실패(403)다", async () => {
    github([json({ message: "forbidden" }, 403)]);
    await expect(getFeedbackInstallationToken({ installationId: 12, repositoryId: 42 })).rejects.toMatchObject({ status: 403, code: "github_installation_unavailable" });
    github([json(installation), json(credential(), 201), json({ message: "Bad credentials" }, 401)]);
    await expect(verifyFeedbackInstallation({ installationId: 12, repositoryId: 42 })).rejects.toMatchObject({ status: 403, code: "github_installation_unavailable" });
  });

  it("GET /app — 설정한 App 이면 통과, 401·403·404 는 자격 거절, id·slug 가 다르면 App 불일치, 닿지 않으면 그대로 던진다", async () => {
    const fetch = github([json({ id: 123, slug: "nmv-feedback" })]);
    await expect(verifyFeedbackAppCredentials()).resolves.toEqual({ id: 123, slug: "nmv-feedback" });
    expect(fetch.mock.calls[0][0]).toBe("https://api.github.com/app");
    for (const status of [401, 403, 404]) {
      github([json({ message: "nope" }, status)]);
      await expect(verifyFeedbackAppCredentials(), String(status)).rejects.toMatchObject({ status: 503, code: "github_app_credentials_rejected" });
    }
    github([json({ id: 999, slug: "nmv-feedback" })]);
    await expect(verifyFeedbackAppCredentials()).rejects.toMatchObject({ code: "github_app_mismatch" });
    github([json({ id: 123, slug: "someone-else" })]);
    await expect(verifyFeedbackAppCredentials()).rejects.toMatchObject({ code: "github_app_mismatch" });
    // 슬러그를 두지 않은 워커는 id 만 견준다
    vi.stubEnv("GITHUB_FEEDBACK_APP_SLUG", "");
    github([json({ id: 123, slug: "someone-else" })]);
    await expect(verifyFeedbackAppCredentials()).resolves.toMatchObject({ id: 123 });
    github([json({}, 502)]);
    await expect(verifyFeedbackAppCredentials()).rejects.toMatchObject({ code: "github_installation_unknown" });
    vi.stubEnv("GITHUB_FEEDBACK_APP_PRIVATE_KEY", "");
    await expect(verifyFeedbackAppCredentials()).rejects.toMatchObject({ code: "github_feedback_unconfigured" });
  });
});
