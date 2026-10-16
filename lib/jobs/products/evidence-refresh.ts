import { canonicalSourceMode } from "@/lib/domain/evidence/source-control";
import { executeCanonicalEvidenceSource } from "@/lib/domain/evidence/source-claims";
import { roleLeaseFromEnv } from "@/lib/jobs/role-leader";
import { HttpOriginPermitError } from "@/lib/net/http-origin-policy";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { currentEvidenceSettings } from "@/lib/domain/evidence/settings-store";
import {
  dueEvidenceProductSlugs,
  queueInitialProductEvidenceRefresh,
  refreshProductEvidence,
  type EvidenceRefreshDependencies,
} from "@/lib/domain/evidence/refresh";
import { ProductGenerationChangedError } from "@/lib/domain/products/generation";
import { beginProductRefresh, dueProductRefreshRequests, saveProductRefreshProgress } from "@/lib/domain/evidence/refresh-requests";
import { JobLeaseLostError } from "@/lib/jobs/control";
import { db, onPrimary } from "@/lib/db";
import { JobBatchBlockedError, lockJobBatch } from "@/lib/jobs/batch-repository";

export type EvidenceRefreshCursor = { afterSlug?: string; requestTurn?: boolean };
export type EvidenceRefreshCounts = {
  attempted: number;
  succeeded: number;
  failed: number;
  factsChanged: number;
  eventsInserted: number;
  mediaInserted: number;
};

function refreshErrorCode(error: unknown): string {
  if (error instanceof ProductGenerationChangedError) return "product_generation_changed";
  if (!(error instanceof Error)) return "unknown";
  return error.name.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").toLowerCase().slice(0, 80)
    || "error";
}

export async function refreshProductEvidenceJob(
  ctx: JobContext<EvidenceRefreshCursor>,
  dependencies: EvidenceRefreshDependencies = {},
): Promise<JobOutcome<EvidenceRefreshCursor>> {
  const deadlineAt = Math.min(ctx.deadlineAt ?? Date.now() + 25_000, dependencies.deadlineAt ?? Infinity);
  const now = (dependencies.now ?? (() => new Date()))();
  const settings = await currentEvidenceSettings();
  const counts: EvidenceRefreshCounts = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    factsChanged: 0,
    eventsInserted: 0,
    mediaInserted: 0,
  };
  // Existing consumer only. Source mode has a separately owned durable lane;
  // GitHub/request-level retry deadlines never control canonical admission.
  if (await canonicalSourceMode()) {
    const batch = await onPrimary(() => db.transaction(lockJobBatch));
    if (batch.mode === "draining") return { done: false, deferred: "stage_blocked" };
    if (batch.mode === "legacy") {
      const owner = roleLeaseFromEnv("crawler", process.env);
      if (!owner || !ctx.lease) throw new Error("evidence_source_owner_required");
      try {
        for (let turn = 0; turn < 4 && ctx.hasBudget() && !ctx.signal?.aborted && Date.now() < deadlineAt; turn++) {
          const result = await executeCanonicalEvidenceSource({ owner: { instanceId: owner.instanceId, bootId: owner.bootId },
            roleLease: owner, job: ctx.lease, signal: ctx.signal, deadlineAt });
          if (result.state === "idle") break;
          if (result.state === "recorded" || result.state === "failed") {
            counts.attempted++; counts.factsChanged += result.factsChanged;
            if (result.state === "recorded") counts.succeeded++; else counts.failed++;
          }
        }
      } catch (error) {
        if (error instanceof JobBatchBlockedError) return { done: false, deferred: "stage_blocked" };
        throw error;
      }
    }
  }
  let afterSlug = ctx.cursor?.afterSlug;
  let providerHold = false;
  const providerHolds = new Set(["rate_limited", "auth_unavailable", "quota", "cooldown", "backoff"]);
  const sourceDependencies: EvidenceRefreshDependencies = {
    ...dependencies,
    log: (event, fields) => {
      for (const value of [fields?.httpClass, fields?.outcome]) {
        if (typeof value === "string" && providerHolds.has(value)) providerHold = true;
      }
      dependencies.log?.(event, fields);
      ctx.log(event, fields);
    },
  };
  const [pendingRequest] = await dueProductRefreshRequests(now);
  if (!pendingRequest) {
    try {
      const queued = await queueInitialProductEvidenceRefresh({ lease: ctx.lease, hasBudget: ctx.hasBudget });
      if (queued) ctx.log("evidence.initial_refresh_queued", queued);
    } catch (error) {
      if (error instanceof JobLeaseLostError || error instanceof HttpOriginPermitError) throw error;
      ctx.log("evidence.initial_refresh_queue_failed", { errorCode: refreshErrorCode(error) });
    }
  }
  let requestProcessed = false;
  let requestTurn = ctx.cursor?.requestTurn ?? true;
  const saveCursor = () => ctx.save({ ...(afterSlug ? { afterSlug } : {}),
    ...(pendingRequest ? { requestTurn } : {}) });
  const runRequest = async () => {
    if (!pendingRequest || requestProcessed || !ctx.hasBudget()) return;
    requestProcessed = true;
    requestTurn = false;
    // Save the next lane before external I/O so a slow forced refresh cannot starve due work.
    await saveCursor();
    const request = await beginProductRefresh(pendingRequest, now, ctx.lease);
    if (!request) return;
    let progress = request.progress;
    counts.attempted += 1;
    try {
      const result = await refreshProductEvidence(request.slug, {
        now, productId: request.productId, force: request.activeForce,
        deadlineAt, signal: ctx.signal, lease: ctx.lease,
        hasBudget: ctx.hasBudget, dependencies: sourceDependencies, progress,
        saveProgress: async next => {
          await saveProductRefreshProgress(request, next, { now, lease: ctx.lease });
          progress = next;
        },
      });
      if (result.deferred === "http_origin_permit") throw new HttpOriginPermitError("unavailable");
      await saveProductRefreshProgress(request, progress, { now, lease: ctx.lease, result });
      if (result.sourcesFailed) counts.failed += 1;
      else if (result.complete) counts.succeeded += 1;
      counts.factsChanged += result.factsChanged;
      counts.eventsInserted += result.eventsInserted;
      counts.mediaInserted += result.mediaInserted;
      ctx.log("evidence.request_refresh", { productId: request.productId, requestedVersion: request.activeVersion,
        complete: result.complete, completedSources: progress.completedKeys.length });
    } catch (error) {
      if (error instanceof JobLeaseLostError || error instanceof HttpOriginPermitError) throw error;
      counts.failed += 1;
      const errorCode = refreshErrorCode(error);
      if (!(error instanceof ProductGenerationChangedError)) {
        await saveProductRefreshProgress(request, progress, { now, lease: ctx.lease, error: errorCode });
      }
      ctx.log("evidence.product_refresh_failed", { slug: request.slug, errorCode });
    }
  };

  if (pendingRequest && requestTurn) await runRequest();

  while (ctx.hasBudget()) {
    // Read one later product before external I/O so a full-page deadline can
    // continue without starting another selection after the budget has ended.
    const selectionLimit = Math.min(settings.batchSize + 1, 100);
    const selected = await dueEvidenceProductSlugs({
      afterSlug,
      limit: selectionLimit,
      now,
      settings,
    });
    const slugs = selected.slice(0, settings.batchSize);
    let untouchedNextPage = selected.length > slugs.length;
    let finalPage = selected.length < selectionLimit;
    // The selector caps at 100. At that setting, obtain the lookahead separately
    // while the shared and dependency budgets still permit starting a read.
    if (settings.batchSize === 100 && selected.length === 100 && ctx.hasBudget()
      && !ctx.signal?.aborted && Date.now() < deadlineAt) {
      const later = await dueEvidenceProductSlugs({ afterSlug: slugs.at(-1), limit: 1, now, settings });
      untouchedNextPage = later.length > 0;
      finalPage = !untouchedNextPage;
    }
    if (slugs.length === 0) {
      await runRequest();
      ctx.log("evidence.refresh_batch", counts);
      return { done: true };
    }

    let completedPage = true;
    let untouchedLater = false;
    for (let index = 0; index < slugs.length; index += 1) {
      const slug = slugs[index];
      if (!ctx.hasBudget()) {
        completedPage = false;
        untouchedLater = true;
        break;
      }
      counts.attempted += 1;
      try {
        const result = await refreshProductEvidence(slug, {
          now,
          deadlineAt, signal: ctx.signal, lease: ctx.lease,
          hasBudget: ctx.hasBudget,
          dependencies: sourceDependencies,
        });
        if (result.deferred === "http_origin_permit") throw new HttpOriginPermitError("unavailable");
        if (result.sourcesFailed > 0) counts.failed += 1;
        else if (result.complete) counts.succeeded += 1;
        counts.factsChanged += result.factsChanged;
        counts.eventsInserted += result.eventsInserted;
        counts.mediaInserted += result.mediaInserted;
        // Durable source checkpoints keep this product due. Advance traversal so
        // repeated partial work cannot keep later products behind the same cursor.
        if (!result.complete && !ctx.hasBudget()) completedPage = false;
      } catch (error) {
        if (error instanceof JobLeaseLostError || error instanceof HttpOriginPermitError) throw error;
        counts.failed += 1;
        ctx.log("evidence.product_refresh_failed", {
          slug,
          errorCode: refreshErrorCode(error),
        });
      }
      afterSlug = slug;
      requestTurn = true;
      await saveCursor();
      await runRequest();
      if (!completedPage) {
        untouchedLater = index < slugs.length - 1 || untouchedNextPage;
        break;
      }
    }
    if (completedPage && untouchedNextPage && !ctx.hasBudget()) {
      completedPage = false;
      untouchedLater = true;
    }
    if (!completedPage) {
      const budgetElapsed = ctx.deadlineAt !== undefined && Date.now() >= ctx.deadlineAt;
      const ready = budgetElapsed && !ctx.signal?.aborted && counts.succeeded > 0 && counts.failed === 0
        && !providerHold && untouchedLater;
      ctx.log("evidence.refresh_batch", counts);
      return { done: false, ...(ready ? { continuation: "ready" as const } : {}), cursor: pendingRequest
        ? { ...(afterSlug ? { afterSlug } : {}), requestTurn }
        : afterSlug ? { afterSlug } : ctx.cursor };
    }
    if (finalPage) {
      ctx.log("evidence.refresh_batch", counts);
      return { done: true };
    }
  }

  ctx.log("evidence.refresh_batch", counts);
  return { done: false, cursor: pendingRequest
    ? { ...(afterSlug ? { afterSlug } : {}), requestTurn }
    : afterSlug ? { afterSlug } : ctx.cursor };
}
