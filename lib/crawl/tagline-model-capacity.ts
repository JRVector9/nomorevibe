import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { TAGLINE_MODEL, taglineEvidence, type TaglineResult } from "./tagline";
import { prepareCrawlTaglineGatewayCall, writeTaglineWithReservedGateway, readCrawlTaglineGatewayTerminal } from "./agent-review-gateway";
import { readModelCapacityCallerControl, findOwnPendingModelRequest, requestCrawlTaglineModelSlot,
  readCrawlTaglineContinuation, cancelReservedModelSlot, markModelDispatchIndeterminate, reconcileCrawlTaglineGatewayTerminal } from "@/lib/llm/capacity-repository";
import { modelCapacityRequestIdentitySchema, crawlTaglineInputHash, crawlTaglineLogicalWorkKey, type CrawlTaglineParent } from "@/lib/llm/capacity";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { prepareCrawlTaglineDispatch, prepareCrawlTaglineHistory, type TaglineTask, type CrawlTaglineWriteExpectation } from "./taglines";
import type { JobLease } from "@/lib/jobs/control";
import { roleLeaseFromEnv, type RoleLease } from "@/lib/jobs/role-leader";

export type CrawlTaglineCapacityOutcome = { kind: "result"; result: TaglineResult; askOrdinal: 1 | 2;
  parent: CrawlTaglineParent | null; expectation: CrawlTaglineWriteExpectation };
export type CrawlTaglineCapacityResult = { kind: "disabled" } | { kind: "skipped"; reason: string } | CrawlTaglineCapacityOutcome;
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
  if (!process.env.ABCLLM_API_KEY?.trim() && !previous) return { kind: "disabled" };
  const control = await readModelCapacityCallerControl();
  if (control.mode === "disabled" && !previous) return { kind: "disabled" };
  if (control.mode !== "open") throw new ModelCapacityDeferredError(control.mode === "draining" ? "draining" : "disabled");
  if (!control.policy?.routes.some(route => route.routeId === "crawl-tagline" && route.provider === "abcllm" && route.model === TAGLINE_MODEL))
    throw new ModelCapacityDeferredError("unmapped");
  const roleLease = options.roleLease ?? (env.ROLE_LEASE_ROLE === "text" ? roleLeaseFromEnv("text", env) : undefined);
  if (!roleLease || roleLease.role !== "text") throw new ModelCapacityDeferredError("owner_unavailable");
  const initial = await prepareCrawlTaglineDispatch(task, lease, { roleLease, previous: previous?.expectation });
  if (initial.kind === "disabled") {
    if (previous) throw new ModelCapacityDeferredError("disabled");
    return initial;
  }
  if (initial.kind === "skipped") return initial;
  if (!("snapshot" in initial)) throw new Error("crawl_tagline_preparation_invalid");
  const history = await readCrawlTaglineContinuation({ member: initial.member, model: TAGLINE_MODEL });
  if (history && (!previous || history.second)) return prepareCrawlTaglineHistory(task, lease, { initial, history });
  if (previous && (!history || !isDeepStrictEqual(previous.parent, { requestId: history.first.requestId,
    bindingHash: history.first.bindingHash, responseHash: history.first.responseHash }) || !history.first.outcome.ok || history.first.outcome.tagline))
    throw new ModelCapacityDeferredError("reservation_lost");
  const input = { member: initial.member, model: TAGLINE_MODEL, askOrdinal: previous ? 2 as const : 1 as const,
    parent: previous?.parent ?? null };
  const evidence = taglineEvidence(task.candidate.repo, task.document);
  const call = prepareCrawlTaglineGatewayCall(evidence, { model: TAGLINE_MODEL, timeoutMs: options.timeoutMs });
  if (call.kind !== "prepared") throw new ModelCapacityDeferredError(call.reason);
  const identity = modelCapacityRequestIdentitySchema.parse({ owner: { instanceId: initial.role.instanceId, bootId: initial.role.bootId },
    class: "background", pool: "text", routeId: "crawl-tagline", provider: "abcllm", model: TAGLINE_MODEL,
    workKey: `${crawlTaglineLogicalWorkKey(input)}:${crawlTaglineInputHash(input)}` });
  const pending = await findOwnPendingModelRequest(identity);
  if (pending && (pending.state === "dispatched" || pending.state === "indeterminate")) throw new ModelCapacityDeferredError("dispatched");
  const slot = await requestCrawlTaglineModelSlot({ ...identity, requestId: pending?.requestId ?? randomUUID() }, input);
  if (slot.kind !== "granted") throw new ModelCapacityDeferredError(slot.reason);
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
    try { if (!await markModelDispatchIndeterminate(prepared.dispatch, options.signal?.aborted ? "local_abort" : "transport_unknown"))
      throw new Error("crawl_tagline_dispatch_not_marked"); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "crawl_tagline_transport_cleanup_failed"); }
    throw error;
  }
  // 물리 정산은 현재 signal/job/domain 판단보다 먼저 끝낸다.
  try {
    if (native.terminal) await reconcileCrawlTaglineGatewayTerminal(native.terminal);
    else if (!await markModelDispatchIndeterminate(prepared.dispatch, options.signal?.aborted ? "local_abort" : "transport_unknown"))
      throw new Error("crawl_tagline_dispatch_not_marked");
  } catch (cleanup) {
    if (!native.result.ok) throw new AggregateError([native.result, cleanup], "crawl_tagline_result_cleanup_failed");
    throw cleanup;
  }
  const terminal = native.terminal && readCrawlTaglineGatewayTerminal(native.terminal);
  return { kind: "result", result: native.result, askOrdinal: input.askOrdinal, expectation: prepared.expectation,
    parent: terminal ? { requestId: terminal.dispatch.requestId, bindingHash: terminal.dispatch.bindingHash, responseHash: terminal.responseHash } : null };
}
