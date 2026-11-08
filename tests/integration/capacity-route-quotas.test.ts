import { randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { modelCapacityPolicyHash, type ModelCapacityPolicy, type ModelCapacityRequest } from "@/lib/llm/capacity";
import { cancelReservedModelSlot, requestModelSlot } from "@/lib/llm/capacity-repository";
import { MODEL_CAPACITY_ROUTE_QUOTA_SAVE_AUDIT_ACTION, type ModelCapacityRouteQuota } from "@/lib/llm/capacity-devices";
import { readModelCapacityDevice, readModelCapacityDeviceStates, saveModelCapacityDevice, saveModelCapacityRouteQuotas } from "@/lib/llm/capacity-devices-repository";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { chooseTaskWorkloadMember } from "@/lib/llm/ai-task-workload-selector";
import { taskPoolEngineKey } from "@/lib/llm/ai-task-pool-identity";
import type { AiTaskExecutionConfig, AiTaskPoolMember } from "@/lib/llm/ai-task-execution-config";
import type { AiTaskConnectionSnapshot } from "@/lib/llm/ai-task-models-snapshot";
import { setAiTaskModelsForTest } from "@/lib/llm/ai-task-models-snapshot";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { resolveTextTaskRanks, TextTaskRanks } from "@/lib/llm/ai-task-resolver";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { textContract, textRankRow } from "../text-task-ranks-fixture";
import { TEST_DATABASE_URL } from "./setup";

/**
 * step 2(운영자 결정 2026-11-08): 장비 안 경로별 몫 — 보장(min_slots)·상한(max_slots)·유휴 보장 빌려주기(lend_idle). 실제 장부(requestSlot·grantOne)로 본다.
 * 자기 DB 를 만들어 끝까지 migrate 한다(공유 test DB 의 장비 행·몫을 남기지 않는다).
 * 장비 alpha: primary-route(rank 1)·secondary-route(rank 2)·tertiary-route(순위 없음), beta: beta-route. 둘 다 작업 풀 시험용 product-search-profile 경로를 하나씩 둔다.
 */
const name = `nomorevibe_test_route_quotas_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {} });
let created = false;
const root = path.resolve(".");
const route = (routeId: string, groupId: string, provider = "fixture", model = "m") => ({ routeId, provider, model, providerBudgetId: "account", groupId });
const basePolicy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { account: 1 }, poolLimits: { reviewer: 1, text: 1 },
  weights: { first: 1, second: 1, background: 1 }, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [route("primary-route", "alpha"), route("secondary-route", "alpha"), route("tertiary-route", "alpha"), route("beta-route", "beta"),
    route("product-search-profile", "alpha", "abcllm", "m-alpha"), route("product-search-profile", "beta", "abcllm", "m-beta")] };
const owner = { instanceId: `route-quotas-${randomUUID()}`, bootId: randomUUID() };

const request = (routeId: string, overrides: Partial<ModelCapacityRequest> = {}): ModelCapacityRequest => ({ requestId: randomUUID(), workKey: randomUUID(), owner,
  class: "first", pool: "reviewer", routeId, provider: "fixture", model: "m", ...overrides });
async function granted(value: ModelCapacityRequest) {
  const result = await requestModelSlot(value);
  expect(result.kind, `${value.routeId} should be granted`).toBe("granted");
  if (result.kind !== "granted") throw new Error("fixture_not_granted");
  return result.reservation;
}
const deferred = async (value: ModelCapacityRequest, reason: string) => expect(await requestModelSlot(value), value.routeId).toEqual({ kind: "deferred", reason });
const live = () => client`SELECT route_id, state FROM model_capacity_requests
  WHERE owner_instance_id = ${owner.instanceId} AND state IN ('waiting','reserved','dispatched') ORDER BY queue_ordinal`;
const rowOf = async (requestId: string) => (await client`SELECT state FROM model_capacity_requests WHERE request_id = ${requestId}`)[0]?.state ?? null;
const eventsOf = async (requestId: string) => (await client`SELECT kind FROM model_capacity_events WHERE request_id = ${requestId} ORDER BY id`).map(row => row.kind);
const stateOf = async (deviceId: string) => (await readModelCapacityDeviceStates()).find(state => state.deviceId === deviceId);
const routeOf = async (deviceId: string, routeId: string) => (await stateOf(deviceId))?.routes?.find(row => row.routeId === routeId);
async function installPolicy(value: ModelCapacityPolicy) {
  await client`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(value)}::jsonb, policy_hash = ${modelCapacityPolicyHash(value)},
    revision = revision + 1, cursor = 0, updated_at = clock_timestamp() WHERE id = 1`;
}
type Settings = { limitSlots: number; secondaryCap: number; idleMs: number; reserveSlots: number; roles: { routeId: string; rank: number }[] };
const alphaRoles = [{ routeId: "primary-route", rank: 1 }, { routeId: "secondary-route", rank: 2 }];
async function configure(deviceId: string, settings: Partial<Settings> = {}) {
  const current = await readModelCapacityDevice(deviceId);
  const input = { deviceId, limitSlots: 4, secondaryCap: 4, idleMs: 0, reserveSlots: 0, roles: deviceId === "alpha" ? alphaRoles : [], physicalLimit: null, note: null, ...settings };
  return db.transaction(tx => saveModelCapacityDevice(tx, input, current?.version ?? null, "route-quota-test"));
}
async function setQuotas(deviceId: string, lendIdle: boolean, quotas: ModelCapacityRouteQuota[], actor = "route-quota-test") {
  const current = await readModelCapacityDevice(deviceId);
  return db.transaction(tx => saveModelCapacityRouteQuotas(tx, { deviceId, expectedVersion: current!.version, lendIdle, quotas }, actor));
}
const quota = (routeId: string, minSlots: number, maxSlots: number | null): ModelCapacityRouteQuota => ({ routeId, minSlots, maxSlots });
async function clearLedger() {
  await client.begin(async tx => {
    const mine = tx`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id = ${owner.instanceId}`;
    await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_events WHERE request_id IN (${mine})`;
    await tx`DELETE FROM model_capacity_requests WHERE owner_instance_id = ${owner.instanceId}`;
    await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
  });
}

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") });
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
  await installPolicy(basePolicy);
  await configure("alpha");
  await configure("beta", { limitSlots: 2, secondaryCap: 2 });
}, 180_000);
afterAll(async () => {
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  setAiTaskModelsForTest(null); setServingContractSnapshotForTest(null);
  await client.end({ timeout: 3 }); if (created) await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end({ timeout: 3 });
});
// 한 시험이 바꾼 장부·몫·장비 설정·정책을 되돌린다(장비 설정은 기본값으로 다시 저장 — version 만 오른다)
afterEach(async () => {
  await clearLedger();
  await client`UPDATE model_capacity_devices SET route_quotas = '[]'::jsonb, lend_idle = true, enabled = true`;
  await installPolicy(basePolicy);
  await configure("alpha");
  await configure("beta", { limitSlots: 2, secondaryCap: 2 });
  setAiTaskModelsForTest(null); setServingContractSnapshotForTest(null);
});

describe("migration 0169", () => {
  it("adds lend_idle (default true) and an empty route_quotas list to existing and new device rows", async () => {
    expect(await client`SELECT device_id, lend_idle, route_quotas FROM model_capacity_devices ORDER BY device_id`)
      .toEqual([{ device_id: "alpha", lend_idle: true, route_quotas: [] }, { device_id: "beta", lend_idle: true, route_quotas: [] }]);
    expect(await readModelCapacityDevice("alpha")).toMatchObject({ lendIdle: true, routeQuotas: [] });
  });

  it("the DB refuses quota JSON the save refuses — shape, duplicates, min > max, max or guarantee sum above the device limit", async () => {
    const write = (value: unknown) => client`UPDATE model_capacity_devices SET route_quotas = ${JSON.stringify(value)}::jsonb WHERE device_id = 'alpha'`;
    const line = (routeId: string, min: unknown, max: unknown) => ({ route_id: routeId, min_slots: min, max_slots: max });
    await expect(write([line("a", 1, 2), line("b", 3, null)])).resolves.toBeDefined(); // Σmin 4 = limit 4
    for (const bad of [{}, [line("a", 5, null)], [line("a", 3, 2)], [line("a", 1, 5)], [line("a", 3, null), line("b", 2, null)], [line("a", 1, 1), line("a", 0, null)],
      [line(" a", 0, 1)], [line("a", -1, null)], [line("a", 1.5, null)], [line("a", "1", null)], [{ ...line("a", 0, 1), extra: true }], [{ route_id: "a", min_slots: 0 }]])
      await expect(write(bad), JSON.stringify(bad)).rejects.toThrow(/model_capacity_devices_route_quotas_check/);
    await client`UPDATE model_capacity_devices SET route_quotas = '[]'::jsonb WHERE device_id = 'alpha'`;
  });
});

describe("no quota lines = today's admission", () => {
  it("grants the identical sequence with an empty quota list and with no-op lines (no guarantee, no cap)", async () => {
    await configure("alpha", { limitSlots: 2, secondaryCap: 1 });
    const scenario = async () => {
      const outcomes: string[] = [];
      for (const routeId of ["secondary-route", "primary-route", "secondary-route", "tertiary-route", "primary-route"]) {
        const result = await requestModelSlot(request(routeId));
        outcomes.push(result.kind === "granted" ? "granted" : result.reason);
      }
      return { outcomes, rows: (await live()).map(row => `${row.route_id}:${row.state}`) };
    };
    const baseline = await scenario();
    expect(baseline).toEqual({ outcomes: ["granted", "granted", "capacity", "capacity", "capacity"],
      rows: ["secondary-route:reserved", "primary-route:reserved", "secondary-route:waiting", "tertiary-route:waiting", "primary-route:waiting"] });
    await clearLedger();
    await setQuotas("alpha", true, [quota("primary-route", 0, null), quota("secondary-route", 0, null), quota("tertiary-route", 0, null)]);
    expect(await scenario()).toEqual(baseline);
    await clearLedger();
    await setQuotas("alpha", false, [quota("primary-route", 0, null), quota("secondary-route", 0, null)]);
    expect(await scenario()).toEqual(baseline);
  });
});

describe("cap (max_slots)", () => {
  it("refuses a route at its cap as route_quota without a waiting row or event, and still grants other routes on the device", async () => {
    await setQuotas("alpha", true, [quota("tertiary-route", 0, 1)]);
    await granted(request("tertiary-route"));
    const capped = request("tertiary-route");
    await deferred(capped, "route_quota");
    expect(await rowOf(capped.requestId)).toBeNull();
    expect(await eventsOf(capped.requestId)).toEqual([]);
    await granted(request("primary-route"));
    await granted(request("secondary-route"));
    expect(await routeOf("alpha", "tertiary-route")).toEqual({ routeId: "tertiary-route", active: 1, waiting: 0, minSlots: 0, maxSlots: 1, cap: 1, demand: true, held: 0 });
    expect((await stateOf("alpha"))?.lendIdle).toBe(true);
  });

  it("max_slots 0 takes the route off the device even when it is empty; the other device and routes are untouched", async () => {
    await setQuotas("alpha", true, [quota("tertiary-route", 0, 0)]);
    const off = request("tertiary-route");
    await deferred(off, "route_quota");
    expect(await rowOf(off.requestId)).toBeNull();
    expect(await stateOf("alpha")).toMatchObject({ active: 0, waiting: 0 });
    await granted(request("secondary-route"));
    await granted(request("beta-route"));
  });

  it("counts earlier waiting rows toward the cap and withdraws an own waiting row once the cap is spoken for", async () => {
    await configure("alpha", { limitSlots: 1, secondaryCap: 1 });
    const blocker = await granted(request("primary-route"));
    const first = request("tertiary-route"), second = request("tertiary-route");
    await deferred(first, "capacity"); await deferred(second, "capacity"); // no quota yet: both queue behind the full device
    await setQuotas("alpha", true, [quota("tertiary-route", 0, 1)]);
    await deferred(second, "route_quota");            // first is ahead: 0 active + 1 ahead ≥ cap 1 → its own waiting row is withdrawn
    expect(await rowOf(second.requestId)).toBe("withdrawn");
    expect(await eventsOf(second.requestId)).toEqual(["queued", "wait_cancelled"]);
    await deferred(first, "capacity");                 // first keeps its place
    const third = request("tertiary-route");
    await deferred(third, "route_quota");              // a new request behind first never queues
    expect(await rowOf(third.requestId)).toBeNull();
    expect(await cancelReservedModelSlot(blocker)).toBe(true);
    expect((await requestModelSlot(first)).kind).toBe("granted");
    expect(await routeOf("alpha", "tertiary-route")).toMatchObject({ active: 1, waiting: 0, cap: 1 });
  });
});

describe("guarantee (min_slots) with lending on", () => {
  it("lends an idle guarantee, then gives the next free slot to the route under its guarantee ahead of an earlier rank-1 waiter", async () => {
    await configure("alpha", { limitSlots: 3, secondaryCap: 3, idleMs: 0 });
    await setQuotas("alpha", true, [quota("tertiary-route", 1, null)]);
    const primaries = [await granted(request("primary-route")), await granted(request("primary-route")), await granted(request("primary-route"))];
    expect(await routeOf("alpha", "tertiary-route")).toMatchObject({ active: 0, waiting: 0, demand: false, held: 0 }); // idle guarantee: lent out
    const laterPrimary = request("primary-route"), tertiary = request("tertiary-route");
    await deferred(laterPrimary, "capacity");
    await deferred(tertiary, "capacity");
    expect(await routeOf("alpha", "tertiary-route")).toMatchObject({ active: 0, waiting: 1, demand: true, held: 1 });
    expect(await cancelReservedModelSlot(primaries[0])).toBe(true);
    // the earlier rank-1 waiter's own poll runs the pass, but the only free slot is the tertiary's unmet guarantee
    await deferred(laterPrimary, "capacity");
    expect(await rowOf(tertiary.requestId)).toBe("reserved");
    expect((await requestModelSlot(tertiary)).kind).toBe("granted");
    // guarantee met: the route is no longer held for, and a second tertiary request waits like any other route
    expect(await routeOf("alpha", "tertiary-route")).toMatchObject({ active: 1, held: 0 });
    await deferred(request("tertiary-route"), "capacity");
  });

  it("lets a route under its guarantee pass the secondary cap like rank 1; above its guarantee the cap applies again", async () => {
    await configure("alpha", { limitSlots: 4, secondaryCap: 0, idleMs: 0 });
    await granted(request("primary-route"));                    // primary busy → rank > 1 bound = secondary_cap 0
    const first = request("secondary-route");
    await deferred(first, "capacity");                          // today's rule
    await setQuotas("alpha", true, [quota("secondary-route", 1, null)]);
    expect((await requestModelSlot(first)).kind).toBe("granted"); // under its guarantee
    await deferred(request("secondary-route"), "capacity");     // 1 active = guarantee: secondary_cap 0 binds again
    expect(await stateOf("alpha")).toMatchObject({ active: 2, secondaryActive: 1, primaryBusy: true, secondaryBound: 0 });
  });

  it("keeps a guarantee free for idle_ms after the route's last activity, and lends it at once with idle_ms 0 (device save keeps the quota)", async () => {
    await configure("alpha", { limitSlots: 2, secondaryCap: 2, idleMs: 60_000 });
    await setQuotas("alpha", true, [quota("tertiary-route", 1, null)]);
    expect(await cancelReservedModelSlot(await granted(request("tertiary-route")))).toBe(true); // withdrawn just now: recent demand
    await granted(request("primary-route"));
    const waiting = request("primary-route");
    await deferred(waiting, "capacity");                        // 1 active + tertiary held 1 = 2 = limit
    expect(await routeOf("alpha", "tertiary-route")).toMatchObject({ active: 0, waiting: 0, demand: true, held: 1 });
    await configure("alpha", { limitSlots: 2, secondaryCap: 2, idleMs: 0 });
    expect((await readModelCapacityDevice("alpha"))?.routeQuotas).toEqual([quota("tertiary-route", 1, null)]);
    expect((await requestModelSlot(waiting)).kind).toBe("granted");
  });
});

describe("lending off (strict partition)", () => {
  it("caps a quota route at its guarantee and keeps every guarantee free even while idle", async () => {
    await setQuotas("alpha", false, [quota("tertiary-route", 1, 3), quota("secondary-route", 1, null)]);
    await granted(request("primary-route")); await granted(request("primary-route"));
    await deferred(request("primary-route"), "capacity");     // 2 active + held 1 + 1 = 4: both idle guarantees stay free
    await granted(request("tertiary-route"));                 // inside its guarantee
    await deferred(request("tertiary-route"), "route_quota"); // lending off: cap = guarantee 1, not max 3
    await granted(request("secondary-route"));
    expect(await stateOf("alpha")).toMatchObject({ lendIdle: false, active: 4 });
    expect(await routeOf("alpha", "tertiary-route")).toMatchObject({ cap: 1, active: 1, held: 0 });
  });
});

describe("saveModelCapacityRouteQuotas", () => {
  const audits = async (floor: number) => client`SELECT actor, action, target, detail FROM operations_audit
    WHERE id > ${floor} AND action = ${MODEL_CAPACITY_ROUTE_QUOTA_SAVE_AUDIT_ACTION} ORDER BY id`;
  const auditFloor = async () => Number((await client`SELECT coalesce(max(id), 0)::int AS id FROM operations_audit`)[0].id);
  const save = (input: unknown, actor = "jr") => db.transaction(tx => saveModelCapacityRouteQuotas(tx, input, actor));

  it("compare-and-sets the device version, replaces the lines, audits once and warns on a route the policy does not send to the device", async () => {
    const floor = await auditFloor();
    const before = (await readModelCapacityDevice("alpha"))!;
    const result = await save({ deviceId: "alpha", expectedVersion: before.version, lendIdle: false,
      quotas: [quota("tertiary-route", 1, 2), quota("beta-route", 0, 1), quota("primary-route", 2, null)] });
    expect(result.warnings).toEqual(["route_unmapped:beta-route"]);
    expect(result.before).toEqual({ lendIdle: true, quotas: [] });
    expect(result.after).toMatchObject({ version: before.version + 1, lendIdle: false, updatedBy: "jr",
      routeQuotas: [quota("beta-route", 0, 1), quota("primary-route", 2, null), quota("tertiary-route", 1, 2)] });
    expect((await client`SELECT route_quotas FROM model_capacity_devices WHERE device_id = 'alpha'`)[0].route_quotas).toEqual([
      { route_id: "beta-route", min_slots: 0, max_slots: 1 }, { route_id: "primary-route", min_slots: 2, max_slots: null },
      { route_id: "tertiary-route", min_slots: 1, max_slots: 2 }]);
    const rows = await audits(floor);
    expect(rows.map(row => [row.actor, row.action, row.target])).toEqual([["jr", MODEL_CAPACITY_ROUTE_QUOTA_SAVE_AUDIT_ACTION, "alpha"]]);
    expect(rows[0].detail).toMatchObject({ version: before.version + 1, expectedVersion: before.version, limitSlots: 4, warnings: ["route_unmapped:beta-route"],
      before: { lendIdle: true, quotas: [] }, after: { lendIdle: false, quotas: expect.arrayContaining([{ routeId: "primary-route", minSlots: 2, maxSlots: null, cap: 2 }]) } });
    // the stale form is refused without touching the row or the audit
    const stale = save({ deviceId: "alpha", expectedVersion: before.version, lendIdle: true, quotas: [] });
    await expect(stale).rejects.toThrow(`model_capacity_route_quota_version_mismatch:${before.version + 1}`);
    expect((await readModelCapacityDevice("alpha"))).toMatchObject({ version: before.version + 1, lendIdle: false });
    expect(await audits(floor)).toHaveLength(1);
  });

  it("refuses bad input, limits the locked device row cannot hold, an unknown or disabled device and a bad actor — nothing written", async () => {
    const floor = await auditFloor();
    const current = (await readModelCapacityDevice("alpha"))!;
    const base = { deviceId: "alpha", expectedVersion: current.version, lendIdle: true };
    const refused: [unknown, string][] = [
      [{ ...base, quotas: [quota("a", 3, null), quota("b", 2, null)] }, "model_capacity_route_quota_invalid:quotas:min_sum_exceeds_limit"],
      [{ ...base, quotas: [quota("a", 0, 5)] }, "model_capacity_route_quota_invalid:quotas.0.maxSlots:exceeds_limit"],
      [{ ...base, quotas: [quota("a", 5, null)] }, "model_capacity_route_quota_invalid:quotas.0.minSlots:exceeds_limit"],
      [{ ...base, quotas: [quota("a", 2, 1)] }, "model_capacity_route_quota_invalid:quotas.0.maxSlots:min_exceeds_max"],
      [{ ...base, quotas: [quota("a", 0, 1), quota("a", 0, 2)] }, "model_capacity_route_quota_invalid:quotas:duplicate_route"],
      [{ ...base, quotas: [quota(" a", 0, 1)] }, "model_capacity_route_quota_invalid:quotas.0.routeId"],
      [{ ...base, quotas: [{ routeId: "a", minSlots: 0 }] }, "model_capacity_route_quota_invalid:quotas.0.maxSlots"],
      [{ ...base, quotas: [], extra: 1 }, "model_capacity_route_quota_invalid:root"],
      [{ ...base, expectedVersion: 0, quotas: [] }, "model_capacity_route_quota_invalid:expectedVersion"],
      [{ ...base, deviceId: "nowhere", quotas: [] }, "model_capacity_route_quota_device_unconfigured"],
    ];
    for (const [input, code] of refused) await expect(save(input), code).rejects.toThrow(code);
    await expect(save({ ...base, quotas: [] }, " ")).rejects.toThrow("model_capacity_route_quota_invalid:actor");
    await client`UPDATE model_capacity_devices SET enabled = false WHERE device_id = 'beta'`;
    const beta = (await readModelCapacityDevice("beta"))!;
    await expect(save({ deviceId: "beta", expectedVersion: beta.version, lendIdle: true, quotas: [] })).rejects.toThrow("model_capacity_route_quota_device_unconfigured");
    await client`UPDATE model_capacity_devices SET enabled = true WHERE device_id = 'beta'`;
    expect(await readModelCapacityDevice("alpha")).toMatchObject({ version: current.version, routeQuotas: [], lendIdle: true });
    expect(await audits(floor)).toEqual([]);
  });

  it("a device save keeps the quota lines and cannot lower the limit below the guarantees or a cap", async () => {
    await setQuotas("alpha", true, [quota("tertiary-route", 2, 3)]);
    await expect(configure("alpha", { limitSlots: 2, secondaryCap: 2 })).rejects.toThrow("model_capacity_device_invalid:route_quotas_exceed_limit");
    await expect(configure("alpha", { limitSlots: 1, secondaryCap: 1 })).rejects.toThrow("model_capacity_device_invalid:route_quotas_exceed_limit");
    const saved = await configure("alpha", { limitSlots: 3, secondaryCap: 3 });
    expect(saved.after).toMatchObject({ limitSlots: 3, routeQuotas: [quota("tertiary-route", 2, 3)], lendIdle: true });
  });
});

describe("work-pool selector hint", () => {
  const connection = (deviceId: string): AiTaskConnectionSnapshot => Object.freeze({ id: deviceId === "alpha" ? "0b0c0d0e-0000-4000-8000-0000000000a1" : "0b0c0d0e-0000-4000-8000-0000000000b1",
    label: deviceId, kind: "api" as const, baseUrl: `http://${deviceId}.test:8000/v1`, cliTool: null, deviceId, enabled: true, models: null, contextTokens: null,
    apiKey: null, keyUnreadable: false });
  const member = (deviceId: string, position: number): AiTaskPoolMember => {
    const conn = connection(deviceId), model = `m-${deviceId}`;
    return Object.freeze({ memberId: deviceId === "alpha" ? "0b0c0d0e-0000-4000-8000-00000000a0a0" : "0b0c0d0e-0000-4000-8000-00000000b0b0",
      position, connectionId: conn.id, model, options: {}, canonicalModel: model, deviceId, engineKey: taskPoolEngineKey(conn, model), connection: conn });
  };
  const members = [member("alpha", 1), member("beta", 2)];
  const config: AiTaskExecutionConfig = Object.freeze({ task: "product-search-profile", slot: 1, mode: "workload_pool", revision: 7, updatedAt: null, members });
  const candidates = members.map(row => ({ memberId: row.memberId, routeId: "product-search-profile", connectionId: row.connectionId, engineModel: row.model,
    provider: "abcllm", identity: row.model, deviceId: row.deviceId }));
  const choose = () => db.transaction(tx => chooseTaskWorkloadMember(config, candidates, { executor: tx as unknown as ProductTransaction }));

  it("skips a member whose route is at its cap or whose device must keep other routes' guarantees free; null when none fits", async () => {
    await granted(request("beta-route"));                                    // beta busier: alpha wins on pressure without quotas
    expect((await choose())?.deviceId).toBe("alpha");
    await setQuotas("alpha", true, [quota("product-search-profile", 0, 0)]);
    expect((await choose())?.deviceId).toBe("beta");
    await setQuotas("alpha", true, []);
    await configure("alpha", { limitSlots: 1, secondaryCap: 1 });
    await setQuotas("alpha", false, [quota("primary-route", 1, null)]);       // strict: primary's idle guarantee is the only slot
    expect((await choose())?.deviceId).toBe("beta");
    await setQuotas("beta", true, [quota("product-search-profile", 0, 0)]);
    expect(await choose()).toBeNull();
  });
});

describe("rank fallback on route_quota", () => {
  const SECOND = "0b0c0d0e-0000-4000-8000-0000000000aa", SECOND_BASE = "http://second.test:8000/v1";
  const twoRanks = () => {
    setServingContractSnapshotForTest([textContract("product-search-profile", "gpt-oss-120b"),
      textContract("product-search-profile", "qwen3.6-35b", { baseUrl: SECOND_BASE })]);
    setAiTaskModelsForTest([textRankRow("product-search-profile", "gpt-oss-120b"),
      textRankRow("product-search-profile", "qwen3.6-35b", { rank: 2, connectionId: SECOND, baseUrl: SECOND_BASE, label: "second" })]);
    return new TextTaskRanks(resolveTextTaskRanks("product-search-profile"));
  };
  // rank 1 asks the ledger for alpha's tertiary route, rank 2 for beta's route — the deferral comes from the real admission TX
  const work = async (binding: { rank: number }) => {
    const slot = await requestModelSlot(request(binding.rank === 1 ? "tertiary-route" : "beta-route"));
    if (slot.kind !== "granted") throw new ModelCapacityDeferredError(slot.reason);
    return binding.rank;
  };

  it("hands the same work to rank 2 when rank 1's route is at its cap, and reports saturation (not unusable ranks) when every rank is capped", async () => {
    await setQuotas("alpha", true, [quota("tertiary-route", 0, 0)]);
    const ranks = twoRanks();
    expect(await ranks.run(work)).toMatchObject({ kind: "served", value: 2, binding: { rank: 2 } });
    expect(ranks.summary()).toEqual({ ranks: 2, "served.2": 1, "unusable.1.route_quota": 1 });
    await setQuotas("beta", true, [quota("beta-route", 0, 1)]);
    const capped = twoRanks();
    expect(await capped.run(work)).toEqual({ kind: "unusable" });
    expect(capped.saturated()).toBe(true);                                    // jobs defer model_capacity and retry, like a full device
    expect(capped.degraded().detail).toContain("몫");
    expect((await live()).map(row => `${row.route_id}:${row.state}`)).toEqual(["beta-route:reserved"]); // no waiting row anywhere
  });
});
