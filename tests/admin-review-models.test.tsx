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
const { DEFAULT_CRAWL_SETTINGS } = await import("@/lib/crawl/settings-schema");

/** 옛 화면이 보내던 1차·2차 칸 + (있으면) 단계 풀 */
function submitted(pools: Record<string, string[]> | null = {}): FormData {
  const form = new FormData();
  form.set("settingsVersion", "old-version");
  form.set("primaryProvider0", "abcllm");
  form.set("primaryModel0", "[supa] Qwen3.8-27B-NVFP4");
  form.set("firstAdditionalProvider0", "claude-cli");
  form.set("firstAdditionalModel0", "opus");
  form.set("voterProvider0", "local-direct");
  form.set("voterModel0", "qwen3.8-flash-next");
  if (pools) form.set("stageModelPools", JSON.stringify(pools));
  return form;
}

beforeEach(() => {
  currentAdmin.mockResolvedValue({ login: "jr" });
  saveSettings.mockReset().mockResolvedValue({ ok: true, settings: DEFAULT_CRAWL_SETTINGS });
  readiness.mockReset().mockResolvedValue({ contracts: [], capacity: { mode: "disabled", routes: [], devices: new Map(), groupLimits: {} } });
});

// PR C1: 1차 AI 검수 순위 칸·2차 투표·대체 칩은 이 화면에서 없앴다 — 실행 쪽은 「작업 ↔ 모델」 순위만 읽는다
describe("관리자 단계별 검수 모델 — 1차·2차는 「작업 ↔ 모델」로 옮겨졌다", () => {
  it("옛 설정에 1차·2차 값이 있어도 순위 칸·칩을 그리지 않고 「작업 ↔ 모델」 안내를 둔다", () => {
    const settings = { ...DEFAULT_CRAWL_SETTINGS, firstReview: { provider: "abcllm" as const, model: "[MLX] gpt-oss-120b" },
      firstReviewAdditional: [{ provider: "abcllm" as const, model: "[supa] Qwen3.8-27B-NVFP4" }],
      secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview, voters: [{ provider: "claude-cli" as const, model: "opus" }],
        fallbacks: [{ provider: "local-direct" as const, model: "qwen" }] } };
    const html = renderToStaticMarkup(createElement(ReviewModelsForm, { settings, version: "v1" }));
    expect(html).toContain('data-task-ranks-pointer="true"');
    expect(html).toContain('href="/admin/models/tasks#tasks"');
    for (const rank of ["1순위", "2순위", "3순위"]) expect(html).not.toContain(`aria-label="1차 AI 검수 ${rank}"`);
    for (const name of ["primaryModel0", "firstAdditionalModel0", "voterModel0", "fallbackModel0"]) expect(html, name).not.toContain(`name="${name}"`);
    expect(html).not.toContain("[MLX] gpt-oss-120b");
  });
  it("옛 화면이 1차·2차 칸을 보내도 단계 풀만 CAS 저장하고, 순위 준비 확인도 부르지 않는다", async () => {
    expect(await saveReviewModels(null, submitted())).toEqual({ ok: true, version: "new-version" });
    expect(saveSettings).toHaveBeenCalledWith({ stageModelPools: {} }, "jr", { expectedFormVersion: "old-version" });
    expect(readiness).not.toHaveBeenCalled();
  });
  it("단계 풀 칸 없이 1차·2차 칸만 오면 저장하지 않고 「작업 ↔ 모델」로 안내한다", async () => {
    expect(await saveReviewModels(null, submitted(null))).toEqual({ issues: [expect.stringContaining("작업 ↔ 모델(/admin/models/tasks)에서 바꿉니다")] });
    expect(saveSettings).not.toHaveBeenCalled();
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
});
