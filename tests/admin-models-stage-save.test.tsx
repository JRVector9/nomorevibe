import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ admin: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ currentAdmin: mocks.admin }));
vi.mock("@/lib/crawl/settings", () => ({ saveSettings: mocks.save, settingsFormVersion: () => "v2" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/operations/dr/web-gate", () => ({ runWebWrite: (fn: () => unknown) => fn(), webWriteAction: (fn: unknown) => fn }));
import { saveAdminStageModels } from "@/app/(operator)/admin/models/stage-model-actions";
import { StageModelPoolsForm } from "@/app/(operator)/admin/models/StageModelPoolsForm";
import { ADMIN_MODEL_STAGES } from "@/lib/llm/admin-model-stages";
import { readModelRegistry } from "@/lib/llm/model-registry";
beforeEach(() => { mocks.admin.mockReset().mockResolvedValue({ login: "operator" }); mocks.save.mockReset().mockResolvedValue({ ok: true, settings: {} }); });
const form = (pools: unknown) => { const data = new FormData(); data.set("settingsVersion", "v1"); data.set("stageModelPools", JSON.stringify(pools)); return data; };
it("단계별 여러 모델 선택을 기존 감사·CAS 설정 경로로만 저장한다", async () => {
  const pools = { "product-translate": ["m1:translation", "mlx:text"], "reason-translate": ["supa:review"] };
  expect(await saveAdminStageModels(null, form(pools))).toEqual({ ok: true, version: "v2" });
  expect(mocks.save).toHaveBeenCalledWith({ stageModelPools: pools }, "operator", { expectedFormVersion: "v1" });
});
it("stale 폼 거절을 성공으로 바꾸지 않는다", async () => {
  mocks.save.mockResolvedValue({ ok: false, issues: ["그 사이 다른 곳에서 설정이 바뀌었습니다"] });
  expect(await saveAdminStageModels(null, form({}))).toEqual({ issues: ["그 사이 다른 곳에서 설정이 바뀌었습니다"] });
});
it("비관리자와 어댑터가 다른 선택은 설정 저장에 도달하지 않는다", async () => {
  expect(await saveAdminStageModels(null, form({ "product-translate": ["connect:sonnet"] }))).toHaveProperty("issues");
  mocks.admin.mockResolvedValue(null);
  expect(await saveAdminStageModels(null, form({}))).toHaveProperty("issues");
  expect(mocks.save).not.toHaveBeenCalled();
});
it("모든 지원 단계와 선택된 M1 장비 키·삭제 버튼을 표시한다", () => {
  const html = renderToStaticMarkup(createElement(StageModelPoolsForm, { pools: { "product-translate": ["m1:translation"] }, models: readModelRegistry().models, defaults: {}, version: "v1" }));
  for (const stage of ADMIN_MODEL_STAGES) expect(html).toContain(stage.label);
  expect(html).toContain("m1:translation"); expect(html).toContain("번째 모델 빼기"); expect(html).toContain("단계별 모델 저장");
});
