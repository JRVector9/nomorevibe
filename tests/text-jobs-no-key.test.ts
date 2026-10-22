import { afterEach, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";
import { translateReasons } from "@/lib/crawl/jobs/translate-reasons";
import { writeTaglines } from "@/lib/crawl/jobs/tagline";
import { writeSearchProfiles } from "@/lib/jobs/products/search-profile";
import { verifySearchKeywords } from "@/lib/jobs/products/search-verify";
import { writeKoreanTaglines } from "@/lib/jobs/products/korean-tagline";
import { translateDemandedProductFields } from "@/lib/jobs/products/translations";

vi.mock("server-only", () => ({}));

/**
 * 게이트웨이 키(ABCLLM_API_KEY)가 text 워커에 없으면 여섯 잡(사유 번역·한 줄 소개·검색 키워드 짓기·검수·한국어 소개·제품 번역)은
 * 아무것도 하지 않는다. 전에는 { done: true } 로 돌아와 러너가 성공으로 적었다(2026-10-22 점검에서 확인 — 넷이 아니라 여섯이다).
 * 이제 제 일 못 함(no_key)으로 넘겨 성공 시각을 옮기지 않고, 조치할 일이 잇달아 30번(30분)이면 올린다.
 */
afterEach(() => vi.unstubAllEnvs());
const context = (): JobContext<null> => ({ cursor: null, save: async () => {}, hasBudget: () => true, log: vi.fn() });

it.each([
  ["reason-translate", translateReasons],
  ["crawl-tagline", writeTaglines],
  ["product-search-profile", writeSearchProfiles],
  ["product-search-verify", (ctx: JobContext<null>) => verifySearchKeywords(ctx)],
  ["product-tagline-ko", writeKoreanTaglines],
  ["product-translate", translateDemandedProductFields],
] as const)("%s — 키가 없으면 부르지 않고 no_key 로 넘긴다", async (_name, handler) => {
  vi.stubEnv("ABCLLM_API_KEY", " ");
  const ctx = context();
  expect(await handler(ctx)).toEqual({ done: true, degraded: { code: "no_key", detail: "text 워커에 ABCLLM_API_KEY 가 없습니다" } });
  expect(ctx.log).toHaveBeenCalledTimes(1);
});
