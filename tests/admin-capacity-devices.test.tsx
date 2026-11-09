import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 장비 한도 화면(PR 1b WP-B) — 화면 모형·폼 → 저장 입력·거절 문장·그리기·server action. DB 없이 본다; WP-A 의 저장 본문과 저장소 읽기는 가짜다.
const mocks = vi.hoisted(() => ({ admin: vi.fn(), save: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/operations/admin-capacity-devices", async importOriginal => ({ ...(await importOriginal<object>()),
  saveAdminCapacityDevice: mocks.save, readCapacityDevicesAdminView: mocks.read }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { saveCapacityDevice } from "@/app/(operator)/admin/models/devices/actions";
import { DeviceForm } from "@/app/(operator)/admin/models/devices/DeviceForm";
import { DeviceTable } from "@/app/(operator)/admin/models/devices/DeviceTable";
import { RolesEditor } from "@/app/(operator)/admin/models/devices/RolesEditor";
import { NAV_GROUPS } from "@/app/(operator)/admin/AdminNav";
import { modelsAdvancedEditor } from "@/app/(operator)/admin/workspace-navigation";
import type { ModelCapacityPolicy } from "@/lib/llm/capacity";
import type { ModelCapacityDeviceRow, ModelCapacityDeviceState } from "@/lib/llm/capacity-devices";
import type { AdminLogRow } from "@/lib/operations/admin-log";
import { buildCapacityDevicesAdminView, capacityDeviceInputFromForm, capacityDeviceIssueMessage, deviceAuditChangeLines, deviceRoleLabel,
  DEVICE_FIELD_LABELS, MODEL_CAPACITY_DEVICE_AUDIT_ACTION } from "@/lib/operations/admin-capacity-devices";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const POLICY = { version: 1, globalLimit: 8, providerLimits: { a: 8 }, groupLimits: { supa: 4, "gpu3090-qwen": 4, "m1-qwen": 2 }, poolLimits: { reviewer: 8, text: 8 },
  weights: { first: 2, second: 1, background: 1 }, maxWaiting: 32, queueTtlMs: 60_000, reservationTtlMs: 30_000,
  routes: [
    { routeId: "crawl-agent-review", provider: "abcllm", model: "supa", providerBudgetId: "a", groupId: "supa" },
    { routeId: "product-search-verify", provider: "abcllm", model: "supa", providerBudgetId: "a", groupId: "supa" },
    { routeId: "crawl-tagline", provider: "abcllm", model: "supa", providerBudgetId: "a", groupId: "supa" },
    { routeId: "second-review", provider: "local-direct", model: "qwen", providerBudgetId: "a", groupId: "gpu3090-qwen" },
    { routeId: "product-translate", provider: "abcllm", model: "m1", providerBudgetId: "a", groupId: "m1-qwen" },
    { routeId: "reason-translate", provider: "abcllm", model: "m1", providerBudgetId: "a", groupId: "m1-qwen" },
  ] } satisfies ModelCapacityPolicy;
const row = (over: Partial<ModelCapacityDeviceRow> & { deviceId: string }): ModelCapacityDeviceRow => ({ limitSlots: 4, secondaryCap: 1, idleMs: 60_000, reserveSlots: 0, physicalLimit: null,
  roles: [], note: null, enabled: true, version: 3, updatedBy: "jr", createdAt: "2026-10-30T10:00:00.000Z", updatedAt: "2026-10-30T11:50:00.000Z", ...over });
const state = (over: Partial<ModelCapacityDeviceState> & { deviceId: string }): ModelCapacityDeviceState => ({ source: "table", limitSlots: 4, secondaryCap: 1, idleMs: 60_000, reserveSlots: 0,
  active: 0, secondaryActive: 0, secondaryBound: 1, primaryBusy: false, lending: false, waiting: 0, waitingPrimary: 0, version: 3, updatedAt: "2026-10-30T11:50:00.000Z", ...over });
const ROWS = [
  row({ deviceId: "supa", roles: [{ routeId: "crawl-agent-review", rank: 1 }, { routeId: "product-search-verify", rank: 2 }], note: "1차 심사 장비" }),
  // 정책 개정 전에 미리 만든 행 — 정책의 어느 경로도 쓰지 않는다
  row({ deviceId: "m3-gptoss", limitSlots: 2, secondaryCap: 2, version: 1, roles: [{ routeId: "local-assist-m3", rank: 1 }] }),
];
const STATES = [
  state({ deviceId: "supa", active: 3, secondaryActive: 3, secondaryBound: 4, lending: true, waiting: 2, waitingPrimary: 1 }),
  state({ deviceId: "gpu3090-qwen", source: "policy_fallback", secondaryCap: 4, secondaryBound: 4, active: 5, version: null, updatedAt: null }),
  state({ deviceId: "m3-gptoss", limitSlots: 2, secondaryCap: 2, secondaryBound: 2, version: 1 }),
];
const audit = (over: Partial<AdminLogRow> = {}): AdminLogRow => ({ id: 1, actor: "jr", action: MODEL_CAPACITY_DEVICE_AUDIT_ACTION, target: "supa", createdAt: NOW, actorKind: "github", ip: null, userAgent: null,
  ok: true, error: null, detail: { deviceId: "supa", version: 3, previousVersion: 2, changes: [{ path: "secondaryCap", before: 2, after: 1 }, { path: "roles", before: ["crawl-agent-review=1"], after: ["crawl-agent-review=1", "product-search-verify=2"] }] }, ...over });
const control = { mode: "open" as const, epoch: 3, revision: 12, policy: POLICY, policyVerified: true };
const view = (overrides: Partial<Parameters<typeof buildCapacityDevicesAdminView>[0]> = {}) =>
  buildCapacityDevicesAdminView({ rows: ROWS, states: STATES, control, audit: [audit()], now: NOW, ...overrides });
const form = (entries: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(entries)) data.set(key, value); return data; };
const BASE_FORM = { deviceId: "supa", expectedVersion: "3", limitSlots: "4", secondaryCap: "1", idleSeconds: "60", reserveSlots: "0", physicalLimit: "", note: "" };

beforeEach(() => {
  mocks.admin.mockReset().mockResolvedValue({ login: "operator" });
  mocks.save.mockReset().mockResolvedValue({ ok: true, deviceId: "supa", version: 4, created: false, changes: ["낮은 순위 평소 상한: 1 → 2"] });
});

describe("화면 모형 — 장비 목록은 행 ∪ 정책 장비 ∪ 실시간 상태", () => {
  it("표 행·정책 대체·미설정 장비를 모두 보이고, 역할 순서는 순위 → 순위 없는 정책 경로 순이다", () => {
    const model = view();
    expect(model).toMatchObject({ mode: "open", epoch: 3, revision: 12, policyVerified: true, controlError: null, rowsError: null, statesError: null, lendingCount: 1, issues: [] });
    expect(model.devices.map(device => device.deviceId)).toEqual(["gpu3090-qwen", "m1-qwen", "m3-gptoss", "supa"]);
    const supa = model.devices.find(device => device.deviceId === "supa")!;
    expect(supa).toMatchObject({ source: "table", enabled: true, version: 3, updatedBy: "jr", updatedAt: "2026-10-30T11:50:00.000Z",
      settings: { limitSlots: 4, secondaryCap: 1, idleMs: 60_000, reserveSlots: 0, physicalLimit: null, note: "1차 심사 장비" },
      // 기본값: 칸 수는 정책 groupLimits, 낮은 순위 상한은 칸 수(seed 규칙 cap = limit), 유휴 60초, 비워 둘 칸 0
      defaults: { limitSlots: 4, secondaryCap: 4, idleMs: 60_000, reserveSlots: 0, physicalLimit: null, note: null },
      policyRoutes: ["crawl-agent-review", "crawl-tagline", "product-search-verify"],
      live: { source: "table", active: 3, limitSlots: 4, lending: true, secondaryActive: 3, secondaryBound: 4, primaryBusy: false, waiting: 2, waitingPrimary: 1 }, issues: [] });
    expect(supa.roles).toEqual([
      { routeId: "crawl-agent-review", rank: 1, label: "1차 검수", inPolicy: true },
      { routeId: "product-search-verify", rank: 2, label: "키워드 검수", inPolicy: true },
      { routeId: "crawl-tagline", rank: null, label: "소개 생성", inPolicy: true }]);
    // 행이 없는 정책 장비 → 정책 대체(groupLimits 로 칸 수·낮은 순위 상한) + 실시간 상태(policy_fallback)
    const gpu = model.devices.find(device => device.deviceId === "gpu3090-qwen")!;
    expect(gpu).toMatchObject({ source: "policy_fallback", version: null, updatedBy: null, settings: { limitSlots: 4, secondaryCap: 4, idleMs: 60_000, reserveSlots: 0 },
      roles: [{ routeId: "second-review", rank: null, label: "2차 검수", inPolicy: true }], live: { source: "policy_fallback", active: 5 } });
    expect(gpu.issues).toEqual([expect.stringContaining("policy_fallback"), expect.stringContaining("점유 5가 칸 수 4를 넘습니다")]);
    // 행도 상태도 없는 정책 장비는 정책 대체(실시간 상태 미확인)
    const m1 = model.devices.find(device => device.deviceId === "m1-qwen")!;
    expect(m1).toMatchObject({ source: "policy_fallback", live: null, settings: { limitSlots: 2, secondaryCap: 2 }, roles: [
      { routeId: "product-translate", rank: null, label: "공개 번역", inPolicy: true }, { routeId: "reason-translate", rank: null, label: "사유 번역", inPolicy: true }] });
    // 정책에 없는 장비 행 — 미리 만든 행이면 정상이라고 알리고, 정책 밖 경로 순위를 표시한다
    const m3 = model.devices.find(device => device.deviceId === "m3-gptoss")!;
    expect(m3).toMatchObject({ source: "table", policyRoutes: [], roles: [{ routeId: "local-assist-m3", rank: 1, label: "local-assist-m3", inPolicy: false }] });
    expect(m3.issues).toEqual([expect.stringContaining("어느 경로도 이 장비를 쓰지 않습니다"), "순위에 있지만 현재 정책에 없는 경로: local-assist-m3"]);
  });

  it("groupLimits 도 행도 없는 장비는 device_unconfigured 로 알리고, 꺼진 행·엔진 실제 초과도 문제로 올린다", () => {
    const policy = { ...POLICY, groupLimits: { supa: 4 }, routes: POLICY.routes.filter(route => route.groupId !== "m1-qwen" || route.routeId === "product-translate") };
    const model = view({ control: { ...control, policy }, rows: [row({ deviceId: "supa", enabled: false, physicalLimit: 2 })], states: [] });
    expect(model.devices.find(device => device.deviceId === "m1-qwen")).toMatchObject({ source: "unconfigured", settings: { limitSlots: null, secondaryCap: null },
      issues: [expect.stringContaining("device_unconfigured")] });
    expect(model.devices.find(device => device.deviceId === "supa")!.issues).toEqual([expect.stringContaining("꺼진 행"), "칸 수(4)가 엔진 실제 동시 처리 수(2)를 넘습니다"]);
    expect(model.lendingCount).toBe(0);
  });

  it("제어 행·장비 행·실시간 상태를 못 읽어도 화면은 뜬다 — 그 자리에 이유; 정책 hash 불일치·정책 없음은 문제 줄", () => {
    const none = view({ control: null, controlError: "model_capacity_control_missing", rows: null, rowsError: "Cannot find module", states: null, statesError: "boom" });
    expect(none).toMatchObject({ mode: null, epoch: null, controlError: "model_capacity_control_missing", rowsError: "Cannot find module", statesError: "boom", devices: [] });
    expect(view({ states: null }).statesError).toBe("model_capacity_device_states_unreadable");
    expect(view({ control: { ...control, policy: null, policyVerified: false } }).issues).toEqual([expect.stringContaining("hash")]);
    expect(view({ control: { mode: "disabled", epoch: 1, revision: 1, policy: null, policyVerified: true }, states: [] }).issues).toEqual([expect.stringContaining("정책이 없습니다")]);
  });

  it("감사 줄은 바뀐 값을 한국어 이름으로 — 최근 10줄", () => {
    const model = view();
    expect(model.audit).toEqual([{ id: 1, actor: "jr", at: NOW.toISOString(), ok: true, deviceId: "supa", version: 3, error: null,
      changes: ["낮은 순위 평소 상한: 2 → 1", "역할 순서: crawl-agent-review=1 → crawl-agent-review=1, product-search-verify=2"] }]);
    expect(deviceAuditChangeLines(audit({ detail: { changes: [{ path: "limitSlots", before: null, after: 4 }] } }))).toEqual(["칸 수: 없음 → 4"]);
    // 1b-A 저장소가 남기는 모양 { version, expectedVersion, before, after }(roles 는 [{routeId, rank}]) — changes 가 없으면 before/after 에서 만든다
    const saved = audit({ target: "gpu3090-qwen", detail: { version: 2, expectedVersion: 1,
      before: { limitSlots: 4, secondaryCap: 4, idleMs: 60_000, reserveSlots: 0, physicalLimit: null, roles: [], note: null, enabled: true },
      after: { limitSlots: 4, secondaryCap: 2, idleMs: 60_000, reserveSlots: 1, physicalLimit: null, roles: [{ routeId: "second-review", rank: 1 }, { routeId: "local-screen", rank: 2 }], note: null, enabled: true } } });
    expect(deviceAuditChangeLines(saved)).toEqual(["항상 비워 둘 칸: 0 → 1", "역할 순서: 없음 → second-review=1, local-screen=2", "낮은 순위 평소 상한: 4 → 2"]);
    expect(view({ audit: [saved] }).audit[0]).toMatchObject({ deviceId: "gpu3090-qwen", version: 2, ok: true });
    // 새 장비의 빈 순위·빈 메모("없음 → 없음")는 줄이 되지 않는다
    expect(deviceAuditChangeLines(audit({ detail: { version: 1, expectedVersion: null, before: null, after: { limitSlots: 2, roles: [], note: null, enabled: true } } })))
      .toEqual(["사용: 없음 → true", "칸 수: 없음 → 2"]);
    expect(view({ audit: Array.from({ length: 12 }, (_, index) => audit({ id: index + 1 })) }).audit).toHaveLength(10);
    expect(view({ audit: [audit({ ok: false, error: "model_capacity_device_version_mismatch:3", target: "supa", detail: { deviceId: "supa", expectedVersion: 2 } })] }).audit[0])
      .toMatchObject({ ok: false, error: "model_capacity_device_version_mismatch:3", version: null, changes: [] });
  });

  it("역할 이름은 실시간 한도 화면의 ROUTE_LABELS → 단계 이름 → 경로 id 순이다", () => {
    expect(deviceRoleLabel("product-search-verify")).toBe("키워드 검수");
    // ROUTE_LABELS 에 없는 경로는 단계 이름(modelStageLabel: crawl-agent-review → 1차 검수)
    expect(deviceRoleLabel("crawl-agent-review")).toBe("1차 검수");
    expect(deviceRoleLabel("human-deepseek-review")).toBe("사람 위임 검수");
    expect(deviceRoleLabel("local-assist-m3")).toBe("local-assist-m3");
    // 2026-11-09: 그 밖은 작업·보조·옛 경로 이름으로 채운다(같은 id 를 두 번 찍지 않게)
    expect(deviceRoleLabel("local-held-qwen")).toBe("보류 재심사");
    expect(deviceRoleLabel("local-assist-decision_audit-m3-deepseek")).toBe("보조 · 판정 감사");
    expect(deviceRoleLabel("product-tagline-ko-qwen-legacy")).toBe("옛 경로 · 한국어 소개 번역");
    expect(DEVICE_FIELD_LABELS.secondaryCap).toBe("낮은 순위 평소 상한");
  });
});

describe("폼 → 저장 입력", () => {
  it("초는 ms 로, 빈 엔진 실제는 null, rank:<route> 와 extraRoute 는 순위 목록으로, 빈 expectedVersion 은 CAS 없음", () => {
    const parsed = capacityDeviceInputFromForm(form({ ...BASE_FORM, idleSeconds: "1.5", physicalLimit: "8", note: "  메모  ",
      "rank:crawl-agent-review": "1", "rank:product-search-verify": " 2 ", "rank:crawl-tagline": "", "extraRoute:0": "local-x", "extraRank:0": "3", "extraRoute:1": "", "extraRank:1": "" }));
    expect(parsed).toEqual({ expectedVersion: 3, issues: [], input: { deviceId: "supa", limitSlots: 4, secondaryCap: 1, idleMs: 1_500, reserveSlots: 0, physicalLimit: 8, note: "메모",
      roles: [{ routeId: "crawl-agent-review", rank: 1 }, { routeId: "product-search-verify", rank: 2 }, { routeId: "local-x", rank: 3 }] } });
    expect(capacityDeviceInputFromForm(form({ ...BASE_FORM, deviceId: " new-dev ", expectedVersion: "" }))).toMatchObject({ expectedVersion: null, input: { deviceId: "new-dev", physicalLimit: null, note: null, roles: [] } });
  });

  it("장비 이름 없음·정수 아님·중복 경로·순위만 적음·잘못된 판 번호는 한국어로 거절하고 저장 입력을 만들지 않는다", () => {
    expect(capacityDeviceInputFromForm(form({ ...BASE_FORM, deviceId: "" })).issues).toEqual(["장비 이름을 넣어주세요"]);
    expect(capacityDeviceInputFromForm(form({ ...BASE_FORM, limitSlots: "넷", secondaryCap: "1.5", reserveSlots: "", idleSeconds: "-1", physicalLimit: "x" })).issues).toEqual([
      "칸 수: 정수를 넣어주세요", "낮은 순위 평소 상한: 정수를 넣어주세요", "항상 비워 둘 칸: 정수를 넣어주세요", "유휴 판정 시간(초): 0 이상의 초 단위 숫자를 넣어주세요",
      "엔진 실제 동시 처리 수: 정수를 넣어주세요(비우면 없음)"]);
    expect(capacityDeviceInputFromForm(form({ ...BASE_FORM, "rank:a": "1", "extraRoute:0": "a", "extraRank:0": "2", "extraRoute:1": "", "extraRank:1": "5", "rank:b": "둘" })).issues)
      .toEqual(["역할 순서 b(b): 순위는 정수입니다(비우면 순위 없음)", "역할 순서에 같은 경로가 두 번 있습니다: a", "역할 순서: 경로 이름 없이 순위만 적었습니다"]);
    const stale = capacityDeviceInputFromForm(form({ ...BASE_FORM, expectedVersion: "0" }));
    expect(stale).toMatchObject({ input: null, issues: ["판 번호(version)를 읽지 못했습니다. 새로고침해주세요."] });
    expect(capacityDeviceInputFromForm(form({ ...BASE_FORM, note: "x".repeat(401) })).issues).toEqual(["메모는 400자까지입니다"]);
  });
});

describe("거절 코드 → 한국어", () => {
  it("CAS·검사·fence·미구현은 문장으로, 모르는 코드는 그대로 보인다", () => {
    expect(capacityDeviceIssueMessage("model_capacity_device_version_mismatch:5")).toBe("다른 사람이 먼저 저장했습니다(지금 판 5). 새로고침해 바뀐 값을 확인한 뒤 다시 저장해주세요.");
    expect(capacityDeviceIssueMessage("model_capacity_device_version_mismatch:none")).toContain("없음(새 장비)");
    expect(capacityDeviceIssueMessage("model_capacity_device_version_mismatch:invalid")).toBe("판 번호(version)를 읽지 못했습니다. 새로고침해주세요.");
    expect(capacityDeviceIssueMessage("model_capacity_device_version_exhausted")).toContain("판 번호가 상한");
    // 1b-A 의 zod 는 교차 검사도 그 칸의 path 로 던진다(secondaryCap·reserveSlots·limitSlots·roles) — 범위와 교차 규칙을 함께 적는다
    expect(capacityDeviceIssueMessage("model_capacity_device_invalid:secondaryCap")).toBe("낮은 순위 평소 상한: 0 이상, 칸 수 이하의 정수여야 합니다(칸 수를 넘을 수 없습니다)");
    expect(capacityDeviceIssueMessage("model_capacity_device_invalid:secondary_cap_exceeds_limit")).toBe(capacityDeviceIssueMessage("model_capacity_device_invalid:secondaryCap"));
    expect(capacityDeviceIssueMessage("model_capacity_device_invalid:reserveSlots")).toContain("항상 비워 둘 칸: 0 이상, 칸 수 미만");
    expect(capacityDeviceIssueMessage("model_capacity_device_invalid:reserve_exceeds_limit")).toBe(capacityDeviceIssueMessage("model_capacity_device_invalid:reserveSlots"));
    expect(capacityDeviceIssueMessage("model_capacity_device_invalid:limitSlots")).toContain("엔진 실제 동시 처리 수를 적었으면 그 값을 넘을 수 없습니다");
    expect(capacityDeviceIssueMessage("model_capacity_device_invalid:limit_exceeds_physical")).toBe(capacityDeviceIssueMessage("model_capacity_device_invalid:limitSlots"));
    expect(capacityDeviceIssueMessage("model_capacity_device_invalid:roles")).toBe("역할 순서: 같은 경로가 두 번 있거나 64개를 넘습니다");
    expect(capacityDeviceIssueMessage("model_capacity_device_invalid:roles.1.rank")).toBe("역할 순서 2번째: 순위는 1~64 의 정수입니다");
    expect(capacityDeviceIssueMessage("model_capacity_device_invalid:roles.0.routeId")).toContain("역할 순서 1번째: 경로 id");
    expect(capacityDeviceIssueMessage("model_capacity_device_invalid:idleMs")).toBe("유휴 판정 시간: 0~3600초여야 합니다");
    expect(capacityDeviceIssueMessage("model_capacity_device_invalid:deviceId")).toContain("장비 이름: 1~120자");
    expect(capacityDeviceIssueMessage("model_capacity_device_invalid:root")).toContain("장비 설정 모양이 틀립니다");
    expect(capacityDeviceIssueMessage("model_capacity_device_invalid:actor")).toContain("다시 로그인");
    expect(capacityDeviceIssueMessage("model_capacity_device_invalid:enabled")).toBe("사용: 범위를 벗어났거나 형식이 틀립니다(enabled)");
    expect(capacityDeviceIssueMessage("model_capacity_device_invalid:something")).toBe("장비 설정이 검사를 통과하지 못했습니다: something");
    expect(capacityDeviceIssueMessage("site_fenced")).toBe("이 사이트는 지금 쓰기가 막혀 있습니다(DR).");
    expect(capacityDeviceIssueMessage("model_capacity_replay_unsupported")).toContain("재생(replay) DB");
    expect(capacityDeviceIssueMessage("Cannot find module '@/lib/llm/capacity-devices-repository'")).toBe("저장 경로가 아직 준비되지 않았습니다(model_capacity_devices).");
    expect(capacityDeviceIssueMessage("something_new:detail")).toBe("something_new:detail");
  });
});

describe("server action — 쓰기 관문 뒤 관리자 확인·폼 검사·CAS·거절 문장", () => {
  it("저장 입력과 expectedVersion 을 저장 경로로 넘기고 판·즉시 적용을 알린다", async () => {
    const result = await saveCapacityDevice(null, form({ ...BASE_FORM, secondaryCap: "2", "rank:crawl-agent-review": "1" }));
    expect(mocks.save).toHaveBeenCalledWith({ deviceId: "supa", limitSlots: 4, secondaryCap: 2, idleMs: 60_000, reserveSlots: 0, physicalLimit: null, note: null,
      roles: [{ routeId: "crawl-agent-review", rank: 1 }] }, 3, "operator");
    expect(result).toEqual({ ok: true, message: "저장했습니다(장비 supa, 판 4). 다음 입장 판정부터 바로 쓰입니다 — DRAIN 불필요. 바뀐 값: 낮은 순위 평소 상한: 1 → 2" });
    mocks.save.mockResolvedValue({ ok: true, deviceId: "m3-gptoss", version: 1, created: true, changes: [] });
    expect(await saveCapacityDevice(null, form({ ...BASE_FORM, deviceId: "m3-gptoss", expectedVersion: "" }))).toEqual({ ok: true,
      message: "만들었습니다(장비 m3-gptoss, 판 1). 다음 입장 판정부터 바로 쓰입니다 — DRAIN 불필요. 바뀐 값이 없습니다." });
    expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ deviceId: "m3-gptoss" }), null, "operator");
  });

  it("CAS 거절과 검사 거절은 그대로 한국어로 보이고 성공으로 바꾸지 않는다; 던진 오류도 문장으로", async () => {
    mocks.save.mockResolvedValue({ ok: false, issues: ["model_capacity_device_version_mismatch:4"] });
    expect(await saveCapacityDevice(null, form(BASE_FORM))).toEqual({ issues: ["다른 사람이 먼저 저장했습니다(지금 판 4). 새로고침해 바뀐 값을 확인한 뒤 다시 저장해주세요."] });
    mocks.save.mockResolvedValue({ ok: false, issues: ["model_capacity_device_invalid:secondaryCap", "weird_code"] });
    expect(await saveCapacityDevice(null, form(BASE_FORM))).toEqual({ issues: ["낮은 순위 평소 상한: 0 이상, 칸 수 이하의 정수여야 합니다(칸 수를 넘을 수 없습니다)", "weird_code"] });
    mocks.save.mockRejectedValue(new Error("not_implemented"));
    expect(await saveCapacityDevice(null, form(BASE_FORM))).toEqual({ issues: ["저장 경로가 아직 준비되지 않았습니다(model_capacity_devices)."] });
  });

  it("비관리자·폼 문제는 저장 경로에 닿지 않는다", async () => {
    expect(await saveCapacityDevice(null, form({ ...BASE_FORM, limitSlots: "" }))).toEqual({ issues: ["칸 수: 정수를 넣어주세요"] });
    mocks.admin.mockResolvedValue(null);
    expect(await saveCapacityDevice(null, form(BASE_FORM))).toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

describe("그리기", () => {
  const model = view();
  it("장비 목록 표 — 출처·설정값·역할 순서·점유(예약+진행)·우선 역할·빌려 쓰는 중·판·마지막 저장", () => {
    const html = renderToStaticMarkup(createElement(DeviceTable, { devices: model.devices, now: NOW }));
    for (const text of ["점유(예약+진행)", "낮은 순위 평소 상한", "유휴 판정", "비워 둘 칸", "엔진 실제", "역할 순서", "우선 역할", "대기", "마지막 저장"]) expect(html).toContain(text);
    expect(html).toContain('href="#device-supa"');
    expect(html).toContain("빌려 쓰는 중");
    expect(html).toContain("정책 대체");
    expect(html).toContain("유휴");
    expect(html).toContain("초과");
    expect(html).toContain("1차 검수");
    // 순위 없는 경로도 이름으로(경로 id 는 title)
    expect(html).toContain("순위 없음: 소개 생성");
    expect(html).toContain("정책 밖");
    expect(html).toContain("저장한 적 없음");
    expect(html).toContain("60초");
    expect(renderToStaticMarkup(createElement(DeviceTable, { devices: [], now: NOW }))).toContain("장비가 없습니다");
  });
  it("2026-11-09: 장비 이름은 연결 이름이 먼저, 장비 id(정책 groupId)는 다를 때만 옆에 작게 — 연결이 없는 장비는 「연결 없음」", () => {
    const names = { "m1-qwen": { name: "m1-gemma", connected: true }, supa: { name: "supa", connected: false }, "gpu3090-qwen": { name: "gpu3090-qwen", connected: true } };
    const html = renderToStaticMarkup(createElement(DeviceTable, { devices: model.devices, now: NOW, names }));
    const cell = (deviceId: string) => html.match(new RegExp(`data-device="${deviceId}"><td[^>]*>([^]*?)</td>`))![1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    expect(cell("m1-qwen")).toMatch(/^m1-gemma m1-qwen( 문제 \d+)?$/);
    expect(cell("gpu3090-qwen")).toMatch(/^gpu3090-qwen( 문제 \d+)?$/);
    expect(cell("supa")).toMatch(/^supa 연결 없음( 문제 \d+)?$/);
    const form = renderToStaticMarkup(createElement(DeviceForm, { device: model.devices.find(device => device.deviceId === "m1-qwen")!, name: "m1-gemma" }));
    expect(form).toMatch(/<h3[^>]*>m1-gemma<code[^>]*>m1-qwen<\/code><\/h3>/);
  });
  it("장비 폼 — 숨은 deviceId·expectedVersion(CAS)·칸 이름·기본값·바꿈 표시·역할 순위 칸·추가 경로", () => {
    const supa = model.devices.find(device => device.deviceId === "supa")!;
    const html = renderToStaticMarkup(createElement(DeviceForm, { device: supa }));
    expect(html).toContain('id="device-supa"');
    expect(html).toContain('type="hidden" name="deviceId" value="supa"');
    expect(html).toContain('name="expectedVersion" value="3"');
    for (const name of ["limitSlots", "secondaryCap", "idleSeconds", "reserveSlots", "physicalLimit", "note"]) expect(html).toContain(`name="${name}"`);
    expect(html).toContain('aria-label="칸 수"');
    expect(html).toContain("기본 4칸");
    expect(html).toContain("기본 60초");
    expect(html).toContain("바꿈");          // secondaryCap 1 ≠ 기본 4
    expect(html).toContain("기본값");
    expect(html).toContain('name="rank:crawl-agent-review"');
    expect(html).toContain('value="1"');
    expect(html).toContain('name="rank:crawl-tagline"');
    expect(html).toContain("순위 없음(최하위)");
    expect(html).toContain('name="extraRoute:0"');
    expect(html).toContain("이 장비 저장");
    expect(html).toContain("DRAIN 불필요");
    expect(html).toContain("판 3");
    // 새 장비 폼은 이름 입력·빈 expectedVersion·추가 경로 셋
    const fresh = renderToStaticMarkup(createElement(DeviceForm, { device: null }));
    expect(fresh).toContain('id="device-new"');
    expect(fresh).toContain('aria-label="장비 이름"');
    expect(fresh).toContain('name="expectedVersion" value=""');
    expect(fresh).toContain('name="extraRoute:2"');
    expect(fresh).toContain("새 장비 만들기");
    // 정책 대체 장비는 같은 폼으로 첫 행을 만든다; 읽기 전용이면 단추가 꺼진다
    const gpu = renderToStaticMarkup(createElement(DeviceForm, { device: model.devices.find(device => device.deviceId === "gpu3090-qwen")!, readOnly: true }));
    expect(gpu).toContain("정책 대체 — 저장하면 행이 생깁니다");
    expect(gpu).toContain("읽기 전용");
    expect(gpu).toMatch(/<button[^>]*disabled/);
    expect(renderToStaticMarkup(createElement(RolesEditor, { roles: supa.roles, extraRows: 0 }))).not.toContain("extraRoute");
  });
  it("장비 한도 메뉴는 「장비 한도」 화면을 연다 — 메뉴·제목·옛 메뉴 이름이 같다(PR 5: 실시간 한도의 자리표시 묶음은 지웠다)", () => {
    const page = readFileSync(path.resolve(__dirname, "../app/(operator)/admin/models/devices/page.tsx"), "utf8");
    expect(page).toContain("<PageStamp />");
    expect(page).toContain('modelsAdvancedEditor("devices")');
    expect(page).not.toContain("엔진 공유 한도");
    expect(modelsAdvancedEditor("devices").label).toBe("장비 한도");
    expect(NAV_GROUPS[1].pages.find(page => page.href === "/admin/models/devices")).toMatchObject({ label: "장비 한도" });
    expect(readFileSync(path.resolve(__dirname, "../app/(operator)/admin/models/limits/page.tsx"), "utf8")).not.toContain("DevicesPlaceholder");
  });
});

/** tests/stubs 의 ambient 형 선언은 WP-A 의 진짜 파일보다 우선한다(tsc paths) — 둘이 함께 있으면 진짜 형이 가려지므로 합칠 때 stub 을 지운다 */
it("WP-A 의 lib/llm/capacity-devices*.ts 가 들어오면 tests/stubs 의 임시 형 선언은 지워져야 한다", () => {
  const root = path.resolve(__dirname, "..");
  const real = ["lib/llm/capacity-devices.ts", "lib/llm/capacity-devices-repository.ts"].filter(file => existsSync(path.join(root, file)));
  const stub = existsSync(path.join(root, "tests/stubs/capacity-devices-frozen-interface.d.ts"));
  expect(real.length > 0 && stub, `delete tests/stubs/capacity-devices-frozen-interface.d.ts — real files present: ${real.join(", ")}`).toBe(false);
});
