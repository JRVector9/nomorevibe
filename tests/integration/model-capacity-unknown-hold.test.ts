import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { modelCapacityPolicyHash, type ModelCapacityPolicy, type ModelCapacityRequest } from "@/lib/llm/capacity";
import { beginModelDispatch, closeModelCapacityUnknownReview, markModelDispatchIndeterminate, requestModelSlot } from "@/lib/llm/capacity-repository";
import { readModelCapacityDeviceStates } from "@/lib/llm/capacity-devices-repository";
import { DEFAULT_MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS, readModelCapacityUnknownHoldMs, storedUnknownHoldMsSql } from "@/lib/llm/capacity-unknown-hold";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

vi.mock("server-only", () => ({}));

/**
 * 결과 미확정 점유(소유자 결정 2026-11-10): indeterminate 행은 보낸 시각(없으면 미확정이 된 시각)부터 runtime_settings
 * capacity.unknownHoldSeconds(기본 600초) 동안 장비 칸·모델 상한·경로 몫에 dispatched 처럼 센다. 지나면 세지 않고, 0 이면 예전처럼 세지 않는다.
 * 행의 상태는 바뀌지 않는다(정산·종료 근거를 꾸며내지 않는다). 공개 API 로 행을 만들고, 시각만 관리 연결로 옮긴다.
 * 이 파일은 자기 owner 의 행과 자기 장비 행만 지우고 control·runtime_settings 행은 원래 값으로 되돌린다.
 */
const instanceId = `unknown-hold-${randomUUID()}`;
const owner = { instanceId, bootId: randomUUID() };
const device = `hold-${randomUUID().slice(0, 8)}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: "model-capacity-unknown-hold" } });
let originalControl: Record<string, unknown>;
let originalSettings: unknown;

const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { account: 1 }, groupLimits: { [device]: 1 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 2, second: 1, background: 1 }, maxWaiting: 32, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "fixture-chat", provider: "fixture-provider", model: "fixture-model", providerBudgetId: "account", groupId: device }] };

const request = (overrides: Partial<ModelCapacityRequest> = {}): ModelCapacityRequest => ({ requestId: randomUUID(), workKey: randomUUID(), owner,
  class: "first", pool: "reviewer", routeId: "fixture-chat", provider: "fixture-provider", model: "fixture-model", ...overrides });
async function installPolicy(value: ModelCapacityPolicy = policy) {
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(value)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(value)},
    cursor=0,updated_at=clock_timestamp() WHERE id=1`;
}
/** runtime_settings 의 capacity.unknownHoldSeconds — null 이면 키를 지운다(코드 기본값 600초). */
async function setHold(seconds: number | null) {
  await admin`UPDATE runtime_settings SET values = CASE WHEN ${seconds}::int IS NULL THEN values - 'capacity'
    ELSE jsonb_set(values, '{capacity}', jsonb_build_object('unknownHoldSeconds', ${seconds}::int)) END WHERE id = 1`;
}
/** waiting → reserved → dispatched → indeterminate(client_timeout) 한 행(공개 API). */
async function unknownRow(value = request()) {
  const slot = await requestModelSlot(value);
  if (slot.kind !== "granted") throw new Error(`fixture_not_granted:${JSON.stringify(slot)}`);
  const begun = await beginModelDispatch(slot.reservation);
  if (begun.kind !== "dispatched") throw new Error("fixture_not_dispatched");
  expect(await markModelDispatchIndeterminate(begun.dispatch, "client_timeout")).toBe(true);
  return value;
}
const stateOf = async (requestId: string) => (await admin`SELECT state FROM model_capacity_requests WHERE request_id=${requestId}::uuid`)[0]?.state;
const eventsOf = async (requestId: string) => (await admin`SELECT kind FROM model_capacity_events WHERE request_id=${requestId}::uuid ORDER BY id`).map(row => row.kind);
const deviceState = async () => (await readModelCapacityDeviceStates()).find(state => state.deviceId === device);
/** 미확정 행의 기준 시각을 과거로 옮긴다(보낸 시각이 없는 행은 updated_at = 미확정이 된 시각이 기준이다). */
async function age(requestId: string, minutes: number) {
  await admin`UPDATE model_capacity_requests SET updated_at = clock_timestamp() - make_interval(mins => ${minutes}) WHERE request_id=${requestId}::uuid`;
}

beforeAll(async () => {
  ensureSchema();
  [originalControl] = await admin`SELECT to_jsonb(c) AS value FROM model_capacity_control c WHERE id=1`.then(rows => rows.map(row => row.value));
  expect(originalControl).toMatchObject({ mode: "disabled", policy: null });
  [{ values: originalSettings }] = await admin`SELECT values FROM runtime_settings WHERE id = 1`;
});
afterEach(async () => {
  await admin.begin(async tx => {
    await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_events WHERE request_id IN (SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${instanceId})`;
    await tx`DELETE FROM model_capacity_requests WHERE owner_instance_id=${instanceId}`;
    await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_devices WHERE device_id=${device}`;
    await tx`UPDATE runtime_settings SET values=${JSON.stringify(originalSettings)}::text::jsonb WHERE id=1`;
    await tx`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,policy_hash=r.policy_hash,cursor=r.cursor,updated_at=r.updated_at
      FROM jsonb_populate_recordset(NULL::model_capacity_control,${JSON.stringify([originalControl])}::text::jsonb) r WHERE c.id=r.id`;
  });
});
afterAll(() => admin.end({ timeout: 3 }));

it("reads the hold from runtime_settings: missing key → 600 s default, a stored value, an unreadable value → default", async () => {
  await setHold(null);
  expect(await readModelCapacityUnknownHoldMs(db)).toBe(DEFAULT_MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS * 1000);
  await setHold(90);
  expect(await readModelCapacityUnknownHoldMs(db)).toBe(90_000);
  expect(await readModelCapacityUnknownHoldMs(db, { whenReadable: true })).toBe(90_000);
  await admin`UPDATE runtime_settings SET values = jsonb_set(values, '{capacity}', '{"unknownHoldSeconds":"90"}'::jsonb) WHERE id = 1`;
  expect(await readModelCapacityUnknownHoldMs(db)).toBe(DEFAULT_MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS * 1000);
  // 관측 한 문장용 SQL 식(storedUnknownHoldMsSql)은 같은 저장값에 같은 답을 낸다
  for (const stored of [null, 0, 90, 3600, "90", 3601, -1, 1.5, true]) {
    if (stored === null) await setHold(null);
    else await admin`UPDATE runtime_settings SET values = jsonb_set(values, '{capacity}', jsonb_build_object('unknownHoldSeconds', ${JSON.stringify(stored)}::jsonb)) WHERE id = 1`;
    const [row] = await db.execute<{ ms: number }>(sql`SELECT ${storedUnknownHoldMsSql} AS ms`);
    expect([stored, Number(row.ms)]).toEqual([stored, await readModelCapacityUnknownHoldMs(db)]);
  }
});

it("a held unknown blocks a new admission on a full device (default hold) and the row stays indeterminate", async () => {
  await installPolicy();
  await setHold(null);
  const unknown = await unknownRow();
  const next = request();
  expect(await requestModelSlot(next)).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await stateOf(unknown.requestId)).toBe("indeterminate");
  expect(await stateOf(next.requestId)).toBe("waiting");
  // 관측도 같은 규칙: 칸 1 을 미확정 점유 1 이 쥐고 있다
  expect(await deviceState()).toMatchObject({ limitSlots: 1, active: 1, heldUnknown: 1, waiting: 1 });
});

it("stops blocking after the window: the waiting request is granted, the unknown row is not settled or changed", async () => {
  await installPolicy();
  await setHold(60);
  const unknown = await unknownRow();
  const before = await eventsOf(unknown.requestId);
  const next = request();
  expect(await requestModelSlot(next)).toEqual({ kind: "deferred", reason: "capacity" });
  await age(unknown.requestId, 2); // 보낸 시각이 없는 행 — 미확정이 된 시각(updated_at)이 60초 창 밖으로
  expect((await requestModelSlot(next)).kind).toBe("granted");
  expect(await stateOf(unknown.requestId)).toBe("indeterminate");
  expect(await eventsOf(unknown.requestId)).toEqual(before);
  expect(await deviceState()).toMatchObject({ active: 1, heldUnknown: 0 });
});

it("0 disables holding (the 2026-10-30 rule): the next request is granted at once", async () => {
  await installPolicy();
  await setHold(0);
  await unknownRow();
  expect((await requestModelSlot(request())).kind).toBe("granted");
  expect(await deviceState()).toMatchObject({ active: 1, heldUnknown: 0 });
});

it("a saved hold applies to the very next admission (no 30 s snapshot)", async () => {
  await installPolicy();
  await setHold(0);
  await unknownRow();
  await setHold(600);
  expect(await requestModelSlot(request())).toEqual({ kind: "deferred", reason: "capacity" });
});

it("the window is measured from the dispatch time when the row has one, and from the time it became indeterminate otherwise", async () => {
  await installPolicy({ ...policy, groupLimits: { [device]: 4 } });
  await setHold(300);
  // 보낸 시각이 있는 행(장부의 묶인 전송)은 공개 API 로 만들기 무거워, 시각 칸만 다른 미확정 행 둘을 관리 연결로 넣는다(점검 트리거만 건너뛴다)
  await admin.begin(async tx => {
    await tx`SET LOCAL session_replication_role = replica`;
    for (const [minutes, label] of [[10, "old-dispatch"], [1, "fresh-dispatch"]] as const) {
      await tx`INSERT INTO model_capacity_requests (request_id, work_key, owner_instance_id, owner_boot_id, class, pool, route_id, provider, model,
        provider_budget_id, group_id, epoch, revision, policy_hash, state, token, reserved_until, queue_until, dispatched_at, updated_at)
        SELECT gen_random_uuid(), ${label}, ${instanceId}, ${owner.bootId}::uuid, 'first', 'reviewer', 'fixture-chat', 'fixture-provider', 'fixture-model',
          'account', ${device}, c.epoch, c.revision, c.policy_hash, 'indeterminate', gen_random_uuid(), clock_timestamp(), clock_timestamp(),
          clock_timestamp() - make_interval(mins => ${minutes}), clock_timestamp()
        FROM model_capacity_control c WHERE c.id = 1`;
    }
  });
  // 둘 다 방금 미확정이 됐지만(updated_at = 지금) 10분 전에 보낸 행은 300초 창 밖이다
  expect(await deviceState()).toMatchObject({ active: 1, heldUnknown: 1 });
});

it("a held unknown counts toward the model limit (0170) and the route quota (0169)", async () => {
  await installPolicy(); // 정책 대체 한도는 1 이지만 enabled 장비 행(칸 4)이 이긴다
  await setHold(null);
  await admin`INSERT INTO model_capacity_devices (device_id, limit_slots, secondary_cap, updated_by, model_limits)
    VALUES (${device}, 4, 4, 'unknown-hold-test', '[{"model":"fixture-model","max_slots":1,"engine_max":null}]'::jsonb)`;
  await unknownRow();
  expect(await requestModelSlot(request())).toEqual({ kind: "deferred", reason: "model_quota" });
  expect((await deviceState())?.models).toEqual([{ model: "fixture-model", active: 1, waiting: 0, maxSlots: 1, engineMax: null }]);
  await admin`UPDATE model_capacity_devices SET model_limits='[]'::jsonb,
    route_quotas='[{"route_id":"fixture-chat","min_slots":0,"max_slots":1}]'::jsonb WHERE device_id=${device}`;
  expect(await requestModelSlot(request())).toEqual({ kind: "deferred", reason: "route_quota" });
  expect((await deviceState())?.routes).toEqual([expect.objectContaining({ routeId: "fixture-chat", active: 1, cap: 1 })]);
  // 상한을 걷으면 공유 칸(4) 안이라 들어간다
  await admin`UPDATE model_capacity_devices SET route_quotas='[]'::jsonb WHERE device_id=${device}`;
  expect((await requestModelSlot(request())).kind).toBe("granted");
});

it("closing a held unknown (사람 검토 완료) frees its slot at once", async () => {
  await installPolicy();
  await setHold(null);
  const unknown = await unknownRow();
  const next = request();
  expect(await requestModelSlot(next)).toEqual({ kind: "deferred", reason: "capacity" });
  expect((await closeModelCapacityUnknownReview({ requestId: unknown.requestId, operator: "jr", note: "엔진 재시작 확인" })).kind).toBe("reviewed");
  expect((await requestModelSlot(next)).kind).toBe("granted");
});

it("the admin models observation counts held unknowns in the device's occupancy, like admission", async () => {
  await installPolicy();
  await setHold(null);
  const unknown = await unknownRow();
  expect(await requestModelSlot(request())).toEqual({ kind: "deferred", reason: "capacity" }); // 칸 1 을 미확정이 쥐어 다음은 기다린다
  const { readAdminModelsObservation } = await import("@/lib/operations/admin-models-repository");
  const observation = await readAdminModelsObservation({ throughput: false });
  expect(observation.error).toBeNull();
  expect(observation.unknownHoldMs).toBe(DEFAULT_MODEL_CAPACITY_UNKNOWN_HOLD_SECONDS * 1000);
  expect(observation.groups.find(group => group.groupId === device)).toMatchObject({ held: 1, heldUnknown: 1, limit: 1 });
  expect(observation.rows.find(row => row.groupId === device)).toMatchObject({ indeterminate: 1, heldUnknown: 1, dispatched: 0, waiting: 1 });
  await age(unknown.requestId, 20);
  const later = await readAdminModelsObservation({ throughput: false });
  expect(later.groups.find(group => group.groupId === device)).toMatchObject({ held: 0, heldUnknown: 0 });
  expect(later.rows.find(row => row.groupId === device)).toMatchObject({ indeterminate: 1, heldUnknown: 0 });
});
