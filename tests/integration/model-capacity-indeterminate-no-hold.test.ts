import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { modelCapacityPolicyHash, operatorReviewEvidenceHash, type ModelCapacityPolicy, type ModelCapacityRequest } from "@/lib/llm/capacity";
import { beginModelDispatch, closeModelCapacityUnknownReview, findOwnPendingModelRequest, markModelDispatchIndeterminate,
  requestModelSlot } from "@/lib/llm/capacity-repository";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

/**
 * 2026-10-30 소유자 결정: 미확인(indeterminate) 행은 사람 검토용으로 남지만 슬롯을 점유하지 않고, 같은 작업의 재접수와 정책 변경을 막지 않는다.
 * 2026-11-10 결과 미확정 점유 뒤로 칸 점유는 유지 시간(runtime_settings capacity.unknownHoldSeconds) 동안만이다 — 이 파일은 그 값을 0(= 10-30 규칙)으로
 * 두고 본다(유지 시간이 있을 때는 model-capacity-unknown-hold.test.ts). 재접수 fence·정책 변경은 유지 시간과 무관하게 10-30 그대로다.
 * 이 파일은 공개 API 만 쓰고 자기 owner 의 행만 지운다(control·runtime_settings 행은 원래 값으로 되돌린다).
 */
const instanceId = `nohold-${randomUUID()}`;
const owner = { instanceId, bootId: randomUUID() };
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: "model-capacity-indeterminate-no-hold" } });
let originalControl: Record<string, unknown>;
let originalSettings: unknown;

const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { account: 1 }, groupLimits: { shared: 1 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 2, second: 1, background: 1 }, maxWaiting: 32, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "fixture-chat", provider: "fixture-provider", model: "fixture-model", providerBudgetId: "account", groupId: "shared" }] };

const request = (overrides: Partial<ModelCapacityRequest> = {}): ModelCapacityRequest => ({ requestId: randomUUID(), workKey: randomUUID(), owner,
  class: "first", pool: "reviewer", routeId: "fixture-chat", provider: "fixture-provider", model: "fixture-model", ...overrides });
async function installPolicy(value: ModelCapacityPolicy = policy, bump: "none" | "revision" | "epoch" = "none") {
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(value)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(value)},
    cursor=0,revision=revision+${bump === "none" ? 0 : 1},epoch=epoch+${bump === "epoch" ? 1 : 0},updated_at=clock_timestamp() WHERE id=1`;
}
/** waiting → reserved → dispatched → indeterminate(reason) 한 행. */
async function unknownRow(reason: "client_timeout" | "local_abort" | "transport_unknown" = "client_timeout", value = request()) {
  const slot = await requestModelSlot(value);
  if (slot.kind !== "granted") throw new Error(`fixture_not_granted:${JSON.stringify(slot)}`);
  const begun = await beginModelDispatch(slot.reservation);
  if (begun.kind !== "dispatched") throw new Error("fixture_not_dispatched");
  expect(await markModelDispatchIndeterminate(begun.dispatch, reason)).toBe(true);
  return { value, dispatch: begun.dispatch };
}
const stateOf = async (requestId: string) => (await admin`SELECT state FROM model_capacity_requests WHERE request_id=${requestId}::uuid`)[0]?.state;
const occupying = async () => (await admin`SELECT count(*)::int AS n FROM model_capacity_requests WHERE owner_instance_id=${instanceId} AND state IN ('reserved','dispatched')`)[0].n;

beforeAll(async () => {
  ensureSchema();
  [originalControl] = await admin`SELECT to_jsonb(c) AS value FROM model_capacity_control c WHERE id=1`.then(rows => rows.map(row => row.value));
  expect(originalControl).toMatchObject({ mode: "disabled", policy: null });
  [{ values: originalSettings }] = await admin`SELECT values FROM runtime_settings WHERE id = 1`;
});
beforeEach(async () => {
  await admin`UPDATE runtime_settings SET values = jsonb_set(values, '{capacity}', '{"unknownHoldSeconds":0}'::jsonb) WHERE id = 1`;
});
afterEach(async () => {
  await admin.begin(async tx => {
    await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_events WHERE request_id IN (SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${instanceId})`;
    await tx`DELETE FROM model_capacity_requests WHERE owner_instance_id=${instanceId}`;
    await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    await tx`UPDATE runtime_settings SET values=${JSON.stringify(originalSettings)}::text::jsonb WHERE id=1`;
    await tx`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,policy_hash=r.policy_hash,cursor=r.cursor,updated_at=r.updated_at
      FROM jsonb_populate_recordset(NULL::model_capacity_control,${JSON.stringify([originalControl])}::text::jsonb) r WHERE c.id=r.id`;
  });
});
afterAll(() => admin.end({ timeout: 3 }));

it("hold 0: an indeterminate row frees its slot: the next request is granted at globalLimit 1 and the unknown row stays for review with its reason", async () => {
  await installPolicy();
  const { value, dispatch } = await unknownRow("client_timeout");
  expect(await occupying()).toBe(0);
  const next = request(), slot = await requestModelSlot(next);
  expect(slot.kind).toBe("granted");
  expect(await stateOf(value.requestId)).toBe("indeterminate");
  expect(await admin`SELECT reason FROM model_capacity_events WHERE request_id=${dispatch.requestId}::uuid AND kind='dispatch_indeterminate'`)
    .toEqual([{ reason: "client_timeout" }]);
  // 두 번째 표시도 멱등이고 사유를 덧쓰지 않는다.
  expect(await markModelDispatchIndeterminate(dispatch, "transport_unknown")).toBe(true);
  expect(await admin`SELECT count(*)::int AS n FROM model_capacity_events WHERE request_id=${dispatch.requestId}::uuid AND kind='dispatch_indeterminate'`).toEqual([{ n: 1 }]);
});

it("the same logical work (owner + work key) re-admits with a new requestId while its indeterminate row exists", async () => {
  await installPolicy();
  const workKey = `nohold-work-${randomUUID()}`;
  const { value } = await unknownRow("local_abort", request({ workKey }));
  const identity = { owner, workKey, class: value.class, pool: value.pool, routeId: value.routeId, provider: value.provider, model: value.model };
  // 조정기의 readback 은 미확인 행을 '보류 중'으로 돌려주지 않는다 → 새 requestId 로 접수한다.
  expect(await findOwnPendingModelRequest(identity)).toBeNull();
  const retry = request({ workKey });
  const slot = await requestModelSlot(retry);
  expect(slot.kind).toBe("granted");
  expect(await admin`SELECT state FROM model_capacity_requests WHERE owner_instance_id=${instanceId} AND work_key=${workKey} ORDER BY queue_ordinal`)
    .toEqual([{ state: "indeterminate" }, { state: "reserved" }]);
  // 같은 requestId 로 다시 묻는 것은 여전히 '전송됨'이다(그 요청 자체는 끝났다).
  expect(await requestModelSlot(value)).toEqual({ kind: "deferred", reason: "dispatched" });
});

it("a policy change with only indeterminate old-generation rows does not defer (with or without a hold), while a dispatched old-generation row still does", async () => {
  // 유지 시간이 있어도 옛 세대 판정은 미확정을 세지 않는다(칸 점유만 유지 시간을 본다 — 이 행은 옛 장비 shared 의 칸만 쥔다)
  await admin`UPDATE runtime_settings SET values = jsonb_set(values, '{capacity}', '{"unknownHoldSeconds":600}'::jsonb) WHERE id = 1`;
  await installPolicy();
  await unknownRow("transport_unknown");
  const renamed: ModelCapacityPolicy = { ...policy, groupLimits: { renamed: 1 }, routes: policy.routes.map(route => ({ ...route, groupId: "renamed" })) };
  await installPolicy(renamed, "epoch");
  const fresh = request();
  expect((await requestModelSlot(fresh)).kind).toBe("granted");
  // 대조: 결과 모르는 실제 전송(dispatched)은 옛 세대 점유라 policy_changed 로 미룬다.
  const held = request(); const slot = await requestModelSlot(held);
  expect(slot).toEqual({ kind: "deferred", reason: "capacity" }); // fresh 가 슬롯 1 을 쥔다
  const again = await requestModelSlot(fresh); // 같은 requestId 재조회는 같은 예약을 돌려준다
  if (again.kind !== "granted") throw new Error("fixture_not_granted_again");
  const begun = await beginModelDispatch(again.reservation);
  expect(begun.kind).toBe("dispatched");
  await installPolicy(policy, "epoch");
  expect(await requestModelSlot(request())).toEqual({ kind: "deferred", reason: "policy_changed" });
});

it("검토 완료 closes an indeterminate row as withdrawn with operator_review evidence on the row and a dispatch_reviewed event; capacity is unchanged", async () => {
  await installPolicy();
  const { value, dispatch } = await unknownRow("client_timeout");
  const before = await occupying();
  const result = await closeModelCapacityUnknownReview({ requestId: value.requestId, operator: "jr", note: "엔진 응답 없음 확인 · 재시도는 다음 틱" });
  expect(result.kind).toBe("reviewed"); if (result.kind !== "reviewed") throw new Error("not_reviewed");
  expect(result.evidence).toMatchObject({ version: 1, kind: "operator_review", requestId: value.requestId, owner, fromState: "indeterminate", operator: "jr" });
  const [row] = await admin`SELECT state, terminal_evidence, terminal_evidence_hash, settled_at FROM model_capacity_requests WHERE request_id=${value.requestId}::uuid`;
  expect(row).toMatchObject({ state: "withdrawn", settled_at: null, terminal_evidence_hash: operatorReviewEvidenceHash(result.evidence) });
  expect(row.terminal_evidence).toEqual(result.evidence);
  expect((await admin`SELECT kind, from_state, to_state, reason, evidence FROM model_capacity_events WHERE request_id=${value.requestId}::uuid ORDER BY id`).at(-1))
    .toEqual({ kind: "dispatch_reviewed", from_state: "indeterminate", to_state: "withdrawn", reason: null, evidence: result.evidence });
  expect(await occupying()).toBe(before);
  expect(await closeModelCapacityUnknownReview({ requestId: value.requestId, operator: "jr", note: "again" })).toEqual({ kind: "not_indeterminate", state: "withdrawn" });
  // 결과 모르는 실제 전송은 검토 대상이 아니다.
  const live = request(); const slot = await requestModelSlot(live);
  if (slot.kind !== "granted") throw new Error("fixture_not_granted");
  await beginModelDispatch(slot.reservation);
  expect(await closeModelCapacityUnknownReview({ requestId: live.requestId, operator: "jr", note: "x" })).toEqual({ kind: "not_indeterminate", state: "dispatched" });
  expect(await markModelDispatchIndeterminate(dispatch, "transport_unknown")).toBe(false);
});
