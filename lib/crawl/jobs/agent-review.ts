import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { findByUrl } from "@/lib/domain/products/repository";
import { getDocument } from "@/lib/crawl/repository";
import { getSettings } from "@/lib/crawl/settings";
import { judge, factsFromRepoMeta } from "@/lib/crawl/rules";
import { isReviewCandidate, REVIEW_RULES_VERSION, type ReviewOutcome } from "@/lib/crawl/agent-review-contract";
import { listReviewCandidates, loadReviewInput, claimAgentReview, recordAgentReview } from "@/lib/crawl/agent-review-repository";
import { reviewModel, reviewWithAgent, REVIEW_CLI_TIMEOUT_MS } from "@/lib/crawl/agent-review";

/** One external review per bounded tick; existing rules, candidate states and publication remain intact. */
export async function reviewCrawlCandidates(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const startedAt = Date.now();
  const settings = await getSettings();
  if (!settings.enabled || settings.reviewMode === "off") {
    ctx.log("crawl.agent_review_skipped", { reason: !settings.enabled ? "disabled" : "review_off" });
    return { done: true };
  }
  if (!ctx.lease) throw new Error("AI review requires a valid worker job lease");
  const model = reviewModel();
  if (!model) throw new Error("CRAWL_REVIEW_MODEL must be configured before enabling AI review");
  const candidates = await listReviewCandidates(settings, 20);
  if (!candidates.length) return { done: true };
  const remaining = () => 24_000 - (Date.now() - startedAt);

  for (const candidate of candidates) {
    if (!ctx.hasBudget() || remaining() < 1_000) return { done: false };
    if (!isReviewCandidate(candidate)) continue;
    const document = await getDocument(candidate.repo);
    if (!document) continue;
    const input = await loadReviewInput(candidate, document, settings);
    if (input.validUntil.getTime() <= Date.now()) continue;
    const page = document.pageMeta ?? {};
    const verdict = judge(factsFromRepoMeta(document.repo, document.repoMeta), {
      productUrl: document.productUrl, status: document.pageStatus,
      generator: typeof page.generator === "string" ? page.generator : null,
      title: typeof page.title === "string" ? page.title : null,
    }, settings, new Date(), settings.agentEvidence.enforceEligibility ? {
      relationship: input.snapshot.relationship, scanState: input.snapshot.scanState,
      observations: input.snapshot.evidence.map(evidence => evidence.observation),
    } : undefined);
    const existing = document.productUrl && verdict.state !== "rejected" ? await findByUrl(document.productUrl) : null;
    const hardReason = verdict.state === "rejected" ? verdict.reason
      : existing ? existing.status === "banned" ? "banned" : "already_listed" : null;
    const provider = hardReason ? "rules" : "claude-cli";
    if (!ctx.hasBudget() || remaining() < 1_000) return { done: false };
    const context = { candidate, document, settings, input, lease: ctx.lease };
    const claim = await claimAgentReview({ ...context, provider, model: hardReason ? REVIEW_RULES_VERSION : model });
    if (claim.kind === "skipped") {
      ctx.log("crawl.agent_review_skipped", { repo: candidate.repo, reason: claim.reason });
      continue;
    }
    if (hardReason || claim.kind === "reused") {
      const outcome: ReviewOutcome | undefined = hardReason ? {
        decision: "reject", reason: `기존 등재 규칙에 해당합니다: ${hardReason}`, evidenceIds: ["product"],
      } : claim.attempt.outcome ?? undefined;
      const recorded = await recordAgentReview({ ...context, attempt: claim.attempt, outcome });
      ctx.log("crawl.agent_reviewed", { repo: candidate.repo, provider, reused: claim.kind === "reused", ...recorded });
      continue;
    }

    const controller = new AbortController();
    // A lost heartbeat/lease must also stop a running CLI, not only prevent its final DB write.
    const ownershipPoll = setInterval(() => { if (!ctx.hasBudget()) controller.abort(); }, 250);
    ownershipPoll.unref?.();
    const result = await reviewWithAgent(input, {
      model, timeoutMs: Math.max(1, Math.min(REVIEW_CLI_TIMEOUT_MS, remaining())), signal: controller.signal,
    }).finally(() => clearInterval(ownershipPoll));
    const recorded = await recordAgentReview({
      ...context, attempt: claim.attempt,
      ...(result.ok ? { outcome: result.outcome, usage: result.usage } : {
        error: result.error, usage: result.usage,
        retryAfter: new Date(Date.now() + Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, claim.attempt.attemptNumber - 1))),
      }),
    });
    ctx.log("crawl.agent_reviewed", {
      repo: candidate.repo, provider, mode: settings.reviewMode, ...recorded,
      ...(result.ok ? { decision: result.outcome.decision } : { error: result.error }),
    });
    return { done: false };
  }
  return { done: false };
}
