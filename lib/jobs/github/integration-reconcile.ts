import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { expireFeedbackDispatches } from "@/lib/domain/feedback/github/outbox";
import { reconcileFeedbackIssue } from "@/lib/domain/feedback/github/reconcile";
import { withinFeedbackDeadline, type FeedbackProviderOptions } from "@/lib/domain/feedback/github/deliver";
import { getFeedbackInstallationToken, verifyFeedbackAppCredentials, verifyFeedbackInstallation } from "@/lib/domain/github-installations/credentials";
import { githubRequest } from "@/lib/github/client";
import { processGithubWebhookEvents } from "@/lib/domain/github-webhooks/process";
import { cleanupExpiredMakerGithubAuthorizations, dueGithubIntegrationTargets, reconcileGithubBindings, reconcileLinkedGithubIssue } from "@/lib/domain/github-webhooks/reconcile";

const CREDENTIAL_FAILURE: Record<string, string> = {
  github_app_credentials_rejected: "GitHub 가 피드백 App 자격(App JWT)을 거절했습니다",
  github_app_mismatch: "GitHub 가 돌려준 App 이 설정(GITHUB_FEEDBACK_APP_ID·SLUG)과 다릅니다",
  github_bindings_all_rejected: "확인한 연동이 모두 자격 오류(401·403·설치 없음)로 실패했습니다",
};

/**
 * Reads existing external results even after flags stop new writes. Never refreshes Star user tokens.
 *
 * 연동 확인은 한꺼번에 한다(reconcileGithubBindings) — App 자격이 거절되면 연동을 끄지 않고, 회차 끝에 던져 운영센터의
 * "마지막 회차가 실패한 작업"(긴급)과 작업 상세의 마지막 오류로 보인다. 그동안 웹훅·이슈 읽기는 그대로 한다.
 */
export async function reconcileGithubIntegrations(ctx: JobContext<null>, provider: Partial<Pick<FeedbackProviderOptions, "verify" | "token" | "request">> & {
  appCheck?: (options: FeedbackProviderOptions) => Promise<unknown>;
} = {}): Promise<JobOutcome<null>> {
  const deadlineAt = Date.now() + 20_000, httpDeadlineAt = deadlineAt - 6_000;
  const options: FeedbackProviderOptions = { deadlineAt, lease: ctx.lease, signal: ctx.signal,
    token: (input, settings) => withinFeedbackDeadline(() => (provider.token ?? getFeedbackInstallationToken)(input, { ...settings, deadlineAt: Math.min(httpDeadlineAt, settings?.deadlineAt ?? httpDeadlineAt) }), httpDeadlineAt, ctx.signal),
    verify: (binding, settings) => withinFeedbackDeadline(() => (provider.verify ?? verifyFeedbackInstallation)(binding, { ...settings, deadlineAt: Math.min(httpDeadlineAt, settings?.deadlineAt ?? httpDeadlineAt) }), httpDeadlineAt, ctx.signal),
    request: input => withinFeedbackDeadline(() => (provider.request ?? githubRequest<unknown>)({ ...input, timeoutMs: Math.max(1, Math.min(input.timeoutMs ?? 10_000, 10_000, httpDeadlineAt - Date.now())) }), httpDeadlineAt, ctx.signal),
  };
  const expiredCredentials = await cleanupExpiredMakerGithubAuthorizations(options);
  const expiredDispatches = await expireFeedbackDispatches(ctx.lease, options.deadlineAt);
  const events = await processGithubWebhookEvents({ limit: 20, lease: ctx.lease, deadlineAt: options.deadlineAt });
  let processed = 0;
  const targets = await dueGithubIntegrationTargets(options);
  for (const target of targets.filter((item) => item.kind !== "binding")) {
    // Reserve the bounded pool/transaction lifecycle before beginning another target.
    if (!ctx.hasBudget() || ctx.signal?.aborted || Date.now() >= options.deadlineAt - 6_000) break;
    const state = target.kind === "issue" ? await reconcileLinkedGithubIssue(target.id, options) : await reconcileFeedbackIssue(target.id, options);
    ctx.log("github.integration_reconcile", { kind: target.kind, state });
    processed += 1;
  }
  const bindings = await reconcileGithubBindings(targets.filter((item) => item.kind === "binding").map((item) => Number(item.id)), {
    ...options, hasBudget: ctx.hasBudget,
    appCheck: (settings) => withinFeedbackDeadline(() => (provider.appCheck ?? verifyFeedbackAppCredentials)({ ...settings, deadlineAt: Math.min(httpDeadlineAt, settings.deadlineAt) }), httpDeadlineAt, ctx.signal),
  });
  for (const state of bindings.states) ctx.log("github.integration_reconcile", { kind: "binding", state });
  processed += bindings.states.length;
  ctx.log("github.integration_reconcile_tick", { processed, events, expiredCredentials, expiredDispatches, credentialFailure: bindings.credentialFailure !== null });
  if (bindings.credentialFailure) {
    throw new Error(`${bindings.credentialFailure}: ${CREDENTIAL_FAILURE[bindings.credentialFailure] ?? "App 자격 문제"} — 연동 ${bindings.states.length}개는 끄지 않았습니다. `
      + "GITHUB_FEEDBACK_APP_ID·GITHUB_FEEDBACK_APP_PRIVATE_KEY(·SLUG)를 확인하고, 고치면 다음 회차가 연동을 다시 확인합니다");
  }
  return { done: true, cursor: null };
}
