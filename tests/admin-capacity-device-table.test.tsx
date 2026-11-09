import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 장비 한도 표(2026-11-09 개편 시안 #devices) — 줄 모형·한 줄 저장(운영 한도 + 모델 한도, 엔진 최대치는 그대로)·그리기·지우기·옛 경로 정리. DB 없이 본다; 저장소는 가짜다.
const mocks = vi.hoisted(() => ({ admin: vi.fn(), read: vi.fn(), saveDevice: vi.fn(), saveLimits: vi.fn(), revalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock("@/lib/llm/capacity-devices-repository", () => ({ readModelCapacityDevice: mocks.read, saveModelCapacityDevice: mocks.saveDevice,
  saveModelCapacityModelLimits: mocks.saveLimits }));
vi.mock("@/lib/db", () => ({ db: { transaction: (work: (tx: unknown) => unknown) => work({ tx: true }) }, onPrimary: (run: () => unknown) => run() }));

import { saveDeviceRowAction } from "@/app/(operator)/admin/models/devices/actions";
import { DeviceLimitsTable, shortTaskList } from "@/app/(operator)/admin/models/devices/DeviceLimitsTable";
import { StaleRoutesPanel } from "@/app/(operator)/admin/models/devices/StaleRoutesPanel";
import type { ModelCapacityPolicy } from "@/lib/llm/capacity";
import type { ModelCapacityDeviceRow, ModelCapacityDeviceState } from "@/lib/llm/capacity-devices";
import { buildCapacityDevicesAdminView } from "@/lib/operations/admin-capacity-devices";
import { deviceRowInputFromForm, deviceRowIssueMessage, saveAdminDeviceRow } from "@/lib/operations/admin-capacity-device-row-save";
import { buildDeviceTableRows, staleRouteItems, type DeviceTableInput } from "@/lib/operations/admin-capacity-device-table-view";
import type { DisplayConnection } from "@/lib/operations/llm-display";

const DEEPSEEK = "deepseek-v4.1-flash-1017", GPT = "gpt-oss-120b", QWEN = "qwen3.8-flash-next";
const route = (routeId: string, model: string, groupId: string, provider = "local-direct") => ({ routeId, provider, model, providerBudgetId: "a", groupId });
const POLICY = { version: 1, globalLimit: 8, providerLimits: { a: 8 }, groupLimits: { supa: 20, "m1-gemma": 2 }, poolLimits: { reviewer: 8, text: 8 },
  weights: { first: 2, second: 1, background: 1 }, maxWaiting: 32, queueTtlMs: 60_000, reservationTtlMs: 30_000,
  routes: [
    route("crawl-agent-review", QWEN, "gpu3090-qwen"), route("second-review", QWEN, "gpu3090-qwen"),
    route("local-deepseek-confirm", DEEPSEEK, "m3-mlx"), route("local-human-deepseek", DEEPSEEK, "m3-mlx"), route("product-search-verify", GPT, "m3-mlx"),
    route("product-intro-check", "sonnet", "anthropic-cli", "claude-cli"),
    route("crawl-tagline", "deepseek-v4.1-flash", "m3-opencode-host", "opencode-cli"),
    route("product-translate", "supa", "supa", "abcllm"),
    route("reason-translate", "m1-gemma", "m1-gemma"),
  ] } satisfies ModelCapacityPolicy;
const row = (over: Partial<ModelCapacityDeviceRow> & { deviceId: string }): ModelCapacityDeviceRow => ({ limitSlots: 4, secondaryCap: 4, idleMs: 60_000, reserveSlots: 0,
  physicalLimit: null, roles: [], note: null, enabled: true, version: 3, updatedBy: "jr", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-08T00:00:00.000Z", ...over });
const state = (over: Partial<ModelCapacityDeviceState> & { deviceId: string }): ModelCapacityDeviceState => ({ source: "table", limitSlots: 4, secondaryCap: 4, idleMs: 60_000,
  reserveSlots: 0, active: 0, secondaryActive: 0, secondaryBound: 4, primaryBusy: false, lending: false, waiting: 0, waitingPrimary: 0, version: 3, updatedAt: null, ...over });
const ROWS = [
  row({ deviceId: "gpu3090-qwen", limitSlots: 5, secondaryCap: 5, physicalLimit: 5 }),
  row({ deviceId: "m3-mlx", limitSlots: 2, secondaryCap: 2, version: 7, modelLimits: [{ model: DEEPSEEK, maxSlots: 1, engineMax: 1 }, { model: GPT, maxSlots: 2, engineMax: 4 }] }),
  row({ deviceId: "anthropic-cli", limitSlots: 2, secondaryCap: 2 }),
  row({ deviceId: "m3-opencode-host", limitSlots: 1, secondaryCap: 1 }),
];
const STATES = [
  state({ deviceId: "gpu3090-qwen", limitSlots: 5 }),
  state({ deviceId: "m3-mlx", limitSlots: 2, active: 2, waiting: 3, version: 7, models: [
    { model: DEEPSEEK, active: 1, waiting: 3, maxSlots: 1, engineMax: 1 } as never, { model: GPT, active: 1, waiting: 0, maxSlots: 2, engineMax: 4 } as never] }),
  state({ deviceId: "anthropic-cli", limitSlots: 2 }),
  state({ deviceId: "m3-opencode-host", limitSlots: 1 }),
  state({ deviceId: "supa", source: "policy_fallback", limitSlots: 20, version: null }),
  state({ deviceId: "m1-gemma", source: "policy_fallback", limitSlots: 2, version: null, active: 1 }),
];
const api = (id: string, label: string, deviceId: string, models: string[], enabled = true): DisplayConnection =>
  ({ id, label, kind: "api", cliTool: null, deviceId, enabled, models: models.map(model => ({ id: model, maxModelLen: null })), cliModels: [] });
const cli = (id: string, label: string, deviceId: string, tool: "claude" | "codex" | "opencode", models: string[]): DisplayConnection =>
  ({ id, label, kind: "cli", cliTool: tool, deviceId, enabled: true, models: null, cliModels: models });
const CONNECTIONS = [
  api("c1", "gpu3090-qwen", "gpu3090-qwen", [QWEN]), api("c2", "m3-deepseek", "m3-mlx", [DEEPSEEK]), api("c3", "m3-gpt-oss", "m3-mlx", [GPT]),
  api("c4", "m1-gemma", "m1-gemma", ["mlx-community--gemma-4-26b-a4b-it-4bit", "m1-gemma"]),
  cli("c5", "Claude CLI", "anthropic-cli", "claude", ["sonnet", "opus", "haiku"]), cli("c6", "M3 OpenCode", "m3-opencode-host", "opencode", ["deepseek-v4.1-flash"]),
];
const OBSERVATION: NonNullable<DeviceTableInput["observation"]> = { error: null, observedAt: "2026-11-09T00:00:00.000Z", configuredRoutes: POLICY.routes, groups: [],
  devices: STATES, rows: [] };
const view = buildCapacityDevicesAdminView({ rows: ROWS, states: STATES, control: { mode: "open", epoch: 3, revision: 40, policy: POLICY, policyVerified: true } });
const tableRows = (over: Partial<DeviceTableInput> = {}) => buildDeviceTableRows({ devices: view.devices, connections: CONNECTIONS, observation: OBSERVATION, readOnly: false, ...over });
const byId = (deviceId: string, rows = tableRows()) => rows.find(entry => entry.deviceId === deviceId)!;
const form = (entries: [string, string][]) => { const data = new FormData(); for (const [key, value] of entries) data.append(key, value); return data; };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ login: "jr" });
});

describe("줄 모형(buildDeviceTableRows)", () => {
  it("서버 한 대가 한 줄 — 일반·모델이 나뉜 장비·CLI·OpenCode(고정)·연결 없는 장비", () => {
    const rows = tableRows();
    expect(Object.fromEntries(rows.map(entry => [entry.deviceId, entry.kind]))).toEqual({ "anthropic-cli": "cli", "gpu3090-qwen": "plain", "m1-gemma": "plain",
      "m3-mlx": "models", "m3-opencode-host": "plain", supa: "orphan" });
    expect(byId("gpu3090-qwen")).toMatchObject({ name: "gpu3090-qwen", models: [QWEN], limitSlots: 5, engineMax: 5, active: 0, waiting: 0, editable: true,
      tasks: ["1차 검수", "2차 검수"], retirable: false, retireReason: "연결 1개가 이 서버를 씁니다" });
    // 같은 엔진의 별칭(옛·새 Gemma 이름)은 모델 둘로 나누지 않는다
    expect(byId("m1-gemma")).toMatchObject({ kind: "plain", models: ["Gemma 4 26B"], source: "policy_fallback", version: null, editable: true });
    expect(byId("m3-opencode-host")).toMatchObject({ kind: "plain", models: ["deepseek-v4.1-flash"], modelFixed: true });
    expect(byId("anthropic-cli")).toMatchObject({ kind: "cli", models: [], sub: "CLI · 작업마다 모델·강도", retirable: false });
    expect(byId("supa")).toMatchObject({ kind: "orphan", sub: "연결 없음", editable: false, retirable: true, retireReason: null });
  });

  it("M3 — 부모 줄은 전체 공유 한도, 모델마다 그 모델을 내놓는 연결 이름·모델 한도·엔진 최대치·지금·대기·그 모델로 가는 작업", () => {
    const m3 = byId("m3-mlx");
    expect(m3).toMatchObject({ name: "m3-deepseek · m3-gpt-oss", sub: "장비 m3-mlx · 모델 2개", limitSlots: 2, active: 2, waiting: 3, version: 7 });
    expect(m3.lines).toEqual([
      { model: DEEPSEEK, name: "m3-deepseek", exposed: true, maxSlots: 1, engineMax: 1, active: 1, waiting: 3, tasks: ["2차 갈림 재확인", "사람 몫 위임 검수"] },
      { model: GPT, name: "m3-gpt-oss", exposed: true, maxSlots: 2, engineMax: 4, active: 1, waiting: 0, tasks: ["키워드 검수"] },
    ]);
    // 저장된 줄만 있고 연결이 내놓지 않는 모델도 줄로 남는다(지울 수 있게)
    const gone = tableRows({ connections: CONNECTIONS.filter(connection => connection.id !== "c3") });
    expect(byId("m3-mlx", gone).lines.find(line => line.model === GPT)).toMatchObject({ name: GPT, exposed: false, maxSlots: 2 });
  });

  it("지우기 판정 — 읽기 전용·연결/장부를 못 읽음이면 끈다(이유를 단다)", () => {
    expect(byId("supa", tableRows({ readOnly: true }))).toMatchObject({ retirable: false, retireReason: "읽기 전용이라 지울 수 없습니다", editable: false });
    expect(byId("supa", tableRows({ connections: null }))).toMatchObject({ kind: "plain", retirable: false, retireReason: "연결·장부를 읽지 못해 지워도 되는지 판정하지 않았습니다" });
    expect(byId("supa", tableRows({ observation: { ...OBSERVATION, rows: [{ routeId: "product-translate", groupId: "supa", dispatched: 1, reserved: 0, waiting: 0, indeterminate: 0,
      succeeded1h: 0, failed1h: 0, unclassified1h: 0 } as never] } }))).toMatchObject({ kind: "plain", retirable: false, retireReason: "점유·대기·최근 1시간 호출이 남아 있습니다" });
  });
});

describe("그리기(DeviceLimitsTable)", () => {
  const html = renderToStaticMarkup(createElement(DeviceLimitsTable, { rows: tableRows(),
    cliRows: { "anthropic-cli": createElement("tr", { "data-cli-row": "intro" }, createElement("td", { colSpan: 7 }, "소개 검수 줄")) } }));
  it("열 머리 일곱 칸과 ⓘ 도움말, 칸마다 낭독 이름", () => {
    for (const head of ["서버", "모델", "운영 한도", "엔진 최대치", "지금 · 대기", "함께 쓰는 작업", "동작"]) expect(html).toContain(`>${head}`);
    expect(html).toMatch(/role="img" tabindex="0" title="[^"]+" aria-label="도움말: /);
    expect(html).toContain('aria-label="gpu3090-qwen 운영 한도"');
    expect(html).toContain('aria-label="m3-deepseek · m3-gpt-oss 전체 공유 한도"');
    expect(html).toContain(`aria-label="m3-deepseek ${DEEPSEEK} 모델 한도"`);
    expect(html).toContain(`aria-label="m3-gpt-oss ${GPT} 엔진 최대치"`);
    expect(html).toContain(`name="max:${GPT}"`);
    expect(html).toContain(`name="engine:${DEEPSEEK}"`);
    expect(html).toContain('name="modelLimits" value="1"');
    // 엔진 최대치(physicalLimit)는 이 표에서 보내지 않는다
    expect(html).not.toContain('name="physicalLimit"');
  });
  it("저장은 바꿨을 때만 — 처음에는 숨어 있다; 쓰는 서버는 「사용 중」과 꺼진 삭제(이유는 title), 연결 없는 서버만 삭제가 켜진다", () => {
    expect(html.match(/<button type="submit" class="devlim-btn devlim-primary" hidden=""/g)?.length).toBe(5);
    expect(html).toContain("사용 중");
    expect(html).toMatch(/<button type="button" class="devlim-btn" disabled="" title="연결 1개가 이 서버를 씁니다"/);
    expect(html).toContain('aria-label="supa 삭제"');
    expect(html).toMatch(/<button type="button" class="devlim-btn devlim-danger"[^>]*aria-label="supa 삭제">삭제<\/button>/);
  });
  it("모델 한도 합(1+2)이 전체 공유(2)보다 크면 경고 줄", () => {
    expect(html).toContain("모델 한도 합 <b>3</b>이 전체 공유 <b>2</b>보다 큽니다");
  });
  it("cliRows 는 그 CLI 장비 줄 바로 아래에 그린다; OpenCode 는 모델과 「고정」", () => {
    const parent = html.indexOf('data-device="anthropic-cli"'), inserted = html.indexOf('data-cli-row="intro"');
    expect(parent).toBeGreaterThan(-1);
    expect(inserted).toBeGreaterThan(parent);
    const nextDevice = html.slice(parent + 1).search(/data-device="/) + parent + 1;
    expect(inserted).toBeLessThan(nextDevice);
    expect(html).toMatch(/deepseek-v4\.1-flash<span class="devlim-fixed"[^>]*>고정<\/span>/);
    expect(shortTaskList(["카테고리 분류", "1차 AI 검수", "2차 심사"])).toBe("카테고리 분류 외 2");
    expect(shortTaskList([])).toBe("—");
  });
});

describe("한 줄 저장 — 폼 읽기", () => {
  it("운영 한도·판·모델 줄(빈 모델 한도는 줄을 지움)", () => {
    expect(deviceRowInputFromForm(form([["deviceId", "m3-mlx"], ["expectedVersion", "7"], ["limitSlots", "3"], ["modelLimits", "1"],
      ["model", DEEPSEEK], [`max:${DEEPSEEK}`, "1"], [`engine:${DEEPSEEK}`, "1"], ["model", GPT], [`max:${GPT}`, ""], [`engine:${GPT}`, "4"]])))
      .toEqual({ issues: [], input: { deviceId: "m3-mlx", expectedVersion: 7, limitSlots: 3, modelLimits: [{ model: DEEPSEEK, maxSlots: 1, engineMax: 1 }] } });
    expect(deviceRowInputFromForm(form([["deviceId", "supa"], ["expectedVersion", ""], ["limitSlots", "4"]])).input)
      .toEqual({ deviceId: "supa", expectedVersion: null, limitSlots: 4, modelLimits: null });
    expect(deviceRowInputFromForm(form([["deviceId", "x"], ["expectedVersion", "v"], ["limitSlots", "0"]])).issues)
      .toEqual(["판 번호(version)를 읽지 못했습니다. 새로고침해주세요.", "운영 한도는 1~256 의 정수입니다."]);
  });
});

describe("한 줄 저장 — saveAdminDeviceRow", () => {
  const saved = (version: number) => ({ before: null, after: { version } });
  it("운영 한도만 바꾼다 — 엔진 최대치·역할·유휴·메모는 그대로, 낮은 순위 상한이 칸 수와 같았으면 따라간다", async () => {
    mocks.read.mockResolvedValue(row({ deviceId: "gpu3090-qwen", limitSlots: 5, secondaryCap: 5, physicalLimit: 5, reserveSlots: 1, idleMs: 30_000,
      roles: [{ routeId: "crawl-agent-review", rank: 1 }], note: "메모" }));
    mocks.saveDevice.mockResolvedValue(saved(4));
    const result = await saveAdminDeviceRow({ deviceId: "gpu3090-qwen", expectedVersion: 3, limitSlots: 4, modelLimits: null }, "jr");
    expect(mocks.saveDevice).toHaveBeenCalledWith({ tx: true }, { deviceId: "gpu3090-qwen", limitSlots: 4, secondaryCap: 4, reserveSlots: 1, idleMs: 30_000, physicalLimit: 5,
      roles: [{ routeId: "crawl-agent-review", rank: 1 }], note: "메모" }, 3, "jr");
    expect(mocks.saveLimits).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, deviceId: "gpu3090-qwen", version: 4, warnings: [], changes: ["운영 한도: 5 → 4", "낮은 순위 상한: 5 → 4"] });
  });
  it("우선순위가 있던 상한은 새 칸 수 이하로만 줄이고, 비워 둘 칸은 칸 수 − 1 이하로", async () => {
    mocks.read.mockResolvedValue(row({ deviceId: "d", limitSlots: 6, secondaryCap: 3, reserveSlots: 2 }));
    mocks.saveDevice.mockResolvedValue(saved(4));
    await saveAdminDeviceRow({ deviceId: "d", expectedVersion: 3, limitSlots: 2, modelLimits: null }, "jr");
    expect(mocks.saveDevice.mock.calls[0][1]).toMatchObject({ limitSlots: 2, secondaryCap: 2, reserveSlots: 1 });
    mocks.saveDevice.mockClear();
    await saveAdminDeviceRow({ deviceId: "d", expectedVersion: 3, limitSlots: 8, modelLimits: null }, "jr");
    expect(mocks.saveDevice.mock.calls[0][1]).toMatchObject({ limitSlots: 8, secondaryCap: 3, reserveSlots: 2 });
  });
  it("M3 — 공유 한도와 모델 줄을 한 TX 에서, 모델 저장은 첫 저장이 올린 판으로; 그대로인 쪽은 건너뛴다", async () => {
    const before = row({ deviceId: "m3-mlx", limitSlots: 2, secondaryCap: 2, version: 7, physicalLimit: null, modelLimits: [{ model: DEEPSEEK, maxSlots: 1, engineMax: 1 }] });
    mocks.read.mockResolvedValue(before);
    mocks.saveDevice.mockResolvedValue(saved(8));
    mocks.saveLimits.mockResolvedValue({ before: [], after: { version: 9 }, warnings: ["max_exceeds_limit:gpt-oss-120b"] });
    const limits = [{ model: DEEPSEEK, maxSlots: 1, engineMax: 1 }, { model: GPT, maxSlots: 4, engineMax: 4 }];
    const result = await saveAdminDeviceRow({ deviceId: "m3-mlx", expectedVersion: 7, limitSlots: 3, modelLimits: limits }, "jr");
    expect(mocks.saveDevice.mock.calls[0][1]).toMatchObject({ limitSlots: 3, physicalLimit: null });
    expect(mocks.saveLimits).toHaveBeenCalledWith({ tx: true }, { deviceId: "m3-mlx", expectedVersion: 8, limits }, "jr");
    expect(result).toMatchObject({ ok: true, version: 9, warnings: ["max_exceeds_limit:gpt-oss-120b"], changes: ["운영 한도: 2 → 3", "낮은 순위 상한: 2 → 3", `${GPT}: 상한 없음 → 최대 4칸 (엔진 4)`] });
    // 공유 한도 그대로 + 모델 줄만 → 장비 저장 없이 처음 판으로
    vi.clearAllMocks();
    mocks.read.mockResolvedValue(before);
    mocks.saveLimits.mockResolvedValue({ before: [], after: { version: 8 }, warnings: [] });
    await saveAdminDeviceRow({ deviceId: "m3-mlx", expectedVersion: 7, limitSlots: 2, modelLimits: limits }, "jr");
    expect(mocks.saveDevice).not.toHaveBeenCalled();
    expect(mocks.saveLimits.mock.calls[0][1]).toMatchObject({ expectedVersion: 7 });
    // 둘 다 그대로 → 아무것도 쓰지 않는다
    vi.clearAllMocks();
    mocks.read.mockResolvedValue(before);
    expect(await saveAdminDeviceRow({ deviceId: "m3-mlx", expectedVersion: 7, limitSlots: 2, modelLimits: [{ model: DEEPSEEK, maxSlots: 1, engineMax: 1 }] }, "jr"))
      .toEqual({ ok: true, deviceId: "m3-mlx", version: 7, changes: [], warnings: [] });
    expect(mocks.saveDevice).not.toHaveBeenCalled();
    expect(mocks.saveLimits).not.toHaveBeenCalled();
  });
  it("행 없는 장비는 정책 대체 설정(cap = limit)으로 첫 행을 만든다", async () => {
    mocks.read.mockResolvedValue(null);
    mocks.saveDevice.mockResolvedValue(saved(1));
    expect(await saveAdminDeviceRow({ deviceId: "m1-gemma", expectedVersion: null, limitSlots: 3, modelLimits: null }, "jr"))
      .toMatchObject({ ok: true, version: 1, changes: ["운영 한도: 없음(정책 대체) → 3"] });
    expect(mocks.saveDevice).toHaveBeenCalledWith({ tx: true }, { deviceId: "m1-gemma", limitSlots: 3, secondaryCap: 3, reserveSlots: 0, idleMs: 60_000, physicalLimit: null,
      roles: [], note: null }, null, "jr");
  });
  it("거절 — 판이 다름·꺼진 장비·저장소 거절은 코드로, 그 밖의 오류는 던진다", async () => {
    mocks.read.mockResolvedValue(row({ deviceId: "d", version: 5 }));
    expect(await saveAdminDeviceRow({ deviceId: "d", expectedVersion: 4, limitSlots: 2, modelLimits: null }, "jr"))
      .toEqual({ ok: false, issues: ["model_capacity_device_version_mismatch:5"] });
    mocks.read.mockResolvedValue(row({ deviceId: "d", enabled: false }));
    expect(await saveAdminDeviceRow({ deviceId: "d", expectedVersion: 3, limitSlots: 2, modelLimits: null }, "jr"))
      .toEqual({ ok: false, issues: ["model_capacity_device_row_disabled"] });
    mocks.read.mockResolvedValue(row({ deviceId: "d", physicalLimit: 2 }));
    mocks.saveDevice.mockRejectedValue(new Error("model_capacity_device_invalid:limitSlots"));
    expect(await saveAdminDeviceRow({ deviceId: "d", expectedVersion: 3, limitSlots: 3, modelLimits: null }, "jr"))
      .toEqual({ ok: false, issues: ["model_capacity_device_invalid:limitSlots"] });
    mocks.saveDevice.mockRejectedValue(new Error("connection reset"));
    await expect(saveAdminDeviceRow({ deviceId: "d", expectedVersion: 3, limitSlots: 3, modelLimits: null }, "jr")).rejects.toThrow("connection reset");
    expect(await saveAdminDeviceRow({ deviceId: "d", expectedVersion: 3, limitSlots: 3, modelLimits: null }, " ")).toEqual({ ok: false, issues: ["invalid_actor"] });
  });
  it("거절 문장 — 운영 한도·엔진 최대치 이름으로", () => {
    expect(deviceRowIssueMessage("model_capacity_device_invalid:limitSlots")).toContain("엔진 최대치를 넘을 수 없습니다");
    expect(deviceRowIssueMessage("model_capacity_device_row_disabled")).toContain("꺼진 장비입니다");
    expect(deviceRowIssueMessage("model_capacity_model_limit_version_mismatch:9")).toContain("지금 판 9");
    expect(deviceRowIssueMessage("model_capacity_device_version_mismatch:5")).toContain("지금 판 5");
  });
});

describe("server action saveDeviceRowAction", () => {
  it("권한·폼·거절·결과(바뀐 값이 있을 때만 다시 그린다)", async () => {
    mocks.admin.mockResolvedValueOnce(null);
    expect(await saveDeviceRowAction(null, form([]))).toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
    expect(await saveDeviceRowAction(null, form([["deviceId", "d"], ["limitSlots", "x"]]))).toEqual({ issues: ["운영 한도는 1~256 의 정수입니다."] });
    mocks.read.mockResolvedValue(row({ deviceId: "d", version: 5 }));
    expect((await saveDeviceRowAction(null, form([["deviceId", "d"], ["expectedVersion", "4"], ["limitSlots", "2"]])))?.issues?.[0]).toContain("다른 사람이 먼저 저장했습니다");
    mocks.read.mockResolvedValue(row({ deviceId: "d", version: 5 }));
    mocks.saveDevice.mockResolvedValue({ before: null, after: { version: 6 } });
    expect(await saveDeviceRowAction(null, form([["deviceId", "d"], ["expectedVersion", "5"], ["limitSlots", "2"]])))
      .toMatchObject({ ok: true, changes: ["운영 한도: 4 → 2", "낮은 순위 상한: 4 → 2"], warnings: [] });
    expect(mocks.revalidate).toHaveBeenCalledWith("/admin/models/devices");
    mocks.revalidate.mockClear();
    mocks.read.mockResolvedValue(row({ deviceId: "d", version: 5, limitSlots: 2 }));
    expect(await saveDeviceRowAction(null, form([["deviceId", "d"], ["expectedVersion", "5"], ["limitSlots", "2"]]))).toMatchObject({ ok: true, message: "바뀐 값이 없습니다." });
    expect(mocks.revalidate).not.toHaveBeenCalled();
    mocks.read.mockRejectedValue(new Error("db down"));
    expect(await saveDeviceRowAction(null, form([["deviceId", "d"], ["expectedVersion", "5"], ["limitSlots", "2"]])))
      .toEqual({ issues: ["저장 결과를 확인하지 못했습니다. 다시 저장하기 전에 새로고침해 현재 한도를 확인해주세요."] });
  });
});

describe("옛 정책 경로 정리", () => {
  const candidates = [{ route: route("product-translate", "supa", "supa", "abcllm"), reason: "장비 supa에 묶인 연결이 없고 …", deviceWithoutConnection: true, aliasHints: [] },
    { route: route("crawl-tagline-legacy", "m1-qwen", "m1-gemma"), reason: "장비 m1-gemma의 연결이 m1-qwen을(를) 내보내지 않고 …", deviceWithoutConnection: false, aliasHints: [] }];
  it("후보 → 경로 이름·모델·서버·짧은 까닭(전체는 title), route 값은 [routeId, provider, model, groupId] JSON", () => {
    const items = staleRouteItems(candidates, CONNECTIONS);
    expect(items[0]).toMatchObject({ value: JSON.stringify(["product-translate", "abcllm", "supa", "supa"]), label: "공개 번역", server: "supa", reason: "연결 없는 장비의 경로" });
    expect(items[1]).toMatchObject({ label: "옛 경로 · 수집 소개 짓기", server: "m1-gemma", reason: "연결이 이 모델을 내보내지 않음" });
  });
  it("후보가 없으면 그리지 않는다; 있으면 체크칸·판·확인 값을 싣는다", () => {
    expect(renderToStaticMarkup(createElement(StaleRoutesPanel, { items: [], revision: 40, readOnly: false, error: null }))).toBe("");
    const html = renderToStaticMarkup(createElement(StaleRoutesPanel, { items: staleRouteItems(candidates, CONNECTIONS), revision: 40, readOnly: false, error: null }));
    expect(html).toContain("옛 정책 경로 정리");
    expect(html).toContain('name="expectedRevision" value="40"');
    expect(html).toContain('name="confirm" value="yes"');
    expect(html.match(/type="checkbox"[^>]*name="route"/g)?.length).toBe(2);
    expect(html).toContain("aria-label=\"공개 번역 · supa · supa 고르기\"");
    expect(html).toMatch(/<button type="button" class="devlim-btn devlim-danger" disabled="">선택한 0개 정리<\/button>/);
  });
});

it("화면 — 표 하나와 세부 설정 접기, 옛 공유 한도 폼(엔진 최대치를 함께 덮던 것)은 쓰지 않는다", () => {
  const page = readFileSync(path.resolve(__dirname, "../app/(operator)/admin/models/devices/page.tsx"), "utf8");
  expect(page).toContain("<DeviceLimitsTable");
  expect(page).toContain("<StaleRoutesPanel");
  expect(page).toMatch(/<details[^>]*>\s*<summary[^>]*><h2>세부 설정<\/h2>/);
  expect(page).not.toContain("SharedLimitForm");
  expect(page).toContain('import "./devices.css"');
});
