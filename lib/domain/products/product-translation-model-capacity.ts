import { randomUUID } from "node:crypto";
import { translateProductFields } from "@/lib/crawl/translate";
import { prepareProductTranslationGatewayCall, translateProductFieldsWithReservedGateway } from "@/lib/crawl/agent-review-gateway";
import { reconcileGatewayNotStarted, readModelCapacityCallerControl, findOwnPendingModelRequest, requestProductTranslationModelSlot,
  findOwnPendingProductTextRequests, cancelOwnPendingProductTextRequest,
  cancelReservedModelSlot, markModelDispatchIndeterminate, reconcileProductTranslationGatewayTerminal } from "@/lib/llm/capacity-repository";
import { markUnsettledDispatch } from "@/lib/llm/capacity-unsettled";
import { capacityRefusalReason } from "@/lib/llm/capacity-busy-targets";
import { modelCapacityRequestIdentitySchema, productTranslationInputHash, productTranslationLogicalWorkKey } from "@/lib/llm/capacity";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { modelCapacityIndeterminateReason } from "@/lib/llm/capacity";
import { translationSourceText } from "./translation-policy";
import { pendingProductTranslationBatch, prepareProductTranslationDispatch, type ProductTranslationTask } from "./translations";
import type { JobLease } from "@/lib/jobs/control";
import { roleLeaseFromEnv, type RoleLease } from "@/lib/jobs/role-leader";
import type { KoreanTaglineBatch } from "./korean-tagline";
import type { ProductTranslationWriteExpectation } from "./translations";
import { textRouteAccess } from "@/lib/llm/serving-contract-store";
import { productTranslationServingProvider } from "@/lib/llm/product-translation-serving-contract";
import { textTaskModel } from "@/lib/llm/ai-task-rank-scope";

export type ProductTranslationCapacityResult = { kind: "skipped" } | {
  kind: "result"; result: KoreanTaglineBatch; expectation?: ProductTranslationWriteExpectation; batch?: readonly ProductTranslationTask[];
};

/** A single demanded batch; neither queue waiting nor HTTP retains a DB TX. */
export async function translateProductFieldsWithModelCapacity(value: readonly ProductTranslationTask[], job: JobLease,
  valueOptions: { timeoutMs: number; signal?: AbortSignal; roleLease?: RoleLease; deadlineAt?: number }): Promise<ProductTranslationCapacityResult> {
  let tasks = structuredClone(value);
  const lease = structuredClone(job);
  const options = { timeoutMs: valueOptions.timeoutMs, signal: valueOptions.signal, deadlineAt: valueOptions.deadlineAt,
    roleLease: valueOptions.roleLease && structuredClone(valueOptions.roleLease) };
  const env = Object.fromEntries(["ROLE_LEASE_ROLE", "ROLE_LEASE_INSTANCE_ID", "ROLE_LEASE_BOOT_ID", "ROLE_LEASE_RELEASE",
    "ROLE_LEASE_EPOCH", "ROLE_LEASE_BATCH_VERSION", "ROLE_LEASE_BATCH_EPOCH", "ROLE_LEASE_HOST"].map(key => [key, process.env[key]]));
  let items = tasks.map(task => ({ name: task.source.name, locale: task.locale, field: task.field,
    text: translationSourceText(task.source, task.field) }));
  const model = textTaskModel("product-translate");
  const provider = productTranslationServingProvider(model);
  const legacy = async () => ({ kind: "result" as const,
    result: await translateProductFields(items, options.timeoutMs, undefined, options.signal, model) });
  // 순위(PR B)가 계약을 확인하고 범위를 열었다 — 그 사이 계약이 닫혔으면 이 모델만의 일이라 다음 순위로 넘긴다(옛 게이트웨이 길로 떨어지지 않는다)
  if (textRouteAccess("product-translate", model, provider).block) throw new ModelCapacityDeferredError("provider_contract_unavailable");
  const control = await readModelCapacityCallerControl();
  if (control.mode === "disabled") return legacy();
  if (control.mode !== "open") throw new ModelCapacityDeferredError("draining");
  if (!control.policy?.routes.some(route => route.routeId === "product-translate" && route.provider === provider && route.model === model))
    throw new ModelCapacityDeferredError("unmapped");
  let call = prepareProductTranslationGatewayCall(items, { model, timeoutMs: options.timeoutMs, provider });
  if (call.kind !== "prepared") throw new ModelCapacityDeferredError(call.reason);
  const roleLease = options.roleLease ?? (env.ROLE_LEASE_ROLE === "text" || env.ROLE_LEASE_ROLE === "translation"
    ? roleLeaseFromEnv(env.ROLE_LEASE_ROLE, env) : undefined);
  if (!roleLease) throw new ModelCapacityDeferredError("owner_unavailable");
  let initial = await prepareProductTranslationDispatch(tasks, lease, { roleLease, call });
  if (initial.kind === "disabled") return legacy();
  if (initial.kind === "skipped") return initial;
  if (!("members" in initial)) throw new Error("product_translation_preparation_invalid");
  const expected = { owner: { instanceId: initial.role.instanceId, bootId: initial.role.bootId },
    model, routeId: "product-translate" as const, provider };
  let adopted: { requestId: string; state: "waiting" | "reserved" } | undefined;
  for (const candidate of await findOwnPendingProductTextRequests(expected)) {
    if (options.signal?.aborted) throw new ModelCapacityDeferredError("reservation_lost");
    const recovered = await pendingProductTranslationBatch(candidate.memberKeys);
    if (!recovered) { await cancelOwnPendingProductTextRequest(candidate, expected); continue; }
    const recoveredItems = recovered.map(task => ({ name: task.source.name, locale: task.locale, field: task.field,
      text: translationSourceText(task.source, task.field) }));
    const recoveredCall = prepareProductTranslationGatewayCall(recoveredItems, { model, timeoutMs: options.timeoutMs, provider });
    if (recoveredCall.kind !== "prepared") throw new ModelCapacityDeferredError(recoveredCall.reason);
    const current = await prepareProductTranslationDispatch(recovered, lease, { roleLease, call: recoveredCall });
    if (current.kind === "disabled") return legacy();
    if (current.kind === "skipped") { await cancelOwnPendingProductTextRequest(candidate, expected); continue; }
    if (!("members" in current)) throw new Error("product_translation_preparation_invalid");
    const recoveredKey = `${productTranslationLogicalWorkKey(current.members)}:${productTranslationInputHash({ members: current.members, model: textTaskModel("product-translate") })}`;
    if (candidate.request.workKey !== recoveredKey) { await cancelOwnPendingProductTextRequest(candidate, expected); continue; }
    tasks = recovered; items = recoveredItems; call = recoveredCall; initial = current;
    adopted = { requestId: candidate.request.requestId, state: candidate.state }; break;
  }
  const { members, role } = initial;
  const identity = modelCapacityRequestIdentitySchema.parse({ owner: { instanceId: role.instanceId, bootId: role.bootId },
    class: "background", pool: "text", routeId: "product-translate", provider: call.provider, model,
    workKey: `${productTranslationLogicalWorkKey(members)}:${productTranslationInputHash({ members, model })}` });
  const pending = adopted ?? await findOwnPendingModelRequest(identity);
  if (pending?.state === "dispatched") throw new ModelCapacityDeferredError("dispatched");
  const request = { ...identity, requestId: pending?.requestId ?? randomUUID() };
  const slot = await requestProductTranslationModelSlot(request, members);
  // 줄에 서지 못한 capacity(멤버 fence)는 이 묶음만의 work_busy — 잡은 이 멤버를 넘기고 다음 수요로 간다(2026-10-30 결정)
  if (slot.kind !== "granted") throw new ModelCapacityDeferredError(await capacityRefusalReason(request, slot.reason));
  let prepared: Awaited<ReturnType<typeof prepareProductTranslationDispatch>>;
  try {
    if (options.signal?.aborted) throw new ModelCapacityDeferredError("reservation_lost");
    prepared = await prepareProductTranslationDispatch(tasks, lease, { roleLease, call,
      reserved: { reservation: slot.reservation, identity, members, role },
      ...(options.deadlineAt === undefined ? {} : { callBudget: { deadlineAt: options.deadlineAt, minimumRemainingMs: options.timeoutMs + 2_000 } }) });
  } catch (error) {
    try { await cancelReservedModelSlot(slot.reservation); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "product_translation_reservation_cleanup_failed"); }
    throw error;
  }
  if (prepared.kind !== "ready" || !("dispatch" in prepared)) {
    await cancelReservedModelSlot(slot.reservation);
    if (prepared.kind === "disabled") throw new ModelCapacityDeferredError("disabled");
    return { kind: "skipped" as const };
  }
  let native: Awaited<ReturnType<typeof translateProductFieldsWithReservedGateway>>;
  try { native = await translateProductFieldsWithReservedGateway(items, prepared.dispatch, call,
    { signal: options.signal, timeoutMs: options.timeoutMs }); }
  catch (error) {
    try {
      if (!await markModelDispatchIndeterminate(prepared.dispatch, modelCapacityIndeterminateReason({ signal: options.signal, error })))
        throw new Error("product_translation_dispatch_not_marked");
    } catch (cleanup) { throw new AggregateError([error, cleanup], "product_translation_transport_cleanup_failed"); }
    throw error;
  }
  // Physical history settles before current job/signal/domain writer decisions.
  try {
    if (native.terminal) await reconcileProductTranslationGatewayTerminal(native.terminal);
    else if (native.notStarted) await reconcileGatewayNotStarted(native.notStarted);
    else if (!await markModelDispatchIndeterminate(prepared.dispatch, modelCapacityIndeterminateReason({ signal: options.signal, timedOut: !native.result.ok && native.result.error === "timeout" })))
      throw new Error("product_translation_dispatch_not_marked");
  } catch (cleanup) {
    if (native.terminal || native.notStarted) await markUnsettledDispatch(prepared.dispatch);
    if (!native.result.ok) throw new AggregateError([native.result, cleanup], "product_translation_result_cleanup_failed");
    throw cleanup;
  }
  return { kind: "result" as const, result: native.result, expectation: prepared.expectation, ...(adopted ? { batch: tasks } : {}) };
}
