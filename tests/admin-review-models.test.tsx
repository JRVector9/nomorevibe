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
});

describe("관리자 단계별 검수 모델", () => {
  it("모델만 CAS 저장하며 단계 활성화·사람 위임·용량 값은 보내지 않는다", async () => {
    expect(await saveReviewModels(null, submitted())).toEqual({ ok: true, version: "new-version" });
    expect(saveSettings).toHaveBeenCalledWith({
      firstReview: { provider: "abcllm", model: "[supa] Qwen3.8-27B-NVFP4" }, firstReviewAdditional: [],
      secondReview: { voters: [{ provider: "local-direct", model: "qwen3.8-flash-next" }], fallbacks: [] },
    }, "jr", { expectedFormVersion: "old-version" });
  });
  it("현재 추가 1차 모델을 모두 그려 저장 누락으로 숨기지 않는다", async () => {
    const settings = { ...DEFAULT_CRAWL_SETTINGS, firstReview: { provider: "abcllm" as const, model: "[MLX] gpt-oss-120b" },
      firstReviewAdditional: [{ provider: "abcllm" as const, model: "[supa] Qwen3.8-27B-NVFP4" }] };
    const html = renderToStaticMarkup(createElement(ReviewModelsForm, { settings, version: "v1", firstChoices: reviewModelOptions(null, false), secondChoices: reviewModelOptions(null, true) }));
    expect(html).toContain('name="firstAdditionalModel0"');
    expect(html).toContain('value="[supa] Qwen3.8-27B-NVFP4"');
    expect(html).toContain("GPU3090 · Qwen · 직접 연결");
    const form = submitted(); form.set("firstAdditionalProvider0", "claude-cli"); form.set("firstAdditionalModel0", "opus");
    await saveReviewModels(null, form);
    expect(saveSettings.mock.calls[0][0].firstReviewAdditional).toEqual([{ provider: "claude-cli", model: "opus" }]);
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
  it("직접 AI2 모델은 1차 목록에 제시하지 않고 동적 모델은 중복 제거한다", () => {
    expect(reviewModelOptions(null, false).some(row => row.provider === "local-direct")).toBe(false);
    expect(reviewModelOptions(["[supa] Qwen3.8-27B-NVFP4", "custom"], true).filter(row => row.model === "[supa] Qwen3.8-27B-NVFP4")).toHaveLength(1);
  });
});
