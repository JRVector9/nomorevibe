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
import { MODEL_CAPACITY_MODEL_LIMIT_SAVE_AUDIT_ACTION, deviceModelLimitText, deviceModelUsageText, type ModelCapacityModelLimit,
  type ModelCapacityRouteQuota } from "@/lib/llm/capacity-devices";
import { readModelCapacityDevice, readModelCapacityDeviceStates, saveModelCapacityDevice, saveModelCapacityModelLimits,
  saveModelCapacityRouteQuotas } from "@/lib/llm/capacity-devices-repository";
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
 * 0170(운영자 결정 2026-11-09): 장비 안 모델별 상한 — 공유 칸(limit_slots)과 따로 모델(장부 model 문자열, 공급자 무관)마다 최대 칸. 실제 장부(requestSlot·grantOne)로 본다.
 * 운영 사례를 본뜬다: 장비 mlx(공유 2칸)를 deepseek(두 공급자 경로) 와 gpt-oss 가 함께 쓴다. beta 는 다른 장비(다음 순위·작업 풀 시험용).
 * 자기 DB 를 만들어 끝까지 migrate 한다(공유 test DB 의 장비 행·상한을 남기지 않는다).
 */
const name = `nomorevibe_test_model_limits_${randomUUID().replaceAll("-", "")}`, url = new URL(TEST_DATABASE_URL); url.pathname = `/${name}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} }), client = postgres(url.toString(), { max: 4, prepare: false, onnotice: () => {} });
let created = false;
const root = path.resolve(".");
const DEEPSEEK = "deepseek-v4.1-flash-1017", GPT = "gpt-oss-120b";
const route = (routeId: string, groupId: string, provider = "fixture", model = "m") => ({ routeId, provider, model, providerBudgetId: "account", groupId });
const basePolicy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { account: 1 }, poolLimits: { reviewer: 1, text: 1 },
  weights: { first: 1, second: 1, background: 1 }, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [route("ds-route", "mlx", "fixture", DEEPSEEK), route("ds-direct", "mlx", "fixture-direct", DEEPSEEK), route("gpt-route", "mlx", "fixture", GPT),
    route("beta-route", "beta"), route("product-search-profile", "mlx", "abcllm", "m-mlx"), route("product-search-profile", "beta", "abcllm", "m-beta")] };
const owner = { instanceId: `model-limits-${randomUUID()}`, bootId: randomUUID() };
const MODEL: Record<string, [string, string]> = { "ds-route": ["fixture", DEEPSEEK], "ds-direct": ["fixture-direct", DEEPSEEK], "gpt-route": ["fixture", GPT],
  "beta-route": ["fixture", "m"] };

const request = (routeId: string, overrides: Partial<ModelCapacityRequest> = {}): ModelCapacityRequest => ({ requestId: randomUUID(), workKey: randomUUID(), owner,
  class: "first", pool: "reviewer", routeId, provider: MODEL[routeId][0], model: MODEL[routeId][1], ...overrides });
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
async function installPolicy(value: ModelCapacityPolicy) {
  await client`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(value)}::jsonb, policy_hash = ${modelCapacityPolicyHash(value)},
    revision = revision + 1, cursor = 0, updated_at = clock_timestamp() WHERE id = 1`;
}
async function configure(deviceId: string, limitSlots = 2) {
  const current = await readModelCapacityDevice(deviceId);
  const input = { deviceId, limitSlots, secondaryCap: limitSlots, idleMs: 0, reserveSlots: 0, roles: [], physicalLimit: null, note: null };
  return db.transaction(tx => saveModelCapacityDevice(tx, input, current?.version ?? null, "model-limit-test"));
}
async function setLimits(deviceId: string, limits: ModelCapacityModelLimit[], actor = "model-limit-test") {
  const current = await readModelCapacityDevice(deviceId);
  return db.transaction(tx => saveModelCapacityModelLimits(tx, { deviceId, expectedVersion: current!.version, limits }, actor));
}
async function setQuotas(deviceId: string, quotas: ModelCapacityRouteQuota[]) {
  const current = await readModelCapacityDevice(deviceId);
  return db.transaction(tx => saveModelCapacityRouteQuotas(tx, { deviceId, expectedVersion: current!.version, lendIdle: true, quotas }, "model-limit-test"));
}
const limit = (model: string, maxSlots: number, engineMax: number | null = null): ModelCapacityModelLimit => ({ model, maxSlots, engineMax });
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
  await configure("mlx");
  await configure("beta");
}, 180_000);
afterAll(async () => {
  delete (globalThis as { db?: unknown }).db; delete (globalThis as { pgClient?: unknown }).pgClient;
  setAiTaskModelsForTest(null); setServingContractSnapshotForTest(null);
  await client.end({ timeout: 3 }); if (created) await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end({ timeout: 3 });
});
afterEach(async () => {
  await clearLedger();
  await client`UPDATE model_capacity_devices SET model_limits = '[]'::jsonb, route_quotas = '[]'::jsonb, lend_idle = true, enabled = true`;
  await installPolicy(basePolicy);
  await configure("mlx");
  await configure("beta");
  setAiTaskModelsForTest(null); setServingContractSnapshotForTest(null);
});

describe("migration 0170", () => {
  it("adds an empty model_limits list to existing device rows", async () => {
    expect(await client`SELECT device_id, model_limits FROM model_capacity_devices ORDER BY device_id`)
      .toEqual([{ device_id: "beta", model_limits: [] }, { device_id: "mlx", model_limits: [] }]);
    expect(await readModelCapacityDevice("mlx")).toMatchObject({ modelLimits: [] });
  });

  it("the DB refuses limit JSON the save refuses — shape, duplicates, range, engine maximum below the limit", async () => {
    const write = (value: unknown) => client`UPDATE model_capacity_devices SET model_limits = ${JSON.stringify(value)}::jsonb WHERE device_id = 'mlx'`;
    const line = (model: unknown, max: unknown, engine: unknown = null) => ({ model, max_slots: max, engine_max: engine });
    await expect(write([line(DEEPSEEK, 1, 1), line(GPT, 4, 4), line("big", 256, null)])).resolves.toBeDefined(); // above the shared 2: allowed
    for (const bad of [{}, [line(GPT, 1), line(GPT, 2)], [line(GPT, 5, 4)], [line(GPT, 1, 0)], [line(GPT, 1, 257)], [line(GPT, 257)], [line(GPT, -1)],
      [line(GPT, 1.5)], [line(GPT, "1")], [line(` ${GPT}`, 1)], [line("", 1)], [line(1, 1)], [{ model: GPT, max_slots: 1 }], [{ ...line(GPT, 1), extra: true }],
      Array.from({ length: 65 }, (_, index) => line(`m${index}`, 1))])
      await expect(write(bad), JSON.stringify(bad).slice(0, 80)).rejects.toThrow(/model_capacity_devices_model_limits_check/);
    await client`UPDATE model_capacity_devices SET model_limits = '[]'::jsonb WHERE device_id = 'mlx'`;
  });
});

describe("no model limit lines = today's admission", () => {
  it("grants the identical sequence with an empty list and with non-binding lines", async () => {
    const scenario = async () => {
      const outcomes: string[] = [];
      for (const routeId of ["ds-route", "gpt-route", "ds-direct", "gpt-route", "ds-route"]) {
        const result = await requestModelSlot(request(routeId));
        outcomes.push(result.kind === "granted" ? "granted" : result.reason);
      }
      return { outcomes, rows: (await live()).map(row => `${row.route_id}:${row.state}`) };
    };
    const baseline = await scenario();
    expect(baseline).toEqual({ outcomes: ["granted", "granted", "capacity", "capacity", "capacity"],
      rows: ["ds-route:reserved", "gpt-route:reserved", "ds-direct:waiting", "gpt-route:waiting", "ds-route:waiting"] });
    await clearLedger();
    await setLimits("mlx", [limit(DEEPSEEK, 3), limit(GPT, 4, 4), limit("unused-model", 0)]);
    expect(await scenario()).toEqual(baseline);
  });
});

describe("model cap (max_slots)", () => {
  it("refuses the model at its cap as model_quota without a waiting row or event — across providers — and still grants the other model", async () => {
    await configure("mlx", 4);
    await setLimits("mlx", [limit(DEEPSEEK, 1, 1), limit(GPT, 4, 4)]);
    await granted(request("ds-route"));
    for (const routeId of ["ds-route", "ds-direct"]) {          // same model string under another provider shares the cap
      const capped = request(routeId);
      await deferred(capped, "model_quota");
      expect(await rowOf(capped.requestId)).toBeNull();
      expect(await eventsOf(capped.requestId)).toEqual([]);
    }
    await granted(request("gpt-route"));
    await granted(request("gpt-route"));
    expect((await stateOf("mlx"))?.models).toEqual([{ model: DEEPSEEK, active: 1, waiting: 0, maxSlots: 1, engineMax: 1 },
      { model: GPT, active: 2, waiting: 0, maxSlots: 4, engineMax: 4 }]);
    const state = (await stateOf("mlx"))!;
    expect(deviceModelUsageText(state, model => model === DEEPSEEK ? "m3-deepseek" : "m3-gpt-oss")).toBe("m3-deepseek 1/1 · m3-gpt-oss 2/4 · 공유 3/4");
    expect(deviceModelLimitText(state, model => model === DEEPSEEK ? "m3-deepseek" : "m3-gpt-oss")).toBe("m3-deepseek 한도 1 / 엔진 1 · m3-gpt-oss 한도 4 / 엔진 4");
  });

  it("keeps the shared limit: below the model cap a full device still queues (capacity), and max_slots 0 takes the model off the device", async () => {
    await setLimits("mlx", [limit(DEEPSEEK, 2), limit(GPT, 4)]);
    await granted(request("gpt-route")); await granted(request("gpt-route"));
    const queued = request("ds-route");
    await deferred(queued, "capacity");                          // model 0/2 but shared 2/2
    expect(await rowOf(queued.requestId)).toBe("waiting");
    await clearLedger();
    await setLimits("mlx", [limit(DEEPSEEK, 0)]);
    await deferred(request("ds-direct"), "model_quota");
    expect(await stateOf("mlx")).toMatchObject({ active: 0, waiting: 0 });
    await granted(request("gpt-route"));
  });

  it("does not admit a waiting row of a capped model; the next pass takes a later row of another model, and the capped row's own poll withdraws it", async () => {
    const blocker = await granted(request("gpt-route"));
    await granted(request("gpt-route"));
    const ds = request("ds-route"), gpt = request("gpt-route");
    await deferred(ds, "capacity"); await deferred(gpt, "capacity"); // both queue behind the full device; ds is ahead
    await setLimits("mlx", [limit(DEEPSEEK, 0)]);
    expect(await cancelReservedModelSlot(blocker)).toBe(true);
    expect((await requestModelSlot(gpt)).kind).toBe("granted");      // the pass skips the earlier ds row
    expect(await rowOf(ds.requestId)).toBe("waiting");
    await deferred(ds, "model_quota");
    expect(await rowOf(ds.requestId)).toBe("withdrawn");
    expect(await eventsOf(ds.requestId)).toEqual(["queued", "wait_cancelled"]);
  });

  it("counts earlier waiting rows of the same model (any route) toward the cap and withdraws an own waiting row once the cap is spoken for", async () => {
    await configure("mlx", 1);
    const blocker = await granted(request("gpt-route"));
    const first = request("ds-route"), second = request("ds-direct");
    await deferred(first, "capacity"); await deferred(second, "capacity");
    await setLimits("mlx", [limit(DEEPSEEK, 1)]);
    await deferred(second, "model_quota");                         // 0 active + 1 ahead (other route, same model) ≥ 1
    expect(await rowOf(second.requestId)).toBe("withdrawn");
    await deferred(first, "capacity");                             // first keeps its place
    const third = request("ds-route");
    await deferred(third, "model_quota");
    expect(await rowOf(third.requestId)).toBeNull();
    expect(await cancelReservedModelSlot(blocker)).toBe(true);
    expect((await requestModelSlot(first)).kind).toBe("granted");
    expect((await stateOf("mlx"))?.models).toEqual([{ model: DEEPSEEK, active: 1, waiting: 0, maxSlots: 1, engineMax: null }]);
  });

  it("is absolute: a route under its guarantee still respects the model cap", async () => {
    await setQuotas("mlx", [{ routeId: "ds-route", minSlots: 2, maxSlots: null }]);
    await setLimits("mlx", [limit(DEEPSEEK, 1)]);
    await granted(request("ds-route"));
    await deferred(request("ds-route"), "model_quota");             // route at 1 of its guarantee 2, model at 1 of 1
    expect((await stateOf("mlx"))?.routes?.find(row => row.routeId === "ds-route")).toMatchObject({ active: 1, minSlots: 2 });
  });
});

describe("saveModelCapacityModelLimits", () => {
  const audits = async (floor: number) => client`SELECT actor, action, target, detail FROM operations_audit
    WHERE id > ${floor} AND action = ${MODEL_CAPACITY_MODEL_LIMIT_SAVE_AUDIT_ACTION} ORDER BY id`;
  const auditFloor = async () => Number((await client`SELECT coalesce(max(id), 0)::int AS id FROM operations_audit`)[0].id);
  const save = (input: unknown, actor = "jr") => db.transaction(tx => saveModelCapacityModelLimits(tx, input, actor));

  it("compare-and-sets the device version, replaces the lines, audits once and warns above the shared limit and for an unmapped model", async () => {
    const floor = await auditFloor();
    const before = (await readModelCapacityDevice("mlx"))!;
    const result = await save({ deviceId: "mlx", expectedVersion: before.version,
      limits: [{ model: GPT, maxSlots: 4, engineMax: 4 }, { model: DEEPSEEK, maxSlots: 1, engineMax: 1 }, { model: "qwen-elsewhere", maxSlots: 1 }] });
    expect(result.warnings).toEqual([`max_exceeds_limit:${GPT}`, "model_unmapped:qwen-elsewhere"]);
    expect(result.before).toEqual([]);
    expect(result.after).toMatchObject({ version: before.version + 1, updatedBy: "jr",
      modelLimits: [limit(DEEPSEEK, 1, 1), limit(GPT, 4, 4), limit("qwen-elsewhere", 1)] });
    expect((await client`SELECT model_limits FROM model_capacity_devices WHERE device_id = 'mlx'`)[0].model_limits).toEqual([
      { model: DEEPSEEK, max_slots: 1, engine_max: 1 }, { model: GPT, max_slots: 4, engine_max: 4 }, { model: "qwen-elsewhere", max_slots: 1, engine_max: null }]);
    const rows = await audits(floor);
    expect(rows.map(row => [row.actor, row.action, row.target])).toEqual([["jr", MODEL_CAPACITY_MODEL_LIMIT_SAVE_AUDIT_ACTION, "mlx"]]);
    expect(rows[0].detail).toMatchObject({ version: before.version + 1, expectedVersion: before.version, limitSlots: 2, before: [],
      after: [limit(DEEPSEEK, 1, 1), limit(GPT, 4, 4), limit("qwen-elsewhere", 1)], warnings: [`max_exceeds_limit:${GPT}`, "model_unmapped:qwen-elsewhere"] });
    const stale = save({ deviceId: "mlx", expectedVersion: before.version, limits: [] });
    await expect(stale).rejects.toThrow(`model_capacity_model_limit_version_mismatch:${before.version + 1}`);
    expect(await readModelCapacityDevice("mlx")).toMatchObject({ version: before.version + 1, modelLimits: [limit(DEEPSEEK, 1, 1), limit(GPT, 4, 4), limit("qwen-elsewhere", 1)] });
    expect(await audits(floor)).toHaveLength(1);
    // a device save keeps the model lines (and lowering the shared limit below a model cap is allowed — the shared limit binds first)
    await configure("mlx", 1);
    expect((await readModelCapacityDevice("mlx"))?.modelLimits).toEqual([limit(DEEPSEEK, 1, 1), limit(GPT, 4, 4), limit("qwen-elsewhere", 1)]);
  });

  it("refuses bad input, an unknown or disabled device and a bad actor — nothing written", async () => {
    const floor = await auditFloor();
    const current = (await readModelCapacityDevice("mlx"))!;
    const base = { deviceId: "mlx", expectedVersion: current.version };
    const refused: [unknown, string][] = [
      [{ ...base, limits: [{ model: GPT, maxSlots: 5, engineMax: 4 }] }, "model_capacity_model_limit_invalid:limits.0.maxSlots:exceeds_engine"],
      [{ ...base, limits: [limit(GPT, 1), limit(GPT, 2)] }, "model_capacity_model_limit_invalid:limits:duplicate_model"],
      [{ ...base, limits: [limit(GPT, 257)] }, "model_capacity_model_limit_invalid:limits.0.maxSlots"],
      [{ ...base, limits: [limit(GPT, 1, 0)] }, "model_capacity_model_limit_invalid:limits.0.engineMax"],
      [{ ...base, limits: [limit(` ${GPT}`, 1)] }, "model_capacity_model_limit_invalid:limits.0.model"],
      [{ ...base, limits: [], extra: 1 }, "model_capacity_model_limit_invalid:root"],
      [{ ...base, expectedVersion: 0, limits: [] }, "model_capacity_model_limit_invalid:expectedVersion"],
      [{ ...base, deviceId: "nowhere", limits: [] }, "model_capacity_model_limit_device_unconfigured"],
    ];
    for (const [input, code] of refused) await expect(save(input), code).rejects.toThrow(code);
    await expect(save({ ...base, limits: [] }, " ")).rejects.toThrow("model_capacity_model_limit_invalid:actor");
    await client`UPDATE model_capacity_devices SET enabled = false WHERE device_id = 'beta'`;
    const beta = (await readModelCapacityDevice("beta"))!;
    await expect(save({ deviceId: "beta", expectedVersion: beta.version, limits: [] })).rejects.toThrow("model_capacity_model_limit_device_unconfigured");
    await client`UPDATE model_capacity_devices SET enabled = true WHERE device_id = 'beta'`;
    expect(await readModelCapacityDevice("mlx")).toMatchObject({ version: current.version, modelLimits: [] });
    expect(await audits(floor)).toEqual([]);
  });
});

describe("work-pool selector hint", () => {
  const connection = (deviceId: string): AiTaskConnectionSnapshot => Object.freeze({ id: deviceId === "mlx" ? "0b0c0d0e-0000-4000-8000-0000000000a1" : "0b0c0d0e-0000-4000-8000-0000000000b1",
    label: deviceId, kind: "api" as const, baseUrl: `http://${deviceId}.test:8000/v1`, cliTool: null, deviceId, enabled: true, models: null, contextTokens: null,
    apiKey: null, keyUnreadable: false });
  const member = (deviceId: string, position: number): AiTaskPoolMember => {
    const conn = connection(deviceId), model = `m-${deviceId}`;
    return Object.freeze({ memberId: deviceId === "mlx" ? "0b0c0d0e-0000-4000-8000-00000000a0a0" : "0b0c0d0e-0000-4000-8000-00000000b0b0",
      position, connectionId: conn.id, model, options: {}, canonicalModel: model, deviceId, engineKey: taskPoolEngineKey(conn, model), connection: conn });
  };
  const members = [member("mlx", 1), member("beta", 2)];
  const config: AiTaskExecutionConfig = Object.freeze({ task: "product-search-profile", slot: 1, mode: "workload_pool", revision: 7, updatedAt: null, members });
  const candidates = members.map(row => ({ memberId: row.memberId, routeId: "product-search-profile", connectionId: row.connectionId, engineModel: row.model,
    provider: "abcllm", identity: row.model, deviceId: row.deviceId }));
  const choose = (options: { queueWhenFull?: boolean; rotate?: boolean } = {}) =>
    db.transaction(tx => chooseTaskWorkloadMember(config, candidates, { executor: tx as unknown as ProductTransaction, ...options }));

  it("skips a member whose model is at its cap on that device; null when none fits", async () => {
    await granted(request("beta-route"));                                    // beta busier: mlx wins on pressure without limits
    expect((await choose())?.deviceId).toBe("mlx");
    await setLimits("mlx", [limit("m-mlx", 0)]);
    expect((await choose())?.deviceId).toBe("beta");
    await setLimits("beta", [limit("m-beta", 0)]);
    expect(await choose()).toBeNull();
  });

  // 2026-11-12 「동시에」 검토: 빈 칸만 고르면 풀은 장부 줄에 서지 못한다 — 순위대로처럼 줄에 설 구성원을 고른다(판정·대기 행은 requestSlot)
  it("queueWhenFull: with no free slot anywhere, picks the least-loaded member that can still queue; never a quota-capped one", async () => {
    await granted(request("ds-route")); await granted(request("gpt-route"));      // mlx 2/2
    await granted(request("beta-route")); await granted(request("beta-route"));   // beta 2/2
    await deferred(request("beta-route"), "capacity");                             // beta also has a waiting row → more pressure
    expect(await choose()).toBeNull();                                             // the plain hint still answers "no free slot"
    expect((await choose({ queueWhenFull: true }))?.deviceId).toBe("mlx");
    // A model at its cap is refused as model_quota without a waiting row — it is not a queue target
    await setLimits("mlx", [limit("m-mlx", 0)]);
    expect((await choose({ queueWhenFull: true }))?.deviceId).toBe("beta");
    await setLimits("beta", [limit("m-beta", 0)]);
    expect(await choose({ queueWhenFull: true })).toBeNull();
  });

  it("queueWhenFull keeps choosing a free member first", async () => {
    await granted(request("ds-route")); await granted(request("gpt-route"));      // mlx full, beta idle
    expect((await choose({ queueWhenFull: true }))?.deviceId).toBe("beta");
  });

  it("a text pool with every device full enters the ledger queue like fallback ranks (waiting row + member-only deferral), instead of folding the tick", async () => {
    setServingContractSnapshotForTest(members.map(row => textContract("product-search-profile", row.model, { baseUrl: row.connection.baseUrl! })));
    const ranks = new TextTaskRanks(resolveTextTaskRanks("product-search-profile", config), config);
    ranks.lanes(1);
    await granted(request("ds-route")); await granted(request("gpt-route"));      // mlx 2/2
    await granted(request("beta-route")); await granted(request("beta-route"));   // beta 2/2
    await deferred(request("beta-route"), "capacity");                             // beta busier
    const work = async (binding: { identity: string }) => {
      const slot = await requestModelSlot({ requestId: randomUUID(), workKey: randomUUID(), owner, class: "background", pool: "text",
        routeId: "product-search-profile", provider: "abcllm", model: binding.identity });
      if (slot.kind !== "granted") throw new ModelCapacityDeferredError(slot.reason);
      return binding.identity;
    };
    const error = await ranks.run(work).catch(caught => caught);
    expect(error).toBeInstanceOf(ModelCapacityDeferredError);
    expect(ranks.skipsWork(error)).toBe(true);                                     // only this work is passed; the tick goes on
    expect((await live()).filter(row => row.route_id === "product-search-profile").map(row => row.state)).toEqual(["waiting"]);
    expect(ranks.usable().map(row => row.identity)).toEqual(["m-beta"]);          // the queued member rests for this tick
  });

  it("rotate: back-to-back choices without ledger writes alternate members instead of piling onto the least-loaded one", async () => {
    await granted(request("beta-route"));                                          // beta busier, both still have a free slot
    const plain = [await choose(), await choose(), await choose()].map(row => row?.deviceId);
    expect(plain).toEqual(["mlx", "mlx", "mlx"]);
    const rotated = [await choose({ rotate: true }), await choose({ rotate: true })].map(row => row?.deviceId);
    expect(new Set(rotated)).toEqual(new Set(["mlx", "beta"]));
  });
});

describe("rank fallback on model_quota", () => {
  const SECOND = "0b0c0d0e-0000-4000-8000-0000000000aa", SECOND_BASE = "http://second.test:8000/v1";
  const twoRanks = () => {
    setServingContractSnapshotForTest([textContract("product-search-profile", "gpt-oss-120b"),
      textContract("product-search-profile", "qwen3.6-35b", { baseUrl: SECOND_BASE })]);
    setAiTaskModelsForTest([textRankRow("product-search-profile", "gpt-oss-120b"),
      textRankRow("product-search-profile", "qwen3.6-35b", { rank: 2, connectionId: SECOND, baseUrl: SECOND_BASE, label: "second" })]);
    return new TextTaskRanks(resolveTextTaskRanks("product-search-profile"));
  };
  // rank 1 asks the ledger for mlx's deepseek route, rank 2 for beta's route — the deferral comes from the real admission TX
  const work = async (binding: { rank: number }) => {
    const slot = await requestModelSlot(request(binding.rank === 1 ? "ds-route" : "beta-route"));
    if (slot.kind !== "granted") throw new ModelCapacityDeferredError(slot.reason);
    return binding.rank;
  };

  it("hands the same work to rank 2 when rank 1's model is at its cap, and reports saturation when every rank is capped", async () => {
    await setLimits("mlx", [limit(DEEPSEEK, 0)]);
    const ranks = twoRanks();
    expect(await ranks.run(work)).toMatchObject({ kind: "served", value: 2, binding: { rank: 2 } });
    expect(ranks.summary()).toEqual({ ranks: 2, "served.2": 1, "unusable.1.model_quota": 1 });
    await setLimits("beta", [limit("m", 1)]);
    const capped = twoRanks();
    expect(await capped.run(work)).toEqual({ kind: "unusable" });
    expect(capped.saturated()).toBe(true);
    expect(capped.degraded().detail).toContain("모델의 상한");
    expect((await live()).map(row => `${row.route_id}:${row.state}`)).toEqual(["beta-route:reserved"]);
  });
});
