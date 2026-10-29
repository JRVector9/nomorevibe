import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ admin: vi.fn(), settings: vi.fn(), save: vi.fn(), ready: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: mocks.settings, setHumanReviewEnabled: mocks.save }));
vi.mock("@/lib/crawl/deepseek-review", () => ({ deepseekReviewReady: mocks.ready }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { configuredHumanModelsReady, humanReviewModelDisplay } from "@/lib/operations/admin-models-human";
import { DEFAULT_MODEL_DEFINITIONS, scopedModel } from "@/lib/llm/model-registry";
import { setHumanReview } from "@/app/(operator)/admin/review/human-review-actions";
import { HumanReviewSwitch } from "@/app/(operator)/admin/review/HumanReviewSwitch";
const form = (enabled = "true") => { const data = new FormData(); data.set("enabled", enabled); data.set("generation", "3"); return data; };
beforeEach(() => {
  vi.resetAllMocks(); mocks.admin.mockResolvedValue({ login: "operator" }); mocks.save.mockResolvedValue({ ok: true });
  mocks.settings.mockResolvedValue({ stageModelPools: { "human-review": ["gpu3090:review", "m3:review"] } });
  mocks.ready.mockResolvedValue(true);
});
it("사람 위임 풀의 Qwen·DeepSeek를 각각 실제 선택 범위에서 확인한다", async () => {
  const seen: string[] = [];
  mocks.ready.mockImplementation(async () => { seen.push(scopedModel("human-review", "default")); return true; });
  expect(await configuredHumanModelsReady(["gpu3090:review", "m3:review"])).toBe(true);
  expect(seen).toEqual(["qwen3.8-flash-next", "deepseek-v4.1-flash-1017"]);
});
it("풀 일부가 미확인이면 켜지 않고, 확인한 풀을 정식 저장 CAS에 고정한다", async () => {
  mocks.ready.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await setHumanReview(null, form())).toHaveProperty("error"); expect(mocks.save).not.toHaveBeenCalled();
  mocks.ready.mockResolvedValue(true);
  expect(await setHumanReview(null, form())).toHaveProperty("message");
  expect(mocks.save).toHaveBeenCalledWith({ enabled: true, expectedGeneration: 3, actor: "operator", expectedModelPoolKeys: ["gpu3090:review", "m3:review"] });
});
it("끄기는 연결 확인 없이 기존 정식 경로를 사용하고 비관리자는 거절한다", async () => {
  expect(await setHumanReview(null, form("false"))).toHaveProperty("message"); expect(mocks.ready).not.toHaveBeenCalled();
  mocks.admin.mockResolvedValue(null); mocks.save.mockClear();
  expect(await setHumanReview(null, form())).toHaveProperty("error"); expect(mocks.save).not.toHaveBeenCalled();
});
it("선택 모델을 M3 DeepSeek로 잘못 표시하지 않는다", () => {
  const html = renderToStaticMarkup(createElement(HumanReviewSwitch, { enabled: true, generation: 3, ready: true, modelLabel: "선택 모델", modelLocation: "사람 위임 검수 풀" }));
  expect(html).toContain("선택 모델"); expect(html).not.toContain("M3 Ultra"); expect(html).not.toContain("DeepSeek v4.1");
});
it("사람 검토 모델 표시는 저장한 풀, 없으면 레지스트리의 human-review 모델에서 읽는다", () => {
  expect(humanReviewModelDisplay(["gpu3090:review", "m3:review"])).toEqual({ modelLabel: "선택 모델",
    modelLocation: "사람 위임 검수 풀 · GPU3090 · Qwen · 직접 연결, M3 · DeepSeek" });
  expect(humanReviewModelDisplay([])).toEqual({ modelLabel: "M3 · DeepSeek", modelLocation: "m3:review · deepseek-v4.1-flash-1017" });
  const previous = process.env.MODEL_REGISTRY_CONFIG;
  process.env.MODEL_REGISTRY_CONFIG = JSON.stringify({ version: 1, models: DEFAULT_MODEL_DEFINITIONS.map(model => model.key === "m3:review"
    ? { ...model, purposes: ["assist-audit"] } : model.key === "gpu3090:review" ? { ...model, purposes: [...model.purposes, "human-review"] } : model) });
  try {
    expect(humanReviewModelDisplay()).toEqual({ modelLabel: "GPU3090 · Qwen · 직접 연결", modelLocation: "gpu3090:review · qwen3.8-flash-next" });
  } finally {
    if (previous === undefined) delete process.env.MODEL_REGISTRY_CONFIG; else process.env.MODEL_REGISTRY_CONFIG = previous;
  }
});
