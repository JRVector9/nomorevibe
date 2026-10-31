import { desc, sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { operationsAudit } from "@/lib/db/schema";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import type { ModelCapacityDeviceRow } from "@/lib/llm/capacity-devices";
import { setCapacityDeviceRepositoryForTest, type DeviceRepository } from "@/lib/operations/admin-capacity-devices";
import { adminAuditRow } from "@/lib/operations/admin-log";
import { auditFloor, auditRowsAfter, ensureSchema, TEST_DATABASE_URL } from "./setup";

/**
 * 장비 한도 server action → saveAdminCapacityDevice → 저장소 저장(감사 한 줄 포함) → 화면 모형(PR 1b WP-B). 관리자·next/cache 만 가짜고
 * 쓰기 관문(fence 읽기·TX 첫 lock)·감사 표·용량 제어 행(정책 경로·groupLimits)은 진짜다.
 *
 * 1b-A 의 저장소(@/lib/llm/capacity-devices-repository)가 이 트리에 있으면 그대로 쓴다(표 0153 포함, 진짜 경로). 없으면(1b-A 합치기 전) 같은 계약 —
 * zod 범위·CAS → 행+역할 교체 → operations_audit 한 줄 { version, expectedVersion, before, after }, 거절은 감사 없이 던진다 — 의 메모리 구현을
 * setCapacityDeviceRepositoryForTest 로 끼운다(vitest 는 아직 없는 alias 경로의 vi.mock 을 import 때 풀지 못한다: Cannot find package).
 * 표·입장 판정·seed 는 1b-A 의 tests/integration/capacity-devices.test.ts 가 본다.
 */
type Row = ModelCapacityDeviceRow;
const admin = vi.hoisted(() => ({ login: null as { login: string } | null }));
const fake = { rows: new Map<string, Row>(), calls: [] as string[], active: false };
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: async () => admin.login, localOperatorName: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const AUDIT_ACTION = "model-capacity-device-save";
const settingsOf = (row: Row) => ({ limitSlots: row.limitSlots, secondaryCap: row.secondaryCap, idleMs: row.idleMs, reserveSlots: row.reserveSlots,
  physicalLimit: row.physicalLimit, roles: row.roles.map(role => ({ ...role })), note: row.note, enabled: row.enabled });
function inMemoryRepository(): DeviceRepository {
  const int = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
  const invalid = (path: string) => new Error(`model_capacity_device_invalid:${path}`);
  return {
    async saveModelCapacityDevice(tx, input, expectedVersion, actor) {
      fake.calls.push("save");
      if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) throw new Error("model_capacity_device_version_mismatch:invalid");
      // 계약: control FOR UPDATE 로 입장과 직렬화 — 같은 TX 를 받는다는 것만 확인한다(실제 lock 순서는 1b-A 의 몫)
      await tx.execute(drizzleSql`SELECT id FROM model_capacity_control WHERE id = 1 FOR UPDATE`);
      const value = (input ?? {}) as Record<string, unknown>;
      if (typeof value.deviceId !== "string" || !value.deviceId.trim() || value.deviceId !== value.deviceId.trim()) throw invalid("deviceId");
      if (!int(value.limitSlots, 1, 256)) throw invalid("limitSlots");
      if (!int(value.secondaryCap, 0, 256)) throw invalid("secondaryCap");
      if (!int(value.idleMs, 0, 3_600_000)) throw invalid("idleMs");
      if (!int(value.reserveSlots, 0, 255)) throw invalid("reserveSlots");
      if (value.physicalLimit !== null && !int(value.physicalLimit, 1, 256)) throw invalid("physicalLimit");
      if (!Array.isArray(value.roles) || value.roles.length > 64) throw invalid("roles");
      const roles = value.roles as { routeId: unknown; rank: unknown }[];
      roles.forEach((role, index) => { if (typeof role.routeId !== "string" || !role.routeId.trim()) throw invalid(`roles.${index}.routeId`); if (!int(role.rank, 1, 64)) throw invalid(`roles.${index}.rank`); });
      if (value.note !== null && (typeof value.note !== "string" || value.note.length > 400)) throw invalid("note");
      const limit = value.limitSlots as number;
      // 1b-A 의 refine 은 그 칸의 path 로 던진다
      if ((value.secondaryCap as number) > limit) throw invalid("secondaryCap");
      if ((value.reserveSlots as number) >= limit) throw invalid("reserveSlots");
      if (value.physicalLimit !== null && limit > (value.physicalLimit as number)) throw invalid("limitSlots");
      if (new Set(roles.map(role => role.routeId)).size !== roles.length) throw invalid("roles");
      const before = fake.rows.get(value.deviceId as string) ?? null;
      if (expectedVersion !== null && (before?.version ?? null) !== expectedVersion) throw new Error(`model_capacity_device_version_mismatch:${before?.version ?? "none"}`);
      const now = new Date().toISOString();
      const after: Row = { deviceId: value.deviceId as string, limitSlots: limit, secondaryCap: value.secondaryCap as number, idleMs: value.idleMs as number,
        reserveSlots: value.reserveSlots as number, physicalLimit: value.physicalLimit as number | null,
        roles: roles.map(role => ({ routeId: role.routeId as string, rank: role.rank as number })).sort((a, b) => a.rank - b.rank || a.routeId.localeCompare(b.routeId)),
        note: value.note as string | null, enabled: true, version: (before?.version ?? 0) + 1, updatedBy: actor, createdAt: before?.createdAt ?? now, updatedAt: now };
      fake.rows.set(after.deviceId, after);
      await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: AUDIT_ACTION, target: after.deviceId,
        detail: { version: after.version, expectedVersion, before: before && settingsOf(before), after: settingsOf(after) } }));
      return { before: before ? structuredClone(before) : null, after: structuredClone(after) };
    },
    async listModelCapacityDevices() { fake.calls.push("list"); return [...fake.rows.values()].map(row => structuredClone(row)); },
    async readModelCapacityDeviceStates() {
      fake.calls.push("states");
      return [...fake.rows.values()].map(row => ({ deviceId: row.deviceId, source: "table" as const, limitSlots: row.limitSlots, secondaryCap: row.secondaryCap, idleMs: row.idleMs,
        reserveSlots: row.reserveSlots, active: 0, secondaryActive: 0, secondaryBound: Math.max(row.secondaryCap, row.limitSlots - row.reserveSlots), primaryBusy: false,
        lending: false, waiting: 0, waitingPrimary: 0, version: row.version, updatedAt: row.updatedAt }));
    },
  };
}

const DEVICE = "wpb-admin-device", FUTURE = "wpb-admin-future";
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { "wpb-budget": 4 }, groupLimits: { [DEVICE]: 2, "wpb-admin-fallback": 1 },
  poolLimits: { reviewer: 4, text: 4 }, weights: { first: 2, second: 1, background: 1 }, maxWaiting: 32, queueTtlMs: 60_000, reservationTtlMs: 30_000,
  routes: [
    { routeId: "crawl-agent-review", provider: "wpb-provider", model: "wpb-model", providerBudgetId: "wpb-budget", groupId: DEVICE },
    { routeId: "product-search-verify", provider: "wpb-provider", model: "wpb-model", providerBudgetId: "wpb-budget", groupId: DEVICE },
    { routeId: "crawl-tagline", provider: "wpb-provider", model: "wpb-model-2", providerBudgetId: "wpb-budget", groupId: "wpb-admin-fallback" },
  ] };
const sql = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
let originalControl: unknown, floor = 0;
/** 1b-A 의 표가 이 DB 에 있으면(합친 뒤) 이 파일이 만든 행만 지운다 — 다른 파일·운영 데이터는 건드리지 않는다 */
async function cleanupRealRows() {
  const [exists] = await sql`SELECT to_regclass('model_capacity_devices') IS NOT NULL AS present`;
  if (exists.present) await sql`DELETE FROM model_capacity_devices WHERE device_id LIKE 'wpb-admin-%'`;
}
beforeAll(async () => {
  ensureSchema();
  const real = await import("@/lib/llm/capacity-devices-repository").then(() => true, () => false);
  if (!real) { fake.active = true; setCapacityDeviceRepositoryForTest(inMemoryRepository()); }
  await cleanupRealRows();
  floor = await auditFloor();
  admin.login = { login: "operator" };
  // 공유 test DB 의 제어 행을 이 파일 동안만 바꾼다(다른 파일처럼 끝나면 그대로 되돌린다). 입장 판정은 부르지 않으므로 요청·이벤트 행은 생기지 않는다
  [originalControl] = (await sql`SELECT to_jsonb(c) AS value FROM model_capacity_control c WHERE id = 1`).map(row => row.value);
  await sql`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(policy)}::text::jsonb, policy_hash = ${modelCapacityPolicyHash(policy)}, cursor = 0, updated_at = clock_timestamp() WHERE id = 1`;
});
afterAll(async () => {
  setCapacityDeviceRepositoryForTest(null);
  try {
    await cleanupRealRows();
    if (originalControl) await sql`UPDATE model_capacity_control c SET mode = r.mode, epoch = r.epoch, revision = r.revision, policy = r.policy, policy_hash = r.policy_hash, cursor = r.cursor, updated_at = r.updated_at
      FROM jsonb_populate_recordset(NULL::model_capacity_control, ${JSON.stringify([originalControl])}::text::jsonb) r WHERE c.id = r.id`;
  } finally { await sql.end({ timeout: 3 }); }
});

const form = (entries: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(entries)) data.set(key, value); return data; };
const saved = () => auditRowsAfter(floor, AUDIT_ACTION).orderBy(desc(operationsAudit.id));
const BASE = { deviceId: DEVICE, expectedVersion: "", limitSlots: "4", secondaryCap: "1", idleSeconds: "60", reserveSlots: "1", physicalLimit: "4", note: "1차 심사 장비",
  "rank:crawl-agent-review": "1", "rank:product-search-verify": "2" };
const deviceView = async (deviceId: string) => {
  const { readCapacityDevicesAdminView } = await import("@/lib/operations/admin-capacity-devices");
  return (await readCapacityDevicesAdminView()).devices.find(entry => entry.deviceId === deviceId)!;
};

it("새 장비 저장 → 저장소의 감사 한 줄(before null·after·판 1, 여기서는 또 쓰지 않는다) → 화면 모형이 표 행·역할 순서·판·실시간 상태를 보인다", async () => {
  const { saveCapacityDevice } = await import("@/app/(operator)/admin/models/devices/actions");
  const { readCapacityDevicesAdminView } = await import("@/lib/operations/admin-capacity-devices");
  const view0 = await readCapacityDevicesAdminView();
  expect(view0.devices.map(device => [device.deviceId, device.source])).toEqual([[DEVICE, "policy_fallback"], ["wpb-admin-fallback", "policy_fallback"]]);
  expect(view0).toMatchObject({ mode: "open", policyVerified: true, controlError: null, rowsError: null, statesError: null });

  const result = await saveCapacityDevice(null, form(BASE));
  expect(result).toMatchObject({ ok: true, message: expect.stringContaining(`만들었습니다(장비 ${DEVICE}, 판 1)`) });
  expect(result?.message).toContain("DRAIN 불필요");
  if (fake.active) expect(fake.calls).toContain("save");
  const trail = await saved();
  expect(trail).toHaveLength(1);
  const [row] = trail;
  expect(row).toMatchObject({ actor: "operator", ok: true, action: AUDIT_ACTION, target: DEVICE, error: null });
  expect(row.detail).toMatchObject({ version: 1, expectedVersion: null, before: null,
    after: { limitSlots: 4, secondaryCap: 1, idleMs: 60_000, reserveSlots: 1, physicalLimit: 4, note: "1차 심사 장비", enabled: true,
      roles: [{ routeId: "crawl-agent-review", rank: 1 }, { routeId: "product-search-verify", rank: 2 }] } });

  const view = await readCapacityDevicesAdminView();
  const device = view.devices.find(entry => entry.deviceId === DEVICE)!;
  expect(device).toMatchObject({ source: "table", version: 1, updatedBy: "operator", enabled: true, issues: [],
    settings: { limitSlots: 4, secondaryCap: 1, idleMs: 60_000, reserveSlots: 1, physicalLimit: 4, note: "1차 심사 장비" },
    defaults: { limitSlots: 2, secondaryCap: 4, idleMs: 60_000, reserveSlots: 0 },
    roles: [{ routeId: "crawl-agent-review", rank: 1, label: "1차 검수", inPolicy: true }, { routeId: "product-search-verify", rank: 2, label: "키워드 검수", inPolicy: true }],
    live: { source: "table", active: 0, limitSlots: 4, secondaryActive: 0, secondaryBound: 3, lending: false, waiting: 0 } });
  expect(view.devices.find(entry => entry.deviceId === "wpb-admin-fallback")).toMatchObject({ source: "policy_fallback", version: null, settings: { limitSlots: 1, secondaryCap: 1 },
    issues: [expect.stringContaining("policy_fallback")] });
  expect(view.audit[0]).toMatchObject({ actor: "operator", ok: true, deviceId: DEVICE, version: 1 });
  expect(view.audit[0].changes).toEqual(expect.arrayContaining(["칸 수: 없음 → 4", "낮은 순위 평소 상한: 없음 → 1", "역할 순서: 없음 → crawl-agent-review=1, product-search-verify=2"]));
});

it("CAS — 옛 판으로 다시 저장하면 version_mismatch 를 한국어로 거절한다(저장소는 행도 감사도 건드리지 않고 던진다); 빈 판은 확인 없이 덮어쓴다", async () => {
  const { saveCapacityDevice } = await import("@/app/(operator)/admin/models/devices/actions");
  const count = (await saved()).length;
  // 판 1 로 저장 → 판 2
  expect(await saveCapacityDevice(null, form({ ...BASE, expectedVersion: "1", secondaryCap: "2" }))).toMatchObject({ ok: true, message: expect.stringContaining("판 2") });
  // 다른 탭이 아직 판 1 을 들고 있다
  const stale = await saveCapacityDevice(null, form({ ...BASE, expectedVersion: "1", secondaryCap: "3" }));
  expect(stale).toEqual({ issues: ["다른 사람이 먼저 저장했습니다(지금 판 2). 새로고침해 바뀐 값을 확인한 뒤 다시 저장해주세요."] });
  const trail = await saved();
  expect(trail).toHaveLength(count + 1);
  expect(trail[0]).toMatchObject({ ok: true, target: DEVICE });
  expect(trail[0].detail).toMatchObject({ version: 2, expectedVersion: 1, before: { secondaryCap: 1 }, after: { secondaryCap: 2 } });
  expect(await deviceView(DEVICE)).toMatchObject({ version: 2, settings: { secondaryCap: 2 } });
  // 새 장비로 만들려는데(expectedVersion 없음) 이미 있으면 CAS 없이 덮어쓴다 — 계약의 null 은 "확인하지 않음"이다
  expect(await saveCapacityDevice(null, form({ ...BASE, expectedVersion: "", secondaryCap: "3" }))).toMatchObject({ ok: true, message: expect.stringContaining("저장했습니다") });
  expect(await deviceView(DEVICE)).toMatchObject({ version: 3, settings: { secondaryCap: 3 } });
});

it("검사 거절 — 낮은 순위 상한 > 칸 수·엔진 실제 초과·비워 둘 칸 ≥ 칸 수·중복 경로는 저장되지 않고(감사도 없다) 이유가 한국어로 그대로 보인다", async () => {
  const { saveCapacityDevice } = await import("@/app/(operator)/admin/models/devices/actions");
  const count = (await saved()).length;
  const version = String((await deviceView(DEVICE)).version);
  expect(await saveCapacityDevice(null, form({ ...BASE, expectedVersion: version, secondaryCap: "5" }))).toEqual({ issues: ["낮은 순위 평소 상한: 0 이상, 칸 수 이하의 정수여야 합니다(칸 수를 넘을 수 없습니다)"] });
  expect(await saveCapacityDevice(null, form({ ...BASE, expectedVersion: version, limitSlots: "8", secondaryCap: "1" }))).toEqual({ issues: [expect.stringContaining("칸 수: 1~256 의 정수이고, 엔진 실제 동시 처리 수를 적었으면")] });
  expect(await saveCapacityDevice(null, form({ ...BASE, expectedVersion: version, reserveSlots: "4" }))).toEqual({ issues: [expect.stringContaining("항상 비워 둘 칸: 0 이상, 칸 수 미만")] });
  // 폼 단계에서 걸리는 중복은 저장 경로에 닿지 않는다
  const calls = fake.calls.length;
  expect(await saveCapacityDevice(null, form({ ...BASE, expectedVersion: version, "extraRoute:0": "crawl-agent-review", "extraRank:0": "3" })))
    .toEqual({ issues: ["역할 순서에 같은 경로가 두 번 있습니다: crawl-agent-review"] });
  if (fake.active) expect(fake.calls.length).toBe(calls);
  expect((await saved()).length).toBe(count);
  expect(await deviceView(DEVICE)).toMatchObject({ version: Number(version), settings: { secondaryCap: 3 } });
});

it("비관리자는 쓰기 관문 뒤에서 막히고 저장 경로·감사에 닿지 않는다; 정책 밖 장비 이름도 행으로 받는다", async () => {
  const { saveCapacityDevice } = await import("@/app/(operator)/admin/models/devices/actions");
  const count = (await saved()).length, calls = fake.calls.length;
  admin.login = null;
  try {
    expect(await saveCapacityDevice(null, form(BASE))).toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
  } finally { admin.login = { login: "operator" }; }
  expect((await saved()).length).toBe(count);
  if (fake.active) expect(fake.calls.length).toBe(calls);
  // 장비를 나누기 전에 행을 먼저 만드는 흐름(pr1-plan §2.7): 정책에 없는 이름
  expect(await saveCapacityDevice(null, form({ deviceId: FUTURE, expectedVersion: "", limitSlots: "2", secondaryCap: "2", idleSeconds: "0", reserveSlots: "0", physicalLimit: "", note: "",
    "extraRoute:0": "local-human-deepseek", "extraRank:0": "1" }))).toMatchObject({ ok: true });
  const future = await deviceView(FUTURE);
  expect(future).toMatchObject({ source: "table", policyRoutes: [], settings: { idleMs: 0, physicalLimit: null, note: null },
    roles: [{ routeId: "local-human-deepseek", rank: 1, inPolicy: false }] });
  expect(future.issues).toEqual([expect.stringContaining("어느 경로도 이 장비를 쓰지 않습니다"), "순위에 있지만 현재 정책에 없는 경로: local-human-deepseek"]);
});
