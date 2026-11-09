import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 도우미 장비 화면(PR 2a WP-2a-C) — 화면 모형·폼 → 저장 입력·거절 문장·그리기·server action. DB 없이 본다; WP-2a-A 의 저장 본문은 가짜다.
const mocks = vi.hoisted(() => ({ admin: vi.fn(), save: vi.fn(), mode: vi.fn(), clear: vi.fn(), supervisor: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/operations/admin-model-helpers", async importOriginal => ({ ...(await importOriginal<object>()),
  saveAdminModelHelper: mocks.save, setAdminModelHelperMode: mocks.mode, clearAdminModelHelperStops: mocks.clear, setAdminSupervisorControl: mocks.supervisor }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));

import { changeModelHelperMode, clearModelHelperStop, saveCapacitySupervisorTiming, saveModelHelper, switchCapacitySupervisor } from "@/app/(operator)/admin/models/helpers/actions";
import { HelperForm, msToSecondsText, ratioToPercentText } from "@/app/(operator)/admin/models/helpers/HelperForm";
import { HelperTable } from "@/app/(operator)/admin/models/helpers/HelperTable";
import { clientAgeLabel, clientDurationLabel, SupervisorCard } from "@/app/(operator)/admin/models/helpers/SupervisorCard";
import { NAV_GROUPS } from "@/app/(operator)/admin/AdminNav";
import { modelsAdvancedEditor } from "@/app/(operator)/admin/workspace-navigation";
import {
  HELPER_REASONS, HELPER_ROUTE_DEFAULTS, HELPER_SAVE_REFUSALS, helperAssignmentSchema, parseHelperAssignment, SUPERVISOR_PRINCIPAL,
  type HelperAssignmentRow, type HelperSignalRow, type HelperStatusSnapshot, type HelperStopRow, type SupervisorControlRow,
} from "@/lib/llm/capacity-helpers";
import type { AdminLogRow } from "@/lib/operations/admin-log";
import {
  ageLabel, buildModelHelpersAdminView, durationLabel, HELPER_INPUT_KEYS, HELPER_REASON_LABELS, HELPER_REFUSAL_MESSAGES, HELPER_SETTING_DEFAULTS,
  helperAssignmentInputFromForm, helperAuditChangeLines, helperInputOf, modelHelperIssueMessage, msToSecondsInput, percentInputToRatio, percentLabel,
  ratioToPercentInput, secondsInputToMs, setCapacityHelpersRepositoryForTest, supervisorLocation, supervisorTimingFromForm, type HelperRepository,
} from "@/lib/operations/admin-model-helpers";

const NOW_MS = Date.parse("2026-10-31T12:00:00.000Z");
const NOW = new Date(NOW_MS);
const at = (offsetMs: number) => new Date(NOW_MS + offsetMs).toISOString();
const EK = "a".repeat(64), EK2 = "b".repeat(64);
const control = (over: Partial<SupervisorControlRow> = {}): SupervisorControlRow => ({ enabled: true, signalPrincipal: SUPERVISOR_PRINCIPAL, signalTtlMs: 45_000,
  loopMs: 15_000, ownerInstanceId: "oracle-osaka-1", ownerBootId: "6d7f0f53-4d39-4b9d-a5a6-3a4a8f0c1b11", epoch: 4, leaseUntil: at(30_000),
  heartbeatAt: at(-5_000), loopSeq: 120, release: "r2026.10.31", updatedBy: "jr", updatedAt: at(-3_600_000), ...over });
const assignment = (over: Partial<HelperAssignmentRow> & { assignmentId: string; stage: "ai1" | "ai2" }): HelperAssignmentRow => ({
  ...parseHelperAssignment({ assignmentId: over.assignmentId, stage: over.stage, deviceId: "m3-deepseek", model: "deepseek-v4.1-flash-1017",
    ...HELPER_ROUTE_DEFAULTS[over.stage], mode: "shadow" }),
  version: 3, evidenceKey: EK, promotedAt: null, promotedBy: null, updatedBy: "jr", createdAt: at(-86_400_000), updatedAt: at(-60_000), ...over });
const signal = (over: Partial<HelperSignalRow> & { assignmentId: string }): HelperSignalRow => ({ assignmentVersion: 3, supervisorEpoch: 4,
  verdict: "shadow_only", reason: "primary_not_full", streak: 1, stateSince: at(-600_000), lastExitAt: null, metrics: {}, observedAt: at(-4_000),
  validUntil: at(41_000), writtenBy: SUPERVISOR_PRINCIPAL, ...over });
const stop = (over: Partial<HelperStopRow> & { id: number }): HelperStopRow => ({ assignmentId: "m3-deepseek:ai1", assignmentVersion: 3, effect: "stop",
  reason: "unknown_rate", evidence: { n: 12, unknown: 3, note: "<b>raw</b>" }, createdAt: at(-120_000), writtenBy: SUPERVISOR_PRINCIPAL, ...over });
const AI1 = assignment({ assignmentId: "m3-deepseek:ai1", stage: "ai1" });
const AI2 = assignment({ assignmentId: "m3-deepseek:ai2", stage: "ai2", mode: "off", version: 2, evidenceKey: EK2, note: "2차 도우미" });
const snapshot = (over: Partial<HelperStatusSnapshot> = {}): HelperStatusSnapshot => ({
  nowMs: NOW_MS, control: control(), assignments: [AI2, AI1],
  signals: [
    signal({ assignmentId: AI1.assignmentId, metrics: { primaryFull: false, primaryActive: 3, primaryLimit: 4, primaryWaiting: 0, primaryDevices: 2,
      shadowSamples: 42, shadowAgreement: 0.952, shadowWrongApproval: 0.012, shadowWrongRejection: 0.005, shadowUnknownRate: 0, shadowFailureRate: 0.024, extra: "x" } }),
    // 저장 전 판(1)의 신호 — 지금 판은 2 라 쓸 수 없다
    signal({ assignmentId: AI2.assignmentId, assignmentVersion: 1, verdict: "hold", reason: "mode_off" }),
  ],
  stops: [stop({ id: 7 }), stop({ id: 3, assignmentVersion: 2, reason: "failure_rate", createdAt: at(-7_200_000) })],
  deviceSignals: [{ deviceId: "m3-deepseek", supervisorEpoch: 4, primaryDemand: false, backlog: 0, metrics: { reason: "fresh" }, observedAt: at(-4_000),
    validUntil: at(41_000), writtenBy: SUPERVISOR_PRINCIPAL }],
  roleDemand: [{ roleId: "human-review", deviceId: "m3-deepseek", backlog: 5, oldestAgeMs: 90_000, metrics: {}, observedAt: at(-20_000), validUntil: at(130_000),
    writtenBy: "nomorevibe" }],
  gates: [
    { assignmentId: AI1.assignmentId, kind: "live", routeId: "local-ai1-helper", provider: "local-direct", model: AI1.model, ok: false, active: 0, maxSlots: 1 },
    { assignmentId: AI1.assignmentId, kind: "shadow", routeId: "local-helper-shadow-ai1", provider: "local-direct", model: AI1.model, ok: false, active: 0, maxSlots: 1 },
  ],
  ...over,
});
const auditRow = (over: Partial<AdminLogRow> = {}): AdminLogRow => ({ id: 1, actor: "jr", action: "model-helper-save", target: AI1.assignmentId, createdAt: NOW,
  actorKind: "github", ip: null, userAgent: null, ok: true, error: null,
  detail: { version: 3, expectedVersion: 2, before: { ...helperInputOf(AI1), minAgreement: 0.9, minHelpMs: 60_000, version: 2 }, after: { ...helperInputOf(AI1), version: 3 } }, ...over });
const view = (over: Partial<Parameters<typeof buildModelHelpersAdminView>[0]> = {}) =>
  buildModelHelpersAdminView({ snapshot: snapshot(), audit: [auditRow()], now: NOW, ...over });
const form = (entries: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(entries)) data.set(key, value); return data; };
const FORM = { expectedVersion: "3", assignmentId: AI1.assignmentId, stage: "ai1", deviceId: "m3-deepseek", mode: "shadow", model: AI1.model,
  shadowRouteId: "local-helper-shadow-ai1", liveRouteId: "local-ai1-helper", liveProvider: "local-direct", maxSlots: "1", perTick: "2", shadowPerHour: "30",
  minShadowSamples: "200", enterSamples: "2", exitSamples: "4", minAgreementPct: "95", maxWrongApprovalPct: "1", maxWrongRejectionPct: "2",
  maxUnknownRatePct: "2", maxFailureRatePct: "10", maxLiveDisagreementPct: "10", minHelpSeconds: "120", reenterCooldownSeconds: "60", note: "" };

beforeEach(() => {
  mocks.admin.mockReset().mockResolvedValue({ login: "operator" });
  mocks.save.mockReset().mockResolvedValue({ ok: true, assignmentId: AI1.assignmentId, version: 4, created: false, changes: ["최소 일치율: 95% → 96%"],
    evidenceChanged: false, modeBefore: "shadow", modeAfter: "shadow" });
  mocks.mode.mockReset().mockResolvedValue({ ok: true, assignmentId: AI1.assignmentId, version: 4, modeBefore: "off", modeAfter: "shadow" });
  mocks.clear.mockReset().mockResolvedValue({ ok: true, assignmentId: AI1.assignmentId, version: 4, modeBefore: "shadow", modeAfter: "shadow" });
  mocks.supervisor.mockReset().mockResolvedValue({ ok: true, patch: { enabled: false } });
  mocks.revalidate.mockReset();
});
afterEach(() => setCapacityHelpersRepositoryForTest(null));

describe("화면 모형 — 감시자 카드", () => {
  it("lease·신호가 살아 있으면 정상, 위치·인스턴스·epoch·나이·빌려주기 신호·자기 일 beacon 을 보인다", () => {
    const model = view();
    expect(model).toMatchObject({ nowMs: NOW_MS, snapshotError: null, counts: { help: 0, shadowOnly: 1, hold: 1 }, issues: [] });
    expect(model.supervisor).toMatchObject({ enabled: true, badge: "ok", badgeLabel: "정상", location: "Oracle", instanceId: "oracle-osaka-1", epoch: 4, loopSeq: 120,
      leaseAlive: true, leaseLeftMs: 30_000, heartbeatAgeMs: 5_000, lastSignalAgeMs: 4_000, signalTtlMs: 45_000, loopMs: 15_000, foreignWriters: [],
      deviceDemand: [{ deviceId: "m3-deepseek", primaryDemand: false, backlog: 0, usable: true, ageMs: 4_000, reason: "fresh" }],
      roleDemand: [{ roleId: "human-review", label: "사람 검수 대기", deviceId: "m3-deepseek", backlog: 5, fresh: true, ageMs: 20_000 }] });
    expect(supervisorLocation(null)).toContain("없음");
    expect(supervisorLocation("m3-home")).toContain("Oracle 아님");
  });

  it("배지: 꺼짐 > 계정 불일치 > 늦음(lease 만료·신호 만료) > 정상", () => {
    expect(view({ snapshot: snapshot({ control: control({ enabled: false }) }) }).supervisor).toMatchObject({ badge: "off", badgeLabel: "꺼짐" });
    const foreign = view({ snapshot: snapshot({ signals: [signal({ assignmentId: AI1.assignmentId, writtenBy: "nomorevibe" })] }) });
    expect(foreign.supervisor).toMatchObject({ badge: "principal_mismatch", badgeLabel: "계정 불일치", foreignWriters: ["nomorevibe"] });
    expect(foreign.issues).toEqual([expect.stringContaining("signal_principal")]);
    const lease = view({ snapshot: snapshot({ control: control({ leaseUntil: at(-1) }) }) });
    expect(lease.supervisor).toMatchObject({ badge: "late", badgeLabel: "늦음", leaseAlive: false });
    expect(lease.supervisor!.badgeDetail).toContain("lease 가 만료");
    expect(lease.issues).toEqual([expect.stringContaining("capacity-supervisor")]);
    const expired = view({ snapshot: snapshot({ signals: [signal({ assignmentId: AI1.assignmentId, validUntil: at(-1) })] }) });
    expect(expired.supervisor).toMatchObject({ badge: "late" });
    expect(expired.supervisor!.badgeDetail).toContain("신호 만료");
    // lease 를 잡은 적 없는 켜진 감시자(배정 없음): 늦음 + 배정이 없다는 알림
    const never = view({ snapshot: snapshot({ control: control({ leaseUntil: null, heartbeatAt: null, ownerInstanceId: null }), assignments: [], signals: [], gates: [] }) });
    expect(never.supervisor).toMatchObject({ badge: "late", heartbeatAgeMs: null, leaseLeftMs: null, lastSignalAgeMs: null });
    expect(never.issues).toEqual([expect.stringContaining("lease"), expect.stringContaining("배정이 없어")]);
  });
});

describe("화면 모형 — 도우미 표", () => {
  it("쓸 수 있는 신호면 판정·이유, 아니면 쉬는 중 + 못 쓰는 이유; 지금 판의 정지만; 입장은 DB gate 그대로; metrics 열쇠를 읽는다", () => {
    const model = view();
    expect(model.helpers.map(row => row.assignmentId)).toEqual(["m3-deepseek:ai1", "m3-deepseek:ai2"]);
    const [ai1, ai2] = model.helpers;
    expect(ai1).toMatchObject({ stageLabel: "1차 검수", modeLabel: "섀도", version: 3, verdict: "shadow_only", verdictLabel: "섀도만", reasonLabel: "주 장비 여유",
      signalUsable: true, staleness: null, signalAgeMs: 4_000, signalLeftMs: 41_000, streak: 1,
      gates: { live: { ok: false, active: 0, maxSlots: 1, routeId: "local-ai1-helper" }, shadow: { ok: false, routeId: "local-helper-shadow-ai1" } },
      primary: { full: false, active: 3, limit: 4, waiting: 0, devices: 2 },
      ownWork: { label: "사람 검수 대기", backlog: 5, fresh: true, ageMs: 20_000 },
      shadow: { samples: 42, agreement: 0.952, wrongApproval: 0.012, wrongRejection: 0.005, unknownRate: 0, failureRate: 0.024 } });
    // 지금 판(3)의 정지만 — 옛 판(2)의 정지는 풀린 것이다. 근거는 글자 그대로(마크업 아님)
    expect(ai1.stops).toEqual([{ id: 7, assignmentId: AI1.assignmentId, version: 3, effect: "stop", effectLabel: "자동 정지(실전·섀도 모두 닫힘)", reason: "unknown_rate",
      reasonLabel: "확인 못함 비율 초과", createdAt: at(-120_000), writtenBy: SUPERVISOR_PRINCIPAL, evidence: '{"n":12,"unknown":3,"note":"<b>raw</b>"}' }]);
    expect(model.stops.map(entry => entry.id)).toEqual([7]);
    expect(ai1.issues).toEqual([expect.stringContaining("자동 정지 중(확인 못함 비율 초과)")]);
    expect(ai1.metrics).toContainEqual(["extra", "x"]);
    expect(ai1.settings).toEqual(helperInputOf(AI1));
    expect(ai2).toMatchObject({ stageLabel: "2차 검수", modeLabel: "꺼짐", verdict: "hold", verdictLabel: "쉬는 중", signalUsable: false, staleness: "version_mismatch",
      reasonLabel: "저장 전 판의 신호(다음 순환에 갱신)", gates: { live: null, shadow: null }, primary: { full: null, active: null }, shadow: { samples: null }, stops: [] });
  });

  it("감시자가 꺼지면 모두 쉬는 중(감시자 꺼짐); beacon 이 없거나 오래되면·수요 신호가 있으면 알린다", () => {
    const off = view({ snapshot: snapshot({ control: control({ enabled: false }) }) });
    expect(off.helpers.map(row => [row.verdict, row.reasonLabel])).toEqual([["hold", "감시자 꺼짐"], ["hold", "감시자 꺼짐"]]);
    const stale = view({ snapshot: snapshot({ roleDemand: [{ ...snapshot().roleDemand[0], validUntil: at(-1) }] }) });
    expect(stale.helpers[0].ownWork).toMatchObject({ fresh: false });
    expect(stale.helpers[0].issues).toContainEqual(expect.stringContaining("beacon(human-review)이 오래돼"));
    const missing = view({ snapshot: snapshot({ roleDemand: [] }) });
    expect(missing.helpers[0].ownWork).toBeNull();
    expect(missing.helpers[0].issues).toContainEqual(expect.stringContaining("beacon 이 없어"));
    const demand = view({ snapshot: snapshot({ deviceSignals: [{ ...snapshot().deviceSignals[0], primaryDemand: true, backlog: 3 }] }) });
    expect(demand.helpers[0].issues).toContainEqual("자기 일 수요 신호(대기 3)가 있어 이 장비는 빌려주지 않습니다");
    const helping = view({ snapshot: snapshot({ stops: [], signals: [signal({ assignmentId: AI1.assignmentId, verdict: "help", reason: "primary_full" })] }) });
    expect(helping.helpers[0]).toMatchObject({ verdict: "help", verdictLabel: "돕는 중", reasonLabel: "주 장비가 가득 참", issues: [] });
    expect(helping.counts).toEqual({ help: 1, shadowOnly: 0, hold: 1 });
  });

  it("스냅샷을 못 읽으면 이유만 보이고 비어 있다(읽기 전용); 감사는 그대로", () => {
    const none = view({ snapshot: null, snapshotError: "capacity_helpers_not_implemented" });
    expect(none).toMatchObject({ snapshotError: "capacity_helpers_not_implemented", supervisor: null, helpers: [], stops: [], nowMs: NOW_MS });
    expect(none.audit).toHaveLength(1);
    expect(view({ snapshot: null }).snapshotError).toBe("model_helper_status_unreadable");
    expect(none.defaults).toEqual(HELPER_SETTING_DEFAULTS);
    expect(none.routeDefaults).toEqual(HELPER_ROUTE_DEFAULTS);
  });

  it("감사 줄 — 한국어 이름, 비율은 %, ms 는 초, 감시자 patch 도; 최근 20줄", () => {
    const model = view();
    expect(model.audit[0]).toMatchObject({ actionLabel: "배정 저장", target: AI1.assignmentId, version: 3, ok: true,
      changes: ["최소 일치율: 90% → 95%", "최소 유지 시간: 1분 → 2분"] });
    expect(helperAuditChangeLines(auditRow({ action: "model-supervisor-toggle", detail: { before: { enabled: false, signalTtlMs: 45_000 }, after: { enabled: true, signalTtlMs: 45_000 } } })))
      .toEqual(["감시자 전체 스위치: 꺼짐 → 켜짐"]);
    expect(helperAuditChangeLines(auditRow({ detail: { patch: { loopMs: 20_000 } } }))).toEqual(["순환 간격: 20초"]);
    expect(helperAuditChangeLines(auditRow({ detail: { changes: [{ path: "mode", before: "off", after: "shadow" }] } }))).toEqual(["모드: 꺼짐 → 섀도"]);
    expect(view({ audit: Array.from({ length: 25 }, (_, index) => auditRow({ id: index + 1 })) }).audit).toHaveLength(20);
    expect(view({ audit: [auditRow({ ok: false, error: "model_helper_version_mismatch:4", detail: {} })] }).audit[0]).toMatchObject({ ok: false, version: null, changes: [] });
  });
});

describe("폼 → 저장 입력", () => {
  it("백분율 → 비율(셋째 자리), 초 → ms, 빈 메모 → null, 빈 판 → 새 배정, 빈 이름 → <장비>:<단계>", () => {
    const parsed = helperAssignmentInputFromForm(form({ ...FORM, minAgreementPct: "96.5", maxWrongApprovalPct: "0.5", minHelpSeconds: "1.5", note: "  메모 " }));
    expect(parsed).toMatchObject({ expectedVersion: 3, issues: [] });
    expect(parsed.input).toMatchObject({ assignmentId: AI1.assignmentId, minAgreement: 0.965, maxWrongApproval: 0.005, minHelpMs: 1_500, note: "메모", mode: "shadow" });
    // 저장 입력은 zod 를 그대로 통과한다(같은 칸 이름)
    expect(() => parseHelperAssignment(parsed.input)).not.toThrow();
    const fresh = helperAssignmentInputFromForm(form({ ...FORM, expectedVersion: "", assignmentId: "", mode: "" }));
    expect(fresh).toMatchObject({ expectedVersion: null, issues: [], input: { assignmentId: "m3-deepseek:ai1", mode: "off" } });
    expect(percentInputToRatio("100")).toBe(1);
    expect(percentInputToRatio("95%")).toBe(0.95);
    expect(percentInputToRatio("0.55")).toBeUndefined();
    expect(secondsInputToMs("0")).toBe(0);
    expect(secondsInputToMs("-1")).toBeUndefined();
  });

  it("정수·백분율·초 모양과 판 번호를 한국어로 거절하고 저장 입력을 만들지 않는다", () => {
    const bad = helperAssignmentInputFromForm(form({ ...FORM, maxSlots: "하나", minAgreementPct: "95.55", minHelpSeconds: "-3", expectedVersion: "0" }));
    expect(bad).toMatchObject({ input: null, issues: ["판 번호(version)를 읽지 못했습니다. 새로고침해 주세요.", "최대 칸: 정수를 넣어주세요",
      "최소 일치율: 0~100 사이 백분율(소수 한 자리까지)을 넣어주세요", "최소 유지 시간(초): 0 이상의 초 단위 숫자를 넣어주세요"] });
    expect(helperAssignmentInputFromForm(form({ ...FORM, stage: "", deviceId: "", model: "", assignmentId: "" })).issues)
      .toEqual(["돕는 단계를 골라주세요", "도우미 장비를 넣어주세요", "모델을 넣어주세요", "배정 이름을 넣어주세요(예: m3-deepseek:ai1)"]);
    expect(helperAssignmentInputFromForm(form({ ...FORM, note: "x".repeat(401) })).issues).toEqual(["메모는 400자까지입니다"]);
  });

  it("감시자 순환 설정: 초 → ms, 범위·순환 × 2 ≤ 유효 시간은 저장소와 같은 코드", () => {
    expect(supervisorTimingFromForm(form({ signalTtlSeconds: "60", loopSeconds: "20" }))).toEqual({ patch: { signalTtlMs: 60_000, loopMs: 20_000 }, issues: [] });
    expect(supervisorTimingFromForm(form({ signalTtlSeconds: "30", loopSeconds: "20" }))).toEqual({ patch: null, issues: ["model_supervisor_invalid:loopMs"] });
    expect(supervisorTimingFromForm(form({ signalTtlSeconds: "10", loopSeconds: "5" }))).toEqual({ patch: null, issues: ["model_supervisor_invalid:signalTtlMs"] });
    expect(supervisorTimingFromForm(form({ signalTtlSeconds: "x", loopSeconds: "5" })).issues).toEqual(["model_supervisor_invalid:signalTtlMs"]);
    expect(supervisorTimingFromForm(form({ signalTtlSeconds: "45", loopSeconds: "" })).issues).toEqual(["model_supervisor_invalid:loopMs"]);
  });

  it("배정 입력 칸은 zod shape 하나가 기준이고, 행 → 입력은 저장 전용 칸을 버린다; 기본값은 zod default", () => {
    expect([...HELPER_INPUT_KEYS].sort()).toEqual(Object.keys(helperAssignmentSchema.shape).sort());
    expect(Object.keys(helperInputOf(AI1)).sort()).toEqual([...HELPER_INPUT_KEYS].sort());
    expect(() => parseHelperAssignment(helperInputOf(AI1))).not.toThrow();
    expect(HELPER_SETTING_DEFAULTS).toMatchObject({ maxSlots: 1, perTick: 2, shadowPerHour: 30, minShadowSamples: 200, minAgreement: 0.95, maxWrongApproval: 0.01,
      maxWrongRejection: 0.02, maxUnknownRate: 0.02, maxFailureRate: 0.1, maxLiveDisagreement: 0.1, enterSamples: 2, exitSamples: 4, minHelpMs: 120_000,
      reenterCooldownMs: 60_000, mode: "off", note: null });
  });
});

describe("거절 코드 → 한국어(모든 코드)", () => {
  it("CAS·저장 거절 다섯·검사 칸·감시자 검사·제어 행·fence·재생·미구현은 문장으로, 모르는 코드는 그대로", () => {
    expect(modelHelperIssueMessage("model_helper_version_mismatch:5")).toBe("다른 사람이 먼저 저장했습니다(지금 판 5). 새로고침해 주세요.");
    expect(modelHelperIssueMessage("model_helper_version_mismatch:none")).toContain("지금 판 없음");
    expect(modelHelperIssueMessage("model_helper_version_mismatch:invalid")).toBe("판 번호(version)를 읽지 못했습니다. 새로고침해 주세요.");
    for (const code of HELPER_SAVE_REFUSALS) expect(modelHelperIssueMessage(`model_helper_refused:${code}`)).toBe(HELPER_REFUSAL_MESSAGES[code]);
    expect(modelHelperIssueMessage("model_helper_refused:helper_route_is_primary")).toContain("순위를 2 이상으로");
    expect(modelHelperIssueMessage("model_helper_refused:helper_route_unmapped")).toContain("경로를 정책에 먼저 덧붙인 뒤 저장하세요");
    expect(modelHelperIssueMessage("model_helper_refused:helper_route_unmapped")).not.toMatch(/rev ?\d+|DRAIN 창/);
    expect(modelHelperIssueMessage("model_helper_refused:helper_ai2_voter_not_in_fallbacks")).toContain("2차 대체 모델 목록");
    expect(modelHelperIssueMessage("model_helper_refused:brand_new")).toBe("저장이 거절됐습니다: brand_new");
    for (const path of [...HELPER_INPUT_KEYS, "root", "evidence", "actor"]) {
      expect(modelHelperIssueMessage(`model_helper_invalid:${path}`), path).not.toMatch(/^model_helper_invalid|검사를 통과하지 못했습니다/);
    }
    expect(modelHelperIssueMessage("model_helper_invalid:minAgreement")).toBe("최소 일치율: 50~100% 의 백분율(소수 한 자리까지)이어야 합니다");
    expect(modelHelperIssueMessage("model_helper_invalid:shadowRouteId")).toContain("실전 경로와 달라야");
    expect(modelHelperIssueMessage("model_helper_invalid:something")).toBe("도우미 배정이 검사를 통과하지 못했습니다: something");
    for (const path of ["enabled", "signalTtlMs", "loopMs", "root"]) expect(modelHelperIssueMessage(`model_supervisor_invalid:${path}`), path).not.toContain("통과하지 못했습니다");
    expect(modelHelperIssueMessage("model_supervisor_invalid:loopMs")).toContain("순환 간격 × 2 ≤ 신호 유효 시간");
    expect(modelHelperIssueMessage("model_supervisor_invalid:other")).toBe("감시자 설정이 검사를 통과하지 못했습니다: other");
    expect(modelHelperIssueMessage("model_supervisor_control_missing")).toContain("model_supervisor_control id=1");
    expect(modelHelperIssueMessage("site_fenced")).toBe("이 사이트는 지금 쓰기가 막혀 있습니다(DR).");
    for (const reason of ["lineage_mismatch", "epoch_stale", "epoch_ahead"]) expect(modelHelperIssueMessage(reason)).toContain("DR:");
    expect(modelHelperIssueMessage("model_capacity_replay_unsupported")).toContain("재생(replay) DB");
    expect(modelHelperIssueMessage("model_capacity_control_missing")).toContain("model_capacity_control");
    expect(modelHelperIssueMessage("capacity_helpers_not_implemented")).toContain("아직 준비되지 않았습니다");
    expect(modelHelperIssueMessage("Cannot find module '@/lib/llm/capacity-helpers-repository'")).toBe(modelHelperIssueMessage("capacity_helpers_not_implemented"));
    expect(modelHelperIssueMessage("invalid_actor")).toContain("다시 로그인");
    expect(modelHelperIssueMessage("model_helper_status_unreadable")).toBe("도우미 상태를 읽지 못했습니다.");
    expect(modelHelperIssueMessage("weird:detail")).toBe("weird:detail");
  });
  it("판정 이유는 모두 §5.2 의 한국어 이름이 있다", () => {
    for (const reason of HELPER_REASONS) expect(HELPER_REASON_LABELS[reason], reason).toMatch(/[가-힣]/);
    expect(HELPER_REASON_LABELS.helper_own_work).toBe("자기 일이 있음");
    expect(HELPER_REASON_LABELS.supervisor_off).toBe("감시자 꺼짐");
  });
});

describe("저장 함수의 저장소 전 거절(저장소에 닿지 않는다)", () => {
  it("실전 모드·잘못된 이름·판·사람은 저장소를 부르지 않고 코드로 돌려준다", async () => {
    const actual = await vi.importActual<typeof import("@/lib/operations/admin-model-helpers")>("@/lib/operations/admin-model-helpers");
    const repo = { saveHelperAssignment: vi.fn(), setHelperMode: vi.fn(), listHelperAssignments: vi.fn(), setSupervisorControl: vi.fn(), readHelperStatusSnapshot: vi.fn() };
    actual.setCapacityHelpersRepositoryForTest(repo as unknown as HelperRepository);
    try {
      expect(await actual.setAdminModelHelperMode(AI1.assignmentId, "live", 3, "jr")).toEqual({ ok: false, issues: ["model_helper_refused:helper_live_requires_promotion"] });
      expect(await actual.setAdminModelHelperMode("Bad Id", "off", 3, "jr")).toEqual({ ok: false, issues: ["model_helper_invalid:assignmentId"] });
      expect(await actual.setAdminModelHelperMode(AI1.assignmentId, "odd", 3, "jr")).toEqual({ ok: false, issues: ["model_helper_invalid:mode"] });
      expect(await actual.setAdminModelHelperMode(AI1.assignmentId, "off", 0, "jr")).toEqual({ ok: false, issues: ["model_helper_version_mismatch:invalid"] });
      expect(await actual.clearAdminModelHelperStops(AI1.assignmentId, 3, " ")).toEqual({ ok: false, issues: ["invalid_actor"] });
      expect(await actual.saveAdminModelHelper({}, -1, "jr")).toEqual({ ok: false, issues: ["model_helper_version_mismatch:invalid"] });
      expect(await actual.setAdminSupervisorControl({ loopMs: 1 }, "jr")).toEqual({ ok: false, issues: ["model_supervisor_invalid:loopMs"] });
      expect(await actual.setAdminSupervisorControl({ signalTtlMs: 20_000, loopMs: 15_000 }, "jr")).toEqual({ ok: false, issues: ["model_supervisor_invalid:loopMs"] });
      expect(await actual.setAdminSupervisorControl({}, "jr")).toEqual({ ok: false, issues: ["model_supervisor_invalid:root"] });
      expect(await actual.setAdminSupervisorControl({ enabled: true, extra: 1 }, "jr")).toMatchObject({ ok: false });
      for (const fn of Object.values(repo)) expect(fn).not.toHaveBeenCalled();
    } finally { actual.setCapacityHelpersRepositoryForTest(null); }
  });
});

describe("server action — 쓰기 관문 뒤 관리자 확인·폼 검사·CAS·거절 문장", () => {
  it("배정 저장: 저장 입력·판·사람을 넘기고 판·모드·바뀐 값을 알린다; 근거가 새로 시작하면 알린다", async () => {
    const result = await saveModelHelper(null, form(FORM));
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ assignmentId: AI1.assignmentId, minAgreement: 0.95, minHelpMs: 120_000, note: null }), 3, "operator");
    expect(result).toEqual({ ok: true, message: "저장했습니다(배정 m3-deepseek:ai1, 판 4, 모드 섀도). 감시자의 다음 순환부터 새 판으로 판정합니다. 바뀐 값: 최소 일치율: 95% → 96%" });
    expect(mocks.revalidate).toHaveBeenCalledWith("/admin/models/helpers");
    mocks.save.mockResolvedValue({ ok: true, assignmentId: AI1.assignmentId, version: 5, created: false, changes: [], evidenceChanged: true, modeBefore: "live", modeAfter: "shadow" });
    expect((await saveModelHelper(null, form(FORM)))?.message).toEqual(expect.stringContaining("섀도 근거(evidence_key)가 새로 시작합니다. 실전은 섀도(으)로 내려갔습니다. 바뀐 값이 없습니다."));
    mocks.save.mockResolvedValue({ ok: true, assignmentId: "m3-deepseek:ai2", version: 1, created: true, changes: [], evidenceChanged: false, modeBefore: null, modeAfter: "off" });
    expect((await saveModelHelper(null, form({ ...FORM, expectedVersion: "", assignmentId: "", stage: "ai2" }))))
      .toMatchObject({ ok: true, message: expect.stringContaining("만들었습니다(배정 m3-deepseek:ai2, 판 1, 모드 꺼짐)") });
    expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ assignmentId: "m3-deepseek:ai2" }), null, "operator");
  });

  it("CAS·저장 거절은 한국어로 그대로, 던진 오류도 문장으로; 비관리자·폼 문제는 저장 경로에 닿지 않는다", async () => {
    mocks.save.mockResolvedValue({ ok: false, issues: ["model_helper_version_mismatch:4"] });
    expect(await saveModelHelper(null, form(FORM))).toEqual({ issues: ["다른 사람이 먼저 저장했습니다(지금 판 4). 새로고침해 주세요."] });
    mocks.save.mockResolvedValue({ ok: false, issues: ["model_helper_refused:helper_route_is_primary", "weird_code"] });
    expect(await saveModelHelper(null, form(FORM))).toEqual({ issues: [HELPER_REFUSAL_MESSAGES.helper_route_is_primary, "weird_code"] });
    mocks.save.mockRejectedValue(new Error("capacity_helpers_not_implemented"));
    expect(await saveModelHelper(null, form(FORM))).toEqual({ issues: [modelHelperIssueMessage("capacity_helpers_not_implemented")] });
    mocks.save.mockClear();
    expect(await saveModelHelper(null, form({ ...FORM, perTick: "" }))).toEqual({ issues: ["한 틱 최대 건수: 정수를 넣어주세요"] });
    mocks.admin.mockResolvedValue(null);
    expect(await saveModelHelper(null, form(FORM))).toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
    for (const action of [changeModelHelperMode, clearModelHelperStop, switchCapacitySupervisor, saveCapacitySupervisorTiming])
      expect(await action(null, form({ ...FORM, enabled: "false", signalTtlSeconds: "45", loopSeconds: "15" }))).toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
    for (const fn of [mocks.save, mocks.mode, mocks.clear, mocks.supervisor]) expect(fn).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("모드 바꾸기·자동 정지 해제: 누른 단추의 모드와 판(CAS)을 넘긴다; 판이 없으면 거절", async () => {
    expect(await changeModelHelperMode(null, form({ assignmentId: AI1.assignmentId, expectedVersion: "3", mode: "shadow" })))
      .toEqual({ ok: true, message: expect.stringContaining("모드를 꺼짐 → 섀도(으)로 바꿨습니다(배정 m3-deepseek:ai1, 판 4).") });
    expect(mocks.mode).toHaveBeenCalledWith(AI1.assignmentId, "shadow", 3, "operator");
    mocks.mode.mockResolvedValue({ ok: false, issues: ["model_helper_refused:helper_live_requires_promotion"] });
    expect(await changeModelHelperMode(null, form({ assignmentId: AI1.assignmentId, expectedVersion: "3", mode: "live" }))).toEqual({ issues: [HELPER_REFUSAL_MESSAGES.helper_live_requires_promotion] });
    expect(await changeModelHelperMode(null, form({ assignmentId: AI1.assignmentId, expectedVersion: "", mode: "off" }))).toEqual({ issues: ["판 번호(version)를 읽지 못했습니다. 새로고침해 주세요."] });
    expect(await changeModelHelperMode(null, form({ assignmentId: "", expectedVersion: "3", mode: "off" }))).toEqual({ issues: ["배정 이름을 읽지 못했습니다. 새로고침해 주세요."] });
    expect(await clearModelHelperStop(null, form({ assignmentId: AI1.assignmentId, expectedVersion: "3" })))
      .toEqual({ ok: true, message: expect.stringContaining("자동 정지를 풀었습니다(배정 m3-deepseek:ai1, 판 4, 모드 섀도)") });
    expect(mocks.clear).toHaveBeenCalledWith(AI1.assignmentId, 3, "operator");
    mocks.clear.mockResolvedValue({ ok: false, issues: ["model_helper_version_mismatch:5"] });
    expect(await clearModelHelperStop(null, form({ assignmentId: AI1.assignmentId, expectedVersion: "3" }))).toEqual({ issues: ["다른 사람이 먼저 저장했습니다(지금 판 5). 새로고침해 주세요."] });
  });

  it("감시자 스위치: 끄기는 바로, 켜기는 확인 칸이 있어야; 순환 설정은 검사 뒤 저장", async () => {
    expect(await switchCapacitySupervisor(null, form({ enabled: "false" }))).toEqual({ ok: true, message: expect.stringContaining("감시자를 껐습니다") });
    expect(mocks.supervisor).toHaveBeenLastCalledWith({ enabled: false }, "operator");
    expect(await switchCapacitySupervisor(null, form({ enabled: "true" }))).toEqual({ issues: [expect.stringContaining("확인 칸에 표시해 주세요")] });
    expect(mocks.supervisor).toHaveBeenCalledTimes(1);
    expect(await switchCapacitySupervisor(null, form({ enabled: "true", confirm: "yes" }))).toEqual({ ok: true, message: expect.stringContaining("감시자를 켰습니다") });
    expect(mocks.supervisor).toHaveBeenLastCalledWith({ enabled: true }, "operator");
    expect(await switchCapacitySupervisor(null, form({ enabled: "maybe" }))).toEqual({ issues: [modelHelperIssueMessage("model_supervisor_invalid:enabled")] });
    mocks.supervisor.mockResolvedValue({ ok: false, issues: ["model_supervisor_control_missing"] });
    expect(await switchCapacitySupervisor(null, form({ enabled: "false" }))).toEqual({ issues: [modelHelperIssueMessage("model_supervisor_control_missing")] });
    mocks.supervisor.mockResolvedValue({ ok: true, patch: { signalTtlMs: 60_000, loopMs: 20_000 } });
    expect(await saveCapacitySupervisorTiming(null, form({ signalTtlSeconds: "60", loopSeconds: "20" })))
      .toEqual({ ok: true, message: "저장했습니다(신호 유효 시간 1분 · 순환 간격 20초). 감시자의 다음 순환부터 쓰입니다." });
    expect(mocks.supervisor).toHaveBeenLastCalledWith({ signalTtlMs: 60_000, loopMs: 20_000 }, "operator");
    const calls = mocks.supervisor.mock.calls.length;
    expect(await saveCapacitySupervisorTiming(null, form({ signalTtlSeconds: "30", loopSeconds: "20" }))).toEqual({ issues: [modelHelperIssueMessage("model_supervisor_invalid:loopMs")] });
    expect(mocks.supervisor).toHaveBeenCalledTimes(calls);
  });
});

describe("그리기", () => {
  const model = view();
  it("도우미 표(2026-11-09 시안) — 8열, 섀도는 「표본 / 기준 · 일치율」 + 나머지는 title, 뺀 칸은 「설정」으로 펼친 줄에", () => {
    const html = renderToStaticMarkup(createElement(HelperTable, { helpers: model.helpers, now: NOW }));
    const head = html.match(/<thead>[^]*?<\/thead>/)![0];
    expect([...head.matchAll(/<th[^>]*>([^<]+)/g)].map(match => match[1])).toEqual(["서버", "돕는 단계", "모델", "모드", "지금", "섀도 표본 · 일치율", "자동 정지", "동작"]);
    expect(html).toContain('href="#helper-m3-deepseek:ai1"');
    expect(html).toContain("섀도만");
    expect(html).toContain("주 장비 여유");
    expect(html).toContain("쉬는 중");
    expect(html).toContain("저장 전 판의 신호");
    // 섀도 두 숫자 + 나머지 지표는 title
    expect(html).toMatch(/title="잘못 승인 1\.2% · 잘못 거절 0\.5% · 미확인률 0% · 실패율 2\.4%">42 \/ 200 · 95\.2%<\/span>/);
    expect(html).toContain("표본 없음");
    // 자동 정지 칸은 짧게(효과 · 이유), 긴 효과 이름은 title
    expect(html).toMatch(/title="자동 정지\(실전·섀도 모두 닫힘\) · [^"]+"><span class="mh-alert">정지<\/span> · 확인 못함 비율 초과/);
    // 「설정」 단추가 펼침 줄을 연다 — 처음에는 닫혀 있고(hidden), 표에서 뺀 칸(신호 나이·입장·주 장비·자기 일·섀도 세부·판)이 그 줄에 있다
    expect(html).toMatch(/<button type="button" class="mh-btn" aria-expanded="false" aria-controls="helper-m3-deepseek:ai1-row"[^>]*>설정<\/button>/);
    const row = html.match(/<tr id="helper-m3-deepseek:ai1-row" class="mh-form-row" hidden="">[^]*?<\/tr>/)![0];
    for (const text of ["신호 나이", "4초 전", "41초 남음", "입장(실제)", "실전 닫힘 · 점유 0/1", "주 장비", "여유 · 3/4 · 대기 0 · 장비 2대", "사람 검수 대기 <strong",
      "잘못 승인 1.2%", "실패율 2.4%", "자동 정지(실전·섀도 모두 닫힘)", "판 <span class=\"mh-num\">3</span>"]) expect(row).toContain(text);
    // 폼을 주면 펼침 줄에 그 배정의 설정 폼(테두리 없이)
    expect(row).not.toContain('name="expectedVersion"');
    const withForm = renderToStaticMarkup(createElement(HelperTable, { helpers: model.helpers, now: NOW, form: { defaults: model.defaults, routeDefaults: model.routeDefaults } }));
    expect(withForm.match(/<tr id="helper-m3-deepseek:ai1-row"[^]*?<\/tr>/)![0]).toMatch(/<div id="helper-m3-deepseek:ai1" class="grid gap-3 text-\[13px\] scroll-mt-24">[^]*name="expectedVersion" value="3"/);
    expect(renderToStaticMarkup(createElement(HelperTable, { helpers: [], now: NOW }))).toContain("도우미 배정이 없습니다");
  });

  it("2026-11-09: 도우미 장비는 연결 이름으로 — 장비 id 는 title 에만(표·폼 머리·감시자 카드)", () => {
    const deviceId = model.helpers[0].deviceId, names = { [deviceId]: "m3-deepseek · m3-gpt-oss" };
    const table = renderToStaticMarkup(createElement(HelperTable, { helpers: model.helpers, now: NOW, names }));
    expect(table).toContain(`title="장비 id ${deviceId}">m3-deepseek · m3-gpt-oss</a>`);
    const head = renderToStaticMarkup(createElement(HelperForm, { helper: model.helpers[0], defaults: model.defaults, routeDefaults: model.routeDefaults, names }));
    expect(head).toMatch(/<h3[^>]*title="장비 id [^"]+">m3-deepseek · m3-gpt-oss · /);
    // 이름표가 없는 장비는 장비 id 그대로
    expect(renderToStaticMarkup(createElement(HelperTable, { helpers: model.helpers, now: NOW }))).toContain(`>${deviceId}</a>`);
    const card = renderToStaticMarkup(createElement(SupervisorCard, { supervisor: model.supervisor, names: Object.fromEntries(
      [...(model.supervisor?.roleDemand ?? []), ...(model.supervisor?.deviceDemand ?? [])].map(entry => [entry.deviceId, `이름 ${entry.deviceId}`])) }));
    for (const entry of model.supervisor?.roleDemand ?? []) expect(card).toContain(`title="장비 id ${entry.deviceId}">이름 ${entry.deviceId}</span>`);
  });

  it("감시자 카드 — 배지·스위치(켜져 있으면 끄기, 꺼져 있으면 확인 칸 + 켜기)·lease·순환 설정·beacon", () => {
    const html = renderToStaticMarkup(createElement(SupervisorCard, { supervisor: model.supervisor }));
    expect(html).toContain('data-badge="ok"');
    expect(html).toContain("정상");
    // 표 한 줄 — 상태 · 전체 스위치 · 마지막 신호 · 신호 유효 · 순환 · 동작
    expect([...html.match(/<thead>[^]*?<\/thead>/)![0].matchAll(/<th[^>]*>([^<]+)/g)].map(match => match[1])).toEqual(["상태", "전체 스위치", "마지막 신호", "신호 유효", "순환", "동작"]);
    expect(html).toMatch(/<td class="r mh-num nowrap">45초<\/td><td class="r mh-num nowrap">15초<\/td>/);
    expect(html).toContain("감시자 끄기");
    expect(html).toContain('name="enabled" value="false"');
    expect(html).toContain("돌고 있는 호출은 끝까지 갑니다");
    // 순환 설정 폼은 「시간 바꾸기」로 연다(처음엔 숨김), lease·beacon 등은 「감시자 자세히」에 접힌다
    expect(html).toMatch(/aria-expanded="false" aria-controls="supervisor-timing">시간 바꾸기<\/button>/);
    expect(html).toMatch(/<form id="supervisor-timing" hidden=""/);
    expect(html).toContain("<summary>감시자 자세히</summary>");
    expect(html).toContain("Oracle");
    expect(html).toContain("oracle-osaka-1");
    expect(html).toContain("살아 있음(30초 남음)");
    expect(html).toContain("5초 전");
    expect(html).toContain('name="signalTtlSeconds" value="45"');
    expect(html).toContain('name="loopSeconds" value="15"');
    expect(html).toContain("사람 검수 대기");
    expect(html).not.toContain('name="confirm"');
    const off = renderToStaticMarkup(createElement(SupervisorCard, { supervisor: view({ snapshot: snapshot({ control: control({ enabled: false }) }) }).supervisor, readOnly: true }));
    expect(off).toContain('data-badge="off"');
    expect(off).toContain("감시자 켜기");
    expect(off).toContain('name="confirm" value="yes"');
    expect(off).toContain('name="enabled" value="true"');
    expect(off).toMatch(/<button[^>]*disabled/);
    expect(renderToStaticMarkup(createElement(SupervisorCard, { supervisor: null }))).toContain("감시자 상태를 읽지 못해");
  });

  it("배정 폼 — 숨은 판(CAS)·장비·단계·모드, 백분율·초 칸, 모드 단추(실전 꺼짐)·자동 정지 해제; 새 배정은 단계 기본 경로", () => {
    const [ai1, ai2] = model.helpers;
    const html = renderToStaticMarkup(createElement(HelperForm, { helper: ai1, defaults: model.defaults, routeDefaults: model.routeDefaults }));
    expect(html).toContain('id="helper-m3-deepseek:ai1"');
    expect(html).toContain('name="expectedVersion" value="3"');
    expect(html).toContain('type="hidden" name="assignmentId" value="m3-deepseek:ai1"');
    expect(html).toContain('type="hidden" name="mode" value="shadow"');
    for (const name of ["model", "shadowRouteId", "liveRouteId", "liveProvider", "maxSlots", "perTick", "shadowPerHour", "minShadowSamples", "enterSamples", "exitSamples",
      "minAgreementPct", "maxWrongApprovalPct", "maxWrongRejectionPct", "maxUnknownRatePct", "maxFailureRatePct", "maxLiveDisagreementPct", "minHelpSeconds",
      "reenterCooldownSeconds", "note"]) expect(html).toContain(`name="${name}"`);
    expect(html).toContain('name="minAgreementPct" value="95"');
    expect(html).toContain('name="minHelpSeconds" value="120"');
    expect(html).toContain("기본 95%");
    // PR 5: 모드 단추는 두 단계 확인 — 처음에는 type="button"(확인 열기)만, 「끄기 확인」을 눌러야 name="mode" value="off" 가 나간다
    expect(html).toMatch(/<button type="button" data-confirm-trigger=""[^>]*>끄기<\/button>/);
    expect(html).not.toContain('type="submit"');
    expect(html).not.toContain(">섀도 시작<");
    expect(html).toContain("자동 정지 해제");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>실전으로 올리기<\/button>/);
    expect(html).toContain("이 배정 저장");
    const offForm = renderToStaticMarkup(createElement(HelperForm, { helper: ai2, defaults: model.defaults, routeDefaults: model.routeDefaults }));
    expect(offForm).toContain(">섀도 시작<");
    expect(offForm).not.toContain("자동 정지 해제");
    expect(offForm).toContain('value="second-review"');
    expect(offForm).toContain("2차 도우미");
    const fresh = renderToStaticMarkup(createElement(HelperForm, { helper: null, defaults: model.defaults, routeDefaults: model.routeDefaults }));
    expect(fresh).toContain('id="helper-new"');
    expect(fresh).toContain('name="expectedVersion" value=""');
    expect(fresh).toContain('aria-label="돕는 단계"');
    expect(fresh).toContain('name="deviceId"');
    expect(fresh).toContain('value="local-helper-shadow-ai1"');
    expect(fresh).toContain('value="local-ai1-helper"');
    expect(fresh).toMatch(/<option value="live" disabled="">/);
    expect(fresh).toContain("새 배정 만들기");
    expect(fresh).not.toContain("실전으로 올리기");
  });

  it("클라이언트의 작은 글자 규칙은 서버 모듈과 같다", () => {
    for (const ms of [null, 0, 4_000, 59_499, 61_000, 3_725_000, 200_000_000]) expect(clientAgeLabel(ms)).toBe(ageLabel(ms));
    for (const ms of [null, 1_500, 15_000, 60_000, 90_000, 120_000]) expect(clientDurationLabel(ms)).toBe(durationLabel(ms));
    for (const ratio of [0, 0.005, 0.01, 0.952, 0.95, 1]) expect(ratioToPercentText(ratio)).toBe(ratioToPercentInput(ratio));
    for (const ms of [0, 1_500, 60_000, 120_000]) expect(msToSecondsText(ms)).toBe(msToSecondsInput(ms));
    expect(percentLabel(0.952)).toBe("95.2%");
    expect(percentLabel(null)).toBe("—");
  });

  it("메뉴에 도우미·감시자가 h1 과 같은 이름으로 있고, 장비 한도 화면이 이 화면으로 보낸다; 화면에 PageStamp", () => {
    const root = path.resolve(__dirname, "..");
    const page = readFileSync(path.join(root, "app/(operator)/admin/models/helpers/page.tsx"), "utf8");
    expect(page).toContain("<PageStamp />");
    // 이름은 메뉴와 같은 표(MODELS_ADVANCED_EDITORS) 하나에서 온다(PR 5)
    expect(page).toMatch(/<h1[^>]*>\{EDITOR\.label\}<\/h1>/); expect(page).toContain('modelsAdvancedEditor("helpers")');
    expect(modelsAdvancedEditor("helpers").label).toBe("도우미·감시자");
    expect(page).toContain('redirect("/admin/login")');
    const pages = NAV_GROUPS[1].pages.map(entry => entry.href);
    expect(pages.indexOf("/admin/models/helpers")).toBe(pages.indexOf("/admin/models/devices") + 1);
    expect(NAV_GROUPS[1].pages.find(entry => entry.href === "/admin/models/helpers")).toMatchObject({ label: "도우미·감시자", icon: "sliders" });
    expect(readFileSync(path.join(root, "app/(operator)/admin/models/devices/page.tsx"), "utf8")).toMatch(/<AdvancedEditorLinks next=\{\[[^\]]*"helpers"/);
    // 서버 모듈(DB·node:crypto)은 클라이언트 폼에 형으로만 들어간다
    for (const file of ["HelperForm.tsx", "SupervisorCard.tsx"]) {
      const source = readFileSync(path.join(root, "app/(operator)/admin/models/helpers", file), "utf8");
      expect(source.startsWith('"use client"'), file).toBe(true);
      expect(source, file).not.toMatch(/^import \{[^}]*\} from "@\/lib\/(operations\/admin-model-helpers|llm\/capacity-helpers)"/m);
    }
  });

  it("안내 문구는 지금 상태만 말한다 — 정책 판 번호(rev14)·DRAIN 창·PR 번호를 쓰지 않는다", () => {
    const root = path.resolve(__dirname, "..");
    for (const file of ["page.tsx", "SupervisorCard.tsx", "actions.ts", "HelperForm.tsx", "HelperTable.tsx"]) {
      const source = readFileSync(path.join(root, "app/(operator)/admin/models/helpers", file), "utf8");
      expect(source, file).not.toMatch(/rev ?1\d\b|DRAIN 창|OPEN 전에/);
    }
    for (const message of Object.values(HELPER_REFUSAL_MESSAGES)) expect(message).not.toMatch(/rev ?1\d\b|DRAIN 창/);
    // 새 배정 안내: 경로는 정책에 먼저, DRAIN 은 필요 없고, 새 배정은 꺼짐으로
    const page = readFileSync(path.join(root, "app/(operator)/admin/models/helpers/page.tsx"), "utf8");
    expect(page).toContain("경로는 DRAIN 없이 정책에 덧붙일 수 있습니다. 새 배정은 꺼짐으로 만드세요.");
  });
});
