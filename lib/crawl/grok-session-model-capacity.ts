import { assertJobLeaseAtWallTime, type JobLease } from "@/lib/jobs/control";
import { grokSessionInputHash, grokSessionLogicalWorkKey, modelCapacityRequestIdentitySchema } from "@/lib/llm/capacity";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { grokCliCallInput, reviewerModelOwner, runCliWithModelCapacity } from "@/lib/llm/cli-model-capacity";
import { serviceInstanceId } from "@/lib/operations/instance";
import type { GrokCliRun } from "./agent-review-grok";

/**
 * Grok 세션 점검 한 번을 공통 슬롯에 묶는 run(05c-5, 설계 D3 — native kind, policy 의 background 최소 가중).
 * 인스턴스마다 로그인 파일 하나·관측 키 하나라 슬롯 주인은 이 서비스 인스턴스여야 한다. 슬롯이 미뤄지면 그대로 던져 관측을 남기지 않는다
 * — 오래 미뤄지면 갱신 호출 없이 6시간 토큰이 만료될 수 있다. spawn 전에 끝나면 legacy runGrokCli 처럼 cancelled 다.
 */
export function grokSessionCliRun(model: string, lease: JobLease): GrokCliRun {
  if (lease.name !== "grok-session-check") throw new Error("grok_session_job_lease_required");
  const job = { name: "grok-session-check" as const, token: lease.token, requestedVersion: lease.requestedVersion };
  return async (args, options) => {
    const outcome = await runCliWithModelCapacity(grokCliCallInput("grok-session-check", model, args, options), options.signal, {
      beforeSpawn: () => true,
      plan: async () => {
        const owner = reviewerModelOwner(), instanceId = serviceInstanceId();
        if (instanceId !== owner.instanceId) throw new ModelCapacityDeferredError("owner_unavailable");
        return { target: { kind: "grok-session", instanceId }, identity: modelCapacityRequestIdentitySchema.parse({ owner, class: "background",
          pool: "reviewer", routeId: "grok-session-check", provider: "grok-cli", model,
          workKey: `${grokSessionLogicalWorkKey(instanceId)}:${grokSessionInputHash({ instanceId, model })}` }) };
      },
      prove: async (tx, call, plan) => {
        const instanceId = plan.identity.owner.instanceId;
        await assertJobLeaseAtWallTime(tx, lease, "update");
        return { kind: "grok_session_cli", version: 1, instanceId, model, logicalWorkKey: grokSessionLogicalWorkKey(instanceId),
          inputHash: grokSessionInputHash({ instanceId, model }), provider: "grok-cli", routeId: "grok-session-check", transport: call.transport,
          totalTokenBound: call.totalTokenBound, chargedTokens: call.totalTokenBound, job };
      },
    });
    return outcome.kind === "ran" ? outcome.result : { kind: "cancelled" };
  };
}
