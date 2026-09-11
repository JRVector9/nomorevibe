import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { requestJob } from "@/lib/jobs/control";
import { findByUrl } from "@/lib/domain/products/repository";
import { loadReviewDocument } from "./review-document";
import { getSettings } from "@/lib/crawl/settings";
import { judge, factsFromRepoMeta, pageFactsFromDocument } from "@/lib/crawl/rules";
import { isReviewCandidate, REVIEW_RULES_VERSION, type ReviewOutcome } from "@/lib/crawl/agent-review-contract";
import { listReviewCandidates, loadReviewInput, claimAgentReview, recordAgentReview,
  requeueStaleReviewSources } from "@/lib/crawl/agent-review-repository";
import { reviewModel, reviewWithAgent, REVIEW_CLI_TIMEOUT_MS } from "@/lib/crawl/agent-review";

/**
 * 한 틱에 동시에 띄우는 외부 심사 수.
 *
 * 한 건씩이면 1분 주기에 시간당 60회가 상한이었다. CLI 제한 20초짜리 둘을 이어 붙이면 잡 예산
 * 25초를 넘으므로, 늘리려면 동시에 띄워야 한다. 후보마다 claim·입력 hash·lease를 따로 검증하고
 * 같은 lease로 이미 도는 claim은 건너뛰므로 둘이 같은 후보를 잡지 않는다.
 */
const MAX_CONCURRENT_REVIEWS = 2;

/** 틱마다 외부 심사를 최대 두 건 동시에 돌린다. 기존 규칙·후보 상태·발행 조건은 그대로 둔다. */
export async function reviewCrawlCandidates(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const startedAt = Date.now();
  const settings = await getSettings();
  if (!settings.enabled || settings.reviewMode === "off") {
    ctx.log("crawl.agent_review_skipped", { reason: !settings.enabled ? "disabled" : "review_off" });
    return { done: true };
  }
  const lease = ctx.lease;
  if (!lease) throw new Error("AI review requires a valid worker job lease");
  const model = reviewModel();
  if (!model) throw new Error("CRAWL_REVIEW_MODEL must be configured before enabling AI review");
  const requeued = await requeueStaleReviewSources(settings, lease, 20);
  if (requeued) ctx.log("crawl.agent_review_sources_queued", { count: requeued });
  const candidates = await listReviewCandidates(settings, 20);
  if (!candidates.length) return { done: true };
  const remaining = () => 24_000 - (Date.now() - startedAt);
  /** 외부 심사마다 enforce에서 승인을 후보에 반영했는지 */
  const reviews: Promise<boolean>[] = [];
  let settled: PromiseSettledResult<boolean>[] = [];
  let approved = 0;

  try {
    for (const candidate of candidates) {
      if (reviews.length >= MAX_CONCURRENT_REVIEWS || !ctx.hasBudget() || remaining() < 1_000) break;
      if (!isReviewCandidate(candidate)) continue;
      const document = await loadReviewDocument(candidate.repo);
      if (!document) continue;
      const input = await loadReviewInput(candidate, document, settings);
      if (input.validUntil.getTime() <= Date.now()) continue;
      // 판정 잡과 같은 추출기로 규칙을 태운다. 여기서 PageFacts를 손으로 조립했을 때 본문이 빠져
      // "설치 유도 아님"을 지나쳤고, 재수집으로 본문에 npm install이 생긴 needs_review 후보를 모델이
      // 메타데이터만 보고 승인했다(codex 재현). 규칙이 거부하는 것은 모델에게 보내지 않는다.
      const verdict = judge(factsFromRepoMeta(document.repo, document.repoMeta), pageFactsFromDocument(document),
        settings, new Date(), settings.agentEvidence.enforceEligibility ? {
          relationship: input.snapshot.relationship, scanState: input.snapshot.scanState,
          observations: input.snapshot.evidence.map(evidence => evidence.observation),
        } : undefined);
      const existing = document.productUrl && verdict.state !== "rejected" ? await findByUrl(document.productUrl) : null;
      const hardReason = verdict.state === "rejected" ? verdict.reason
        : existing ? existing.status === "banned" ? "banned" : "already_listed" : null;
      // Missing development evidence is a hold, never proof the product is ineligible.
      // Enforce this before a model call: real-source review showed the model conflating the two.
      const evidenceHold = !hardReason && settings.agentEvidence.enforceEligibility
        && !input.snapshot.evidenceSummary.eligible ? input.snapshot.evidenceSummary.reason : null;
      const provider = hardReason || evidenceHold ? "rules" : "claude-cli";
      if (!ctx.hasBudget() || remaining() < 1_000) break;
      const context = { candidate, document, settings, input, lease };
      const claim = await claimAgentReview({ ...context, provider, model: provider === "rules" ? REVIEW_RULES_VERSION : model });
      if (claim.kind === "skipped") {
        ctx.log("crawl.agent_review_skipped", { repo: candidate.repo, reason: claim.reason });
        continue;
      }
      if (hardReason || evidenceHold || claim.kind === "reused") {
        const outcome: ReviewOutcome | undefined = hardReason ? {
          decision: "reject", reason: `기존 등재 규칙에 해당합니다: ${hardReason}`, evidenceIds: ["product"],
        } : evidenceHold ? {
          decision: "needs_review", reason: `개발 근거 확인이 필요합니다 (${evidenceHold}). 현재 수집 내용만으로 승인하거나 부적격으로 확정하지 않습니다.`,
          evidenceIds: ["product", ...input.snapshot.evidence.slice(0, 8).map(item => item.id)],
        } : claim.attempt.outcome ?? undefined;
        const recorded = await recordAgentReview({ ...context, attempt: claim.attempt, outcome });
        if (recorded.applied && outcome?.decision === "approve") approved++;
        ctx.log("crawl.agent_reviewed", { repo: candidate.repo, provider, reused: claim.kind === "reused", ...recorded });
        continue;
      }

      const review = (async () => {
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
        return recorded.applied && result.ok && result.outcome.decision === "approve";
      })();
      // 이 호출이 도는 동안 다음 후보의 DB 작업을 기다린다. 그 사이 먼저 실패하면 아직 아무도 받지 않은
      // 거부가 되어 워커 프로세스가 죽는다. 결과는 아래 allSettled가 받으므로 여기서는 받았다고만 표시한다.
      review.catch(() => {});
      reviews.push(review);
    }
  } finally {
    // 앞에서 예외가 나도 떠 있는 호출은 끝까지 기다린다. 두고 나가면 lease를 놓은 뒤에 기록을 시도한다.
    // 한 호출이 실패해도 다른 호출의 기록은 그대로 끝난다.
    settled = await Promise.allSettled(reviews);
  }
  approved += settled.filter(result => result.status === "fulfilled" && result.value).length;
  // 승인된 후보가 발행 잡의 5분 주기를 기다리지 않게 배치 끝에 한 번 알린다. 요청은 신호일 뿐이라
  // 한 번이면 이번 배치의 승인이 모두 실린다. observe는 발행 조건을 바꾸지 않으므로 후보에 반영된 승인만 센다.
  if (approved) await requestJob("crawl-publish");
  const failure = settled.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
  return { done: false };
}
