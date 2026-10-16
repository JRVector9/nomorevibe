import { randomUUID } from "node:crypto";
import { TRANSLATE_MODEL } from "@/lib/crawl/translate";
import { prepareWebsearchQueryGatewayCall, translateQueryWithReservedGateway } from "@/lib/crawl/agent-review-gateway";
import { readModelCapacityCallerControl, findOwnPendingModelRequest, requestWebsearchQueryModelSlot, cancelReservedModelSlot,
  markModelDispatchIndeterminate, reconcileWebsearchQueryGatewayTerminal } from "@/lib/llm/capacity-repository";
import { modelCapacityRequestIdentitySchema, websearchQueryInputHash, websearchQueryLogicalWorkKey } from "@/lib/llm/capacity";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { websearchProcessOwner } from "@/lib/llm/websearch-process-owner";
import { prepareWebsearchQueryDispatch, recordWebsearchQueryResult, type WebsearchQueryResult,
  type WebsearchQueryTarget } from "./search-query-capacity-repository";

/**
 * 공개 검색어 번역을 공통 모델 슬롯에 묶는다.
 *
 * - 장부가 꺼져 있으면(disabled) 아무것도 하지 않고 legacy 를 돌려준다 — 부르는 쪽이 원래 길을 그대로 탄다.
 * - 슬롯을 바로 못 얻으면 기다리지 않고 미룬다(ModelCapacityDeferredError) — 원문·정해 둔 영어로 찾고 pending 이 된다.
 * - 같은 프로세스의 같은 캐시 열쇠는 한 번만 부른다(singleflight). 합류한 쪽은 먼저 온 쪽의 남은 시간만 함께 쓴다.
 *   다른 프로세스는 장부의 고정 대상 열쇠가 막는다.
 */
export type WebsearchQueryCapacityResult = { kind: "legacy" } | { kind: "cached"; text: string } | { kind: "result"; result: WebsearchQueryResult };
const globalFlights = globalThis as typeof globalThis & { noMoreVibeWebsearchQueryFlights?: Map<string, Promise<WebsearchQueryCapacityResult>> };
const flights = globalFlights.noMoreVibeWebsearchQueryFlights ??= new Map();

export async function translateQueryWithModelCapacity(value: WebsearchQueryTarget, timeoutMs: number): Promise<WebsearchQueryCapacityResult> {
  const target = structuredClone(value);
  if (!process.env.ABCLLM_API_KEY?.trim()) return { kind: "legacy" };
  const running = flights.get(target.cacheKey);
  if (running) return running;
  const control = await readModelCapacityCallerControl();
  if (control.mode === "disabled") return { kind: "legacy" };
  if (control.mode !== "open") throw new ModelCapacityDeferredError("draining");
  if (!control.policy?.routes.some(route => route.routeId === "search-query-translate" && route.provider === "abcllm" && route.model === TRANSLATE_MODEL))
    throw new ModelCapacityDeferredError("unmapped");
  const joined = flights.get(target.cacheKey);
  if (joined) return joined;
  const flight = translateOnce(target, timeoutMs);
  flights.set(target.cacheKey, flight);
  try { return await flight; } finally { if (flights.get(target.cacheKey) === flight) flights.delete(target.cacheKey); }
}

async function translateOnce(target: WebsearchQueryTarget, timeoutMs: number): Promise<WebsearchQueryCapacityResult> {
  const owner = websearchProcessOwner();
  if (!owner) throw new ModelCapacityDeferredError("owner_unavailable");
  const input = { sourceLocale: target.sourceLocale, query: target.query };
  const call = prepareWebsearchQueryGatewayCall(input, { model: TRANSLATE_MODEL, timeoutMs });
  if (call.kind !== "prepared") throw new ModelCapacityDeferredError(call.reason);
  const initial = await prepareWebsearchQueryDispatch(target, { owner, call });
  if (initial.kind === "disabled") return { kind: "legacy" };
  if (initial.kind === "cached") return initial;
  if (initial.kind === "continued") return initial.cached !== null ? { kind: "cached", text: initial.cached } : { kind: "result", result: initial.result };
  if (initial.kind === "skipped" || !("input" in initial)) throw new Error("websearch_query_preparation_invalid");
  const identity = modelCapacityRequestIdentitySchema.parse({ owner: { instanceId: owner.instanceId, bootId: owner.bootId },
    class: "background", pool: "text", routeId: "search-query-translate", provider: "abcllm", model: TRANSLATE_MODEL,
    workKey: `${websearchQueryLogicalWorkKey(initial.input.member)}:${websearchQueryInputHash(initial.input)}` });
  const pending = await findOwnPendingModelRequest(identity);
  if (pending && (pending.state === "dispatched" || pending.state === "indeterminate")) throw new ModelCapacityDeferredError("dispatched");
  // 한 번만 묻는다 — 슬롯이 없으면 짧게 기다리며 다시 묻지 않고 바로 미룬다
  const slot = await requestWebsearchQueryModelSlot({ ...identity, requestId: pending?.requestId ?? randomUUID() }, initial.input);
  if (slot.kind !== "granted") throw new ModelCapacityDeferredError(slot.reason);
  let prepared: Awaited<ReturnType<typeof prepareWebsearchQueryDispatch>>;
  try {
    prepared = await prepareWebsearchQueryDispatch(target, { owner, call, reserved: { reservation: slot.reservation, identity, input: initial.input } });
  } catch (error) {
    try { await cancelReservedModelSlot(slot.reservation); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "websearch_query_reservation_cleanup_failed"); }
    throw error;
  }
  if (prepared.kind !== "ready" || !("dispatch" in prepared)) {
    await cancelReservedModelSlot(slot.reservation);
    if (prepared.kind === "cached") return prepared;
    if (prepared.kind === "continued") return prepared.cached !== null ? { kind: "cached", text: prepared.cached } : { kind: "result", result: prepared.result };
    throw new ModelCapacityDeferredError(prepared.kind === "disabled" ? "disabled" : "reservation_lost");
  }
  let native: Awaited<ReturnType<typeof translateQueryWithReservedGateway>>;
  try { native = await translateQueryWithReservedGateway(input, prepared.dispatch, call, { timeoutMs }); }
  catch (error) {
    try {
      if (!await markModelDispatchIndeterminate(prepared.dispatch, "transport_unknown")) throw new Error("websearch_query_dispatch_not_marked");
    } catch (cleanup) { throw new AggregateError([error, cleanup], "websearch_query_transport_cleanup_failed"); }
    throw error;
  }
  // 물리 호출의 끝(정산 또는 full C)을 먼저 남기고, 그 뒤에 캐시를 쓴다 — 캐시 쓰기 실패가 정산을 되돌리지 않는다
  try {
    if (native.terminal) await reconcileWebsearchQueryGatewayTerminal(native.terminal);
    else if (!await markModelDispatchIndeterminate(prepared.dispatch, "transport_unknown")) throw new Error("websearch_query_dispatch_not_marked");
  } catch (cleanup) {
    if (!native.result.ok) throw new AggregateError([native.result, cleanup], "websearch_query_result_cleanup_failed");
    throw cleanup;
  }
  const stored = await recordWebsearchQueryResult(prepared.expectation, native.result);
  return stored.kind === "lost" && stored.cached !== null ? { kind: "cached", text: stored.cached } : { kind: "result", result: native.result };
}
