import { afterEach, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { textRankUnusableText } from "@/lib/llm/ai-task-resolver";
import { pinTextRanks, textContract } from "./text-task-ranks-fixture";

vi.mock("server-only", () => ({}));
const settings = vi.hoisted(() => ({ getSettings: vi.fn(async () => ({ enabled: false })) }));
vi.mock("@/lib/crawl/settings", async original => ({ ...await original<typeof import("@/lib/crawl/settings")>(), getSettings: settings.getSettings }));

import { translateReasons } from "@/lib/crawl/jobs/translate-reasons";
import { writeTaglines } from "@/lib/crawl/jobs/tagline";

/**
 * PR 3b-C: 사유 번역·한 줄 소개도 다른 text 잡처럼 이 경로의 직접 연결 계약(엔진에 바로, 키 없음)이 있으면 연다 — 게이트웨이 키 env 는
 * 2026-10-31부터 읽지 않는다. 2026-11-02(PR B)부터 모델은 「작업 ↔ 모델」 순위가 고르고, 그 순위의 연결을 가리키는 계약이 있어야 연다.
 * 계약이 없으면 그 순위를 쓸 수 없고, 모든 순위를 쓸 수 없으면 all_ranks_unusable 이다(text-jobs-no-key.test.ts).
 */
afterEach(() => { setServingContractSnapshotForTest(null); pinTextRanks(null); vi.unstubAllEnvs(); settings.getSettings.mockClear(); });
const context = (): JobContext<null> => ({ cursor: null, save: async () => {}, hasBudget: () => true, log: vi.fn() });
const REASON_MODEL = "mlx-community--gemma-4-26b-a4b-it-4bit";
const TAGLINE_MODEL = "qwen3.6-35b-heretic";

it("reason-translate passes the key gate with a directly connected engine and no gateway key", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "");
  pinTextRanks({ "reason-translate": REASON_MODEL });
  setServingContractSnapshotForTest([textContract("reason-translate", REASON_MODEL)]);
  const ctx = context();
  // Past the gate the job needs its lease — reaching that check proves the direct contract opened the route.
  await expect(translateReasons(ctx)).rejects.toThrow("Translation worker requires a job lease");
  expect(ctx.log).not.toHaveBeenCalledWith("translate.skipped", expect.anything());
});

it("crawl-tagline passes the key gate with a directly connected engine and no gateway key", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "");
  pinTextRanks({ "crawl-tagline": TAGLINE_MODEL });
  setServingContractSnapshotForTest([textContract("crawl-tagline", TAGLINE_MODEL)]);
  const ctx = context();
  expect(await writeTaglines(ctx)).toEqual({ done: true });
  expect(settings.getSettings).toHaveBeenCalledTimes(1);
  expect(ctx.log).toHaveBeenCalledWith("tagline.skipped", { reason: "disabled" });
});

it("a direct contract of another route or model does not open either job, whatever the old gateway key env says", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "ignored-gateway-key");
  pinTextRanks({ "reason-translate": REASON_MODEL, "crawl-tagline": TAGLINE_MODEL });
  setServingContractSnapshotForTest([textContract("product-translate", REASON_MODEL), textContract("crawl-tagline", "some-other-model")]);
  for (const [handler, label, model] of [[translateReasons, "심사 사유 번역", REASON_MODEL], [writeTaglines, "수집 소개 짓기", TAGLINE_MODEL]] as const) {
    const ctx = context();
    expect(await handler(ctx)).toEqual({ done: true, degraded: { code: "all_ranks_unusable",
      detail: `${label}: 1순위 test-engine · ${model}: ${textRankUnusableText("no_direct_contract")}` } });
  }
  expect(settings.getSettings).not.toHaveBeenCalled();
});
