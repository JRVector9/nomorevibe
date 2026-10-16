import { randomUUID } from "node:crypto";
import { TRANSLATE_MODEL, translateTaglinesToKorean } from "@/lib/crawl/translate";
import { prepareProductTaglineKoGatewayCall, translateTaglinesWithReservedGateway } from "@/lib/crawl/agent-review-gateway";
import { readModelCapacityCallerControl, findOwnPendingModelRequest, requestProductTaglineKoModelSlot,
  cancelReservedModelSlot, markModelDispatchIndeterminate, reconcileProductTaglineKoGatewayTerminal } from "@/lib/llm/capacity-repository";
import { modelCapacityRequestIdentitySchema, productTaglineKoInputHash, productTaglineKoLogicalWorkKey } from "@/lib/llm/capacity";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { displayProjectName } from "./display-name";
import { prepareKoreanTaglineDispatch, koreanTaglineSource, type KoreanTaglineTask } from "./korean-taglines";
import type { JobLease } from "@/lib/jobs/control";
import { roleLeaseFromEnv, type RoleLease } from "@/lib/jobs/role-leader";
import type { KoreanTaglineBatch } from "./korean-tagline";
import type { KoreanTaglineWriteExpectation } from "./korean-taglines";

export type KoreanTaglineCapacityResult = { kind: "skipped" } | {
  kind: "result"; result: KoreanTaglineBatch; expectation?: KoreanTaglineWriteExpectation;
};

/** A single demanded batch; neither queue waiting nor HTTP retains a DB TX. */
export async function translateKoreanTaglinesWithModelCapacity(value: readonly KoreanTaglineTask[], homeSlugs: readonly string[], job: JobLease,
  valueOptions: { timeoutMs: number; signal?: AbortSignal; roleLease?: RoleLease }): Promise<KoreanTaglineCapacityResult> {
  const tasks = structuredClone(value), home = structuredClone(homeSlugs), lease = structuredClone(job);
  const options = { timeoutMs: valueOptions.timeoutMs, signal: valueOptions.signal,
    roleLease: valueOptions.roleLease && structuredClone(valueOptions.roleLease) };
  const env = Object.fromEntries(["ROLE_LEASE_ROLE", "ROLE_LEASE_INSTANCE_ID", "ROLE_LEASE_BOOT_ID", "ROLE_LEASE_RELEASE",
    "ROLE_LEASE_EPOCH", "ROLE_LEASE_BATCH_VERSION", "ROLE_LEASE_BATCH_EPOCH", "ROLE_LEASE_HOST"].map(key => [key, process.env[key]]));
  const items = tasks.map(task => ({ name: displayProjectName(task.name, task.repoUrl), tagline: koreanTaglineSource(task) }));
  const legacy = async () => ({ kind: "result" as const,
    result: await translateTaglinesToKorean(items, options.timeoutMs, undefined, options.signal) });
  if (!process.env.ABCLLM_API_KEY?.trim()) return legacy();
  const control = await readModelCapacityCallerControl();
  if (control.mode === "disabled") return legacy();
  if (control.mode !== "open") throw new ModelCapacityDeferredError("draining");
  if (!control.policy?.routes.some(route => route.routeId === "product-tagline-ko" && route.provider === "abcllm" && route.model === TRANSLATE_MODEL))
    throw new ModelCapacityDeferredError("unmapped");
  const call = prepareProductTaglineKoGatewayCall(items, { model: TRANSLATE_MODEL, timeoutMs: options.timeoutMs });
  if (call.kind !== "prepared") throw new ModelCapacityDeferredError(call.reason);
  const roleLease = options.roleLease ?? (env.ROLE_LEASE_ROLE === "text" || env.ROLE_LEASE_ROLE === "translation"
    ? roleLeaseFromEnv(env.ROLE_LEASE_ROLE, env) : undefined);
  if (!roleLease) throw new ModelCapacityDeferredError("owner_unavailable");
  const initial = await prepareKoreanTaglineDispatch(tasks, home, lease, { roleLease, call });
  if (initial.kind === "disabled") return legacy();
  if (initial.kind === "skipped") return initial;
  if (!("members" in initial)) throw new Error("product_tagline_ko_preparation_invalid");
  const { members, role } = initial;
  const identity = modelCapacityRequestIdentitySchema.parse({ owner: { instanceId: role.instanceId, bootId: role.bootId },
    class: "background", pool: "text", routeId: "product-tagline-ko", provider: "abcllm", model: TRANSLATE_MODEL,
    workKey: `${productTaglineKoLogicalWorkKey(members)}:${productTaglineKoInputHash({ members, model: TRANSLATE_MODEL })}` });
  const pending = await findOwnPendingModelRequest(identity);
  if (pending && (pending.state === "dispatched" || pending.state === "indeterminate")) throw new ModelCapacityDeferredError("dispatched");
  const slot = await requestProductTaglineKoModelSlot({ ...identity, requestId: pending?.requestId ?? randomUUID() }, members);
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
      if (!await markModelDispatchIndeterminate(prepared.dispatch, options.signal?.aborted ? "local_abort" : "transport_unknown"))
        throw new Error("product_tagline_ko_dispatch_not_marked");
    } catch (cleanup) { throw new AggregateError([error, cleanup], "product_tagline_ko_transport_cleanup_failed"); }
    throw error;
  }
  // Physical history settles before current job/signal/domain writer decisions.
  try {
    if (native.terminal) await reconcileProductTaglineKoGatewayTerminal(native.terminal);
    else if (!await markModelDispatchIndeterminate(prepared.dispatch, options.signal?.aborted ? "local_abort" : "transport_unknown"))
      throw new Error("product_tagline_ko_dispatch_not_marked");
  } catch (cleanup) {
    if (!native.result.ok) throw new AggregateError([native.result, cleanup], "product_tagline_ko_result_cleanup_failed");
    throw cleanup;
  }
  return { kind: "result" as const, result: native.result, expectation: prepared.expectation };
}
