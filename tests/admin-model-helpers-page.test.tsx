import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 보조 모델 화면 한 장(2026-11-09 시안) — 머리 · 감시자 · 도우미 배정 · 보조 작업 경로 · 자동 정지 · 최근 기록을 실제 화면 모형으로 그린다(DB 없이).
const mocks = vi.hoisted(() => ({ helpers: vi.fn(), connections: vi.fn(), observation: vi.fn(),
  redirect: vi.fn((href: string) => { throw new Error(`NEXT_REDIRECT:${href}`); }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: async () => ({ login: "jr" }) }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock("@/lib/db", () => ({ db: {}, onPrimary: (run: () => unknown) => run() }));
vi.mock("@/lib/operations/admin-model-helpers", async importOriginal => ({ ...await importOriginal<object>(), readModelHelpersAdminView: mocks.helpers }));
vi.mock("@/lib/operations/admin-ai-tasks-repository", () => ({ listAiConnections: mocks.connections }));
vi.mock("@/lib/operations/admin-models-repository", () => ({ readAdminModelsObservation: mocks.observation }));

import ModelHelpersPage from "@/app/(operator)/admin/models/helpers/page";
import { HELPER_ROUTE_DEFAULTS, parseHelperAssignment, SUPERVISOR_PRINCIPAL } from "@/lib/llm/capacity-helpers";
import { buildModelHelpersAdminView } from "@/lib/operations/admin-model-helpers";
import { unavailableAdminModels, type AdminModelsObservation } from "@/lib/operations/admin-models-observation";

const NOW_MS = Date.parse("2026-11-09T00:00:00.000Z");
const at = (offset: number) => new Date(NOW_MS + offset).toISOString();
const AI1 = { ...parseHelperAssignment({ assignmentId: "m3-deepseek:ai1", stage: "ai1", deviceId: "m3-deepseek", model: "deepseek-v4.1-flash", ...HELPER_ROUTE_DEFAULTS.ai1, mode: "shadow" }),
  version: 3, evidenceKey: "a".repeat(64), promotedAt: null, promotedBy: null, updatedBy: "jr", createdAt: at(-86_400_000), updatedAt: at(-60_000) };
const view = buildModelHelpersAdminView({ now: new Date(NOW_MS), audit: [], snapshot: {
  nowMs: NOW_MS, assignments: [AI1], signals: [], stops: [], deviceSignals: [], roleDemand: [], gates: [],
  control: { enabled: true, signalPrincipal: SUPERVISOR_PRINCIPAL, signalTtlMs: 90_000, loopMs: 30_000, ownerInstanceId: "oracle-osaka-1", ownerBootId: null, epoch: 4,
    leaseUntil: at(30_000), heartbeatAt: at(-5_000), loopSeq: 7, release: null, updatedBy: "jr", updatedAt: at(-3_600_000) } } });
const observation: AdminModelsObservation = { ...unavailableAdminModels(), error: null, observedAt: at(0), mode: "open", policyVerified: true,
  rows: [{ routeId: "local-assist-uptime-gpu3090-qwen", provider: "local-direct", model: "qwen", groupId: "gpu3090", providerBudgetId: "local", succeeded1h: 0, failed1h: 0,
    withdrawn1h: 0, unclassified1h: 0, waiting: 0, reserved: 0, dispatched: 0, indeterminate: 0, lastSuccessAt: null }],
  configuredRoutes: [{ routeId: "local-assist-uptime-gpu3090-qwen", provider: "local-direct", model: "qwen", groupId: "gpu3090", providerBudgetId: "local" }] };

beforeEach(() => {
  mocks.helpers.mockResolvedValue(view);
  mocks.connections.mockResolvedValue([{ id: "c1", label: "m3-deepseek", kind: "api", cliTool: null, deviceId: "m3-deepseek", enabled: true, models: [] },
    { id: "c2", label: "gpu3090-qwen", kind: "api", cliTool: null, deviceId: "gpu3090", enabled: true, models: [] }]);
  mocks.observation.mockResolvedValue(observation);
});

describe("보조 모델 화면", () => {
  it("머리(경로 · 제목 · 한 줄 · 수)와 패널 다섯을 같은 간격으로 그린다", async () => {
    const html = renderToStaticMarkup(await ModelHelpersPage());
    expect(mocks.observation).toHaveBeenCalledWith({ throughput: false });
    expect(html).toContain('<header class="mh-head">');
    expect(html).toContain('href="/admin/models/advanced">← 고급 설정</a>');
    expect(html).toMatch(/<h1>도우미·감시자<\/h1>/);
    expect(html).toMatch(/<p class="mh-meta">[^]*감시자 <b>늦음<\/b>[^]*배정 <b class="mh-num">1<\/b>[^]*보조 작업 <b class="mh-num">1<\/b> · 쉼 1/);
    expect([...html.matchAll(/<h2 id="mh-[a-z]+-title">([^<]+)/g)].map(match => match[1])).toEqual(["감시자", "도우미 배정", "보조 작업 경로", "자동 정지", "최근 기록"]);
    // 보조 작업 경로 — 작업 이름 · 서버(연결 이름) · 마지막 사용(24시간 안 없음) · 쉼
    const routes = html.match(/<table class="mh-table mh-routes">[^]*?<\/table>/)![0];
    expect(routes).toMatch(/<td title="local-assist-uptime-gpu3090-qwen">연결 확인<\/td><td><span title="장비 id gpu3090\nqwen">gpu3090-qwen<\/span>/);
    expect(routes).toContain("24시간 안 없음");
    expect(routes).toContain('data-shape="‖">쉼</span>');
    // 배정 줄의 「설정」 → 펼침 줄 안의 폼, 새 배정은 접힌 「새 배정 +」
    expect(html).toMatch(/<tr id="helper-m3-deepseek:ai1-row" class="mh-form-row" hidden="">[^]*name="expectedVersion" value="3"/);
    expect(html).toMatch(/<details id="new" class="mh-details"><summary>새 배정 \+<\/summary>[^]*id="helper-new"/);
    expect(html).toContain("지금 걸린 자동 정지가 없습니다.");
    // 긴 안내 문단은 없다
    expect(html).not.toContain("입장 판정이 DB 안에서 본");
  });

  it("장부를 못 읽어도 화면은 뜨고 보조 작업 칸만 까닭을 보인다", async () => {
    mocks.observation.mockResolvedValue(unavailableAdminModels());
    const html = renderToStaticMarkup(await ModelHelpersPage());
    expect(html).toContain("보조 작업 경로를 보이지 못합니다");
    expect(html).not.toContain("보조 작업 <b");
  });
});
