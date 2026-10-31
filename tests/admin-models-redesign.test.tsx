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
  // 2026-10-30 결정: 미확인은 점유가 아니므로 "멈춤" 판정은 없다 — 그룹 상한(limit 1)이어도 미확인 1건은 "미확인 1건"으로만 그린다.
  it.each(["정상", "느림", "미확인", "접수 중지"] as const)("상태 띠가 %s 판정을 배지로 그린다", expected => {
    const observation = redesignObservation(); const row = { ...redesignMetrics[0], indeterminate: 0, succeeded1h: 1 };
    let requests = [] as typeof redesignRequests;
    if (expected === "느림") { row.waiting = 1; requests = [{ ...redesignRequests[0], state: "waiting" }]; }
    if (expected === "미확인") row.indeterminate = 1;
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
  it("다른 단계의 미확인이 같은 그룹에 있으면 해당 단계에도 미확인과 건수를 표시한다(슬롯은 막지 않는다)", () => {
    // 2026-10-30 결정: 같은 장비(m1)의 미확인은 사람 검토 대상으로 보이기만 하고, 그 단계를 멈춤으로 만들지 않는다.
    const observation = redesignObservation();
    const row = { ...redesignMetrics[2], routeId: "reason-translate", indeterminate: 0, waiting: 0 };
    observation.rows.push(row);
    expect(stageHealth(observation, [row], [])).toBe("미확인");
    const html = renderToStaticMarkup(createElement(StageStatusRibbon, { observation, cards: buildModelCards(observation, redesignModels) }));
    const cell = html.match(/<a [\s\S]*?<\/a>/g)?.find(cell => cell.includes("심사 사유 번역"));
    expect(cell).toContain(">미확인 1건</span>"); expect(cell).not.toContain("멈춤");
    expect(cell).toContain("마지막 성공 기록 없음");
  });
  it("미설정 화면 판별을 가짜 모델 카드로 만들지 않는다", () => {
    const cards = buildModelCards(redesignObservation(), redesignModels, [{ id: "screen-review", label: "화면 판별", models: [{ provider: "local-direct", model: "미설정" }] }]);
    expect(cards.some(card => card.name === "미설정")).toBe(false);
  });
  it("건강한 병렬 모델이 있어도 그룹의 미확인은 해당 단계에 미확인으로만 표시한다", () => {
    const observation = redesignObservation();
    expect(stageHealth(observation, observation.rows.slice(0, 2), observation.requests.slice(0, 1))).toBe("미확인");
  });
  it("미확인 블록에 시작·경과·슬롯 점유 없음(사람 검토 대기)과 M1 sudo/Supa root 비활성 사유가 있다", () => {
    // 2026-10-30 결정: 미확인 요청은 단계를 막지 않으므로 "막고 있는 단계" 대신 "슬롯 점유 없음 · 사람 검토 대기"를 안내한다.
    const html = render();
    for (const value of ["요청 시작 2026-10-29 06:40:00 UTC", "20분째", "슬롯 점유 없음 · 사람 검토 대기", "확인 못함 2건 · 사람 검토", "M1 sudo 필요", "Supa root 필요"]) expect(html).toContain(value);
    expect(html).not.toContain("막고 있는 단계"); expect(html).not.toContain("멈춤"); expect(html).not.toContain("모델 슬롯 가득");
    expect(html.match(/<button[^>]*disabled=""[^>]*>종료\(정식 해제\)<\/button>/g)).toHaveLength(2);
    expect(html.match(/<button[^>]*disabled=""[^>]*>모델 재시작<\/button>/g)).toHaveLength(2);
    expect(html).toContain("접수 중지/재개는 모든 공통 모델에 적용됩니다");
  });
  it("내부 ID는 기본 접힌 자세히 안에만 있고 모델은 장비·이름으로 표시한다", () => {
    const html = render(); const visible = html.replace(/<details[\s\S]*?<\/details>/g, "");
    for (const value of ["routeId", "groupId", "providerBudgetId", "requestId", redesignRequests[0].requestId]) {
      expect(html).toContain(value); expect(visible).not.toContain(value);
    }
    expect(html).not.toMatch(/<details[^>]*\sopen/); expect(visible).toContain("[Supa]"); // 2026-10-31: 카드는 장비 값이 아니라 서버 이름(주소·장비·그룹 순)으로 보인다 expect(visible).toContain("gpt-oss-120b");
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

describe("모델 카드 서버 이름 — 장비 미확인 없이(2026-10-31)", () => {
  it("주소·장비·같은 이름 항목·장비 그룹·대괄호 라벨 순으로 서버 이름을 찾는다", async () => {
    const { modelServerName } = await import("@/lib/operations/admin-models-view");
    const models = [
      { key: "gpu3090:review", equipment: "gpu3090", provider: "local-direct", model: "qwen3.8-flash-next", baseUrl: "http://100.77.43.63:8090/v1" },
      { key: "mlx:text", equipment: "mlx", provider: "abcllm", model: "gpt-oss-120b", baseUrl: "http://100.92.77.66:8014/v1" },
      { key: "m1:translation", equipment: "m1", provider: "abcllm", model: "gemma", baseUrl: "https://m1-studio.tail02799e.ts.net/v1" },
    ] as never[];
    // 1차 검수 abcllm 계약: 등록부엔 local-direct 항목뿐 — 같은 모델 이름의 유일한 항목 주소로 gpu3090
    expect(modelServerName({ provider: "abcllm", model: "qwen3.8-flash-next" }, undefined, models, ["gpu3090-qwen"])).toBe("gpu3090");
    expect(modelServerName({ provider: "abcllm", model: "gpt-oss-120b" }, models[1], models, [])).toBe("M3 Ultra");
    expect(modelServerName({ provider: "abcllm", model: "gemma" }, models[2], models, [])).toBe("M1 Studio");
    // 등록부에서 사라진 옛 이름은 그 카드가 쓴 장비 그룹으로
    expect(modelServerName({ provider: "abcllm", model: "Inferact/Qwen3.8-27B-NVFP4" }, undefined, models, ["supa", "supa-direct"])).toBe("Supa");
    expect(modelServerName({ provider: "abcllm", model: "[MLX] gpt-oss-120b" }, undefined, models, [])).toBe("M3 Ultra");
    expect(modelServerName({ provider: "abcllm", model: "unknown-model" }, undefined, models, [])).toBe("장비 미확인");
  });
});
