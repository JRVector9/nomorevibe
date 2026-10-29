import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { translateReasons } from "@/lib/crawl/jobs/translate-reasons";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { classifyStage } from "@/lib/operations/worker-progress";

const mocks = vi.hoisted(() => ({ untried: vi.fn(), retry: vi.fn(), record: vi.fn(), capacity: vi.fn() }));
vi.mock("@/lib/crawl/translations", () => ({
  untriedTranslations: mocks.untried, retryableTranslations: mocks.retry, recordWorkerTranslations: mocks.record,
}));
vi.mock("@/lib/crawl/translate", () => ({ TRANSLATE_MODEL: "[M1] gemma", translateToKorean: vi.fn() }));
vi.mock("@/lib/crawl/reason-translation-model-capacity", () => ({ translateReasonsWithModelCapacity: mocks.capacity }));

const context = () => ({ cursor: null, hasBudget: () => true, save: vi.fn(), log: vi.fn(),
  lease: { name: "reason-translate", token: "t", requestedVersion: 1 } });
const item = (hash: string) => ({ hash, body: `English reason ${hash}`, attempts: 0 });
const original = process.env.ABCLLM_API_KEY;
beforeEach(() => {
  vi.resetAllMocks(); process.env.ABCLLM_API_KEY = "test-key";
  mocks.untried.mockResolvedValue([]); mocks.retry.mockResolvedValue([]); mocks.record.mockResolvedValue(1);
});
afterEach(() => { if (original === undefined) delete process.env.ABCLLM_API_KEY; else process.env.ABCLLM_API_KEY = original; });

it("logs the exact capacity deferral reason, writes nothing and defers the tick", async () => {
  mocks.untried.mockResolvedValue([item("a")]);
  const deferred = new ModelCapacityDeferredError("dispatched");
  mocks.capacity.mockRejectedValue(deferred);
  const ctx = context();
  await expect(translateReasons(ctx)).rejects.toBe(deferred);
  expect(ctx.log).toHaveBeenCalledWith("translate.capacity_deferred", { translated: 0, failed: 0, reason: "dispatched" });
  expect(mocks.record).not.toHaveBeenCalled();
});

it("stores a reserved native batch and keeps translating within the tick", async () => {
  mocks.untried.mockResolvedValueOnce([item("a")]).mockResolvedValue([]);
  mocks.capacity.mockResolvedValueOnce({ kind: "ready", batch: [item("a")], unknown: false,
    result: { ok: true, translations: ["번역된 사유"] }, expectation: { kind: "reason_translation_write" } });
  const ctx = context();
  await expect(translateReasons(ctx)).resolves.toEqual({ done: true });
  expect(mocks.record).toHaveBeenCalledWith([{ hash: "a", translated: "번역된 사유", error: undefined }], "[M1] gemma",
    expect.anything(), { kind: "reason_translation_write" });
  expect(ctx.log).toHaveBeenCalledWith("translate.done", { translated: 1, failed: 0, drained: true });
});

it("keeps the alarm rule unchanged: aged demand without progress alarms, and any completion in five minutes clears it", () => {
  const now = new Date();
  const stalled = { key: "reason-translate" as const, enabled: true, waiting: 10_964, oldestMinutes: 600, completed5m: 0,
    progress5m: 0, errors5m: 0, deferred: 0, manualAttention: 0, providerErrors: 0, providerErrorMinutes: null };
  expect(classifyStage(stalled, null, true, now)).toMatchObject({ reason: "no_progress", alarm: true, restartEligible: false });
  expect(classifyStage({ ...stalled, completed5m: 1, progress5m: 1 }, null, true, now)).toMatchObject({ reason: "progressing", alarm: false });
});
