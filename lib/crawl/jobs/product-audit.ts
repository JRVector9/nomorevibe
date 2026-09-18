import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { getSettings } from "@/lib/crawl/settings";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { listReviewCandidates } from "@/lib/crawl/agent-review-repository";
import { reviewWithAgent, REVIEW_CLI_TIMEOUT_MS } from "@/lib/crawl/agent-review";
import { reviewWithGateway, REVIEW_GATEWAY_TIMEOUT_MS } from "@/lib/crawl/agent-review-gateway";
import { finishAuditCampaign, loadAuditInput, markAuditNoSource, pendingAuditItems, recordAuditResult,
  runningAuditCampaign } from "@/lib/crawl/product-audit";

/**
 * 틱의 길이와 새 호출을 시작할 여유.
 *
 * 1차 심사 잡과 같은 24초다. 같은 reviewer 워커에서 잡은 하나씩 차례로 돈다(scripts/worker.ts) —
 * 이 틱이 길수록 그 뒤에 온 새 후보가 오래 기다린다. 그래서 2차 심사(110초)처럼 늘리지 않는다.
 *
 * 남은 시간이 15초보다 적으면 새 호출을 시작하지 않는다. 실측(2026-09-18, 게이트웨이 100건)
 * p90 이 15초라, 그보다 짧게 남기고 시작한 호출은 상당수가 틱 끝에 잘려 시도만 하나 버린다.
 */
const TICK_MS = 24_000;
const MIN_CALL_MS = 15_000;
/** 설정(reviewConcurrency)의 상한과 같다. 1차 심사 잡의 안전망과 같은 값이다 */
const MAX_CONCURRENT_REVIEWS = 16;
/** 항목이 아니라 심사자 쪽이 없는 실패 — 이 틱을 멈추고 잡을 실패로 남겨 운영센터에 드러낸다 */
const REVIEWER_DOWN = new Set(["not_configured", "auth", "missing_cli", "model_unavailable"]);

/**
 * 발행분 감사. 진행 중인 감사에서 아직 답을 못 받은 제품을 1차 심사 글로 묻고 결과를 적는다.
 *
 * 적기만 한다. crawl_candidates.state 도 products.status 도 쓰지 않는다 — 내리는 것은 사람이
 * /admin/audit 에서 한 건씩 누른다.
 */
export async function auditPublishedProducts(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const startedAt = Date.now();
  const campaign = await runningAuditCampaign();
  if (!campaign) return { done: true };
  const settings = await getSettings();
  // 수집 스위치는 비상 정지다. 이것을 끄면 발행 문이 멈추는데, 감사가 계속 돌면 끈 순간 그 빈
  // 자리를 감사가 다 차지해 공유 게이트웨이에 오히려 더 많이 보낸다
  if (!settings.enabled) {
    ctx.log("product_audit.skipped", { reason: "disabled", campaign: campaign.id });
    return { done: true };
  }
  // 감사는 시작할 때 굳힌 글로만 묻는다. 배포로 글이 바뀌면 사람이 중단하고 새로 연다 — 자동으로
  // 다시 보지 않는다(글이 한 줄 바뀔 때마다 10,751건을 다시 부르지 않기로 했다)
  if (campaign.promptVersion !== REVIEW_PROMPT_VERSION || campaign.rulesVersion !== REVIEW_RULES_VERSION) {
    ctx.log("product_audit.skipped", { reason: "policy_changed", campaign: campaign.id });
    return { done: true };
  }
  /*
   * 먼저 양보한다. 발행 문에 한 번도 심사받지 않은 새 후보가 하나라도 있으면 이 틱은 쉰다.
   *
   * 새 후보는 심사를 받아야 공개되고, 공개분은 이미 떠 있다 — 기다려서 잃는 쪽이 새 후보다.
   * 같은 워커에서 차례로 돌므로 둘이 게이트웨이에 겹쳐 보내는 일은 없다 — 동시 호출은 늘
   * settings.reviewConcurrency 이하다(4 → 성공 94%, 6 → 87% 실측).
   *
   * "기다리는 후보가 하나라도 있으면"으로 두었을 때는 감사가 영영 돌지 않았다. 2026-09-18 프로드에서
   * 문은 여덟 번 모두 100건으로 찼고, 전부 이미 심사받은 보류 건이 24시간마다 다시 도는 것이었다
   * (새 후보 0건). 그 재심사에 양보할 이유는 없다 — observe 에서는 결과가 반영되지도 않는다.
   */
  if ((await listReviewCandidates(settings, 1, { unreviewedOnly: true })).length) {
    ctx.log("product_audit.yielded", { campaign: campaign.id });
    return { done: true };
  }
  const lease = ctx.lease;
  if (!lease) throw new Error("product audit requires a valid worker job lease");
  const concurrency = Math.min(settings.reviewConcurrency || 2, MAX_CONCURRENT_REVIEWS);
  const queue = await pendingAuditItems(campaign.id, concurrency * 4);
  if (!queue.length) {
    if (await finishAuditCampaign(campaign.id)) ctx.log("product_audit.finished", { campaign: campaign.id });
    return { done: true };
  }
  const remaining = () => TICK_MS - (Date.now() - startedAt);
  // 누가 볼지는 감사 행에 적혀 있다 — 도중에 1차 심사자를 바꿔도 한 감사는 한 모델이 본다
  const ceiling = campaign.provider === "abcllm" ? REVIEW_GATEWAY_TIMEOUT_MS : REVIEW_CLI_TIMEOUT_MS;
  let reviewed = 0, failed = 0, noSource = 0;
  let down: string | null = null;

  // 자리마다 다음 것을 집어 묻는다. 한 호출이 실패해도 그 자리는 다음 것으로 넘어간다
  const settled = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (down || !ctx.hasBudget() || remaining() < MIN_CALL_MS) return;
      const input = await loadAuditInput(item.slug, settings);
      if (!input) {
        noSource += 1;
        await markAuditNoSource(item.id, lease);
        continue;
      }
      const callStartedAt = new Date();
      const options = { model: campaign.model, timeoutMs: Math.max(1, Math.min(ceiling, remaining())), signal: ctx.signal };
      const result = campaign.provider === "abcllm"
        ? await reviewWithGateway(input, options)
        : await reviewWithAgent(input, options);
      // 멈추라고 해서 끊긴 것은 실패가 아니다 — 다음 회차가 처음부터 본다
      if (!result.ok && (result.error === "cancelled" || ctx.signal?.aborted)) return;
      const call = { itemId: item.id, startedAt: callStartedAt, provider: campaign.provider, model: campaign.model, input };
      if (result.ok) {
        reviewed += 1;
        await recordAuditResult({ ...call, ok: true, outcome: result.outcome }, lease);
        continue;
      }
      const reviewerDown = REVIEWER_DOWN.has(result.error);
      if (reviewerDown) down = result.error;
      else failed += 1;
      await recordAuditResult({ ...call, ok: false, error: result.error, counted: !reviewerDown }, lease);
    }
  }));

  ctx.log("product_audit.reviewed", { campaign: campaign.id, reviewed, failed, noSource });
  const failure = settled.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  if (down) throw new Error(`product_audit_reviewer_unavailable:${down}`);
  return { done: false };
}
