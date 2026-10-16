import type { ProductAuditCampaign } from "@/lib/db/schema";
import { assertJobLeaseAtWallTime, type JobLease } from "@/lib/jobs/control";
import { modelCapacityRequestIdentitySchema } from "@/lib/llm/capacity";
import { capturedClaudeCliRun, reviewerModelOwner } from "@/lib/llm/cli-model-capacity";
import type { ReviewInput } from "./agent-review-contract";
import { lockAuditDispatchItem } from "./product-audit";

/**
 * 발행분 감사 한 건의 Claude CLI 호출을 공통 슬롯에 묶는 run(05c-5). reviewWithAgent 가 argv·stdin·parser 를 그대로 만들고 run 만
 * runner 로 바뀐다. settled() 가 미룸이면 그 자리와 새 시작을 멈추고, skipped·not_started 면 감사 시도 행을 넣지 않는다.
 * 게이트웨이(abcllm) 감사는 native 종료 근거가 없어 여기로 오지 않는다(open 이면 계속 미룸).
 */
export function auditCliModelCapacity(value: { campaign: Pick<ProductAuditCampaign, "id" | "provider" | "model" | "promptVersion" | "rulesVersion">;
  item: { id: number; slug: string }; input: ReviewInput; lease: JobLease; beforeSpawn: () => boolean }) {
  const { campaign, item, input, lease } = value, model = campaign.model, logical = `bg:audit:${item.id}`;
  if (lease.name !== "product-audit") throw new Error("product_audit_job_lease_required");
  const job = { name: "product-audit" as const, token: lease.token, requestedVersion: lease.requestedVersion };
  return capturedClaudeCliRun("product-audit", model, {
    beforeSpawn: value.beforeSpawn,
    plan: async () => ({ target: { kind: "audit", itemId: item.id }, identity: modelCapacityRequestIdentitySchema.parse({ owner: reviewerModelOwner(),
      class: "background", pool: "reviewer", routeId: "product-audit", provider: "claude-cli", model, workKey: `${logical}:${input.inputHash}` }) }),
    prove: async (tx, call) => {
      const row = await lockAuditDispatchItem(tx, { itemId: item.id, slug: item.slug, campaign });
      if (!row) return null;
      await assertJobLeaseAtWallTime(tx, lease, "update");
      return { kind: "product_audit_cli", version: 1, logicalWorkKey: logical, itemId: item.id, campaignId: campaign.id, productId: row.productId,
        slug: item.slug, inputHash: input.inputHash, promptVersion: campaign.promptVersion, rulesVersion: campaign.rulesVersion, attempts: row.attempts,
        provider: "claude-cli", model, routeId: "product-audit", transport: call.transport, totalTokenBound: call.totalTokenBound,
        chargedTokens: call.totalTokenBound, job };
    },
  });
}
