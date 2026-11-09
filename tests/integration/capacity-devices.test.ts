import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { deviceCandidateSql, MODEL_CAPACITY_DEVICE_SAVE_AUDIT_ACTION, type ModelCapacityGeneration } from "@/lib/llm/capacity-devices";
import { listModelCapacityDevices, readModelCapacityDevice, readModelCapacityDeviceStates, saveModelCapacityDevice } from "@/lib/llm/capacity-devices-repository";
import { TEST_DATABASE_URL } from "./setup";

/**
 * 1b-A: 자기 DB 를 만들어 0152 까지 올린 뒤 정책(groupLimits)을 두고 0153 을 적용한다 — seed 가 실제 정책에서 나오는지 본다.
 * 입장(grantOne·requestSlot)은 1b-C 의 것이라 여기서는 deviceCandidateSql 을 직접 실행해 조건만 확인한다.
 */
const name = `nomorevibe_test_devices_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 3, prepare: false, onnotice: () => {} });
let created = false;
const root = path.resolve(".");
// 유효한 정책(hash 는 이것으로). seed 필터와 미설정 장비를 보기 위해 저장된 JSON 에만 오늘의 zod 가 거절할 것(huge: 999, 공백 키, groupLimits 에 없는
// omega 장비의 route — 1b-C 가 groupLimits 를 선택으로 바꾸면 유효해진다)을 덧붙인다 — 0153 과 상태 읽기는 JSON 만 읽는다.
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { account: 4 }, groupLimits: { alpha: 2, beta: 1 },
  poolLimits: { reviewer: 4, text: 4 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 32, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "primary-route", provider: "fixture", model: "m", providerBudgetId: "account", groupId: "alpha" },
    { routeId: "secondary-route", provider: "fixture", model: "m", providerBudgetId: "account", groupId: "alpha" },
    { routeId: "beta-route", provider: "fixture", model: "m", providerBudgetId: "account", groupId: "beta" }] };
const hash = modelCapacityPolicyHash(policy);
const storedPolicy = { ...policy, groupLimits: { ...policy.groupLimits, huge: 999, " spaced": 1 },
  routes: [...policy.routes, { routeId: "omega-route", provider: "fixture", model: "m", providerBudgetId: "account", groupId: "omega" }] };
const generation: ModelCapacityGeneration = { epoch: 1, revision: 3, policyHash: hash };
const owner = { instanceId: `devices-${randomUUID()}`, bootId: randomUUID() };

async function migrateUpTo(idx: number) {
  const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  const partial = mkdtempSync(path.join(tmpdir(), "nmv-devices-pre0153-"));
  try {
    mkdirSync(path.join(partial, "meta"));
    const entries = journal.entries.filter(entry => entry.idx < idx);
    for (const entry of entries) copyFileSync(path.join(root, "drizzle", `${entry.tag}.sql`), path.join(partial, `${entry.tag}.sql`));
    writeFileSync(path.join(partial, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    await migrate(drizzle(client), { migrationsFolder: partial });
  } finally { rmSync(partial, { recursive: true, force: true }); }
}

type Fixture = { routeId: string; state: "waiting" | "reserved" | "dispatched" | "indeterminate" | "withdrawn"; groupId?: string;
  updatedAgoMs?: number; generation?: ModelCapacityGeneration; queueUntilMs?: number };
async function insertRequest(fixture: Fixture): Promise<string> {
  const id = randomUUID(), gen = fixture.generation ?? generation, held = fixture.state !== "waiting" && fixture.state !== "withdrawn";
  await client`INSERT INTO model_capacity_requests (request_id, work_key, owner_instance_id, owner_boot_id, class, pool, route_id, provider, model,
      provider_budget_id, group_id, epoch, revision, policy_hash, state, token, reserved_until, queue_until, updated_at)
    VALUES (${id}, ${`work-${id}`}, ${owner.instanceId}, ${owner.bootId}, 'first', 'reviewer', ${fixture.routeId}, 'fixture', 'm', 'account',
      ${fixture.groupId ?? "alpha"}, ${gen.epoch}, ${gen.revision}, ${gen.policyHash}, ${fixture.state},
      ${held ? randomUUID() : null}, ${held ? client`clock_timestamp() + interval '1 minute'` : null},
      clock_timestamp() + ${fixture.queueUntilMs ?? 60_000} * interval '1 millisecond',
      clock_timestamp() - ${fixture.updatedAgoMs ?? 0} * interval '1 millisecond')`;
  return id;
}
const clearRequests = () => client`DELETE FROM model_capacity_requests WHERE owner_instance_id = ${owner.instanceId}`;
const candidate = (deviceId: string) => db.transaction(async tx => {
  const rows = await tx.execute<{ request_id: string }>(deviceCandidateSql(deviceId, generation, JSON.stringify(storedPolicy.groupLimits)));
  return rows[0]?.request_id ?? null;
});
const save = (input: unknown, expectedVersion: number | null, actor = "jr") => db.transaction(tx => saveModelCapacityDevice(tx, input, expectedVersion, actor));
const stateOf = async (deviceId: string) => (await readModelCapacityDeviceStates()).find(state => state.deviceId === deviceId);

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
  await migrateUpTo(153);
  await client`UPDATE model_capacity_control SET mode = 'draining', epoch = 1, revision = 3, policy = ${JSON.stringify(storedPolicy)}::jsonb, policy_hash = ${hash} WHERE id = 1`;
  await migrate(drizzle(client), { migrationsFolder: path.join(root, "drizzle") });
  const globals = globalThis as { db?: unknown; pgClient?: unknown }; globals.db = drizzle(client, { schema }); globals.pgClient = client;
}, 180_000);
afterAll(async () => {
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  await client.end({ timeout: 3 }); if (created) await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end({ timeout: 3 });
});
// 한 테스트가 중간에 실패해도 다음 테스트가 그 장부 행을 보지 않는다
afterEach(async () => { await clearRequests(); });

describe("migration 0153", () => {
  it("seeds one row per valid groupLimits key with cap = limit, idle 60000, reserve 0 and no rank rows", async () => {
    const rows = await listModelCapacityDevices();
    expect(rows.map(row => [row.deviceId, row.limitSlots, row.secondaryCap, row.idleMs, row.reserveSlots, row.physicalLimit, row.enabled, row.version, row.updatedBy, row.roles]))
      .toEqual([["alpha", 2, 2, 60_000, 0, null, true, 1, "migration:0153", []], ["beta", 1, 1, 60_000, 0, null, true, 1, "migration:0153", []]]);
    expect(rows[0].note).toBe("seeded from capacity policy groupLimits (epoch 1 revision 3)");
    expect(rows.find(row => row.deviceId === "huge")).toBeUndefined();
    expect(rows.find(row => row.deviceId.trim() === "spaced")).toBeUndefined();
    const [count] = await client`SELECT count(*)::int AS n FROM model_capacity_device_roles`;
    expect(count.n).toBe(0);
  });

  it("the DB refuses rows the schema refuses: limits, reserve, idle, physical, identity, rank, orphan role, version", async () => {
    const insert = (overrides: Record<string, unknown>) => client`INSERT INTO model_capacity_devices ${client({ device_id: `bad-${randomUUID()}`, limit_slots: 2,
      secondary_cap: 1, idle_ms: 60000, reserve_slots: 0, updated_by: "jr", ...overrides })}`;
    await expect(insert({})).resolves.toBeDefined();
    await expect(insert({ limit_slots: 0 })).rejects.toThrow(/model_capacity_devices_limits_check/);
    await expect(insert({ limit_slots: 257 })).rejects.toThrow(/model_capacity_devices_limits_check/);
    await expect(insert({ secondary_cap: 3 })).rejects.toThrow(/model_capacity_devices_limits_check/);
    await expect(insert({ reserve_slots: 2 })).rejects.toThrow(/model_capacity_devices_limits_check/);
    await expect(insert({ idle_ms: 3_600_001 })).rejects.toThrow(/model_capacity_devices_limits_check/);
    await expect(insert({ physical_limit: 1 })).rejects.toThrow(/model_capacity_devices_physical_check/);
    await expect(insert({ physical_limit: 0 })).rejects.toThrow(/model_capacity_devices_physical_check/);
    await expect(insert({ device_id: " padded" })).rejects.toThrow(/model_capacity_devices_id_check/);
    await expect(insert({ device_id: "ctl\u0001" })).rejects.toThrow(/model_capacity_devices_id_check/);
    await expect(insert({ version: 0 })).rejects.toThrow(/model_capacity_devices_version_check/);
    await expect(client`INSERT INTO model_capacity_device_roles (device_id, route_id, role_rank) VALUES ('alpha', 'r', 65)`).rejects.toThrow(/model_capacity_device_roles_rank_check/);
    await expect(client`INSERT INTO model_capacity_device_roles (device_id, route_id, role_rank) VALUES ('alpha', ' r', 1)`).rejects.toThrow(/model_capacity_device_roles_route_check/);
    await expect(client`INSERT INTO model_capacity_device_roles (device_id, route_id, role_rank) VALUES ('no-such-device', 'r', 1)`).rejects.toThrow(/model_capacity_device_roles_device_fk/);
    await client`DELETE FROM model_capacity_devices WHERE device_id LIKE 'bad-%'`;
  });
});

describe("saveModelCapacityDevice", () => {
  it("creates, bumps version on every save, replaces the rank rows and audits once per save", async () => {
    const [floor] = await client`SELECT coalesce(max(id), 0)::int AS id FROM operations_audit`;
    const first = await save({ deviceId: "gamma", limitSlots: 4, secondaryCap: 1, idleMs: 0, reserveSlots: 1, physicalLimit: 4,
      roles: [{ routeId: "g-two", rank: 2 }, { routeId: "g-one", rank: 1 }], note: "first" }, null);
    expect(first.before).toBeNull();
    expect(first.after).toMatchObject({ deviceId: "gamma", version: 1, enabled: true, updatedBy: "jr", note: "first",
      roles: [{ routeId: "g-one", rank: 1 }, { routeId: "g-two", rank: 2 }] });
    const second = await save({ deviceId: "gamma", limitSlots: 3, secondaryCap: 2, idleMs: 5_000, reserveSlots: 0, physicalLimit: null,
      roles: [{ routeId: "g-three", rank: 1 }], note: null }, 1, "operator");
    expect(second.before?.version).toBe(1);
    expect(second.after).toMatchObject({ version: 2, limitSlots: 3, secondaryCap: 2, idleMs: 5_000, reserveSlots: 0, physicalLimit: null, updatedBy: "operator",
      roles: [{ routeId: "g-three", rank: 1 }] });
    expect(new Date(second.after.updatedAt).getTime()).toBeGreaterThan(new Date(first.after.updatedAt).getTime());
    expect(second.after.createdAt).toBe(first.after.createdAt);
    expect((await readModelCapacityDevice("gamma"))?.roles.map(role => role.routeId)).toEqual(["g-three"]);
    const audits = await client`SELECT actor, action, target, detail FROM operations_audit WHERE id > ${floor.id} ORDER BY id`;
    expect(audits.map(row => [row.actor, row.action, row.target])).toEqual([["jr", MODEL_CAPACITY_DEVICE_SAVE_AUDIT_ACTION, "gamma"], ["operator", MODEL_CAPACITY_DEVICE_SAVE_AUDIT_ACTION, "gamma"]]);
    expect(audits[0].detail).toMatchObject({ version: 1, expectedVersion: null, before: null, after: { limitSlots: 4, roles: [{ routeId: "g-one", rank: 1 }, { routeId: "g-two", rank: 2 }] } });
    expect(audits[1].detail).toMatchObject({ version: 2, expectedVersion: 1, before: { limitSlots: 4 }, after: { limitSlots: 3, roles: [{ routeId: "g-three", rank: 1 }] } });
  });

  it("refuses a stale version, an unexpected existing row, bad input and a bad actor without touching the row or the audit", async () => {
    const [floor] = await client`SELECT coalesce(max(id), 0)::int AS id FROM operations_audit`;
    const input = { deviceId: "gamma", limitSlots: 3, secondaryCap: 2, idleMs: 5_000, reserveSlots: 0, physicalLimit: null, roles: [], note: null };
    await expect(save(input, 1)).rejects.toThrow("model_capacity_device_version_mismatch:2");
    await expect(save({ ...input, deviceId: "delta" }, 1)).rejects.toThrow("model_capacity_device_version_mismatch:none");
    await expect(save(input, 0)).rejects.toThrow("model_capacity_device_version_mismatch:invalid");
    await expect(save({ ...input, secondaryCap: 4 }, 2)).rejects.toThrow("model_capacity_device_invalid:secondaryCap");
    await expect(save({ ...input, roles: [{ routeId: "a", rank: 1 }, { routeId: "a", rank: 2 }] }, 2)).rejects.toThrow("model_capacity_device_invalid:roles");
    await expect(save(input, 2, " ")).rejects.toThrow("model_capacity_device_invalid:actor");
    expect((await readModelCapacityDevice("gamma"))?.version).toBe(2);
    expect(await readModelCapacityDevice("delta")).toBeNull();
    const [count] = await client`SELECT count(*)::int AS n FROM operations_audit WHERE id > ${floor.id}`;
    expect(count.n).toBe(0);
  });

  it("re-enables a disabled row on save and keeps lowering the limit below the occupancy a settings-only change", async () => {
    await client`UPDATE model_capacity_devices SET enabled = false WHERE device_id = 'gamma'`;
    await insertRequest({ routeId: "g-three", state: "dispatched", groupId: "gamma" });
    await insertRequest({ routeId: "g-three", state: "reserved", groupId: "gamma" });
    const saved = await save({ deviceId: "gamma", limitSlots: 1, secondaryCap: 0, idleMs: 0, reserveSlots: 0, physicalLimit: null, roles: [{ routeId: "g-three", rank: 1 }], note: null }, 2);
    expect(saved.after).toMatchObject({ enabled: true, version: 3, limitSlots: 1 });
    const [held] = await client`SELECT count(*)::int AS n FROM model_capacity_requests WHERE group_id = 'gamma' AND state IN ('reserved','dispatched')`;
    expect(held.n).toBe(2);
    expect(await stateOf("gamma")).toMatchObject({ source: "table", limitSlots: 1, active: 2, version: 3 });
    expect(await candidate("gamma")).toBeNull();
    await clearRequests();
  });
});

describe("readModelCapacityDeviceStates", () => {
  it("counts reserved/dispatched only, reports busy/bound/lending/waiting per device, and falls back to the policy for a device without an enabled row", async () => {
    await save({ deviceId: "alpha", limitSlots: 4, secondaryCap: 1, idleMs: 0, reserveSlots: 0, physicalLimit: null,
      roles: [{ routeId: "primary-route", rank: 1 }, { routeId: "secondary-route", rank: 2 }], note: null }, 1);
    await client`UPDATE model_capacity_devices SET enabled = false WHERE device_id = 'beta'`;
    await insertRequest({ routeId: "primary-route", state: "dispatched" });                                 // occupies, primary busy
    await insertRequest({ routeId: "secondary-route", state: "reserved" });                                 // occupies as secondary
    await insertRequest({ routeId: "secondary-route", state: "indeterminate" });                            // holds nothing
    await insertRequest({ routeId: "primary-route", state: "indeterminate", updatedAgoMs: 3_600_000 });     // neither occupancy nor busy
    await insertRequest({ routeId: "secondary-route", state: "waiting" });                                  // waiting (current generation)
    await insertRequest({ routeId: "primary-route", state: "waiting", generation: { ...generation, revision: 2 } }); // old generation: not waiting here
    await insertRequest({ routeId: "primary-route", state: "waiting", queueUntilMs: -1_000 });               // expired: not waiting
    await insertRequest({ routeId: "unranked-route", state: "dispatched" });                                // unranked = secondary occupancy
    await insertRequest({ routeId: "beta-route", state: "indeterminate", groupId: "beta" });
    await insertRequest({ routeId: "beta-route", state: "reserved", groupId: "beta" });
    const states = await readModelCapacityDeviceStates();
    expect(states.map(state => state.deviceId)).toEqual(["alpha", "beta", "gamma"]); // omega: route without row or groupLimits → unconfigured, absent; huge/" spaced": invalid fallback
    expect(states[0]).toMatchObject({ deviceId: "alpha", source: "table", limitSlots: 4, secondaryCap: 1, idleMs: 0, reserveSlots: 0,
      active: 3, secondaryActive: 2, primaryBusy: true, secondaryBound: 1, lending: false, waiting: 1, waitingPrimary: 0, version: 2 });
    expect(states[0].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(states[1]).toEqual({ deviceId: "beta", source: "policy_fallback", limitSlots: 1, secondaryCap: 1, idleMs: 60_000, reserveSlots: 0,
      active: 1, secondaryActive: 1, primaryBusy: false, secondaryBound: 1, lending: false, waiting: 0, waitingPrimary: 0, version: null, updatedAt: null,
      helpers: [], // PR 2a: no helper assignment on this device
      // 0169 (route quotas): the policy fallback lends idle slots and has no quota lines; the per-route occupancy still shows (indeterminate holds nothing)
      lendIdle: true, routes: [{ routeId: "beta-route", active: 1, waiting: 0, minSlots: null, maxSlots: null, cap: null, demand: false, held: 0 }],
      // 0170 (model limits): no limit lines on a fallback device; the per-model occupancy still shows (indeterminate holds nothing)
      models: [{ model: "m", active: 1, waiting: 0, maxSlots: null, engineMax: null }] });
    expect(states[2]).toMatchObject({ deviceId: "gamma", source: "table", active: 0 });
    // the same read inside a caller transaction (1b-C's admission TX) sees the same snapshot
    expect(await db.transaction(tx => readModelCapacityDeviceStates(tx))).toEqual(states);
    await clearRequests();
  });

  it("marks lending when the primary is idle and secondaries exceed the cap, and busy again when a primary waits", async () => {
    await insertRequest({ routeId: "secondary-route", state: "dispatched" });
    await insertRequest({ routeId: "secondary-route", state: "reserved" });
    expect(await stateOf("alpha")).toMatchObject({ active: 2, secondaryActive: 2, primaryBusy: false, secondaryBound: 4, lending: true });
    await insertRequest({ routeId: "primary-route", state: "waiting" });
    expect(await stateOf("alpha")).toMatchObject({ active: 2, secondaryActive: 2, primaryBusy: true, secondaryBound: 1, lending: false, waiting: 1, waitingPrimary: 1 });
    await clearRequests();
    // a recently finished primary row (withdrawn, updated now) keeps the device busy for idle_ms
    await save({ deviceId: "alpha", limitSlots: 4, secondaryCap: 1, idleMs: 600_000, reserveSlots: 0, physicalLimit: null,
      roles: [{ routeId: "primary-route", rank: 1 }, { routeId: "secondary-route", rank: 2 }], note: null }, 2);
    await insertRequest({ routeId: "primary-route", state: "withdrawn" });
    expect(await stateOf("alpha")).toMatchObject({ active: 0, primaryBusy: true, secondaryBound: 1 });
    await clearRequests();
    await insertRequest({ routeId: "primary-route", state: "withdrawn", updatedAgoMs: 3_600_000 });   // older than idle_ms: idle again
    expect(await stateOf("alpha")).toMatchObject({ active: 0, primaryBusy: false, secondaryBound: 4 });
  });
});

describe("deviceCandidateSql (the predicate 1b-C's grantOne executes)", () => {
  const alpha = (overrides: Partial<{ limitSlots: number; secondaryCap: number; idleMs: number; reserveSlots: number }> = {}) => db.transaction(async tx => {
    const current = await readModelCapacityDevice("alpha", tx);
    return saveModelCapacityDevice(tx, { deviceId: "alpha", limitSlots: 4, secondaryCap: 1, idleMs: 0, reserveSlots: 0, physicalLimit: null,
      roles: [{ routeId: "primary-route", rank: 1 }, { routeId: "secondary-route", rank: 2 }], note: null, ...overrides }, current?.version ?? null, "jr");
  });

  it("picks the primary before an earlier secondary and nothing once the device is full", async () => {
    await alpha({ limitSlots: 2 });
    const secondary = await insertRequest({ routeId: "secondary-route", state: "waiting" });
    const primary = await insertRequest({ routeId: "primary-route", state: "waiting" });
    expect(await candidate("alpha")).toBe(primary);
    await insertRequest({ routeId: "primary-route", state: "dispatched" });
    await insertRequest({ routeId: "unranked-route", state: "reserved" });
    expect(await candidate("alpha")).toBeNull();                      // active 2 = limit 2 (the unranked row counts)
    await client`DELETE FROM model_capacity_requests WHERE request_id = ${primary}`;
    await client`DELETE FROM model_capacity_requests WHERE route_id = 'unranked-route' AND owner_instance_id = ${owner.instanceId}`;
    expect(await candidate("alpha")).toBe(secondary);                 // active 1 < 2; primary dispatched → busy → bound = cap 1 > secondaryActive 0
    await alpha({ limitSlots: 2, secondaryCap: 0 });
    expect(await candidate("alpha")).toBeNull();                      // cap 0 while the primary is busy: no secondary starts
    await alpha({ limitSlots: 2, secondaryCap: 1 });
    expect(await candidate("alpha")).toBe(secondary);
    await insertRequest({ routeId: "secondary-route", state: "reserved" });
    expect(await candidate("alpha")).toBeNull();                      // secondaryActive 1 = cap 1 (and the device is full anyway)
  });

  it("caps secondaries while the primary is busy, lends the whole device minus reserve when idle, and ignores indeterminate rows", async () => {
    await alpha({ limitSlots: 4, secondaryCap: 1, reserveSlots: 1 });
    await insertRequest({ routeId: "secondary-route", state: "dispatched" });
    await insertRequest({ routeId: "secondary-route", state: "indeterminate" });     // holds nothing
    await insertRequest({ routeId: "primary-route", state: "indeterminate", updatedAgoMs: 3_600_000 }); // not busy either
    const waiting = await insertRequest({ routeId: "secondary-route", state: "waiting" });
    expect(await candidate("alpha")).toBe(waiting);                   // idle: bound = max(1, 4 - 1) = 3 > secondaryActive 1
    await insertRequest({ routeId: "secondary-route", state: "reserved" });
    await insertRequest({ routeId: "secondary-route", state: "reserved" });
    expect(await candidate("alpha")).toBeNull();                      // secondaryActive 3 = bound 3: the reserve slot stays free
    const primary = await insertRequest({ routeId: "primary-route", state: "waiting" });
    expect(await candidate("alpha")).toBe(primary);                   // the reserved slot goes to the primary (active 3 < 4)
    await client`DELETE FROM model_capacity_requests WHERE request_id = ${primary}`;
    await insertRequest({ routeId: "primary-route", state: "reserved" });
    expect(await candidate("alpha")).toBeNull();                      // full (4) and busy
    await clearRequests();
  });

  it("falls back to the policy groupLimits for a device without an enabled row and yields nothing for an unconfigured device", async () => {
    const beta = await insertRequest({ routeId: "beta-route", state: "waiting", groupId: "beta" });
    expect(await candidate("beta")).toBe(beta);                       // beta row disabled above → policy_fallback limit 1
    await insertRequest({ routeId: "beta-route", state: "reserved", groupId: "beta" });
    expect(await candidate("beta")).toBeNull();
    await insertRequest({ routeId: "omega-route", state: "waiting", groupId: "omega" });
    expect(await candidate("omega")).toBeNull();                      // no row, no groupLimits → no settings source → no grant
    await insertRequest({ routeId: "huge-route", state: "waiting", groupId: "huge" });
    expect(await candidate("huge")).toBeNull();                       // groupLimits 999 is outside 1..256 → not a fallback
    await clearRequests();
  });
});
