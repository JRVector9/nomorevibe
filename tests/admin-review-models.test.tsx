import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/operations/dr/epoch", async original => ({ ...await original<typeof import("@/lib/operations/dr/epoch")>(), readWriterFence: async () => ({ state: "active" }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const currentAdmin = vi.fn();
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: () => currentAdmin() }));
const saveSettings = vi.fn();
vi.mock("@/lib/crawl/settings", () => ({ saveSettings: (...args: unknown[]) => saveSettings(...args), settingsFormVersion: () => "new-version" }));

const readiness = vi.fn();
vi.mock("@/lib/operations/admin-first-review-ranks-read", () => ({ readRankReadinessInput: () => readiness() }));

const { saveReviewModels } = await import("@/app/(operator)/admin/models/actions");
const { ReviewModelsForm } = await import("@/app/(operator)/admin/models/ReviewModelsForm");
const { reviewModelOptions } = await import("@/app/(operator)/admin/models/model-options");
const { DEFAULT_CRAWL_SETTINGS } = await import("@/lib/crawl/settings-schema");

function submitted(): FormData {
  const form = new FormData();
  form.set("settingsVersion", "old-version");
  form.set("primaryProvider0", "abcllm");
  form.set("primaryModel0", "[supa] Qwen3.8-27B-NVFP4");
  form.set("voterProvider0", "local-direct");
  form.set("voterModel0", "qwen3.8-flash-next");
  return form;
}

beforeEach(() => {
  currentAdmin.mockResolvedValue({ login: "jr" });
  saveSettings.mockReset().mockResolvedValue({ ok: true, settings: DEFAULT_CRAWL_SETTINGS });
  // 저장한 순위가 모두 쓰일 수 있는 상태(연결 계약·용량 경로 있음)
  readiness.mockReset().mockResolvedValue({ contracts: [{ routeId: "crawl-agent-review", model: "[supa] Qwen3.8-27B-NVFP4", contract: {}, transport: "direct" }],
    capacity: { mode: "disabled", routes: [], devices: new Map(), groupLimits: {} } });
});

describe("관리자 단계별 검수 모델", () => {
  it("모델만 CAS 저장하며 단계 활성화·사람 위임·용량 값은 보내지 않는다", async () => {
    expect(await saveReviewModels(null, submitted())).toEqual({ ok: true, version: "new-version" });
    expect(saveSettings).toHaveBeenCalledWith({
      firstReview: { provider: "abcllm", model: "[supa] Qwen3.8-27B-NVFP4" }, firstReviewAdditional: [],
      secondReview: { voters: [{ provider: "local-direct", model: "qwen3.8-flash-next" }], fallbacks: [] },
    }, "jr", { expectedFormVersion: "old-version" });
  });
  it("현재 1차 순위(1순위·2순위)를 모두 그려 저장 누락으로 숨기지 않는다", async () => {
    const settings = { ...DEFAULT_CRAWL_SETTINGS, firstReview: { provider: "abcllm" as const, model: "[MLX] gpt-oss-120b" },
      firstReviewAdditional: [{ provider: "abcllm" as const, model: "[supa] Qwen3.8-27B-NVFP4" }] };
    const html = renderToStaticMarkup(createElement(ReviewModelsForm, { settings, version: "v1", firstChoices: reviewModelOptions(null, false), secondChoices: reviewModelOptions(null, true) }));
    expect(html).toContain('name="primaryModel0" value="[MLX] gpt-oss-120b"');
    expect(html).toContain('name="firstAdditionalModel0" value="[supa] Qwen3.8-27B-NVFP4"');
    expect(html).not.toContain('name="firstAdditionalModel1"');
    for (const rank of ["1순위", "2순위", "3순위"]) expect(html).toContain(`aria-label="1차 AI 검수 ${rank}"`);
    const form = submitted(); form.set("firstAdditionalProvider0", "claude-cli"); form.set("firstAdditionalModel0", "opus");
    await saveReviewModels(null, form);
    expect(saveSettings.mock.calls[0][0].firstReviewAdditional).toEqual([{ provider: "claude-cli", model: "opus" }]);
  });
  it("같은 모델을 두 순위에 두거나 앞 순위를 비운 순위는 저장하지 않고 한국어로 알린다", async () => {
    const duplicate = submitted(); duplicate.set("firstAdditionalProvider0", "abcllm"); duplicate.set("firstAdditionalModel0", "[supa] Qwen3.8-27B-NVFP4");
    expect(await saveReviewModels(null, duplicate)).toEqual({ issues: [expect.stringContaining("1순위와 2순위가 같은 모델입니다")] });
    const gap = submitted(); gap.set("firstAdditionalProvider1", "grok-cli"); gap.set("firstAdditionalModel1", "grok-4.7");
    expect(await saveReviewModels(null, gap)).toEqual({ issues: [expect.stringContaining("2순위를 비우고 그 뒤 순위만 고를 수 없습니다")] });
    expect(saveSettings).not.toHaveBeenCalled();
  });
  it("저장한 순위 중 아직 쓰일 수 없는 것(연결 계약·용량 경로 없음)을 저장 뒤 알린다", async () => {
    readiness.mockResolvedValue({ contracts: [], capacity: { mode: "open", routes: [], devices: new Map(), groupLimits: {} } });
    const form = submitted(); form.set("firstAdditionalProvider0", "grok-cli"); form.set("firstAdditionalModel0", "grok-4.7");
    const result = await saveReviewModels(null, form);
    expect(result).toMatchObject({ ok: true, version: "new-version" });
    expect(result?.warnings).toEqual([
      expect.stringContaining("1순위 abcllm · [supa] Qwen3.8-27B-NVFP4: 1차 AI 검수(crawl-agent-review) 연결 계약이 없습니다"),
      expect.stringContaining("1순위 abcllm · [supa] Qwen3.8-27B-NVFP4: 용량 정책에 crawl-agent-review / abcllm / [supa] Qwen3.8-27B-NVFP4 경로가 없습니다"),
      expect.stringContaining("2순위 grok-cli · grok-4.7: 용량 정책에 crawl-agent-review / grok-cli / grok-4.7 경로가 없습니다")]);
    expect(saveSettings.mock.calls[0][0]).toMatchObject({ firstReview: { provider: "abcllm", model: "[supa] Qwen3.8-27B-NVFP4" },
      firstReviewAdditional: [{ provider: "grok-cli", model: "grok-4.7" }] });
  });
  it("권한 없는 요청은 설정 저장에 도달하지 않는다", async () => {
    currentAdmin.mockResolvedValue(null);
    expect(await saveReviewModels(null, submitted())).toMatchObject({ issues: expect.any(Array) });
    expect(saveSettings).not.toHaveBeenCalled();
  });
  it("stale 또는 계약상 거절을 성공으로 표시하지 않는다", async () => {
    saveSettings.mockResolvedValue({ ok: false, issues: ["설정이 바뀌었습니다"] });
    expect(await saveReviewModels(null, submitted())).toEqual({ issues: ["설정이 바뀌었습니다"] });
  });
  it("선택지는 엔진 API가 돌려준 이름만 담고 등록부 모델명을 지어내지 않는다", () => {
    expect(reviewModelOptions(null, false).some(row => row.provider === "local-direct" || row.provider === "abcllm")).toBe(false);
    expect(reviewModelOptions(["served-by-api"], true).filter(row => row.model === "served-by-api"))
      .toEqual([{ provider: "local-direct", model: "served-by-api", label: "served-by-api" }]);
  });
});
