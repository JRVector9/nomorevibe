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

beforeEach(() => {
  currentAdmin.mockReset().mockResolvedValue({ login: "operator" });
  saveSettings.mockReset().mockResolvedValue({ ok: true, settings: DEFAULT_CRAWL_SETTINGS });
});
it("파란 주 저장 버튼과 추가·제거 후 저장 안내를 노출한다", () => {
  const html = renderToStaticMarkup(createElement(ReviewModelsForm, { settings: DEFAULT_CRAWL_SETTINGS, version: "v1", firstChoices: [], secondChoices: [] }));
  expect(html).toMatch(/type="submit"[^>]*bg-accent-solid[^>]*>검수 모델 저장/);
  expect(html).toContain("모델을 추가·제거한 뒤 저장해야 적용됩니다");
});
it("정식 감사 저장 경로에 사용자와 CAS 버전을 넘긴다", async () => {
  const form = new FormData(); form.set("settingsVersion", "v1");
  form.set("primaryModel0", "[MLX] gpt-oss-120b");
  expect(await saveReviewModels(null, form)).toEqual({ ok: true, version: "v2" });
  expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ firstReview: { provider: "abcllm", model: "[MLX] gpt-oss-120b" } }), "operator", { expectedFormVersion: "v1" });
});
it("충돌 거절을 성공과 구별해 표시한다", async () => {
  const issues = ["그 사이 다른 곳에서 설정이 바뀌었습니다. 새로고침해주세요."];
  saveSettings.mockResolvedValue({ ok: false, issues });
  const result = await saveReviewModels(null, new FormData());
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
  expect(await saveReviewModels(null, new FormData())).toMatchObject({ issues: [expect.stringContaining("권한")] });
  expect(saveSettings).not.toHaveBeenCalled();
});
