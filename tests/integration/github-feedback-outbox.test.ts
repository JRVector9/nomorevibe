import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { jobs, products, rateLimits } from "@/lib/db/schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import { productFeedback } from "@/lib/db/product-feedback-schema";
import { githubMakerAuthContexts, githubProductBindings } from "@/lib/db/github-binding-schema";
import { githubAuthFlows } from "@/lib/db/github-user-schema";
import { githubIssueOutbox } from "@/lib/db/github-issue-outbox-schema";
import { submitFeedback } from "@/lib/domain/feedback/submit";
import { reviewFeedback } from "@/lib/domain/feedback/review";
import { getFeedback, listMyFeedback, listProductFeedback } from "@/lib/domain/feedback/repository";
import { enqueueFeedbackIssue } from "@/lib/domain/feedback/github/enqueue";
import { beginFeedbackDispatch, cancelBindingFeedbackOutbox, claimFeedbackOutbox, completeFeedbackDispatch, expireFeedbackDispatches } from "@/lib/domain/feedback/github/outbox";
import { deliverFeedbackIssue } from "@/lib/domain/feedback/github/deliver";
import { feedbackIssueMarker } from "@/lib/domain/feedback/github/issue-body";
import { reconcileFeedbackIssue } from "@/lib/domain/feedback/github/reconcile";
import { GithubInstallationError } from "@/lib/domain/github-installations/credentials";
import { feedbackSql, setFeedbackTransactionDeadline } from "@/lib/domain/feedback/github/database";
import { completeProductGithubBinding, disableProductGithubBinding, getProductGithubBinding } from "@/lib/domain/github-installations/bindings";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));
beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(rateLimits).where(sql`${rateLimits.key} like 'feedback:%' or ${rateLimits.key} like 'github-issue:%'`);
  await db.delete(jobs).where(eq(jobs.name, "github-feedback-delivery"));
  vi.stubEnv("GITHUB_FEEDBACK_DELIVERY_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://nomorevibe.example");
});

const repository = { id: 123, owner: "acme", repo: "tool", fullName: "acme/tool", htmlUrl: "https://github.com/acme/tool", private: false, archived: false, hasIssues: true };
async function seed(options: { autoEnqueue?: boolean; body?: string } = {}) {
  const [product] = await db.insert(products).values({ slug: "outbox-tool", name: "Tool", url: "https://outbox.example", repoUrl: repository.htmlUrl,
    tagline: "Tool", description: "Tool", category: "Dev", status: "verified", verifyToken: "v", editTokenHash: "e" }).returning();
  const [author] = await db.insert(publicUsers).values({ displayName: "작성자" }).returning();
  const [binding] = await db.insert(githubProductBindings).values({ productId: product.id, repositoryId: repository.id, repositoryFullName: repository.fullName,
    repositoryUrl: repository.htmlUrl, productRepoUrl: repository.htmlUrl, installationId: 456, consentedByUserId: author.id, enabled: true, revision: 1 }).returning();
  const result = await submitFeedback(product.slug, author.id, { requestId: randomUUID(), kind: "bug", title: "설치 오류", body: options.body ?? "설치가 실패합니다.",
    serviceDisclosureConsent: true, sendToGithub: true, githubDisclosureConsent: true }, options.autoEnqueue ? {} : { onAccepted: async () => {} });
  const feedback = options.autoEnqueue ? result.feedback : (await db.update(productFeedback).set({ githubDeliveryEligible: true }).where(eq(productFeedback.id, result.feedback.id)).returning())[0];
  return { product, author, binding, feedback };
}

async function queued() {
  const fixture = await seed();
  const outbox = await db.transaction((tx) => enqueueFeedbackIssue(tx, fixture.feedback));
  if (!outbox) throw new Error("fixture_outbox_missing");
  return { ...fixture, outbox };
}

function issue(row: { feedbackId: string; dispatchId: string }) {
  return { id: 88, number: 7, url: "https://api.github.com/repos/acme/tool/issues/7", repository_url: "https://api.github.com/repos/acme/tool",
    html_url: "https://github.com/acme/tool/issues/7", state: "open", body: feedbackIssueMarker(row.feedbackId, row.dispatchId) };
}

const adapters = {
  verify: async () => ({ repository }),
  token: async () => ({ token: "installation_test_token_123456", expiresAt: Date.now() + 3600_000 }),
};

describe("feedback transactional GitHub outbox", () => {
  it("uses the default accepted hook atomically and returns refreshed queued feedback", async () => {
    const { feedback } = await seed({ autoEnqueue: true });
    expect(feedback.githubDeliveryEligible).toBe(true);
    expect(feedback.deliveryState).toBe("queued");
    expect(await db.select().from(githubIssueOutbox)).toHaveLength(1);
    expect((await db.select().from(jobs).where(eq(jobs.name, "github-feedback-delivery")))[0].requestedVersion).toBe(1);
  });

  it("queues consented held feedback only after individual administrator approval", async () => {
    const { feedback } = await seed({ autoEnqueue: true, body: "https://a.test https://b.test https://c.test https://d.test" });
    expect(feedback.reviewState).toBe("held");
    expect(await db.select().from(githubIssueOutbox)).toEqual([]);
    const approved = await reviewFeedback({ expectedReviewState: "held", id: feedback.id, decision: "accepted", reason: "관련 문서 확인", adminLogin: "reviewer" });
    expect(approved.deliveryState).toBe("queued");
    expect(await db.select().from(githubIssueOutbox)).toHaveLength(1);
  });

  it("keeps creation-time ineligible feedback local when the delivery flag is later enabled", async () => {
    vi.stubEnv("GITHUB_FEEDBACK_DELIVERY_ENABLED", "false");
    const { feedback } = await seed({ autoEnqueue: true, body: "https://a.test https://b.test https://c.test https://d.test" });
    // seed's explicit eligibility update is only for lower-level queue fixtures.
    const [stored] = await db.select().from(productFeedback);
    expect(stored.githubDeliveryEligible).toBe(false);
    vi.stubEnv("GITHUB_FEEDBACK_DELIVERY_ENABLED", "true");
    const approved = await reviewFeedback({ expectedReviewState: "held", id: feedback.id, decision: "accepted", reason: "관련 문서 확인", adminLogin: "reviewer" });
    expect(approved.deliveryState).toBe("local_only");
    expect(await db.select().from(githubIssueOutbox)).toEqual([]);
  });

  it("projects only safe issue URL, external state and error fields through existing visibility rules", async () => {
    const { author, product, feedback, outbox } = await queued();
    await db.update(githubIssueOutbox).set({ state: "delivered", githubIssueId: 88, githubIssueNumber: 7,
      githubIssueUrl: "https://github.com/acme/renamed/issues/7", externalIssueState: "closed", lastErrorCode: null }).where(eq(githubIssueOutbox.id, outbox.id));
    await db.update(productFeedback).set({ deliveryState: "delivered" }).where(eq(productFeedback.id, feedback.id));
    for (const item of [await getFeedback(feedback.id), (await listProductFeedback(product.slug))[0], (await listMyFeedback(author.id))[0]]) {
      expect(item).toMatchObject({ githubIssueUrl: "https://github.com/acme/renamed/issues/7", externalIssueState: "closed", lastErrorCode: null });
      expect(item).not.toHaveProperty("payloadBody");
      expect(item).not.toHaveProperty("installationId");
    }
    await db.update(productFeedback).set({ reviewState: "held" }).where(eq(productFeedback.id, feedback.id));
    expect(await getFeedback(feedback.id)).toBeNull();
    expect(await listProductFeedback(product.slug)).toEqual([]);
    expect(await getFeedback(feedback.id, { userId: author.id })).toMatchObject({ externalIssueState: "closed" });
    await db.update(githubIssueOutbox).set({ githubIssueUrl: "javascript:alert(1)", lastErrorCode: "raw token=secret" }).where(eq(githubIssueOutbox.id, outbox.id));
    expect(await getFeedback(feedback.id, { admin: true })).toMatchObject({ githubIssueUrl: null, lastErrorCode: null });
  });

  it("rolls back feedback and quotas when the default enqueue fails", async () => {
    const fixture = await seed();
    await db.delete(productFeedback).where(eq(productFeedback.id, fixture.feedback.id));
    await db.delete(rateLimits).where(sql`${rateLimits.key} like 'feedback:%'`);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://wrong.example/path");
    await expect(submitFeedback(fixture.product.slug, fixture.author.id, { requestId: randomUUID(), kind: "bug", title: "오류", body: "다른 오류",
      serviceDisclosureConsent: true, sendToGithub: true, githubDisclosureConsent: true })).rejects.toThrow("feedback_site_origin_invalid");
    expect(await db.select().from(productFeedback)).toEqual([]);
    expect(await db.select().from(githubIssueOutbox)).toEqual([]);
    expect(await db.select().from(rateLimits).where(sql`${rateLimits.key} like 'feedback:%'`)).toEqual([]);
  });

  it.each(["disable", "mismatch", "complete"])("cancels pending rows atomically on binding %s while preserving in-flight uncertainty", async (operation) => {
    const { feedback, outbox, product, author, binding } = await queued();
    for (const state of ["retry_wait", "sending", "uncertain"] as const) {
      const [copy] = await db.insert(productFeedback).values({ ...feedback, id: randomUUID(), requestId: randomUUID(), deliveryState: state }).returning();
      await db.insert(githubIssueOutbox).values({ ...outbox, id: randomUUID(), feedbackId: copy.id, dispatchId: randomUUID(), state });
    }
    if (operation === "disable") await disableProductGithubBinding(product.id, "installation_removed");
    else if (operation === "mismatch") {
      await db.update(products).set({ repoUrl: "https://github.com/acme/changed" }).where(eq(products.id, product.id));
      await getProductGithubBinding(product.id);
    } else {
      const flowId = randomUUID();
      await db.insert(githubAuthFlows).values({ id: flowId, purpose: "maker", actorUserId: author.id, productId: product.id, browserNonceHash: "b".repeat(64), encryptedPkceVerifier: "encrypted-fixture",
        stateHash: "t".repeat(64), expiresAt: new Date(Date.now() + 60_000), returnTo: `/p/${product.slug}` });
      await db.insert(githubMakerAuthContexts).values({ flowId, actorUserId: author.id, productId: product.id, repositoryId: repository.id, productRepoUrl: product.repoUrl!,
        editTokenHash: product.editTokenHash!, expectedRevision: binding.revision, browserNonceHash: "b".repeat(64), sessionTokenHash: "s".repeat(64),
        state: "verifying", expiresAt: new Date(Date.now() + 60_000) });
      await completeProductGithubBinding({ flowId, actorUserId: author.id, installationId: 457, repository });
    }
    const rows = await db.select().from(githubIssueOutbox);
    expect(rows.filter((row) => row.state === "cancelled")).toHaveLength(2);
    expect(rows.filter((row) => row.state === "sending")).toHaveLength(1);
    expect(rows.filter((row) => row.state === "uncertain")).toHaveLength(1);
    expect((await db.select().from(productFeedback)).filter((row) => row.deliveryState === "cancelled")).toHaveLength(2);
  });

  it("enqueues one row and one signal even when two transactions enqueue the same feedback", async () => {
    const { feedback } = await seed();
    const rows = await Promise.all([db.transaction((tx) => enqueueFeedbackIssue(tx, feedback)), db.transaction((tx) => enqueueFeedbackIssue(tx, feedback))]);
    expect(new Set(rows.map((row) => row?.id)).size).toBe(1);
    expect(await db.select().from(githubIssueOutbox)).toHaveLength(1);
    expect((await db.select().from(jobs).where(eq(jobs.name, "github-feedback-delivery")))[0].requestedVersion).toBe(1);
    expect((await db.select().from(productFeedback))[0].deliveryState).toBe("queued");
  });

  it("keeps historical, held, opt-out, unbound and disabled-flag feedback local", async () => {
    const { feedback } = await seed();
    for (const change of [{ githubDeliveryEligible: false }, { reviewState: "held" as const }, { sendToGithub: false }]) {
      await db.update(productFeedback).set(change).where(eq(productFeedback.id, feedback.id));
      await expect(db.transaction((tx) => enqueueFeedbackIssue(tx, feedback))).resolves.toBeNull();
      await db.update(productFeedback).set({ githubDeliveryEligible: true, reviewState: "accepted", sendToGithub: true }).where(eq(productFeedback.id, feedback.id));
    }
    vi.stubEnv("GITHUB_FEEDBACK_DELIVERY_ENABLED", "false");
    await expect(db.transaction((tx) => enqueueFeedbackIssue(tx, feedback))).resolves.toBeNull();
    vi.stubEnv("GITHUB_FEEDBACK_DELIVERY_ENABLED", "true");
    await db.update(githubProductBindings).set({ enabled: false }).where(eq(githubProductBindings.productId, feedback.productId));
    await expect(db.transaction((tx) => enqueueFeedbackIssue(tx, feedback))).resolves.toBeNull();
    expect(await db.select().from(githubIssueOutbox)).toEqual([]);
  });

  it("atomically rolls back the queue, signal and feedback state", async () => {
    const { feedback } = await seed();
    await expect(db.transaction(async (tx) => { await enqueueFeedbackIssue(tx, feedback); throw new Error("rollback"); })).rejects.toThrow("rollback");
    expect(await db.select().from(githubIssueOutbox)).toEqual([]);
    expect(await db.select().from(jobs).where(eq(jobs.name, "github-feedback-delivery"))).toEqual([]);
    expect((await db.select().from(productFeedback))[0].deliveryState).toBe("local_only");
  });

  it("allows only one worker to claim a due row", async () => {
    await queued();
    const claims = await Promise.all([claimFeedbackOutbox(), claimFeedbackOutbox()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    expect(claim.leaseToken).not.toBeNull();
    expect(claim.dispatchedAt).toBeNull();
  });

  it("bounds cumulative SQL work by the remaining transaction deadline and rolls back writes", async () => {
    const { outbox } = await queued();
    const started = Date.now();
    await expect(db.transaction(async (tx) => {
      const deadlineAt = Date.now() + 400;
      await setFeedbackTransactionDeadline(tx, deadlineAt);
      await tx.update(githubIssueOutbox).set({ state: "blocked" }).where(eq(githubIssueOutbox.id, outbox.id));
      await feedbackSql(tx, deadlineAt, () => tx.execute(sql`select pg_sleep(0.2)`));
      await feedbackSql(tx, deadlineAt, () => tx.execute(sql`select pg_sleep(0.2)`));
    })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
    expect((await db.select().from(githubIssueOutbox))[0].state).toBe("queued");
  });

  it("waits for the product before holding binding or feedback locks during dispatch", async () => {
    const { product, binding } = await queued();
    const claim = (await claimFeedbackOutbox())!;
    let releaseProduct!: () => void;
    let productLocked!: () => void;
    const ready = new Promise<void>((resolve) => { productLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseProduct = resolve; });
    const invalidation = db.transaction(async (tx) => {
      await tx.select({ id: products.id }).from(products).where(eq(products.id, product.id)).for("update");
      productLocked();
      await release;
    });
    await ready;
    const dispatch = beginFeedbackDispatch(claim, repository);
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const rows = await db.execute(sql`select 1 from pg_stat_activity where datname = current_database()
          and wait_event_type = 'Lock' and query ilike '%products%' and query ilike '%for share%'`);
        if (rows.length) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await expect(db.transaction((tx) => tx.select({ id: githubProductBindings.productId }).from(githubProductBindings)
        .where(eq(githubProductBindings.productId, binding.productId)).for("update", { noWait: true }))).resolves.toHaveLength(1);
    } finally {
      releaseProduct();
      await invalidation;
      await dispatch;
    }
  });

  it("records a sending attempt before HTTP and holds no SQL lock during the request", async () => {
    const { outbox } = await queued();
    const claim = (await claimFeedbackOutbox())!;
    let observedSending = false;
    const result = await deliverFeedbackIssue(claim, { ...adapters, deadlineAt: Date.now() + 10_000, request: async () => {
      const [during] = await db.select().from(githubIssueOutbox).where(eq(githubIssueOutbox.id, outbox.id));
      observedSending = during.state === "sending" && !!during.attemptId && !!during.dispatchedAt;
      // The dispatch transaction is committed; another connection can lock this row now.
      await db.transaction(async (tx) => { await tx.execute(sql`set local lock_timeout = '500ms'`); await tx.select().from(githubIssueOutbox).where(eq(githubIssueOutbox.id, outbox.id)).for("update"); });
      return { outcome: "confirmed_success", status: 201, retryAt: null, requestId: null, code: null, data: issue(outbox) };
    } });
    expect(observedSending).toBe(true);
    expect(result).toBe("delivered");
    expect((await db.select().from(githubIssueOutbox))[0]).toMatchObject({ state: "delivered", githubIssueId: 88, githubIssueNumber: 7 });
  });

  it("leaves unknown HTTP outcomes uncertain and never reclaims them for POST", async () => {
    await queued();
    const claim = (await claimFeedbackOutbox())!;
    await deliverFeedbackIssue(claim, { ...adapters, deadlineAt: Date.now() + 10_000,
      request: async () => ({ outcome: "unknown", status: 503, retryAt: null, requestId: null, code: "github_server_error" }) });
    expect((await db.select().from(githubIssueOutbox))[0].state).toBe("uncertain");
    expect(await claimFeedbackOutbox()).toBeNull();
  });

  it("fences a late result after a sending lease expires and marks the crash uncertain", async () => {
    await queued();
    const claim = (await claimFeedbackOutbox())!;
    const started = await beginFeedbackDispatch(claim, repository);
    expect(started).not.toBeNull();
    await db.update(githubIssueOutbox).set({ leaseExpiresAt: new Date(0) }).where(eq(githubIssueOutbox.id, claim.id));
    await expireFeedbackDispatches();
    expect(await completeFeedbackDispatch(claim, { state: "delivered", issue: { id: 88, number: 7, url: repository.htmlUrl + "/issues/7", state: "open" }, errorCode: null, retryAt: null })).toBe(false);
    expect((await db.select().from(githubIssueOutbox))[0].state).toBe("uncertain");
    expect(await claimFeedbackOutbox()).toBeNull();
  });

  it("respects confirmed rate-limit timing before another attempt", async () => {
    await queued();
    const retryAt = Date.now() + 3600_000;
    const claim = (await claimFeedbackOutbox())!;
    await deliverFeedbackIssue(claim, { ...adapters, deadlineAt: Date.now() + 10_000,
      request: async () => ({ outcome: "confirmed_rejection", status: 429, retryAt, requestId: null, code: "github_rate_limited" }) });
    const [row] = await db.select().from(githubIssueOutbox);
    expect(row.state).toBe("retry_wait");
    expect(row.availableAt.getTime()).toBeGreaterThanOrEqual(retryAt);
    expect(await claimFeedbackOutbox()).toBeNull();
  });

  it("rejects binding revision changes before any POST", async () => {
    const { binding } = await queued();
    const claim = (await claimFeedbackOutbox())!;
    await db.update(githubProductBindings).set({ revision: binding.revision + 1 }).where(eq(githubProductBindings.productId, binding.productId));
    expect(await beginFeedbackDispatch(claim, repository)).toBeNull();
    expect((await db.select().from(githubIssueOutbox))[0].state).toBe("blocked");
  });

  it("rejects altered original content before any POST", async () => {
    const { feedback } = await queued();
    const claim = (await claimFeedbackOutbox())!;
    await db.update(productFeedback).set({ body: "changed original" }).where(eq(productFeedback.id, feedback.id));
    const request = vi.fn();
    expect(await deliverFeedbackIssue(claim, { ...adapters, request, deadlineAt: Date.now() + 10_000 })).toBe("skipped");
    expect(request).not.toHaveBeenCalled();
    expect((await db.select().from(githubIssueOutbox))[0].state).toBe("blocked");
  });

  it("rechecks the delivery flag after credential preflight before any POST", async () => {
    await queued();
    const claim = (await claimFeedbackOutbox())!;
    const request = vi.fn();
    const token = async () => { vi.stubEnv("GITHUB_FEEDBACK_DELIVERY_ENABLED", "false"); return adapters.token(); };
    expect(await deliverFeedbackIssue(claim, { ...adapters, token, request, deadlineAt: Date.now() + 10_000 })).toBe("skipped");
    expect(request).not.toHaveBeenCalled();
    expect((await db.select().from(githubIssueOutbox))[0]).toMatchObject({ state: "queued", leaseToken: null });
  });

  it("blocks installation permission loss before any issue HTTP", async () => {
    await queued();
    const claim = (await claimFeedbackOutbox())!;
    const request = vi.fn();
    const token = async () => { throw new GithubInstallationError(403, "github_installation_permissions_changed"); };
    expect(await deliverFeedbackIssue(claim, { ...adapters, token, request, deadlineAt: Date.now() + 10_000 })).toBe("blocked");
    expect(request).not.toHaveBeenCalled();
    expect((await db.select().from(githubIssueOutbox))[0]).toMatchObject({ state: "blocked", dispatchedAt: null, attempts: 0 });
  });

  it.each([403, 429])("keeps a proven preflight %i rate limit retryable and preserves its retry deadline", async (status) => {
    await queued();
    const claim = (await claimFeedbackOutbox())!;
    const retryAt = Date.now() + 3600_000;
    const token = async () => { throw Object.assign(new GithubInstallationError(status, "github_installation_unavailable"), { providerCode: "github_rate_limited", retryAt }); };
    const request = vi.fn();
    expect(await deliverFeedbackIssue(claim, { ...adapters, token, request, deadlineAt: Date.now() + 10_000 })).toBe("retry_wait");
    expect(request).not.toHaveBeenCalled();
    const [row] = await db.select().from(githubIssueOutbox);
    expect(row.lastErrorCode).toBe("github_rate_limited");
    expect(row.availableAt.getTime()).toBeGreaterThanOrEqual(retryAt);
    expect(row.dispatchedAt).toBeNull();
  });

  it("keeps a verified 201 uncertain when the process loses its DB lease before recording success", async () => {
    const { outbox } = await queued();
    const claim = (await claimFeedbackOutbox())!;
    expect(await deliverFeedbackIssue(claim, { ...adapters, deadlineAt: Date.now() + 10_000, request: async () => {
      await db.update(githubIssueOutbox).set({ leaseExpiresAt: new Date(0) }).where(eq(githubIssueOutbox.id, outbox.id));
      return { outcome: "confirmed_success", status: 201, retryAt: null, requestId: null, code: null, data: issue(outbox) };
    } })).toBe("lease_lost");
    await expireFeedbackDispatches();
    expect((await db.select().from(githubIssueOutbox))[0].state).toBe("uncertain");
    expect(await claimFeedbackOutbox()).toBeNull();
  });

  it("preserves sending after verified 201 exhausts the DB completion budget", async () => {
    const { outbox } = await queued();
    const claim = (await claimFeedbackOutbox())!;
    let now = Date.now();
    const deadlineAt = now + 10_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const request = vi.fn(async () => {
      now = deadlineAt - 100;
      return { outcome: "confirmed_success" as const, status: 201, code: null, retryAt: null, requestId: null, data: issue(outbox) };
    });
    try {
      await expect(deliverFeedbackIssue(claim, { ...adapters, request, deadlineAt })).rejects.toThrow("feedback_database_deadline");
      expect((await db.select().from(githubIssueOutbox))[0].state).toBe("sending");
      expect(request).toHaveBeenCalledOnce();
    } finally { clock.mockRestore(); }
    await db.update(githubIssueOutbox).set({ leaseExpiresAt: new Date(0) }).where(eq(githubIssueOutbox.id, outbox.id));
    await expireFeedbackDispatches();
    expect((await db.select().from(githubIssueOutbox))[0].state).toBe("uncertain");
    expect(await claimFeedbackOutbox()).toBeNull();
  });

  it("preserves sending after actual DB success-recording failure and recovers through uncertain without another POST", async () => {
    const { outbox } = await queued();
    const claim = (await claimFeedbackOutbox())!;
    const request = vi.fn(async () => ({ outcome: "confirmed_success" as const, status: 201, retryAt: null, requestId: null, code: null, data: issue(outbox) }));
    await db.execute(sql`alter table github_issue_outbox add constraint github_outbox_test_completion_failure check (state <> 'delivered') not valid`);
    try {
      await expect(deliverFeedbackIssue(claim, { ...adapters, request, deadlineAt: Date.now() + 10_000 })).rejects.toThrow();
    } finally {
      await db.execute(sql`alter table github_issue_outbox drop constraint github_outbox_test_completion_failure`);
    }
    expect(request).toHaveBeenCalledTimes(1);
    expect((await db.select().from(githubIssueOutbox))[0].state).toBe("sending");
    await db.update(githubIssueOutbox).set({ leaseExpiresAt: new Date(0) }).where(eq(githubIssueOutbox.id, outbox.id));
    await expireFeedbackDispatches();
    expect((await db.select().from(githubIssueOutbox))[0].state).toBe("uncertain");
    expect(await claimFeedbackOutbox()).toBeNull();
  });

  it("enforces twenty dispatches per repository per day including potentially delivered unknowns", async () => {
    await queued();
    const claim = (await claimFeedbackOutbox())!;
    await db.insert(rateLimits).values({ key: `github-issue:day:${repository.id}`, count: 20, resetAt: new Date(Date.now() + 3600_000) });
    expect(await beginFeedbackDispatch(claim, repository)).toBeNull();
    expect((await db.select().from(githubIssueOutbox))[0]).toMatchObject({ state: "retry_wait", lastErrorCode: "repository_daily_limit" });
  });

  it("cancels pending rows on binding disable while keeping dispatched rows for reconciliation", async () => {
    const { feedback } = await queued();
    const claim = (await claimFeedbackOutbox())!;
    await beginFeedbackDispatch(claim, repository);
    await db.transaction((tx) => cancelBindingFeedbackOutbox(tx, feedback.productId, "installation_removed"));
    expect((await db.select().from(githubIssueOutbox))[0].state).toBe("sending");
    await db.update(githubIssueOutbox).set({ state: "retry_wait" }).where(eq(githubIssueOutbox.id, claim.id));
    await db.transaction((tx) => cancelBindingFeedbackOutbox(tx, feedback.productId, "installation_removed"));
    expect((await db.select().from(githubIssueOutbox))[0].state).toBe("cancelled");
  });

  it("recovers uncertain delivery from exactly one listing marker", async () => {
    const { outbox } = await queued();
    const claim = (await claimFeedbackOutbox())!;
    await beginFeedbackDispatch(claim, repository);
    await completeFeedbackDispatch(claim, { state: "uncertain", errorCode: "github_timeout", retryAt: null });
    const request = async ({ path }: { path: string }) => ({ outcome: "confirmed_success" as const, status: 200, retryAt: null, requestId: null, code: null,
      data: path.startsWith("/repositories/") ? { id: repository.id, owner: { login: repository.owner }, name: repository.repo,
        full_name: repository.fullName, html_url: repository.htmlUrl, private: false, archived: false, has_issues: true } : path.endsWith("/issues/7") ? issue(outbox) : [issue(outbox)] });
    expect(await reconcileFeedbackIssue(outbox.id, { ...adapters, request, deadlineAt: Date.now() + 10_000 })).toBe("delivered");
    const [row] = await db.select().from(githubIssueOutbox).where(and(eq(githubIssueOutbox.id, outbox.id), eq(githubIssueOutbox.state, "delivered")));
    expect(row.githubIssueUrl).toBe("https://github.com/acme/tool/issues/7");
  });

  it("reserves checkpoint time so a slow paginated scan advances across ticks and releases its claim", async () => {
    const { outbox } = await queued();
    const claim = (await claimFeedbackOutbox())!;
    await beginFeedbackDispatch(claim, repository);
    await completeFeedbackDispatch(claim, { state: "uncertain", errorCode: "github_timeout", retryAt: null });
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const pages: number[] = [];
    const request = vi.fn(async ({ path }: { path: string }) => {
      if (!path.startsWith("/repositories/")) {
        pages.push(Number(new URL(path, "https://api.github.com").searchParams.get("page")));
        now += 1000;
      }
      return { outcome: "confirmed_success" as const, status: 200, retryAt: null, requestId: null, code: null,
        data: path.startsWith("/repositories/") ? { id: repository.id, owner: { login: repository.owner }, name: repository.repo,
          full_name: repository.fullName, html_url: repository.htmlUrl, private: false, archived: false, has_issues: true }
          : Array.from({ length: 100 }, () => ({ body: "other" })) };
    });
    try {
      for (let tick = 0; tick < 2; tick += 1) {
        const firstPage = tick === 0 ? 1 : pages.at(-1)! + 1;
        const index = pages.length;
        expect(await reconcileFeedbackIssue(outbox.id, { ...adapters, request, deadlineAt: now + 20_000 })).toBe("uncertain");
        const [saved] = await db.select().from(githubIssueOutbox);
        expect(saved.reconcilePage).toBe(pages.at(-1)! + 1);
        expect(pages[index]).toBe(firstPage);
        expect(saved.leaseToken).toBeNull();
        expect(saved.leaseExpiresAt).toBeNull();
        expect(saved.lastErrorCode).toBe("github_issue_scan_incomplete");
      }
    } finally { clock.mockRestore(); }
    expect(request.mock.calls.every(([input]) => !input.path.includes("search"))).toBe(true);
  });

  it.each(["credential", "metadata", "list"])("preserves a %s rate-limit retry deadline while remaining uncertain", async (stage) => {
    const { outbox } = await queued();
    const claim = (await claimFeedbackOutbox())!;
    await beginFeedbackDispatch(claim, repository);
    await completeFeedbackDispatch(claim, { state: "uncertain", errorCode: "github_timeout", retryAt: null });
    const retryAt = Date.now() + 3600_000;
    const token = stage === "credential" ? async () => { throw new GithubInstallationError(503, "github_installation_rate_limited", { providerCode: "github_rate_limited", retryAt }); } : adapters.token;
    const request = vi.fn(async ({ path }: { path: string }) => {
      if (stage === "metadata" || !path.startsWith("/repositories/")) return { outcome: "confirmed_rejection" as const, status: 429, retryAt, requestId: null, code: "github_rate_limited" as const };
      return { outcome: "confirmed_success" as const, status: 200, retryAt: null, requestId: null, code: null,
        data: { id: repository.id, owner: { login: repository.owner }, name: repository.repo,
          full_name: repository.fullName, html_url: repository.htmlUrl, private: false, archived: false, has_issues: true } };
    });
    expect(await reconcileFeedbackIssue(outbox.id, { ...adapters, token, request, deadlineAt: Date.now() + 10_000 })).toBe("uncertain");
    const [saved] = await db.select().from(githubIssueOutbox);
    expect(saved.availableAt.getTime()).toBeGreaterThanOrEqual(retryAt);
    expect(saved.lastErrorCode).toBe("github_rate_limited");
    expect(saved.leaseToken).toBeNull();
    expect(await claimFeedbackOutbox()).toBeNull();
  });

  it("reserves claim cleanup time when the installation token consumes its HTTP budget", async () => {
    const { outbox } = await queued();
    const claim = (await claimFeedbackOutbox())!;
    await beginFeedbackDispatch(claim, repository);
    await completeFeedbackDispatch(claim, { state: "uncertain", errorCode: "github_timeout", retryAt: null });
    let now = Date.now();
    const deadlineAt = now + 20_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const request = vi.fn();
    const token = vi.fn(async (_input, options?: { deadlineAt?: number }) => {
      now = options!.deadlineAt!;
      throw new Error("token deadline");
    });
    try {
      expect(await reconcileFeedbackIssue(outbox.id, { ...adapters, token, request, deadlineAt })).toBe("uncertain");
      expect(now).toBeLessThan(deadlineAt - 3250);
      const [saved] = await db.select().from(githubIssueOutbox);
      expect(saved.leaseToken).toBeNull();
      expect(saved.lastErrorCode).toBe("github_reconcile_unavailable");
      expect(request).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it("checkpoints a sole candidate when its final GET exhausts the HTTP window", async () => {
    const { outbox } = await queued();
    const claim = (await claimFeedbackOutbox())!;
    await beginFeedbackDispatch(claim, repository);
    await completeFeedbackDispatch(claim, { state: "uncertain", errorCode: "github_timeout", retryAt: null });
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const request = vi.fn(async ({ path, timeoutMs }: { path: string; timeoutMs?: number }) => {
      if (path.endsWith("/issues/7")) { now += timeoutMs!; throw new Error("candidate timeout"); }
      if (!path.startsWith("/repositories/")) now += path.endsWith("page=1") ? 15_000 : 500;
      return { outcome: "confirmed_success" as const, status: 200, retryAt: null, requestId: null, code: null,
        data: path.startsWith("/repositories/") ? { id: repository.id, owner: { login: repository.owner }, name: repository.repo,
          full_name: repository.fullName, html_url: repository.htmlUrl, private: false, archived: false, has_issues: true }
          : path.endsWith("page=1") ? [issue(outbox), ...Array.from({ length: 99 }, () => ({ body: "other" }))] : [] };
    });
    try {
      expect(await reconcileFeedbackIssue(outbox.id, { ...adapters, request, deadlineAt: now + 20_000 })).toBe("uncertain");
      const [saved] = await db.select().from(githubIssueOutbox);
      expect(saved.reconcilePage).toBe(2);
      expect(saved.reconcileMatches).toMatchObject([{ id: 88, number: 7 }]);
      expect(saved.leaseToken).toBeNull();
      expect(saved.lastErrorCode).toBe("github_reconcile_unavailable");
    } finally { clock.mockRestore(); }
  });

  it.each([true, false])("revalidates a stored marker candidate against a renamed live repository (valid=%s)", async (valid) => {
    const { outbox } = await queued();
    const claim = (await claimFeedbackOutbox())!;
    await beginFeedbackDispatch(claim, repository);
    await completeFeedbackDispatch(claim, { state: "uncertain", errorCode: "github_timeout", retryAt: null });
    await db.update(githubIssueOutbox).set({ reconcilePage: 2, reconcileMatches: [{ id: 88, number: 7, url: "https://github.com/acme/tool/issues/7", state: "open" }] })
      .where(eq(githubIssueOutbox.id, outbox.id));
    const request = vi.fn(async ({ path }: { path: string }) => ({ outcome: "confirmed_success" as const, status: 200, retryAt: null, requestId: null, code: null,
      data: path.startsWith("/repositories/") ? { id: repository.id, owner: { login: repository.owner }, name: "renamed",
        full_name: "acme/renamed", html_url: "https://github.com/acme/renamed", private: false, archived: false, has_issues: true }
        : path.endsWith("/issues/7") ? { ...issue(outbox), id: valid ? 88 : 999, url: "https://api.github.com/repos/acme/renamed/issues/7",
          repository_url: "https://api.github.com/repos/acme/renamed", html_url: "https://github.com/acme/renamed/issues/7" } : [] }));
    expect(await reconcileFeedbackIssue(outbox.id, { ...adapters, request, deadlineAt: Date.now() + 10_000 })).toBe(valid ? "delivered" : "uncertain");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ path: "/repos/acme/renamed/issues/7" }));
    const [row] = await db.select().from(githubIssueOutbox);
    expect(row.githubIssueUrl).toBe(valid ? "https://github.com/acme/renamed/issues/7" : null);
  });

  it.each([0, 2])("keeps %i marker matches uncertain without repeating issue POST", async (matches) => {
    const { outbox } = await queued();
    const claim = (await claimFeedbackOutbox())!;
    await beginFeedbackDispatch(claim, repository);
    await completeFeedbackDispatch(claim, { state: "uncertain", errorCode: "github_timeout", retryAt: null });
    const request = vi.fn(async ({ path }: { path: string }) => ({ outcome: "confirmed_success" as const, status: 200, retryAt: null, requestId: null, code: null,
      data: path.startsWith("/repositories/") ? { id: repository.id, owner: { login: repository.owner }, name: repository.repo,
        full_name: repository.fullName, html_url: repository.htmlUrl, private: false, archived: false, has_issues: true }
        : Array.from({ length: matches }, (_, index) => ({ ...issue(outbox), id: 88 + index, number: 7 + index,
          url: `https://api.github.com/repos/acme/tool/issues/${7 + index}`, html_url: `https://github.com/acme/tool/issues/${7 + index}` })) }));
    expect(await reconcileFeedbackIssue(outbox.id, { ...adapters, request, deadlineAt: Date.now() + 10_000 })).toBe("uncertain");
    expect(request.mock.calls.every(([options]) => !options.path.includes("search"))).toBe(true);
    expect((await db.select().from(githubIssueOutbox))[0].lastErrorCode).toBe(matches === 0 ? "github_issue_marker_not_found" : "github_issue_duplicate_markers");
    expect(await claimFeedbackOutbox()).toBeNull();
  });
});
