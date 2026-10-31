import { desc, sql as drizzleSql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { operationsAudit } from "@/lib/db/schema";
import {
  HELPER_AUDIT_ACTIONS, HELPER_MODE_AUDIT_ACTION, HELPER_SAVE_AUDIT_ACTION, helperEvidenceKey, parseHelperAssignment, SUPERVISOR_PRINCIPAL,
  SUPERVISOR_TOGGLE_AUDIT_ACTION, supervisorControlPatchSchema, supervisorControlTimingValid,
  type HelperAssignmentRow, type HelperStopRow, type SupervisorControlRow,
} from "@/lib/llm/capacity-helpers";
import { adminAuditRow } from "@/lib/operations/admin-log";
import { setCapacityHelpersRepositoryForTest, type HelperRepository } from "@/lib/operations/admin-model-helpers";
import { auditFloor, auditRowsAfter, ensureSchema } from "./setup";

/**
 * 도우미 장비 server action → admin-model-helpers → 저장소(감사 한 줄 포함) → 화면 모형(PR 2a WP-2a-C). 관리자·next/cache 만 가짜고 쓰기 관문
 * (fence 읽기·TX 첫 lock)·감사 표·감시자 control 행(0154 seed)은 진짜다.
 *
 * WP-2a-A 저장소(@/lib/llm/capacity-helpers-repository)의 본문은 아직 stub 이라 같은 계약 — zod(parseHelperAssignment)·CAS(version)·거절 코드·
 * evidence_key·감사 한 줄(target = assignment_id, detail { version, expectedVersion, before, after })·거절은 감사 없이 던짐 — 의 메모리 구현을
 * setCapacityHelpersRepositoryForTest 로 끼운다. 저장소 파일은 건드리지 않는다. 표·입장 판정은 WP-2a-A 의 tests/integration/model-capacity-helpers.test.ts 가 본다.
 */
const admin = vi.hoisted(() => ({ login: null as { login: string } | null }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: async () => admin.login, localOperatorName: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const DEVICE = "wpc-helper-m3", PRIMARY_DEVICE = "wpc-helper-primary", UNKNOWN_DEVICE = "wpc-helper-missing";
const ID = `${DEVICE}:ai1`;
const nowIso = () => new Date().toISOString();
const fake = {
  calls: [] as string[],
  rows: new Map<string, HelperAssignmentRow>(),
  stops: [] as HelperStopRow[],
  control: null as SupervisorControlRow | null,
};
const resetFake = () => {
  fake.calls.length = 0; fake.rows.clear(); fake.stops.length = 0;
  fake.control = { enabled: false, signalPrincipal: SUPERVISOR_PRINCIPAL, signalTtlMs: 45_000, loopMs: 15_000, ownerInstanceId: null, ownerBootId: null, epoch: 0,
    leaseUntil: null, heartbeatAt: null, loopSeq: 0, release: null, updatedBy: "migration:0154", updatedAt: nowIso() };
};
const settingsOf = (row: HelperAssignmentRow) => ({ ...row });

function inMemoryRepository(): HelperRepository {
  /** 계약: 저장 TX 는 fence(관문이 첫 lock 으로 잡았다) → control FOR UPDATE — 여기서는 0154 의 seed 행이 있고 같은 TX 를 받는다는 것만 본다 */
  const lockSupervisor = async (tx: Parameters<HelperRepository["setSupervisorControl"]>[0]) => {
    const rows = await tx.execute<{ id: number }>(drizzleSql`SELECT id FROM model_supervisor_control WHERE id = 1 FOR UPDATE`);
    if (!rows.length) throw new Error("model_supervisor_control_missing");
  };
  const write = async (tx: Parameters<HelperRepository["setSupervisorControl"]>[0], action: string, target: string, actor: string, detail: Record<string, unknown>) =>
    tx.insert(operationsAudit).values(await adminAuditRow(actor, { action, target, detail }));
  return {
    async saveHelperAssignment(tx, input, expectedVersion, actor) {
      fake.calls.push("save");
      await lockSupervisor(tx);
      const value = parseHelperAssignment(input);
      if (value.deviceId === UNKNOWN_DEVICE) throw new Error("model_helper_refused:helper_device_unconfigured");
      // 이 장비에서 도우미 경로가 rank 1 이라고 가정한 장비
      if (value.deviceId === PRIMARY_DEVICE) throw new Error("model_helper_refused:helper_route_is_primary");
      const before = fake.rows.get(value.assignmentId) ?? null;
      if (expectedVersion !== null && (before?.version ?? null) !== expectedVersion) throw new Error(`model_helper_version_mismatch:${before?.version ?? "none"}`);
      if (expectedVersion === null && before) throw new Error(`model_helper_version_mismatch:${before.version}`);
      if (value.mode === "live" && !before?.promotedAt) throw new Error("model_helper_refused:helper_live_requires_promotion");
      const evidenceKey = helperEvidenceKey({ stage: value.stage, model: value.model, promptVersion: "p1", rulesVersion: "r1", wireVariant: "json_schema",
        contractHash: `${value.shadowRouteId}|${value.liveRouteId}|${value.liveProvider}` });
      const at = nowIso();
      const after: HelperAssignmentRow = { ...value, version: (before?.version ?? 0) + 1, evidenceKey, promotedAt: before?.promotedAt ?? null,
        promotedBy: before?.promotedBy ?? null, updatedBy: actor, createdAt: before?.createdAt ?? at, updatedAt: at };
      fake.rows.set(after.assignmentId, after);
      await write(tx, HELPER_SAVE_AUDIT_ACTION, after.assignmentId, actor, { version: after.version, expectedVersion, before: before && settingsOf(before), after: settingsOf(after) });
      return { before: before ? structuredClone(before) : null, after: structuredClone(after) };
    },
    async setHelperMode(tx, assignmentId, mode, expectedVersion, actor) {
      fake.calls.push(`mode:${mode}`);
      await lockSupervisor(tx);
      const before = fake.rows.get(assignmentId);
      if (!before || before.version !== expectedVersion) throw new Error(`model_helper_version_mismatch:${before?.version ?? "none"}`);
      const after: HelperAssignmentRow = { ...before, mode, version: before.version + 1, updatedBy: actor, updatedAt: nowIso() };
      fake.rows.set(assignmentId, after);
      await write(tx, HELPER_MODE_AUDIT_ACTION, assignmentId, actor, { version: after.version, expectedVersion, before: settingsOf(before), after: settingsOf(after) });
      return { before: structuredClone(before), after: structuredClone(after) };
    },
    async listHelperAssignments() { fake.calls.push("list"); return [...fake.rows.values()].map(row => structuredClone(row)); },
    async setSupervisorControl(tx, patch, actor) {
      fake.calls.push("control");
      const parsed = supervisorControlPatchSchema.safeParse(patch);
      if (!parsed.success) throw new Error(`model_supervisor_invalid:${parsed.error.issues[0]?.path.join(".") || "root"}`);
      await lockSupervisor(tx);
      const before = fake.control!;
      const after = { ...before, ...parsed.data, updatedBy: actor, updatedAt: nowIso() };
      if (!supervisorControlTimingValid(after)) throw new Error("model_supervisor_invalid:loopMs");
      fake.control = after;
      const slice = (row: SupervisorControlRow) => ({ enabled: row.enabled, signalTtlMs: row.signalTtlMs, loopMs: row.loopMs });
      await write(tx, SUPERVISOR_TOGGLE_AUDIT_ACTION, "model_supervisor_control", actor, { before: slice(before), after: slice(after) });
    },
    async readHelperStatusSnapshot() {
      fake.calls.push("snapshot");
      const assignments = [...fake.rows.values()].map(row => structuredClone(row));
      const current = new Map(assignments.map(row => [row.assignmentId, row.version]));
      return { nowMs: Date.now(), control: structuredClone(fake.control!), assignments, signals: [], deviceSignals: [], roleDemand: [],
        stops: fake.stops.filter(stop => current.get(stop.assignmentId) === stop.assignmentVersion).map(stop => structuredClone(stop)),
        gates: assignments.flatMap(row => (["live", "shadow"] as const).map(kind => ({ assignmentId: row.assignmentId, kind,
          routeId: kind === "live" ? row.liveRouteId : row.shadowRouteId, provider: kind === "live" ? row.liveProvider : "local-direct", model: row.model,
          ok: false, active: 0, maxSlots: row.maxSlots }))) };
    },
  };
}

let floor = 0;
beforeAll(async () => {
  ensureSchema();
  floor = await auditFloor();
  setCapacityHelpersRepositoryForTest(inMemoryRepository());
  admin.login = { login: "operator" };
});
beforeEach(() => { admin.login = { login: "operator" }; });
afterAll(() => { setCapacityHelpersRepositoryForTest(null); });
resetFake();

const form = (entries: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(entries)) data.set(key, value); return data; };
const trail = () => auditRowsAfter(floor).orderBy(desc(operationsAudit.id)).then(rows => rows.filter(row => (HELPER_AUDIT_ACTIONS as readonly string[]).includes(row.action)));
const BASE = { expectedVersion: "", assignmentId: "", stage: "ai1", deviceId: DEVICE, mode: "off", model: "deepseek-v4.1-flash-1017",
  shadowRouteId: "local-helper-shadow-ai1", liveRouteId: "local-ai1-helper", liveProvider: "local-direct", maxSlots: "1", perTick: "2", shadowPerHour: "30",
  minShadowSamples: "200", enterSamples: "2", exitSamples: "4", minAgreementPct: "95", maxWrongApprovalPct: "1", maxWrongRejectionPct: "2",
  maxUnknownRatePct: "2", maxFailureRatePct: "10", maxLiveDisagreementPct: "10", minHelpSeconds: "120", reenterCooldownSeconds: "60", note: "M3 DeepSeek 1차 도우미" };
const helperView = async () => {
  const { readModelHelpersAdminView } = await import("@/lib/operations/admin-model-helpers");
  return readModelHelpersAdminView();
};

it("0154 가 감시자 control 행(id=1, 꺼짐)을 심었다 — 저장 TX 가 그 행을 잠근다", async () => {
  const [row] = await db.execute<{ enabled: boolean; signal_principal: string; signal_ttl_ms: number; loop_ms: number }>(
    drizzleSql`SELECT enabled, signal_principal, signal_ttl_ms, loop_ms FROM model_supervisor_control WHERE id = 1`);
  expect(row).toMatchObject({ signal_principal: SUPERVISOR_PRINCIPAL, signal_ttl_ms: 45_000, loop_ms: 15_000 });
});

it("새 배정 → 저장소의 감사 한 줄(before null·판 1, 여기서는 또 쓰지 않는다) → 화면 모형이 배정·쉬는 중(감시자 꺼짐)·자동 정지 없음을 보인다", async () => {
  const { saveModelHelper } = await import("@/app/(operator)/admin/models/helpers/actions");
  const view0 = await helperView();
  expect(view0).toMatchObject({ snapshotError: null, helpers: [], supervisor: { enabled: false, badge: "off" } });
  const result = await saveModelHelper(null, form(BASE));
  expect(result).toMatchObject({ ok: true, message: expect.stringContaining(`만들었습니다(배정 ${ID}, 판 1, 모드 꺼짐)`) });
  const rows = await trail();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actor: "operator", ok: true, action: HELPER_SAVE_AUDIT_ACTION, target: ID, error: null });
  expect(rows[0].detail).toMatchObject({ version: 1, expectedVersion: null, before: null,
    after: { assignmentId: ID, mode: "off", minAgreement: 0.95, minHelpMs: 120_000, note: "M3 DeepSeek 1차 도우미" } });
  const view = await helperView();
  expect(view.helpers).toHaveLength(1);
  expect(view.helpers[0]).toMatchObject({ assignmentId: ID, stageLabel: "1차 검수", modeLabel: "꺼짐", version: 1, verdict: "hold", reasonLabel: "감시자 꺼짐",
    gates: { live: { ok: false }, shadow: { ok: false } }, stops: [] });
  expect(view.audit[0]).toMatchObject({ actionLabel: "배정 저장", target: ID, version: 1, ok: true });
  expect(view.audit[0].changes).toEqual(expect.arrayContaining(["최소 일치율: 없음 → 95%", "모드: 없음 → 꺼짐"]));
});

it("CAS — 옛 판으로 저장·모드 바꾸기·자동 정지 해제는 한국어로 거절하고(저장소는 행도 감사도 건드리지 않는다), 맞는 판이면 판이 오른다", async () => {
  const { saveModelHelper, changeModelHelperMode } = await import("@/app/(operator)/admin/models/helpers/actions");
  const count = (await trail()).length;
  expect(await saveModelHelper(null, form({ ...BASE, expectedVersion: "1", assignmentId: ID, minAgreementPct: "96" })))
    .toMatchObject({ ok: true, message: expect.stringContaining("판 2") });
  // 다른 탭이 아직 판 1 을 들고 있다
  expect(await saveModelHelper(null, form({ ...BASE, expectedVersion: "1", assignmentId: ID, minAgreementPct: "97" })))
    .toEqual({ issues: ["다른 사람이 먼저 저장했습니다(지금 판 2). 새로고침해 주세요."] });
  expect(await changeModelHelperMode(null, form({ assignmentId: ID, expectedVersion: "1", mode: "shadow" })))
    .toEqual({ issues: ["다른 사람이 먼저 저장했습니다(지금 판 2). 새로고침해 주세요."] });
  // 새 배정으로 다시 만들려 해도(판 없음) 이미 있으면 거절
  expect(await saveModelHelper(null, form(BASE))).toEqual({ issues: ["다른 사람이 먼저 저장했습니다(지금 판 2). 새로고침해 주세요."] });
  const rows = await trail();
  expect(rows).toHaveLength(count + 1);
  expect(rows[0].detail).toMatchObject({ version: 2, expectedVersion: 1, before: { minAgreement: 0.95 }, after: { minAgreement: 0.96 } });
  expect((await helperView()).helpers[0]).toMatchObject({ version: 2, settings: { minAgreement: 0.96 } });
  // 맞는 판의 모드 바꾸기 → 판 3·감사 한 줄(model-helper-mode)
  expect(await changeModelHelperMode(null, form({ assignmentId: ID, expectedVersion: "2", mode: "shadow" })))
    .toMatchObject({ ok: true, message: expect.stringContaining("모드를 꺼짐 → 섀도(으)로 바꿨습니다(배정 wpc-helper-m3:ai1, 판 3)") });
  const [mode] = await trail();
  expect(mode).toMatchObject({ action: HELPER_MODE_AUDIT_ACTION, target: ID, ok: true });
  expect(mode.detail).toMatchObject({ version: 3, expectedVersion: 2, before: { mode: "off" }, after: { mode: "shadow" } });
  // 실전은 승격(PR 2c)만 — 저장소에 닿지 않는다
  const calls = fake.calls.length;
  expect(await changeModelHelperMode(null, form({ assignmentId: ID, expectedVersion: "3", mode: "live" })))
    .toEqual({ issues: ["실전은 승격으로만 켤 수 있습니다(섀도 근거·확인 「실전」 — PR 2c)."] });
  expect(fake.calls.length).toBe(calls);
});

it("자동 정지 해제 — 같은 모드로 다시 저장해 판이 오르고 옛 판의 정지는 화면에서 사라진다(행은 남는다)", async () => {
  const { clearModelHelperStop } = await import("@/app/(operator)/admin/models/helpers/actions");
  const row = fake.rows.get(ID)!;
  fake.stops.push({ id: 1, assignmentId: ID, assignmentVersion: row.version, effect: "stop", reason: "unknown_rate", evidence: { n: 10, unknown: 3 },
    createdAt: nowIso(), writtenBy: SUPERVISOR_PRINCIPAL });
  const stopped = await helperView();
  expect(stopped.stops).toHaveLength(1);
  expect(stopped.helpers[0].stops).toMatchObject([{ effectLabel: "자동 정지(실전·섀도 모두 닫힘)", reasonLabel: "확인 못함 비율 초과" }]);
  expect(await clearModelHelperStop(null, form({ assignmentId: ID, expectedVersion: String(row.version - 1) })))
    .toEqual({ issues: [`다른 사람이 먼저 저장했습니다(지금 판 ${row.version}). 새로고침해 주세요.`] });
  expect(await clearModelHelperStop(null, form({ assignmentId: ID, expectedVersion: String(row.version) })))
    .toMatchObject({ ok: true, message: expect.stringContaining(`자동 정지를 풀었습니다(배정 ${ID}, 판 ${row.version + 1}, 모드 섀도)`) });
  const view = await helperView();
  expect(view.stops).toEqual([]);
  expect(view.helpers[0]).toMatchObject({ version: row.version + 1, mode: "shadow", stops: [] });
  expect(fake.stops).toHaveLength(1);
  const [last] = await trail();
  expect(last).toMatchObject({ action: HELPER_MODE_AUDIT_ACTION, target: ID });
  expect(last.detail).toMatchObject({ before: { mode: "shadow" }, after: { mode: "shadow" } });
});

it("저장 거절 — 도우미 경로가 우선 역할·장비 행 없음은 이유가 그대로 보이고 감사가 없다", async () => {
  const { saveModelHelper } = await import("@/app/(operator)/admin/models/helpers/actions");
  const count = (await trail()).length;
  expect(await saveModelHelper(null, form({ ...BASE, deviceId: PRIMARY_DEVICE })))
    .toEqual({ issues: ["도우미 경로가 이 장비의 우선 역할입니다 — 장비 한도에서 순위를 2 이상으로 바꿔 주세요(/admin/models/devices)."] });
  expect(await saveModelHelper(null, form({ ...BASE, deviceId: UNKNOWN_DEVICE })))
    .toEqual({ issues: [expect.stringContaining("도우미 장비 행이 없습니다")] });
  // zod(저장소) 거절도 문장으로 — 섀도 경로 = 실전 경로
  expect(await saveModelHelper(null, form({ ...BASE, stage: "ai2", shadowRouteId: "second-review", liveRouteId: "second-review" })))
    .toEqual({ issues: ["섀도 경로: 1~120자, 앞뒤 공백·제어 문자 없이, 실전 경로와 달라야 합니다"] });
  expect(await saveModelHelper(null, form({ ...BASE, stage: "ai2", minAgreementPct: "40" }))).toEqual({ issues: ["최소 일치율: 50~100% 의 백분율(소수 한 자리까지)이어야 합니다"] });
  expect((await trail()).length).toBe(count);
});

it("감시자 전체 스위치 — 켜기는 확인 칸이 있어야 하고, 켜고 끄면 감사가 한 줄씩; 화면 배지는 꺼짐 → 늦음(lease 없음) → 꺼짐", async () => {
  const { switchCapacitySupervisor, saveCapacitySupervisorTiming } = await import("@/app/(operator)/admin/models/helpers/actions");
  const count = (await trail()).length, calls = fake.calls.length;
  expect(await switchCapacitySupervisor(null, form({ enabled: "true" }))).toEqual({ issues: [expect.stringContaining("확인 칸")] });
  expect(fake.calls.length).toBe(calls);
  expect(await switchCapacitySupervisor(null, form({ enabled: "true", confirm: "yes" }))).toMatchObject({ ok: true, message: expect.stringContaining("감시자를 켰습니다") });
  expect(fake.control).toMatchObject({ enabled: true, updatedBy: "operator" });
  const on = await helperView();
  // 켰지만 감시자가 lease 를 잡은 적이 없다 → 늦음, 도우미는 쉬는 중(lease 만료)
  expect(on.supervisor).toMatchObject({ enabled: true, badge: "late", leaseAlive: false });
  expect(on.helpers[0]).toMatchObject({ verdict: "hold", reasonLabel: "감시자 lease 만료(감시자가 돌지 않음)" });
  expect(on.issues).toEqual([expect.stringContaining("lease 가 만료")]);
  expect(await switchCapacitySupervisor(null, form({ enabled: "false" }))).toMatchObject({ ok: true, message: expect.stringContaining("돌고 있는 호출은 끝까지 갑니다") });
  expect(fake.control).toMatchObject({ enabled: false });
  expect((await helperView()).supervisor).toMatchObject({ badge: "off", enabled: false });
  const rows = (await trail()).slice(0, 2);
  expect(rows.map(row => [row.action, row.target, (row.detail as { after: { enabled: boolean } }).after.enabled]))
    .toEqual([[SUPERVISOR_TOGGLE_AUDIT_ACTION, "model_supervisor_control", false], [SUPERVISOR_TOGGLE_AUDIT_ACTION, "model_supervisor_control", true]]);
  expect((await helperView()).audit.find(row => row.action === SUPERVISOR_TOGGLE_AUDIT_ACTION)?.changes).toEqual(["감시자 전체 스위치: 켜짐 → 꺼짐"]);
  // 순환 설정: 순환 × 2 > 유효 시간은 저장소 전에 거절, 맞으면 저장
  const before = fake.calls.length;
  expect(await saveCapacitySupervisorTiming(null, form({ signalTtlSeconds: "30", loopSeconds: "20" }))).toEqual({ issues: [expect.stringContaining("순환 간격 × 2 ≤ 신호 유효 시간")] });
  expect(fake.calls.length).toBe(before);
  expect(await saveCapacitySupervisorTiming(null, form({ signalTtlSeconds: "60", loopSeconds: "20" }))).toMatchObject({ ok: true });
  expect(fake.control).toMatchObject({ signalTtlMs: 60_000, loopMs: 20_000, enabled: false });
  expect((await trail()).length).toBe(count + 3);
});

it("비관리자는 쓰기 관문 뒤에서 막히고 저장소·감사에 닿지 않는다", async () => {
  const actions = await import("@/app/(operator)/admin/models/helpers/actions");
  const count = (await trail()).length, calls = fake.calls.length;
  admin.login = null;
  for (const action of [actions.saveModelHelper, actions.changeModelHelperMode, actions.clearModelHelperStop, actions.switchCapacitySupervisor, actions.saveCapacitySupervisorTiming])
    expect(await action(null, form({ ...BASE, assignmentId: ID, expectedVersion: "1", enabled: "false", signalTtlSeconds: "45", loopSeconds: "15" })))
      .toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
  expect((await trail()).length).toBe(count);
  expect(fake.calls.length).toBe(calls);
  // 이 파일이 남긴 감사 줄은 모두 도우미 action 이다(장비·다른 action 을 쓰지 않았다)
  const mine = (await auditRowsAfter(floor)).filter(row => [ID, "model_supervisor_control"].includes(row.target));
  expect(new Set(mine.map(row => row.action))).toEqual(new Set([HELPER_SAVE_AUDIT_ACTION, HELPER_MODE_AUDIT_ACTION, SUPERVISOR_TOGGLE_AUDIT_ACTION]));
});
