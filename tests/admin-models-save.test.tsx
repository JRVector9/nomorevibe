import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const { currentAdmin, saveSettings } = vi.hoisted(() => ({ currentAdmin: vi.fn(), saveSettings: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin }));
vi.mock("@/lib/crawl/settings", () => ({ saveSettings, settingsFormVersion: () => "v2" }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ webWriteAction: (fn: unknown) => fn }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { saveReviewModels } from "@/app/(operator)/admin/models/actions";
import { ReviewModelsForm, ModelSaveNotice } from "@/app/(operator)/admin/models/ReviewModelsForm";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { DEFAULT_MODEL_DEFINITIONS } from "@/lib/llm/model-registry";

/** 단계 풀 칸이 있는 폼(이 화면이 저장하는 것은 단계 풀뿐이다 — PR C1) */
const poolForm = (pools: Record<string, string[]> = {}, extra: Record<string, string> = {}) => {
  const form = new FormData(); form.set("settingsVersion", "v1"); form.set("stageModelPools", JSON.stringify(pools));
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return form;
};

beforeEach(() => {
  currentAdmin.mockReset().mockResolvedValue({ login: "operator" });
  saveSettings.mockReset().mockResolvedValue({ ok: true, settings: DEFAULT_CRAWL_SETTINGS });
});
it("파란 주 저장 버튼과 추가·제거 후 저장 안내를 노출한다 — 단계 풀이 있을 때만; 1차·2차는 「작업 ↔ 모델」 안내", () => {
  const html = renderToStaticMarkup(createElement(ReviewModelsForm, { settings: DEFAULT_CRAWL_SETTINGS, version: "v1", models: DEFAULT_MODEL_DEFINITIONS }));
  expect(html).toMatch(/type="submit"[^>]*bg-accent-solid[^>]*>모델 설정 저장/);
  expect(html).toContain("모델을 추가·제거한 뒤 저장해야 적용됩니다");
  expect(html).toContain('data-task-ranks-pointer="true"');
  // 단계 풀이 없으면 저장할 칸이 없다 — 예전 「검수 모델 저장」 바도 없다
  const bare = renderToStaticMarkup(createElement(ReviewModelsForm, { settings: DEFAULT_CRAWL_SETTINGS, version: "v1" }));
  expect(bare).not.toContain('type="submit"');
  expect(bare).not.toContain("검수 모델 저장");
  expect(bare).toContain('data-task-ranks-pointer="true"');
});
it("정식 감사 저장 경로에 사용자와 CAS 버전을 넘긴다 — 단계 풀만", async () => {
  expect(await saveReviewModels(null, poolForm())).toEqual({ ok: true, version: "v2" });
  expect(saveSettings).toHaveBeenCalledWith({ stageModelPools: {} }, "operator", { expectedFormVersion: "v1" });
});
it("충돌 거절을 성공과 구별해 표시한다", async () => {
  const issues = ["그 사이 다른 곳에서 설정이 바뀌었습니다. 새로고침해주세요."];
  saveSettings.mockResolvedValue({ ok: false, issues });
  const result = await saveReviewModels(null, poolForm());
  expect(result).toEqual({ issues });
  const html = renderToStaticMarkup(createElement(ModelSaveNotice, { state: result }));
  expect(html).toContain('role="alert"');
  expect(html).toContain("저장 거절");
  expect(html).not.toContain('role="status"');
});
it("저장 성공과 일반 거절을 각각 표시한다", () => {
  expect(renderToStaticMarkup(createElement(ModelSaveNotice, { state: { ok: true } }))).toContain("모델 설정을 저장했습니다");
  expect(renderToStaticMarkup(createElement(ModelSaveNotice, { state: { issues: ["모델 계약 미확인"] } }))).toContain("저장하지 못했습니다");
});
it("비관리자는 설정 저장에 도달하지 않는다", async () => {
  currentAdmin.mockResolvedValue(null);
  expect(await saveReviewModels(null, poolForm())).toMatchObject({ issues: [expect.stringContaining("권한")] });
  expect(saveSettings).not.toHaveBeenCalled();
});
it("단계 풀 칸이 없는 폼(옛 1차·2차 칸만)은 저장하지 않고 「작업 ↔ 모델」로 안내한다(PR C1)", async () => {
  const form = new FormData(); form.set("settingsVersion", "v1");
  form.set("primaryModel0", "[MLX] gpt-oss-120b"); form.set("voterModel0", "opus");
  expect(await saveReviewModels(null, form)).toEqual({ issues: [expect.stringContaining("작업 ↔ 모델(/admin/models/tasks)")] });
  expect(saveSettings).not.toHaveBeenCalled();
});
it("다른 단계의 칩 변경은 한 번의 기존 CAS·감사 저장으로 보내고, 옛 화면이 보낸 1차·2차 칸은 저장하지 않는다(PR C1)", async () => {
  const form = poolForm({ "product-translate": ["m1:translation"] }, { primaryProvider0: "abcllm", primaryModel0: "[supa] Qwen3.8-27B-NVFP4",
    firstAdditionalModel0: "[MLX] gpt-oss-120b", voterProvider0: "claude-cli", voterModel0: "opus", fallbackModel0: "qwen" });
  expect(await saveReviewModels(null, form)).toEqual({ ok: true, version: "v2" });
  expect(saveSettings).toHaveBeenCalledTimes(1);
  expect(saveSettings).toHaveBeenCalledWith({ stageModelPools: { "product-translate": ["m1:translation"] } }, "operator", { expectedFormVersion: "v1" });
  const patch = saveSettings.mock.calls[0][0] as Record<string, unknown>;
  for (const key of ["firstReview", "firstReviewAdditional", "secondReview"]) expect(patch, key).not.toHaveProperty(key);
});
it("등록되지 않은 단계 모델이 섞이면 부분 저장하지 않는다", async () => {
  expect(await saveReviewModels(null, poolForm({ "product-translate": ["none:missing"] }))).toHaveProperty("issues"); expect(saveSettings).not.toHaveBeenCalled();
});
