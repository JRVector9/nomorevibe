import { randomUUID } from "node:crypto";
import { translateTaglinesToKorean } from "@/lib/crawl/translate";
import { prepareProductTaglineKoGatewayCall, translateTaglinesWithReservedGateway } from "@/lib/crawl/agent-review-gateway";
import { reconcileGatewayNotStarted, readModelCapacityCallerControl, findOwnPendingModelRequest, requestProductTaglineKoModelSlot,
  findOwnPendingProductTextRequests, cancelOwnPendingProductTextRequest,
  cancelReservedModelSlot, markModelDispatchIndeterminate, reconcileProductTaglineKoGatewayTerminal } from "@/lib/llm/capacity-repository";
import { markUnsettledDispatch } from "@/lib/llm/capacity-unsettled";
import { modelCapacityRequestIdentitySchema, productTaglineKoInputHash, productTaglineKoLogicalWorkKey } from "@/lib/llm/capacity";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { modelCapacityIndeterminateReason } from "@/lib/llm/capacity";
import { displayProjectName } from "./display-name";
import { pendingKoreanTaglineBatch, prepareKoreanTaglineDispatch, koreanTaglineSource, type KoreanTaglineTask } from "./korean-taglines";
import type { JobLease } from "@/lib/jobs/control";
import { roleLeaseFromEnv, type RoleLease } from "@/lib/jobs/role-leader";
import type { KoreanTaglineBatch } from "./korean-tagline";
import type { KoreanTaglineWriteExpectation } from "./korean-taglines";
import { textRouteCallable } from "@/lib/llm/serving-contract-store";
import { productTaglineKoServingProvider } from "@/lib/llm/product-tagline-ko-serving-contract";
import { textTaskModel } from "@/lib/llm/ai-task-rank-scope";

export type KoreanTaglineCapacityResult = { kind: "skipped" } | {
  kind: "result"; result: KoreanTaglineBatch; expectation?: KoreanTaglineWriteExpectation; batch?: readonly KoreanTaglineTask[];
};

/** A single demanded batch; neither queue waiting nor HTTP retains a DB TX. */
export async function translateKoreanTaglinesWithModelCapacity(value: readonly KoreanTaglineTask[], homeSlugs: readonly string[], job: JobLease,
  valueOptions: { timeoutMs: number; signal?: AbortSignal; roleLease?: RoleLease;
    pendingClaims?: { requestIds: Set<string>; claimBatch: (tasks: readonly KoreanTaglineTask[]) => boolean } }): Promise<KoreanTaglineCapacityResult> {
  let tasks = structuredClone(value);
  // Tick-local scheduling only; durable source/admission/dispatch checks remain below.
  const pendingClaims = valueOptions.pendingClaims;
  const home = structuredClone(homeSlugs), lease = structuredClone(job);
  const options = { timeoutMs: valueOptions.timeoutMs, signal: valueOptions.signal,
    roleLease: valueOptions.roleLease && structuredClone(valueOptions.roleLease) };
  const env = Object.fromEntries(["ROLE_LEASE_ROLE", "ROLE_LEASE_INSTANCE_ID", "ROLE_LEASE_BOOT_ID", "ROLE_LEASE_RELEASE",
    "ROLE_LEASE_EPOCH", "ROLE_LEASE_BATCH_VERSION", "ROLE_LEASE_BATCH_EPOCH", "ROLE_LEASE_HOST"].map(key => [key, process.env[key]]));
  let items = tasks.map(task => ({ name: displayProjectName(task.name, task.repoUrl), tagline: koreanTaglineSource(task) }));
  const legacy = async () => ({ kind: "result" as const,
    result: await translateTaglinesToKorean(items, options.timeoutMs, undefined, options.signal) });
  const provider = productTaglineKoServingProvider(textTaskModel("product-tagline-ko"));
  // 순위(PR B)가 계약을 확인하고 범위를 열었다 — 그 사이 계약이 닫혔으면 이 모델만의 일이라 다음 순위로 넘긴다(옛 게이트웨이 길로 떨어지지 않는다)
  if (!textRouteCallable("product-tagline-ko", textTaskModel("product-tagline-ko"), provider)) throw new ModelCapacityDeferredError("provider_contract_unavailable");
  const control = await readModelCapacityCallerControl();
  if (control.mode === "disabled") return legacy();
  if (control.mode !== "open") throw new ModelCapacityDeferredError("draining");
  if (!control.policy?.routes.some(route => route.routeId === "product-tagline-ko" && route.provider === provider && route.model === textTaskModel("product-tagline-ko")))
    throw new ModelCapacityDeferredError("unmapped");
  let call = prepareProductTaglineKoGatewayCall(items, { model: textTaskModel("product-tagline-ko"), timeoutMs: options.timeoutMs, provider });
  if (call.kind !== "prepared") throw new ModelCapacityDeferredError(call.reason);
  const roleLease = options.roleLease ?? (env.ROLE_LEASE_ROLE === "text" || env.ROLE_LEASE_ROLE === "translation"
    ? roleLeaseFromEnv(env.ROLE_LEASE_ROLE, env) : undefined);
  if (!roleLease) throw new ModelCapacityDeferredError("owner_unavailable");
  let initial = await prepareKoreanTaglineDispatch(tasks, home, lease, { roleLease, call });
  if (initial.kind === "disabled") return legacy();
  if (initial.kind === "skipped") return initial;
  if (!("members" in initial)) throw new Error("product_tagline_ko_preparation_invalid");
  const expected = { owner: { instanceId: initial.role.instanceId, bootId: initial.role.bootId },
    model: textTaskModel("product-tagline-ko"), routeId: "product-tagline-ko" as const, provider };
  let adopted: { requestId: string; state: "waiting" | "reserved" } | undefined;
  for (const candidate of await findOwnPendingProductTextRequests(expected)) {
    if (options.signal?.aborted) throw new ModelCapacityDeferredError("reservation_lost");
    if (pendingClaims?.requestIds.has(candidate.request.requestId)) continue;
    const recovered = await pendingKoreanTaglineBatch(candidate.memberKeys, home);
    if (pendingClaims?.requestIds.has(candidate.request.requestId)) continue;
    if (!recovered) { await cancelOwnPendingProductTextRequest(candidate, expected); continue; }
    const recoveredItems = recovered.map(task => ({ name: displayProjectName(task.name, task.repoUrl), tagline: koreanTaglineSource(task) }));
    const recoveredCall = prepareProductTaglineKoGatewayCall(recoveredItems, { model: textTaskModel("product-tagline-ko"), timeoutMs: options.timeoutMs, provider });
    if (recoveredCall.kind !== "prepared") throw new ModelCapacityDeferredError(recoveredCall.reason);
    const current = await prepareKoreanTaglineDispatch(recovered, home, lease, { roleLease, call: recoveredCall });
    if (pendingClaims?.requestIds.has(candidate.request.requestId)) continue;
    if (current.kind === "disabled") return legacy();
    if (current.kind === "skipped") { await cancelOwnPendingProductTextRequest(candidate, expected); continue; }
    if (!("members" in current)) throw new Error("product_tagline_ko_preparation_invalid");
    const recoveredKey = `${productTaglineKoLogicalWorkKey(current.members)}:${productTaglineKoInputHash({ members: current.members, model: textTaskModel("product-tagline-ko") })}`;
    if (candidate.request.workKey !== recoveredKey) { await cancelOwnPendingProductTextRequest(candidate, expected); continue; }
    // Only validated members enter the tick-local schedule; claim and adoption do not yield.
    if (pendingClaims && !pendingClaims.claimBatch(recovered)) continue;
    pendingClaims?.requestIds.add(candidate.request.requestId);
    tasks = recovered; items = recoveredItems; call = recoveredCall; initial = current;
    adopted = { requestId: candidate.request.requestId, state: candidate.state }; break;
  }
  const { members, role } = initial;
  const identity = modelCapacityRequestIdentitySchema.parse({ owner: { instanceId: role.instanceId, bootId: role.bootId },
    class: "background", pool: "text", routeId: "product-tagline-ko", provider: call.provider, model: textTaskModel("product-tagline-ko"),
    workKey: `${productTaglineKoLogicalWorkKey(members)}:${productTaglineKoInputHash({ members, model: textTaskModel("product-tagline-ko") })}` });
  const pending = adopted ?? await findOwnPendingModelRequest(identity);
  if (pending?.state === "dispatched") throw new ModelCapacityDeferredError("dispatched");
  if (!adopted && pending && pendingClaims?.requestIds.has(pending.requestId))
    throw new ModelCapacityDeferredError("work_busy");
  const request = { ...identity, requestId: pending?.requestId ?? randomUUID() };
  pendingClaims?.requestIds.add(request.requestId);
  const slot = await requestProductTaglineKoModelSlot(request, members);
  if (slot.kind !== "granted") throw new ModelCapacityDeferredError(slot.reason);
  let prepared: Awaited<ReturnType<typeof prepareKoreanTaglineDispatch>>;
  try {
    if (options.signal?.aborted) throw new ModelCapacityDeferredError("reservation_lost");
    prepared = await prepareKoreanTaglineDispatch(tasks, home, lease, { roleLease, call,
      reserved: { reservation: slot.reservation, identity, members, role } });
  } catch (error) {
    try { await cancelReservedModelSlot(slot.reservation); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "product_tagline_ko_reservation_cleanup_failed"); }
    throw error;
  }
  if (prepared.kind !== "ready" || !("dispatch" in prepared)) {
    await cancelReservedModelSlot(slot.reservation);
    if (prepared.kind === "disabled") throw new ModelCapacityDeferredError("disabled");
    return { kind: "skipped" as const };
  }
  let native: Awaited<ReturnType<typeof translateTaglinesWithReservedGateway>>;
  try { native = await translateTaglinesWithReservedGateway(items, prepared.dispatch, call,
    { signal: options.signal, timeoutMs: options.timeoutMs }); }
  catch (error) {
    try {
      if (!await markModelDispatchIndeterminate(prepared.dispatch, modelCapacityIndeterminateReason({ signal: options.signal, error })))
        throw new Error("product_tagline_ko_dispatch_not_marked");
    } catch (cleanup) { throw new AggregateError([error, cleanup], "product_tagline_ko_transport_cleanup_failed"); }
    throw error;
  }
  // Physical history settles before current job/signal/domain writer decisions.
  try {
    if (native.terminal) await reconcileProductTaglineKoGatewayTerminal(native.terminal);
    else if (native.notStarted) await reconcileGatewayNotStarted(native.notStarted);
    else if (!await markModelDispatchIndeterminate(prepared.dispatch, modelCapacityIndeterminateReason({ signal: options.signal, timedOut: !native.result.ok && native.result.error === "timeout" })))
      throw new Error("product_tagline_ko_dispatch_not_marked");
  } catch (cleanup) {
    if (native.terminal || native.notStarted) await markUnsettledDispatch(prepared.dispatch);
    if (!native.result.ok) throw new AggregateError([native.result, cleanup], "product_tagline_ko_result_cleanup_failed");
    throw cleanup;
  }
  return { kind: "result" as const, result: native.result, expectation: prepared.expectation, ...(adopted ? { batch: tasks } : {}) };
}
