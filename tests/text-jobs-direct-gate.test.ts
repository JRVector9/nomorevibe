import { afterEach, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";
import { setServingContractSnapshotForTest, TEXT_ROUTE_BLOCK_DETAIL } from "@/lib/llm/serving-contract-store";
import { scopedModel } from "@/lib/llm/model-registry";
import { TRANSLATE_MODEL } from "@/lib/crawl/translate";
import { TAGLINE_MODEL } from "@/lib/crawl/tagline";

vi.mock("server-only", () => ({}));
const settings = vi.hoisted(() => ({ getSettings: vi.fn(async () => ({ enabled: false })) }));
vi.mock("@/lib/crawl/settings", async original => ({ ...await original<typeof import("@/lib/crawl/settings")>(), getSettings: settings.getSettings }));

import { translateReasons } from "@/lib/crawl/jobs/translate-reasons";
import { writeTaglines } from "@/lib/crawl/jobs/tagline";

/**
 * PR 3b-C: 사유 번역·한 줄 소개도 다른 text 잡처럼 textRouteCallable(= textRouteBlock === null) 로 연다 — 이 경로의 직접 연결 계약(엔진에 바로,
 * 키 없음)이 있으면 연다. 계약이 없으면 no_direct_contract 다(text-jobs-no-key.test.ts) — 게이트웨이 키 env 는 2026-10-31부터 읽지 않는다.
 */
afterEach(() => { setServingContractSnapshotForTest(null); vi.unstubAllEnvs(); settings.getSettings.mockClear(); });
const context = (): JobContext<null> => ({ cursor: null, save: async () => {}, hasBudget: () => true, log: vi.fn() });
const direct = (routeId: string, model: string) => ({ routeId, model, contract: {}, auth: "none" as const, apiKey: null, transport: "direct" as const });

it("reason-translate passes the key gate with a directly connected engine and no gateway key", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "");
  setServingContractSnapshotForTest([direct("reason-translate", scopedModel("reason-translate", TRANSLATE_MODEL))]);
  const ctx = context();
  // Past the gate the job needs its lease — reaching that check proves the direct contract opened the route.
  await expect(translateReasons(ctx)).rejects.toThrow("Translation worker requires a job lease");
  expect(ctx.log).not.toHaveBeenCalledWith("translate.skipped", expect.anything());
});

it("crawl-tagline passes the key gate with a directly connected engine and no gateway key", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "");
  setServingContractSnapshotForTest([direct("crawl-tagline", scopedModel("crawl-tagline", TAGLINE_MODEL))]);
  const ctx = context();
  expect(await writeTaglines(ctx)).toEqual({ done: true });
  expect(settings.getSettings).toHaveBeenCalledTimes(1);
  expect(ctx.log).toHaveBeenCalledWith("tagline.skipped", { reason: "disabled" });
});

it("a direct contract of another route or model does not open either job, whatever the old gateway key env says", async () => {
  vi.stubEnv("ABCLLM_API_KEY", "ignored-gateway-key");
  setServingContractSnapshotForTest([direct("product-translate", scopedModel("reason-translate", TRANSLATE_MODEL)),
    direct("crawl-tagline", "some-other-model")]);
  for (const handler of [translateReasons, writeTaglines]) {
    const ctx = context();
    expect(await handler(ctx)).toEqual({ done: true, degraded: { code: "no_direct_contract", detail: TEXT_ROUTE_BLOCK_DETAIL.no_direct_contract } });
  }
  expect(settings.getSettings).not.toHaveBeenCalled();
});
