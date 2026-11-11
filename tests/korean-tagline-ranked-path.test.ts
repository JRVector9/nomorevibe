import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";
const m = vi.hoisted(() => ({ control: vi.fn(), pending: vi.fn(), write: vi.fn(), gpt: vi.fn() }));
vi.mock("@/lib/domain/products/korean-taglines", () => ({ homeListSlugs: async () => [], pendingKoreanTaglines: m.pending,
  recordKoreanTaglines: m.write, koreanTaglineSource: (task: { tagline: string }) => task.tagline }));
vi.mock("@/lib/domain/products/korean-tagline-model-capacity", () => ({ translateKoreanTaglinesWithModelCapacity: m.gpt }));
vi.mock("@/lib/llm/capacity-repository", () => ({ readModelCapacityCallerControl: m.control }));
import { writeKoreanTaglines } from "@/lib/jobs/products/korean-tagline";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { TEXT_RANK_UNUSABLE_TEXT } from "@/lib/llm/ai-task-resolver";
import { pinTextRanks, textContract } from "./text-task-ranks-fixture";
/**
 * 한국어 소개 번역은 「작업 ↔ 모델」 product-tagline-ko 순위만 부른다(2026-11-11: 장부 밖 Qwen 직접 경로 korean-translation-direct 와 그 회복 선택을 없앴다).
 * 순위 하나와 그 연결을 가리키는 엔진 직접 계약 하나를 고정한다. 옛 env(KOREAN_TRANSLATION_QWEN_ENABLED·_RECOVERY_ENABLED)를 켜 두어도 동작이 같아야 한다.
 */
const GPT_MODEL = "gpt-oss-120b";
const gptDirectRow = textContract("product-tagline-ko", GPT_MODEL);
const task = (id: number, attempts = 0) => ({ productId: id, name: "Tool", tagline: "Track tasks for your team", repoUrl: null, attempts });
const outputs = (n: number) => ({ ok: true as const, outputs: Array.from({ length: n }, () => "팀의 할 일을 기록하는 도구") });
const ctx = (signal?: AbortSignal) => ({ lease: { name: "product-tagline-ko", token: "lease", requestedVersion: 1 },
  hasBudget: () => true, log: vi.fn(), signal }) as unknown as JobContext<null>;
beforeEach(() => {
  vi.clearAllMocks(); setServingContractSnapshotForTest([gptDirectRow]); pinTextRanks({ "product-tagline-ko": GPT_MODEL });
  // 없앤 경로의 옛 스위치 — 켜져 있어도 읽지 않는다
  vi.stubEnv("KOREAN_TRANSLATION_QWEN_ENABLED", "true"); vi.stubEnv("KOREAN_TRANSLATION_QWEN_RECOVERY_ENABLED", "true");
  m.control.mockResolvedValue({ mode: "disabled" }); m.pending.mockResolvedValue([]);
  m.write.mockImplementation(async entries => entries.length);
  m.gpt.mockImplementation(async batch => ({ kind: "result", result: outputs(batch.length) }));
});
afterEach(() => { setServingContractSnapshotForTest(null); pinTextRanks(null); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it("용량을 끈(disabled) 틱도 순위의 모델 한 묶음만 부르고, 남은 제품을 다른 모델로 나누지 않는다", async () => {
  m.pending.mockResolvedValueOnce(Array.from({ length: 16 }, (_, i) => task(i + 1)));
  await writeKoreanTaglines(ctx());
  expect(m.gpt).toHaveBeenCalledOnce(); expect(m.gpt.mock.calls[0][0]).toHaveLength(8);
  const writes = m.write.mock.calls.flatMap(([entries]) => entries);
  expect(writes).toHaveLength(8);
  expect(new Set(writes.map(e => e.result.model))).toEqual(new Set([GPT_MODEL]));
});
it("preserves the native single-backend 1200-character pack in open mode", async () => {
  m.control.mockResolvedValue({ mode: "open" });
  m.pending.mockResolvedValueOnce(Array.from({ length: 8 }, (_, i) => ({ ...task(i + 1), tagline: "x".repeat(300) })));
  await writeKoreanTaglines(ctx()); expect(m.gpt.mock.calls[0][0]).toHaveLength(4);
});
it("does not write the response after lease/budget abort", async () => {
  const controller = new AbortController(); m.pending.mockResolvedValueOnce(Array.from({ length: 9 }, (_, i) => task(i + 1)));
  m.gpt.mockImplementationOnce(async batch => { controller.abort(); return { kind: "result", result: outputs(batch.length) }; });
  await writeKoreanTaglines(ctx(controller.signal)); expect(m.write).not.toHaveBeenCalled();
});
it("never dispatches an oversized first source or calls it a successful drained queue", async () => {
  m.pending.mockResolvedValueOnce([{ ...task(1), tagline: "x".repeat(3601) }]);
  expect(await writeKoreanTaglines(ctx())).toMatchObject({ degraded: { code: "input_too_large" } });
  expect(m.gpt).not.toHaveBeenCalled(); expect(m.write).not.toHaveBeenCalled();
});
it("순위의 연결 계약이 없으면 장부가 꺼져 있어도(disabled) 다른 길로 부르지 않고 all_ranks_unusable 로 멈춘다", async () => {
  setServingContractSnapshotForTest([]);
  m.pending.mockResolvedValue([task(1)]);
  for (const mode of ["disabled", "open"] as const) {
    m.control.mockResolvedValue({ mode });
    expect(await writeKoreanTaglines(ctx())).toMatchObject({ done: true, degraded: { code: "all_ranks_unusable",
      detail: expect.stringContaining(`1순위 test-engine · ${GPT_MODEL}: ${TEXT_RANK_UNUSABLE_TEXT.no_direct_contract}`) } });
  }
  expect(m.gpt).not.toHaveBeenCalled(); expect(m.write).not.toHaveBeenCalled();
});
it("counts a solo invalid_output as a quality rejection but leaves a batch invalid_output unattributed", async () => {
  m.control.mockResolvedValue({ mode: "open" });
  m.pending.mockResolvedValueOnce([task(1, 2)]).mockResolvedValueOnce([task(2), task(3)]).mockResolvedValue([]);
  m.gpt.mockResolvedValue({ kind: "result", result: { ok: false, error: "invalid_output" } });
  await writeKoreanTaglines(ctx()); await writeKoreanTaglines(ctx());
  const writes = m.write.mock.calls.flatMap(([entries]) => entries);
  expect(writes.map(e => [e.task.productId, e.result.error])).toEqual([[1, "rejected:invalid_output"], [2, "invalid_output"], [3, "invalid_output"]]);
});
