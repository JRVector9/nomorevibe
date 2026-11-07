import { readFileSync } from "node:fs";
import path from "node:path";
import { prerenderToNodeStream } from "react-dom/static";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { advancedDevices, advancedJobs, advancedUnknowns } from "./fixtures/admin-models-advanced";
import { redesignAssignments, redesignObservation } from "./fixtures/admin-models-redesign";
import { pinTextRanks, textRankRow } from "./text-task-ranks-fixture";

/*
 * 고급 설정(/admin/models/advanced, 2026-11-07 LLM 운영 PR 5) — 편집기 목록 + 장애 분석.
 * 저장소 읽기만 바꿔 끼우고 화면 전체를 그린다(prerender 는 Suspense 안의 async 칸까지 기다린다). 쓰기는 하지 않는다.
 */
const mocks = vi.hoisted(() => ({
  redirect: vi.fn((href: string) => { throw new Error(`NEXT_REDIRECT:${href}`); }),
  readOnly: vi.fn(() => false), observation: vi.fn(), unknowns: vi.fn(), devices: vi.fn(), helpers: vi.fn(), jobs: vi.fn(), runtime: vi.fn(), route: vi.fn(),
  agent: vi.fn(), health: vi.fn(), recordProbes: vi.fn(), human: vi.fn(), opsStates: vi.fn(), roles: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: async () => ({ login: "jr" }) }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock("@/lib/db", () => ({ db: {}, onPrimary: (run: () => unknown) => run() }));
vi.mock("@/lib/operations/admin-workspace-preview", () => ({ adminWorkspaceReadOnly: mocks.readOnly }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: async () => DEFAULT_CRAWL_SETTINGS, settingsFormVersion: () => "fixture-v1" }));
vi.mock("@/lib/crawl/review-task-ranks", () => ({ ensureReviewTaskRanks: async () => undefined }));
vi.mock("@/lib/crawl/first-reviewers", () => ({ firstReviewers: () => redesignAssignments[0].models }));
vi.mock("@/lib/crawl/second-review-voters", () => ({ secondReviewVoterSets: () => ({ voters: [], fallbacks: [] }) }));
vi.mock("@/lib/llm/admin-model-pools", () => ({ ensureCliStageCatalogs: async () => undefined }));
vi.mock("@/lib/operations/model-env", () => ({ currentModelEnv: async () => ({ translate: "", productTranslate: "", tagline: "", profile: "gpt-oss-120b", verify: "", introCheck: "sonnet" }) }));
vi.mock("@/lib/llm/ai-task-resolver", async importOriginal => {
  const real = await importOriginal<typeof import("@/lib/llm/ai-task-resolver")>();
  return { ...real, TextTaskRanks: { open: async (route: Parameters<typeof real.resolveTextTaskRanks>[0]) => ({ resolution: real.resolveTextTaskRanks(route), bindings: () => [] }) } };
});
vi.mock("@/lib/operations/admin-assignment-source", () => ({ assignmentTableFlag: async () => false, assignmentSources: async () => ({}) }));
vi.mock("@/lib/operations/admin-models-repository", () => ({ readAdminModelsObservation: mocks.observation }));
vi.mock("@/lib/operations/admin-engine-connect", () => ({ readServedContractModels: async () => [] }));
vi.mock("@/lib/operations/admin-models-human", () => ({ configuredHumanModelsProbe: mocks.human }));
vi.mock("@/lib/operations/model-capacity-unknowns", async importOriginal => ({ ...await importOriginal<object>(), readModelCapacityUnknowns: mocks.unknowns }));
vi.mock("@/lib/operations/ops-runner/repository", () => ({ readModelOpsStates: mocks.opsStates }));
vi.mock("@/lib/operations/roles", () => ({ roleOverview: mocks.roles }));
vi.mock("@/lib/operations/admin-models-probe-repository", () => ({ autoProbeDirectEngines: async () => 0, readProbeObservations: async () => ({}), recordAutoProbes: mocks.recordProbes }));
vi.mock("@/lib/operations/admin-serving-contracts", () => ({ readbackServingEndpoint: vi.fn() }));
vi.mock("@/lib/operations/admin-capacity-devices", async importOriginal => ({ ...await importOriginal<object>(), readCapacityDevicesAdminView: mocks.devices }));
vi.mock("@/lib/operations/admin-model-helpers", async importOriginal => ({ ...await importOriginal<object>(), readModelHelpersAdminView: mocks.helpers }));
vi.mock("@/lib/operations/admin-models-jobs", () => ({ readCatalogJobRegistration: mocks.jobs }));
vi.mock("@/lib/operations/admin-ai-tasks-repository", () => ({ readAiTaskRuntime: mocks.runtime }));
vi.mock("@/lib/operations/model-route-status", () => ({ readModelRouteStatus: mocks.route }));
vi.mock("@/lib/operations/agent-client", () => ({ agentRequest: mocks.agent }));
vi.mock("@/lib/operations/model-servers", () => ({ modelServerHealth: mocks.health }));
vi.mock("@/app/(operator)/admin/models/operation-actions", () => ({ probeAdminModel: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/ops-runner-actions", () => ({ submitAdminModelOperation: vi.fn(), readAdminModelOperation: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/actions", () => ({ saveReviewModels: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/stage-model-actions", () => ({ saveAdminStageModels: vi.fn() }));

import ModelsAdvancedPage from "@/app/(operator)/admin/models/advanced/page";
import { AdvancedEditorsIndex } from "@/app/(operator)/admin/models/advanced/advanced-slots";
import { MODELS_ADVANCED_EDITORS, MODELS_ADVANCED_HREF, WORKSPACE_SECONDARY } from "@/app/(operator)/admin/workspace-navigation";

async function prerender(node: ReactNode): Promise<string> {
  const { prelude } = await prerenderToNodeStream(node);
  let html = "";
  for await (const chunk of prelude) html += chunk;
  // 정적 HTML 사이의 글자 경계 주석(<!-- -->)은 빼고 본다
  return html.replace(/<!-- -->/g, "");
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/\s+/g, " ");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readOnly.mockReturnValue(false);
  mocks.observation.mockResolvedValue(redesignObservation());
  mocks.unknowns.mockResolvedValue(advancedUnknowns);
  mocks.devices.mockResolvedValue(advancedDevices);
  mocks.helpers.mockRejectedValue(new Error("helpers_unread"));
  mocks.jobs.mockResolvedValue(advancedJobs);
  mocks.runtime.mockResolvedValue({});
  mocks.route.mockResolvedValue({ ok: false, reason: "no_replica" });
  mocks.agent.mockResolvedValue({ connected: true, classifyReady: true, config: { primary: { model: "gpt-5.6-terra", effort: "high" }, fallback: null },
    modelOptions: [{ model: "gpt-5.6-terra", provider: "codex-cli" }] });
  mocks.health.mockResolvedValue([{ name: "임베딩", ok: true }, { name: "재정렬", ok: false, error: "HTTP 503" }]);
  mocks.recordProbes.mockResolvedValue(1);
  mocks.human.mockResolvedValue([]);
  mocks.opsStates.mockResolvedValue([]);
  mocks.roles.mockResolvedValue(null);
  pinTextRanks([textRankRow("product-search-profile", "gpt-oss-120b", { label: "gpu3090" })]);
  setServingContractSnapshotForTest([]);
});
afterEach(() => { pinTextRanks(null); setServingContractSnapshotForTest(null); });

describe("고급 설정 화면 그리기", () => {
  it("편집기 일곱 개를 메뉴와 같은 이름·한 줄 설명으로 먼저 보이고, 장애 분석에 표·장비·도우미·작업 순위·경로 계약을 둔다", async () => {
    const html = await prerender(await ModelsAdvancedPage());
    expect(html).toMatch(/<h1[^>]*>고급 설정<\/h1>/);
    for (const editor of MODELS_ADVANCED_EDITORS) {
      expect(html).toContain(`href="${editor.href}"`);
      expect(html).toContain(`${editor.label} →`);
      expect(html).toContain(editor.purpose);
    }
    // 장애 분석: 단계 × 모델 표(연결 확인·모델 재시작·정식 해제), 장비 상세, 도우미 접기, 옮겨 온 진단 표 두 개
    expect(html).toContain('id="analysis"');
    expect(html).toContain(">단계 × 모델</h2>");
    expect(html).toContain(">연결 확인</button>");
    expect(html).toContain(">모델 재시작</button>");
    expect(html).toContain("종료(정식 해제)");
    expect(html).toContain('<caption class="sr-only">장비별 한도와 점유</caption>');
    expect(html).toContain('<details id="assign"');
    expect(html).toContain('id="llm-routes"');
    expect(html).toContain("작업 ↔ 모델 · text 작업 순위");
    expect(html).toContain("모델 경로 계약 · 전환 진행");
    // 자동 연결 확인은 결과 한 줄 + 진짜 편집 화면 링크(운영센터 AI 연결 탭의 분류 모델 선택 — 예전 /admin/status#ai-model-title 는 탭 없이 깨졌다)
    expect(html).toContain('href="/admin/status?tab=ai#ai-model-title"');
    expect(html).not.toContain('href="/admin/status#ai-model-title"');
    expect(text(html)).toContain("검색 서버 · 임베딩 응답 확인 · 재정렬 확인 실패(HTTP 503)");
    expect(mocks.recordProbes).toHaveBeenCalled();
    // 단계별 모델 풀(다른 곳에 편집기가 없는 단계)은 접어 두고, id 는 폼 하나만 갖는다
    expect(html).toContain('<details id="stage-pools"');
    expect(html.match(/id="model-settings"/g)).toHaveLength(1);
    // 확인 못함 검토 목록은 기록 화면(PR 3)이 맡는다 — 여기는 옛 #review 링크를 받는 안내만
    expect(html).not.toContain("unknown-review-heading");
    expect(html).toContain('id="review"');
    expect(html).toContain('href="/admin/models/history"');
    // 옛 참고 접힘의 자리표시·겹치는 칸은 없다
    expect(html).not.toContain('id="ref"');
    expect(html).not.toContain("다른 LLM 단계 · 지금 1순위");
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it("읽기 전용 미리보기에서는 새 연결 확인을 하지 않는다", async () => {
    mocks.readOnly.mockReturnValue(true);
    const html = await prerender(await ModelsAdvancedPage());
    expect(html).toContain("읽기 전용 미리보기에서는 새 연결 확인을 하지 않습니다");
    expect(mocks.agent).not.toHaveBeenCalled();
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.human).not.toHaveBeenCalled();
  });

  it("장비·도우미를 읽지 못해도 화면은 나가고 그 칸만 까닭을 보인다", async () => {
    mocks.route.mockResolvedValue({ ok: false, reason: "error" });
    const html = await prerender(await ModelsAdvancedPage());
    expect(html).toContain("도우미 상태를 읽지 못했습니다");
    expect(html).toContain("보류 — 읽다가 실패했습니다");
  });
});

describe("이름 통일 — 메뉴·화면 제목·뒤로 가기가 같은 표 하나를 쓴다", () => {
  const root = path.resolve(__dirname, "..");
  it("두 번째 메뉴는 고급 설정 + 편집기 일곱 개이고, 목록 화면과 같은 순서·이름이다", () => {
    expect(MODELS_ADVANCED_HREF).toBe("/admin/models/advanced");
    expect(WORKSPACE_SECONDARY.modelsAdvanced.map(link => link.label)).toEqual(["고급 설정", "실시간 한도", "장비 한도", "도우미·감시자", "모델 배정 표", "서빙 계약·등록부", "사람 위임 모델", "검색 모델"]);
    const index = renderToStaticMarkup(<AdvancedEditorsIndex />);
    expect([...index.matchAll(/class="advanced-editor-name">([^<]+) →</g)].map(match => match[1])).toEqual(MODELS_ADVANCED_EDITORS.map(editor => editor.label));
  });
  it.each(MODELS_ADVANCED_EDITORS.map(editor => [editor.id, editor.href] as const))("%s 화면은 그 이름으로 제목·문서 제목을 짓고 「← 고급 설정」으로 돌아간다", (id, href) => {
    const page = readFileSync(path.join(root, "app/(operator)", href, "page.tsx"), "utf8");
    expect(page).toMatch(new RegExp(`advancedEditorTitle\\(["']${id}["']\\)`));
    expect(page).toMatch(new RegExp(`modelsAdvancedEditor\\(["']${id}["']\\)`));
    expect(page).toMatch(/<h1[^>]*>\{EDITOR\.label\}<\/h1>/);
    expect(page).toContain("<AdvancedEditorLinks");
    expect(page).not.toMatch(/← 단계별 모델|모델 운영 현황|엔진 공유 한도/);
  });
  it("뒤로 가기 줄은 「← 고급 설정」과 옆 편집기 이름을 쓴다", async () => {
    const { AdvancedEditorLinks } = await import("@/app/(operator)/admin/models/advanced/AdvancedEditorLinks");
    const html = renderToStaticMarkup(<AdvancedEditorLinks next={["limits", "helpers"]} />);
    expect(html).toContain('href="/admin/models/advanced">← 고급 설정</a>');
    expect(html).toContain('href="/admin/models/limits">실시간 한도 →</a>');
    expect(html).toContain('href="/admin/models/helpers">도우미·감시자 →</a>');
  });
});
