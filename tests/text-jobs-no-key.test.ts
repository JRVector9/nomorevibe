import { afterEach, expect, it, vi } from "vitest";
import type { JobContext } from "@/lib/jobs/runner";
import { translateReasons } from "@/lib/crawl/jobs/translate-reasons";
import { writeTaglines } from "@/lib/crawl/jobs/tagline";
import { writeSearchProfiles } from "@/lib/jobs/products/search-profile";
import { verifySearchKeywords } from "@/lib/jobs/products/search-verify";
import { writeKoreanTaglines } from "@/lib/jobs/products/korean-tagline";
import { translateDemandedProductFields } from "@/lib/jobs/products/translations";
import { aiTask, type AiTextTaskId } from "@/lib/llm/ai-tasks";
import { textRankUnusableText } from "@/lib/llm/ai-task-resolver";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { pinTextRanks, textContract, textRankRow } from "./text-task-ranks-fixture";

vi.mock("server-only", () => ({}));
// crawl-tagline reads the crawl settings right after the gate; paused collection ends the tick without a DB.
vi.mock("@/lib/crawl/settings", async original => ({ ...await original<typeof import("@/lib/crawl/settings")>(), getSettings: async () => ({ enabled: false }) }));

/**
 * 여섯 text 잡(사유 번역·한 줄 소개·검색 키워드 짓기·검수·한국어 소개·제품 번역)은 그 경로·모델의 직접 연결 계약(관리자 엔진 연결,
 * transport direct)이 있어야 부른다. abcLLM 게이트웨이는 2026-10-30 제거됐다 — 게이트웨이 키(env)는 더 읽지 않는다.
 * 2026-11-02(PR B)부터 모델은 「작업 ↔ 모델」 순위가 고른다. 순위가 없으면 no_task_models, 순위는 있는데 그 연결을 가리키는 계약이 없거나
 * 닫혔으면(게이트웨이 인증·연결 키를 열 수 없음) 그 순위를 쓸 수 없고 모두 쓸 수 없으면 all_ranks_unusable 로 넘긴다 — 성공이 아니므로 러너가
 * 성공 시각을 옮기지 않고 조치할 일이 올린다. 계약이 있으면 키 없이도 문을 지나 다음 단계(lease 확인·설정 읽기)로 간다.
 */
afterEach(() => { vi.unstubAllEnvs(); setServingContractSnapshotForTest(null); pinTextRanks(null); });
const context = (): JobContext<null> => ({ cursor: null, save: async () => {}, hasBudget: () => true, log: vi.fn() });
type Handler = (ctx: JobContext<null>) => Promise<unknown>;
const JOBS: readonly (readonly [AiTextTaskId, string, string, Handler])[] = [
  ["reason-translate", "mlx-community--gemma-4-26b-a4b-it-4bit", "translate.skipped", translateReasons],
  ["crawl-tagline", "qwen3.6-35b-heretic", "tagline.skipped", writeTaglines],
  ["product-search-profile", "gpt-oss-120b", "search_profile.skipped", writeSearchProfiles],
  ["product-search-verify", "Qwen3.8-27B-NVFP4", "search_verify.skipped", (ctx: JobContext<null>) => verifySearchKeywords(ctx)],
  ["product-tagline-ko", "gpt-oss-120b", "tagline_ko.skipped", writeKoreanTaglines],
  ["product-translate", "mlx-community--gemma-4-26b-a4b-it-4bit", "product_translation.deferred", translateDemandedProductFields],
];
const unusable = (route: AiTextTaskId, model: string, code: string) => ({ done: true, degraded: { code: "all_ranks_unusable",
  detail: `${aiTask(route)!.label}: 1순위 test-engine · ${model}: ${textRankUnusableText(code)}` } });

it.each(JOBS)("%s — 순위가 없으면 게이트웨이 키·계약이 있어도 부르지 않고 no_task_models 로 넘긴다", async (route, model, event, handler) => {
  vi.stubEnv("ABCLLM_API_KEY", "old-gateway-key");
  pinTextRanks({});
  setServingContractSnapshotForTest([textContract(route, model)]);
  const ctx = context();
  expect(await handler(ctx)).toEqual({ done: true, degraded: { code: "no_task_models", detail: expect.stringContaining(`${aiTask(route)!.label}: `) } });
  expect(vi.mocked(ctx.log).mock.calls).toEqual([[event, { reason: "no_task_models" }], ["ai_task.ranks", { ranks: 0 }]]);
});

it.each(JOBS)("%s — 순위의 직접 연결 계약이 없으면 게이트웨이 키가 있어도 부르지 않고 all_ranks_unusable(no_direct_contract)로 넘긴다", async (route, model, event, handler) => {
  vi.stubEnv("ABCLLM_API_KEY", "old-gateway-key");
  pinTextRanks({ [route]: model });
  setServingContractSnapshotForTest([]);
  const ctx = context();
  expect(await handler(ctx)).toEqual(unusable(route, model, "no_direct_contract"));
  expect(vi.mocked(ctx.log).mock.calls).toEqual([[event, { reason: "all_ranks_unusable" }],
    ["ai_task.ranks", { ranks: 1, "unusable.1.no_direct_contract": 1 }]]);
});

it.each(JOBS)("%s — 계약의 인증이 게이트웨이 키거나 연결 키를 열 수 없으면 그 까닭으로 넘긴다", async (route, model, _event, handler) => {
  pinTextRanks({ [route]: model });
  setServingContractSnapshotForTest([textContract(route, model, { auth: "gateway" })]);
  expect(await handler(context())).toEqual(unusable(route, model, "gateway_auth"));
  // 보내는 키는 연결의 키다 — 연결에 저장한 키가 열리지 않으면 그 순위를 쓸 수 없다
  pinTextRanks([textRankRow(route, model, { keyUnreadable: true })]);
  setServingContractSnapshotForTest([textContract(route, model)]);
  expect(await handler(context())).toEqual(unusable(route, model, "stored_key_unreadable"));
});

it.each(JOBS)("%s — 직접 연결 계약이 있으면 키 없이 문을 지난다(계약 행의 저장 키가 열리지 않아도 연결의 키를 보낸다)", async (route, model, event, handler) => {
  vi.stubEnv("ABCLLM_API_KEY", undefined);
  pinTextRanks({ [route]: model });
  for (const contract of [textContract(route, model), textContract(route, model, { auth: "stored", apiKey: null })]) {
    setServingContractSnapshotForTest([contract]);
    const ctx = context();
    // 다음 단계에서 멈춘다: lease 가 없는 잡은 lease 오류, 소개 짓기는 수집이 멈춰 있어 일 없이 끝난다 — 어느 쪽도 계약 이유로 접지 않는다.
    const outcome = await handler(ctx).catch((error: unknown) => error);
    if (route === "crawl-tagline") expect(outcome).toEqual({ done: true });
    else expect(String(outcome)).toMatch(/lease/i);
    expect(ctx.log).not.toHaveBeenCalledWith(event, { reason: expect.stringMatching(/rank|task_models/) });
  }
});
