import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { taglineEvidence, type TaglineResult } from "./tagline";
import { prepareCrawlTaglineGatewayCall, writeTaglineWithReservedGateway, readCrawlTaglineGatewayTerminal } from "./agent-review-gateway";
import { reconcileGatewayNotStarted, reconcileGatewayHttpRejected, readModelCapacityCallerControl, findOwnPendingModelRequest, requestCrawlTaglineModelSlot,
  readCrawlTaglineContinuation, cancelReservedModelSlot, markModelDispatchIndeterminate, reconcileCrawlTaglineGatewayTerminal } from "@/lib/llm/capacity-repository";
import { markUnsettledDispatch } from "@/lib/llm/capacity-unsettled";
import { capacityRefusalReason } from "@/lib/llm/capacity-busy-targets";
import { modelCapacityRequestIdentitySchema, crawlTaglineInputHash, crawlTaglineLogicalWorkKey, type CrawlTaglineParent } from "@/lib/llm/capacity";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { modelCapacityIndeterminateReason } from "@/lib/llm/capacity";
import { prepareCrawlTaglineDispatch, prepareCrawlTaglineHistory, prepareCrawlTaglineNotStarted, type TaglineTask, type CrawlTaglineWriteExpectation } from "./taglines";
import type { JobLease } from "@/lib/jobs/control";
import { roleLeaseFromEnv, type RoleLease } from "@/lib/jobs/role-leader";
import { textRouteCallable } from "@/lib/llm/serving-contract-store";
import { crawlTaglineServingProvider } from "@/lib/llm/crawl-tagline-serving-contract";
import { textTaskModel } from "@/lib/llm/ai-task-rank-scope";
import { assertProviderNotRateLimited } from "@/lib/llm/provider-rate-limit";

export type CrawlTaglineCapacityOutcome = { kind: "result"; result: TaglineResult; askOrdinal: 1 | 2;
  parent: CrawlTaglineParent | null; expectation: CrawlTaglineWriteExpectation };
export type CrawlTaglineCapacityResult = { kind: "skipped"; reason: string } | CrawlTaglineCapacityOutcome;
type Options = { timeoutMs: number; signal?: AbortSignal; roleLease?: RoleLease; previous?: CrawlTaglineCapacityOutcome };

/** 큐와 HTTP 사이에는 열린 TX/connection이 없다. 재질문 조건과 시간 계산은 job이 소유한다. */
export async function writeCrawlTaglineWithModelCapacity(value: TaglineTask, job: JobLease, valueOptions: Options): Promise<CrawlTaglineCapacityResult> {
  const task = structuredClone(value), lease = structuredClone(job), options = { ...valueOptions,
    roleLease: valueOptions.roleLease && structuredClone(valueOptions.roleLease) };
  const previous = options.previous && { ...options.previous, result: structuredClone(options.previous.result), parent: structuredClone(options.previous.parent) }, env = Object.fromEntries(["ROLE_LEASE_ROLE", "ROLE_LEASE_INSTANCE_ID", "ROLE_LEASE_BOOT_ID", "ROLE_LEASE_RELEASE",
    "ROLE_LEASE_EPOCH", "ROLE_LEASE_BATCH_VERSION", "ROLE_LEASE_BATCH_EPOCH", "ROLE_LEASE_HOST"].map(key => [key, process.env[key]]));
  if (previous && (previous.askOrdinal !== 1 || !previous.result.ok || previous.result.tagline))
    throw new Error("invalid_crawl_tagline_second_ask");
  if (previous && !previous.parent) throw new ModelCapacityDeferredError("dispatched");
  const provider = crawlTaglineServingProvider(textTaskModel("crawl-tagline"));
  // 순위(PR B)가 계약을 확인하고 범위를 열었다 — 그 사이 계약이 닫혔으면 이 모델만의 일이라 다음 순위로 넘긴다(옛 게이트웨이 길로 떨어지지 않는다)
  if (!textRouteCallable("crawl-tagline", textTaskModel("crawl-tagline"), provider)) throw new ModelCapacityDeferredError("provider_contract_unavailable");
  // 공급자가 이 경로·모델에 429(빈도 한도)를 준 뒤 쉬는 중이면 장부에 묻지 않고 이 모델만 미룬다(다음 순위가 받는다, provider-rate-limit.ts)
  assertProviderNotRateLimited({ routeId: "crawl-tagline", provider, model: textTaskModel("crawl-tagline") });
  const control = await readModelCapacityCallerControl();
  if (control.mode === "disabled") throw new ModelCapacityDeferredError("disabled");
  if (control.mode !== "open") throw new ModelCapacityDeferredError("draining");
  if (!control.policy?.routes.some(route => route.routeId === "crawl-tagline" && route.provider === provider && route.model === textTaskModel("crawl-tagline")))
    throw new ModelCapacityDeferredError("unmapped");
  const roleLease = options.roleLease ?? (env.ROLE_LEASE_ROLE === "text" ? roleLeaseFromEnv("text", env) : undefined);
  if (!roleLease || roleLease.role !== "text") throw new ModelCapacityDeferredError("owner_unavailable");
  const initial = await prepareCrawlTaglineDispatch(task, lease, { roleLease, previous: previous?.expectation });
  if (initial.kind === "disabled") throw new ModelCapacityDeferredError("disabled");
  if (initial.kind === "skipped") return initial;
  if (!("snapshot" in initial)) throw new Error("crawl_tagline_preparation_invalid");
  const history = await readCrawlTaglineContinuation({ member: initial.member, model: textTaskModel("crawl-tagline") });
  // 이 후보 한 세대의 장부가 사슬로 읽히지 않는다 — 이 후보만 넘기고 잡은 다음 후보로 간다(#754 원칙, 2026-10-31). 호출·시도 기록 없음.
  if (history && "broken" in history) throw new ModelCapacityDeferredError("ledger_mismatch");
  // 보내지 않은 단계(0149)로 끝난 세대: 같은 단계는 다시 보낼 수 없으니 실패 한 번으로 닫고 다음 세대로 넘긴다.
  if (history && "notStarted" in history) {
    if (previous) throw new ModelCapacityDeferredError("reservation_lost");
    return prepareCrawlTaglineNotStarted(task, lease, { initial, history });
  }
  if (history && (!previous || history.second)) return prepareCrawlTaglineHistory(task, lease, { initial, history });
  if (previous && (!history || !isDeepStrictEqual(previous.parent, { requestId: history.first.requestId,
    bindingHash: history.first.bindingHash, responseHash: history.first.responseHash }) || !history.first.outcome.ok || history.first.outcome.tagline))
    throw new ModelCapacityDeferredError("reservation_lost");
  const input = { member: initial.member, model: textTaskModel("crawl-tagline"), askOrdinal: previous ? 2 as const : 1 as const,
    parent: previous?.parent ?? null };
  const evidence = taglineEvidence(task.candidate.repo, task.document);
  const call = prepareCrawlTaglineGatewayCall(evidence, { model: textTaskModel("crawl-tagline"), timeoutMs: options.timeoutMs, provider });
  if (call.kind !== "prepared") throw new ModelCapacityDeferredError(call.reason);
  const identity = modelCapacityRequestIdentitySchema.parse({ owner: { instanceId: initial.role.instanceId, bootId: initial.role.bootId },
    class: "background", pool: "text", routeId: "crawl-tagline", provider: call.provider, model: textTaskModel("crawl-tagline"),
    workKey: `${crawlTaglineLogicalWorkKey(input)}:${crawlTaglineInputHash(input)}` });
  const pending = await findOwnPendingModelRequest(identity);
  if (pending?.state === "dispatched") throw new ModelCapacityDeferredError("dispatched");
  const request = { ...identity, requestId: pending?.requestId ?? randomUUID() };
  const slot = await requestCrawlTaglineModelSlot(request, input);
  // 줄에 서지 못한 capacity(같은 후보·같은 단계 fence — 미확인 단계 행 포함)는 이 후보만의 work_busy — 잡은 다음 후보로 간다(2026-10-30 결정)
  if (slot.kind !== "granted") throw new ModelCapacityDeferredError(await capacityRefusalReason(request, slot.reason));
  let prepared: Awaited<ReturnType<typeof prepareCrawlTaglineDispatch>>;
  try {
    if (options.signal?.aborted) throw new ModelCapacityDeferredError("reservation_lost");
    prepared = await prepareCrawlTaglineDispatch(task, lease, { roleLease, call,
      reserved: { reservation: slot.reservation, identity, input, initial } });
  } catch (error) {
    try { await cancelReservedModelSlot(slot.reservation); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "crawl_tagline_reservation_cleanup_failed"); }
    throw error;
  }
  if (prepared.kind !== "ready" || !("dispatch" in prepared)) {
    await cancelReservedModelSlot(slot.reservation);
    if (prepared.kind === "disabled") throw new ModelCapacityDeferredError("disabled");
    return { kind: "skipped", reason: "source_changed" };
  }
  let native: Awaited<ReturnType<typeof writeTaglineWithReservedGateway>>;
  try { native = await writeTaglineWithReservedGateway(evidence, prepared.dispatch, call, { signal: options.signal, timeoutMs: options.timeoutMs }); }
  catch (error) {
    try { if (!await markModelDispatchIndeterminate(prepared.dispatch, modelCapacityIndeterminateReason({ signal: options.signal, error })))
      throw new Error("crawl_tagline_dispatch_not_marked"); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "crawl_tagline_transport_cleanup_failed"); }
    throw error;
  }
  // 물리 정산은 현재 signal/job/domain 판단보다 먼저 끝낸다.
  try {
    if (native.terminal) await reconcileCrawlTaglineGatewayTerminal(native.terminal);
    else if (native.notStarted) await reconcileGatewayNotStarted(native.notStarted);
    // 0174: 공급자가 처리하지 않고 거절한 완결 응답(429·401·403) — 결과 미확정 대신 확정 실패로 정산해 칸을 바로 비운다
    else if (native.rejected) await reconcileGatewayHttpRejected(native.rejected);
    else if (!await markModelDispatchIndeterminate(prepared.dispatch, modelCapacityIndeterminateReason({ signal: options.signal, timedOut: !native.result.ok && native.result.error === "timeout" })))
      throw new Error("crawl_tagline_dispatch_not_marked");
  } catch (cleanup) {
    if (native.terminal || native.notStarted || native.rejected) await markUnsettledDispatch(prepared.dispatch);
    if (!native.result.ok) throw new AggregateError([native.result, cleanup], "crawl_tagline_result_cleanup_failed");
    throw cleanup;
  }
  const terminal = native.terminal && readCrawlTaglineGatewayTerminal(native.terminal);
  return { kind: "result", result: native.result, askOrdinal: input.askOrdinal, expectation: prepared.expectation,
    parent: terminal ? { requestId: terminal.dispatch.requestId, bindingHash: terminal.dispatch.bindingHash, responseHash: terminal.responseHash } : null };
}
