import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs, products } from "@/lib/db/schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import { githubAuthFlows, githubUserConnections } from "@/lib/db/github-user-schema";
import { githubMakerAuthContexts, githubProductBindings } from "@/lib/db/github-binding-schema";
import { githubIssueOutbox } from "@/lib/db/github-issue-outbox-schema";
import { githubIntegrationActions, githubWebhookEvents } from "@/lib/db/github-webhook-schema";
import { productFeedback } from "@/lib/db/product-feedback-schema";
import { feedbackFingerprint, normalizedFeedbackBodyHash } from "@/lib/domain/feedback/contract";
import { enqueueFeedbackIssue } from "@/lib/domain/feedback/github/enqueue";
import { beginFeedbackDispatch, claimFeedbackOutbox } from "@/lib/domain/feedback/github/outbox";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));
const feedbackSecret = "feedback-webhook-secret-at-least-32-bytes", starSecret = "star-webhook-secret-at-least-32-bytes";
const installation = { id: 12, app_id: 123, repository_selection: "selected", suspended_at: null, permissions: { issues: "write", metadata: "read" } };
const repository = { id: 42, owner: "Owner", repo: "Repo", fullName: "Owner/Repo", htmlUrl: "https://github.com/Owner/Repo", private: false, archived: false, hasIssues: true };
let productId: number, userId: number;
function signed(payload: unknown, event = "installation", app: "star" | "feedback" = "feedback", deliveryId = randomUUID()) {
  const raw = JSON.stringify(payload);
  return new Request("https://nomorevibe.test/api/github/webhooks/" + app, { method: "POST", headers: { "content-type": "application/json", "x-github-delivery": deliveryId,
    "x-github-event": event, "x-github-hook-installation-target-id": app === "feedback" ? "123" : "321",
    "x-hub-signature-256": "sha256=" + createHmac("sha256", app === "feedback" ? feedbackSecret : starSecret).update(raw).digest("hex") }, body: raw });
}
async function receive(request: Request, app: "star" | "feedback" = "feedback") {
  const { receiveGithubWebhook } = await import("@/lib/domain/github-webhooks/receive");
  return receiveGithubWebhook(request, app);
}
beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables(); await db.delete(githubWebhookEvents);
  await db.delete(jobs).where(inArray(jobs.name, ["github-feedback-delivery", "github-integration-reconcile"]));
  vi.stubEnv("GITHUB_FEEDBACK_APP_ID", "123"); vi.stubEnv("GITHUB_STAR_APP_ID", "321");
  vi.stubEnv("GITHUB_FEEDBACK_APP_WEBHOOK_SECRET", feedbackSecret); vi.stubEnv("GITHUB_STAR_APP_WEBHOOK_SECRET", starSecret);
  vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "true"); vi.stubEnv("PRODUCT_FEEDBACK_ENABLED", "true"); vi.stubEnv("GITHUB_FEEDBACK_DELIVERY_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://nomorevibe.test");
  [{ id: userId }] = await db.insert(publicUsers).values({ displayName: "Maker" }).returning({ id: publicUsers.id });
  [{ id: productId }] = await db.insert(products).values({ slug: "recovery-tool", name: "Recovery tool", url: "https://recovery.example", repoUrl: repository.htmlUrl, tagline: "Fixture", description: "Fixture", category: "Dev", status: "verified", verifyToken: "v", editTokenHash: "e" }).returning({ id: products.id });
  await db.insert(githubProductBindings).values({ productId, repositoryId: 42, repositoryFullName: repository.fullName, repositoryUrl: repository.htmlUrl, productRepoUrl: repository.htmlUrl, installationId: 12, consentedByUserId: userId, revision: 1, enabled: true });
});

describe("webhook HTTP and maintenance recovery", () => {
  it("retains binding rate limits and prohibits periodic or directly requested HTTP until retry time", async () => {
    const retryAt = Date.now() + 3_600_000;
    const { GithubInstallationError } = await import("@/lib/domain/github-installations/credentials");
    const { reconcileGithubBinding, dueGithubIntegrationTargets } = await import("@/lib/domain/github-webhooks/reconcile");
    const verify = vi.fn(async () => { throw new GithubInstallationError(503, "github_installation_rate_limited", { providerCode: "github_rate_limited", retryAt }); });
    await reconcileGithubBinding(productId, { verify, deadlineAt: Date.now() + 10_000 });
    const [row] = await db.execute<{ retryAt: Date }>(sql`select verification_retry_at as "retryAt" from github_product_bindings where product_id = ${productId}`);
    expect(new Date(row.retryAt).getTime()).toBe(retryAt);
    expect((await db.select().from(githubProductBindings))[0].enabled).toBe(true);
    const options = { verify, deadlineAt: Date.now() + 10_000 };
    expect(await dueGithubIntegrationTargets(options)).toEqual([]);
    expect(await reconcileGithubBinding(productId, options)).toBe("skipped");
    expect(verify).toHaveBeenCalledTimes(1);
  });
  it("resets an expired binding backoff after confirmed verification", async () => {
    await db.execute(sql`update github_product_bindings set verification_retry_at = now() - interval '1 second'`);
    const { reconcileGithubBinding } = await import("@/lib/domain/github-webhooks/reconcile");
    expect(await reconcileGithubBinding(productId, { verify: async () => ({ repository }), deadlineAt: Date.now() + 10_000 })).toBe("verified");
    expect((await db.execute<{ retry: Date | null }>(sql`select verification_retry_at as retry from github_product_bindings`))[0].retry).toBeNull();
  });
  it("clears prior backoff when a fresh maker consent activates the same exact repository", async () => {
    const flowId = await verifyingContext();
    await db.insert(githubProductBindings).values({ productId, repositoryId: 42, repositoryFullName: repository.fullName, repositoryUrl: repository.htmlUrl, productRepoUrl: repository.htmlUrl, installationId: 12, consentedByUserId: userId, revision: 1, enabled: true, verificationRetryAt: new Date(Date.now() + 3_600_000) });
    await db.update(githubMakerAuthContexts).set({ expectedRevision: 1 });
    const { completeProductGithubBinding } = await import("@/lib/domain/github-installations/bindings");
    expect(await completeProductGithubBinding({ flowId, actorUserId: userId, installationId: 12, repository })).toMatchObject({ enabled: true, revision: 2, verificationRetryAt: null });
  });
  it("retains linked issue rate limits and keeps admin requery from bypassing the read backoff", async () => {
    const row = await outbox("delivered"), retryAt = Date.now() + 3_600_000;
    const { reconcileLinkedGithubIssue, dueGithubIntegrationTargets } = await import("@/lib/domain/github-webhooks/reconcile");
    const request = vi.fn().mockResolvedValue({ outcome: "confirmed_rejection", status: 429, code: "github_rate_limited", retryAt, requestId: null });
    await reconcileLinkedGithubIssue(row.id, { request, token: tokenFixture, deadlineAt: Date.now() + 10_000 });
    expect((await db.select().from(githubIssueOutbox))[0].availableAt.getTime()).toBe(retryAt);
    await db.delete(githubProductBindings);
    const { requestGithubIntegrationRequery } = await import("@/lib/domain/github-webhooks/admin");
    await requestGithubIntegrationRequery({ requestId: randomUUID(), outboxId: row.id, expectedDispatchId: row.dispatchId, reason: "재조회", adminLogin: "operator" });
    expect(await dueGithubIntegrationTargets({ deadlineAt: Date.now() + 10_000 })).toEqual([]);
    expect(await reconcileLinkedGithubIssue(row.id, { request, token: tokenFixture, deadlineAt: Date.now() + 10_000 })).toBe("skipped");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("serializes receipt first: an in-flight first binding waits and is rejected after the receipt commits", async () => {
    const flowId = await verifyingContext();
    await db.insert(jobs).values({ name: "github-integration-reconcile" });
    const locked = deferred(), release = deferred();
    const held = db.transaction(async tx => { await tx.select().from(jobs).where(eq(jobs.name, "github-integration-reconcile")).for("update"); locked.resolve(); await release.promise; });
    await locked.promise;
    let received: Promise<unknown> | undefined, completed: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      received = receive(signed({ action: "deleted", installation }));
      await waitForInstallationLock();
      const { completeProductGithubBinding } = await import("@/lib/domain/github-installations/bindings");
      completed = Promise.allSettled([completeProductGithubBinding({ flowId, actorUserId: userId, installationId: 12, repository })]);
      await waitForAdvisoryWaiter();
      release.resolve(); await held; await received;
      expect((await completed)[0]).toMatchObject({ status: "rejected", reason: { code: "github_installation_revoked" } });
      expect(await db.select().from(githubProductBindings)).toHaveLength(0);
    } finally { release.resolve(); await held; await received?.catch(() => {}); await completed; }
  });
  it("serializes binding first: receipt waits for the first binding then immediately disables it", async () => {
    const flowId = await verifyingContext(), locked = deferred(), release = deferred();
    const held = db.transaction(async tx => { await tx.select().from(githubMakerAuthContexts).where(eq(githubMakerAuthContexts.flowId, flowId)).for("update"); locked.resolve(); await release.promise; });
    await locked.promise;
    let received: Promise<unknown> | undefined, completed: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const { completeProductGithubBinding } = await import("@/lib/domain/github-installations/bindings");
      completed = Promise.allSettled([completeProductGithubBinding({ flowId, actorUserId: userId, installationId: 12, repository })]);
      await waitForInstallationLock();
      received = receive(signed({ action: "deleted", installation }));
      await waitForAdvisoryWaiter();
      release.resolve(); await held; expect((await completed)[0].status).toBe("fulfilled"); await received;
      expect((await db.select().from(githubProductBindings))[0]).toMatchObject({ enabled: false, revision: 2, blockedReason: "github_installation_deleted" });
    } finally { release.resolve(); await held; await received?.catch(() => {}); await completed; }
  });
  it("detects a signed installation revocation committed before any binding existed", async () => {
    const verifiedAfter = new Date(Date.now() - 1000);
    await db.delete(githubProductBindings);
    await receive(signed({ action: "deleted", installation }));
    const { hasGithubInstallationRevocation } = await import("@/lib/domain/github-webhooks/lifecycle");
    expect(await db.transaction(tx => hasGithubInstallationRevocation(tx, { installationId: 12, repositoryId: 42, verifiedAfter }))).toBe(true);
  });
  it("rejects first-binding activation after a signed permissions object omits Issues", async () => {
    const flowId = await verifyingContext();
    await receive(signed({ action: "new_permissions_accepted", installation: { ...installation, permissions: { metadata: "read" } } }));
    const { completeProductGithubBinding } = await import("@/lib/domain/github-installations/bindings");
    await expect(completeProductGithubBinding({ flowId, actorUserId: userId, installationId: 12, repository })).rejects.toMatchObject({ code: "github_installation_revoked" });
    expect(await db.select().from(githubProductBindings)).toHaveLength(0);
  });
  it("scopes recent repository exclusion guards to the same repository and consent flow", async () => {
    const verifiedAfter = new Date(Date.now() - 1000);
    await receive(signed({ action: "removed", installation, repositories_removed: [{ id: 43 }] }, "installation_repositories"));
    const { hasGithubInstallationRevocation } = await import("@/lib/domain/github-webhooks/lifecycle");
    expect(await db.transaction(tx => hasGithubInstallationRevocation(tx, { installationId: 12, repositoryId: 42, verifiedAfter }))).toBe(false);
    expect(await db.transaction(tx => hasGithubInstallationRevocation(tx, { installationId: 12, repositoryId: 43, verifiedAfter }))).toBe(true);
    expect(await db.transaction(tx => hasGithubInstallationRevocation(tx, { installationId: 12, repositoryId: 43, verifiedAfter: new Date(Date.now() + 1000) }))).toBe(false);
  });
  it("acknowledges a signed webhook with 202 and rejects a tampered body without CSRF cookies", async () => {
    const { POST } = await import("@/app/api/github/webhooks/feedback/route");
    const response = await POST(signed({ action: "deleted", installation }));
    expect(response.status).toBe(202); expect(response.headers.get("cache-control")).toBe("private, no-store");
    const invalid = signed({ action: "created", installation }); invalid.headers.set("x-hub-signature-256", "sha256=" + "a".repeat(64));
    expect((await POST(invalid)).status).toBe(401);
  });
  it("cleans expired maker credentials before flags and makes no Star token or issue write request", async () => {
    const flowId = randomUUID(), hash = "a".repeat(64), expiresAt = new Date(Date.now() - 1000);
    await db.insert(githubAuthFlows).values({ id: flowId, purpose: "maker", actorUserId: userId, productId, stateHash: hash, browserNonceHash: hash, encryptedPkceVerifier: "fixture", expiresAt });
    await db.insert(githubMakerAuthContexts).values({ flowId, actorUserId: userId, productId, repositoryId: 42, productRepoUrl: repository.htmlUrl, editTokenHash: hash, expectedRevision: 1, browserNonceHash: hash, sessionTokenHash: hash, setupStateHash: hash, encryptedUserToken: "fixture-encrypted", state: "awaiting_setup", expiresAt });
    await db.delete(githubProductBindings);
    vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "false"); vi.stubEnv("GITHUB_STAR_ENABLED", "false"); vi.stubEnv("PRODUCT_FEEDBACK_ENABLED", "false"); vi.stubEnv("GITHUB_FEEDBACK_DELIVERY_ENABLED", "false");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const { reconcileGithubIntegrations } = await import("@/lib/jobs/github/integration-reconcile");
    await reconcileGithubIntegrations({ cursor: null, save: async () => {}, hasBudget: () => true, log: () => {} });
    expect((await db.select().from(githubMakerAuthContexts))[0]).toMatchObject({ state: "expired", encryptedUserToken: null, setupStateHash: null });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("authoritatively refreshes a linked issue after reverse-order events even after binding/flags are disabled", async () => {
    const row = await outbox("delivered");
    await receive(signed({ action: "reopened", installation: { id: 12 }, repository: { id: 42 }, issue: { id: 99, number: 7 } }, "issues"));
    await receive(signed({ action: "closed", installation: { id: 12 }, repository: { id: 42 }, issue: { id: 99, number: 7 } }, "issues"));
    await db.update(githubProductBindings).set({ enabled: false }); vi.stubEnv("GITHUB_FEEDBACK_DELIVERY_ENABLED", "false");
    const { reconcileLinkedGithubIssue } = await import("@/lib/domain/github-webhooks/reconcile");
    const request = vi.fn().mockResolvedValueOnce(ok(rawRepo)).mockResolvedValueOnce(ok(issue("open")));
    expect(await reconcileLinkedGithubIssue(row.id, { request, token: tokenFixture, deadlineAt: Date.now() + 10_000 })).toBe("open");
    expect((await db.select().from(githubIssueOutbox))[0]).toMatchObject({ state: "delivered", externalIssueState: "open", leaseToken: null });
    expect((await db.select().from(productFeedback))[0]).toMatchObject({ reviewState: "accepted", deliveryState: "delivered" });
    expect(request.mock.calls.every(call => !call[0].method || call[0].method === "GET")).toBe(true);
  });
  it("claims each linked issue read once across two maintenance instances", async () => {
    const row = await outbox("delivered");
    const { reconcileLinkedGithubIssue } = await import("@/lib/domain/github-webhooks/reconcile");
    const request = vi.fn().mockResolvedValueOnce(ok(rawRepo)).mockResolvedValueOnce(ok(issue("closed")));
    const results = await Promise.all([reconcileLinkedGithubIssue(row.id, { request, token: tokenFixture, deadlineAt: Date.now() + 10_000 }), reconcileLinkedGithubIssue(row.id, { request, token: tokenFixture, deadlineAt: Date.now() + 10_000 })]);
    expect(results.sort()).toEqual(["closed", "skipped"]); expect(request).toHaveBeenCalledTimes(2);
  });
  it("keeps a new issue event due when it arrives during a current HTTP read", async () => {
    const row = await outbox("delivered");
    const { reconcileLinkedGithubIssue } = await import("@/lib/domain/github-webhooks/reconcile");
    const request = vi.fn().mockResolvedValueOnce(ok(rawRepo)).mockImplementationOnce(async () => { await receive(signed({ action: "reopened", installation: { id: 12 }, repository: { id: 42 }, issue: { id: 99, number: 7 } }, "issues")); return ok(issue("closed")); });
    await reconcileLinkedGithubIssue(row.id, { request, token: tokenFixture, deadlineAt: Date.now() + 10_000 });
    expect((await db.select().from(githubIssueOutbox))[0].lastCheckedAt).toBeNull();
  });
  it("blocks confirmed missing installation permission but preserves in-flight uncertainty", async () => {
    const row = await outbox(), uncertain = await outbox("uncertain");
    const { GithubInstallationError } = await import("@/lib/domain/github-installations/credentials");
    const { reconcileGithubBinding } = await import("@/lib/domain/github-webhooks/reconcile");
    await reconcileGithubBinding(productId, { verify: async () => { throw new GithubInstallationError(409, "github_installation_permission_missing"); }, deadlineAt: Date.now() + 10_000 });
    expect((await db.select().from(githubProductBindings))[0]).toMatchObject({ enabled: false, revision: 2 });
    expect((await db.select().from(githubIssueOutbox).where(eq(githubIssueOutbox.id, row.id)))[0].state).toBe("cancelled");
    expect((await db.select().from(githubIssueOutbox).where(eq(githubIssueOutbox.id, uncertain.id)))[0].state).toBe("uncertain");
  });
  it("does not re-enable an installation revoked while its verification was in flight", async () => {
    const { reconcileGithubBinding } = await import("@/lib/domain/github-webhooks/reconcile");
    await reconcileGithubBinding(productId, { verify: async () => { await receive(signed({ action: "deleted", installation })); return { repository }; }, deadlineAt: Date.now() + 10_000 });
    expect((await db.select().from(githubProductBindings))[0]).toMatchObject({ enabled: false, revision: 2 });
  });
  it("caps a maintenance tick at 20 targets and does not POST", async () => {
    for (let i = 0; i < 25; i++) await outbox("delivered");
    await db.delete(githubProductBindings);
    await db.update(githubIssueOutbox).set({ lastCheckedAt: null });
    const { reconcileGithubIntegrations } = await import("@/lib/jobs/github/integration-reconcile");
    const request = vi.fn(async (input: { path: string }) => ok(input.path.startsWith("/repositories/") ? rawRepo : issue("closed")));
    await reconcileGithubIntegrations({ cursor: null, save: async () => {}, hasBudget: () => true, log: () => {} }, { request, token: tokenFixture });
    expect((await db.select().from(githubIssueOutbox).where(sql`last_checked_at IS NOT NULL`))).toHaveLength(20);
    expect(request).toHaveBeenCalledTimes(40);
  });
  it("keeps the tighter provider deadline supplied by uncertainty reconciliation", async () => {
    await outbox("uncertain"); await db.delete(githubProductBindings);
    vi.stubEnv("DB_CONNECT_TIMEOUT_SECONDS", "5");
    vi.spyOn(Date, "now").mockReturnValue(100_000);
    const { reconcileGithubIntegrations } = await import("@/lib/jobs/github/integration-reconcile");
    const token = vi.fn<(input: unknown, options?: { deadlineAt?: number }) => Promise<{ token: string; expiresAt: number }>>().mockResolvedValue({ token: "ghs_fixture", expiresAt: 160_000 });
    const request = vi.fn(async (input: { path: string }) => ok(input.path.startsWith("/repositories/") ? rawRepo : []));
    await reconcileGithubIntegrations({ cursor: null, save: async () => {}, hasBudget: () => true, log: () => {} }, { request, token });
    expect(token.mock.calls[0][1]?.deadlineAt).toBe(113_750);
  });
});
const rawRepo = { id: 42, name: "Repo", owner: { login: "Owner" }, full_name: "Owner/Repo", html_url: repository.htmlUrl, private: false, archived: false, has_issues: true };
const issue = (state: "open" | "closed") => ({ id: 99, number: 7, state, repository_url: "https://api.github.com/repos/Owner/Repo", url: "https://api.github.com/repos/Owner/Repo/issues/7", html_url: repository.htmlUrl + "/issues/7" });
const ok = (data: unknown) => ({ outcome: "confirmed_success" as const, status: 200, data, code: null, retryAt: null, requestId: null });
const tokenFixture = async () => ({ token: "ghs_fixture", expiresAt: Date.now() + 60_000 });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function eventually(check: () => Promise<boolean>) { const end = Date.now() + 2000; do { if (await check()) return; await new Promise(done => setTimeout(done, 5)); } while (Date.now() < end); throw new Error("fixture_lock_not_observed"); }
async function waitForInstallationLock() { await eventually(() => db.transaction(async tx => !(await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended('nmv-feedback-installation:12', 0)) as acquired`))[0].acquired)); }
async function waitForAdvisoryWaiter() { await eventually(async () => Number((await db.execute<{ count: string }>(sql`select count(*)::text from pg_stat_activity where datname = current_database() and wait_event = 'advisory'`))[0].count) > 0); }
async function verifyingContext() {
  await db.delete(githubProductBindings);
  const flowId = randomUUID(), hash = "a".repeat(64), expiresAt = new Date(Date.now() + 600_000);
  await db.update(products).set({ editTokenHash: hash });
  await db.insert(githubAuthFlows).values({ id: flowId, purpose: "maker", actorUserId: userId, productId, stateHash: hash, browserNonceHash: hash, encryptedPkceVerifier: "fixture", expiresAt });
  await db.insert(githubMakerAuthContexts).values({ flowId, actorUserId: userId, productId, repositoryId: 42, productRepoUrl: repository.htmlUrl, editTokenHash: hash, expectedRevision: 0, browserNonceHash: hash, sessionTokenHash: hash, githubUserId: 77, encryptedUserToken: "fixture", state: "verifying", expiresAt });
  return flowId;
}

describe("explicit administrator recovery requests", () => {
  function input(row: Awaited<ReturnType<typeof outbox>>) { return { requestId: randomUUID(), outboxId: row.id, expectedDispatchId: row.dispatchId, expectedBindingRevision: 1, expectedPayloadHash: row.payloadHash, adminLogin: "operator", reason: "GitHub 결과를 확인했고 중복 위험을 검토했습니다.", duplicateRiskAcknowledged: true }; }
  const verify = async () => ({ repository });
  it("signals a requery without modifying dispatch, payload or uncertain state", async () => {
    const row = await outbox("uncertain");
    const { requestGithubIntegrationRequery } = await import("@/lib/domain/github-webhooks/admin");
    const request = input(row);
    expect(await requestGithubIntegrationRequery(request)).toMatchObject({ duplicate: false });
    expect(await requestGithubIntegrationRequery(request)).toMatchObject({ duplicate: true });
    expect((await db.select().from(githubIssueOutbox))[0]).toMatchObject({ state: "uncertain", dispatchId: row.dispatchId, payloadHash: row.payloadHash });
    expect(await db.select().from(githubIntegrationActions)).toHaveLength(1);
    expect((await db.select().from(jobs).where(eq(jobs.name, "github-integration-reconcile")))[0].requestedVersion).toBe(1);
  });
  it("permits one explicit new dispatch for the same repo after live verification, with immutable audit and a new marker", async () => {
    const row = await outbox("uncertain");
    const { requestGithubIntegrationRetransmit } = await import("@/lib/domain/github-webhooks/admin");
    const request = input(row), preflight = vi.fn(verify);
    expect(await requestGithubIntegrationRetransmit(request, { verify: preflight })).toMatchObject({ duplicate: false });
    const updated = (await db.select().from(githubIssueOutbox))[0];
    expect(updated).toMatchObject({ state: "queued", repositoryId: 42, attempts: 0, githubIssueId: null });
    expect(updated.dispatchId).not.toBe(row.dispatchId); expect(updated.payloadBody).toContain(updated.dispatchId); expect(updated.payloadHash).not.toBe(row.payloadHash);
    expect(updated.payloadBody.replace(updated.dispatchId, row.dispatchId)).toBe(row.payloadBody);
    expect((await db.select().from(githubIntegrationActions))[0]).toMatchObject({ previousDispatchId: row.dispatchId, payloadHash: row.payloadHash, previousState: "uncertain", adminLogin: "operator", duplicateRiskAcknowledged: true });
    expect(await requestGithubIntegrationRetransmit(request, { verify: preflight })).toMatchObject({ duplicate: true });
    expect(preflight).toHaveBeenCalledTimes(1);
  });
  it("serializes two different explicit recovery forms for the same old dispatch", async () => {
    const row = await outbox("uncertain");
    const { requestGithubIntegrationRetransmit } = await import("@/lib/domain/github-webhooks/admin");
    const results = await Promise.allSettled([requestGithubIntegrationRetransmit(input(row), { verify }), requestGithubIntegrationRetransmit(input(row), { verify })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(githubIntegrationActions)).toHaveLength(1);
  });
  it.each(["risk", "flags", "different_repo", "revision", "payload", "consent", "sending", "read_backoff", "live_permission", "repository_changed_during_verify"])("rejects %s without queuing a new request", async kind => {
    const row = await outbox(kind === "sending" ? "sending" : "uncertain");
    const request = input(row);
    if (kind === "risk") request.duplicateRiskAcknowledged = false;
    if (kind === "flags") vi.stubEnv("GITHUB_FEEDBACK_DELIVERY_ENABLED", "false");
    if (kind === "different_repo") await db.update(githubProductBindings).set({ repositoryId: 43 });
    if (kind === "revision") request.expectedBindingRevision = 2;
    if (kind === "payload") request.expectedPayloadHash = "a".repeat(64);
    if (kind === "consent") await db.update(productFeedback).set({ githubDisclosureConsent: false, sendToGithub: false });
    if (kind === "read_backoff") await db.update(githubProductBindings).set({ verificationRetryAt: new Date(Date.now() + 3_600_000) });
    const { GithubInstallationError } = await import("@/lib/domain/github-installations/credentials");
    const check = async () => { if (kind === "live_permission") throw new GithubInstallationError(409, "github_installation_permission_missing"); if (kind === "repository_changed_during_verify") await db.update(products).set({ repoUrl: "https://github.com/Owner/Other" }); return { repository }; };
    const { requestGithubIntegrationRetransmit } = await import("@/lib/domain/github-webhooks/admin");
    await expect(requestGithubIntegrationRetransmit(request, { verify: check })).rejects.toThrow();
    expect((await db.select().from(githubIssueOutbox))[0]).toMatchObject({ dispatchId: row.dispatchId, state: row.state });
    expect(await db.select().from(githubIntegrationActions)).toHaveLength(0);
  });
  it("rolls back the new dispatch and audit when the worker signal fails", async () => {
    const row = await outbox("uncertain");
    const control = await import("@/lib/jobs/control"); vi.spyOn(control, "requestJob").mockRejectedValueOnce(new Error("fixture_signal_failed"));
    const { requestGithubIntegrationRetransmit } = await import("@/lib/domain/github-webhooks/admin");
    await expect(requestGithubIntegrationRetransmit(input(row), { verify })).rejects.toThrow("fixture_signal_failed");
    expect((await db.select().from(githubIssueOutbox))[0]).toMatchObject({ dispatchId: row.dispatchId, state: "uncertain" });
    expect(await db.select().from(githubIntegrationActions)).toHaveLength(0);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
async function outbox(state: "queued" | "sending" | "uncertain" | "delivered" = "queued") {
  const input = { requestId: randomUUID(), kind: "bug" as const, title: "Recovery fixture", body: "Fixture content", serviceDisclosureConsent: true, sendToGithub: true, githubDisclosureConsent: true };
  const [feedback] = await db.insert(productFeedback).values({ productId, authorUserId: userId, ...input, requestHash: feedbackFingerprint(productId, input), normalizedBodyHash: normalizedFeedbackBodyHash(input.body), githubDeliveryEligible: true, reviewState: "accepted" }).returning();
  const queued = await db.transaction(tx => enqueueFeedbackIssue(tx, feedback));
  const [row] = await db.update(githubIssueOutbox).set({ state, ...(state === "sending" ? { leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 45_000), dispatchedAt: new Date() } : {}), ...(state === "delivered" ? { githubIssueId: 99, githubIssueNumber: 7, githubIssueUrl: repository.htmlUrl + "/issues/7", externalIssueState: "open", lastCheckedAt: new Date() } : {}) }).where(eq(githubIssueOutbox.id, queued!.id)).returning();
  await db.update(productFeedback).set({ deliveryState: state }).where(eq(productFeedback.id, feedback.id));
  return row;
}

describe("signed webhook receipt and immediate revocation", () => {
  it("deduplicates one delivery and one job signal across two web instances", async () => {
    const request = signed({ action: "deleted", installation });
    const results = await Promise.all([receive(request.clone()), receive(request)]);
    expect(results.filter(result => result.duplicate)).toHaveLength(1);
    expect(await db.select().from(githubWebhookEvents)).toHaveLength(1);
    expect((await db.select().from(jobs).where(eq(jobs.name, "github-integration-reconcile")))[0].requestedVersion).toBe(1);
    expect((await db.select().from(githubProductBindings))[0]).toMatchObject({ enabled: false, revision: 2 });
  });

  it("rejects a changed payload under an already accepted delivery ID", async () => {
    const id = randomUUID();
    await receive(signed({ action: "created", installation }, "installation", "feedback", id));
    await expect(receive(signed({ action: "deleted", installation }, "installation", "feedback", id))).rejects.toMatchObject({ code: "github_webhook_delivery_conflict" });
    expect((await db.select().from(githubProductBindings))[0].enabled).toBe(true);
  });

  it.each(["deleted", "suspend", "permission_removed", "repository_removed"])("blocks %s and cancels only unsent rows before returning", async kind => {
    const queued = await outbox(), sending = await outbox("sending"), uncertain = await outbox("uncertain");
    const event = kind === "repository_removed" ? "installation_repositories" : "installation";
    const payload = kind === "repository_removed" ? { action: "removed", installation, repositories_removed: [{ id: 42 }] }
      : { action: kind === "permission_removed" ? "new_permissions_accepted" : kind, installation: kind === "permission_removed" ? { ...installation, permissions: { issues: "read" } } : installation };
    await receive(signed(payload, event));
    expect((await db.select().from(githubProductBindings))[0]).toMatchObject({ enabled: false, revision: 2 });
    expect((await db.select().from(githubIssueOutbox).where(eq(githubIssueOutbox.id, queued.id)))[0].state).toBe("cancelled");
    expect((await db.select().from(githubIssueOutbox).where(eq(githubIssueOutbox.id, sending.id)))[0].state).toBe("sending");
    expect((await db.select().from(githubIssueOutbox).where(eq(githubIssueOutbox.id, uncertain.id)))[0].state).toBe("uncertain");
  });

  it("disables a binding and cancels only queued rows before 202 when Issues is omitted from permissions", async () => {
    const queued = await outbox(), sending = await outbox("sending"), uncertain = await outbox("uncertain");
    const { POST } = await import("@/app/api/github/webhooks/feedback/route");
    expect((await POST(signed({ action: "new_permissions_accepted", installation: { ...installation, permissions: { metadata: "read" } } }))).status).toBe(202);
    expect((await db.select().from(githubProductBindings))[0]).toMatchObject({ enabled: false, revision: 2, blockedReason: "github_installation_permission_removed" });
    expect((await db.select().from(githubIssueOutbox).where(eq(githubIssueOutbox.id, queued.id)))[0].state).toBe("cancelled");
    expect((await db.select().from(githubIssueOutbox).where(eq(githubIssueOutbox.id, sending.id)))[0].state).toBe("sending");
    expect((await db.select().from(githubIssueOutbox).where(eq(githubIssueOutbox.id, uncertain.id)))[0].state).toBe("uncertain");
  });

  it("does not disable an unrelated repository removed from the same installation", async () => {
    await receive(signed({ action: "removed", installation, repositories_removed: [{ id: 43 }] }, "installation_repositories"));
    expect((await db.select().from(githubProductBindings))[0]).toMatchObject({ enabled: true, revision: 1 });
  });

  it("prevents a previously claimed dispatch from entering sending after receipt commits", async () => {
    await outbox(); const claim = (await claimFeedbackOutbox())!;
    await receive(signed({ action: "deleted", installation }));
    expect(await beginFeedbackDispatch(claim, repository)).toBeNull();
    expect((await db.select().from(githubIssueOutbox))[0].state).toBe("cancelled");
  });

  it("invalidates the matching Star user credentials even when feature flags have been switched off", async () => {
    await db.insert(githubUserConnections).values({ userId, githubUserId: 77, githubLogin: "maker", state: "active", encryptedAccessToken: "encrypted-access", encryptedRefreshToken: "encrypted-refresh", revision: 1 });
    vi.stubEnv("PUBLIC_USER_AUTH_ENABLED", "false"); vi.stubEnv("GITHUB_STAR_ENABLED", "false");
    await receive(signed({ action: "revoked", sender: { id: 77 } }, "github_app_authorization", "star"), "star");
    expect((await db.select().from(githubUserConnections))[0]).toMatchObject({ state: "needs_reconnect", revision: 2, encryptedAccessToken: null, encryptedRefreshToken: null });
  });

  it("clears only the revoked Feedback OAuth user's temporary contexts and conservatively clears legacy unidentified contexts", async () => {
    const makeContext = async (githubUserId: number | null) => {
      const flowId = randomUUID(), hash = "a".repeat(64), expiresAt = new Date(Date.now() + 600_000);
      await db.insert(githubAuthFlows).values({ id: flowId, purpose: "maker", actorUserId: userId, productId, stateHash: flowId.replace(/-/g, "").padEnd(64, "a"), browserNonceHash: hash, encryptedPkceVerifier: "fixture", expiresAt });
      await db.insert(githubMakerAuthContexts).values({ flowId, actorUserId: userId, productId, repositoryId: 42, productRepoUrl: repository.htmlUrl, editTokenHash: hash, expectedRevision: 1, browserNonceHash: hash, sessionTokenHash: hash, githubUserId, encryptedUserToken: "fixture", state: "awaiting_setup", expiresAt });
      return flowId;
    };
    const match = await makeContext(77), unrelated = await makeContext(88), legacy = await makeContext(null);
    await db.insert(githubUserConnections).values({ userId, githubUserId: 88, githubLogin: "star-other-account", state: "active", encryptedAccessToken: "star-access", encryptedRefreshToken: "star-refresh" });
    await receive(signed({ action: "revoked", sender: { id: 77 } }, "github_app_authorization"));
    for (const id of [match, legacy]) expect((await db.select().from(githubMakerAuthContexts).where(eq(githubMakerAuthContexts.flowId, id)))[0]).toMatchObject({ state: "failed", encryptedUserToken: null });
    expect((await db.select().from(githubMakerAuthContexts).where(eq(githubMakerAuthContexts.flowId, unrelated)))[0]).toMatchObject({ state: "awaiting_setup", encryptedUserToken: "fixture" });
    expect((await db.select().from(githubUserConnections))[0]).toMatchObject({ state: "active", encryptedAccessToken: "star-access" });
  });

  it("marks linked issue reads due without applying out-of-order closed/reopened payload state", async () => {
    const row = await outbox("delivered");
    await receive(signed({ action: "reopened", installation: { id: 12 }, repository: { id: 42 }, issue: { id: 99, number: 7, state: "open" } }, "issues"));
    await receive(signed({ action: "closed", installation: { id: 12 }, repository: { id: 42 }, issue: { id: 99, number: 7, state: "closed" } }, "issues"));
    expect((await db.select().from(githubIssueOutbox).where(eq(githubIssueOutbox.id, row.id)))[0]).toMatchObject({ externalIssueState: "open", lastCheckedAt: null });
  });

  it("rolls back the receipt, revocation and queue cancellation if the job signal fails", async () => {
    await outbox();
    const control = await import("@/lib/jobs/control");
    vi.spyOn(control, "requestJob").mockRejectedValueOnce(new Error("fixture_signal_failed"));
    await expect(receive(signed({ action: "deleted", installation }))).rejects.toThrow("fixture_signal_failed");
    expect(await db.select().from(githubWebhookEvents)).toHaveLength(0);
    expect((await db.select().from(githubProductBindings))[0]).toMatchObject({ enabled: true, revision: 1 });
    expect((await db.select().from(githubIssueOutbox))[0].state).toBe("queued");
  });

  it("processes a persisted event once across two maintenance instances", async () => {
    await receive(signed({ action: "created", installation }));
    const { processGithubWebhookEvents } = await import("@/lib/domain/github-webhooks/process");
    const results = await Promise.all([processGithubWebhookEvents(), processGithubWebhookEvents()]);
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect((await db.select().from(githubWebhookEvents))[0].processedAt).not.toBeNull();
  });
});
