import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { modelCapacityPolicyHash, type ModelCapacityPolicy, type ModelCapacityRequest } from "@/lib/llm/capacity";
import { beginModelDispatch, markModelDispatchIndeterminate, requestModelSlot } from "@/lib/llm/capacity-repository";
import { closeOwnerGoneReviews, markOwnerGoneIndeterminate } from "@/lib/operations/dr/owner-gone";
import { readModelCapacityUnknowns } from "@/lib/operations/model-capacity-unknowns";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

/**
 * 소유 프로세스가 사라진 dispatched 행 → indeterminate(운영자 판정, 2026-11-02) → 사람 검토로 닫기.
 * 이 파일은 자기 instance 의 장부 행·event·역할 lease 만 지운다. operations_audit·dr_process_group_events 는 덧붙이기만 되는 표라 지우지 않는다
 * (instance 이름이 실행마다 새로워 다른 파일과 섞이지 않는다). control 행은 원래 값으로 되돌린다.
 */
const admin = postgres(TEST_DATABASE_URL, { max: 2, prepare: false, onnotice: () => {}, connection: { application_name: "model-capacity-owner-gone" } });
const instances: string[] = [], roles: string[] = [];
let originalControl: Record<string, unknown>;

const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { account: 1 }, groupLimits: { shared: 1 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 2, second: 1, background: 1 }, maxWaiting: 32, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "fixture-chat", provider: "fixture-provider", model: "fixture-model", providerBudgetId: "account", groupId: "shared" }] };
async function installPolicy(limit = 1) {
  const value: ModelCapacityPolicy = { ...policy, globalLimit: limit, providerLimits: { account: limit }, groupLimits: { shared: limit },
    poolLimits: { reviewer: limit, text: limit } };
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(value)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(value)},
    cursor=0,updated_at=clock_timestamp() WHERE id=1`;
}
const ownerOf = () => { const instanceId = `og-${randomUUID().slice(0, 13)}`; instances.push(instanceId); return { instanceId, bootId: randomUUID() }; };
const request = (owner: { instanceId: string; bootId: string }): ModelCapacityRequest => ({ requestId: randomUUID(), workKey: randomUUID(), owner,
  class: "first", pool: "reviewer", routeId: "fixture-chat", provider: "fixture-provider", model: "fixture-model" });
const attestation = () => JSON.stringify({ version: 1, kernelBootId: randomUUID(), pidNamespace: 4026531836 });

/** owner 의 boot 가 dispatch 한 행 하나. 전송·접수 시각을 `agoMinutes` 전으로 옮겨 오래된 전송을 만든다. */
async function dispatchedRow(owner: { instanceId: string; bootId: string }, agoMinutes = 120) {
  const value = request(owner), slot = await requestModelSlot(value);
  if (slot.kind !== "granted") throw new Error(`fixture_not_granted:${JSON.stringify(slot)}`);
  const begun = await beginModelDispatch(slot.reservation);
  if (begun.kind !== "dispatched") throw new Error("fixture_not_dispatched");
  // binding 없는 fixture 행은 dispatched_at 이 비어 전송 시각이 dispatch_started event 시각이다(장부·모니터와 같은 coalesce). 둘 다 옮긴다.
  await admin.begin(async tx => {
    await tx`UPDATE model_capacity_requests SET queued_at = queued_at - make_interval(mins => ${agoMinutes}),
      dispatched_at = dispatched_at - make_interval(mins => ${agoMinutes}), updated_at = updated_at - make_interval(mins => ${agoMinutes})
      WHERE request_id = ${value.requestId}::uuid`;
    await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
    await tx`UPDATE model_capacity_events SET created_at = created_at - make_interval(mins => ${agoMinutes}) WHERE request_id = ${value.requestId}::uuid`;
    await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
  });
  return { value, dispatch: begun.dispatch };
}
/** 프로세스 그룹 기록기의 boot 시작 기록(owner_opened). recorded_at 은 지금부터 `agoMinutes` 전. */
async function opened(owner: { instanceId: string; bootId: string }, agoMinutes: number) {
  await admin`INSERT INTO dr_process_group_events (owner_instance_id, owner_boot_id, kind, seq, detail, recorded_at)
    VALUES (${owner.instanceId}, ${owner.bootId}::uuid, 'owner_opened', 0, ${attestation()}::text::jsonb, clock_timestamp() - make_interval(mins => ${agoMinutes}))`;
}
async function spawnedNotExited(owner: { instanceId: string; bootId: string }, agoMinutes: number) {
  const runId = randomUUID();
  await admin`INSERT INTO dr_process_group_events (owner_instance_id, owner_boot_id, kind, seq, run_id, recorded_at)
    VALUES (${owner.instanceId}, ${owner.bootId}::uuid, 'spawn_intent', 1, ${runId}::uuid, clock_timestamp() - make_interval(mins => ${agoMinutes}))`;
  await admin`INSERT INTO dr_process_group_events (owner_instance_id, owner_boot_id, kind, seq, run_id, pid, recorded_at)
    VALUES (${owner.instanceId}, ${owner.bootId}::uuid, 'spawned', 1, ${runId}::uuid, 4242, clock_timestamp() - make_interval(mins => ${agoMinutes}))`;
}
async function roleLease(owner: { instanceId: string; bootId: string }, live: boolean) {
  const role = `og-${randomUUID().slice(0, 8)}`; roles.push(role);
  await admin`INSERT INTO role_leases (role, owner_instance_id, owner_boot_id, owner_kind, owner_release, epoch, lease_until, updated_at)
    VALUES (${role}, ${owner.instanceId}, ${owner.bootId}, 'primary', 'fixture', 1, now() + make_interval(secs => ${live ? 45 : -600}), now())`;
  return role;
}
/** 옛 boot 가 죽고, 같은 instance 의 새 boot 가 전송 뒤에 떠서 역할을 쥔 상태. */
async function ownerGoneFixture() {
  const owner = ownerOf(), successor = { instanceId: owner.instanceId, bootId: randomUUID() };
  await opened(owner, 180);
  await spawnedNotExited(owner, 121);
  const row = await dispatchedRow(owner);
  await opened(successor, 60);
  const role = await roleLease(successor, true);
  return { owner, successor, role, ...row };
}
const stateOf = async (requestId: string) => (await admin`SELECT state FROM model_capacity_requests WHERE request_id=${requestId}::uuid`)[0]?.state;
const events = (requestId: string) => admin`SELECT kind, from_state, to_state, reason, evidence FROM model_capacity_events WHERE request_id=${requestId}::uuid ORDER BY id`;
const audits = (requestId: string) => admin`SELECT action, actor, ok, detail FROM operations_audit WHERE target=${requestId} ORDER BY id`;
const stuckThresholds = { reviewMaxRows: 1_000_000, reviewMaxAgeSeconds: 31_536_000, dispatchStuckSeconds: 1_800 };

beforeAll(async () => {
  ensureSchema();
  [originalControl] = await admin`SELECT to_jsonb(c) AS value FROM model_capacity_control c WHERE id=1`.then(rows => rows.map(row => row.value));
});
afterEach(async () => {
  await admin.begin(async tx => {
    await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_events WHERE request_id IN (SELECT request_id FROM model_capacity_requests WHERE owner_instance_id = ANY(${instances}))`;
    await tx`DELETE FROM model_capacity_requests WHERE owner_instance_id = ANY(${instances})`;
    await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM role_leases WHERE role = ANY(${roles})`;
    await tx`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,policy_hash=r.policy_hash,cursor=r.cursor,updated_at=r.updated_at
      FROM jsonb_populate_recordset(NULL::model_capacity_control,${JSON.stringify([originalControl])}::text::jsonb) r WHERE c.id=r.id`;
  });
  instances.length = 0; roles.length = 0;
});
afterAll(() => admin.end({ timeout: 3 }));

it("a gone owner's dispatched row becomes indeterminate with evidence and an audit row, frees its slot after the unknown hold window and the monitor's stuck count at once, then closes by operator review", async () => {
  await installPolicy();
  const fixture = await ownerGoneFixture(), id = fixture.value.requestId;
  // 슬롯 1칸을 죽은 owner 의 전송이 쥐고 있다 — 다음 요청은 줄에서 기다린다.
  const waiting = request(ownerOf());
  expect(await requestModelSlot(waiting)).toEqual({ kind: "deferred", reason: "capacity" });
  const before = await readModelCapacityUnknowns(stuckThresholds);
  if (before.status === "unknown") throw new Error("monitor_unknown");
  expect(before.stuckDispatched).toBeGreaterThanOrEqual(1);
  expect(before.alarmReasons).toContain("dispatch_stuck");

  const applied = await markOwnerGoneIndeterminate({ requestIds: [id], operator: "jr" }, true);
  expect(applied.rows).toHaveLength(1);
  const [row] = applied.rows;
  expect(row).toMatchObject({ requestId: id, status: "marked", state: "indeterminate", reason: null });
  expect(row.evidence).toMatchObject({ version: 1, kind: "owner_gone", requestId: id, owner: fixture.owner, fromState: "dispatched",
    basis: ["successor_boot"], quietMs: 30 * 60_000, unexitedSpawns: 1, operator: "jr", ownerExitRecordedAt: null,
    successor: { bootId: fixture.successor.bootId, firstStart: { source: "process_group_opened" }, roleLease: fixture.role } });
  expect(await stateOf(id)).toBe("indeterminate");
  expect((await events(id)).at(-1)).toEqual({ kind: "dispatch_indeterminate", from_state: "dispatched", to_state: "indeterminate", reason: "process_exit",
    evidence: row.evidence });
  expect(await audits(id)).toEqual([{ action: "model-capacity-owner-gone", actor: "jr", ok: true,
    detail: { fromState: "dispatched", toState: "indeterminate", reason: "process_exit", evidence: row.evidence } }]);

  // 결과 미확정 점유(2026-11-10): 보낸 시각부터 유지 시간(기본 600초) 동안 칸을 쥔다. 이 fixture 행은 binding 이 없어 dispatched_at 이 비므로
  // 미확정이 된 시각(지금)부터 잰다 — 운영의 전송 행은 모두 묶인 전송이라 dispatched_at 이 있어 120분 전 전송은 바로 칸을 놓는다.
  expect(await requestModelSlot(waiting)).toEqual({ kind: "deferred", reason: "capacity" });
  await admin`UPDATE model_capacity_requests SET updated_at = updated_at - interval '11 minutes' WHERE request_id = ${id}::uuid`;
  // 유지 시간이 지나면 같은 한도 1에서 다음 요청이 받는다(행은 그대로 indeterminate).
  expect((await requestModelSlot(waiting)).kind).toBe("granted");
  expect(await stateOf(id)).toBe("indeterminate");
  const after = await readModelCapacityUnknowns(stuckThresholds);
  if (after.status === "unknown") throw new Error("monitor_unknown");
  expect(after.stuckDispatched).toBe(before.stuckDispatched - 1);
  expect(after.count).toBe(before.count + 1);
  expect(after.requests.map(item => item.requestId)).toContain(id);

  // 다시 돌려도 바꾸지 않는다.
  expect((await markOwnerGoneIndeterminate({ requestIds: [id], operator: "jr" }, true)).rows[0])
    .toMatchObject({ status: "not_dispatched", state: "indeterminate" });
  expect((await events(id)).filter(event => event.kind === "dispatch_indeterminate")).toHaveLength(1);

  // 운영자 검토(closeModelCapacityUnknownReview)로 닫힌다. dry-run 은 상태만 읽는다.
  expect(await closeOwnerGoneReviews({ requestIds: [id], operator: "jr", note: "소유 프로세스 부재 확인(커널 패닉)" }, false))
    .toEqual({ rows: [{ requestId: id, result: "would_review", state: "indeterminate", reviewedAt: null }] });
  expect(await stateOf(id)).toBe("indeterminate");
  const closed = await closeOwnerGoneReviews({ requestIds: [id], operator: "jr", note: "소유 프로세스 부재 확인(커널 패닉)" }, true);
  expect(closed.rows[0]).toMatchObject({ requestId: id, result: "reviewed", state: "withdrawn" });
  expect(await stateOf(id)).toBe("withdrawn");
  expect((await events(id)).at(-1)).toMatchObject({ kind: "dispatch_reviewed", from_state: "indeterminate", to_state: "withdrawn" });
  expect((await audits(id)).map(item => item.action)).toEqual(["model-capacity-owner-gone", "model-capacity-unknown-reviewed"]);
  const final = await readModelCapacityUnknowns(stuckThresholds);
  if (final.status === "unknown") throw new Error("monitor_unknown");
  expect(final.count).toBe(before.count);
  // 닫힌 행은 다시 바꾸지 않는다.
  expect((await markOwnerGoneIndeterminate({ requestIds: [id], operator: "jr" }, true)).rows[0]).toMatchObject({ status: "not_dispatched", state: "withdrawn" });
  expect((await closeOwnerGoneReviews({ requestIds: [id], operator: "jr", note: "again" }, true)).rows[0])
    .toMatchObject({ result: "not_indeterminate", state: "withdrawn" });
});

it("dry-run runs the same transaction and rolls it back: no state change, event or audit row", async () => {
  await installPolicy();
  const fixture = await ownerGoneFixture(), id = fixture.value.requestId;
  const eventsBefore = (await events(id)).length;
  const dry = await markOwnerGoneIndeterminate({ requestIds: [id], operator: "jr" }, false);
  expect(dry.rows[0]).toMatchObject({ status: "marked", state: "indeterminate", evidence: { kind: "owner_gone", basis: ["successor_boot"] } });
  expect(await stateOf(id)).toBe("dispatched");
  expect(await events(id)).toHaveLength(eventsBefore);
  expect(await audits(id)).toEqual([]);
  expect(await requestModelSlot(request(ownerOf()))).toEqual({ kind: "deferred", reason: "capacity" });
});

it("refuses without owner-gone evidence and leaves the row dispatched: live owner lease, no successor, recent owner activity", async () => {
  await installPolicy(3);
  // 1) 옛 boot 가 아직 역할 lease 를 쥐고 있다(살아 있는 boot).
  const alive = await ownerGoneFixture();
  await roleLease(alive.owner, true);
  // 2) 같은 instance 의 다른 boot 가 없다 — 오래 조용해도 바꾸지 않는다.
  const lonely = ownerOf();
  await opened(lonely, 180);
  const first = await markOwnerGoneIndeterminate({ requestIds: [alive.value.requestId], operator: "jr" }, true);
  expect(first.rows[0]).toMatchObject({ status: "refused", reason: "owner_holds_role_lease", state: "dispatched", evidence: null });
  const quiet = await dispatchedRow(lonely);
  // 3) 다른 boot 는 있지만 옛 boot 의 기록이 quiet 창(30분) 안에 있다 — 막 보낸 전송.
  const recentOwner = ownerOf();
  const recent = await dispatchedRow(recentOwner, 5);
  await opened({ instanceId: recentOwner.instanceId, bootId: randomUUID() }, 1);
  const result = await markOwnerGoneIndeterminate({ requestIds: [quiet.value.requestId, recent.value.requestId], operator: "jr" }, true);
  expect(result.rows.map(row => [row.status, row.reason])).toEqual([["refused", "no_successor_boot"], ["refused", "owner_seen_recently"]]);
  for (const id of [alive.value.requestId, quiet.value.requestId, recent.value.requestId]) {
    expect(await stateOf(id)).toBe("dispatched");
    expect(await audits(id)).toEqual([]);
    expect((await events(id)).some(event => event.kind === "dispatch_indeterminate")).toBe(false);
  }
});

it("an already indeterminate row is left untouched (no second event, no audit)", async () => {
  await installPolicy();
  const fixture = await ownerGoneFixture(), id = fixture.value.requestId;
  expect(await markModelDispatchIndeterminate(fixture.dispatch, "client_timeout")).toBe(true);
  const result = await markOwnerGoneIndeterminate({ requestIds: [id], operator: "jr" }, true);
  expect(result.rows[0]).toEqual({ requestId: id, status: "not_dispatched", reason: "not_dispatched", state: "indeterminate", evidence: null, verdict: null });
  expect((await events(id)).filter(event => event.kind === "dispatch_indeterminate")).toEqual([
    { kind: "dispatch_indeterminate", from_state: "dispatched", to_state: "indeterminate", reason: "client_timeout", evidence: null }]);
  expect(await audits(id)).toEqual([]);
  // 모르는 id 도 바꿀 것이 없다.
  const missing = randomUUID();
  expect((await markOwnerGoneIndeterminate({ requestIds: [missing], operator: "jr" }, true)).rows[0]).toMatchObject({ status: "not_dispatched", state: null });
});

it("two concurrent applies on the same row: the row lock lets exactly one transition through", async () => {
  await installPolicy();
  const fixture = await ownerGoneFixture(), id = fixture.value.requestId;
  const results = await Promise.all([markOwnerGoneIndeterminate({ requestIds: [id], operator: "jr" }, true),
    markOwnerGoneIndeterminate({ requestIds: [id], operator: "jr-2" }, true)]);
  expect(results.map(result => result.rows[0].status).sort()).toEqual(["marked", "not_dispatched"]);
  expect((await events(id)).filter(event => event.kind === "dispatch_indeterminate")).toHaveLength(1);
  expect(await audits(id)).toHaveLength(1);
});

it("the owner's own exit record after the dispatch is enough without a successor boot", async () => {
  await installPolicy();
  const owner = ownerOf();
  await opened(owner, 180);
  const row = await dispatchedRow(owner);
  await admin`INSERT INTO operations_observations (key, value, observed_at) VALUES (${`worker-exit:text:${owner.bootId}`},
    ${JSON.stringify({ why: "signal", instanceId: owner.instanceId, bootId: owner.bootId, exitCode: 0 })}::text::jsonb,
    (clock_timestamp() AT TIME ZONE 'UTC') - interval '100 minutes')`;
  try {
    const result = await markOwnerGoneIndeterminate({ requestIds: [row.value.requestId], operator: "jr" }, true);
    expect(result.rows[0]).toMatchObject({ status: "marked", evidence: { basis: ["owner_exit_record"], successor: null,
      ownerLastSeen: { source: "worker_exit" } } });
    expect(await stateOf(row.value.requestId)).toBe("indeterminate");
  } finally {
    await admin`DELETE FROM operations_observations WHERE key = ${`worker-exit:text:${owner.bootId}`}`;
  }
});
