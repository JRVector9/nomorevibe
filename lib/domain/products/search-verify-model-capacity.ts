import { randomUUID } from "node:crypto";
import { prepareSearchVerifyGatewayCall, verifyKeywordsWithReservedGateway, readSearchVerifyGatewayTerminal } from "@/lib/crawl/agent-review-gateway";
import { reconcileGatewayNotStarted, reconcileGatewayHttpRejected, readModelCapacityCallerControl, findOwnPendingModelRequest, requestSearchVerifyModelSlot, cancelReservedModelSlot,
  markModelDispatchIndeterminate, reconcileSearchVerifyGatewayTerminal, readSearchVerifyContinuation } from "@/lib/llm/capacity-repository";
import { markUnsettledDispatch } from "@/lib/llm/capacity-unsettled";
import { modelCapacityRequestIdentitySchema, firstSearchVerifyStep, nextSearchVerifyStep, searchVerifyStepKeywords,
  searchVerifyLogicalWorkKey, searchVerifyInputHash, type SearchVerifyInput, type SearchVerifyParent, type SearchVerifyStep } from "@/lib/llm/capacity";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { modelCapacityIndeterminateReason } from "@/lib/llm/capacity";
import { roleLeaseFromEnv, type RoleLease } from "@/lib/jobs/role-leader";
import type { JobLease } from "@/lib/jobs/control";
import { profileEvidence } from "./search-profile";
import { prepareSearchVerifyModelDispatch, sealSearchVerifyWriteExpectation, type ProfileTask, type SearchVerifyWriteExpectation } from "./search-profiles";
import type { VerifyResult } from "./search-verify";
import { textRouteCallable } from "@/lib/llm/serving-contract-store";
import { searchVerifyServingProvider } from "@/lib/llm/search-verify-serving-contract";
import { textTaskModel } from "@/lib/llm/ai-task-rank-scope";
import { assertProviderNotRateLimited } from "@/lib/llm/provider-rate-limit";

/**
 * "expired": the original shared deadline ended while the next permit was unavailable, or a resumed execution ran out.
 * No attempt, failure or timeout is counted. The job only rests the product (restExpiredVerification), and a later tick
 * starts a new execution from its first step.
 */
export type SearchVerifyCapacityResult = { kind: "skipped" } | { kind: "expired" }
  | { kind: "result"; result: VerifyResult; expectation?: SearchVerifyWriteExpectation };

/** Fixed verifier coordinator. One permit allows exactly one physical POST; neither slot waiting nor HTTP holds a DB TX.
 * Steps follow verifyKeywordsInChunks exactly and continue only inside the original shared deadline.
 * minStepMs (the job's minCallMs) is the least shared-deadline time a continuing chunk step needs before it asks for a permit.
 * A shorter rest ends as the deadline did, without a POST. Prod 11-10: steps sent with 2–8s left against ~9s calls always
 * timed out, and each one left an indeterminate ledger row. */
export async function verifyKeywordsWithModelCapacity(task: ProfileTask, lease: JobLease, valueOptions: {
  timeoutMs: number; chunked: boolean; signal?: AbortSignal; request?: typeof fetch; roleLease?: RoleLease; minStepMs?: number;
}): Promise<SearchVerifyCapacityResult> {
  const snapshot = structuredClone(task), job = structuredClone(lease);
  const options = { timeoutMs: valueOptions.timeoutMs, chunked: valueOptions.chunked, signal: valueOptions.signal, request: valueOptions.request,
    roleLease: valueOptions.roleLease && structuredClone(valueOptions.roleLease), minStepMs: Math.max(0, valueOptions.minStepMs ?? 0) };
  const item = { evidence: profileEvidence(snapshot.product, snapshot.reviewerNote),
    keywords: [...snapshot.profile!.keywordsEn, ...snapshot.profile!.keywordsKo] };
  const provider = searchVerifyServingProvider(textTaskModel("product-search-verify"));
  // 순위(PR B)가 계약을 확인하고 범위를 열었다 — 그 사이 계약이 닫혔으면 이 모델만의 일이라 다음 순위로 넘긴다(옛 게이트웨이 길로 떨어지지 않는다)
  if (!textRouteCallable("product-search-verify", textTaskModel("product-search-verify"), provider)) throw new ModelCapacityDeferredError("provider_contract_unavailable");
  // 공급자가 이 경로·모델에 429(빈도 한도)를 준 뒤 쉬는 중이면 장부에 묻지 않고 이 모델만 미룬다(다음 순위가 받는다, provider-rate-limit.ts)
  assertProviderNotRateLimited({ routeId: "product-search-verify", provider, model: textTaskModel("product-search-verify") });
  const control = await readModelCapacityCallerControl();
  if (control.mode === "disabled") throw new ModelCapacityDeferredError("disabled");
  if (control.mode !== "open") throw new ModelCapacityDeferredError("draining");
  if (!control.policy?.routes.some(route => route.routeId === "product-search-verify" && route.provider === provider && route.model === textTaskModel("product-search-verify")))
    throw new ModelCapacityDeferredError("unmapped");
  const roleLease = options.roleLease ?? roleLeaseFromEnv("text", process.env);
  if (!roleLease) throw new ModelCapacityDeferredError("owner_unavailable");
  const startedAt = Date.now(), mode = options.chunked ? "chunk" as const : "full" as const, full = mode === "full";
  const keywords = mode === "chunk" ? [...new Set(item.keywords)] : item.keywords;
  const initial = await prepareSearchVerifyModelDispatch(snapshot, job, { roleLease, keywords: item.keywords, mode });
  if (initial.kind === "disabled") throw new ModelCapacityDeferredError("disabled");
  if (initial.kind !== "ready" || !("member" in initial)) return { kind: "skipped" };
  const { member, role, expectation } = initial, model = textTaskModel("product-search-verify");
  const continuation = await readSearchVerifyContinuation({ member, model });
  if (continuation.unresolved) throw new ModelCapacityDeferredError("dispatched");
  // A row of this generation has no readable execution: only this product is skipped, the job goes on (no call, attempt or failure).
  if (continuation.broken) throw new ModelCapacityDeferredError("ledger_mismatch");
  // Deadlines bound new HTTP admission. A fully settled successful chain needs no more HTTP:
  // recover it through the current generation's fenced writer even after its admission deadline.
  // Incomplete executions still resume only inside their stored deadline, never a new 60 seconds.
  const latest = continuation.latest && (continuation.latest.next === "done" || continuation.latest.deadlineAt > continuation.nowMs)
    ? continuation.latest : null;
  const resumed = !!latest, execution = latest ? latest.execution : continuation.nextExecution;
  sealSearchVerifyWriteExpectation(expectation, execution);
  const deadline = startedAt + Math.max(1, latest ? Math.min(options.timeoutMs, latest.deadlineAt - continuation.nowMs) : options.timeoutMs);
  let step: SearchVerifyStep | "done" | "stop" = latest ? latest.next : firstSearchVerifyStep(mode);
  let parent: SearchVerifyParent | null = latest ? latest.parent : null;
  const removed = latest ? latest.outcomes.flatMap(({ outcome }) => outcome.ok ? outcome.removed : []) : [];
  const owner = { instanceId: role.instanceId, bootId: role.bootId };
  const finish = (result: VerifyResult): SearchVerifyCapacityResult => resumed && !result.ok && result.error === "timeout"
    ? { kind: "expired" } : { kind: "result", result, expectation };
  // Chunk mode keeps the legacy shared-deadline checks around every step; full mode keeps the legacy single-call timeout.
  const stopped = (at = Date.now()): VerifyResult | null => options.signal?.aborted ? { ok: false, error: "cancelled" }
    : !full && at >= deadline ? { ok: false, error: "timeout" } : null;
  for (;;) {
    if (step === "done") return { kind: "result", result: { ok: true, unsupported: [...removed] }, expectation };
    if (step === "stop") return { kind: "result", result: { ok: false, error: "invalid_output" }, expectation };
    const before = stopped(); if (before) return finish(before);
    // A continuing step (it has a parent) is not sent into a remainder shorter than one call; its timeout would only leave an indeterminate row.
    if (!full && parent && deadline - Date.now() < options.minStepMs) return finish({ ok: false, error: "timeout" });
    const sent = searchVerifyStepKeywords(keywords, step), timeoutMs = Math.max(1, full ? options.timeoutMs : deadline - Date.now());
    const call = prepareSearchVerifyGatewayCall({ evidence: item.evidence, keywords: sent }, { model, timeoutMs, provider });
    if (call.kind !== "prepared") throw new ModelCapacityDeferredError(call.reason);
    const input: SearchVerifyInput = { member, model, execution, step, parent };
    const identity = modelCapacityRequestIdentitySchema.parse({ owner, class: "background", pool: "text", routeId: "product-search-verify",
      provider: call.provider, model, workKey: `${searchVerifyLogicalWorkKey(input)}:${searchVerifyInputHash(input)}` });
    const pending = await findOwnPendingModelRequest(identity);
    if (pending?.state === "dispatched") throw new ModelCapacityDeferredError("dispatched");
    // A deferred permit keeps every settled prefix in the ledger; the next tick resumes only before the stored deadline.
    const slot = await requestSearchVerifyModelSlot({ ...identity, requestId: pending?.requestId ?? randomUUID() }, input);
    if (slot.kind !== "granted") throw new ModelCapacityDeferredError(slot.reason);
    let prepared: Awaited<ReturnType<typeof prepareSearchVerifyModelDispatch>>;
    try {
      if (options.signal?.aborted) throw new ModelCapacityDeferredError("reservation_lost");
      prepared = await prepareSearchVerifyModelDispatch(snapshot, job, { roleLease, keywords: item.keywords, mode, call,
        reserved: { reservation: slot.reservation, identity, input, role, remainingMs: full ? timeoutMs : deadline - Date.now() } });
    } catch (error) {
      // Cancel is a reserved-only CAS. A dispatch with an unknown commit outcome is never refunded.
      try { await cancelReservedModelSlot(slot.reservation); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "search_verify_reservation_cleanup_failed"); }
      throw error;
    }
    if (prepared.kind !== "ready" || !("dispatch" in prepared)) {
      await cancelReservedModelSlot(slot.reservation);
      if (prepared.kind === "disabled") throw new ModelCapacityDeferredError("disabled");
      return prepared.kind === "expired" ? { kind: "expired" } : { kind: "skipped" };
    }
    const dispatch = prepared.dispatch;
    let native: Awaited<ReturnType<typeof verifyKeywordsWithReservedGateway>>;
    try { native = await verifyKeywordsWithReservedGateway({ evidence: item.evidence, keywords: sent }, dispatch, call,
      { signal: options.signal, timeoutMs }); }
    catch (error) {
      try {
        if (!await markModelDispatchIndeterminate(dispatch, modelCapacityIndeterminateReason({ signal: options.signal, error })))
          throw new Error("search_verify_dispatch_not_marked");
      } catch (cleanup) { throw new AggregateError([error, cleanup], "search_verify_transport_cleanup_failed"); }
      throw error;
    }
    const returnedAt = Date.now();
    // Physical history settles before any deadline, signal or domain decision.
    try {
      if (native.terminal) await reconcileSearchVerifyGatewayTerminal(native.terminal);
      else if (native.notStarted) await reconcileGatewayNotStarted(native.notStarted);
      // 0174: 공급자가 처리하지 않고 거절한 완결 응답(429·401·403) — 결과 미확정 대신 확정 실패로 정산해 칸을 바로 비운다
      else if (native.rejected) await reconcileGatewayHttpRejected(native.rejected);
      else if (!await markModelDispatchIndeterminate(dispatch, modelCapacityIndeterminateReason({ signal: options.signal, timedOut: !native.result.ok && native.result.error === "timeout" })))
        throw new Error("search_verify_dispatch_not_marked");
    } catch (cleanup) {
      if (native.terminal || native.notStarted || native.rejected) await markUnsettledDispatch(dispatch);
      if (!native.result.ok) throw new AggregateError([native.result, cleanup], "search_verify_result_cleanup_failed");
      throw cleanup;
    }
    const after = stopped(returnedAt); if (after) return finish(after);
    const proof = native.terminal ? readSearchVerifyGatewayTerminal(native.terminal) : null;
    if (!proof) return finish(native.result.ok ? { ok: false, error: "invalid_output" } : native.result);
    parent = { requestId: dispatch.requestId, bindingHash: dispatch.bindingHash, responseHash: proof.responseHash };
    if (proof.outcome.ok) removed.push(...proof.outcome.removed);
    step = nextSearchVerifyStep(member, step, proof.outcome);
  }
}
