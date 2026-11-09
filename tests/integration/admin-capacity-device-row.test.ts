import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { MODEL_CAPACITY_MODEL_LIMIT_SAVE_AUDIT_ACTION } from "@/lib/llm/capacity-devices";
import { readModelCapacityDevice, saveModelCapacityDevice } from "@/lib/llm/capacity-devices-repository";
import { saveAdminDeviceRow } from "@/lib/operations/admin-capacity-device-row-save";
import { auditFloor, auditRowsAfter, ensureSchema, TEST_DATABASE_URL } from "./setup";

/**
 * 장비 한도 표 한 줄 저장(2026-11-09 개편) — 진짜 저장소(saveModelCapacityDevice·saveModelCapacityModelLimits)를 한 TX 에서 부른다.
 * 엔진 최대치(physicalLimit)·역할·유휴·메모를 그대로 두는지, 모델 줄이 첫 저장이 올린 판으로 붙는지, 둘째 저장이 거절하면 첫 저장도 되돌아가는지를 본다.
 */
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const DEVICE = "devrow-mlx", DEEPSEEK = "deepseek-v4.1-flash-1017", GPT = "gpt-oss-120b";
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 8, providerLimits: { "devrow-budget": 8 }, groupLimits: { [DEVICE]: 2 }, poolLimits: { reviewer: 8, text: 8 },
  weights: { first: 2, second: 1, background: 1 }, maxWaiting: 32, queueTtlMs: 60_000, reservationTtlMs: 30_000,
  routes: [{ routeId: "local-deepseek-confirm", provider: "local-direct", model: DEEPSEEK, providerBudgetId: "devrow-budget", groupId: DEVICE },
    { routeId: "product-search-verify", provider: "local-direct", model: GPT, providerBudgetId: "devrow-budget", groupId: DEVICE }] };
const sql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
let originalControl: unknown = null;

beforeAll(async () => {
  ensureSchema();
  [originalControl] = (await sql`SELECT to_jsonb(c) AS value FROM model_capacity_control c WHERE id = 1`).map(row => row.value);
  await sql`UPDATE model_capacity_control SET policy = ${JSON.stringify(policy)}::text::jsonb, policy_hash = ${modelCapacityPolicyHash(policy)}, updated_at = clock_timestamp() WHERE id = 1`;
  await sql`DELETE FROM model_capacity_device_roles WHERE device_id = ${DEVICE}`;
  await sql`DELETE FROM model_capacity_devices WHERE device_id = ${DEVICE}`;
});
afterAll(async () => {
  await sql`DELETE FROM model_capacity_device_roles WHERE device_id = ${DEVICE}`;
  await sql`DELETE FROM model_capacity_devices WHERE device_id = ${DEVICE}`;
  if (originalControl) await sql`UPDATE model_capacity_control c SET policy = r.policy, policy_hash = r.policy_hash, updated_at = r.updated_at
    FROM jsonb_populate_recordset(NULL::model_capacity_control, ${JSON.stringify([originalControl])}::text::jsonb) r WHERE c.id = r.id`;
  await sql.end();
});

it("운영 한도와 모델 줄을 한 TX 에서 — 엔진 최대치·역할·메모는 그대로, 판은 두 번 오르고 감사는 저장마다 한 줄", async () => {
  const created = await db.transaction(tx => saveModelCapacityDevice(tx, { deviceId: DEVICE, limitSlots: 2, secondaryCap: 2, idleMs: 30_000, reserveSlots: 0,
    physicalLimit: 5, roles: [{ routeId: "local-deepseek-confirm", rank: 1 }], note: "M3" }, null, "devrow-test"));
  const floor = await auditFloor();
  const result = await saveAdminDeviceRow({ deviceId: DEVICE, expectedVersion: created.after.version, limitSlots: 3,
    modelLimits: [{ model: DEEPSEEK, maxSlots: 1, engineMax: 1 }, { model: GPT, maxSlots: 2, engineMax: 4 }] }, "devrow-test");
  expect(result).toMatchObject({ ok: true, version: created.after.version + 2, warnings: [] });
  const after = await readModelCapacityDevice(DEVICE);
  expect(after).toMatchObject({ limitSlots: 3, secondaryCap: 3, physicalLimit: 5, idleMs: 30_000, note: "M3", roles: [{ routeId: "local-deepseek-confirm", rank: 1 }],
    modelLimits: [{ model: DEEPSEEK, maxSlots: 1, engineMax: 1 }, { model: GPT, maxSlots: 2, engineMax: 4 }] });
  const audit = await auditRowsAfter(floor);
  expect(audit.map(row => row.action).sort()).toEqual(["model-capacity-device-save", MODEL_CAPACITY_MODEL_LIMIT_SAVE_AUDIT_ACTION].sort());
});

it("엔진 최대치를 넘는 운영 한도는 거절하고, 모델 줄이 거절되면 운영 한도도 되돌아간다", async () => {
  const before = (await readModelCapacityDevice(DEVICE))!;
  expect(await saveAdminDeviceRow({ deviceId: DEVICE, expectedVersion: before.version, limitSlots: 6, modelLimits: null }, "devrow-test"))
    .toMatchObject({ ok: false, issues: [expect.stringMatching(/^model_capacity_device_invalid:/)] });
  // 모델 한도 > 엔진 최대 → 모델 저장 거절 → 같은 TX 의 운영 한도 4 도 남지 않는다
  const refused = await saveAdminDeviceRow({ deviceId: DEVICE, expectedVersion: before.version, limitSlots: 4,
    modelLimits: [{ model: DEEPSEEK, maxSlots: 3, engineMax: 1 }] }, "devrow-test");
  expect(refused).toMatchObject({ ok: false, issues: [expect.stringMatching(/^model_capacity_model_limit_invalid:/)] });
  expect(await readModelCapacityDevice(DEVICE)).toMatchObject({ version: before.version, limitSlots: 3 });
  // 그 사이 판이 바뀌었으면 아무것도 쓰지 않는다
  expect(await saveAdminDeviceRow({ deviceId: DEVICE, expectedVersion: before.version - 1, limitSlots: 4, modelLimits: null }, "devrow-test"))
    .toEqual({ ok: false, issues: [`model_capacity_device_version_mismatch:${before.version}`] });
});
