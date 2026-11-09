import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import type { ModelCapacityDeviceState, ModelCapacityRouteState } from "@/lib/llm/capacity-devices";
import type { AiConnectionView } from "@/lib/operations/admin-ai-tasks";
import { buildAdminModelsObservation, unavailableAdminModels, type AdminModelMetrics } from "@/lib/operations/admin-models-observation";

// 칸 배분(step 3) — 화면 모형(순수)·폼 → 저장 입력·거절 문장·화면 그리기·server action. DB 없이 본다; 저장소 저장과 장부 관측 읽기는 가짜다.
const mocks = vi.hoisted(() => ({
  admin: vi.fn(), observation: vi.fn(), connections: vi.fn(), ranks: vi.fn(), executions: vi.fn(), save: vi.fn(), revalidate: vi.fn(), readOnly: vi.fn(() => false),
  redirect: vi.fn((href: string) => { throw new Error(`NEXT_REDIRECT:${href}`); }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock("@/lib/operations/admin-workspace-preview", () => ({ adminWorkspaceReadOnly: mocks.readOnly }));
vi.mock("@/lib/operations/admin-models-repository", () => ({ readAdminModelsObservation: mocks.observation }));
vi.mock("@/lib/operations/admin-ai-tasks-repository", () => ({ listAiConnections: mocks.connections, listAiTaskRows: mocks.ranks }));
vi.mock("@/lib/operations/admin-ai-task-execution", () => ({ readAiTaskExecutionAdminViews: mocks.executions }));
vi.mock("@/lib/llm/capacity-devices-repository", () => ({ saveModelCapacityRouteQuotas: mocks.save }));
vi.mock("@/lib/db", () => ({ db: { transaction: (work: (tx: unknown) => unknown) => work({}) }, onPrimary: (run: () => unknown) => run() }));

import CapacityAllocationPage from "@/app/(operator)/admin/models/allocation/page";
import { saveRouteQuotasAction } from "@/app/(operator)/admin/models/allocation/actions";
import { AllocationMatrix } from "@/app/(operator)/admin/models/allocation/AllocationMatrix";
import { modelsAdvancedEditor } from "@/app/(operator)/admin/workspace-navigation";
import { readCapacityAllocationView, routeQuotaChangeLines, routeQuotaIssueMessage, routeQuotaWarningMessage, saveAdminRouteQuotas } from "@/lib/operations/admin-capacity-allocation";
import { ALLOCATION_SECTIONS, allocationAreaLabel, allocationSectionOf, buildCapacityAllocationView, routeQuotasInputFromForm, routeQuotaText, sharedColumnGroupName }
  from "@/lib/operations/capacity-allocation-view";
import { llmAllocationAnchor, llmAllocationHref } from "@/lib/operations/llm-ops-links";

const NOW = "2026-11-08T16:30:00.000Z";
const GPU = "gpu3090-qwen", SUPA = "supa-direct", MLX = "m3-mlx", M1 = "m1-qwen";
const route = (routeId: string, groupId: string, model = "m") => ({ routeId, provider: "local-direct", model, providerBudgetId: "acct", groupId });
// 운영자 예: gpu3090 5칸을 카테고리 분류·1차 AI 검수·보류 재심사·2차 갈림 판가름·감사에 — 2차 AI 검수 투표자 셋은 한 경로(second-review)
// nowhere-host: 정책 groupLimits 에는 있지만 실시간 상태가 없다(대체 한도도 읽히지 않는 장비 — 그 장비로 가는 요청은 보류된다)
const POLICY: ModelCapacityPolicy = { version: 1, groupLimits: { [GPU]: 5, [SUPA]: 3, [MLX]: 2, [M1]: 2, "m3-opencode-host": 2, "nowhere-host": 1 }, providerLimits: { acct: 8 },
  maxWaiting: 50, queueTtlMs: 60_000, reservationTtlMs: 30_000,
  routes: [route("crawl-publish-classify", GPU), route("crawl-agent-review", GPU), route("local-held-qwen", GPU), route("local-qwen-tiebreak", GPU), route("local-audit", GPU),
    route("second-review", SUPA), route("product-search-verify", SUPA), route("second-review", MLX, "gpt-oss"), route("crawl-tagline", MLX, "gpt-oss"),
    route("product-translate", M1), route("crawl-agent-review", "m3-opencode-host", "deepseek"), route("local-human-deepseek", "nowhere-host")] };
const quotaRoute = (routeId: string, patch: Partial<ModelCapacityRouteState> = {}): ModelCapacityRouteState => ({ routeId, active: 0, waiting: 0, minSlots: null, maxSlots: null,
  cap: null, demand: false, held: 0, ...patch });
const device = (deviceId: string, limitSlots: number, patch: Partial<ModelCapacityDeviceState> = {}): ModelCapacityDeviceState => ({ deviceId, source: "table", limitSlots,
  secondaryCap: limitSlots, idleMs: 60_000, reserveSlots: 0, active: 0, secondaryActive: 0, secondaryBound: limitSlots, primaryBusy: false, lending: false, waiting: 0, waitingPrimary: 0,
  version: 7, updatedAt: "2026-11-08T16:00:00.000Z", helpers: [], lendIdle: true, routes: [], ...patch });
const DEVICES: ModelCapacityDeviceState[] = [
  device(GPU, 5, { active: 2, waiting: 2, version: 9, routes: [
    quotaRoute("crawl-agent-review", { waiting: 2, minSlots: 1, maxSlots: 2, cap: 2, demand: true, held: 1 }),
    quotaRoute("crawl-publish-classify", { active: 1, minSlots: 1, maxSlots: 2, cap: 2, demand: true }),
    quotaRoute("local-held-qwen", { active: 1 }),
    // 정책에서 빠진 경로에 남은 몫 줄(상한 0 = 이 장비에서 뺌) — 칸으로 보여야 지울 수 있다
    quotaRoute("local-screen", { minSlots: 0, maxSlots: 0, cap: 0 }),
  ] }),
  device(SUPA, 3, { lendIdle: false, routes: [quotaRoute("second-review", { active: 1, minSlots: 2, maxSlots: 3, cap: 2, demand: true, held: 1 })] }),
  device(MLX, 2), device(M1, 2),
  // 장비 행이 없다(정책 대체 한도) — 몫을 둘 수 없다
  device("m3-opencode-host", 2, { source: "policy_fallback", version: null, lendIdle: true, routes: [] }),
  // 정책 경로가 없는 켜진 장비 행 — 열을 만들지 않는다
  device("anthropic-cli", 4),
];
const metric = (routeId: string, groupId: string, patch: Partial<AdminModelMetrics>): AdminModelMetrics => ({ ...route(routeId, groupId), succeeded1h: 0, failed1h: 0,
  withdrawn1h: 0, unclassified1h: 0, waiting: 0, reserved: 0, dispatched: 0, indeterminate: 0, lastSuccessAt: null, ...patch });
const METRICS = [metric("crawl-publish-classify", GPU, { succeeded1h: 160, failed1h: 1 }), metric("crawl-agent-review", GPU, { succeeded1h: 98, unclassified1h: 2 }),
  metric("second-review", SUPA, { succeeded1h: 40 }), metric("product-translate", M1, { succeeded1h: 114 })];
const observation = (patch: { devices?: ModelCapacityDeviceState[] | null; policy?: ModelCapacityPolicy; policyHash?: string } = {}) => buildAdminModelsObservation({ observedAt: NOW,
  control: { mode: "open", epoch: 4, revision: 12, policy: patch.policy ?? POLICY, policyHash: patch.policyHash ?? modelCapacityPolicyHash(patch.policy ?? POLICY), updatedAt: NOW },
  metrics: METRICS, requests: [], devices: patch.devices === undefined ? DEVICES : patch.devices });
const connection = (deviceId: string, label: string, models: string[] | null = null) => ({ id: `id-${deviceId}-${label}`, label, kind: "api", deviceId, baseUrl: null, host: null,
  hasKey: false, cliTool: null, cliModels: [], models: models && models.map(id => ({ id, maxModelLen: null })), modelsReadAt: null, modelsError: null, capacitySlots: 1,
  contextTokens: null, enabled: true, version: 1, note: null, updatedBy: "jr", updatedAt: NOW, cliVersion: null }) as AiConnectionView;
const form = (entries: [string, string][]) => { const data = new FormData(); for (const [key, value] of entries) data.append(key, value); return data; };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
/** 배분표의 줄 하나(작업 이름으로) — 줄 머리 th 의 title 은 경로 id */
const rowHtml = (html: string, label: string) =>
  html.match(new RegExp(`<tr data-group="[a-z]+"[^>]*><th scope="row" class="alloc-area" title="[^"]*"><span class="alloc-area-in"><span class="alloc-area-name">${label}</span>[^]*?</tr>`))![0];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue({ login: "jr" });
  mocks.readOnly.mockReturnValue(false);
  mocks.observation.mockResolvedValue(observation());
  mocks.connections.mockResolvedValue([connection(GPU, GPU), connection(MLX, "m3-mlx (2)"), connection("m3-opencode-host", "M3 OpenCode")]);
  mocks.ranks.mockResolvedValue([]);
  mocks.executions.mockResolvedValue([]);
});

describe("화면 모형(buildCapacityAllocationView)", () => {
  it("열 = 정책 경로가 가거나 몫이 있는 장비 행(경로 많은 순), 줄 = 작업 영역(작업 목록 순), 칸 = 정책이 보내는 곳 + 남은 몫 줄", () => {
    const view = buildCapacityAllocationView({ observation: observation() });
    expect(view).toMatchObject({ readable: true, policyVerified: true, observedAt: NOW, errors: [] });
    expect(view.devices.map(entry => entry.deviceId)).toEqual([GPU, MLX, SUPA, M1]);
    expect(view.devices[0]).toEqual({ deviceId: GPU, name: GPU, models: [], limitSlots: 5, version: 9, lendIdle: true, active: 2, waiting: 2, guaranteeSum: 2, over: false, lines: 3,
      routes: ["crawl-agent-review", "local-qwen-tiebreak", "local-held-qwen", "local-audit", "local-screen", "crawl-publish-classify"], columns: [], groupName: null, modelLimits: "" });
    expect(view.devices.find(entry => entry.deviceId === SUPA)).toMatchObject({ lendIdle: false, guaranteeSum: 2, lines: 1, routes: ["second-review", "product-search-verify"] });
    // 줄은 갈래(검수 → 분류·감사 → 글·번역·검색) 순, 갈래 안은 작업 목록 순
    expect(view.rows.map(row => [row.routeId, row.label, row.section])).toEqual([
      ["crawl-agent-review", "1차 AI 검수", "review"], ["second-review", "2차 AI 검수 (투표자 1·2·3)", "review"], ["local-qwen-tiebreak", "2차 갈림 판가름", "review"],
      ["local-held-qwen", "보류 재심사", "review"], ["local-audit", "발행분 감사 · 직접 모델", "audit"], ["local-screen", "화면 판별", "audit"],
      ["crawl-publish-classify", "카테고리 분류", "audit"], ["crawl-tagline", "수집 소개 짓기", "text"], ["product-translate", "제품 다국어 번역", "text"],
      ["product-search-verify", "검색 키워드 검수", "text"]]);
    // 줄의 1시간 호출 = 그 줄 칸들의 최근 1시간 정산 합(장부 관측 값 그대로)
    expect(view.rows.find(row => row.routeId === "crawl-publish-classify")).toMatchObject({ calls1h: 161, failed1h: 1, place: [0, null, null, null] });
    expect(view.rows.find(row => row.routeId === "second-review")).toMatchObject({ calls1h: 40, failed1h: 0, place: [null, 0, 0, null] });
    const classify = view.rows.find(row => row.routeId === "crawl-publish-classify")!;
    expect(classify.cells.map(cell => cell?.deviceId ?? null)).toEqual([GPU, null, null, null]);
    expect(classify.cells[0]).toEqual({ deviceId: GPU, routeId: "crawl-publish-classify", mapped: true, minSlots: 1, maxSlots: 2, active: 1, waiting: 0, held: 0, cap: 2,
      settled1h: 161, failed1h: 1 });
    // 몫 줄이 없는 칸: 값은 null(오늘과 같음), 점유는 실시간 상태 그대로
    expect(view.rows.find(row => row.routeId === "local-held-qwen")!.cells[0]).toMatchObject({ mapped: true, minSlots: null, maxSlots: null, active: 1, settled1h: 0 });
    expect(view.rows.find(row => row.routeId === "crawl-agent-review")!.cells[0]).toMatchObject({ waiting: 2, held: 1, settled1h: 100, failed1h: 0 });
    // 정책에서 빠진 경로의 남은 몫
    expect(view.rows.find(row => row.routeId === "local-screen")!.cells[0]).toMatchObject({ mapped: false, minSlots: 0, maxSlots: 0 });
    // 2차 AI 검수는 두 장비에 한 줄
    expect(view.rows.find(row => row.routeId === "second-review")!.cells.map(cell => cell?.deviceId ?? null)).toEqual([null, MLX, SUPA, null]);
    // 행이 없는 장비는 뺀다(대체 한도·아예 없음)
    expect(view.skipped).toEqual([{ deviceId: "m3-opencode-host", name: "m3-opencode-host", reason: "policy_fallback" },
      { deviceId: "nowhere-host", name: "nowhere-host", reason: "unconfigured" }]);
    // 연결을 모르면 아무것도 숨기지 않는다
    expect(view.orphans).toEqual([]);
    expect(view.rows.every(row => row.group === "task" && !row.stale)).toBe(true);
  });

  it("열 이름 = 그 장비를 쓰는 연결 이름(정렬, 「 · 」) + 모델(같은 엔진 별칭은 하나로) — 연결이 없으면 장비 id, 보장 합이 한도를 넘으면 over", () => {
    const over = DEVICES.map(entry => entry.deviceId === M1 ? { ...entry, routes: [quotaRoute("product-translate", { minSlots: 3, maxSlots: null })] } : entry);
    // 2026-11-09 운영 그대로: m3-mlx 장비를 연결 둘이, m1-qwen 장비를 m1-gemma 연결이, supa-direct 는 별칭 두 이름을 내놓는다
    const connections = [connection(GPU, GPU, ["qwen3.8-flash-next"]), connection(MLX, "m3-gpt-oss", ["gpt-oss-120b"]), connection(MLX, "m3-deepseek", ["deepseek-v4.1-flash-1017"]),
      connection(M1, "m1-gemma", ["m1-gemma"]), connection(SUPA, "supa-direct", ["supa", "Inferact/Qwen3.8-27B-NVFP4"])];
    const view = buildCapacityAllocationView({ observation: observation({ devices: over }), connections });
    expect(view.devices.map(entry => [entry.deviceId, entry.name, entry.models])).toEqual([[GPU, GPU, ["qwen3.8-flash-next"]],
      [MLX, "m3-deepseek · m3-gpt-oss", ["gpt-oss-120b", "deepseek-v4.1-flash-1017"]], [SUPA, "supa-direct", ["Inferact/Qwen3.8-27B-NVFP4"]], [M1, "m1-gemma", ["Gemma 4 26B"]]]);
    expect(view.devices.find(entry => entry.deviceId === M1)).toMatchObject({ guaranteeSum: 3, over: true });
    const html = renderToStaticMarkup(<AllocationMatrix view={view} readOnly={false} />);
    expect(text(html)).toContain("m3-deepseek · m3-gpt-oss gpt-oss-120b · deepseek-v4.1-flash-1017 한도 2");
    expect(text(html)).toContain("m1-gemma Gemma 4 26B 한도 2");
    // 장비 id 는 title 에만(보이는 이름으로 쓰지 않는다)
    expect(html).toContain('title="장비 id m1-qwen"');
    expect(text(html.replace(/title="[^"]*"/g, "").replace(/(id|form|aria-label|name)="[^"]*"/g, ""))).not.toMatch(/m1-qwen|\bm3-mlx\b/);
  });

  it("2026-11-09: 연결도 쓰임도 없는 장비는 열을 만들지 않고, 낡은 정책 경로만 남은 줄은 stale, 보조 경로는 「보조」 갈래로 뒤에 모은다", () => {
    const policy: ModelCapacityPolicy = { ...POLICY, groupLimits: { ...POLICY.groupLimits, supa: 20 }, routes: [...POLICY.routes,
      // supa: 연결이 없고 쓰임도 없는 장비 — 옛 별칭 정책 경로만 남았다
      route("local-held-qwen", "supa", "[supa] Qwen3.8-27B-NVFP4"), route("second-review", "supa", "Inferact/Qwen3.8-27B-NVFP4"),
      // m3-mlx: 지금 연결이 내놓지 않는 별칭([MLX] …) — 순위·분산이 쓰지 않으면 낡음
      route("product-translate", MLX, "[MLX] gpt-oss-120b"),
      // 한 번도 쓰지 않은 옛 경로 id
      route("product-tagline-ko-qwen-legacy", GPU, "qwen3.8-flash-next"),
      // 보조 경로 — 같은 작업이 두 백엔드
      route("local-assist-uptime-gpu3090-qwen", GPU, "qwen3.8-flash-next"), route("local-assist-uptime-m3-deepseek", MLX, "deepseek-v4.1-flash-1017"),
      route("local-assist-decision_audit-m3-deepseek", MLX, "deepseek-v4.1-flash-1017")] };
    const devices = [...DEVICES, device("supa", 20)];
    const connections = [connection(GPU, GPU, ["qwen3.8-flash-next"]), connection(MLX, "m3-gpt-oss", ["gpt-oss-120b"]), connection(MLX, "m3-deepseek", ["deepseek-v4.1-flash-1017"]),
      connection(M1, "m1-gemma", ["m1-gemma"]), connection(SUPA, "supa-direct", ["supa", "Inferact/Qwen3.8-27B-NVFP4"]), connection("m3-opencode-host", "M3 OpenCode")];
    const view = buildCapacityAllocationView({ observation: observation({ policy, devices }), connections, references: new Set(["m", "gpt-oss"]) });
    expect(view.devices.map(entry => entry.deviceId)).not.toContain("supa");
    expect(view.orphans).toEqual(["supa", "nowhere-host"].sort());
    expect(view.skipped.map(entry => entry.deviceId)).toEqual(["m3-opencode-host"]);
    const byId = new Map(view.rows.map(row => [row.routeId, row]));
    expect(byId.get("product-tagline-ko-qwen-legacy")).toMatchObject({ label: "옛 경로 · 한국어 소개 번역", stale: true });
    // product-translate: m1-qwen 칸은 쓰는 중(정산 114건), m3-mlx 칸은 낡은 별칭 → 줄은 살아 있다
    expect(byId.get("product-translate")).toMatchObject({ stale: false });
    expect(view.rows.filter(row => row.group === "helper").map(row => [row.routeId, row.label])).toEqual([
      ["local-assist-uptime-gpu3090-qwen", "보조 · 연결 확인 (gpu3090-qwen)"], ["local-assist-uptime-m3-deepseek", "보조 · 연결 확인 (m3-deepseek)"],
      ["local-assist-decision_audit-m3-deepseek", "보조 · 판정 감사"]]);
    // 보조 줄은 맨 뒤, 숨긴 줄은 저장 폼 경로에서 빠진다
    expect(view.rows.slice(-3).every(row => row.group === "helper")).toBe(true);
    expect(view.devices.find(entry => entry.deviceId === GPU)!.routes).not.toContain("product-tagline-ko-qwen-legacy");
    const html = renderToStaticMarkup(<AllocationMatrix view={view} readOnly={false} />);
    expect(html).not.toContain('name="route" value="product-tagline-ko-qwen-legacy"');
    expect(text(html)).toContain("숨긴 옛 경로 1개 보기");
    expect(html).toContain('title="옛 경로 · 한국어 소개 번역 (product-tagline-ko-qwen-legacy)"');
    // 숨긴 옛 줄은 토글을 켜기 전에는 그리지 않는다
    expect(html).not.toContain('title="product-tagline-ko-qwen-legacy"');
    expect(text(html)).toContain("연결도 쓰임도 없는 장비 2대(nowhere-host, supa)");
    expect(html).toMatch(/<tr class="alloc-group" data-group="helper">/);
    // 경로 id 는 title 에만 — 보조 갈래 안에서는 「보조 · 」를 떼고 작업 이름만
    expect(html).toContain('<th scope="row" class="alloc-area" title="local-assist-decision_audit-m3-deepseek"><span class="alloc-area-in"><span class="alloc-area-name">판정 감사</span>');
    expect(text(html.replace(/(title|name|aria-label)="[^"]*"/g, ""))).not.toContain("local-assist-decision_audit-m3-deepseek");
    // 보조 작업은 접힌 한 묶음 — 줄은 hidden 이지만 입력은 그 장비 폼에 붙어 있어 값을 보낸다
    expect(html).toContain('aria-expanded="false"');
    expect(text(html)).toContain("보조 작업 3");
    expect(html).toMatch(/<tr data-group="helper" hidden=""><th scope="row" class="alloc-area" title="local-assist-uptime-gpu3090-qwen">/);
    expect(html).toMatch(/form="alloc-form-0-gpu3090-qwen"[^>]* name="min:local-assist-uptime-gpu3090-qwen"/);
  });

  it("못 읽으면 꾸미지 않는다 — 장부 실패는 표 없이 까닭, 장비 상태 실패도 까닭, 정책 확인 실패는 저장된 몫만", () => {
    const failed = buildCapacityAllocationView({ observation: unavailableAdminModels() });
    expect(failed).toMatchObject({ readable: false, devices: [], rows: [], skipped: [], errors: ["운영 DB 실측을 읽지 못했습니다. 0건으로 간주하지 않습니다."] });
    const noDevices = buildCapacityAllocationView({ observation: observation({ devices: null }) });
    expect(noDevices.devices).toEqual([]);
    expect(noDevices.skipped).toEqual([]);
    expect(noDevices.errors).toEqual([expect.stringContaining("장비 상태(model_capacity_devices)를 읽지 못해")]);
    const unverified = buildCapacityAllocationView({ observation: observation({ policyHash: "0".repeat(64) }) });
    expect(unverified.errors).toEqual([expect.stringContaining("용량 정책을 확인하지 못해")]);
    expect(unverified.devices.map(entry => entry.deviceId)).toEqual([GPU, SUPA]);
    expect(unverified.rows.map(row => row.routeId)).toEqual(["crawl-agent-review", "second-review", "local-screen", "crawl-publish-classify"]);
    expect(unverified.rows.every(row => row.cells.every(cell => cell === null || !cell.mapped))).toBe(true);
  });
});

describe("갈래와 연결(모델)마다 가른 장비 열 — 2026-11-09 승인 시안 #alloc", () => {
  it("줄 갈래: 검수 · 분류·감사 · 글·번역·검색 · 기타 · 보조 작업(이 순서) — 옛 경로 id 는 바탕 작업의 갈래", () => {
    expect(ALLOCATION_SECTIONS.map(entry => entry.label)).toEqual(["검수", "분류 · 감사", "글 · 번역 · 검색", "기타", "보조 작업"]);
    expect(Object.fromEntries(["crawl-agent-review", "second-review", "local-human-deepseek", "local-deepseek-confirm", "local-qwen-tiebreak", "local-held-qwen",
      "crawl-publish-classify", "local-published-filter", "local-audit", "local-second-opinion", "local-screen", "product-audit",
      "crawl-tagline", "product-tagline-ko", "product-translate", "reason-translate", "search-query-translate", "product-search-profile", "product-search-verify", "product-intro-check",
      "grok-session-check", "mystery-route", "local-assist-uptime-gpu3090-qwen", "product-tagline-ko-qwen-legacy", "crawl-agent-review-legacy"].map(id => [id, allocationSectionOf(id)])))
      .toEqual({ "crawl-agent-review": "review", "second-review": "review", "local-human-deepseek": "review", "local-deepseek-confirm": "review", "local-qwen-tiebreak": "review",
        "local-held-qwen": "review", "crawl-publish-classify": "audit", "local-published-filter": "audit", "local-audit": "audit", "local-second-opinion": "audit",
        "local-screen": "audit", "product-audit": "audit", "crawl-tagline": "text", "product-tagline-ko": "text", "product-translate": "text", "reason-translate": "text",
        "search-query-translate": "text", "product-search-profile": "text", "product-search-verify": "text", "product-intro-check": "text", "grok-session-check": "other",
        "mystery-route": "other", "local-assist-uptime-gpu3090-qwen": "helper", "product-tagline-ko-qwen-legacy": "text", "crawl-agent-review-legacy": "review" });
  });

  it("묶음 머리 이름 = 연결 이름의 공통 앞 조각(m3 → M3), 없으면 null", () => {
    expect(sharedColumnGroupName(["m3-deepseek", "m3-gpt-oss"])).toBe("M3");
    expect(sharedColumnGroupName(["oracle-osaka-a", "oracle-osaka-b"])).toBe("oracle-osaka");
    expect(sharedColumnGroupName(["gpu3090-qwen", "supa-direct"])).toBeNull();
    expect(sharedColumnGroupName(["m3", "m3-gpt-oss"])).toBeNull();
    expect(sharedColumnGroupName(["m3-deepseek"])).toBeNull();
  });

  // m3-mlx = 연결 둘(m3-deepseek·m3-gpt-oss)이 서로 다른 모델을 내놓는 장비. 정책 경로의 모델로 칸을 그 연결 열에 놓는다
  const SPLIT_POLICY: ModelCapacityPolicy = { ...POLICY, routes: [...POLICY.routes.filter(entry => entry.groupId !== MLX),
    route("second-review", MLX, "gpt-oss-120b"), route("crawl-tagline", MLX, "gpt-oss-120b"),
    // 장부 이름의 「@연결 8자」는 떼고 맞춘다
    route("local-human-deepseek", MLX, "deepseek-v4.1-flash-1017@0a1b2c3d")] };
  const SPLIT_DEVICES = DEVICES.map(entry => entry.deviceId === MLX ? { ...entry, active: 2, waiting: 3, models: [
    { model: "deepseek-v4.1-flash-1017", active: 1, waiting: 3, maxSlots: 1, engineMax: 1 }, { model: "gpt-oss-120b", active: 1, waiting: 0, maxSlots: 2, engineMax: 4 }] } : entry);
  const SPLIT_CONNECTIONS = [connection(GPU, GPU, ["qwen3.8-flash-next"]), connection(MLX, "m3-gpt-oss", ["gpt-oss-120b"]),
    connection(MLX, "m3-deepseek", ["deepseek-v4.1-flash-1017"]), connection(SUPA, "supa-direct", ["Inferact/Qwen3.8-27B-NVFP4"]), connection(M1, "m1-gemma", ["m1-gemma"])];

  it("켜진 API 연결이 둘 이상이고 모델이 다르면 장비 열을 연결마다 가른다 — 모델 한도·점유는 장비 상태의 모델 상한 줄, 저장은 장비 하나", () => {
    const view = buildCapacityAllocationView({ observation: observation({ policy: SPLIT_POLICY, devices: SPLIT_DEVICES }), connections: SPLIT_CONNECTIONS });
    const mlxIndex = view.devices.findIndex(entry => entry.deviceId === MLX);
    const mlx = view.devices[mlxIndex];
    expect(mlx).toMatchObject({ groupName: "M3", limitSlots: 2, active: 2, waiting: 3,
      modelLimits: "deepseek-v4.1-flash-1017 한도 1 / 엔진 1 · gpt-oss-120b 한도 2 / 엔진 4" });
    expect(mlx.columns).toEqual([
      { connectionId: `id-${MLX}-m3-deepseek`, name: "m3-deepseek", models: ["deepseek-v4.1-flash-1017"], modelLimit: 1, engineMax: 1, active: 1, waiting: 3 },
      { connectionId: `id-${MLX}-m3-gpt-oss`, name: "m3-gpt-oss", models: ["gpt-oss-120b"], modelLimit: 2, engineMax: 4, active: 1, waiting: 0 }]);
    // 가르지 않은 장비는 columns 가 비었다
    expect(view.devices.filter(entry => entry.deviceId !== MLX).every(entry => entry.columns.length === 0 && entry.groupName === null)).toBe(true);
    const placeOf = (routeId: string) => view.rows.find(row => row.routeId === routeId)!.place[mlxIndex];
    expect([placeOf("local-human-deepseek"), placeOf("second-review"), placeOf("crawl-tagline"), placeOf("crawl-agent-review")]).toEqual([0, 1, 1, null]);
    expect(mlx.routes).toEqual(["second-review", "local-human-deepseek", "crawl-tagline"]);

    const html = renderToStaticMarkup(<AllocationMatrix view={view} readOnly={false} />);
    // 머리 두 줄: 「M3 · 공유 한도 2」 묶음(앵커는 장비 id) + 연결 열(이름·모델·모델 한도·지금·대기); 나머지 장비는 두 줄에 걸친다
    expect(html).toMatch(new RegExp(`<th scope="colgroup" colSpan="2" id="${llmAllocationAnchor(MLX)}" class="alloc-dev alloc-dev-group"`));
    expect(text(html)).toContain("M3 · 공유 한도 2 지금 2 · 대기 3");
    expect(text(html)).toContain("m3-deepseek deepseek-v4.1-flash-1017 모델 한도 1 지금 1 · 대기 3");
    expect(text(html)).toContain("m3-gpt-oss gpt-oss-120b 모델 한도 2 지금 1 · 대기 0");
    expect(html).toMatch(new RegExp(`<th scope="col" rowSpan="2" id="${llmAllocationAnchor(GPU)}"`));
    expect(html).toContain('<th scope="col" rowSpan="2" class="alloc-area">작업<span class="alloc-area-sub">1시간 호출</span></th>');
    // 칸은 그 모델을 내놓는 연결 열에 — 사람 몫 위임 검수는 m3-deepseek(첫 열), 2차 AI 검수는 m3-gpt-oss(둘째 열)
    const formId = `alloc-form-${mlxIndex}-m3-mlx`;
    const human = rowHtml(html, "사람 몫 위임 검수");
    expect(human).toContain('aria-label="사람 몫 위임 검수 · m3-deepseek 보장 칸"');
    expect(human).toMatch(new RegExp(`<td><div class="alloc-cell"[^]*form="${formId}"[^]*?</td><td class="alloc-na" title="이 작업을 m3-gpt-oss\\(으\\)로 보내지 않음">`));
    const second = rowHtml(html, "2차 AI 검수 \\(투표자 1·2·3\\)");
    expect(second).toMatch(/<td class="alloc-na" title="이 작업을 m3-deepseek\(으\)로 보내지 않음">[^]*?<\/td><td><div class="alloc-cell"/);
    expect(second).toContain('aria-label="2차 AI 검수 (투표자 1·2·3) · m3-gpt-oss 보장 칸"');
    // 저장은 장비 하나 — 바닥 칸이 두 열에 걸치고, 폼 하나에 두 열의 경로가 모두 있다
    expect(html).toMatch(new RegExp(`<td colSpan="2"><div class="alloc-foot">[^]*?<form id="${formId}"`));
    const mlxForm = html.match(new RegExp(`<form id="${formId}"[^]*?</form>`))![0];
    expect(mlxForm).toContain('aria-label="M3 칸 배분 저장"');
    expect(mlxForm.match(/name="route"/g)).toHaveLength(3);
    expect(text(html)).toContain("보장 합 0 / 2");
  });

  it("칸이 어느 연결 열인지 하나로 정해지지 않으면 그 장비는 한 열 — 정책에서 빠진 몫 줄, 같은 모델을 내놓는 두 연결, 정책 확인 실패, 꺼진 연결", () => {
    const build = (patch: { policy?: ModelCapacityPolicy; devices?: ModelCapacityDeviceState[]; policyHash?: string }, connections: AiConnectionView[] | null = SPLIT_CONNECTIONS) =>
      buildCapacityAllocationView({ observation: observation({ policy: SPLIT_POLICY, devices: SPLIT_DEVICES, ...patch }), connections }).devices.find(entry => entry.deviceId === MLX);
    expect(build({})?.columns).toHaveLength(2);
    const quotaOnly = SPLIT_DEVICES.map(entry => entry.deviceId === MLX ? { ...entry, routes: [quotaRoute("local-screen", { minSlots: 1, maxSlots: 1, cap: 1 })] } : entry);
    expect(build({ devices: quotaOnly })).toMatchObject({ columns: [], groupName: null });
    const same = [...SPLIT_CONNECTIONS.filter(entry => entry.deviceId !== MLX), connection(MLX, "m3-a", ["gpt-oss-120b"]), connection(MLX, "m3-b", ["gpt-oss-120b"])];
    expect(build({}, same)?.columns).toEqual([]);
    const overlap = [...SPLIT_CONNECTIONS.filter(entry => entry.deviceId !== MLX), connection(MLX, "m3-a", ["gpt-oss-120b", "deepseek-v4.1-flash-1017"]),
      connection(MLX, "m3-b", ["deepseek-v4.1-flash-1017"])];
    expect(build({}, overlap)?.columns).toEqual([]);
    expect(build({ policyHash: "0".repeat(64) })?.columns ?? []).toEqual([]);
    const off = SPLIT_CONNECTIONS.map(entry => entry.label === "m3-gpt-oss" ? { ...entry, enabled: false } : entry);
    expect(build({}, off)?.columns).toEqual([]);
    expect(build({}, null)?.columns).toEqual([]);
    // 가르지 않으면 머리는 한 줄, 칸은 장비 열 하나
    const html = renderToStaticMarkup(<AllocationMatrix view={buildCapacityAllocationView({ observation: observation({ policy: SPLIT_POLICY, devices: quotaOnly }),
      connections: SPLIT_CONNECTIONS })} readOnly={false} />);
    expect(html).not.toContain("alloc-dev-group");
    expect(html).not.toContain("rowSpan");
  });

  it("갈린 장비에서 숨긴 옛 줄(stale)의 칸은 연결 열에 놓지 않고 장비 전체에 걸친다", () => {
    const policy: ModelCapacityPolicy = { ...SPLIT_POLICY, routes: [...SPLIT_POLICY.routes, route("product-tagline-ko-qwen-legacy", MLX, "qwen-old")] };
    const view = buildCapacityAllocationView({ observation: observation({ policy, devices: SPLIT_DEVICES }), connections: SPLIT_CONNECTIONS, references: new Set() });
    const mlxIndex = view.devices.findIndex(entry => entry.deviceId === MLX);
    expect(view.devices[mlxIndex].columns).toHaveLength(2);
    expect(view.rows.find(row => row.routeId === "product-tagline-ko-qwen-legacy")).toMatchObject({ stale: true });
    expect(view.rows.find(row => row.routeId === "product-tagline-ko-qwen-legacy")!.place[mlxIndex]).toBeNull();
    expect(view.devices[mlxIndex].routes).not.toContain("product-tagline-ko-qwen-legacy");
  });
});

describe("폼 → 저장 입력(routeQuotasInputFromForm)", () => {
  const base: [string, string][] = [["deviceId", GPU], ["expectedVersion", "9"], ["lendIdle", "on"]];
  it("열의 경로마다 보장(비우면 0)·상한(비우면 없음)을 읽고, 두 칸 다 빈 줄은 보내지 않는다 — 줄은 경로 순", () => {
    const parsed = routeQuotasInputFromForm(form([...base, ["route", "local-held-qwen"], ["route", "crawl-publish-classify"], ["route", "crawl-agent-review"], ["route", "local-screen"],
      ["route", "crawl-publish-classify"], ["min:crawl-publish-classify", "1"], ["max:crawl-publish-classify", "2"], ["min:crawl-agent-review", " 1 "], ["max:crawl-agent-review", ""],
      ["min:local-held-qwen", ""], ["max:local-held-qwen", ""], ["min:local-screen", "0"], ["max:local-screen", "0"]]));
    expect(parsed).toEqual({ issues: [], input: { deviceId: GPU, expectedVersion: 9, lendIdle: true, quotas: [
      { routeId: "crawl-agent-review", minSlots: 1, maxSlots: null }, { routeId: "crawl-publish-classify", minSlots: 1, maxSlots: 2 },
      { routeId: "local-screen", minSlots: 0, maxSlots: 0 }] } });
    // 체크박스가 꺼지면 값이 오지 않는다 = 빌려 쓰기 끔, 모든 칸을 비우면 빈 목록(오늘과 같음)
    expect(routeQuotasInputFromForm(form([["deviceId", GPU], ["expectedVersion", "9"], ["route", "local-audit"], ["min:local-audit", ""], ["max:local-audit", ""]])))
      .toEqual({ issues: [], input: { deviceId: GPU, expectedVersion: 9, lendIdle: false, quotas: [] } });
  });
  it("숫자 모양·보장 > 상한·판 번호를 작업 영역 이름으로 거절한다", () => {
    expect(routeQuotasInputFromForm(form([["deviceId", GPU], ["expectedVersion", ""], ["route", "crawl-publish-classify"], ["min:crawl-publish-classify", "1.5"],
      ["max:crawl-publish-classify", "-1"], ["route", "local-audit"], ["min:local-audit", "3"], ["max:local-audit", "2"]]))).toEqual({ input: null, issues: [
      "판 번호(version)를 읽지 못했습니다. 새로고침해주세요.",
      "카테고리 분류: 보장 칸은 0 이상의 정수로 적어주세요(비우면 0)",
      "카테고리 분류: 상한 칸은 0 이상의 정수로 적어주세요(비우면 상한 없음, 0 은 이 장비에서 뺌)",
      "발행분 감사 · 직접 모델: 보장 칸(3)이 상한 칸(2)보다 많습니다"] });
    expect(routeQuotasInputFromForm(form([["expectedVersion", "1"]])).issues).toEqual(["장비 이름을 읽지 못했습니다. 새로고침해주세요."]);
  });
});

describe("거절·경고·바뀐 값 문장", () => {
  const quotas = [{ routeId: "crawl-agent-review" }, { routeId: "crawl-publish-classify" }];
  it.each([
    ["model_capacity_route_quota_invalid:quotas:min_sum_exceeds_limit", "보장 칸 합계가 장비 칸 수를 넘습니다 — 보장을 줄이거나, 장비 한도에서 칸 수를 먼저 늘려 주세요."],
    ["model_capacity_route_quota_invalid:quotas.1.minSlots:exceeds_limit", "카테고리 분류: 보장 칸이 장비 칸 수보다 많습니다 — 장비 칸 수 이하로 적어주세요."],
    ["model_capacity_route_quota_invalid:quotas.0.maxSlots:exceeds_limit", "1차 AI 검수: 상한 칸이 장비 칸 수보다 많습니다 — 장비 칸 수 이하로 적어주세요."],
    ["model_capacity_route_quota_invalid:quotas.0.maxSlots:min_exceeds_max", "1차 AI 검수: 보장 칸이 상한 칸보다 많습니다 — 상한을 보장 이상으로 적거나 비워 두세요."],
    ["model_capacity_route_quota_invalid:quotas.1.minSlots", "카테고리 분류: 보장 칸은 0~256 의 정수입니다."],
    ["model_capacity_route_quota_invalid:quotas.7.maxSlots", "8번째 줄: 상한 칸은 0~256 의 정수이거나 비워 둡니다."],
    ["model_capacity_route_quota_invalid:quotas:duplicate_route", "같은 작업 영역이 두 번 있습니다. 새로고침해주세요."],
    ["model_capacity_route_quota_invalid:quotas", "작업 영역 몫은 장비 하나에 64줄까지입니다."],
    ["model_capacity_route_quota_invalid:expectedVersion", "판 번호(version)를 읽지 못했습니다. 새로고침해주세요."],
    ["model_capacity_route_quota_invalid:actor", "저장한 사람을 확인하지 못했습니다. 다시 로그인해주세요."],
    ["model_capacity_route_quota_invalid:root", "칸 배분 입력 모양이 틀립니다(알 수 없는 칸이 있거나 칸이 빠졌습니다). 새로고침해주세요."],
    ["model_capacity_route_quota_invalid:something_new", "칸 배분이 검사를 통과하지 못했습니다: something_new"],
    ["model_capacity_route_quota_version_mismatch:10", "다른 곳(장비 한도·칸 배분)에서 이 장비를 먼저 저장했습니다(지금 판 10). 새로고침해 바뀐 값을 확인한 뒤 다시 저장해주세요."],
    ["model_capacity_route_quota_device_unconfigured", "이 장비는 장비 행이 없거나 꺼져 있어 칸을 나눌 수 없습니다 — 장비 한도에서 장비 행을 먼저 저장하거나 켜 주세요."],
    ["site_fenced", "이 사이트는 지금 쓰기가 막혀 있습니다(DR)."],
    ["model_capacity_device_version_exhausted", "이 장비의 판 번호가 상한에 닿았습니다 — 운영자에게 알려주세요."],
    ["weird_code", "weird_code"],
  ])("%s", (code, message) => expect(routeQuotaIssueMessage(code, quotas)).toBe(message));

  it("경고는 저장한 뒤의 알림, 바뀐 값은 「영역: 전 → 후」", () => {
    expect(routeQuotaWarningMessage("route_unmapped:local-screen")).toBe("화면 판별: 지금 정책에서 이 장비로 오지 않습니다 — 몫은 저장했고, 이 장비로 오면 그때부터 적용됩니다.");
    expect(routeQuotaWarningMessage("policy_unreadable")).toContain("용량 정책을 읽지 못해");
    expect(routeQuotaChangeLines({ lendIdle: true, quotas: [{ routeId: "crawl-agent-review", minSlots: 1, maxSlots: 2 }, { routeId: "local-audit", minSlots: 1, maxSlots: null }] },
      { lendIdle: false, quotas: [{ routeId: "crawl-agent-review", minSlots: 1, maxSlots: 2 }, { routeId: "crawl-publish-classify", minSlots: 1, maxSlots: 0 }] }))
      .toEqual(["빈 칸 빌려 쓰기: 켬 → 끔", "카테고리 분류: 없음 → 보장 1 · 상한 0(뺌)", "발행분 감사 · 직접 모델: 보장 1 · 상한 없음 → 없음"]);
    expect(routeQuotaText(null)).toBe("없음");
    expect(allocationAreaLabel("unknown-route")).toBe("unknown-route");
  });
});

describe("칸 배분 화면 그리기", () => {
  it("고급 설정 편집기 「칸 배분」 — 열 머리(장비 · 한도 N), 칸마다 보장·상한 입력(그 열의 폼에 붙는다)·지금·1시간, 「—」·「이 장비에서 뺌」·열 아래 저장", async () => {
    const html = renderToStaticMarkup(await CapacityAllocationPage());
    expect(mocks.observation).toHaveBeenCalledWith({ throughput: false });
    expect(modelsAdvancedEditor("allocation")).toMatchObject({ label: "칸 배분", href: "/admin/models/allocation" });
    expect(html).toMatch(/<h1[^>]*>칸 배분<\/h1>/);
    expect(html).toContain('href="/admin/models/advanced">← 고급 설정</a>');
    expect(html).toContain('href="/admin/models/devices">장비 한도 →</a>');
    expect(html).toContain('id="allocation"');
    expect(html).toContain(`id="${llmAllocationAnchor(GPU)}"`);
    expect(text(html)).toContain(`${GPU} 한도 5 지금 2 · 대기 2`);
    expect(text(html)).toContain("m3-mlx (2) 한도 2");
    // 칸: 저장된 값과 빈 값, 입력은 form 속성으로 그 장비 열의 폼에 붙는다
    const classify = rowHtml(html, "카테고리 분류");
    expect(classify).toMatch(/<input type="number"[^>]* max="5"[^>]* form="alloc-form-0-gpu3090-qwen"[^>]* name="min:crawl-publish-classify" value="1"\/>/);
    expect(classify).toMatch(/<input type="number"[^>]* form="alloc-form-0-gpu3090-qwen"[^>]* name="max:crawl-publish-classify" value="2"\/>/);
    expect(classify).toContain('aria-label="카테고리 분류 · gpu3090-qwen 보장 칸"');
    // 줄 머리: 이름 + 1시간 호출(실패 함께), 경로 id 는 title. 칸: 지금·대기(켤 때만 보이는 글), 1시간 정산은 칸 title
    expect(classify).toContain('title="crawl-publish-classify"');
    expect(text(classify)).toContain("카테고리 분류 161 · 실패 1");
    expect(text(classify)).toContain("지금 1 · 대기 0");
    expect(classify).toContain('title="최근 1시간 161건 · 실패 1 · 지금 상한 2"');
    expect(classify.match(/class="alloc-na"/g)).toHaveLength(3);
    const held = rowHtml(html, "보류 재심사");
    expect(held).toMatch(/form="alloc-form-0-gpu3090-qwen"[^>]* name="min:local-held-qwen" value=""\/>/);
    expect(held).toContain('placeholder="–"');
    const screen = rowHtml(html, "화면 판별");
    expect(text(screen)).toContain("이 장비에서 뺌");
    expect(text(screen)).toContain("정책 경로 없음");
    expect(text(rowHtml(html, "1차 AI 검수"))).toContain("지금 0 · 대기 2 · 비워 둠 1");
    // 갈래 머리 줄과 지금·대기 토글(처음엔 꺼짐 — 표에 data-show-use 없음)
    expect(html.match(/<tr class="alloc-group" data-group="(review|audit|text)">/g)).toHaveLength(3);
    expect(text(html)).toContain("칸마다 지금·대기 보기");
    expect(html).not.toContain("data-show-use");
    // 열 아래: 보장 합 / 한도, 빌려 쓰기(장비마다), 그 장비의 폼(판·경로)
    expect(text(html)).toContain("보장 합 2 / 5");
    expect(html).toContain('<form id="alloc-form-0-gpu3090-qwen"');
    expect(html).toContain('name="expectedVersion" value="9"');
    expect(html.match(/<input type="hidden" name="route"[^>]*>/g)?.length).toBe(6 + 2 + 2 + 1);
    expect(html).toMatch(/aria-label="gpu3090-qwen 빈 칸 빌려 쓰기" name="lendIdle" checked=""\/>/);
    expect(html).toMatch(/aria-label="supa-direct 빈 칸 빌려 쓰기" name="lendIdle"\/>/);
    expect(html.match(/>저장<\/button>/g)).toHaveLength(4);
    // 바뀐 값이 없으면 저장 단추는 잠겨 있다
    expect(html.match(/<button type="button" data-confirm-trigger="" disabled=""[^>]*>저장<\/button>/g)).toHaveLength(4);
    // 설명은 한 줄
    expect(text(html)).toContain("보 보장: 일이 있으면 늘 남겨 두는 칸 · 상 상한: 한 번에 쓰는 최대(비우면 없음, 0이면 뺌)");
    expect(text(html)).toContain("둘 다 비우면 오늘과 같고");
    expect(text(html)).toContain("장비 행이 없거나 꺼진 장비 1대( M3 OpenCode )");
    expect(text(html)).toContain("연결도 쓰임도 없는 장비 1대(nowhere-host)");
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("읽기 전용 미리보기는 저장 칸(폼·입력·저장)을 감추고 값만 보인다", async () => {
    mocks.readOnly.mockReturnValue(true);
    const html = renderToStaticMarkup(await CapacityAllocationPage());
    expect(html).not.toContain("<form");
    expect(html).not.toContain('name="min:');
    expect(html).not.toContain(">저장</button>");
    expect(text(html)).toContain("빈 칸 빌려 쓰기 켬");
    expect(text(html)).toContain("빈 칸 빌려 쓰기 끔");
    expect(text(html)).toContain("보 보장 1 상 상한 2");
  });

  it("장부를 못 읽으면 표 대신 까닭, 연결 이름을 못 읽어도 화면은 뜬다", async () => {
    mocks.observation.mockResolvedValue(unavailableAdminModels());
    mocks.connections.mockRejectedValue(new Error("down"));
    const html = renderToStaticMarkup(await CapacityAllocationPage());
    expect(html).toContain("운영 DB 실측을 읽지 못했습니다");
    expect(html).toContain("장비 상태를 읽지 못해 배분표를 그리지 못했습니다.");
    expect(html).not.toContain("<table");
    mocks.observation.mockResolvedValue(observation());
    expect((await readCapacityAllocationView()).devices.every(entry => entry.name === entry.deviceId)).toBe(true);
  });

  it("보장 합이 한도를 넘는 열은 경고하고 저장 단추를 잠근다", () => {
    const over = DEVICES.map(entry => entry.deviceId === M1 ? { ...entry, routes: [quotaRoute("product-translate", { minSlots: 3, maxSlots: null })] } : entry);
    const html = renderToStaticMarkup(<AllocationMatrix view={buildCapacityAllocationView({ observation: observation({ devices: over }) })} readOnly={false} />);
    expect(text(html)).toContain("보장 합 3 / 2");
    expect(html).toContain("보장 합이 한도를 넘습니다</span>");
    expect(html).toContain("보장이 한도 2칸보다 많습니다");
    const m1 = html.match(/<form id="alloc-form-3-m1-qwen"[^]*?<\/form>/)![0];
    expect(m1).toMatch(/<button type="button" data-confirm-trigger="" disabled=""/);
  });

  it("다른 화면이 거는 주소 — 장비 열 앵커와 표 앵커", () => {
    expect(llmAllocationHref()).toBe("/admin/models/allocation#allocation");
    expect(llmAllocationHref("gpu3090-qwen")).toBe("/admin/models/allocation#alloc-gpu3090-qwen");
    expect(llmAllocationAnchor("a b/c")).toBe("alloc-a_b_c");
  });
});

describe("server action(saveRouteQuotasAction)", () => {
  const entries: [string, string][] = [["deviceId", GPU], ["expectedVersion", "9"], ["lendIdle", "on"], ["route", "crawl-publish-classify"], ["min:crawl-publish-classify", "1"],
    ["max:crawl-publish-classify", "2"], ["route", "crawl-agent-review"], ["min:crawl-agent-review", "1"], ["max:crawl-agent-review", ""]];
  it("저장 → 저장소 한 번(그 입력 그대로), 바뀐 값·경고를 한국어로, 영향 받는 화면을 다시 읽게 한다", async () => {
    mocks.save.mockResolvedValue({ before: { lendIdle: true, quotas: [] },
      after: { deviceId: GPU, version: 10, lendIdle: true, routeQuotas: [{ routeId: "crawl-agent-review", minSlots: 1, maxSlots: null }, { routeId: "crawl-publish-classify", minSlots: 1, maxSlots: 2 }] },
      warnings: ["route_unmapped:crawl-agent-review"] });
    const result = await saveRouteQuotasAction(null, form(entries));
    expect(mocks.save).toHaveBeenCalledWith({}, { deviceId: GPU, expectedVersion: 9, lendIdle: true, quotas: [
      { routeId: "crawl-agent-review", minSlots: 1, maxSlots: null }, { routeId: "crawl-publish-classify", minSlots: 1, maxSlots: 2 }] }, "jr");
    expect(result).toEqual({ ok: true, message: "저장했습니다(장비 gpu3090-qwen, 판 10). 다음 입장부터 바로 쓰입니다 — 이미 잡힌 칸은 그대로 끝나고 DRAIN 은 필요 없습니다.",
      changes: ["1차 AI 검수: 없음 → 보장 1 · 상한 없음", "카테고리 분류: 없음 → 보장 1 · 상한 2"],
      warnings: ["1차 AI 검수: 지금 정책에서 이 장비로 오지 않습니다 — 몫은 저장했고, 이 장비로 오면 그때부터 적용됩니다."] });
    expect(mocks.revalidate.mock.calls.map(call => call[0])).toEqual(["/admin/models/allocation", "/admin/models/devices", "/admin/models", "/admin/models/llm",
      "/admin/models/tasks", "/admin/status"]);
  });

  it("거절은 보낸 줄의 작업 영역 이름으로(저장소 순서 = 경로 순), 알 수 없는 DB 오류는 던지지 않고 그대로 보인다", async () => {
    mocks.save.mockRejectedValueOnce(new Error("model_capacity_route_quota_invalid:quotas.1.maxSlots:exceeds_limit"));
    expect(await saveRouteQuotasAction(null, form(entries))).toEqual({ issues: ["카테고리 분류: 상한 칸이 장비 칸 수보다 많습니다 — 장비 칸 수 이하로 적어주세요."] });
    mocks.save.mockRejectedValueOnce(new Error("model_capacity_route_quota_version_mismatch:11"));
    expect((await saveRouteQuotasAction(null, form(entries)))?.issues?.[0]).toContain("지금 판 11");
    mocks.save.mockRejectedValueOnce(new Error("connection reset"));
    expect(await saveRouteQuotasAction(null, form(entries))).toEqual({ issues: ["connection reset"] });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("관리자가 아니거나 폼이 틀리면 저장소에 닿지 않는다; 저장 함수는 DR 거절을 문장 코드로 돌려준다", async () => {
    mocks.admin.mockResolvedValueOnce(null);
    expect(await saveRouteQuotasAction(null, form(entries))).toEqual({ issues: ["권한이 없습니다. 다시 로그인해주세요."] });
    expect(await saveRouteQuotasAction(null, form([...entries.filter(([key]) => key !== "max:crawl-publish-classify"), ["max:crawl-publish-classify", "x"]])))
      .toEqual({ issues: ["카테고리 분류: 상한 칸은 0 이상의 정수로 적어주세요(비우면 상한 없음, 0 은 이 장비에서 뺌)"] });
    expect(mocks.save).not.toHaveBeenCalled();
    const { DrWriterFencedError } = await import("@/lib/operations/dr/epoch");
    mocks.save.mockRejectedValueOnce(new DrWriterFencedError("site_fenced"));
    expect(await saveAdminRouteQuotas({ deviceId: GPU, expectedVersion: 9, lendIdle: true, quotas: [] }, "jr")).toEqual({ ok: false, issues: ["site_fenced"] });
    expect(await saveAdminRouteQuotas({ deviceId: GPU, expectedVersion: 9, lendIdle: true, quotas: [] }, " ")).toEqual({ ok: false, issues: ["invalid_actor"] });
  });
});
