import { randomUUID } from "node:crypto";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { dbPoolConfig } from "@/lib/db/pool";
import { productFeedback } from "@/lib/db/product-feedback-schema";
import { githubIssueOutbox } from "@/lib/db/github-issue-outbox-schema";
import { githubRequest } from "@/lib/github/client";
import type { GithubRepository } from "@/lib/github/repositories";
import { getFeedbackInstallationToken, GithubInstallationError } from "@/lib/domain/github-installations/credentials";
import { parseGithubRepositoryResponse } from "@/lib/github/repositories";
import { feedbackIssueMarker, parseDeliveredIssue, type DeliveredIssue } from "./issue-body";
import { claimOwnership, feedbackOutboxWrite, type FeedbackOutboxClaim } from "./outbox";
import { withinFeedbackDeadline, type FeedbackIssueTransport, type FeedbackProviderOptions } from "./deliver";
import { feedbackSql } from "./database";

export type FeedbackMarkerScan = { complete: boolean; page: number; matches: DeliveredIssue[]; errorCode: string | null; retryAt: number | null };

/** No search index and no automatic issue writes. A partial list never proves absence. */
export async function scanFeedbackIssueMarkers(input: { repository: GithubRepository; token: string; marker: string; page: number; matches: DeliveredIssue[];
  deadlineAt: number; request?: FeedbackIssueTransport; signal?: AbortSignal }): Promise<FeedbackMarkerScan> {
  const matches = [...input.matches];
  let page = input.page;
  for (let read = 0; read < 20 && Date.now() < input.deadlineAt && !input.signal?.aborted; read += 1) {
    let result;
    try {
      result = await withinFeedbackDeadline(() => (input.request ?? githubRequest<unknown>)({ path: `/repos/${input.repository.fullName}/issues?state=all&per_page=100&page=${page}`,
        token: input.token, auth: "installation", timeoutMs: Math.max(1, Math.min(10_000, input.deadlineAt - Date.now())) }), input.deadlineAt, input.signal);
    } catch { return { complete: false, page, matches, errorCode: "github_timeout", retryAt: null }; }
    if (result.outcome !== "confirmed_success" || !Array.isArray(result.data)) return { complete: false, page, matches, errorCode: result.code ?? "github_issue_list_invalid", retryAt: result.retryAt ?? null };
    for (const candidate of result.data) {
      const issue = parseDeliveredIssue(candidate, input.repository, input.marker);
      if (issue && !matches.some((existing) => existing.id === issue.id)) matches.push(issue);
      if (matches.length >= 2) return { complete: true, page, matches: matches.slice(0, 2), errorCode: "github_issue_duplicate_markers", retryAt: null };
    }
    if (result.data.length < 100) return { complete: true, page, matches, errorCode: null, retryAt: null };
    page += 1;
  }
  return { complete: false, page, matches, errorCode: null, retryAt: null };
}

/** Reconciliation uses the frozen numeric repository even when its binding has been disabled. */
export async function reconcileFeedbackIssue(id: string, options: FeedbackProviderOptions): Promise<string> {
  const claim = await feedbackOutboxWrite(options.lease, async (tx) => {
    const [row] = await feedbackSql(tx, options.deadlineAt, () => tx.select().from(githubIssueOutbox).where(and(eq(githubIssueOutbox.id, id), eq(githubIssueOutbox.state, "uncertain"),
      or(isNull(githubIssueOutbox.leaseExpiresAt), lte(githubIssueOutbox.leaseExpiresAt, sql`now()`)))).for("update", { skipLocked: true }));
    if (!row) return null;
    const [claimed] = await feedbackSql(tx, options.deadlineAt, () => tx.update(githubIssueOutbox).set({ leaseToken: randomUUID(), leaseExpiresAt: sql`now() + interval '45 seconds'` })
      .where(eq(githubIssueOutbox.id, row.id)).returning());
    return claimed as FeedbackOutboxClaim;
  }, options.deadlineAt);
  if (!claim) return "skipped";
  // Leave the configured connection handshake and a short SQL lifecycle window
  // for the awaited cursor/error checkpoint, even when a provider stalls.
  const checkpointMs = dbPoolConfig().connectSeconds * 1000 + 250 + 1000;
  const providerOptions = { ...options, deadlineAt: options.deadlineAt - checkpointMs };
  let scan: FeedbackMarkerScan = { complete: false, page: claim.reconcilePage, matches: claim.reconcileMatches, errorCode: null, retryAt: null };
  let verifiedCandidate: DeliveredIssue | null = null;
  try {
    const credential = await withinFeedbackDeadline(() => (options.token ?? getFeedbackInstallationToken)({ installationId: claim.installationId, repositoryId: claim.repositoryId }, providerOptions), providerOptions.deadlineAt, options.signal);
    const repositoryResult = await withinFeedbackDeadline(() => (options.request ?? githubRequest<unknown>)({ path: `/repositories/${claim.repositoryId}`, token: credential.token, auth: "installation",
      timeoutMs: Math.max(1, Math.min(10_000, providerOptions.deadlineAt - Date.now())) }), providerOptions.deadlineAt, options.signal);
    if (repositoryResult.code === "github_rate_limited") throw new GithubInstallationError(503, "github_installation_rate_limited", { providerCode: repositoryResult.code, retryAt: repositoryResult.retryAt });
    const repository = repositoryResult.outcome === "confirmed_success" ? parseGithubRepositoryResponse(repositoryResult.data, claim.repositoryId) : null;
    if (!repository || repository.private) throw new Error("github_reconcile_repository_unavailable");
    scan = await scanFeedbackIssueMarkers({ repository, token: credential.token, marker: feedbackIssueMarker(claim.feedbackId, claim.dispatchId),
      page: claim.reconcilePage, matches: claim.reconcileMatches, deadlineAt: providerOptions.deadlineAt, request: options.request, signal: options.signal });
    if (scan.complete && scan.matches.length === 1) {
      const candidate = scan.matches[0];
      const result = await withinFeedbackDeadline(() => (options.request ?? githubRequest<unknown>)({ path: `/repos/${repository.fullName}/issues/${candidate.number}`,
        token: credential.token, auth: "installation", timeoutMs: Math.max(1, Math.min(10_000, providerOptions.deadlineAt - Date.now())) }), providerOptions.deadlineAt, options.signal);
      const current = result.outcome === "confirmed_success" ? parseDeliveredIssue(result.data, repository, feedbackIssueMarker(claim.feedbackId, claim.dispatchId)) : null;
      if (current?.id === candidate.id && current.number === candidate.number) verifiedCandidate = current;
      else if (result.code === "github_rate_limited") scan = { ...scan, complete: false, errorCode: result.code, retryAt: result.retryAt ?? null };
      else scan.errorCode = "github_issue_candidate_invalid";
    }
  } catch (error) {
    const rateLimited = error instanceof GithubInstallationError && error.providerCode === "github_rate_limited";
    scan = { ...scan, complete: false, errorCode: rateLimited ? "github_rate_limited" : "github_reconcile_unavailable", retryAt: rateLimited ? error.retryAt : null };
  }
  return feedbackOutboxWrite(options.lease, async (tx) => {
    const [owned] = await feedbackSql(tx, options.deadlineAt, () => tx.select().from(githubIssueOutbox).where(and(claimOwnership(claim), eq(githubIssueOutbox.state, "uncertain"), eq(githubIssueOutbox.dispatchId, claim.dispatchId))).for("update"));
    if (!owned) return "lease_lost";
    const found = verifiedCandidate;
    await feedbackSql(tx, options.deadlineAt, () => tx.update(githubIssueOutbox).set({ state: found ? "delivered" : "uncertain", leaseToken: null, leaseExpiresAt: null,
      reconcilePage: scan.complete ? 1 : scan.page, reconcileMatches: scan.complete ? [] : scan.matches, lastCheckedAt: new Date(), updatedAt: new Date(),
      availableAt: new Date(Math.max(Date.now() + 60_000, Number.isFinite(scan.retryAt) ? scan.retryAt! : 0)),
      lastErrorCode: found ? null : scan.errorCode ?? (scan.complete ? "github_issue_marker_not_found" : "github_issue_scan_incomplete"),
      ...(found ? { githubIssueId: found.id, githubIssueNumber: found.number, githubIssueUrl: found.url, externalIssueState: found.state, completedAt: new Date() } : {}),
    }).where(eq(githubIssueOutbox.id, owned.id)));
    if (found) await feedbackSql(tx, options.deadlineAt, () => tx.update(productFeedback).set({ deliveryState: "delivered" }).where(eq(productFeedback.id, owned.feedbackId)));
    return found ? "delivered" : "uncertain";
  }, options.deadlineAt);
}

export function uncertainFeedbackIssueIds(limit = 20): Promise<string[]> {
  return onPrimary(async () => (await db.select({ id: githubIssueOutbox.id }).from(githubIssueOutbox).where(and(eq(githubIssueOutbox.state, "uncertain"), lte(githubIssueOutbox.availableAt, sql`now()`)))
    .orderBy(githubIssueOutbox.availableAt, githubIssueOutbox.id).limit(Math.min(20, Math.max(1, limit)))).map((row) => row.id));
}
