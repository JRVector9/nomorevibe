import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { packBatch, translateReasons } from "@/lib/crawl/jobs/translate-reasons";

const mocks = vi.hoisted(() => ({ pending: vi.fn(), record: vi.fn(), translate: vi.fn() }));
vi.mock("@/lib/crawl/translations", () => ({ pendingTranslations: mocks.pending, recordTranslations: mocks.record }));
vi.mock("@/lib/crawl/translate", () => ({ TRANSLATE_MODEL: "[MLX] gpt-oss-120b", translateToKorean: mocks.translate }));

const context = () => ({ cursor: null, hasBudget: () => true, save: vi.fn(), log: vi.fn(), lease: { name: "reason-translate", token: "t", requestedVersion: 1 } });
const item = (hash: string, attempts = 0) => ({ hash, body: `English reason ${hash}`, attempts });
const original = process.env.ABCLLM_API_KEY;

beforeEach(() => {
  vi.resetAllMocks();
  process.env.ABCLLM_API_KEY = "test-key";
  mocks.record.mockResolvedValue(undefined);
});
afterEach(() => { if (original === undefined) delete process.env.ABCLLM_API_KEY; else process.env.ABCLLM_API_KEY = original; });

it("키가 없으면 아무것도 하지 않는다", async () => {
  delete process.env.ABCLLM_API_KEY;
  const ctx = context();
  expect(await translateReasons(ctx)).toEqual({ done: true });
  expect(mocks.pending).not.toHaveBeenCalled();
  expect(ctx.log).toHaveBeenCalledWith("translate.skipped", { reason: "no_key" });
});

it("처음 보는 글을 묶어 옮기고, 남은 것이 없으면 끝낸다", async () => {
  mocks.pending.mockResolvedValueOnce([item("a"), item("b"), item("c")]).mockResolvedValueOnce([]);
  mocks.translate.mockResolvedValue({ ok: true, translations: ["가", "나", null] });

  expect(await translateReasons(context())).toEqual({ done: true });
  expect(mocks.pending).toHaveBeenCalledWith(8);
  expect(mocks.translate.mock.calls[0][0]).toEqual(["English reason a", "English reason b", "English reason c"]);
  // 한 항목이 비면 그것만 실패로 — 나머지는 남긴다
  expect(mocks.record).toHaveBeenCalledWith([
    { hash: "a", translated: "가", error: undefined }, { hash: "b", translated: "나", error: undefined }, { hash: "c", translated: null, error: undefined },
  ], "[MLX] gpt-oss-120b");
});

it("한 번 실패한 글은 따로 옮긴다", async () => {
  mocks.pending.mockResolvedValueOnce([item("x", 2), item("y"), item("z")]).mockResolvedValueOnce([]);
  mocks.translate.mockResolvedValue({ ok: true, translations: ["엑스"] });
  await translateReasons(context());
  expect(mocks.translate.mock.calls[0][0]).toEqual(["English reason x"]);
});

it("게이트웨이가 막히면 실패로 남기고 이번 틱을 멈춘다 — 다음 틱에 이어 간다", async () => {
  mocks.pending.mockResolvedValue([item("a"), item("b")]);
  mocks.translate.mockResolvedValue({ ok: false, error: "timeout" });
  expect(await translateReasons(context())).toEqual({ done: false });
  expect(mocks.translate).toHaveBeenCalledTimes(1);
  expect(mocks.record).toHaveBeenCalledWith([{ hash: "a", translated: null, error: "timeout" }, { hash: "b", translated: null, error: "timeout" }], "[MLX] gpt-oss-120b");
});

it("시간이 모자라면 다음 틱으로 넘긴다", async () => {
  let calls = 0;
  const ctx = { ...context(), hasBudget: () => calls++ < 1 };
  mocks.pending.mockResolvedValue([item("a")]);
  mocks.translate.mockResolvedValue({ ok: true, translations: ["가"] });
  expect(await translateReasons(ctx)).toEqual({ done: false });
  expect(mocks.translate).toHaveBeenCalledTimes(1);
});

it("글자 수로 묶는다 — 최대 4건·1,600자, 순서를 지키고, 긴 글 하나는 혼자 간다", () => {
  const text = (chars: number, id: string) => ({ id, body: "x".repeat(chars) });
  expect(packBatch([text(400, "a"), text(400, "b"), text(400, "c"), text(400, "d"), text(10, "e")]).map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
  expect(packBatch([text(700, "a"), text(700, "b"), text(700, "c")]).map((i) => i.id)).toEqual(["a", "b"]);
  expect(packBatch([text(2_000, "long"), text(10, "b")]).map((i) => i.id)).toEqual(["long"]);
  expect(packBatch([])).toEqual([]);
});

it("틱 끝에 시간이 모자라면 새로 부르지 않는다 — 줄어든 제한으로 헛실패하지 않게", async () => {
  vi.useFakeTimers();
  try {
    mocks.pending.mockResolvedValue([item("a")]);
    // 한 번 부르는 데 30초 — 두 번째를 부르기엔 24초밖에 남지 않는다
    mocks.translate.mockImplementation(async () => { vi.advanceTimersByTime(30_000); return { ok: true, translations: ["가"] }; });
    expect(await translateReasons(context())).toEqual({ done: false });
    expect(mocks.translate).toHaveBeenCalledTimes(1);
    expect(mocks.translate.mock.calls[0][1]).toBe(45_000);
  } finally { vi.useRealTimers(); }
});
