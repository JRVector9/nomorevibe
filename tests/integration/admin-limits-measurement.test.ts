import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { modelCapacityPolicyHash, productTranslationInputHash, productTranslationLogicalWorkKey, type ModelCapacityPolicy, type ModelCapacityRequest,
  type ModelCapacityReservation, type ModelSlotResult, type ProductTranslationDispatchBinding, type ProductTranslationMember,
  type ProductTranslationModelDispatch } from "@/lib/llm/capacity";
import { cancelReservedModelSlot, finishProductTranslationModelCapacityDispatch, lockProductTranslationModelCapacityDispatch, markModelDispatchIndeterminate,
  reconcileGatewayHttpRejected, requestProductTranslationModelSlot } from "@/lib/llm/capacity-repository";
import { issueGatewayHttpRejected } from "@/lib/llm/gateway-http-rejected";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

vi.mock("server-only", () => ({}));

/**
 * 「실시간 한도」 장부 실측(2026-11-11, lib/operations/admin-limits-repository.ts queryLimitsMeasurement) — 실제 PostgreSQL·실제 장부 행.
 * 공개 번역 경로에 (1) 정산된 호출 둘, (2) 결과 미확정 하나(client_timeout), (3) 보내기 전에 취소된 예약 하나를 장부 함수로 만든 뒤,
 * 읽기 전용 스냅숏 한 번이 작업 줄마다 호출 수·p50/p99/최대·상한에서 끊김·미확정 갈래·취소·모델/장비 섞임·장비 칸·정책 route 를 맞게 세는지 본다.
 * 분류 상한은 지도로 넘기므로 같은 행을 상한 0(모두 상한에서 끊김)·10분(모두 상한 안, 미확정은 틱이 끊음)으로 나눠 본다.
 * 이 파일은 자기 owner 의 행·event 만 지우고 control 행은 원래 값으로 되돌린다. 읽기만 하는지는 read only TX(쓰면 25006)로 보인다.
 */
const tag = randomUUID().slice(0, 8), prefix = `limits-measure-${tag}`, owner = { instanceId: prefix, bootId: randomUUID() };
const device = `limits-${tag}`, model = "Limits Model";
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: prefix } });
let originalControl: Record<string, unknown>, serial = Number.parseInt(randomUUID().slice(0, 7), 16);
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 8, providerLimits: { account: 8 }, groupLimits: { [device]: 8 }, poolLimits: { reviewer: 8, text: 8 },
  weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "product-translate", provider: "abcllm", model, providerBudgetId: "account", groupId: device }] };

function granted(result: ModelSlotResult): ModelCapacityReservation {
  expect(result.kind).toBe("granted"); if (result.kind !== "granted") throw new Error("actual_reservation_required");
  return result.reservation;
}
function identity(value: ModelCapacityRequest) { const result = { ...value }; Reflect.deleteProperty(result, "requestId"); return result; }
function members(): ProductTranslationMember[] {
  return [++serial].map(productId => ({ productId, slug: `${prefix}-${productId}`, locale: "en", field: "tagline", sourceHash: "a".repeat(64),
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
    role: { role: "text", instanceId: value.owner.instanceId, bootId: value.owner.bootId, release: "ledger-fixture", kind: "primary", epoch: 1, batch: { mode: "legacy" } } };
}
async function dispatched(): Promise<ProductTranslationModelDispatch> {
  const batch = members(), requested = translationRequest(batch);
  const handle = granted(await requestProductTranslationModelSlot(requested, batch));
  return db.transaction(async tx => {
    const lock = await lockProductTranslationModelCapacityDispatch(tx, { reservation: handle, identity: identity(requested), members: batch });
    if (!lock) throw new Error("actual_lock_required");
    return finishProductTranslationModelCapacityDispatch(tx, lock, translationBinding(requested, batch));
  });
}

beforeAll(async () => {
  ensureSchema();
  [originalControl] = (await admin`SELECT to_jsonb(c) AS value FROM model_capacity_control c WHERE id=1`).map(entry => entry.value);
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
    await tx`DELETE FROM model_capacity_devices WHERE device_id=${device}`;
  });
});
afterAll(() => admin.end({ timeout: 5 }));

it("작업 줄마다 정산 호출·지속 시간·상한에서 끊김·미확정 갈래·보내기 전 취소를 한 읽기 전용 스냅숏으로 센다", async () => {
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(policy)},
    cursor=0,updated_at=clock_timestamp() WHERE id=1`;
  await admin`INSERT INTO model_capacity_devices (device_id, limit_slots, secondary_cap, updated_by) VALUES (${device}, 3, 1, ${prefix})
    ON CONFLICT (device_id) DO UPDATE SET limit_slots = 3`;
  // 정산 둘 — 공급자 처리 전 거절(429)로 정산한다(장부가 settled_at·dispatched_at 을 남기는 실제 길)
  for (let index = 0; index < 2; index++) expect(await reconcileGatewayHttpRejected(issueGatewayHttpRejected(await dispatched(), 429, null))).toEqual({ kind: "settled" });
  // 결과 미확정 하나(시간 초과) — 행은 indeterminate 로 남는다
  expect(await markModelDispatchIndeterminate(await dispatched(), "client_timeout")).toBe(true);
  // 보내기 전에 취소된 예약 하나
  const batch = members();
  expect(await cancelReservedModelSlot(granted(await requestProductTranslationModelSlot(translationRequest(batch), batch)))).toBe(true);

  const { queryLimitsMeasurement } = await import("@/lib/operations/admin-limits-repository");
  // 이 테스트 DB 의 다른 행(다른 파일이 남긴 것)이 섞이지 않게 지도는 공개 번역 하나만
  const tight = await queryLimitsMeasurement({ "product-translate": { task: "product-translate", capMs: 0 } });
  expect(Date.parse(tight.measuredAt)).toBeGreaterThan(Date.now() - 60_000);
  const mine = tight.mix.filter(entry => entry.groupId === device);
  expect(mine).toEqual([{ task: "product-translate", provider: "abcllm", model, groupId: device, calls: 2 }]);
  const task = tight.tasks["product-translate"];
  expect(task.calls).toBeGreaterThanOrEqual(2);
  expect(task.p50Ms).not.toBeNull();
  expect(task.p50Ms!).toBeGreaterThanOrEqual(0);
  expect(task.p99Ms!).toBeGreaterThanOrEqual(task.p50Ms!);
  expect(task.maxMs!).toBeGreaterThanOrEqual(task.p99Ms!);
  // 상한 0 이면 정산 호출은 모두 「상한에서 끊김」, 미확정도 상한 근처다(틱이 끊은 것이 아니다)
  expect(task.cutAtCap).toBe(task.calls);
  expect(task.unknown).toBeGreaterThanOrEqual(1);
  expect(task.unknownAtCap).toBe(task.unknown);
  expect(task.tickCut).toBe(0);
  expect(task.cancelled).toBeGreaterThanOrEqual(1);
  expect(tight.devices.find(entry => entry.deviceId === device)).toEqual({ deviceId: device, limitSlots: 3, enabled: true, modelLimits: [] });
  expect(tight.policyRoutes).toEqual([{ routeId: "product-translate", provider: "abcllm", model, groupId: device }]);

  // 상한 10분이면 같은 행이 상한 안 — 시간 초과 미확정은 「틱이 끊음」(상한 - 2초보다 짧다)
  const loose = await queryLimitsMeasurement({ "product-translate": { task: "product-translate", capMs: 600_000 } });
  expect(loose.tasks["product-translate"]).toMatchObject({ cutAtCap: 0, unknownAtCap: 0, tickCut: loose.tasks["product-translate"].unknown });
  expect(loose.tasks["product-translate"].tickCutMinMs).not.toBeNull();
  // 공급자마다 다른 상한(1차 심사처럼) — 이 공급자에 0 을 주면 다시 모두 상한에서 끊김
  const byProvider = await queryLimitsMeasurement({ "product-translate": { task: "product-translate", capMs: 600_000, providers: { abcllm: 0 } } });
  expect(byProvider.tasks["product-translate"].cutAtCap).toBe(byProvider.tasks["product-translate"].calls);
  // 지도에 없는 장부 route 는 세지 않는다
  expect((await queryLimitsMeasurement({ "reason-translate": { task: "reason-translate", capMs: 45_000 } })).mix.filter(entry => entry.groupId === device)).toEqual([]);
});

it("읽기 전용 TX 다 — 실측 SQL 은 장부에 쓰지 않고(행·event 수가 그대로), 빈 장부·빈 지도에서도 던지지 않는다", async () => {
  const count = async () => (await admin`SELECT (SELECT count(*) FROM model_capacity_requests)::int AS requests, (SELECT count(*) FROM model_capacity_events)::int AS events`)[0];
  const before = await count();
  const { queryLimitsMeasurement } = await import("@/lib/operations/admin-limits-repository");
  const empty = await queryLimitsMeasurement({});
  expect(empty).toMatchObject({ tasks: {}, mix: [] });
  const unused = await queryLimitsMeasurement({ "no-such-route": { task: "nothing", capMs: null } });
  expect(unused.tasks).toEqual({});
  expect(await count()).toEqual(before);
});
