import { githubRequest, type GithubRequestOptions, type GithubResult } from "@/lib/github/client";
import type { GithubRepository } from "@/lib/github/repositories";
import type { GithubProductBinding } from "@/lib/db/github-binding-schema";
import { getFeedbackInstallationToken, GithubInstallationError, verifyFeedbackInstallation, type GithubInstallationOptions } from "@/lib/domain/github-installations/credentials";
import type { JobLease } from "@/lib/jobs/control";
import { feedbackIssueMarker, parseDeliveredIssue } from "./issue-body";
import { beginFeedbackDispatch, completeFeedbackDispatch, getDispatchBinding, type FeedbackDeliveryResolution, type FeedbackOutboxClaim } from "./outbox";

export type FeedbackIssueTransport = (options: GithubRequestOptions) => Promise<GithubResult<unknown>>;
export type FeedbackProviderOptions = {
  deadlineAt: number; lease?: JobLease; signal?: AbortSignal;
  verify?: (binding: GithubProductBinding, options?: GithubInstallationOptions) => Promise<{ repository: GithubRepository }>;
  token?: (input: { installationId: number; repositoryId: number }, options?: GithubInstallationOptions) => Promise<{ token: string; expiresAt: number }>;
  request?: FeedbackIssueTransport;
};

export function classifyGithubIssueResult(result: GithubResult<unknown>, repository: GithubRepository, marker: string): FeedbackDeliveryResolution {
  if (result.outcome === "confirmed_success" && result.status === 201) {
    const issue = parseDeliveredIssue(result.data, repository, marker);
    return issue ? { state: "delivered", issue, errorCode: null, retryAt: null }
      : { state: "uncertain", errorCode: "github_issue_response_mismatch", retryAt: null };
  }
  if (result.outcome === "confirmed_rejection") {
    if (result.code === "github_rate_limited") return { state: "retry_wait", errorCode: result.code, retryAt: Math.max(Date.now(), result.retryAt ?? Date.now() + 60_000) };
    return { state: "blocked", errorCode: result.code, retryAt: null };
  }
  return { state: "uncertain", errorCode: result.code ?? "github_issue_response_mismatch", retryAt: null };
}

/** Preflight reads may finish late, but this race never chains a late preflight into issue POST. */
export async function withinFeedbackDeadline<T>(work: () => Promise<T>, deadlineAt: number, signal?: AbortSignal): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0 || signal?.aborted) throw new Error("feedback_dispatch_deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("feedback_dispatch_deadline"));
    timer = setTimeout(abort, remaining);
    signal?.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([work(), expired]); }
  finally { clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
}

export async function deliverFeedbackIssue(claim: FeedbackOutboxClaim, options: FeedbackProviderOptions): Promise<string> {
  let repository: GithubRepository, token: string;
  try {
    const binding = await getDispatchBinding(claim, options.lease, options.deadlineAt);
    if (!binding) {
      await completeFeedbackDispatch(claim, { state: "blocked", errorCode: "feedback_target_changed", retryAt: null }, options.lease, options.deadlineAt);
      return "blocked";
    }
    ({ repository } = await withinFeedbackDeadline(() => (options.verify ?? verifyFeedbackInstallation)(binding, options), options.deadlineAt, options.signal));
    const credential = await withinFeedbackDeadline(() => (options.token ?? getFeedbackInstallationToken)({ installationId: claim.installationId, repositoryId: claim.repositoryId }, options), options.deadlineAt, options.signal);
    if (credential.expiresAt <= options.deadlineAt) throw new Error("feedback_credential_expired");
    token = credential.token;
  } catch (error) {
    const rateLimited = error instanceof GithubInstallationError && error.providerCode === "github_rate_limited";
    const blocked = !rateLimited && error instanceof GithubInstallationError && [400, 401, 403, 404, 409, 410, 422].includes(error.status);
    const state = blocked ? "blocked" : "retry_wait";
    await completeFeedbackDispatch(claim, { state, errorCode: rateLimited ? "github_rate_limited" : error instanceof GithubInstallationError ? error.code : "github_feedback_preflight_unavailable",
      retryAt: blocked ? null : Math.max(Date.now(), rateLimited ? error.retryAt ?? Date.now() + 60_000 : Date.now() + 60_000) }, options.lease, options.deadlineAt);
    return state;
  }
  if (options.signal?.aborted || Date.now() >= options.deadlineAt) {
    await completeFeedbackDispatch(claim, { state: "retry_wait", errorCode: "feedback_dispatch_deadline", retryAt: Date.now() + 60_000 }, options.lease, options.deadlineAt);
    return "retry_wait";
  }
  const started = await beginFeedbackDispatch(claim, repository, options.lease, options.deadlineAt);
  if (!started) return "skipped";
  let result: GithubResult<unknown>;
  try {
    result = await withinFeedbackDeadline(() => (options.request ?? githubRequest<unknown>)({ path: `/repos/${repository.fullName}/issues`, token, auth: "installation", method: "POST",
      body: { title: started.payloadTitle, body: started.payloadBody }, timeoutMs: Math.max(1, Math.min(10_000, options.deadlineAt - Date.now())) }), options.deadlineAt, options.signal);
  } catch {
    result = { outcome: "unknown", status: null, retryAt: null, requestId: null, code: "github_timeout" };
  }
  const resolution = classifyGithubIssueResult(result, repository, feedbackIssueMarker(started.feedbackId, started.dispatchId));
  const saved = await completeFeedbackDispatch(claim, resolution, options.lease, options.deadlineAt);
  return saved ? resolution.state : "lease_lost";
}
