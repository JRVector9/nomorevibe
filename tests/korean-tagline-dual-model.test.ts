import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";
const m = vi.hoisted(() => ({ control: vi.fn(), pending: vi.fn(), recovery: vi.fn(), write: vi.fn(), gpt: vi.fn(), qwen: vi.fn() }));
vi.mock("@/lib/domain/products/korean-taglines", () => ({ homeListSlugs: async () => [], pendingKoreanTaglines: m.pending,
  pendingKoreanTaglineRecovery: m.recovery, recordKoreanTaglines: m.write, koreanTaglineSource: (task: { tagline: string }) => task.tagline }));
vi.mock("@/lib/domain/products/korean-tagline-model-capacity", () => ({ translateKoreanTaglinesWithModelCapacity: m.gpt }));
vi.mock("@/lib/crawl/korean-translation-qwen", () => ({ translateKoreanTaglinesWithQwen: m.qwen }));
vi.mock("@/lib/llm/capacity-repository", () => ({ readModelCapacityCallerControl: m.control }));
vi.mock("@/lib/crawl/translate", () => ({ TRANSLATE_MODEL: "[MLX] gpt-oss-120b" }));
import { writeKoreanTaglines } from "@/lib/jobs/products/korean-tagline";
import { KOREAN_TRANSLATION_QWEN_MODEL } from "@/lib/crawl/korean-translation-config";
const task = (id: number, attempts = 0) => ({ productId: id, name: "Tool", tagline: "Track tasks for your team", repoUrl: null, attempts });
const outputs = (n: number) => ({ ok: true as const, outputs: Array.from({ length: n }, () => "팀의 할 일을 기록하는 도구") });
const ctx = (signal?: AbortSignal) => ({ lease: { name: "product-tagline-ko", token: "lease", requestedVersion: 1 },
  hasBudget: () => true, log: vi.fn(), signal }) as unknown as JobContext<null>;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("ABCLLM_API_KEY", "test"); vi.stubEnv("KOREAN_TRANSLATION_QWEN_ENABLED", "true"); vi.stubEnv("KOREAN_TRANSLATION_QWEN_RECOVERY_ENABLED", "false");
  m.control.mockResolvedValue({ mode: "disabled" }); m.pending.mockResolvedValue([]); m.recovery.mockResolvedValue([]);
  m.write.mockImplementation(async entries => entries.length);
  m.gpt.mockImplementation(async batch => ({ kind: "result", result: outputs(batch.length) }));
  m.qwen.mockImplementation(async items => outputs(items.length));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it("starts disjoint GPT and Qwen batches concurrently and stores exact model provenance once per row", async () => {
  m.pending.mockResolvedValueOnce(Array.from({ length: 16 }, (_, i) => task(i + 1)));
  let finish!: (result: unknown) => void;
  m.gpt.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const running = writeKoreanTaglines(ctx());
  await vi.waitFor(() => expect(m.qwen).toHaveBeenCalledOnce());
  expect(m.gpt).toHaveBeenCalledOnce(); finish({ kind: "result", result: outputs(8) }); await running;
  const writes = m.write.mock.calls.flatMap(([entries]) => entries);
  expect(writes).toHaveLength(16); expect(new Set(writes.map(e => e.task.productId)).size).toBe(16);
  expect(writes.slice(0, 8).every(e => e.result.model === "[MLX] gpt-oss-120b")).toBe(true);
  expect(writes.slice(8).every(e => e.result.model === KOREAN_TRANSLATION_QWEN_MODEL)).toBe(true);
});
it("stores GPT successes even when Qwen is unreachable, recording Qwen failures with its model", async () => {
  m.pending.mockResolvedValueOnce(Array.from({ length: 9 }, (_, i) => task(i + 1)));
  m.qwen.mockResolvedValueOnce({ ok: false, error: "network" }); await writeKoreanTaglines(ctx());
  const writes = m.write.mock.calls.flatMap(([entries]) => entries);
  expect(writes.filter(e => e.result.kind === "success")).toHaveLength(8);
  expect(writes.find(e => e.task.productId === 9).result).toEqual({ kind: "failure", error: "network", model: KOREAN_TRANSLATION_QWEN_MODEL });
});
it("preserves the native single-backend 1200-character pack and does not call Qwen in open mode", async () => {
  m.control.mockResolvedValue({ mode: "open" });
  m.pending.mockResolvedValueOnce(Array.from({ length: 8 }, (_, i) => ({ ...task(i + 1), tagline: "x".repeat(300) })));
  await writeKoreanTaglines(ctx()); expect(m.gpt.mock.calls[0][0]).toHaveLength(4); expect(m.qwen).not.toHaveBeenCalled();
});
it("does not write either response after lease/budget abort", async () => {
  const controller = new AbortController(); m.pending.mockResolvedValueOnce(Array.from({ length: 9 }, (_, i) => task(i + 1)));
  m.qwen.mockImplementationOnce(async () => { controller.abort(); return outputs(1); });
  await writeKoreanTaglines(ctx(controller.signal)); expect(m.write).not.toHaveBeenCalled();
});
it("fills Qwen with at most eight distinct recovery rows in a tick", async () => {
  vi.stubEnv("KOREAN_TRANSLATION_QWEN_RECOVERY_ENABLED", "true");
  m.recovery.mockResolvedValueOnce(Array.from({ length: 12 }, (_, i) => task(i + 1, 4)));
  await writeKoreanTaglines(ctx()); expect(m.gpt).not.toHaveBeenCalled(); expect(m.qwen).toHaveBeenCalledOnce();
  expect(m.qwen.mock.calls[0][0]).toHaveLength(8); expect(m.recovery).toHaveBeenCalledOnce();
  expect(m.write.mock.calls.flatMap(([entries]) => entries)).toHaveLength(8);
});
it("runs regular repeated-failure Qwen work alone before a distinct recovery-only batch", async () => {
  vi.stubEnv("KOREAN_TRANSLATION_QWEN_RECOVERY_ENABLED", "true");
  m.pending.mockResolvedValueOnce([...Array.from({ length: 8 }, (_, i) => task(i + 1)), task(9, 2)]);
  m.recovery.mockResolvedValueOnce([task(1, 4), task(9, 4), task(100, 4)]);
  await writeKoreanTaglines(ctx());
  expect(new Set(m.recovery.mock.calls[0][2]).size).toBe(9);
  expect(m.qwen.mock.calls[0][0]).toHaveLength(1);
  expect(m.qwen.mock.calls[1][0]).toHaveLength(1);
  const writes = m.write.mock.calls.flatMap(([entries]) => entries); expect(writes).toHaveLength(10);
  expect(new Set(writes.map(e => e.task.productId)).size).toBe(10);
});
it("never dispatches an oversized first source or calls it a successful drained queue", async () => {
  m.pending.mockResolvedValueOnce([{ ...task(1), tagline: "x".repeat(3601) }]);
  expect(await writeKoreanTaglines(ctx())).toMatchObject({ degraded: { code: "input_too_large" } });
  expect(m.gpt).not.toHaveBeenCalled(); expect(m.qwen).not.toHaveBeenCalled(); expect(m.write).not.toHaveBeenCalled();
});
it("uses keyless Qwen in disabled mode but does not call a missing-key native path successful", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "");
  m.pending.mockResolvedValueOnce([task(1)]);
  await writeKoreanTaglines(ctx()); expect(m.gpt).not.toHaveBeenCalled(); expect(m.qwen).toHaveBeenCalledOnce();
  m.qwen.mockClear(); m.control.mockResolvedValue({ mode: "open" });
  expect(await writeKoreanTaglines(ctx())).toMatchObject({ degraded: { code: "no_key" } });
  expect(m.qwen).not.toHaveBeenCalled();
});
it("defers recovery before selection when an earlier regular round leaves less than a full call budget", async () => {
  vi.stubEnv("KOREAN_TRANSLATION_QWEN_RECOVERY_ENABLED", "true");
  let now = 100_000; vi.spyOn(Date, "now").mockImplementation(() => now);
  m.pending.mockResolvedValueOnce([task(1)]);
  // The recovery lookup is available in the first round, but no recovered task was returned.
  m.recovery.mockResolvedValueOnce([]);
  m.gpt.mockImplementationOnce(async batch => { now += 10_000; return { kind: "result", result: outputs(batch.length) }; });
  expect(await writeKoreanTaglines(ctx())).toMatchObject({ done: false });
  expect(m.recovery).toHaveBeenCalledOnce(); expect(m.qwen).not.toHaveBeenCalled();
});
it("rechecks full recovery budget after a slow selection and makes no shortened recovery HTTP call", async () => {
  vi.stubEnv("KOREAN_TRANSLATION_QWEN_RECOVERY_ENABLED", "true");
  let now = 100_000; vi.spyOn(Date, "now").mockImplementation(() => now);
  m.recovery.mockImplementationOnce(async () => { now += 10_000; return [task(1, 4)]; });
  expect(await writeKoreanTaglines(ctx())).toMatchObject({ done: false });
  expect(m.qwen).not.toHaveBeenCalled(); expect(m.write).not.toHaveBeenCalled();
});
it("records an actual full-budget recovery timeout as a Qwen attempt instead of silently retrying", async () => {
  vi.stubEnv("KOREAN_TRANSLATION_QWEN_RECOVERY_ENABLED", "true");
  m.recovery.mockResolvedValueOnce([task(1, 4)]); m.qwen.mockResolvedValueOnce({ ok: false, error: "timeout" });
  await writeKoreanTaglines(ctx());
  expect(m.qwen.mock.calls[0][1].timeoutMs).toBe(45_000);
  expect(m.write.mock.calls[0][0][0].result).toEqual({ kind: "failure", error: "timeout", model: KOREAN_TRANSLATION_QWEN_MODEL });
  expect(m.qwen).toHaveBeenCalledOnce();
});
