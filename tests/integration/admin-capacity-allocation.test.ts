import { desc } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { operationsAudit } from "@/lib/db/schema";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { MODEL_CAPACITY_ROUTE_QUOTA_SAVE_AUDIT_ACTION } from "@/lib/llm/capacity-devices";
import { readModelCapacityDevice, saveModelCapacityDevice } from "@/lib/llm/capacity-devices-repository";
import { auditFloor, auditRowsAfter, ensureSchema, TEST_DATABASE_URL } from "./setup";

/**
 * 칸 배분(step 3) server action → saveAdminRouteQuotas → 저장소 saveModelCapacityRouteQuotas(fence·control·장비 행 CAS·칸 수 검사·줄 교체·감사 한 줄)
 * → 화면 모형(readCapacityAllocationView: 장부 관측 안의 장비 상태). 관리자·next/cache·server-only 표시만 가짜고, 쓰기 관문·감사 표·용량 제어 행·
 * model_capacity_devices(0169 열과 DB 검사)는 진짜다. 장부 행(요청·이벤트)은 만들지 않는다 — 입장 판정은 tests/integration/capacity-route-quotas.test.ts 가 본다.
 */
const admin = vi.hoisted(() => ({ login: { login: "operator" } as { login: string } | null }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: async () => admin.login, localOperatorName: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const GPU = "alloc-it-gpu", SUPA = "alloc-it-supa", FALLBACK = "alloc-it-fallback";
const route = (routeId: string, groupId: string) => ({ routeId, provider: "alloc-provider", model: "alloc-model", providerBudgetId: "alloc-budget", groupId });
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 8, providerLimits: { "alloc-budget": 8 }, groupLimits: { [GPU]: 5, [SUPA]: 3, [FALLBACK]: 1 },
  poolLimits: { reviewer: 8, text: 8 }, weights: { first: 2, second: 1, background: 1 }, maxWaiting: 32, queueTtlMs: 60_000, reservationTtlMs: 30_000,
  routes: [route("crawl-publish-classify", GPU), route("crawl-agent-review", GPU), route("local-held-qwen", GPU), route("local-qwen-tiebreak", GPU), route("local-audit", GPU),
    route("second-review", SUPA), route("product-search-verify", SUPA), route("crawl-tagline", FALLBACK)] };
const sql = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
let originalControl: unknown, floor = 0;
const cleanup = () => sql`DELETE FROM model_capacity_devices WHERE device_id LIKE 'alloc-it-%'`;
async function configure(deviceId: string, limitSlots: number) {
  const current = await readModelCapacityDevice(deviceId);
  await db.transaction(tx => saveModelCapacityDevice(tx, { deviceId, limitSlots, secondaryCap: limitSlots, idleMs: 60_000, reserveSlots: 0, physicalLimit: null, roles: [], note: null },
    current?.version ?? null, "alloc-it"));
}
const stored = async (deviceId: string) => (await sql`SELECT version::int AS version, lend_idle, route_quotas FROM model_capacity_devices WHERE device_id = ${deviceId}`)[0];
const trail = () => auditRowsAfter(floor, MODEL_CAPACITY_ROUTE_QUOTA_SAVE_AUDIT_ACTION).orderBy(desc(operationsAudit.id));
const form = (entries: [string, string][]) => { const data = new FormData(); for (const [key, value] of entries) data.append(key, value); return data; };
const GPU_ROUTES = ["crawl-agent-review", "local-qwen-tiebreak", "local-held-qwen", "local-audit", "crawl-publish-classify"];
/** 장비 열 하나의 폼 — 그 열의 경로마다 보장·상한 칸(값이 없으면 빈 칸) */
const gpuForm = (version: number, values: Record<string, [string, string]>, lendIdle = true): FormData => form([["deviceId", GPU], ["expectedVersion", String(version)],
  ...(lendIdle ? [["lendIdle", "on"] as [string, string]] : []),
  ...GPU_ROUTES.flatMap((routeId): [string, string][] => [["route", routeId], [`min:${routeId}`, values[routeId]?.[0] ?? ""], [`max:${routeId}`, values[routeId]?.[1] ?? ""]])]);
const allocation = async () => (await import("@/lib/operations/admin-capacity-allocation")).readCapacityAllocationView();

beforeAll(async () => {
  ensureSchema();
  await cleanup();
  floor = await auditFloor();
  // 공유 test DB 의 제어 행을 이 파일 동안만 바꾼다(끝나면 그대로 되돌린다)
  [originalControl] = (await sql`SELECT to_jsonb(c) AS value FROM model_capacity_control c WHERE id = 1`).map(row => row.value);
  await sql`UPDATE model_capacity_control SET mode = 'open', policy = ${JSON.stringify(policy)}::text::jsonb, policy_hash = ${modelCapacityPolicyHash(policy)}, cursor = 0,
    revision = revision + 1, updated_at = clock_timestamp() WHERE id = 1`;
  await configure(GPU, 5);
  await configure(SUPA, 3);
});
afterAll(async () => {
  try {
    await cleanup();
    if (originalControl) await sql`UPDATE model_capacity_control c SET mode = r.mode, epoch = r.epoch, revision = r.revision, policy = r.policy, policy_hash = r.policy_hash, cursor = r.cursor, updated_at = r.updated_at
      FROM jsonb_populate_recordset(NULL::model_capacity_control, ${JSON.stringify([originalControl])}::text::jsonb) r WHERE c.id = r.id`;
  } finally { await sql.end({ timeout: 3 }); }
});

it("화면 모형: 장비 행이 있는 장비만 열, 정책 경로가 칸 — 몫이 없으면 빈 칸(오늘과 같음)·빌려 쓰기 켬", async () => {
  const view = await allocation();
  const mine = view.devices.filter(device => device.deviceId.startsWith("alloc-it-"));
  expect(mine.map(device => [device.deviceId, device.limitSlots, device.version, device.lendIdle, device.guaranteeSum])).toEqual([[GPU, 5, 1, true, 0], [SUPA, 3, 1, true, 0]]);
  expect(view.skipped).toEqual(expect.arrayContaining([{ deviceId: FALLBACK, reason: "policy_fallback" }]));
  const gpuIndex = view.devices.findIndex(device => device.deviceId === GPU);
  expect(view.devices[gpuIndex].routes).toEqual(GPU_ROUTES);
  const classify = view.rows.find(row => row.routeId === "crawl-publish-classify")!;
  expect(classify).toMatchObject({ label: "카테고리 분류" });
  expect(classify.cells[gpuIndex]).toMatchObject({ mapped: true, minSlots: null, maxSlots: null, active: 0, waiting: 0, settled1h: 0 });
  expect(view.rows.find(row => row.routeId === "second-review")).toMatchObject({ label: "2차 AI 검수 (투표자 1·2·3)" });
});

it("저장 → 저장소의 감사 한 줄(여기서는 또 쓰지 않는다)·판 +1·열 그대로 → 화면 모형이 새 몫·빌려 쓰기를 보인다", async () => {
  const { saveRouteQuotasAction } = await import("@/app/(operator)/admin/models/allocation/actions");
  // 운영자 예: 5칸을 다섯 영역에 1칸씩 보장, 카테고리 분류·1차 검수는 2칸까지
  const values: Record<string, [string, string]> = { "crawl-publish-classify": ["1", "2"], "crawl-agent-review": ["1", "2"], "local-held-qwen": ["1", "1"],
    "local-qwen-tiebreak": ["1", "1"], "local-audit": ["1", ""] };
  const result = await saveRouteQuotasAction(null, gpuForm(1, values, false));
  expect(result).toMatchObject({ ok: true, message: expect.stringContaining(`저장했습니다(장비 ${GPU}, 판 2)`), warnings: [] });
  expect(result?.changes).toEqual(["빈 칸 빌려 쓰기: 켬 → 끔", "1차 AI 검수: 없음 → 보장 1 · 상한 2", "카테고리 분류: 없음 → 보장 1 · 상한 2",
    "발행분 감사 · 직접 모델: 없음 → 보장 1 · 상한 없음", "보류 재심사: 없음 → 보장 1 · 상한 1", "2차 갈림 판가름: 없음 → 보장 1 · 상한 1"]);
  expect(await stored(GPU)).toEqual({ version: 2, lend_idle: false, route_quotas: [
    { route_id: "crawl-agent-review", min_slots: 1, max_slots: 2 }, { route_id: "crawl-publish-classify", min_slots: 1, max_slots: 2 },
    { route_id: "local-audit", min_slots: 1, max_slots: null }, { route_id: "local-held-qwen", min_slots: 1, max_slots: 1 },
    { route_id: "local-qwen-tiebreak", min_slots: 1, max_slots: 1 }] });
  const rows = await trail();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actor: "operator", ok: true, target: GPU, error: null });
  expect(rows[0].detail).toMatchObject({ version: 2, expectedVersion: 1, limitSlots: 5, warnings: [], before: { lendIdle: true, quotas: [] },
    after: { lendIdle: false, quotas: expect.arrayContaining([{ routeId: "local-audit", minSlots: 1, maxSlots: null, cap: 1 }]) } });
  const view = await allocation();
  const gpuIndex = view.devices.findIndex(device => device.deviceId === GPU);
  expect(view.devices[gpuIndex]).toMatchObject({ version: 2, lendIdle: false, guaranteeSum: 5, over: false, lines: 5 });
  expect(view.rows.find(row => row.routeId === "local-audit")!.cells[gpuIndex]).toMatchObject({ minSlots: 1, maxSlots: null, cap: 1 });
  // 다른 장비는 그대로
  expect(await stored(SUPA)).toEqual({ version: 1, lend_idle: true, route_quotas: [] });
});

it("CAS·칸 수 검사 거절은 한국어로 그대로 보이고 행·감사를 남기지 않는다", async () => {
  const { saveRouteQuotasAction } = await import("@/app/(operator)/admin/models/allocation/actions");
  const count = (await trail()).length;
  // 다른 탭이 아직 판 1 을 들고 있다
  expect(await saveRouteQuotasAction(null, gpuForm(1, {}))).toEqual({ issues: [
    "다른 곳(장비 한도·칸 배분)에서 이 장비를 먼저 저장했습니다(지금 판 2). 새로고침해 바뀐 값을 확인한 뒤 다시 저장해주세요."] });
  // 보장 합 6 > 칸 5
  expect(await saveRouteQuotasAction(null, gpuForm(2, { "crawl-publish-classify": ["2", ""], "crawl-agent-review": ["1", ""], "local-held-qwen": ["1", ""],
    "local-qwen-tiebreak": ["1", ""], "local-audit": ["1", ""] }))).toEqual({ issues: ["보장 칸 합계가 장비 칸 수를 넘습니다 — 보장을 줄이거나, 장비 한도에서 칸 수를 먼저 늘려 주세요."] });
  // 상한 6 > 칸 5 — 그 줄의 작업 영역 이름으로
  expect(await saveRouteQuotasAction(null, gpuForm(2, { "crawl-publish-classify": ["1", "6"] }))).toEqual({ issues: ["카테고리 분류: 상한 칸이 장비 칸 수보다 많습니다 — 장비 칸 수 이하로 적어주세요."] });
  // 폼 단계에서 걸리는 보장 > 상한은 저장 경로에 닿지 않는다
  expect(await saveRouteQuotasAction(null, gpuForm(2, { "local-audit": ["2", "1"] }))).toEqual({ issues: ["발행분 감사 · 직접 모델: 보장 칸(2)이 상한 칸(1)보다 많습니다"] });
  // 장비 행이 없는(정책 대체) 장비
  expect(await saveRouteQuotasAction(null, form([["deviceId", FALLBACK], ["expectedVersion", "1"], ["lendIdle", "on"], ["route", "crawl-tagline"], ["min:crawl-tagline", "1"],
    ["max:crawl-tagline", ""]]))).toEqual({ issues: ["이 장비는 장비 행이 없거나 꺼져 있어 칸을 나눌 수 없습니다 — 장비 한도에서 장비 행을 먼저 저장하거나 켜 주세요."] });
  expect((await trail()).length).toBe(count);
  expect(await stored(GPU)).toMatchObject({ version: 2, lend_idle: false });
});

it("정책이 이 장비로 보내지 않는 경로의 몫은 저장하고 경고한다; 모든 칸을 비우면 오늘과 같은 빈 목록으로 돌아간다; 비관리자는 닿지 않는다", async () => {
  const { saveRouteQuotasAction } = await import("@/app/(operator)/admin/models/allocation/actions");
  const unmapped = await saveRouteQuotasAction(null, form([["deviceId", SUPA], ["expectedVersion", "1"], ["lendIdle", "on"], ["route", "second-review"], ["min:second-review", "2"],
    ["max:second-review", "3"], ["route", "local-screen"], ["min:local-screen", "0"], ["max:local-screen", "0"]]));
  expect(unmapped).toMatchObject({ ok: true, changes: ["화면 판별: 없음 → 보장 0 · 상한 0(뺌)", "2차 AI 검수 (투표자 1·2·3): 없음 → 보장 2 · 상한 3"],
    warnings: ["화면 판별: 지금 정책에서 이 장비로 오지 않습니다 — 몫은 저장했고, 이 장비로 오면 그때부터 적용됩니다."] });
  const view = await allocation();
  const supaIndex = view.devices.findIndex(device => device.deviceId === SUPA);
  expect(view.rows.find(row => row.routeId === "local-screen")!.cells[supaIndex]).toMatchObject({ mapped: false, minSlots: 0, maxSlots: 0 });
  expect(view.devices[supaIndex].routes).toEqual(["second-review", "product-search-verify", "local-screen"]);

  const count = (await trail()).length;
  admin.login = null;
  try {
    expect(await saveRouteQuotasAction(null, gpuForm(2, {}))).toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
  } finally { admin.login = { login: "operator" }; }
  expect((await trail()).length).toBe(count);

  expect(await saveRouteQuotasAction(null, gpuForm(2, {}))).toMatchObject({ ok: true, message: expect.stringContaining("판 3") });
  expect(await stored(GPU)).toEqual({ version: 3, lend_idle: true, route_quotas: [] });
  // 장비 한도 저장은 몫을 그대로 두고 판만 올린다 — 칸 배분의 다음 저장은 새 판으로 해야 한다
  await configure(SUPA, 3);
  expect(await stored(SUPA)).toMatchObject({ version: 3, route_quotas: [{ route_id: "local-screen", min_slots: 0, max_slots: 0 }, { route_id: "second-review", min_slots: 2, max_slots: 3 }] });
});
