import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(operator)/admin/models/operation-actions", () => ({ probeAdminModel: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/ops-runner-actions", () => ({ submitAdminModelOperation: vi.fn(), readAdminModelOperation: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/actions", () => ({ saveReviewModels: vi.fn() }));
vi.mock("@/app/(operator)/admin/models/stage-model-actions", () => ({ saveAdminStageModels: vi.fn() }));
import { LiveModels, StageStatusRibbon, ThroughputMetrics } from "@/app/(operator)/admin/models/LiveModels";
import { ModelSaveBar } from "@/app/(operator)/admin/models/ModelChips";
import { ReviewModelsForm } from "@/app/(operator)/admin/models/ReviewModelsForm";
import { buildModelCards, MODEL_DASHBOARD_STAGES, stageHealth } from "@/lib/operations/admin-models-view";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { redesignObservation, redesignModels, redesignAssignments, redesignMetrics, redesignRequests } from "./fixtures/admin-models-redesign";
const render = () => renderToStaticMarkup(createElement(LiveModels, { observation: redesignObservation(), models: redesignModels, assignments: redesignAssignments }));
describe("admin models 리디자인 렌더", () => {
  it.each(["정상", "느림", "멈춤", "미확인", "접수 중지"] as const)("상태 띠가 %s 판정을 배지로 그린다", expected => {
    const observation = redesignObservation(); const row = { ...redesignMetrics[0], indeterminate: 0, succeeded1h: 1 };
    let requests = [] as typeof redesignRequests;
    if (expected === "느림") { row.waiting = 1; requests = [{ ...redesignRequests[0], state: "waiting" }]; }
    if (expected === "멈춤") row.indeterminate = 1;
    if (expected === "미확인") { row.indeterminate = 1; observation.groups[0].limit = 2; }
    if (expected === "접수 중지") observation.mode = "draining";
    observation.rows = [row]; observation.requests = requests;
    expect(stageHealth(observation, [row], requests)).toBe(expected);
    const html = renderToStaticMarkup(createElement(StageStatusRibbon, { observation, cards: buildModelCards(observation, redesignModels) }));
    const first = html.match(/<a .*?<\/a>/)?.[0]; expect(first).toContain(`>${expected}${expected === "미확인" ? " 1건" : ""}</span>`);
  });
  it("지원하는 모든 단계·마지막 성공·미확인 건수를 빠짐없이 표시한다", () => {
    const html = render(); for (const stage of MODEL_DASHBOARD_STAGES) expect(html).toContain(stage.label);
    expect(html).toContain("미확인 1건"); expect(html).toContain("마지막 성공 2분 전");
    expect(html).toContain("모델 카드로 이동"); expect(html).toContain("30초 자동 새로고침");
  });
  it("건강한 병렬 모델이 있으면 해당 단계 전체를 멈춤으로 단정하지 않는다", () => {
    const observation = redesignObservation();
    expect(stageHealth(observation, observation.rows.slice(0, 2), observation.requests.slice(0, 1))).toBe("미확인");
  });
  it("미확인 블록에 시작·경과·막힌 단계와 M1 sudo/Supa root 비활성 사유가 있다", () => {
    const html = render();
    for (const value of ["요청 시작 2026-10-29 06:40:00 UTC", "20분째", "막고 있는 단계", "M1 sudo 필요", "Supa root 필요"]) expect(html).toContain(value);
    expect(html.match(/<button[^>]*disabled=""[^>]*>종료\(정식 해제\)<\/button>/g)).toHaveLength(2);
    expect(html.match(/<button[^>]*disabled=""[^>]*>모델 재시작<\/button>/g)).toHaveLength(2);
    expect(html).toContain("접수 중지/재개는 모든 공통 모델에 적용됩니다");
  });
  it("내부 ID는 기본 접힌 자세히 안에만 있고 모델은 장비·이름으로 표시한다", () => {
    const html = render(); const visible = html.replace(/<details[\s\S]*?<\/details>/g, "");
    for (const value of ["routeId", "groupId", "providerBudgetId", "requestId", redesignRequests[0].requestId]) {
      expect(html).toContain(value); expect(visible).not.toContain(value);
    }
    expect(html).not.toMatch(/<details[^>]*\sopen/); expect(visible).toContain("[supa]"); expect(visible).toContain("gpt-oss-120b");
  });
  it("종료 표본이 없으면 기록 없음이며 시간당 0건·실패율 0%로 꾸미지 않는다", () => {
    const html = renderToStaticMarkup(createElement(ThroughputMetrics, {}));
    expect(html).toContain("기록 없음"); expect(html).not.toContain("0.0%"); expect(html).not.toContain("0초");
  });
  it.each([{ changes: [], pending: false, disabled: true }, { changes: ["1차 검수"], pending: false, disabled: false }, { changes: ["1차 검수"], pending: true, disabled: true }])("저장 활성 조건 $changes / pending $pending", ({ changes, pending, disabled }) => {
    const html = renderToStaticMarkup(createElement(ModelSaveBar, { changes, pending }));
    expect(/<button[^>]*disabled=""/.test(html)).toBe(disabled); if (changes.length) expect(html).toContain("1차 검수");
  });
  it("운영과 같은 Supa 주 모델 + 추가 MLX 값을 그대로 칩과 hidden input으로 보존한다", () => {
    const settings = { ...DEFAULT_CRAWL_SETTINGS, firstReview: { provider: "abcllm" as const, model: "[supa] Qwen3.8-27B-NVFP4" }, firstReviewAdditional: [{ provider: "abcllm" as const, model: "[MLX] gpt-oss-120b" }] };
    const html = renderToStaticMarkup(createElement(ReviewModelsForm, { settings, version: "fixture-cas", firstChoices: [], secondChoices: [], models: redesignModels }));
    expect(html).toContain('name="primaryModel0" value="[supa] Qwen3.8-27B-NVFP4"');
    expect(html).toContain('name="firstAdditionalModel0" value="[MLX] gpt-oss-120b"');
    expect(html).toContain("설정 바꾸기"); expect(html).toContain("저장된 설정과 같습니다");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>모델 설정 저장<\/button>/);
  });
});
