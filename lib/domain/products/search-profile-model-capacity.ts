import { randomUUID } from "node:crypto";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { findOwnPendingModelRequest, requestTextProfileModelSlot, cancelReservedModelSlot,
  reconcileTextProfileGatewayTerminal, markModelDispatchIndeterminate } from "@/lib/llm/capacity-repository";
import { markUnsettledDispatch } from "@/lib/llm/capacity-unsettled";
import { writeKeywordsWithReservedGateway } from "@/lib/crawl/agent-review-gateway";
import { textProfileInputHash, type ModelCapacityRequestIdentity } from "@/lib/llm/capacity";
import { prepareProfileModelDispatch, type ProfileTask, type ProfileWriteExpectation } from "./search-profiles";
import { profileEvidence, writeKeywords, type KeywordResult } from "./search-profile";
import type { JobLease } from "@/lib/jobs/control";
import type { RoleLease } from "@/lib/jobs/role-leader";

export type ProfileCapacityResult = { kind: "skipped" } | { kind: "result"; result: KeywordResult; expectedProfile?: ProfileWriteExpectation };
/** Fixed route coordinator. No callback, JSON shape or timeout is dispatch authority. */
export async function writeKeywordsWithModelCapacity(task: ProfileTask, lease: JobLease,
  options: { timeoutMs: number; signal?: AbortSignal; roleLease?: RoleLease }): Promise<ProfileCapacityResult> {
  const snapshot = structuredClone(task), ownedLease = structuredClone(lease), captured = { ...options,
    roleLease: options.roleLease && structuredClone(options.roleLease) };
  if (!process.env.ABCLLM_API_KEY?.trim()) return { kind: "result", result: { ok: false, error: "no_key" } };
  const prepared = await prepareProfileModelDispatch(snapshot, ownedLease, captured);
  if (prepared.kind === "disabled") return { kind: "result", result: await writeKeywords(profileEvidence(snapshot.product, snapshot.reviewerNote), options) };
  if (prepared.kind === "skipped") return prepared;
  const role = captured.roleLease;
  if (!role || role.role !== "text") throw new ModelCapacityDeferredError("owner_unavailable");
  const input = prepared.intent.input;
  const identity: ModelCapacityRequestIdentity = { owner: { instanceId: role.instanceId, bootId: role.bootId },
    workKey: `text:profile:${input.productId}:${textProfileInputHash(input)}`, class: "background", pool: "text",
    routeId: "product-search-profile", provider: "abcllm", model: input.model };
  const pending = await findOwnPendingModelRequest(identity);
  const slot = await requestTextProfileModelSlot({ ...identity, requestId: pending?.requestId ?? randomUUID() }, input.productId);
  if (slot.kind !== "granted") throw new ModelCapacityDeferredError(slot.reason);
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
      if (!await markModelDispatchIndeterminate(dispatch, captured.signal?.aborted ? "local_abort" : "transport_unknown"))
        throw new Error("text_profile_dispatch_not_marked");
    } catch (cleanup) { throw new AggregateError([error, cleanup], "profile transport and unknown recording failed"); }
    throw error;
  }
  try {
    if (native.terminal) await reconcileTextProfileGatewayTerminal(native.terminal);
    else if (!await markModelDispatchIndeterminate(dispatch, captured.signal?.aborted ? "local_abort" : "transport_unknown"))
      throw new Error("text_profile_dispatch_not_marked");
  } catch (error) {
    if (native.terminal) await markUnsettledDispatch(dispatch);
    if (!native.result.ok) throw new AggregateError([native.result, error], "profile result and terminal recording failed");
    throw error;
  }
  return { kind: "result", result: native.result, expectedProfile: current.intent.input.profile };
}
