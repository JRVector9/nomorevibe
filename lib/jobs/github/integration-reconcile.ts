import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { expireFeedbackDispatches } from "@/lib/domain/feedback/github/outbox";
import { reconcileFeedbackIssue } from "@/lib/domain/feedback/github/reconcile";
import { withinFeedbackDeadline, type FeedbackProviderOptions } from "@/lib/domain/feedback/github/deliver";
import { getFeedbackInstallationToken, verifyFeedbackInstallation } from "@/lib/domain/github-installations/credentials";
import { githubRequest } from "@/lib/github/client";
import { processGithubWebhookEvents } from "@/lib/domain/github-webhooks/process";
import { cleanupExpiredMakerGithubAuthorizations, dueGithubIntegrationTargets, reconcileGithubBinding, reconcileLinkedGithubIssue } from "@/lib/domain/github-webhooks/reconcile";

/** Reads existing external results even after flags stop new writes. Never refreshes Star user tokens. */
export async function reconcileGithubIntegrations(ctx: JobContext<null>, provider: Partial<Pick<FeedbackProviderOptions, "verify" | "token" | "request">> = {}): Promise<JobOutcome<null>> {
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
  for (const target of await dueGithubIntegrationTargets(options)) {
    // Reserve the bounded pool/transaction lifecycle before beginning another target.
    if (!ctx.hasBudget() || ctx.signal?.aborted || Date.now() >= options.deadlineAt - 6_000) break;
    const state = target.kind === "binding" ? await reconcileGithubBinding(Number(target.id), options)
      : target.kind === "issue" ? await reconcileLinkedGithubIssue(target.id, options) : await reconcileFeedbackIssue(target.id, options);
    ctx.log("github.integration_reconcile", { kind: target.kind, state });
    processed += 1;
  }
  ctx.log("github.integration_reconcile_tick", { processed, events, expiredCredentials, expiredDispatches });
  return { done: true, cursor: null };
}
