import { randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { modelCapacityPolicyHash, type ModelCapacityPolicy, type ModelCapacityRequest } from "@/lib/llm/capacity";
import { beginModelDispatch, cancelReservedModelSlot, markModelDispatchIndeterminate, requestModelSlot } from "@/lib/llm/capacity-repository";
import { readModelCapacityDevice, readModelCapacityDeviceStates, saveModelCapacityDevice } from "@/lib/llm/capacity-devices-repository";
import { TEST_DATABASE_URL } from "./setup";

/**
 * 1b-C: 장비별 입장(grantOne·requestSlot)을 실제 장부로 본다 — 자기 DB 를 만들어 끝까지 migrate 한다(공유 test DB 의 장비 행을 남기지 않는다).
 * 정책: 전역 1·풀 1(입장이 읽지 않음을 보인다), 장비 alpha 는 설정 행(우선 primary-route, 낮은 순위 secondary-route, 순위 없는 tertiary-route),
 * beta 는 행 없음(정책 groupLimits 대체는 그 테스트 안에서만 설치), omega 는 행도 대체값도 없다(device_unconfigured).
 */
const name = `nomorevibe_test_device_admission_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {} });
let created = false;
const root = path.resolve(".");
const route = (routeId: string, groupId: string) => ({ routeId, provider: "fixture", model: "m", providerBudgetId: "account", groupId });
const basePolicy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { account: 1 }, poolLimits: { reviewer: 1, text: 1 },
  weights: { first: 1, second: 1, background: 1 }, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [route("primary-route", "alpha"), route("secondary-route", "alpha"), route("tertiary-route", "alpha"), route("beta-route", "beta"), route("omega-route", "omega")] };
const owner = { instanceId: `device-admission-${randomUUID()}`, bootId: randomUUID() };

const request = (routeId: string, overrides: Partial<ModelCapacityRequest> = {}): ModelCapacityRequest => ({ requestId: randomUUID(), workKey: randomUUID(), owner,
  class: "first", pool: "reviewer", routeId, provider: "fixture", model: "m", ...overrides });
async function granted(value: ModelCapacityRequest) {
  const result = await requestModelSlot(value);
  expect(result.kind, `${value.routeId} should be granted`).toBe("granted");
  if (result.kind !== "granted") throw new Error("fixture_not_granted");
  return result.reservation;
}
const deferred = async (value: ModelCapacityRequest, reason: string) => expect(await requestModelSlot(value)).toEqual({ kind: "deferred", reason });
const rows = (states: readonly string[] = ["reserved", "dispatched"]) => client`SELECT route_id, state FROM model_capacity_requests
  WHERE owner_instance_id = ${owner.instanceId} AND state = ANY(${states}::text[]) ORDER BY queue_ordinal`;
const stateOf = async (deviceId: string) => (await readModelCapacityDeviceStates()).find(state => state.deviceId === deviceId);
const control = async () => (await client`SELECT mode, revision::int AS revision, cursor FROM model_capacity_control WHERE id = 1`)[0];
async function installPolicy(value: ModelCapacityPolicy) {
  await client`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(value)}::jsonb, policy_hash = ${modelCapacityPolicyHash(value)},
    revision = revision + 1, cursor = 0, updated_at = clock_timestamp() WHERE id = 1`;
}
type Settings = { limitSlots: number; secondaryCap: number; idleMs: number; reserveSlots: number; roles: { routeId: string; rank: number }[] };
const alphaRoles = [{ routeId: "primary-route", rank: 1 }, { routeId: "secondary-route", rank: 2 }];
async function configure(deviceId: string, settings: Partial<Settings> = {}) {
  const current = await readModelCapacityDevice(deviceId);
  const input = { deviceId, limitSlots: 4, secondaryCap: 1, idleMs: 0, reserveSlots: 0, roles: deviceId === "alpha" ? alphaRoles : [], physicalLimit: null, note: null, ...settings };
  return db.transaction(tx => saveModelCapacityDevice(tx, input, current?.version ?? null, "1b-c-test"));
}

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") });
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
  await installPolicy(basePolicy);
  await configure("alpha");
}, 180_000);
afterAll(async () => {
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  await client.end({ timeout: 3 }); if (created) await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end({ timeout: 3 });
});
// 자기 DB 만 정리한다: event 는 지울 수 없게 잠겨 있으므로(0078 trigger) 이 DB 에서만 잠깐 풀고 이 파일의 행만 지운다.
afterEach(async () => {
  await client.begin(async tx => {
    const mine = tx`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id = ${owner.instanceId} OR owner_instance_id LIKE 'old-generation-%'`;
    await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
    await tx`DELETE FROM model_capacity_events WHERE request_id IN (${mine})`;
    await tx`DELETE FROM model_capacity_requests WHERE owner_instance_id = ${owner.instanceId} OR owner_instance_id LIKE 'old-generation-%'`;
    await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
  });
  await installPolicy(basePolicy);
});

describe("priority and the secondary cap", () => {
  it("gives the freed slot to a rank-1 waiting row before an earlier rank-2 row, one grant per device per pass", async () => {
    await configure("alpha", { limitSlots: 1, secondaryCap: 1 });
    const blocker = await granted(request("secondary-route"));
    const laterSecondary = request("secondary-route"), primary = request("primary-route");
    await deferred(laterSecondary, "capacity");
    await deferred(primary, "capacity");
    expect(await stateOf("alpha")).toMatchObject({ active: 1, waiting: 2, waitingPrimary: 1, primaryBusy: true, secondaryBound: 1 });
    expect(await cancelReservedModelSlot(blocker)).toBe(true);
    // the secondary's own poll runs the pass: the device's one grant goes to the primary (smaller rank), not to the poller
    await deferred(laterSecondary, "capacity");
    expect((await rows()).map(row => row.route_id)).toEqual(["primary-route"]);
    expect((await requestModelSlot(primary)).kind).toBe("granted");
    expect((await control()).cursor).toBe(0);
  });

  it("caps rank>1 occupancy at secondary_cap while the primary is busy and lets the primary ignore the cap", async () => {
    await configure("alpha", { limitSlots: 4, secondaryCap: 1 });
    const primary = await granted(request("primary-route"));
    expect((await beginModelDispatch(primary)).kind).toBe("dispatched");
    await granted(request("secondary-route"));
    await deferred(request("secondary-route"), "capacity");
    await deferred(request("tertiary-route"), "capacity"); // unranked = lowest rank, also secondary occupancy
    await granted(request("primary-route"));
    expect(await stateOf("alpha")).toMatchObject({ active: 3, secondaryActive: 1, primaryBusy: true, secondaryBound: 1, lending: false, waiting: 2, waitingPrimary: 0 });
    expect((await rows()).map(row => row.route_id)).toEqual(["primary-route", "secondary-route", "primary-route"]);
  });
});

describe("lending an idle device and returning it", () => {
  it("lets secondaries fill the whole device while the primary is idle, then stops new secondary admission the moment a primary waits", async () => {
    await configure("alpha", { limitSlots: 4, secondaryCap: 1, idleMs: 0 });
    const secondaries = [];
    for (let i = 0; i < 4; i++) secondaries.push(await granted(request(i % 2 ? "tertiary-route" : "secondary-route")));
    expect(await stateOf("alpha")).toMatchObject({ active: 4, secondaryActive: 4, primaryBusy: false, secondaryBound: 4, lending: true });
    const fifth = request("secondary-route"), primary = request("primary-route");
    await deferred(fifth, "capacity");
    await deferred(primary, "capacity");
    // a waiting primary makes the device busy: bound drops back to the cap, no new secondary starts above it
    expect(await stateOf("alpha")).toMatchObject({ primaryBusy: true, secondaryBound: 1, lending: false, waitingPrimary: 1 });
    expect(await cancelReservedModelSlot(secondaries[0])).toBe(true);
    await deferred(fifth, "capacity");
    expect((await rows()).map(row => row.route_id)).toContain("primary-route");
    expect(await cancelReservedModelSlot(secondaries[1])).toBe(true);
    await deferred(fifth, "capacity"); // secondaryActive 2 >= cap 1 while the primary is reserved
    expect(await stateOf("alpha")).toMatchObject({ active: 3, secondaryActive: 2, primaryBusy: true, secondaryBound: 1 });
  });

  it("keeps reserve_slots free for the primary during lending", async () => {
    await configure("alpha", { limitSlots: 4, secondaryCap: 1, reserveSlots: 1, idleMs: 0 });
    for (let i = 0; i < 3; i++) await granted(request("secondary-route"));
    await deferred(request("secondary-route"), "capacity");
    expect(await stateOf("alpha")).toMatchObject({ active: 3, secondaryActive: 3, secondaryBound: 3, lending: true, primaryBusy: false });
    await granted(request("primary-route"));
    expect(await stateOf("alpha")).toMatchObject({ active: 4, primaryBusy: true });
  });

  it("treats a primary left indeterminate as neither occupancy nor a busy signal, except for its idle_ms recency window", async () => {
    await configure("alpha", { limitSlots: 1, secondaryCap: 0, idleMs: 60_000 });
    const primary = await granted(request("primary-route"));
    const begun = await beginModelDispatch(primary);
    if (begun.kind !== "dispatched") throw new Error("fixture_dispatch");
    expect(await markModelDispatchIndeterminate(begun.dispatch, "transport_unknown")).toBe(true);
    const secondary = request("secondary-route");
    // the unknown row holds no slot, but its fresh updated_at keeps the primary "busy" for idle_ms → cap 0 blocks the secondary
    await deferred(secondary, "capacity");
    expect(await stateOf("alpha")).toMatchObject({ active: 0, primaryBusy: true, secondaryBound: 0 });
    await configure("alpha", { limitSlots: 1, secondaryCap: 0, idleMs: 0 });
    expect((await requestModelSlot(secondary)).kind).toBe("granted");
    expect(await stateOf("alpha")).toMatchObject({ active: 1, secondaryActive: 1, primaryBusy: false, lending: true });
    expect((await rows(["indeterminate"])).map(row => row.route_id)).toEqual(["primary-route"]);
  });
});

describe("settings sources and generations", () => {
  it("defers device_unconfigured without a row or event when neither a device row nor a groupLimits fallback exists, and admits via the fallback when it does", async () => {
    await client`DELETE FROM model_capacity_devices WHERE device_id = 'beta'`;
    const orphan = request("beta-route");
    await deferred(orphan, "device_unconfigured");
    await deferred(request("omega-route"), "device_unconfigured");
    expect(await client`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id = ${owner.instanceId}`).toEqual([]);
    expect(await client`SELECT id FROM model_capacity_events e WHERE e.request_id = ${orphan.requestId}`).toEqual([]);
    await installPolicy({ ...basePolicy, groupLimits: { alpha: 4, beta: 1, omega: 1 } });
    await granted(request("beta-route"));
    await deferred(request("beta-route"), "capacity");
    expect(await stateOf("beta")).toMatchObject({ source: "policy_fallback", limitSlots: 1, secondaryCap: 1, active: 1 });
    expect(await stateOf("alpha")).toMatchObject({ source: "table" });
  });

  it("applies a device edit to the next grant while OPEN — no DRAIN, no policy revision, held rows untouched", async () => {
    await configure("alpha", { limitSlots: 2, secondaryCap: 2 });
    const first = await granted(request("secondary-route")); await granted(request("secondary-route"));
    const before = await control();
    expect(before.mode).toBe("open");
    await configure("alpha", { limitSlots: 1, secondaryCap: 1 });
    const third = request("secondary-route");
    await deferred(third, "capacity");
    expect((await rows()).map(row => row.state)).toEqual(["reserved", "reserved"]);
    expect(await client`SELECT id FROM model_capacity_events WHERE kind = 'policy_changed'`).toEqual([]);
    expect(await control()).toEqual(before);
    await configure("alpha", { limitSlots: 3, secondaryCap: 3 });
    expect((await requestModelSlot(third)).kind).toBe("granted");
    expect(await cancelReservedModelSlot(first)).toBe(true);
  });

  it("still counts held rows of an old generation toward the device and defers new work as policy_changed", async () => {
    await client`INSERT INTO model_capacity_requests (request_id, work_key, owner_instance_id, owner_boot_id, class, pool, route_id, provider, model,
        provider_budget_id, group_id, epoch, revision, policy_hash, state, token, reserved_until, queue_until)
      VALUES (${randomUUID()}, ${randomUUID()}, ${`old-generation-${randomUUID()}`}, ${randomUUID()}, 'first', 'reviewer', 'secondary-route', 'fixture', 'm', 'account',
        'alpha', 1, 1, ${"a".repeat(64)}, 'reserved', ${randomUUID()}, clock_timestamp() + interval '1 hour', clock_timestamp() + interval '1 hour')`;
    await deferred(request("primary-route"), "policy_changed");
    expect(await stateOf("alpha")).toMatchObject({ active: 1, secondaryActive: 1 });
  });

  it("grants on two devices in one pass and ignores the global and pool limits of the policy", async () => {
    await configure("alpha", { limitSlots: 1, secondaryCap: 1 });
    await configure("beta", { limitSlots: 1, secondaryCap: 1 });
    const a1 = await granted(request("primary-route")), b1 = await granted(request("beta-route")); // 2 active > globalLimit 1 = poolLimits.reviewer 1
    const a2 = request("secondary-route"), b2 = request("beta-route");
    await deferred(a2, "capacity"); await deferred(b2, "capacity");
    expect(await cancelReservedModelSlot(a1)).toBe(true); expect(await cancelReservedModelSlot(b1)).toBe(true);
    expect((await requestModelSlot(a2)).kind).toBe("granted");
    expect(await client`SELECT state FROM model_capacity_requests WHERE request_id = ${b2.requestId}`).toEqual([{ state: "reserved" }]);
    await client`DELETE FROM model_capacity_devices WHERE device_id = 'beta'`;
  });

  it("grants exactly one of two concurrent requests on a one-slot device", async () => {
    await configure("alpha", { limitSlots: 1, secondaryCap: 1 });
    const results = await Promise.all([requestModelSlot(request("primary-route")), requestModelSlot(request("primary-route"))]);
    expect(results.filter(result => result.kind === "granted")).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });
});
