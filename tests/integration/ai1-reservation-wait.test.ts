import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { modelCapacityPolicyHash, type ModelCapacityPolicy, type ModelCapacityRequest, type ModelSlotResult } from "@/lib/llm/capacity";
import { cancelReservedModelSlot, requestAi1ModelSlot } from "@/lib/llm/capacity-repository";
import { awaitQueuedAi1Reservation, AI1_RESERVATION_POLL_MS, type Ai1ReservationWaitEvent } from "@/lib/crawl/agent-review-model-capacity";
import { runJob } from "@/lib/jobs/runner";
import { runWorker } from "@/scripts/worker";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

/**
 * AI1 틱 안의 예약 대기와 전용 줄(2026-10-29)을 실제 장부·잡 lease 로 본다.
 * - 같은 requestId 로 다시 묻는 동안 다른 호출이 슬롯을 놓으면 그 줄의 행이 reserved 가 되고 그대로 받는다(만료·취소 없음).
 * - 떠나 있는 사이 다른 호출의 grant 로 reserved 가 된 행은 다시 물을 때 쉬지 않고 받는다.
 * - 시작 가능 시각이 지나면 행을 줄에 남긴 채(취소하지 않고) 돌아온다. fence 로 행이 없으면 기다리지 않는다.
 * - 한 잡을 두 줄이 동시에 집어도 DB 잡 lease 가 한쪽만 돌린다.
 * 이 fixture 의 요청·사건·jobs 행·control 은 끝나면 원래대로 되돌린다.
 */
type Raw = Record<string, unknown>;
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: "ai1-reservation-wait-fixture" } });
const tag = randomBytes(5).toString("hex"), owner = { instanceId: `ai1-wait-${tag}`, bootId: randomUUID() }, model = "AI1 Wait Fixture Model";
const owned = new Set<string>();
let serial = 900_000_000 + Number.parseInt(randomBytes(3).toString("hex"), 16), originalControl: Raw | undefined, originalJob: Raw | undefined;
let originalObservation: Raw | undefined;
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { account: 4 }, groupLimits: { engine: 1 },
  poolLimits: { reviewer: 4, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 16, queueTtlMs: 60_000,
  reservationTtlMs: 30_000, routes: [{ routeId: "crawl-agent-review", provider: "abcllm", model, providerBudgetId: "account", groupId: "engine" }] };

function request(candidateId = ++serial, workSuffix = "a"): ModelCapacityRequest {
  const value = { requestId: randomUUID(), owner: { ...owner }, class: "first" as const, pool: "reviewer" as const,
    routeId: "crawl-agent-review", provider: "abcllm", model, workKey: `ai1:${candidateId}:${workSuffix.repeat(64)}` };
  owned.add(value.requestId);
  return value;
}
const ask = (value: ModelCapacityRequest) => requestAi1ModelSlot(value, Number(value.workKey.split(":")[1]));
function reservationOf(result: ModelSlotResult) {
  expect(result.kind).toBe("granted"); if (result.kind !== "granted") throw new Error("granted_required");
  return result.reservation;
}
const state = async (id: string) => (await admin`SELECT state FROM model_capacity_requests WHERE request_id=${id}::uuid`)[0]?.state as string | undefined;
const kinds = async (id: string) => Array.from(await admin`SELECT kind FROM model_capacity_events WHERE request_id=${id}::uuid ORDER BY id`).map(row => row.kind);

async function clear() {
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const ids = [...owned];
    if (ids.length) {
      await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
      await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
      await tx`DELETE FROM model_capacity_events WHERE request_id=ANY(${ids}::uuid[])`;
      await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
      await tx`DELETE FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[])`;
    }
  });
  owned.clear();
}

beforeAll(async () => {
  ensureSchema();
  const active = await admin`SELECT count(*)::int AS count FROM model_capacity_requests WHERE state IN ('waiting','reserved','dispatched','indeterminate')`;
  if (active[0].count) throw new Error("ai1_wait_fixture_active_capacity");
  originalControl = (await admin`SELECT to_jsonb(c) AS value FROM model_capacity_control c WHERE id=1`)[0].value as Raw;
  originalJob = (await admin`SELECT to_jsonb(j) AS value FROM jobs j WHERE name='crawl-agent-review'`)[0]?.value as Raw | undefined;
  originalObservation = (await admin`SELECT to_jsonb(o) AS value FROM operations_observations o WHERE key='job:crawl-agent-review'`)[0]?.value as Raw | undefined;
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(policy)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(policy)},cursor=0 WHERE id=1`;
});
afterEach(clear);
afterAll(async () => {
  try {
    await clear();
    if (originalControl) await admin`UPDATE model_capacity_control c SET mode=r.mode,epoch=r.epoch,revision=r.revision,policy=r.policy,
      policy_hash=r.policy_hash,cursor=r.cursor,updated_at=r.updated_at
      FROM jsonb_populate_record(NULL::model_capacity_control,${JSON.stringify(originalControl)}::text::jsonb) r WHERE c.id=r.id`;
    if (originalJob) await admin`UPDATE jobs j SET requested_version=r.requested_version,processed_version=r.processed_version,cursor=r.cursor,
      locked_at=r.locked_at,lease_token=r.lease_token,not_before=r.not_before,last_error=r.last_error,last_success_at=r.last_success_at,
      last_run_at=r.last_run_at,runs=r.runs,updated_at=r.updated_at
      FROM jsonb_populate_record(NULL::jobs,${JSON.stringify(originalJob)}::text::jsonb) r WHERE j.name=r.name`;
    else await admin`DELETE FROM jobs WHERE name='crawl-agent-review'`;
    if (originalObservation) await admin`UPDATE operations_observations o SET value=r.value,observed_at=r.observed_at
      FROM jsonb_populate_record(NULL::operations_observations,${JSON.stringify(originalObservation)}::text::jsonb) r WHERE o.key=r.key`;
    else await admin`DELETE FROM operations_observations WHERE key='job:crawl-agent-review'`;
  } finally { await admin.end({ timeout: 3 }); }
});

it("claims its own queued request as soon as another call frees the one physical slot, with no expiry or cancellation", async () => {
  const holder = request(), queued = request();
  const held = reservationOf(await ask(holder));
  const first = await ask(queued);
  expect(first).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await state(queued.requestId)).toBe("waiting");
  const seen: Ai1ReservationWaitEvent[] = [];
  const started = Date.now();
  setTimeout(() => { void cancelReservedModelSlot(held); }, 700);
  const result = await awaitQueuedAi1Reservation(queued, Number(queued.workKey.split(":")[1]), first,
    { until: Date.now() + 5_000, observe: event => seen.push(event) });
  expect(result.kind).toBe("granted");
  expect(Date.now() - started).toBeLessThan(700 + 2 * AI1_RESERVATION_POLL_MS + 500);
  expect(seen).toEqual([expect.objectContaining({ granted: true, queued: true, ended: "granted" })]);
  expect(await state(queued.requestId)).toBe("reserved");
  expect(await kinds(queued.requestId)).toEqual(["queued", "reserved"]);
  expect(await kinds(holder.requestId)).toEqual(["queued", "reserved", "reservation_cancelled"]);
  expect(await cancelReservedModelSlot(reservationOf(result))).toBe(true);
});

it("picks up a reservation granted by another caller while it was away, without sleeping first", async () => {
  const holder = request(), away = request(), other = request();
  const held = reservationOf(await ask(holder));
  const first = await ask(away);
  expect(first).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await cancelReservedModelSlot(held)).toBe(true);
  // 다른 호출자의 요청이 grant 를 돌려 줄 맨 앞(away)을 reserved 로 만든다 — 그 호출자 자신은 줄 뒤에 선다
  expect(await ask(other)).toEqual({ kind: "deferred", reason: "capacity" });
  expect(await state(away.requestId)).toBe("reserved");
  const seen: Ai1ReservationWaitEvent[] = [];
  const started = Date.now();
  const result = await awaitQueuedAi1Reservation(away, Number(away.workKey.split(":")[1]), first,
    { until: Date.now() + 5_000, observe: event => seen.push(event) });
  expect(result.kind).toBe("granted");
  expect(Date.now() - started).toBeLessThan(AI1_RESERVATION_POLL_MS);
  expect(seen).toEqual([expect.objectContaining({ polls: 1, ended: "granted" })]);
  expect(await kinds(away.requestId)).toEqual(["queued", "reserved"]);
  expect(await state(other.requestId)).toBe("waiting");
  expect(await cancelReservedModelSlot(reservationOf(result))).toBe(true);
});

it("returns at the start deadline with its row still queued (never cancelled), and skips waiting when a fence left no row", async () => {
  const holder = request(), queued = request();
  reservationOf(await ask(holder));
  const first = await ask(queued);
  const seen: Ai1ReservationWaitEvent[] = [];
  const result = await awaitQueuedAi1Reservation(queued, Number(queued.workKey.split(":")[1]), first,
    { until: Date.now() + 1_200, observe: event => seen.push(event) });
  expect(result).toEqual({ kind: "deferred", reason: "capacity" });
  expect(seen).toEqual([expect.objectContaining({ granted: false, queued: true, ended: "deadline" })]);
  expect(seen[0].polls).toBeLessThanOrEqual(2);
  expect(await state(queued.requestId)).toBe("waiting");
  expect(await kinds(queued.requestId)).toEqual(["queued"]);

  // 같은 후보의 다른 입력(workKey)은 AI1 logical fence 에 막혀 줄에 서지 않는다 — 기다려도 풀리지 않으므로 바로 돌아온다
  const candidateId = Number(queued.workKey.split(":")[1]);
  const fenced = request(candidateId, "b");
  const refused = await ask(fenced);
  expect(refused).toEqual({ kind: "deferred", reason: "capacity" });
  const fenceSeen: Ai1ReservationWaitEvent[] = [];
  const started = Date.now();
  expect(await awaitQueuedAi1Reservation(fenced, candidateId, refused, { until: Date.now() + 5_000, observe: event => fenceSeen.push(event) }))
    .toEqual(refused);
  expect(Date.now() - started).toBeLessThan(AI1_RESERVATION_POLL_MS);
  expect(fenceSeen).toEqual([expect.objectContaining({ queued: false, polls: 0, ended: "not_queued" })]);
  expect(await state(fenced.requestId)).toBeUndefined();
});

it("measures per-model reservation expiry and unused slot time from the ledger in a read-only transaction", async () => {
  const { measureAi1Throughput } = await import("@/scripts/ops/measure-ai1-throughput.mjs");
  const stale = request(), next = request();
  reservationOf(await ask(stale));
  // TTL 이 지난 예약 — 다음 요청의 expireRequests 가 reservation_expired 로 거둔다(떠나 있던 틱이 놓친 예약과 같은 모양)
  await admin`UPDATE model_capacity_requests SET reserved_until=clock_timestamp()-interval '1 second' WHERE request_id=${stale.requestId}::uuid`;
  const granted = reservationOf(await ask(next));
  expect(await kinds(stale.requestId)).toEqual(["queued", "reserved", "reservation_expired"]);
  expect(await cancelReservedModelSlot(granted)).toBe(true);
  const result = await admin.begin("read only", tx => measureAi1Throughput(tx, { windowMinutes: 5, bucketMinutes: 5, backlog: false }));
  const buckets = result.buckets.filter((row: Raw) => row.model === model);
  const sum = (key: string) => buckets.reduce((total: number, row: Raw) => total + Number(row[key]), 0);
  expect([sum("queued"), sum("reserved"), sum("dispatched"), sum("reservation_expired"), sum("reservation_cancelled")]).toEqual([2, 2, 0, 1, 1]);
  const slots = result.slots.find((row: Raw) => row.model === model);
  expect(slots).toMatchObject({ expired: 1, cancelled: 1, used: 0, calls: 0, unusedShare: 1, dispatchesPerHour: 0 });
  expect(slots.expired_s).toBeGreaterThanOrEqual(0);
  expect(result.backlog).toBeNull();
  const withBacklog = await admin.begin("read only", tx => measureAi1Throughput(tx, { windowMinutes: 5, bucketMinutes: 1 }));
  expect(withBacklog.backlog).toEqual({ approved_never_attempted: expect.any(Number) });
  expect(withBacklog.replica).toBe(false);
});

it("runs one job at most once even if two lanes in the same worker pick it at the same time (DB job lease)", async () => {
  await admin`INSERT INTO jobs(name,requested_version,processed_version) VALUES('crawl-agent-review',2,1)
    ON CONFLICT(name) DO UPDATE SET requested_version=2,processed_version=1,locked_at=NULL,lease_token=NULL,not_before=NULL`;
  let entered = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const results: string[] = [];
  const work = runWorker({ role: "reviewer", once: true }, {
    // 줄 구성이 잘못돼 같은 잡이 두 줄에 있어도(실제 카탈로그는 겹치지 않는다 — tests/job-catalog.test.ts) lease 가 막는다
    names: ["crawl-agent-review"], lanes: [["crawl-agent-review"], ["crawl-agent-review"]],
    seen: async () => {}, pending: async () => ["crawl-agent-review"],
    run: async (name, options) => {
      const result = await runJob(name, async () => { entered++; await gate; return { done: true }; }, options);
      results.push(result.status === "skipped" ? `skipped:${result.reason}` : result.status);
      if (results.length === 1) release();
      return result;
    },
  });
  await new Promise(resolve => setTimeout(resolve, 300));
  release();
  expect(await work).toMatchObject({ failures: 0 });
  expect(entered).toBe(1);
  expect(results.sort()).toEqual(["completed", "skipped:locked"]);
  const [job] = await admin`SELECT processed_version, locked_at, lease_token FROM jobs WHERE name='crawl-agent-review'`;
  expect(job).toMatchObject({ processed_version: "2", locked_at: null, lease_token: null });
});
