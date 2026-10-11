import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { publicSessions, publicUsers } from "@/lib/db/public-user-schema";
import { githubAuthFlows } from "@/lib/db/github-user-schema";
import { githubMakerAuthContexts, githubProductBindings } from "@/lib/db/github-binding-schema";
import { disableProductGithubBinding, getProductGithubBinding } from "@/lib/domain/github-installations/bindings";
import { hashToken } from "@/lib/tokens";
import { csrfForToken, newPublicSession } from "@/lib/domain/accounts/session";
import { ensureSchema, resetTables } from "./setup";

let productId: number, userId: number;
const repoUrl = "https://github.com/Owner/Repo";
const editToken = "nmv_edit_binding_fixture";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const rawRepository = { id: 42, name: "Repo", owner: { login: "Owner" }, full_name: "Owner/Repo", html_url: repoUrl, private: false, archived: false, has_issues: true, permissions: { admin: true } };
const sessionTokenHash = hashToken("session");
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function github(responses: Response[]) { const fetch = vi.fn(); for (const response of responses) fetch.mockResolvedValueOnce(response); vi.stubGlobal("fetch", fetch); return fetch; }
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const binding = () => ({ productId, repositoryId: 42, repositoryFullName: "Owner/Repo", repositoryUrl: repoUrl, productRepoUrl: repoUrl, installationId: 12, consentedByUserId: userId, enabled: true, revision: 1 });
beforeAll(() => ensureSchema());
beforeEach(async () => {
  vi.unstubAllGlobals();
  vi.stubEnv("PUBLIC_AUTH_SECRET", "public-auth-test-secret-more-than-32-bytes");
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true");
  vi.stubEnv("PRODUCT_FEEDBACK_ENABLED", "true");
  vi.stubEnv("GITHUB_INTEGRATION_SECRET", "test-integration-secret-longer-than-32-bytes");
  vi.stubEnv("GITHUB_FEEDBACK_APP_ID", "123");
  vi.stubEnv("GITHUB_FEEDBACK_APP_PRIVATE_KEY", privateKeyPem);
  vi.stubEnv("GITHUB_FEEDBACK_APP_SLUG", "nmv-feedback");
  vi.stubEnv("GITHUB_FEEDBACK_APP_CLIENT_ID", "Iv1.feedback-test");
  vi.stubEnv("GITHUB_FEEDBACK_APP_CLIENT_SECRET", "feedback-secret-test");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://nomorevibe.test");
  await resetTables();
  [ { id: userId } ] = await db.insert(publicUsers).values({ displayName: "Maker" }).returning({ id: publicUsers.id });
  [ { id: productId } ] = await db.insert(products).values({ slug: "github-maker", url: "https://maker.example", name: "Maker product", tagline: "Maker fixture", description: "Fixture", category: "Dev", status: "verified", repoUrl, verifyToken: "verify", editTokenHash: hashToken(editToken) }).returning({ id: products.id });
});

describe("numeric binding revision and invalidation", () => {
  it("reads a current binding on the primary database", async () => {
    await db.insert(githubProductBindings).values(binding());
    expect(await getProductGithubBinding(productId)).toMatchObject({ repositoryId: 42, enabled: true, revision: 1 });
  });

  it("atomically disables a binding when the current product repository changes", async () => {
    await db.insert(githubProductBindings).values(binding());
    await db.update(products).set({ repoUrl: "https://github.com/Owner/Other" }).where(eq(products.id, productId));
    expect(await getProductGithubBinding(productId)).toMatchObject({ enabled: false, revision: 2, blockedReason: "product_repository_changed", repositoryId: 42 });
    expect(await getProductGithubBinding(productId)).toMatchObject({ enabled: false, revision: 2 });
  });

  it("disables a banned product without moving the original target", async () => {
    await db.insert(githubProductBindings).values(binding());
    await db.update(products).set({ status: "banned" }).where(eq(products.id, productId));
    expect(await getProductGithubBinding(productId)).toMatchObject({ enabled: false, revision: 2, blockedReason: "product_banned", repositoryId: 42 });
  });

  it("rejects stale maker disable revisions and increments once under concurrent disable", async () => {
    await db.insert(githubProductBindings).values(binding());
    await expect(disableProductGithubBinding(productId, "maker_disabled", 2)).rejects.toMatchObject({ code: "github_binding_revision_conflict" });
    const results = await Promise.allSettled([disableProductGithubBinding(productId, "maker_disabled", 1), disableProductGithubBinding(productId, "maker_disabled", 1)]);
    expect(results.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect((await db.select().from(githubProductBindings))[0]).toMatchObject({ enabled: false, revision: 2 });
  });

  it("enforces one current binding and safe numeric IDs at the database boundary", async () => {
    await db.insert(githubProductBindings).values(binding());
    await expect(db.insert(githubProductBindings).values(binding())).rejects.toThrow();
    await db.delete(githubProductBindings);
    await expect(db.insert(githubProductBindings).values({ ...binding(), repositoryId: 0 })).rejects.toThrow();
  });
});

export async function makerContext(input: { state?: "authorizing" | "awaiting_setup" | "verifying"; expired?: boolean; actorUserId?: number; expectedRevision?: number } = {}) {
  const flowId = randomUUID(), expiresAt = new Date(Date.now() + (input.expired ? -1_000 : 600_000));
  await db.insert(githubAuthFlows).values({ id: flowId, purpose: "maker", actorUserId: userId, productId, stateHash: hashToken(randomUUID()), browserNonceHash: hashToken("nonce"), encryptedPkceVerifier: "fixture", expiresAt });
  await db.insert(githubMakerAuthContexts).values({ flowId, actorUserId: input.actorUserId ?? userId, productId, repositoryId: 42, productRepoUrl: repoUrl, editTokenHash: hashToken(editToken), expectedRevision: input.expectedRevision ?? 0, browserNonceHash: hashToken("nonce"), sessionTokenHash: hashToken("session"), state: input.state ?? "verifying", expiresAt });
  return flowId;
}

const repository = { id: 42, owner: "Owner", repo: "Repo", fullName: "Owner/Repo", htmlUrl: repoUrl, private: false, archived: false, hasIssues: true, permissions: { admin: true, maintain: false, push: false } };

describe("one-shot binding completion", () => {
  it("atomically saves the verified target and destroys the temporary credential", async () => {
    const flowId = await makerContext();
    await db.update(githubMakerAuthContexts).set({ encryptedUserToken: "encrypted-fixture", setupStateHash: hashToken("setup") }).where(eq(githubMakerAuthContexts.flowId, flowId));
    const { completeProductGithubBinding } = await import("@/lib/domain/github-installations/bindings");
    expect(await completeProductGithubBinding({ flowId, actorUserId: userId, installationId: 12, repository })).toMatchObject({ productId, repositoryId: 42, installationId: 12, revision: 1, enabled: true });
    expect((await db.select().from(githubMakerAuthContexts))[0]).toMatchObject({ state: "completed", encryptedUserToken: null, setupStateHash: null });
    await expect(completeProductGithubBinding({ flowId, actorUserId: userId, installationId: 12, repository })).rejects.toMatchObject({ code: "invalid_github_flow" });
  });

  it.each(["repository", "edit_key", "revision", "expiry", "target_id"])("rejects changed %s evidence after external authorization", async changed => {
    const flowId = await makerContext({ expired: changed === "expiry" });
    if (changed === "repository") await db.update(products).set({ repoUrl: "https://github.com/Owner/Other" }).where(eq(products.id, productId));
    if (changed === "edit_key") await db.update(products).set({ editTokenHash: hashToken("new-key") }).where(eq(products.id, productId));
    if (changed === "revision") await db.insert(githubProductBindings).values(binding());
    const { completeProductGithubBinding } = await import("@/lib/domain/github-installations/bindings");
    await expect(completeProductGithubBinding({ flowId, actorUserId: userId, installationId: 12, repository: { ...repository, id: changed === "target_id" ? 43 : 42 } })).rejects.toMatchObject({ code: changed === "revision" ? "github_binding_revision_conflict" : changed === "expiry" ? "invalid_github_flow" : "github_maker_authorization_changed" });
    if (changed !== "revision") expect(await db.select().from(githubProductBindings)).toHaveLength(0);
  });

  it("clears expired temporary tokens without retaining setup state", async () => {
    const flowId = await makerContext({ state: "awaiting_setup", expired: true });
    await db.update(githubMakerAuthContexts).set({ encryptedUserToken: "encrypted-fixture", setupStateHash: hashToken("setup") }).where(eq(githubMakerAuthContexts.flowId, flowId));
    const { expireMakerGithubAuthorizations } = await import("@/lib/domain/github-installations/bindings");
    expect(await expireMakerGithubAuthorizations()).toBe(1);
    expect((await db.select().from(githubMakerAuthContexts))[0]).toMatchObject({ state: "expired", encryptedUserToken: null, setupStateHash: null });
  });
});


describe("maker connection start", () => {
  it("binds actor, product, edit authorization, exact session and numeric target to an opaque PKCE flow", async () => {
    const fetch = github([json(rawRepository)]);
    const { startMakerGithubAuthorization } = await import("@/lib/domain/github-installations/authorization");
    const started = await startMakerGithubAuthorization({ actorUserId: userId, slug: "github-maker", editToken, deliveryConsent: true, sessionTokenHash });
    const url = new URL(started.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv1.feedback-test");
    expect(url.searchParams.get("scope")).toBe("offline_access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.authorizeUrl).not.toContain(editToken);
    expect(started.authorizeUrl).not.toContain("Owner");
    expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
    const [context] = await db.select().from(githubMakerAuthContexts);
    expect(context).toMatchObject({ actorUserId: userId, productId, repositoryId: 42, sessionTokenHash, editTokenHash: hashToken(editToken), expectedRevision: 0, state: "authorizing", encryptedUserToken: null });
    expect(context.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 600_000);
    expect((await db.select().from(githubAuthFlows))[0]).toMatchObject({ purpose: "maker", productId, actorUserId: userId });
  });

  it("requires the current edit key before resolving GitHub metadata", async () => {
    const fetch = github([]);
    const { startMakerGithubAuthorization } = await import("@/lib/domain/github-installations/authorization");
    await expect(startMakerGithubAuthorization({ actorUserId: userId, slug: "github-maker", editToken: "wrong", deliveryConsent: true, sessionTokenHash })).rejects.toMatchObject({ code: "maker_edit_token_invalid" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await db.select().from(githubMakerAuthContexts)).toHaveLength(0);
  });

  it("uses an existing matching binding numeric ID to survive a repository rename without adopting a name replacement", async () => {
    await db.insert(githubProductBindings).values(binding());
    const fetch = github([json({ ...rawRepository, name: "Renamed", full_name: "Owner/Renamed", html_url: "https://github.com/Owner/Renamed" })]);
    const { startMakerGithubAuthorization } = await import("@/lib/domain/github-installations/authorization");
    await startMakerGithubAuthorization({ actorUserId: userId, slug: "github-maker", editToken, deliveryConsent: true, sessionTokenHash });
    expect(fetch.mock.calls[0][0]).toBe("https://api.github.com/repositories/42");
    expect((await db.select().from(githubMakerAuthContexts))[0]).toMatchObject({ repositoryId: 42, expectedRevision: 1 });
  });
});

const userToken = "ghu_feedback_maker_12345678901234567890";
const oauthTokens = { access_token: userToken, refresh_token: "ghr_feedback_maker_12345678901234567890", expires_in: 28_800, refresh_token_expires_in: 15_552_000, token_type: "bearer", scope: "" };
const installation = { id: 12, app_id: 123, repository_selection: "selected", suspended_at: null, permissions: { issues: "write", metadata: "read" } };
const installationCredential = () => ({ token: "ghs_feedback_install_12345678901234567890", expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: { issues: "write", metadata: "read" }, repository_selection: "selected", repositories: [{ id: 42 }] });
async function startedFlow() {
  github([json(rawRepository)]);
  const { startMakerGithubAuthorization } = await import("@/lib/domain/github-installations/authorization");
  const started = await startMakerGithubAuthorization({ actorUserId: userId, slug: "github-maker", editToken, deliveryConsent: true, sessionTokenHash });
  return { state: new URL(started.authorizeUrl).searchParams.get("state")!, browserNonce: started.browserNonce, actorUserId: userId, sessionTokenHash, code: "github-code" };
}
async function awaitingSetup() {
  const flow = await startedFlow();
  github([json(oauthTokens), json(rawRepository)]);
  const { finishMakerGithubAuthorization } = await import("@/lib/domain/github-installations/authorization");
  const finished = await finishMakerGithubAuthorization(flow);
  return { state: new URL(finished.installUrl).searchParams.get("state")!, browserNonce: flow.browserNonce, actorUserId: userId, sessionTokenHash, installationId: 12 };
}
function setupResponses(repo = rawRepository, app = installation) {
  return [json(repo), json({ total_count: 1, installations: [app] }), json({ total_count: 1, repositories: [repo] }), json(app), json(installationCredential(), 201), json(repo)];
}

describe("Feedback OAuth callback and installation setup", () => {
  it("uses dedicated Feedback OAuth PKCE, preserves the session and stores only an encrypted short-lived user token", async () => {
    const flow = await startedFlow();
    const fetch = github([json(oauthTokens), json(rawRepository)]);
    const { finishMakerGithubAuthorization } = await import("@/lib/domain/github-installations/authorization");
    const finished = await finishMakerGithubAuthorization(flow);
    const url = new URL(finished.installUrl);
    expect(url.origin + url.pathname).toBe("https://github.com/apps/nmv-feedback/installations/new");
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).not.toBe(flow.state);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ client_id: "Iv1.feedback-test", client_secret: "feedback-secret-test", code: flow.code, redirect_uri: "https://nomorevibe.test/api/auth/maker/github/callback" });
    expect(body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [context] = await db.select().from(githubMakerAuthContexts);
    expect(context).toMatchObject({ state: "awaiting_setup", sessionTokenHash });
    expect(context.encryptedUserToken).toBeTruthy();
    expect(context.encryptedUserToken).not.toContain(userToken);
    expect(JSON.stringify(context)).not.toContain(oauthTokens.refresh_token);
    const replayFetch = github([]);
    await expect(finishMakerGithubAuthorization(flow)).rejects.toMatchObject({ code: "invalid_github_flow" });
    expect(replayFetch).not.toHaveBeenCalled();
  });

  it.each(["session", "nonce", "purpose", "actor"])("rejects OAuth callback with mismatched %s before token exchange", async changed => {
    const flow = await startedFlow();
    if (changed === "purpose") await db.update(githubAuthFlows).set({ purpose: "star" });
    const fetch = github([]);
    const { finishMakerGithubAuthorization } = await import("@/lib/domain/github-installations/authorization");
    await expect(finishMakerGithubAuthorization({ ...flow, sessionTokenHash: changed === "session" ? hashToken("another-session") : flow.sessionTokenHash, browserNonce: changed === "nonce" ? "x".repeat(43) : flow.browserNonce, actorUserId: changed === "actor" ? userId + 1 : userId })).rejects.toMatchObject({ code: "invalid_github_flow" });
    expect(fetch).not.toHaveBeenCalled();
    expect((await db.select().from(githubAuthFlows))[0].consumedAt).toBeNull();
  });

  it("rejects same-name repository replacement between start and callback and clears the failed context", async () => {
    const flow = await startedFlow();
    github([json(oauthTokens), json({ ...rawRepository, id: 43 })]);
    const { finishMakerGithubAuthorization } = await import("@/lib/domain/github-installations/authorization");
    await expect(finishMakerGithubAuthorization(flow)).rejects.toMatchObject({ code: "github_repository_changed" });
    expect((await db.select().from(githubMakerAuthContexts))[0]).toMatchObject({ state: "failed", encryptedUserToken: null, setupStateHash: null });
  });

  it("binds only the server-enumerated installation and exact repository and clears the temporary user token", async () => {
    const setup = await awaitingSetup();
    const fetch = github(setupResponses());
    const { completeMakerGithubInstallation } = await import("@/lib/domain/github-installations/authorization");
    expect(await completeMakerGithubInstallation(setup)).toMatchObject({ slug: "github-maker", binding: { productId, repositoryId: 42, installationId: 12, enabled: true, revision: 1 } });
    expect((await db.select().from(githubMakerAuthContexts))[0]).toMatchObject({ state: "completed", encryptedUserToken: null, setupStateHash: null });
    expect(fetch.mock.calls.map(call => call[0])).toContain("https://api.github.com/user/installations/12/repositories?per_page=100&page=1");
    const replayFetch = github([]);
    await expect(completeMakerGithubInstallation(setup)).rejects.toMatchObject({ code: "invalid_github_flow" });
    expect(replayFetch).not.toHaveBeenCalled();
  });

  it.each(["session", "nonce", "actor", "expiry"])("rejects installation setup with wrong %s before any external verification", async changed => {
    const setup = await awaitingSetup();
    if (changed === "expiry") await db.update(githubMakerAuthContexts).set({ expiresAt: new Date(Date.now() - 1_000) });
    const fetch = github([]);
    const { completeMakerGithubInstallation } = await import("@/lib/domain/github-installations/authorization");
    await expect(completeMakerGithubInstallation({ ...setup, sessionTokenHash: changed === "session" ? hashToken("another-session") : setup.sessionTokenHash, browserNonce: changed === "nonce" ? "x".repeat(43) : setup.browserNonce, actorUserId: changed === "actor" ? userId + 1 : userId })).rejects.toMatchObject({ code: "invalid_github_flow" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await db.select().from(githubProductBindings)).toHaveLength(0);
  });

  it("rejects a swapped installation ID even when the callback supplied it", async () => {
    const setup = await awaitingSetup();
    github([json(rawRepository), json({ total_count: 1, installations: [installation] })]);
    const { completeMakerGithubInstallation } = await import("@/lib/domain/github-installations/authorization");
    await expect(completeMakerGithubInstallation({ ...setup, installationId: 13 })).rejects.toMatchObject({ code: "github_installation_access_denied" });
    expect((await db.select().from(githubMakerAuthContexts))[0]).toMatchObject({ state: "failed", encryptedUserToken: null });
    expect(await db.select().from(githubProductBindings)).toHaveLength(0);
  });

  it("returns a safe pending organization approval result and clears its temporary credential", async () => {
    const setup = await awaitingSetup();
    const fetch = github([]);
    const { completeMakerGithubInstallation } = await import("@/lib/domain/github-installations/authorization");
    expect(await completeMakerGithubInstallation({ ...setup, setupAction: "request" })).toEqual({ status: "pending", slug: "github-maker" });
    expect(fetch).not.toHaveBeenCalled();
    expect((await db.select().from(githubMakerAuthContexts))[0]).toMatchObject({ state: "failed", encryptedUserToken: null });
  });

  it("redirects an authenticated organization approval request to guidance without retaining its credential", async () => {
    const headers = await sessionHeaders();
    const setup = await awaitingSetup();
    await db.update(githubMakerAuthContexts).set({ sessionTokenHash: hashToken(headers.cookie.slice("nmv_user=".length)) });
    const fetch = github([]);
    const { GET } = await import("@/app/api/github/installations/setup/route");
    const response = await GET(new Request(`https://nomorevibe.test/api/github/installations/setup?state=${setup.state}&setup_action=request`, { headers: { cookie: `${headers.cookie}; nmv_github_nonce=${setup.browserNonce}` } }));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://nomorevibe.test/p/github-maker/github?pending=1");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(fetch).not.toHaveBeenCalled();
    expect((await db.select().from(githubMakerAuthContexts))[0]).toMatchObject({ state: "failed", encryptedUserToken: null, setupStateHash: null });
    expect(await db.select().from(githubProductBindings)).toHaveLength(0);
  });

  it("does not save a binding after the edit key changes while GitHub verification is in flight", async () => {
    const setup = await awaitingSetup();
    const responses = setupResponses();
    const fetch = vi.fn(async () => {
      if (responses.length === 1) await db.update(products).set({ editTokenHash: hashToken("rotated-key") }).where(eq(products.id, productId));
      return responses.shift()!;
    });
    vi.stubGlobal("fetch", fetch);
    const { completeMakerGithubInstallation } = await import("@/lib/domain/github-installations/authorization");
    await expect(completeMakerGithubInstallation(setup)).rejects.toMatchObject({ code: "github_maker_authorization_changed" });
    expect(await db.select().from(githubProductBindings)).toHaveLength(0);
    expect((await db.select().from(githubMakerAuthContexts))[0]).toMatchObject({ state: "failed", encryptedUserToken: null });
  });
});


async function sessionHeaders(extra: Record<string, string> = {}) {
  const session = newPublicSession();
  await db.insert(publicSessions).values({ userId, tokenHash: session.tokenHash, createdAt: session.createdAt, expiresAt: session.expiresAt });
  return { cookie: `nmv_user=${session.token}`, origin: "https://nomorevibe.test", "x-csrf-token": csrfForToken(session.token, "session"), "x-edit-token": editToken, "content-type": "application/json", ...extra };
}
const routeContext = { params: Promise.resolve({ slug: "github-maker" }) };

describe("maker API authorization boundaries", () => {
  it.each(["csrf", "edit_header", "other_product_key", "query_key", "body_key", "browser_target"])("rejects %s in connection start without any GitHub dispatch", async changed => {
    const headers = await sessionHeaders();
    if (changed === "csrf") headers["x-csrf-token"] = "wrong";
    if (changed === "edit_header" || changed === "body_key") delete (headers as Partial<typeof headers>)["x-edit-token"];
    if (changed === "other_product_key") headers["x-edit-token"] = "nmv_other_product_edit_key";
    const fetch = github([]);
    const { POST } = await import("@/app/api/auth/maker/github/route");
    const url = "https://nomorevibe.test/api/auth/maker/github" + (changed === "query_key" ? "?editToken=nmv_edit_binding_fixture" : "");
    const response = await POST(new Request(url, { method: "POST", headers, body: JSON.stringify({ slug: "github-maker", deliveryConsent: true, ...(changed === "body_key" ? { editToken } : {}), ...(changed === "browser_target" ? { repositoryId: 43 } : {}) }) }));
    expect(response.status).toBe(changed === "csrf" || changed === "other_product_key" ? 403 : changed === "edit_header" || changed === "body_key" ? 401 : 400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(fetch).not.toHaveBeenCalled();
    expect(await db.select().from(githubMakerAuthContexts)).toHaveLength(0);
  });

  it("requires session and edit key to read settings and CSRF to disable a current revision", async () => {
    await db.insert(githubProductBindings).values(binding());
    const headers = await sessionHeaders();
    const { GET, PUT } = await import("@/app/api/products/[slug]/github-integration/route");
    const url = "https://nomorevibe.test/api/products/github-maker/github-integration";
    expect((await GET(new Request(url), routeContext)).status).toBe(401);
    expect((await GET(new Request(url, { headers: { cookie: headers.cookie } }), routeContext)).status).toBe(401);
    const current = await GET(new Request(url, { headers }), routeContext);
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ binding: { repositoryId: 42, enabled: true, revision: 1 } });
    const denied = await PUT(new Request(url, { method: "PUT", headers: { ...headers, "x-csrf-token": "wrong" }, body: JSON.stringify({ enabled: false, expectedRevision: 1 }) }), routeContext);
    expect(denied.status).toBe(403);
    const disabled = await PUT(new Request(url, { method: "PUT", headers, body: JSON.stringify({ enabled: false, expectedRevision: 1 }) }), routeContext);
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ binding: { enabled: false, revision: 2 } });
    const reenable = await PUT(new Request(url, { method: "PUT", headers, body: JSON.stringify({ enabled: true, expectedRevision: 2 }) }), routeContext);
    expect(reenable.status).toBe(400);
  });

  it("completes both browser callbacks with the same session and no edit key in URLs or cookies", async () => {
    const headers = await sessionHeaders();
    github([json(rawRepository)]);
    const { POST } = await import("@/app/api/auth/maker/github/route");
    const start = await POST(new Request("https://nomorevibe.test/api/auth/maker/github", { method: "POST", headers, body: JSON.stringify({ slug: "github-maker", deliveryConsent: true }) }));
    expect(start.status).toBe(200);
    const result = await start.json();
    expect(JSON.stringify(result)).not.toContain(editToken);
    const cookie = start.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).not.toContain(editToken);
    const callbackHeaders = { cookie: headers.cookie + "; " + cookie.split(";", 1)[0] };
    github([json(oauthTokens), json(rawRepository)]);
    const { GET: callback } = await import("@/app/api/auth/maker/github/callback/route");
    const oauth = await callback(new Request(`https://nomorevibe.test/api/auth/maker/github/callback?state=${new URL(result.authorizeUrl).searchParams.get("state")}&code=github-code`, { headers: callbackHeaders }));
    expect(oauth.status).toBe(307);
    const installUrl = oauth.headers.get("location")!;
    expect(installUrl).not.toContain(editToken);
    expect(oauth.headers.get("referrer-policy")).toBe("no-referrer");
    github(setupResponses());
    const { GET: setup } = await import("@/app/api/github/installations/setup/route");
    const completed = await setup(new Request(`https://nomorevibe.test/api/github/installations/setup?state=${new URL(installUrl).searchParams.get("state")}&installation_id=12&setup_action=install`, { headers: callbackHeaders }));
    expect(completed.status).toBe(307);
    expect(completed.headers.get("location")).toBe("https://nomorevibe.test/p/github-maker/github?connected=1");
    expect(completed.headers.get("location")).not.toContain(editToken);
    expect(completed.headers.get("set-cookie")).not.toContain("nmv_user=");
    expect(completed.headers.get("cache-control")).toBe("private, no-store");
  });
});

it("rechecks maker edit authorization inside the disable transaction after an edit key rotation", async () => {
  await db.insert(githubProductBindings).values(binding());
  const authorized = { editTokenHash: hashToken(editToken), productRepoUrl: repoUrl };
  await db.update(products).set({ editTokenHash: hashToken("rotated-key") }).where(eq(products.id, productId));
  await expect(disableProductGithubBinding(productId, "maker_disabled", 1, authorized)).rejects.toMatchObject({ code: "github_maker_authorization_changed" });
  expect((await db.select().from(githubProductBindings))[0]).toMatchObject({ enabled: true, revision: 1 });
});
