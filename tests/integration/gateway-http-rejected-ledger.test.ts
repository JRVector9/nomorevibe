import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { modelCapacityPolicyHash, productTranslationInputHash, productTranslationLogicalWorkKey, type ModelCapacityPolicy, type ModelCapacityRequest,
  type ModelCapacityReservation, type ModelSlotResult, type ProductTranslationDispatchBinding, type ProductTranslationMember,
  type ProductTranslationModelDispatch } from "@/lib/llm/capacity";
import { finishProductTranslationModelCapacityDispatch, lockProductTranslationModelCapacityDispatch, markModelDispatchIndeterminate,
  reconcileGatewayHttpRejected, requestLocalModelSlot, requestProductTranslationModelSlot } from "@/lib/llm/capacity-repository";
import { gatewayHttpRejectedWitness, issueGatewayHttpRejected, readGatewayHttpRejected } from "@/lib/llm/gateway-http-rejected";
import { localModelBindingHash, localModelJob, localModelLogicalKey, localModelRoute, type LocalModelBinding,
  type LocalModelTarget } from "@/lib/llm/local-model-capacity-contract";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

vi.mock("server-only", () => ({}));

/**
 * 0174(2026-11-11) 실제 PostgreSQL: 공급자가 처리하지 않고 거절한 text 경로 응답(429·401·403)의 확정 정산 gateway_http_rejected.
 * (1) dispatched 행이 증인 하나로 settled 가 되고 장비 칸(한도 1)이 바로 빈다 — 같은 응답을 결과 미확정으로 두면 유지 시간(600초) 동안 칸을 쥔다.
 * (2) 운영 화면(관리자 모델 관측)은 이 정산을 실패로 센다(성공·미분류가 아니다). (3) indeterminate 행·다른 증거는 받지 않고 같은 증거는 멱등이다.
 * (4) guard(0160 rules + 0174 가지)는 모양이 어긋난 근거·행 자신의 handle 이 아닌 근거·text 경로 밖 binding·indeterminate 에서 온 event 를 23514 로 거절한다.
 * 장부 driver 다 — 게이트웨이 응답을 받는 쪽은 tests/*-gateway-native.test.ts 와 *-capacity-dispatch 통합 시험이 본다. 이 파일은 자기 owner 의 행·event 만 지우고
 * control 행은 원래 값으로 되돌린다.
 */
const tag = randomUUID().slice(0, 8), prefix = `http-rejected-${tag}`, owner = { instanceId: prefix, bootId: randomUUID() };
const device = `rejected-${tag}`, model = "Exact Model", localModel = "fixture-local";
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: prefix } });
let originalControl: Record<string, unknown>, serial = Number.parseInt(randomUUID().slice(0, 7), 16);
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { account: 4, "fixture-direct": 4 },
  groupLimits: { [device]: 1, "same-hardware": 4 }, poolLimits: { reviewer: 4, text: 4 }, weights: { first: 1, second: 1, background: 1 },
  maxWaiting: 12, queueTtlMs: 60_000, reservationTtlMs: 60_000, routes: [
    { routeId: "product-translate", provider: "abcllm", model, providerBudgetId: "account", groupId: device },
    { routeId: "local-audit", provider: "local-direct", model: localModel, providerBudgetId: "fixture-direct", groupId: "same-hardware" }] };

function granted(result: ModelSlotResult): ModelCapacityReservation {
  expect(result.kind).toBe("granted"); if (result.kind !== "granted") throw new Error("actual_reservation_required");
  return result.reservation;
}
function identity(value: ModelCapacityRequest) { const result = { ...value }; Reflect.deleteProperty(result, "requestId"); return result; }
function members(): ProductTranslationMember[] {
  return [++serial, ++serial].map(productId => ({ productId, slug: `${prefix}-${productId}`, locale: "en", field: "tagline", sourceHash: "a".repeat(64),
    demand: { rowIdentityHash: "b".repeat(64), attempts: 0 } }));
}
function translationRequest(batch: ProductTranslationMember[]): ModelCapacityRequest {
  return { requestId: randomUUID(), owner: { ...owner }, class: "background", pool: "text", routeId: "product-translate", provider: "abcllm", model,
    workKey: `${productTranslationLogicalWorkKey(batch)}:${productTranslationInputHash({ members: batch, model })}` };
}
function translationBinding(value: ModelCapacityRequest, batch: readonly ProductTranslationMember[]): ProductTranslationDispatchBinding {
  return { kind: "product_translation_gateway", version: 1, members: structuredClone(batch) as ProductTranslationMember[], model: value.model,
    logicalWorkKey: productTranslationLogicalWorkKey(batch), inputHash: productTranslationInputHash({ members: batch, model: value.model }),
    provider: "abcllm", routeId: "product-translate", wireHash: "c".repeat(64), servingContractHash: "d".repeat(64), totalTokenBound: 8192,
    chargedTokens: 8192, job: { name: "product-translate", token: randomUUID(), requestedVersion: 1 },
    role: { role: "text", instanceId: value.owner.instanceId, bootId: value.owner.bootId, release: "ledger-fixture", kind: "primary", epoch: 1,
      batch: { mode: "legacy" } } };
}
/** text 경로 대표: product-translate dispatched 행(실제 slot → lock → finish). */
async function translate(): Promise<{ dispatch: ProductTranslationModelDispatch; requested: ModelCapacityRequest }> {
  const batch = members(), requested = translationRequest(batch);
  const handle = granted(await requestProductTranslationModelSlot(requested, batch));
  const dispatch = await db.transaction(async tx => {
    const lock = await lockProductTranslationModelCapacityDispatch(tx, { reservation: handle, identity: identity(requested), members: batch });
    if (!lock) throw new Error("actual_lock_required");
    return finishProductTranslationModelCapacityDispatch(tx, lock, translationBinding(requested, batch));
  });
  return { dispatch, requested };
}
/** local-direct dispatched 행 — text 경로 밖 binding 이 이 근거를 받지 않는지 보려고(0149 시험과 같은 손 UPDATE; 저장 모양은 CHECK 가 본다). */
async function local() {
  const target: LocalModelTarget = { kind: "audit", purpose: "audit", itemId: ++serial, slug: `${prefix}-audit` };
  const logical = localModelLogicalKey(target), routeId = localModelRoute(target);
  const binding: LocalModelBinding = { kind: "local_model_direct", version: 1, target, logicalWorkKey: logical, routeId, provider: "local-direct",
    model: localModel, backendId: "fixture-direct", physicalGroup: "same-hardware", deploymentRevision: "fixture-deployment",
    inputHash: "a".repeat(64), sourceRevisionHash: "b".repeat(64), reviewPolicyHash: "c".repeat(64), promptVersion: "fixture-prompt",
    wireHash: "d".repeat(64), servingContractHash: "e".repeat(64), totalTokenBound: 8192, chargedTokens: 8192,
    job: { name: localModelJob(target), token: randomUUID(), requestedVersion: 1 } };
  const requested: ModelCapacityRequest = { requestId: randomUUID(), workKey: `${logical}:${binding.inputHash}`, owner: { ...owner }, class: "background",
    pool: "reviewer", routeId, provider: "local-direct", model: localModel };
  const handle = granted(await requestLocalModelSlot(requested, target));
  const bindingHash = localModelBindingHash(binding);
  expect(await admin`UPDATE model_capacity_requests SET state='dispatched',dispatch_binding=${JSON.stringify(binding)}::text::jsonb,
    dispatch_binding_hash=${bindingHash},dispatched_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE request_id=${requested.requestId}::uuid AND state='reserved' AND token=${handle.token}::uuid RETURNING request_id`).toHaveLength(1);
  return { dispatch: { ...handle, binding, bindingHash }, requested };
}
const row = async (id: string) => (await admin`SELECT to_jsonb(r) AS value FROM model_capacity_requests r WHERE request_id=${id}::uuid`)[0]?.value as Record<string, unknown>;
const events = async (id: string) => Array.from(await admin`SELECT kind,from_state,to_state,reason,evidence FROM model_capacity_events WHERE request_id=${id}::uuid ORDER BY id`);
const verdict = (error: unknown) => { const failure = error as { code?: string; constraint_name?: string }; return `${failure.code}:${failure.constraint_name}`; };
class Rollback extends Error {}
/** 한 번의 시도를 TX 안에서 하고 늘 되돌린다 — 받아들여졌으면 "accepted", 아니면 code:constraint. */
async function attempt(run: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<string> {
  try { await admin.begin(async tx => { await run(tx); throw new Rollback(); }); }
  catch (error) { return error instanceof Rollback ? "accepted" : verdict(error); }
  return "unreachable";
}
const settleRow = (requestId: string, evidence: unknown) => (tx: postgres.TransactionSql) => tx`UPDATE model_capacity_requests SET state='settled',
  terminal_evidence=${JSON.stringify(evidence)}::text::jsonb, terminal_evidence_hash=${reviewHash(evidence)}, settled_at=clock_timestamp(), updated_at=clock_timestamp()
  WHERE request_id=${requestId}::uuid`;
const settledEvent = (requestId: string, fromState: string, evidence: unknown) => async (tx: postgres.TransactionSql) => {
  const [current] = await tx`SELECT epoch,revision,policy_hash FROM model_capacity_requests WHERE request_id=${requestId}::uuid`;
  await tx`INSERT INTO model_capacity_events (request_id,kind,epoch,revision,policy_hash,from_state,to_state,reason,evidence)
    VALUES (${requestId}::uuid,'dispatch_settled',${current.epoch},${current.revision},${current.policy_hash},${fromState},'settled',NULL,
    ${JSON.stringify(evidence)}::text::jsonb)`;
};

beforeAll(async () => {
  ensureSchema();
  [originalControl] = (await admin`SELECT to_jsonb(c) AS value FROM model_capacity_control c WHERE id=1`).map(entry => entry.value);
  expect(originalControl).toMatchObject({ mode: "disabled", policy: null });
  expect((await admin`SELECT count(*)::int AS n FROM model_capacity_check_rules WHERE source='0174_gateway_http_rejected'`)[0].n).toBe(2);
});
afterEach(async () => {
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_events WHERE request_id IN (SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${owner.instanceId})`;
    await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_requests WHERE owner_instance_id=${owner.instanceId}`;
    await tx`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,policy_hash=r.policy_hash,cursor=r.cursor,
      updated_at=r.updated_at FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalControl)}::text::jsonb) r WHERE c.id=r.id`;
  });
  expect(Array.from(await admin`SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass
    AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate') ORDER BY tgname`))
    .toEqual([{ tgname: "model_capacity_events_no_change", tgenabled: "A" }, { tgname: "model_capacity_events_no_truncate", tgenabled: "A" }]);
});
afterAll(() => admin.end({ timeout: 5 }));
async function install(deviceSlots = 1) {
  const value: ModelCapacityPolicy = { ...policy, groupLimits: { ...policy.groupLimits, [device]: deviceSlots } };
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(value)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(value)},
    cursor=0,updated_at=clock_timestamp() WHERE id=1`;
}

it("a 429 settles the dispatched text row as gateway_http_rejected, frees the limit-1 device at once and counts as a failure, not a success", async () => {
  await install();
  const { dispatch, requested } = await translate();
  const nextBatch = members(), next = translationRequest(nextBatch);
  // 보낸 행이 칸 1 을 쥐고 있다
  expect(await requestProductTranslationModelSlot(next, nextBatch)).toEqual({ kind: "deferred", reason: "capacity" });
  const witness = issueGatewayHttpRejected(dispatch, 429, 2_000), evidence = readGatewayHttpRejected(witness)!;
  expect(evidence).toEqual({ version: 1, kind: "gateway_http_rejected", dispatch, status: 429, retryAfterMs: 2_000 });
  expect(await reconcileGatewayHttpRejected(witness)).toEqual({ kind: "settled" });
  const settled = await row(requested.requestId);
  expect(settled).toMatchObject({ state: "settled", terminal_evidence: evidence, terminal_evidence_hash: reviewHash(evidence) });
  expect(settled.settled_at).not.toBeNull();
  // C 는 그대로다(사용량 증거 없음) — binding 의 chargedTokens = totalTokenBound
  expect(settled.dispatch_binding).toEqual(dispatch.binding);
  expect((settled.dispatch_binding as { chargedTokens: number }).chargedTokens).toBe(8192);
  expect((await events(requested.requestId)).map(entry => [entry.kind, entry.from_state, entry.to_state, entry.reason]))
    .toEqual([["queued", null, "waiting", null], ["reserved", "waiting", "reserved", null], ["dispatch_started", "reserved", "dispatched", null],
      ["dispatch_settled", "dispatched", "settled", null]]);
  expect((await events(requested.requestId)).at(-1)!.evidence).toEqual(evidence);
  expect((await events(requested.requestId)).map(entry => entry.kind)).not.toContain("dispatch_indeterminate");
  // 칸이 바로 빈다 — 기다리던 요청이 들어간다(유지 시간을 기다리지 않는다)
  expect((await requestProductTranslationModelSlot(next, nextBatch)).kind).toBe("granted");
  // 운영 화면: 실패 1·성공 0·미분류 0, 마지막 성공 없음
  const { readAdminModelsObservation } = await import("@/lib/operations/admin-models-repository");
  const observation = await readAdminModelsObservation();
  expect(observation.error).toBeNull();
  const metrics = observation.rows.find(entry => entry.groupId === device && entry.routeId === "product-translate");
  expect(metrics).toMatchObject({ succeeded1h: 0, failed1h: 1, unclassified1h: 0, lastSuccessAt: null });
  // 같은 증거는 멱등, 다른 증거(같은 dispatch 의 403)는 충돌이다
  expect(await reconcileGatewayHttpRejected(witness)).toEqual({ kind: "already_settled" });
  await expect(reconcileGatewayHttpRejected(issueGatewayHttpRejected(dispatch, 403, null))).rejects.toThrow("gateway_http_rejected_conflict");
});

it("the same answer left indeterminate holds the slot; the ledger refuses a rejected witness for an indeterminate row and copies are no authority", async () => {
  await install();
  const { dispatch, requested } = await translate();
  expect(await markModelDispatchIndeterminate(dispatch, "transport_unknown")).toBe(true);
  const nextBatch = members(), next = translationRequest(nextBatch);
  // 결과 미확정은 유지 시간(기본 600초) 동안 칸을 쥔다 — 0174 이전의 429 가 바로 이 모양이었다
  expect(await requestProductTranslationModelSlot(next, nextBatch)).toEqual({ kind: "deferred", reason: "capacity" });
  const witness = issueGatewayHttpRejected(dispatch, 429, null);
  await expect(reconcileGatewayHttpRejected(witness)).rejects.toThrow("gateway_http_rejected_state_mismatch");
  expect(await row(requested.requestId)).toMatchObject({ state: "indeterminate", terminal_evidence: null, settled_at: null });
  // 저장된 JSON·사본은 권한이 아니다
  await expect(reconcileGatewayHttpRejected(structuredClone(witness))).rejects.toThrow("invalid_gateway_http_rejected");
  // 증인은 처리 전 거절 상태에만 생긴다 — 5xx·3xx·다른 4xx(시간 초과·끊김은 응답이 없어 여기 오지 않는다)는 결과 미확정 그대로다
  for (const status of [200, 307, 400, 404, 408, 409, 413, 422, 499, 500, 502, 503, 504]) expect(gatewayHttpRejectedWitness(dispatch, status, null)).toEqual({});
  for (const status of [401, 403, 429]) expect(readGatewayHttpRejected((gatewayHttpRejectedWitness(dispatch, status, 5) as { rejected: unknown }).rejected))
    .toMatchObject({ kind: "gateway_http_rejected", status, retryAfterMs: 5 });
});

it("the guards accept only the exact 0174 evidence of the row's own dispatched handle on a text route", async () => {
  await install(4);
  const { dispatch, requested } = await translate(), other = await translate();
  const good = { version: 1, kind: "gateway_http_rejected", dispatch, status: 429, retryAfterMs: null };
  const terminal = "23514:model_capacity_requests_terminal_check", eventTerminal = "23514:model_capacity_events_terminal_check";
  expect(await attempt(settleRow(requested.requestId, good))).toBe("accepted");
  expect(await attempt(settleRow(requested.requestId, { ...good, status: 401, retryAfterMs: 3_600_000 }))).toBe("accepted");
  expect(await attempt(settleRow(requested.requestId, { ...good, retryAfterMs: 0 }))).toBe("accepted");
  for (const forged of [{ ...good, status: 500 }, { ...good, status: 400 }, { ...good, status: "429" }, { ...good, status: 429.5 },
    { ...good, retryAfterMs: 3_600_001 }, { ...good, retryAfterMs: -1 }, { ...good, retryAfterMs: 1.5 }, { ...good, retryAfterMs: "120" },
    { ...good, version: 2 }, { ...good, kind: "gateway_http_reject" }, { ...good, extra: true }, Object.fromEntries(Object.entries(good).filter(([key]) => key !== "retryAfterMs")),
    { ...good, dispatch: other.dispatch }, { ...good, dispatch: { ...dispatch, token: randomUUID() } }])
    expect(await attempt(settleRow(requested.requestId, forged)), JSON.stringify(forged).slice(0, 120)).toBe(terminal);
  // events: dispatched → settled 만(gateway_not_started 처럼 indeterminate 에서는 받지 않는다)
  expect(await attempt(settledEvent(requested.requestId, "dispatched", good))).toBe("accepted");
  expect(await attempt(settledEvent(requested.requestId, "indeterminate", good))).toBe(eventTerminal);
  expect(await attempt(settledEvent(requested.requestId, "dispatched", { ...good, status: 503 }))).toBe(eventTerminal);
  expect(await attempt(settledEvent(requested.requestId, "dispatched", { ...good, dispatch: other.dispatch }))).toBe(eventTerminal);
  // text 경로 밖 binding(local-direct)은 이 근거로 정산하지 않는다
  const direct = await local();
  const localEvidence = { version: 1, kind: "gateway_http_rejected", dispatch: direct.dispatch, status: 429, retryAfterMs: null };
  expect(await attempt(settleRow(direct.requested.requestId, localEvidence))).toBe(terminal);
  expect(await attempt(settledEvent(direct.requested.requestId, "dispatched", localEvidence))).toBe(eventTerminal);
  // 시도는 모두 되돌려졌다
  expect(await row(requested.requestId)).toMatchObject({ state: "dispatched", terminal_evidence: null });
});
