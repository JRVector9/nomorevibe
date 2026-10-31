import { afterEach, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";
import { translateReasons } from "@/lib/crawl/jobs/translate-reasons";
import { writeTaglines } from "@/lib/crawl/jobs/tagline";
import { writeSearchProfiles } from "@/lib/jobs/products/search-profile";
import { verifySearchKeywords } from "@/lib/jobs/products/search-verify";
import { writeKoreanTaglines } from "@/lib/jobs/products/korean-tagline";
import { translateDemandedProductFields } from "@/lib/jobs/products/translations";
import { KOREAN_TAGLINE_MODEL, PRODUCT_TRANSLATE_MODEL, TRANSLATE_MODEL } from "@/lib/crawl/translate";
import { TAGLINE_MODEL } from "@/lib/crawl/tagline";
import { PROFILE_MODEL } from "@/lib/domain/products/search-profile";
import { VERIFY_MODEL } from "@/lib/domain/products/search-verify";
import { setServingContractSnapshotForTest, TEXT_ROUTE_BLOCK_DETAIL } from "@/lib/llm/serving-contract-store";

vi.mock("server-only", () => ({}));
// crawl-tagline reads the crawl settings right after the gate; paused collection ends the tick without a DB.
vi.mock("@/lib/crawl/settings", async original => ({ ...await original<typeof import("@/lib/crawl/settings")>(), getSettings: async () => ({ enabled: false }) }));

/**
 * 여섯 text 잡(사유 번역·한 줄 소개·검색 키워드 짓기·검수·한국어 소개·제품 번역)은 그 경로·모델의 직접 연결 계약(관리자 엔진 연결,
 * transport direct)이 있어야 부른다. abcLLM 게이트웨이는 2026-10-30 제거됐다 — 게이트웨이 키(env)는 더 읽지 않는다.
 * 계약이 없으면 부르지 않고 이유 코드(no_direct_contract·gateway_auth·stored_key_unreadable)로 넘긴다 — 성공이 아니므로 러너가
 * 성공 시각을 옮기지 않고 조치할 일이 올린다. 계약이 있으면 키 없이도 문을 지나 다음 단계(lease 확인·설정 읽기)로 간다.
 */
afterEach(() => { vi.unstubAllEnvs(); setServingContractSnapshotForTest(null); });
const context = (): JobContext<null> => ({ cursor: null, save: async () => {}, hasBudget: () => true, log: vi.fn() });
const JOBS = [
  ["reason-translate", TRANSLATE_MODEL, translateReasons],
  ["crawl-tagline", TAGLINE_MODEL, writeTaglines],
  ["product-search-profile", PROFILE_MODEL, writeSearchProfiles],
  ["product-search-verify", VERIFY_MODEL, (ctx: JobContext<null>) => verifySearchKeywords(ctx)],
  ["product-tagline-ko", KOREAN_TAGLINE_MODEL, writeKoreanTaglines],
  ["product-translate", PRODUCT_TRANSLATE_MODEL, translateDemandedProductFields],
] as const;
const direct = (routeId: string, model: string, auth: "none" | "gateway" | "stored" = "none") =>
  ({ routeId, model, contract: {}, auth, apiKey: null, transport: "direct" as const });

it.each(JOBS)("%s — 직접 연결 계약이 없으면 게이트웨이 키가 있어도 부르지 않고 no_direct_contract 로 넘긴다", async (_route, _model, handler) => {
  vi.stubEnv("ABCLLM_API_KEY", "old-gateway-key");
  setServingContractSnapshotForTest([]);
  const ctx = context();
  expect(await handler(ctx)).toEqual({ done: true, degraded: { code: "no_direct_contract", detail: TEXT_ROUTE_BLOCK_DETAIL.no_direct_contract } });
  expect(ctx.log).toHaveBeenCalledTimes(1);
});

it.each(JOBS)("%s — 계약의 인증이 게이트웨이 키·열 수 없는 저장 키면 그 이유로 넘긴다", async (route, model, handler) => {
  setServingContractSnapshotForTest([direct(route, model, "gateway")]);
  expect(await handler(context())).toEqual({ done: true, degraded: { code: "gateway_auth", detail: TEXT_ROUTE_BLOCK_DETAIL.gateway_auth } });
  setServingContractSnapshotForTest([direct(route, model, "stored")]);
  expect(await handler(context())).toEqual({ done: true, degraded: { code: "stored_key_unreadable", detail: TEXT_ROUTE_BLOCK_DETAIL.stored_key_unreadable } });
});

it.each(JOBS)("%s — 직접 연결 계약이 있으면 키 없이 문을 지난다", async (route, model, handler) => {
  vi.stubEnv("ABCLLM_API_KEY", undefined);
  setServingContractSnapshotForTest([direct(route, model)]);
  const ctx = context();
  // 다음 단계에서 멈춘다: lease 가 없는 잡은 lease 오류, 소개 짓기는 수집이 멈춰 있어 일 없이 끝난다 — 어느 쪽도 계약 이유로 접지 않는다.
  const outcome = await handler(ctx).catch((error: unknown) => error);
  if (route === "crawl-tagline") expect(outcome).toEqual({ done: true });
  else expect(String(outcome)).toMatch(/lease/i);
});
