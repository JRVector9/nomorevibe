import { randomUUID } from "node:crypto";
import { PRODUCT_TRANSLATION_MODEL, translateProductFields } from "@/lib/crawl/translate";
import { prepareProductTranslationGatewayCall, translateProductFieldsWithReservedGateway } from "@/lib/crawl/agent-review-gateway";
import { readModelCapacityCallerControl, findOwnPendingModelRequest, requestProductTranslationModelSlot,
  cancelReservedModelSlot, markModelDispatchIndeterminate, reconcileProductTranslationGatewayTerminal } from "@/lib/llm/capacity-repository";
import { markUnsettledDispatch } from "@/lib/llm/capacity-unsettled";
import { modelCapacityRequestIdentitySchema, productTranslationInputHash, productTranslationLogicalWorkKey } from "@/lib/llm/capacity";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { translationSourceText } from "./translation-policy";
import { prepareProductTranslationDispatch, type ProductTranslationTask } from "./translations";
import type { JobLease } from "@/lib/jobs/control";
import { roleLeaseFromEnv, type RoleLease } from "@/lib/jobs/role-leader";
import type { KoreanTaglineBatch } from "./korean-tagline";
import type { ProductTranslationWriteExpectation } from "./translations";

export type ProductTranslationCapacityResult = { kind: "skipped" } | {
  kind: "result"; result: KoreanTaglineBatch; expectation?: ProductTranslationWriteExpectation;
};

/** A single demanded batch; neither queue waiting nor HTTP retains a DB TX. */
export async function translateProductFieldsWithModelCapacity(value: readonly ProductTranslationTask[], job: JobLease,
  valueOptions: { timeoutMs: number; signal?: AbortSignal; roleLease?: RoleLease }): Promise<ProductTranslationCapacityResult> {
  const tasks = structuredClone(value), lease = structuredClone(job);
  const options = { timeoutMs: valueOptions.timeoutMs, signal: valueOptions.signal,
    roleLease: valueOptions.roleLease && structuredClone(valueOptions.roleLease) };
  const env = Object.fromEntries(["ROLE_LEASE_ROLE", "ROLE_LEASE_INSTANCE_ID", "ROLE_LEASE_BOOT_ID", "ROLE_LEASE_RELEASE",
    "ROLE_LEASE_EPOCH", "ROLE_LEASE_BATCH_VERSION", "ROLE_LEASE_BATCH_EPOCH", "ROLE_LEASE_HOST"].map(key => [key, process.env[key]]));
  const items = tasks.map(task => ({ name: task.source.name, locale: task.locale, field: task.field,
    text: translationSourceText(task.source, task.field) }));
  const legacy = async () => ({ kind: "result" as const,
    result: await translateProductFields(items, options.timeoutMs, undefined, options.signal, PRODUCT_TRANSLATION_MODEL) });
  if (!process.env.ABCLLM_API_KEY?.trim()) return legacy();
  const control = await readModelCapacityCallerControl();
  if (control.mode === "disabled") return legacy();
  if (control.mode !== "open") throw new ModelCapacityDeferredError("draining");
  if (!control.policy?.routes.some(route => route.routeId === "product-translate" && route.provider === "abcllm" && route.model === PRODUCT_TRANSLATION_MODEL))
    throw new ModelCapacityDeferredError("unmapped");
  const call = prepareProductTranslationGatewayCall(items, { model: PRODUCT_TRANSLATION_MODEL, timeoutMs: options.timeoutMs });
  if (call.kind !== "prepared") throw new ModelCapacityDeferredError(call.reason);
  const roleLease = options.roleLease ?? (env.ROLE_LEASE_ROLE === "text" || env.ROLE_LEASE_ROLE === "translation"
    ? roleLeaseFromEnv(env.ROLE_LEASE_ROLE, env) : undefined);
  if (!roleLease) throw new ModelCapacityDeferredError("owner_unavailable");
  const initial = await prepareProductTranslationDispatch(tasks, lease, { roleLease, call });
  if (initial.kind === "disabled") return legacy();
  if (initial.kind === "skipped") return initial;
  if (!("members" in initial)) throw new Error("product_translation_preparation_invalid");
  const { members, role } = initial;
  const identity = modelCapacityRequestIdentitySchema.parse({ owner: { instanceId: role.instanceId, bootId: role.bootId },
    class: "background", pool: "text", routeId: "product-translate", provider: "abcllm", model: PRODUCT_TRANSLATION_MODEL,
    workKey: `${productTranslationLogicalWorkKey(members)}:${productTranslationInputHash({ members, model: PRODUCT_TRANSLATION_MODEL })}` });
  const pending = await findOwnPendingModelRequest(identity);
  if (pending && (pending.state === "dispatched" || pending.state === "indeterminate")) throw new ModelCapacityDeferredError("dispatched");
  const slot = await requestProductTranslationModelSlot({ ...identity, requestId: pending?.requestId ?? randomUUID() }, members);
  if (slot.kind !== "granted") throw new ModelCapacityDeferredError(slot.reason);
  let prepared: Awaited<ReturnType<typeof prepareProductTranslationDispatch>>;
  try {
    if (options.signal?.aborted) throw new ModelCapacityDeferredError("reservation_lost");
    prepared = await prepareProductTranslationDispatch(tasks, lease, { roleLease, call,
      reserved: { reservation: slot.reservation, identity, members, role } });
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
      if (!await markModelDispatchIndeterminate(prepared.dispatch, options.signal?.aborted ? "local_abort" : "transport_unknown"))
        throw new Error("product_translation_dispatch_not_marked");
    } catch (cleanup) { throw new AggregateError([error, cleanup], "product_translation_transport_cleanup_failed"); }
    throw error;
  }
  // Physical history settles before current job/signal/domain writer decisions.
  try {
    if (native.terminal) await reconcileProductTranslationGatewayTerminal(native.terminal);
    else if (!await markModelDispatchIndeterminate(prepared.dispatch, options.signal?.aborted ? "local_abort" : "transport_unknown"))
      throw new Error("product_translation_dispatch_not_marked");
  } catch (cleanup) {
    if (native.terminal) await markUnsettledDispatch(prepared.dispatch);
    if (!native.result.ok) throw new AggregateError([native.result, cleanup], "product_translation_result_cleanup_failed");
    throw cleanup;
  }
  return { kind: "result" as const, result: native.result, expectation: prepared.expectation };
}
