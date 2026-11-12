import { randomUUID } from "node:crypto";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { capacityRefusalReason } from "@/lib/llm/capacity-busy-targets";
import { modelCapacityIndeterminateReason } from "@/lib/llm/capacity";
import { reconcileGatewayNotStarted, reconcileGatewayHttpRejected, findOwnPendingModelRequest, requestTextProfileModelSlot, cancelReservedModelSlot,
  reconcileTextProfileGatewayTerminal, markModelDispatchIndeterminate } from "@/lib/llm/capacity-repository";
import { markUnsettledDispatch } from "@/lib/llm/capacity-unsettled";
import { writeKeywordsWithReservedGateway } from "@/lib/crawl/agent-review-gateway";
import { textProfileInputHash, type ModelCapacityRequestIdentity } from "@/lib/llm/capacity";
import { prepareProfileModelDispatch, type ProfileTask, type ProfileWriteExpectation } from "./search-profiles";
import { profileEvidence, writeKeywords, type KeywordResult } from "./search-profile";
import type { JobLease } from "@/lib/jobs/control";
import type { RoleLease } from "@/lib/jobs/role-leader";
import { textRouteCallable } from "@/lib/llm/serving-contract-store";
import { textProfileServingProvider } from "@/lib/llm/text-profile-serving-contract";
import { textTaskModel } from "@/lib/llm/ai-task-rank-scope";
import { assertProviderNotRateLimited } from "@/lib/llm/provider-rate-limit";

export type ProfileCapacityResult = { kind: "skipped" } | { kind: "result"; result: KeywordResult; expectedProfile?: ProfileWriteExpectation };
/** Fixed route coordinator. No callback, JSON shape or timeout is dispatch authority. */
export async function writeKeywordsWithModelCapacity(task: ProfileTask, lease: JobLease,
  options: { timeoutMs: number; signal?: AbortSignal; roleLease?: RoleLease }): Promise<ProfileCapacityResult> {
  const snapshot = structuredClone(task), ownedLease = structuredClone(lease), captured = { ...options, timeoutMs: options.timeoutMs,
    roleLease: options.roleLease && structuredClone(options.roleLease) };
  // provider 는 계약 모듈이 정한다(abcllm 계약이 있으면 abcllm, 없고 local-direct 직접 계약이 닿으면 local-direct — PR 3b-E)
  const model = textTaskModel("product-search-profile"), provider = textProfileServingProvider(model);
  // 순위(PR B)가 계약을 확인하고 범위를 열었다 — 그 사이 계약이 닫혔으면 이 모델만의 일이라 다음 순위로 넘긴다(옛 게이트웨이 길로 떨어지지 않는다)
  if (!textRouteCallable("product-search-profile", model, provider)) throw new ModelCapacityDeferredError("provider_contract_unavailable");
  // 공급자가 이 경로·모델에 429(빈도 한도)를 준 뒤 쉬는 중이면 장부에 묻지 않고 이 모델만 미룬다(다음 순위가 받는다, provider-rate-limit.ts)
  assertProviderNotRateLimited({ routeId: "product-search-profile", provider, model });
  const prepared = await prepareProfileModelDispatch(snapshot, ownedLease, captured);
  if (prepared.kind === "disabled") return { kind: "result", result: await writeKeywords(profileEvidence(snapshot.product, snapshot.reviewerNote), options) };
  if (prepared.kind === "skipped") return prepared;
  const role = captured.roleLease;
  if (!role || role.role !== "text") throw new ModelCapacityDeferredError("owner_unavailable");
  const input = prepared.intent.input;
  const identity: ModelCapacityRequestIdentity = { owner: { instanceId: role.instanceId, bootId: role.bootId },
    workKey: `text:profile:${input.productId}:${textProfileInputHash(input)}`, class: "background", pool: "text",
    routeId: "product-search-profile", provider: prepared.call.provider, model: input.model };
  const pending = await findOwnPendingModelRequest(identity);
  const request = { ...identity, requestId: pending?.requestId ?? randomUUID() };
  const slot = await requestTextProfileModelSlot(request, input.productId);
  if (slot.kind !== "granted") throw new ModelCapacityDeferredError(await capacityRefusalReason(request, slot));
  let current;
  try {
    current = await prepareProfileModelDispatch(snapshot, ownedLease, { ...captured,
      reserved: { reservation: slot.reservation, identity, expected: input, call: prepared.call } });
  } catch (error) {
    // Cancel is a reserved-only CAS. A dispatch with an unknown commit outcome is never refunded.
    try { await cancelReservedModelSlot(slot.reservation); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "profile dispatch and reservation cleanup failed"); }
    if (error instanceof Error && error.message === "text_profile_model_reservation_lost")
      throw new ModelCapacityDeferredError("reservation_lost");
    throw error;
  }
  if (current.kind !== "ready" || !current.dispatch) {
    await cancelReservedModelSlot(slot.reservation);
    if (current.kind === "disabled") throw new ModelCapacityDeferredError("disabled");
    return { kind: "skipped" };
  }
  // Reentry resolves only after the transaction's commit acknowledgment. No HTTP under SQL locks.
  const dispatch = current.dispatch;
  let native: Awaited<ReturnType<typeof writeKeywordsWithReservedGateway>>;
  try {
    native = await writeKeywordsWithReservedGateway(current.intent.evidence, dispatch, current.call,
      { signal: captured.signal, timeoutMs: captured.timeoutMs });
  } catch (error) {
    try {
      if (!await markModelDispatchIndeterminate(dispatch, modelCapacityIndeterminateReason({ signal: captured.signal, error })))
        throw new Error("text_profile_dispatch_not_marked");
    } catch (cleanup) { throw new AggregateError([error, cleanup], "profile transport and unknown recording failed"); }
    throw error;
  }
  try {
    if (native.terminal) await reconcileTextProfileGatewayTerminal(native.terminal);
    else if (native.notStarted) await reconcileGatewayNotStarted(native.notStarted);
    // 0174: 공급자가 처리하지 않고 거절한 완결 응답(429·401·403) — 결과 미확정 대신 확정 실패로 정산해 칸을 바로 비운다
    else if (native.rejected) await reconcileGatewayHttpRejected(native.rejected);
    else if (!await markModelDispatchIndeterminate(dispatch, modelCapacityIndeterminateReason({ signal: captured.signal, timedOut: !native.result.ok && native.result.error === "timeout" })))
      throw new Error("text_profile_dispatch_not_marked");
  } catch (error) {
    if (native.terminal || native.notStarted || native.rejected) await markUnsettledDispatch(dispatch);
    if (!native.result.ok) throw new AggregateError([native.result, error], "profile result and terminal recording failed");
    throw error;
  }
  return { kind: "result", result: native.result, expectedProfile: current.intent.input.profile };
}
