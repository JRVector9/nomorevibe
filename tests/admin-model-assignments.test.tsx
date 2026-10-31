import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 모델 배정 화면(PR 3b-D) — 화면 모형·고르기·폼 → 저장 입력·거절 문장·그리기·server action·설정 폼 읽기 전용. DB 없이 본다; 저장 함수는 가짜다.
const mocks = vi.hoisted(() => ({ admin: vi.fn(), save: vi.fn(), off: vi.fn(), apply: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/operations/admin-model-assignments", async importOriginal => ({ ...(await importOriginal<object>()),
  saveAdminModelAssignment: mocks.save, turnOffAdminModelAssignment: mocks.off, applyAdminAssignmentImport: mocks.apply }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
// 설정 폼(떠날 때 묻는 확인 창·저장 뒤 새로고침)이 라우터를 쓴다 — 정적 그리기에는 라우터가 없다
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { applyAssignmentImportAction, saveModelAssignmentAction, turnOffModelAssignmentAction } from "@/app/(operator)/admin/models/assignments/actions";
import { AssignmentForm } from "@/app/(operator)/admin/models/assignments/AssignmentForm";
import { AssignmentStageTable } from "@/app/(operator)/admin/models/assignments/AssignmentTable";
import { ImportCard } from "@/app/(operator)/admin/models/assignments/ImportCard";
import { SettingsForm } from "@/app/(operator)/admin/SettingsForm";
import { ReviewModelsForm } from "@/app/(operator)/admin/models/ReviewModelsForm";
import { reviewModelOptions } from "@/app/(operator)/admin/models/model-options";
import { NAV_GROUPS } from "@/app/(operator)/admin/AdminNav";
import { engineConnectAssignmentHref } from "@/lib/operations/admin-engine-connect";
import { planAssignmentImport, type AssignmentImportSources } from "@/lib/llm/assignment-import";
import {
  ASSIGNMENT_STAGE_IDS, HELPER_ROUTE_DEFAULTS, MODEL_ASSIGNMENT_REFUSALS, parseHelperAssignment, type HelperAssignmentRow, type ModelAssignmentRow,
} from "@/lib/llm/capacity-helpers";
import type { ModelCapacityDeviceRow } from "@/lib/llm/capacity-devices";
import type { ModelCapacityPolicy } from "@/lib/llm/capacity";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { DEFAULT_MODEL_DEFINITIONS, readModelRegistry, type ModelDefinition } from "@/lib/llm/model-registry";
import { assignmentSources, assignmentTableFlag, setAssignmentSourceReaderForTest } from "@/lib/operations/admin-assignment-source";
import type { AdminLogRow } from "@/lib/operations/admin-log";
import {
  ASSIGNMENT_FLAG_OFF_BANNER, ASSIGNMENT_STAGE_LABELS, MODEL_ASSIGNMENT_REFUSAL_MESSAGES, assignmentAuditChangeLines, assignmentFormOptions, assignmentIdFor,
  assignmentImportPlanHash, assignmentImportPreviewOf, assignmentPrefillFromParams, assignmentSavedMessage, assignmentTransportsFor,
  buildModelAssignmentsAdminView, modelAssignmentInputFromForm, modelAssignmentInputOf, modelAssignmentIssueMessage,
} from "@/lib/operations/admin-model-assignments";
import type { ModelAssignmentSaveResult } from "@/lib/llm/capacity-helpers-repository";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const HASH = "c".repeat(64), EK = "e".repeat(64);
const definition = (key: string, provider: ModelDefinition["provider"], model: string, extra: Partial<ModelDefinition> = {}): ModelDefinition =>
  ({ key, equipment: key.slice(0, key.indexOf(":")), displayName: key, provider, baseUrl: provider === "abcllm" || provider === "local-direct" ? "http://e.test:8000/v1" : null,
    model, family: model.toLowerCase(), timeoutMs: 60_000, maxTokens: 8_000, concurrency: 1, purposes: ["fixture"], ...extra });
const ENG = definition("eng:qwen", "abcllm", "Qwen-X");
/** connect 장비가 아닌 CLI 모델 — cli 전송을 쓸 수 없다 */
const ODD_CLI = definition("odd:claude", "claude-cli", "sonnet");
const MODELS: ModelDefinition[] = [...DEFAULT_MODEL_DEFINITIONS, ENG, ODD_CLI];

const row = (over: Partial<ModelAssignmentRow> & Pick<ModelAssignmentRow, "assignmentId" | "stage" | "deviceId" | "registryKey" | "transport" | "model" | "routeId">):
  ModelAssignmentRow => ({ rank: 1, role: "primary", vote: false, mode: "live", provider: "abcllm", maxSlots: 1, evidenceKey: EK, version: 3, note: null,
    updatedBy: "jr", createdAt: at(-86_400_000), updatedAt: at(-60_000), ...over });
const AI1 = row({ assignmentId: "eng-dev:ai1:eng:qwen", stage: "ai1", deviceId: "eng-dev", registryKey: "eng:qwen", transport: "direct", model: "Qwen-X",
  routeId: "crawl-agent-review" });
const AI2_VOTE = row({ assignmentId: "supa:ai2:supa:review", stage: "ai2", deviceId: "supa", registryKey: "supa:review", transport: "gateway",
  model: "[supa] Qwen3.8-27B-NVFP4", routeId: "second-review", vote: true, version: 5 });
const AI2_BACKUP = row({ assignmentId: "eng-dev:ai2:eng:qwen", stage: "ai2", deviceId: "eng-dev", registryKey: "eng:qwen", transport: "direct", model: "Qwen-X",
  routeId: "second-review", rank: 2, mode: "off" });
const INTRO = row({ assignmentId: "connect:intro:connect:sonnet", stage: "intro", deviceId: "connect", registryKey: "connect:sonnet", transport: "cli",
  model: "sonnet", routeId: "product-intro-check", provider: "claude-cli" });
const HELPER: HelperAssignmentRow = { ...parseHelperAssignment({ assignmentId: "m3-deepseek:ai1", stage: "ai1", deviceId: "m3-deepseek",
  model: "deepseek-v4.1-flash-1017", ...HELPER_ROUTE_DEFAULTS.ai1, mode: "shadow" }), version: 2, evidenceKey: EK, promotedAt: null, promotedBy: null,
  updatedBy: "jr", createdAt: at(-86_400_000), updatedAt: at(-60_000) };
const device = (deviceId: string, roles: { routeId: string; rank: number }[], enabled = true): ModelCapacityDeviceRow => ({ deviceId, limitSlots: 4,
  secondaryCap: 4, idleMs: 60_000, reserveSlots: 0, physicalLimit: null, note: null, roles, enabled, version: 1, updatedBy: "jr", createdAt: at(-1), updatedAt: at(-1) });
const DEVICES = [device("eng-dev", [{ routeId: "crawl-agent-review", rank: 1 }, { routeId: "second-review", rank: 3 }]),
  device("supa", [{ routeId: "second-review", rank: 1 }]), device("connect", []), device("m3-deepseek", [{ routeId: HELPER.liveRouteId, rank: 2 }]),
  device("old-box", [], false)];
const POLICY: ModelCapacityPolicy = { version: 1, maxWaiting: 64, queueTtlMs: 60_000, reservationTtlMs: 60_000, routes: [
  { routeId: "crawl-agent-review", provider: "abcllm", model: "Qwen-X", providerBudgetId: "eng", groupId: "eng-dev" },
  { routeId: "second-review", provider: "abcllm", model: "[supa] Qwen3.8-27B-NVFP4", providerBudgetId: "supa", groupId: "gpu-other" },
] } as ModelCapacityPolicy;
const viewOf = (over: Partial<Parameters<typeof buildModelAssignmentsAdminView>[0]> = {}) => buildModelAssignmentsAdminView({
  assignments: [INTRO, AI2_BACKUP, AI1, AI2_VOTE], helpers: [HELPER], devices: DEVICES, policy: { mode: "open", revision: 7, policy: POLICY },
  contracts: [{ id: 11, routeId: "crawl-agent-review", model: "Qwen-X", contractHash: HASH, transport: "direct" }],
  settled: [{ routeId: "crawl-agent-review", model: "Qwen-X", groupId: "eng-dev", settled: 42 }, { routeId: "crawl-agent-review", model: "Qwen-X", groupId: "eng-dev", settled: 3 }],
  models: MODELS, now: NOW, ...over });
const form = (entries: Record<string, string>) => { const data = new FormData(); for (const [key, value] of Object.entries(entries)) data.set(key, value); return data; };

beforeEach(() => { vi.clearAllMocks(); mocks.admin.mockResolvedValue({ login: "jr" }); setAssignmentSourceReaderForTest(null); });

describe("화면 모형 — 단계별 묶음", () => {
  it("ASSIGNMENT_STAGES 순서·한국어 이름으로 묶고, 묶음 안은 주 배정(순위 → 이름) 다음 도우미", () => {
    const view = viewOf();
    expect(view.groups.map(group => group.id)).toEqual([...ASSIGNMENT_STAGE_IDS]);
    expect(view.groups.map(group => group.label)).toEqual(ASSIGNMENT_STAGE_IDS.map(stage => ASSIGNMENT_STAGE_LABELS[stage]));
    expect(view.groups.find(group => group.id === "ai1")!.rows.map(entry => [entry.assignmentId, entry.roleLabel]))
      .toEqual([["eng-dev:ai1:eng:qwen", "주 배정"], ["m3-deepseek:ai1", "도우미"]]);
    expect(view.groups.find(group => group.id === "ai2")!.rows.map(entry => entry.assignmentId)).toEqual(["supa:ai2:supa:review", "eng-dev:ai2:eng:qwen"]);
    for (const stage of ["assist", "assist-audit", "repo"]) expect(view.groups.find(group => group.id === stage)).toMatchObject({ reserved: true, rows: [] });
    expect(view.counts).toEqual({ primary: 4, live: 3, helpers: 1 });
    expect(view.policy).toEqual({ mode: "open", revision: 7, routes: 2 });
    expect(view.readOnly).toBe(false);
  });

  it("칸: 계약(있음 + hash 앞 12자리 / 없음 / CLI), route(있음·없음·다른 장비), 장비 역할 순위, 최근 1시간 합, 도우미는 도우미 화면으로", () => {
    const rows = viewOf().groups.flatMap(group => group.rows);
    const ai1 = rows.find(entry => entry.assignmentId === AI1.assignmentId)!;
    expect(ai1).toMatchObject({ registryKey: "eng:qwen", model: "Qwen-X", transportLabel: "엔진 직접", modeLabel: "실전", rank: 1, deviceRoleRank: 1, settled1h: 45,
      contract: { state: "present", hashPrefix: "c".repeat(12), transportMismatch: false }, route: { state: "present", label: "있음" },
      editHref: "/admin/models/assignments?edit=eng-dev%3Aai1%3Aeng%3Aqwen#form", helperHref: null, issues: [] });
    const vote = rows.find(entry => entry.assignmentId === AI2_VOTE.assignmentId)!;
    expect(vote).toMatchObject({ vote: true, contract: { state: "missing", label: "없음" }, route: { state: "other_device", label: "다른 장비(gpu-other)" }, settled1h: 0 });
    expect(vote.issues).toEqual(expect.arrayContaining([expect.stringContaining("켜진 계약이 없습니다"), expect.stringContaining("다른 장비에 묶여")]));
    const backup = rows.find(entry => entry.assignmentId === AI2_BACKUP.assignmentId)!;
    expect(backup).toMatchObject({ modeLabel: "꺼짐", rank: 2, deviceRoleRank: 3, route: { state: "missing" } });
    expect(backup.issues).toEqual([expect.stringContaining("장비 역할 순위(3)가 배정 순위(2)와 다릅니다")]);
    expect(rows.find(entry => entry.assignmentId === INTRO.assignmentId)).toMatchObject({ transportLabel: "CLI", contract: { state: "cli" } });
    expect(rows.find(entry => entry.assignmentId === HELPER.assignmentId)).toMatchObject({ role: "helper", modeLabel: "섀도", transportLabel: "—",
      helperHref: "/admin/models/helpers#helper-m3-deepseek:ai1", editHref: null, deviceRoleRank: 2, contract: { state: "helper" } });
  });

  it("못 읽은 것은 모름·—(화면은 뜬다); 배정 표를 못 읽으면 읽기 전용; 장비·등록부 문제는 행의 알림", () => {
    const view = viewOf({ settled: null, contracts: null, policy: null, errors: { counts: "canceling statement due to statement timeout" } });
    const ai1 = view.groups[0].rows[0];
    expect(ai1).toMatchObject({ settled1h: null, contract: { label: "모름(계약을 읽지 못함)" }, route: { state: "unknown" } });
    expect(view.errors).toEqual({ counts: "canceling statement due to statement timeout" });
    expect(viewOf({ assignments: null }).readOnly).toBe(true);
    const stray = row({ assignmentId: "ghost:ai1:gone:model", stage: "ai1", deviceId: "ghost", registryKey: "gone:model", transport: "direct", model: "M",
      routeId: "crawl-agent-review", mode: "off" });
    const issues = viewOf({ assignments: [stray] }).groups[0].rows[0].issues;
    expect(issues).toEqual([expect.stringContaining("등록부에 없는 key(gone:model)"), expect.stringContaining("장비 행이 없습니다")]);
  });

  it("상태 띠: 플래그가 꺼지면 모두 설정(legacy) + 「읽기: 설정(legacy). 플래그 MODEL_ASSIGNMENT_TABLE 켜면 표를 읽습니다」; 켜지면 표·설정·표 비어 있음", async () => {
    const off = viewOf();
    expect(off.banner).toBe("읽기: 설정(legacy). 플래그 MODEL_ASSIGNMENT_TABLE 켜면 표를 읽습니다");
    expect(off.banner).toBe(ASSIGNMENT_FLAG_OFF_BANNER);
    expect(new Set(off.groups.map(group => group.sourceLabel))).toEqual(new Set(["설정"]));
    const on = viewOf({ flagOn: true, sources: { ai1: "table", ai2: "table", human: "table", intro: "legacy" } });
    expect(on.banner).toContain("켜짐");
    const source = (stage: string) => on.groups.find(group => group.id === stage)!.sourceLabel;
    expect([source("ai1"), source("human"), source("intro"), source("reason")]).toEqual(["표", "표 비어 있음", "설정", "설정"]);
    // 3b-B 의 실제 출처: 이 프로세스의 MODEL_ASSIGNMENT_TABLE 이 꺼졌으면(시험 기본) 플래그 꺼짐·모든 단계 legacy
    expect(await assignmentTableFlag()).toBe(false);
    expect(Object.values(await assignmentSources(["ai1", "ai2"]))).toEqual(["legacy", "legacy"]);
    setAssignmentSourceReaderForTest({ assignmentTableEnabled: () => true, assignmentSource: stage => stage === "ai1" ? "table" : "legacy" });
    expect(await assignmentTableFlag()).toBe(true);
    expect(await assignmentSources(["ai1", "ai2"])).toEqual({ ai1: "table", ai2: "legacy" });
    setAssignmentSourceReaderForTest({ assignmentTableEnabled: () => { throw new Error("boom"); }, assignmentSource: () => Promise.reject(new Error("boom")) });
    expect(await assignmentTableFlag()).toBe(false);
    expect(await assignmentSources(["ai1"])).toEqual({ ai1: "legacy" });
  });

  it("감사 줄 — 바뀐 칸을 한국어로, 새 계약·정책 경로 덧붙임·장비 역할 순위", () => {
    const audit = { detail: { version: 2, before: { ...AI2_BACKUP, mode: "off", rank: 2 }, after: { ...AI2_BACKUP, mode: "live", rank: 1, vote: true },
      contract: { source: "probed", contractHash: HASH }, appended: true, policyRevision: 9, deviceRole: { routeId: "second-review", before: 3, after: 1 } } } as unknown as AdminLogRow;
    expect(assignmentAuditChangeLines(audit)).toEqual(["모드: 꺼짐 → 실전", "순위: 2 → 1", "표: 아님 → 투표", `계약: 새로 만듦(${"c".repeat(12)})`,
      "정책 경로 덧붙임(revision 9)", "장비 역할 순위: 3 → 1"]);
  });
});

describe("고를 수 있는 것 — 단계 × 등록부 × 전송", () => {
  const def = (key: string) => MODELS.find(entry => entry.key === key)!;
  it("cli 는 connect 장비 모델에만, 단계가 허락한 전송만, 게이트웨이 표지가 있으면 게이트웨이가 먼저", () => {
    expect(assignmentTransportsFor("ai1", def("connect:sonnet"))).toEqual(["cli"]);
    expect(assignmentTransportsFor("ai1", ODD_CLI)).toEqual([]);
    expect(assignmentTransportsFor("intro", def("connect:sonnet"))).toEqual(["cli"]);
    expect(assignmentTransportsFor("intro", ENG)).toEqual([]);
    expect(assignmentTransportsFor("ai1", def("supa:review"))).toEqual(["gateway", "direct"]);
    expect(assignmentTransportsFor("ai1", ENG)).toEqual(["direct", "gateway"]);
    expect(assignmentTransportsFor("ai1", def("m3:review"))).toEqual([]);
    expect(assignmentTransportsFor("ai2", def("m3:review"))).toEqual(["local-direct"]);
    expect(assignmentTransportsFor("human", def("m3:review"))).toEqual(["local-direct"]);
    expect(assignmentTransportsFor("assist", def("m3:review"))).toEqual([]);
  });
  it("폼 선택지: 단계마다 쓸 수 있는 모델만, 모델마다 wire 이름, 장비는 켜진 것이 먼저; 연결 못 하는 모델은 빠진다", () => {
    const options = assignmentFormOptions(MODELS, DEVICES);
    expect(options.registry.find(entry => entry.key === "odd:claude")).toBeUndefined();
    expect(options.registry.find(entry => entry.key === "connect:sonnet")).toMatchObject({ wire: { cli: "sonnet" }, transportsByStage: { ai1: ["cli"], ai2: ["cli"], intro: ["cli"],
      "publish-classify": ["cli"] } });
    expect(options.registry.find(entry => entry.key === "supa:review")!.wire).toEqual({ gateway: "[supa] Qwen3.8-27B-NVFP4", direct: "Qwen3.8-27B-NVFP4" });
    expect(Object.keys(options.registry.find(entry => entry.key === "m3:review")!.transportsByStage)).toEqual(["ai2", "human", "audit", "audit-second-opinion", "screen"]);
    expect(options.devices.map(entry => entry.id)).toEqual(["connect", "eng-dev", "m3-deepseek", "supa", "old-box"]);
    expect(options.stages.filter(stage => stage.vote).map(stage => stage.id)).toEqual(["ai2"]);
    expect(options).toMatchObject({ rankMax: 8, confirmWord: "배정" });
  });
});

describe("폼 → 저장 입력", () => {
  const BASE = { expectedVersion: "", stage: "ai1", deviceId: "eng-dev", registryKey: "eng:qwen", transport: "direct", rank: "1", role: "primary", mode: "off" };
  it("빈 판 = 새 배정, 빈 이름 = <장비>:<단계>:<등록부 key>, 빈 메모 = null, 체크 = 표; 판이 있으면 CAS", () => {
    expect(modelAssignmentInputFromForm(form(BASE))).toEqual({ issues: [], input: { assignmentId: "eng-dev:ai1:eng:qwen", expectedVersion: null, stage: "ai1",
      deviceId: "eng-dev", registryKey: "eng:qwen", transport: "direct", rank: 1, role: "primary", vote: false, mode: "off", maxSlots: 1, note: null } });
    expect(modelAssignmentInputFromForm(form({ ...BASE, expectedVersion: "4", assignmentId: "mine", stage: "ai2", vote: "on", mode: "live", confirm: "배정", note: " 메모 " })).input)
      .toMatchObject({ assignmentId: "mine", expectedVersion: 4, vote: true, mode: "live", note: "메모" });
    expect(assignmentIdFor("Eng Dev", "ai1", "eng:qwen")).toBeNull();
  });
  it("실전은 확인 「배정」, 도우미 역할은 도우미 화면으로, 순위·판·모드 모양은 코드로", () => {
    expect(modelAssignmentInputFromForm(form({ ...BASE, mode: "live" }))).toEqual({ input: null, issues: ["assignment_confirm_required"] });
    expect(modelAssignmentInputFromForm(form({ ...BASE, mode: "live", confirm: "실전" })).issues).toEqual(["assignment_confirm_required"]);
    expect(modelAssignmentInputFromForm(form({ ...BASE, role: "helper" }))).toEqual({ input: null, issues: ["assignment_helper_role"] });
    expect(modelAssignmentInputFromForm(form({ ...BASE, rank: "9", expectedVersion: "x", mode: "shadow", deviceId: "" })).issues)
      .toEqual(["model_assignment_invalid:expectedVersion", "assignment_device_required", "model_assignment_invalid:rank", "model_assignment_invalid:mode", "assignment_id_required"]);
  });
  it("저장된 행 → 끄기 입력(판 CAS, 나머지 그대로)", () => {
    expect(modelAssignmentInputOf(AI2_VOTE, { mode: "off", expectedVersion: 5 })).toEqual({ assignmentId: AI2_VOTE.assignmentId, expectedVersion: 5, stage: "ai2",
      deviceId: "supa", registryKey: "supa:review", transport: "gateway", rank: 1, role: "primary", vote: true, mode: "off", maxSlots: 1, note: null });
  });
  it("주소 칸 → 미리 채우기(모르는 값은 버린다); 엔진 연결 뒤 링크는 고른 경로의 첫 배정 단계·엔진 직접", () => {
    expect(assignmentPrefillFromParams({ stage: "ai1", transport: "direct", registryKey: "eng:qwen", deviceId: "eng-dev", edit: "eng-dev:ai1:eng:qwen" }))
      .toEqual({ stage: "ai1", transport: "direct", registryKey: "eng:qwen", deviceId: "eng-dev", editId: "eng-dev:ai1:eng:qwen" });
    expect(assignmentPrefillFromParams({ stage: "nope", transport: "carrier", registryKey: "Bad Key", edit: "UPPER" })).toEqual({});
    expect(engineConnectAssignmentHref("m1:translation", ["product-translate", "reason-translate"]))
      .toBe("/admin/models/assignments?registryKey=m1%3Atranslation&transport=direct&stage=reason#form");
    expect(engineConnectAssignmentHref("supa:review", ["crawl-agent-review"])).toContain("stage=ai1");
    expect(engineConnectAssignmentHref("x:y", ["search-query-translate"])).toBe("/admin/models/assignments?registryKey=x%3Ay&transport=direct#form");
  });
});

describe("거절 코드 → 한국어(무엇을 하면 되는지)", () => {
  it("저장 함수의 거절 코드는 모두 문장이 있고 할 일을 말한다", () => {
    for (const code of MODEL_ASSIGNMENT_REFUSALS) {
      const message = modelAssignmentIssueMessage(`model_assignment_refused:${code}`);
      expect(message, code).toBe(MODEL_ASSIGNMENT_REFUSAL_MESSAGES[code]);
      expect(message, code).not.toMatch(/^저장이 거절됐습니다/);
    }
    expect(modelAssignmentIssueMessage("model_assignment_refused:device_unconfigured")).toContain("/admin/models/devices");
    expect(modelAssignmentIssueMessage("model_assignment_refused:contract_unbuildable")).toContain("/admin/models/contracts");
  });
  it("CAS·덧붙이기·probe 원인·검사 칸·fence·도우미 코드, 모르는 코드는 그대로", () => {
    expect(modelAssignmentIssueMessage("model_assignment_version_mismatch:4")).toBe("다른 사람이 먼저 저장했습니다(지금 판 4). 새로고침해 바뀐 값을 확인한 뒤 다시 저장하세요.");
    expect(modelAssignmentIssueMessage("model_assignment_version_mismatch:none")).toContain("이 배정이 지금 없습니다");
    expect(modelAssignmentIssueMessage("model_capacity_append_predecessor_busy")).toContain("호출이 끝난 뒤");
    expect(modelAssignmentIssueMessage("model_capacity_routes_cap")).toContain("상한(256)");
    expect(modelAssignmentIssueMessage("model_capacity_policy_missing")).toContain("정책을 먼저 적용");
    expect(modelAssignmentIssueMessage("model_assignment_refused:contract_probe_failed:engine_unreachable:timeout"))
      .toBe("엔진 확인(readback·1토큰 시험)이 실패해 저장하지 않았습니다 — 엔진에 닿지 못했습니다(timeout) — 등록부의 주소·키·엔진 상태를 확인하세요.");
    expect(modelAssignmentIssueMessage("model_assignment_refused:contract_probe_failed:engine_max_len_unknown")).toContain("컨텍스트 상한을 넣어 계약을 먼저");
    expect(modelAssignmentIssueMessage("model_assignment_refused:contract_probe_failed:engine_model_not_found")).toContain("모델 목록에 이 모델이 없습니다");
    expect(modelAssignmentIssueMessage("model_assignment_invalid:transport")).toContain("connect 장비");
    expect(modelAssignmentIssueMessage("model_assignment_invalid:vote")).toContain("2차 검수의 순위 1");
    expect(modelAssignmentIssueMessage("model_assignment_invalid:registryKey")).toContain("같은 장비·단계에 같은 모델");
    expect(modelAssignmentIssueMessage("model_assignment_invalid:stage")).toContain("예약 단계");
    expect(modelAssignmentIssueMessage("site_fenced")).toContain("DR");
    expect(modelAssignmentIssueMessage("assignment_confirm_required")).toContain("「배정」");
    expect(modelAssignmentIssueMessage("model_helper_invalid:assignmentId")).toContain("/admin/models/helpers");
    expect(modelAssignmentIssueMessage("model_assignment_invalid:weird.path")).toBe("배정이 검사를 통과하지 못했습니다: weird.path");
    expect(modelAssignmentIssueMessage("something_new")).toBe("something_new");
  });
  it("저장 결과 문장 — 판·모드·계약 출처·정책 경로·장비 순위, 플래그가 꺼져 있으면 아직 설정을 읽는다고", () => {
    const result = { before: null, after: AI1, offOnly: false, contract: { routeId: "crawl-agent-review", model: "Qwen-X", contractHash: HASH, source: "probed", id: 3 },
      route: POLICY.routes[0], appended: [POLICY.routes[0]], policyRevision: 8, deviceRole: { routeId: "crawl-agent-review", before: null, after: 1 } } as unknown as ModelAssignmentSaveResult;
    expect(assignmentSavedMessage(result, false)).toBe(`만들었습니다(배정 ${AI1.assignmentId}, 판 3, 모드 실전). 계약: 엔진 확인(readback·1토큰)으로 새로 만든 계약(${"c".repeat(12)}). `
      + "정책에 경로를 덧붙였습니다(revision 8, DRAIN 없음). 장비 역할 순위 없음 → 1. 읽는 쪽은 아직 설정을 씁니다(플래그 MODEL_ASSIGNMENT_TABLE 꺼짐) — 켜면 이 배정을 읽습니다.");
    expect(assignmentSavedMessage({ ...result, before: AI1, appended: [], deviceRole: { routeId: "x", before: 1, after: 1 } } as ModelAssignmentSaveResult, true))
      .toMatch(/^저장했습니다.*정책 경로는 이미 있습니다\. 장비 역할 순위 1 그대로\.$/);
    // 끄기 갈래(있는 행을 끄기만): 계약·정책 경로를 보지 않았다고 말한다
    expect(assignmentSavedMessage({ ...result, before: AI1, after: { ...AI1, mode: "off", version: 4 }, offOnly: true, contract: null, route: null, appended: [],
      deviceRole: { routeId: "crawl-agent-review", before: 1, after: 1 } } as ModelAssignmentSaveResult, true))
      .toBe(`저장했습니다(배정 ${AI1.assignmentId}, 판 4, 모드 꺼짐). 계약: 확인하지 않음(끄기). 정책 경로는 그대로 둡니다. 장비 역할 순위 1 그대로.`);
  });
});

describe("가져오기 계획(3b-B planAssignmentImport)", () => {
  it("옮길 행이 없는 계획은 빈 행 + 경고; 보기는 hash·수·경고; hash 는 행의 동작·출처·입력만(열쇠 순서와 무관)", async () => {
    // 1차가 설정에 없고 2차 투표자가 등록부에 없다 — 옮길 행 없이 경고 둘
    const sources: AssignmentImportSources = { settings: { ...DEFAULT_CRAWL_SETTINGS, secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview,
      voters: [{ provider: "abcllm", model: "[ghost] model" }] } }, registry: readModelRegistry(), policy: null, devices: [], assignments: [] };
    const plan = await planAssignmentImport(sources);
    expect(plan).toEqual({ rows: [], warnings: ["firstReview: 1차 모델이 설정에 없어 1차는 옮기지 않습니다 — CRAWL_REVIEW_MODEL env 대체는 옮기지 않는다",
      "secondReview.voters[0]: 등록부에서 이 모델을 찾지 못해 옮기지 않습니다 — abcllm [ghost] model"] });
    const preview = assignmentImportPreviewOf(plan);
    expect(preview).toMatchObject({ rows: [], warnings: plan.warnings, counts: { create: 0, update: 0, unchanged: 0 }, error: null });
    expect(preview.hash).toMatch(/^[a-f0-9]{64}$/);
    const a = { rows: [{ action: "create" as const, origin: "firstReview", input: { assignmentId: "x", stage: "ai1" as const, deviceId: "d", registryKey: "a:b",
      transport: "direct" as const, expectedVersion: null } }], warnings: ["w"] };
    const b = { rows: [{ action: "create" as const, origin: "firstReview", input: { transport: "direct" as const, expectedVersion: null, registryKey: "a:b",
      deviceId: "d", stage: "ai1" as const, assignmentId: "x" } }], warnings: [] };
    expect(assignmentImportPlanHash(a)).toBe(assignmentImportPlanHash(b));
    expect(assignmentImportPlanHash(a)).not.toBe(assignmentImportPlanHash({ rows: [{ ...a.rows[0], action: "update" as const }], warnings: [] }));
    expect(assignmentImportPreviewOf(a).rows[0]).toMatchObject({ actionLabel: "만들기", stageLabel: "1차 검수", origin: "firstReview" });
  });
});

describe("server action — 쓰기 관문 뒤 관리자 확인·폼 검사·저장 함수·거절 문장", () => {
  const BASE = { expectedVersion: "", stage: "ai1", deviceId: "eng-dev", registryKey: "eng:qwen", transport: "direct", rank: "1", role: "primary", mode: "live", confirm: "배정" };
  const saved = { before: null, after: AI1, offOnly: false, contract: { routeId: "crawl-agent-review", model: "Qwen-X", contractHash: HASH, source: "stored", id: 1 },
    route: POLICY.routes[0], appended: [], policyRevision: 7, deviceRole: { routeId: "crawl-agent-review", before: 1, after: 1 } };
  it("저장: 저장 입력·사람을 넘기고 결과 문장을 돌려준다; 거절은 한국어로; 폼 문제·비관리자는 저장 함수에 닿지 않는다", async () => {
    mocks.save.mockResolvedValueOnce({ ok: true, created: true, result: saved });
    const ok = await saveModelAssignmentAction(null, form(BASE));
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ assignmentId: "eng-dev:ai1:eng:qwen", mode: "live", expectedVersion: null }), "jr");
    expect(ok).toMatchObject({ ok: true, assignmentId: AI1.assignmentId, message: expect.stringContaining("만들었습니다(배정 eng-dev:ai1:eng:qwen, 판 3, 모드 실전)") });
    expect(mocks.revalidate).toHaveBeenCalledWith("/admin/models/assignments");
    mocks.save.mockResolvedValueOnce({ ok: false, issues: ["model_assignment_refused:device_unconfigured"] });
    expect(await saveModelAssignmentAction(null, form(BASE))).toEqual({ issues: [MODEL_ASSIGNMENT_REFUSAL_MESSAGES.device_unconfigured] });
    mocks.save.mockClear();
    expect(await saveModelAssignmentAction(null, form({ ...BASE, confirm: "" }))).toEqual({ issues: [expect.stringContaining("「배정」")] });
    expect(await saveModelAssignmentAction(null, form({ ...BASE, role: "helper" }))).toEqual({ issues: [expect.stringContaining("/admin/models/helpers")] });
    mocks.admin.mockResolvedValueOnce(null);
    expect(await saveModelAssignmentAction(null, form(BASE))).toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("끄기: 이름·판(CAS)을 넘긴다; 판이 없으면 거절; CAS 거절은 문장", async () => {
    mocks.off.mockResolvedValueOnce({ ok: true, created: false, result: { ...saved, after: { ...AI1, mode: "off", version: 4 } } });
    expect(await turnOffModelAssignmentAction(null, form({ assignmentId: AI1.assignmentId, expectedVersion: "3" })))
      .toMatchObject({ ok: true, message: expect.stringContaining("껐습니다(배정 eng-dev:ai1:eng:qwen, 판 4)") });
    expect(mocks.off).toHaveBeenCalledWith(AI1.assignmentId, 3, "jr");
    mocks.off.mockResolvedValueOnce({ ok: false, issues: ["model_assignment_version_mismatch:5"] });
    expect(await turnOffModelAssignmentAction(null, form({ assignmentId: AI1.assignmentId, expectedVersion: "3" }))).toEqual({ issues: [expect.stringContaining("지금 판 5")] });
    mocks.off.mockClear();
    expect(await turnOffModelAssignmentAction(null, form({ assignmentId: AI1.assignmentId }))).toEqual({ issues: [expect.stringContaining("판 번호")] });
    expect(mocks.off).not.toHaveBeenCalled();
  });
  it("가져오기 적용: 확인 「배정」이 있어야, 계획 hash 를 넘기고 행마다 결과", async () => {
    expect(await applyAssignmentImportAction(null, form({ planHash: HASH }))).toEqual({ issues: [expect.stringContaining("「배정」")] });
    expect(mocks.apply).not.toHaveBeenCalled();
    mocks.apply.mockResolvedValueOnce({ ok: true, warnings: ["3b-B 미반영"], results: [
      { index: 0, origin: "firstReview", assignmentId: "a", action: "create", ok: true, skipped: false, version: 1, issues: [] },
      { index: 1, origin: "secondReview.voters[0]", assignmentId: "b", action: "create", ok: false, skipped: false, version: null, issues: ["model_assignment_refused:contract_unbuildable"] },
      { index: 2, origin: "stageModelPools.reason-translate[0]", assignmentId: "c", action: "unchanged", ok: true, skipped: true, version: null, issues: [] }] });
    const result = await applyAssignmentImportAction(null, form({ planHash: HASH, confirm: "배정" }));
    expect(mocks.apply).toHaveBeenCalledWith(HASH, "jr");
    expect(result).toMatchObject({ ok: true, message: "가져오기를 적용했습니다 — 저장 1 · 거절 1 · 그대로 1. 경고: 3b-B 미반영" });
    expect(result?.rows?.map(entry => entry.message)).toEqual(["저장(판 1)", MODEL_ASSIGNMENT_REFUSAL_MESSAGES.contract_unbuildable, "그대로 — 건너뜀"]);
    mocks.apply.mockResolvedValueOnce({ ok: false, issues: ["assignment_import_plan_changed"] });
    expect(await applyAssignmentImportAction(null, form({ planHash: HASH, confirm: "배정" }))).toEqual({ issues: [expect.stringContaining("계획 보기")] });
  });
});

describe("그리기", () => {
  const view = viewOf();
  const group = (stage: string) => view.groups.find(entry => entry.id === stage)!;
  it("단계 표 — 열 이름, 표(투표) 열은 2차에만, 계약 hash·route·장비 순위·1시간 건수·판, 수정·끄기, 도우미는 도우미 화면 링크", () => {
    const ai1 = renderToStaticMarkup(createElement(AssignmentStageTable, { group: group("ai1") }));
    for (const text of ["1차 검수", "장비", "모델", "전송", "순위", "역할", "모드", "계약", "route", "장비 역할 순위", "최근 1시간", "판", "동작", "읽기 설정"])
      expect(ai1).toContain(text);
    expect(ai1).not.toContain(">표</th>");
    expect(ai1).toContain("c".repeat(12));
    expect(ai1).toContain("eng:qwen");
    expect(ai1).toContain("→ <code class=\"break-all\">Qwen-X</code>");
    expect(ai1).toContain('href="/admin/models/assignments?edit=eng-dev%3Aai1%3Aeng%3Aqwen#form"');
    expect(ai1).toContain("끄기");
    expect(ai1).toContain('href="/admin/models/helpers#helper-m3-deepseek:ai1"');
    expect(ai1).toContain("도우미 화면에서");
    const ai2 = renderToStaticMarkup(createElement(AssignmentStageTable, { group: group("ai2") }));
    expect(ai2).toContain(">표</th>");
    expect(ai2).toContain("<strong>투표</strong>");
    expect(ai2).toContain("다른 장비(gpu-other)");
    // 예약 단계 안내는 지금 상태만 말한다 — PR·정책 판 번호 없이
    const repo = renderToStaticMarkup(createElement(AssignmentStageTable, { group: group("repo") }));
    expect(repo).toContain("예약 단계 — assist·assist-audit·repo 는 경로 규칙이 아직 없어 배정할 수 없습니다");
    expect(repo).not.toMatch(/3b-[A-Z]|rev ?\d+/);
    expect(renderToStaticMarkup(createElement(AssignmentStageTable, { group: group("reason") }))).toContain("지금은 설정(단계별 모델·크롤 설정)을 읽습니다");
    // 글자 크기는 13px 이상만(이 화면의 모든 파일)
    const root = path.resolve(__dirname, "..");
    for (const file of ["page.tsx", "AssignmentTable.tsx", "AssignmentForm.tsx", "ImportCard.tsx", "TurnOffButton.tsx"])
      expect(readFileSync(path.join(root, "app/(operator)/admin/models/assignments", file), "utf8"), file).not.toMatch(/text-\[(?:[0-9]|1[0-2])px\]|text-xs/);
  });

  it("새 배정 폼 — 단계·장비·등록부(단계에 맞는 것만)·전송(CLI 는 connect 만)·순위·역할·표(2차만)·모드; 실전 아니면 확인 칸 없음", () => {
    const html = renderToStaticMarkup(createElement(AssignmentForm, { options: view.options, initial: null }));
    expect(html).toContain("새 배정");
    expect(html).toContain('name="expectedVersion" value=""');
    expect(html).not.toContain("odd:claude");
    expect(html).toContain("connect:sonnet");
    expect(html).not.toContain("m3:review");          // 1차는 로컬 직접을 허락하지 않는다
    expect(html).not.toContain("표(투표)");
    expect(html).not.toContain('name="confirm"');
    expect(html).toContain("도우미");
    const intro = renderToStaticMarkup(createElement(AssignmentForm, { options: view.options, initial: null, prefill: { stage: "intro" } }));
    expect(intro).toContain("connect:sonnet");
    expect(intro).not.toContain("eng:qwen");
    expect(intro).toContain('name="transport" value="cli"');
    const ai2 = renderToStaticMarkup(createElement(AssignmentForm, { options: view.options, initial: null, prefill: { stage: "ai2", registryKey: "m3:review" } }));
    expect(ai2).toContain("표(투표)");
    expect(ai2).toContain('name="transport" value="local-direct"');
    expect(ai2).toContain("wire 모델 <code class=\"break-all\">deepseek-v4.1-flash-1017</code>");
    const empty = renderToStaticMarkup(createElement(AssignmentForm, { options: { ...view.options, devices: [] }, initial: null }));
    expect(empty).toContain("device_unconfigured");
  });

  it("고치기 폼 — 숨은 판(CAS)·이름·단계·장비, 실전이면 확인 「배정」 칸; 엔진 연결에서 온 미리 채우기", () => {
    const edit = renderToStaticMarkup(createElement(AssignmentForm, { options: view.options, initial: { assignmentId: AI2_VOTE.assignmentId, version: 5, stage: "ai2",
      deviceId: "supa", registryKey: "supa:review", transport: "gateway", rank: 1, vote: true, mode: "live", maxSlots: 1, note: "주 투표" } }));
    expect(edit).toContain("배정 고치기");
    expect(edit).toContain('name="expectedVersion" value="5"');
    expect(edit).toContain('name="assignmentId" value="supa:ai2:supa:review"');
    expect(edit).toContain('name="stage" value="ai2"');
    expect(edit).toContain('name="deviceId" value="supa"');
    expect(edit).toContain('name="confirm"');
    expect(edit).toContain("「배정」");
    expect(edit).toContain('value="주 투표"');
    const fromEngine = renderToStaticMarkup(createElement(AssignmentForm, { options: view.options, initial: null,
      prefill: assignmentPrefillFromParams({ registryKey: "supa:review", transport: "direct", stage: "ai1" }) }));
    expect(fromEngine).toContain('name="registryKey" value="supa:review"');
    expect(fromEngine).toContain('name="transport" value="direct"');
  });

  it("가져오기 카드 — 계획 보기 링크, 계획(수·경고·행)과 확인 「배정」 + 적용; 빈 계획이면 적용 단추가 꺼진다", () => {
    const idle = renderToStaticMarkup(createElement(ImportCard, { preview: null, confirmWord: "배정" }));
    expect(idle).toContain('href="/admin/models/assignments?import=plan#import"');
    expect(idle).toContain("계획 보기");
    expect(idle).not.toContain('name="planHash"');
    const stub = renderToStaticMarkup(createElement(ImportCard, { preview: assignmentImportPreviewOf({ rows: [], warnings: ["3b-B 미반영"] }), confirmWord: "배정" }));
    expect(stub).toContain("경고 — 3b-B 미반영");
    expect(stub).toContain("옮길 행이 없습니다");
    expect(stub).toMatch(/<button type="submit" disabled=""[^>]*>적용\(행 0개를 하나씩 저장\)/);
    const plan = assignmentImportPreviewOf({ warnings: [], rows: [{ action: "update", origin: "secondReview.voters[0]", changes: ["순위 2 → 1"],
      input: { assignmentId: "supa:ai2:supa:review", expectedVersion: 5, stage: "ai2", deviceId: "supa", registryKey: "supa:review", transport: "gateway", rank: 1, vote: true, mode: "live" } }] });
    const html = renderToStaticMarkup(createElement(ImportCard, { preview: plan, confirmWord: "배정" }));
    for (const text of ["고치기", "secondReview.voters[0]", "2차 검수", "순위 2 → 1", "실전 · 투표", `name="planHash" value="${plan.hash}"`, "적용(행 1개를 하나씩 저장)"])
      expect(html).toContain(text);
  });

  it("화면 파일 — PageStamp·h1·로그인 확인·상태 띠·섹션; 클라이언트 폼은 서버 모듈을 형으로만", () => {
    const root = path.resolve(__dirname, "..");
    const page = readFileSync(path.join(root, "app/(operator)/admin/models/assignments/page.tsx"), "utf8");
    expect(page).toContain("<PageStamp />");
    expect(page).toMatch(/<h1[^>]*>모델 배정<\/h1>/);
    expect(page).toContain('redirect("/admin/login")');
    for (const id of ['id="table"', 'id="form"', 'id="import"', 'id="audit"']) expect(page).toContain(id);
    expect(NAV_GROUPS[1].pages.find(entry => entry.href === "/admin/models/assignments")).toMatchObject({ label: "모델 배정" });
    for (const file of ["AssignmentForm.tsx", "ImportCard.tsx", "TurnOffButton.tsx"]) {
      const source = readFileSync(path.join(root, "app/(operator)/admin/models/assignments", file), "utf8");
      expect(source.startsWith('"use client"'), file).toBe(true);
      expect(source, file).not.toMatch(/^import \{[^}]*\} from "@\/lib\/(operations\/admin-model-assignments|llm\/capacity-helpers)"/m);
    }
    expect(readFileSync(path.join(root, "app/(operator)/admin/models/contracts/EngineConnectForm.tsx"), "utf8")).toContain("이 모델을 단계에 배정");
  });
});

describe("설정 폼 — 배정 표 플래그가 켜졌을 때만 읽기 전용", () => {
  const settings: CrawlSettings = { ...DEFAULT_CRAWL_SETTINGS, firstReview: { provider: "abcllm", model: "[supa] Qwen3.8-27B-NVFP4" },
    firstReviewAdditional: [{ provider: "abcllm", model: "[m1] gemma" }],
    secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, voters: [{ provider: "claude-cli", model: "opus" }], fallbacks: [{ provider: "local-direct", model: "qwen" }] } };
  it("크롤 설정: 기본(꺼짐)은 편집 칸 그대로, 켜지면 알림 + 같은 이름의 숨은 칸(값 유지)·편집 칸 없음", () => {
    const editable = renderToStaticMarkup(createElement(SettingsForm, { settings }));
    expect(editable).not.toContain("배정 표로 옮겨짐");
    expect(editable).toContain('id="firstReviewModel"');
    expect(editable).toContain('aria-label="1번째 모델"');
    const locked = renderToStaticMarkup(createElement(SettingsForm, { settings, assignmentLocked: true }));
    expect(locked).toContain("배정 표로 옮겨짐");
    expect(locked).toContain('href="/admin/models/assignments"');
    expect(locked).not.toContain('id="firstReviewModel"');
    for (const [name, value] of [["firstReviewProvider", "abcllm"], ["firstReviewModel", "[supa] Qwen3.8-27B-NVFP4"], ["firstAdditionalProvider0", "abcllm"],
      ["firstAdditionalModel0", "[m1] gemma"], ["voterProvider0", "claude-cli"], ["voterModel0", "opus"], ["fallbackProvider0", "local-direct"], ["fallbackModel0", "qwen"]])
      expect(locked, name).toContain(`<input type="hidden" name="${name}" value="${value}"/>`);
    expect(locked).not.toContain('aria-label="1번째 모델"');
    expect(locked).not.toContain("+ 대체 모델 더하기");
  });
  it("단계별 모델: 켜지면 알림·칸 잠금·저장 바 없음, 꺼지면 그대로", () => {
    const props = { settings, version: "v1", firstChoices: reviewModelOptions(null, false), secondChoices: reviewModelOptions(null, true), models: MODELS };
    const open = renderToStaticMarkup(createElement(ReviewModelsForm, props));
    expect(open).not.toContain("배정 표로 옮겨짐");
    expect(open).toContain("모델 설정 저장");
    const locked = renderToStaticMarkup(createElement(ReviewModelsForm, { ...props, locked: true }));
    expect(locked).toContain("배정 표로 옮겨짐");
    expect(locked).toContain('data-readonly="true"');
    expect(locked).not.toContain("모델 설정 저장");
  });
});
