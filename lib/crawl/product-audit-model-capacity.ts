import type { ProductAuditCampaign } from "@/lib/db/schema";
import { assertJobLeaseAtWallTime, type JobLease } from "@/lib/jobs/control";
import { modelCapacityRequestIdentitySchema } from "@/lib/llm/capacity";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import type { CliEngineSource } from "@/lib/llm/cli-engine-config";
import { capturedClaudeCliRun, reviewerModelOwner, runRemoteCliTaskWithModelCapacity } from "@/lib/llm/cli-model-capacity";
import { prepareRemoteCliTaskCall } from "@/lib/crawl/cli-task-remote";
import { REVIEW_SYSTEM_PROMPT, reviewCliArgs, reviewCliPrompt, type AgentReviewResult } from "@/lib/crawl/agent-review";
import { MAX_REVIEW_INPUT_BYTES, validateReviewOutcome, type ReviewInput } from "./agent-review-contract";
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

/**
 * 발행분 감사 한 건을 원격 CLI(opencode) 슬롯에 묶어 부른다. 동결된 감사 행의 provider/model 은 그대로 두고,
 * 물리 호출만 opencode-cli 로 바꾼다. prepare 가 계약을 못 만들면 Claude 로 되돌리지 않고 typed defer 로 끝낸다.
 */
export async function reviewAuditWithRemoteCliModelCapacity(value: {
  campaign: Pick<ProductAuditCampaign, "id" | "provider" | "model" | "promptVersion" | "rulesVersion">;
  item: { id: number; slug: string };
  input: ReviewInput;
  lease: JobLease;
  beforeSpawn: () => boolean;
  source: CliEngineSource;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ kind: "result"; result: AgentReviewResult } | { kind: "skipped" } | { kind: "not_started" }> {
  const { campaign, item, input, lease, source } = value;
  const model = campaign.model;
  const logical = `bg:audit:${item.id}`;
  if (lease.name !== "product-audit") throw new Error("product_audit_job_lease_required");
  const job = { name: "product-audit" as const, token: lease.token, requestedVersion: lease.requestedVersion };

  const serialized = JSON.stringify(input.snapshot);
  if (Buffer.byteLength(serialized, "utf8") > MAX_REVIEW_INPUT_BYTES) {
    return { kind: "result", result: { ok: false, error: "input_too_large" } };
  }

  const cliArgs = reviewCliArgs(model);
  const schemaAt = cliArgs.indexOf("--json-schema");
  const schemaValue = schemaAt >= 0 ? cliArgs[schemaAt + 1] : undefined;
  if (!schemaValue) throw new Error("review_cli_schema_missing");
  const schema = JSON.parse(schemaValue) as Record<string, unknown>;

  const prepared = await prepareRemoteCliTaskCall({
    task: "product-audit",
    connectionId: source.connectionId,
    model,
    reasoningEffort: source.reasoningEffort,
    inputHash: input.inputHash,
    messages: [
      { role: "system", content: REVIEW_SYSTEM_PROMPT },
      { role: "user", content: reviewCliPrompt(serialized) },
    ],
    responseFormat: { type: "json_schema", json_schema: { name: "review_outcome", schema } },
    timeoutMs: value.timeoutMs,
  });
  if (prepared.kind === "unsupported") throw new ModelCapacityDeferredError("provider_contract_unavailable");

  const settled = await runRemoteCliTaskWithModelCapacity(prepared, value.signal, {
    beforeSpawn: value.beforeSpawn,
    plan: async () => ({
      target: { kind: "audit", itemId: item.id },
      identity: modelCapacityRequestIdentitySchema.parse({
        owner: reviewerModelOwner(),
        class: "background",
        pool: "reviewer",
        routeId: "product-audit",
        provider: "opencode-cli",
        model,
        workKey: `${logical}:${input.inputHash}`,
      }),
    }),
    prove: async (tx, call) => {
      const row = await lockAuditDispatchItem(tx, { itemId: item.id, slug: item.slug, campaign });
      if (!row) return null;
      await assertJobLeaseAtWallTime(tx, lease, "update");
      return {
        kind: "product_audit_cli",
        version: 1,
        logicalWorkKey: logical,
        itemId: item.id,
        campaignId: campaign.id,
        productId: row.productId,
        slug: item.slug,
        inputHash: input.inputHash,
        promptVersion: campaign.promptVersion,
        rulesVersion: campaign.rulesVersion,
        attempts: row.attempts,
        provider: "opencode-cli",
        model,
        routeId: "product-audit",
        transport: call.transport,
        totalTokenBound: call.totalTokenBound,
        chargedTokens: call.totalTokenBound,
        job,
      };
    },
  });

  if (settled.kind !== "ran") return { kind: settled.kind };
  if (!settled.result.ok) return { kind: "result", result: settled.result };
  try {
    const outcome = validateReviewOutcome(input, JSON.parse(settled.result.content));
    return { kind: "result", result: { ok: true, outcome, usage: settled.result.usage } };
  } catch {
    return { kind: "result", result: { ok: false, error: "invalid_output", usage: settled.result.usage } };
  }
}
