import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withAdminStagePools, withAdminModelStage, validateAdminStagePools, MODEL_POOL_JOBS } from "@/lib/llm/admin-model-pools";
import { configuredModel, modelBaseUrl, modelRequestBudget, modelRouteTimeoutMs, readModelRegistry, scopedModel } from "@/lib/llm/model-registry";
import { reasonTranslationGatewayWire, textHash, translateToKorean } from "@/lib/crawl/translate";
import { profileGatewayWire, writeKeywords } from "@/lib/domain/products/search-profile";
import { searchVerifyGatewayWire, verifyKeywords } from "@/lib/domain/products/search-verify";
import { crawlTaglineGatewayWire, writeTagline } from "@/lib/crawl/tagline";
import { translateReasonsWithModelCapacity } from "@/lib/crawl/reason-translation-model-capacity";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import { textTaskModel } from "@/lib/llm/ai-task-rank-scope";
import { inTextRank, textContract } from "./text-task-ranks-fixture";
/** text 작업의 모델은 「작업 ↔ 모델」 순위가 고른다(PR B) — 시험 순위의 모델 */
const RANK_MODEL = "rank-model";
const control = vi.hoisted(() => vi.fn());
vi.mock("@/lib/llm/capacity-repository", () => ({ readModelCapacityCallerControl: control }));
beforeEach(() => { control.mockReset().mockResolvedValue({ mode: "disabled" }); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); setServingContractSnapshotForTest(null); });

it("기존 설정과 빈 풀은 환경 기본값을 보존한다", () => {
  const before = configuredModel("reason-translate");
  expect(withAdminStagePools({}, "fixture", () => configuredModel("reason-translate"))).toBe(before);
  expect(withAdminStagePools({ "reason-translate": [] }, "fixture", () => configuredModel("reason-translate"))).toBe(before);
});
it("은퇴한 abcLLM env 가 없어도 네 용도는 단계 풀의 등록부 선택을 쓴다", () => {
  for (const [purpose, key, expected] of [
    ["product-search-profile", "supa:review", "supa"],
    ["reason-translate", "mlx:text", "gpt-oss-120b"],
    ["product-tagline-ko", "supa:review", "supa"],
    ["search-query-translate", "mlx:text", "gpt-oss-120b"],
  ] as const)
    expect(withAdminStagePools({ [purpose]: [key] }, "fixture", () => configuredModel(purpose))).toBe(expected);
});
it("등록부의 같은 어댑터 모델을 선택하고 임의 키·제공자 변경·중복을 거절한다", () => {
  expect(validateAdminStagePools({ "reason-translate": ["mlx:text", "supa:review"] })).toEqual({ "reason-translate": ["mlx:text", "supa:review"] });
  for (const pools of [{ "reason-translate": ["connect:sonnet"] }, { "reason-translate": ["none:missing"] },
    { "reason-translate": ["mlx:text", "mlx:text"] }, { "unknown-stage": ["mlx:text"] }])
    expect(() => validateAdminStagePools(pools)).toThrow();
});
it("저장한 번역 선택은 같은 환경변수를 공유하는 검색 질의 모델을 바꾸지 않는다", () => {
  // 검색 질의 자리는 고르지 않았다 — 범위 안에서도 부른 쪽이 준 기본값 그대로다
  withAdminStagePools({ "reason-translate": ["supa:review"] }, "fixture", () => {
    expect(configuredModel("reason-translate")).toBe("supa");
    expect(scopedModel("search-query-translate", "query-fallback")).toBe("query-fallback");
  });
});
it("text 다섯 잡은 단계 풀 범위를 열지 않는다 — 순위가 모델을 고른다(PR B); 한국어 소개는 Qwen 직접 경로 때문에 남는다", () => {
  for (const job of ["reason-translate", "crawl-tagline", "product-translate", "product-search-profile", "product-search-verify"])
    expect(MODEL_POOL_JOBS.has(job)).toBe(false);
  expect(MODEL_POOL_JOBS.has("product-tagline-ko")).toBe(true);
});
it("사유 번역 wire 이름은 저장한 단계 풀이 아니라 순위가 정하고, 옛 게이트웨이 번역 클라이언트는 보내지 않는다", async () => {
  // 게이트웨이(abcLLM)는 2026-10-30 제거됐다 — 옛 클라이언트는 no_key 로 끝난다. 단계 풀에 다른 모델을 저장해 두어도(PR B 전의 선택)
  // 순위 범위 안의 장부 이름·wire 이름은 순위의 모델이다
  vi.stubEnv("ABCLLM_BASE_URL", "http://old-fixture.test/v1");
  vi.stubEnv("ABCLLM_API_KEY", "fixture-key");
  // ABCLLM_BASE_URL is retired: the route keeps the registry's M1 address.
  expect(modelBaseUrl("reason-translate")).toBe("https://m1-studio.tail02799e.ts.net/v1");
  const request = vi.fn();
  await withAdminStagePools({ "reason-translate": ["supa:review"] }, "fixture", () => inTextRank("reason-translate", RANK_MODEL, async () => {
    expect(configuredModel("reason-translate")).toBe("supa");
    const model = textTaskModel("reason-translate");
    expect(model).toBe(RANK_MODEL);
    expect(JSON.parse(reasonTranslationGatewayWire(["Document tool"], model)).model).toBe(RANK_MODEL);
    expect(await translateToKorean(["Document tool"], 1000, request)).toEqual({ ok: false, error: "no_key" });
  }));
  expect(request).not.toHaveBeenCalled();
});
it("동시에 실행하는 작업 묶음의 모델 선택을 섞지 않고 범위를 벗어나면 복원한다", async () => {
  const original = configuredModel("reason-translate");
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const first = withAdminStagePools({ "reason-translate": ["supa:review"] }, "fixture-a", async () => {
    await barrier; return configuredModel("reason-translate");
  });
  const second = withAdminStagePools({ "reason-translate": ["mlx:text"] }, "fixture-b", async () => {
    release(); await Promise.resolve(); return configuredModel("reason-translate");
  });
  expect(await Promise.all([first, second])).toEqual(["supa", "gpt-oss-120b"]);
  expect(configuredModel("reason-translate")).toBe(original);
});
it("같은 업무 배정은 같은 모델·주소를 유지하고 여러 배정은 풀을 나눠 쓴다", () => {
  const pools = { "reason-translate": ["supa:review", "mlx:text"] };
  const results = Array.from({ length: 30 }, (_, i) => withAdminStagePools(pools, String(i), () => configuredModel("reason-translate")));
  expect(new Set(results).size).toBe(2);
  expect(withAdminStagePools(pools, "0", () => configuredModel("reason-translate"))).toBe(results[0]);
  expect(withAdminStagePools({ "product-translate": ["m1:translation"] }, "fixture", () => modelBaseUrl("product-translate"))).toBe("https://m1-studio.tail02799e.ts.net/v1");
});
it("공통 용량 제어가 켜져 있으면 순위로 고른 모델도 정식 dispatch 계약 없이 호출하지 않는다", async () => {
  control.mockResolvedValue({ mode: "draining" });
  // 순위의 모델에 엔진 직접 연결 계약이 있어 용량 경로에 들어선다 — 그래도 draining 이면 보내지 않고 미룬다
  setServingContractSnapshotForTest([textContract("reason-translate", RANK_MODEL)]);
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network_not_allowed"));
  const batch = [{ hash: textHash("Document tool"), body: "Document tool", attempts: 0 }];
  await expect(inTextRank("reason-translate", RANK_MODEL,
    () => translateReasonsWithModelCapacity(batch, { name: "reason-translate", token: "fixture-token", requestedVersion: 1 }, { timeoutMs: 1000 })))
    .rejects.toMatchObject({ name: "ModelCapacityDeferredError", reason: "draining" });
  expect(network).not.toHaveBeenCalled();
});
it("같은 직접 검수 어댑터의 감사·공개분·보류 풀을 단계별로 독립 적용한다", () => {
  withAdminStagePools({ "direct-review": ["gpu3090:review"], "audit-second-opinion": ["m3:review"],
    "published-filter": ["gpu3090:review"], "held-review-retry": ["m3:review"] }, "fixture", () => {
    expect(configuredModel("direct-review")).toBe("qwen3.8-flash-next");
    expect(withAdminModelStage("audit-second-opinion", () => configuredModel("direct-review"))).toBe("deepseek-v4.1-flash-1017");
    expect(withAdminModelStage("published-filter", () => configuredModel("direct-review"))).toBe("qwen3.8-flash-next");
    expect(withAdminModelStage("held-review-retry", () => modelBaseUrl("direct-review"))).toBe("http://100.92.77.66:8010/v1");
    expect(configuredModel("direct-review")).toBe("qwen3.8-flash-next");
  });
});
it("프로필·키워드 검증·소개 wire 는 순위 모델 이름과 경로 한도를 쓰고 단계 풀 모델의 한도는 읽지 않으며, 옛 게이트웨이 클라이언트는 보내지 않는다", async () => {
  // 단계 풀에 토큰 상한 128·시간 10초짜리 모델을 골라 두어도(PR B 전의 선택) 순위 범위의 wire 는 순위의 모델 이름과 경로 한도(routes.limits)를 쓴다
  const registry = readModelRegistry(), source = registry.models.find(row => row.key === "mlx:text")!;
  registry.models.push({ ...source, key: "fixture:text", equipment: "fixture", gatewayLabel: "fixture", baseUrl: "http://fixture.test/v1",
    model: "fixture-text", timeoutMs: 10_000, maxTokens: 128, purposes: ["fixture-text"] });
  vi.stubEnv("MODEL_REGISTRY_CONFIG", JSON.stringify(registry));
  vi.stubEnv("ABCLLM_API_KEY", "fixture-key");
  const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: "fixture output" } }] })));
  const evidence = { name: "Doc", url: "https://doc.test", category: "Tools", topics: "", tagline: "Document tool", pageText: "Document management", readme: "", evidenceLevel: "thin" as const };
  const tagline = { name: "Doc", url: "https://doc.test", topics: [], language: "TypeScript", pageTitle: "Doc", pageText: "Document management", readme: "" };
  // 세 경로의 순위 범위를 겹쳐 연다(경로마다 하나)
  const ranked = (run: () => Promise<void>) => inTextRank("product-search-profile", RANK_MODEL, () => inTextRank("product-search-verify", RANK_MODEL,
    () => inTextRank("crawl-tagline", RANK_MODEL, run)));
  await withAdminStagePools({ "product-search-profile": ["fixture:text"], "product-search-verify": ["fixture:text"], "crawl-tagline": ["fixture:text"] }, "fixture", () => ranked(async () => {
    const wires = [profileGatewayWire(evidence, textTaskModel("product-search-profile")),
      searchVerifyGatewayWire({ evidence, keywords: ["document tool"] }, textTaskModel("product-search-verify")),
      crawlTaglineGatewayWire(tagline, textTaskModel("crawl-tagline"))];
    expect(wires.map(wire => JSON.parse(wire)).map(body => [body.model, body.max_tokens])).toEqual([[RANK_MODEL, 500], [RANK_MODEL, 3_000], [RANK_MODEL, 400]]);
    expect(["product-search-profile", "product-search-verify", "crawl-tagline"].map(route => modelRequestBudget(route).maxTokens)).toEqual([500, 3_000, 400]);
    expect(modelRouteTimeoutMs("product-search-profile")).toBe(45_000);
    expect(await writeKeywords(evidence, { timeoutMs: 30_000, request })).toEqual({ ok: false, error: "no_key" });
    expect(await verifyKeywords({ evidence, keywords: ["document tool"] }, { timeoutMs: 30_000, request })).toEqual({ ok: false, error: "no_key" });
    expect(await writeTagline(tagline, { timeoutMs: 30_000, request })).toEqual({ ok: false, error: "no_key" });
  }));
  expect(request).not.toHaveBeenCalled();
});
