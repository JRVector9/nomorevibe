import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withAdminStagePools, withAdminModelStage, validateAdminStagePools } from "@/lib/llm/admin-model-pools";
import { configuredModel, modelBaseUrl, readModelRegistry, scopedModel, scopedModelBaseUrl, scopedRequestTimeout } from "@/lib/llm/model-registry";
import { reasonTranslationGatewayWire, SEARCH_QUERY_MODEL, TRANSLATE_MODEL, textHash, translateToKorean } from "@/lib/crawl/translate";
import { PROFILE_MODEL, profileGatewayWire, writeKeywords } from "@/lib/domain/products/search-profile";
import { searchVerifyGatewayWire, VERIFY_MODEL, verifyKeywords } from "@/lib/domain/products/search-verify";
import { crawlTaglineGatewayWire, TAGLINE_MODEL, writeTagline } from "@/lib/crawl/tagline";
import { translateReasonsWithModelCapacity } from "@/lib/crawl/reason-translation-model-capacity";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
const control = vi.hoisted(() => vi.fn());
vi.mock("@/lib/llm/capacity-repository", () => ({ readModelCapacityCallerControl: control }));
beforeEach(() => { control.mockReset().mockResolvedValue({ mode: "disabled" }); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); setServingContractSnapshotForTest(null); });

it("기존 설정과 빈 풀은 환경 기본값을 보존한다", () => {
  const before = configuredModel("reason-translate");
  expect(withAdminStagePools({}, "fixture", () => configuredModel("reason-translate"))).toBe(before);
  expect(withAdminStagePools({ "reason-translate": [] }, "fixture", () => configuredModel("reason-translate"))).toBe(before);
});
it("등록부의 같은 어댑터 모델을 선택하고 임의 키·제공자 변경·중복을 거절한다", () => {
  expect(validateAdminStagePools({ "reason-translate": ["mlx:text", "supa:review"] })).toEqual({ "reason-translate": ["mlx:text", "supa:review"] });
  for (const pools of [{ "reason-translate": ["connect:sonnet"] }, { "reason-translate": ["none:missing"] },
    { "reason-translate": ["mlx:text", "mlx:text"] }, { "unknown-stage": ["mlx:text"] }])
    expect(() => validateAdminStagePools(pools)).toThrow();
});
it("저장한 번역 선택은 같은 환경변수를 공유하는 검색 질의 모델을 바꾸지 않는다", () => {
  withAdminStagePools({ "reason-translate": ["supa:review"] }, "fixture", () => {
    expect(configuredModel("reason-translate")).toBe("[supa] Qwen3.8-27B-NVFP4");
    expect(scopedModel("search-query-translate", SEARCH_QUERY_MODEL)).toBe(SEARCH_QUERY_MODEL);
  });
});
it("저장한 선택이 번역 wire 이름과 등록부 주소를 정하고, 옛 게이트웨이 번역 클라이언트는 보내지 않는다", async () => {
  // 게이트웨이(abcLLM)는 2026-10-30 제거됐다 — 옛 클라이언트는 no_key 로 끝나고, 선택한 이름은 용량 경로의 wire·직접 연결 계약 조회에 쓰인다
  const registry = readModelRegistry();
  registry.models = registry.models.map(model => model.key === "supa:review" ? { ...model, baseUrl: "http://supa-fixture.test:8010/v1" } : model);
  vi.stubEnv("MODEL_REGISTRY_CONFIG", JSON.stringify(registry));
  vi.stubEnv("ABCLLM_BASE_URL", "http://old-fixture.test/v1");
  vi.stubEnv("ABCLLM_API_KEY", "fixture-key");
  const request = vi.fn();
  await withAdminStagePools({ "reason-translate": ["supa:review"] }, "fixture", async () => {
    const model = scopedModel("reason-translate", TRANSLATE_MODEL);
    expect(model).toBe("[supa] Qwen3.8-27B-NVFP4");
    expect(JSON.parse(reasonTranslationGatewayWire(["Document tool"], model)).model).toBe("[supa] Qwen3.8-27B-NVFP4");
    expect(scopedModelBaseUrl("reason-translate", "http://fallback.test/v1", "abcllm")).toBe("http://supa-fixture.test:8010/v1");
    expect(await translateToKorean(["Document tool"], 1000, request)).toEqual({ ok: false, error: "no_key" });
  });
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
  expect(await Promise.all([first, second])).toEqual(["[supa] Qwen3.8-27B-NVFP4", "[MLX] gpt-oss-120b"]);
  expect(configuredModel("reason-translate")).toBe(original);
});
it("같은 업무 배정은 같은 모델·주소를 유지하고 여러 배정은 풀을 나눠 쓴다", () => {
  const pools = { "reason-translate": ["supa:review", "mlx:text"] };
  const results = Array.from({ length: 30 }, (_, i) => withAdminStagePools(pools, String(i), () => configuredModel("reason-translate")));
  expect(new Set(results).size).toBe(2);
  expect(withAdminStagePools(pools, "0", () => configuredModel("reason-translate"))).toBe(results[0]);
  expect(withAdminStagePools({ "product-translate": ["m1:translation"] }, "fixture", () => modelBaseUrl("product-translate"))).toBe("https://abcllm-api.brut.bot/v1");
});
it("공통 용량 제어가 켜져 있으면 새 선택도 정식 dispatch 계약 없이 호출하지 않는다", async () => {
  control.mockResolvedValue({ mode: "draining" });
  // 선택한 모델에 엔진 직접 연결 계약이 있어 용량 경로에 들어선다 — 그래도 draining 이면 보내지 않고 미룬다
  setServingContractSnapshotForTest([{ routeId: "reason-translate", model: "[supa] Qwen3.8-27B-NVFP4", contract: null, auth: "none", apiKey: null, transport: "direct" }]);
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network_not_allowed"));
  const batch = [{ hash: textHash("Document tool"), body: "Document tool", attempts: 0 }];
  await expect(withAdminStagePools({ "reason-translate": ["supa:review"] }, "fixture",
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
it("프로필·키워드 검증·소개도 선택한 wire 이름·주소·토큰 상한·시간을 쓰고, 옛 게이트웨이 클라이언트는 보내지 않는다", async () => {
  const registry = readModelRegistry(), source = registry.models.find(row => row.key === "mlx:text")!;
  registry.models.push({ ...source, key: "fixture:text", equipment: "fixture", gatewayLabel: "fixture", baseUrl: "http://fixture.test/v1",
    model: "fixture-text", timeoutMs: 10_000, maxTokens: 128, purposes: ["fixture-text"] });
  vi.stubEnv("MODEL_REGISTRY_CONFIG", JSON.stringify(registry));
  vi.stubEnv("ABCLLM_API_KEY", "fixture-key");
  const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: "fixture output" } }] })));
  const evidence = { name: "Doc", url: "https://doc.test", category: "Tools", topics: "", tagline: "Document tool", pageText: "Document management", readme: "", evidenceLevel: "thin" as const };
  const tagline = { name: "Doc", url: "https://doc.test", topics: [], language: "TypeScript", pageTitle: "Doc", pageText: "Document management", readme: "" };
  await withAdminStagePools({ "product-search-profile": ["fixture:text"], "product-search-verify": ["fixture:text"], "crawl-tagline": ["fixture:text"] }, "fixture", async () => {
    // 용량 경로가 보내는 wire(각 wire 빌더)에 선택한 이름과 토큰 상한이 들어간다
    const wires = [profileGatewayWire(evidence, scopedModel("product-search-profile", PROFILE_MODEL)),
      searchVerifyGatewayWire({ evidence, keywords: ["document tool"] }, scopedModel("product-search-verify", VERIFY_MODEL)),
      crawlTaglineGatewayWire(tagline, scopedModel("crawl-tagline", TAGLINE_MODEL))];
    for (const wire of wires) expect(JSON.parse(wire)).toMatchObject({ model: "[fixture] fixture-text", max_tokens: 128 });
    for (const route of ["product-search-profile", "product-search-verify", "crawl-tagline"])
      expect(scopedModelBaseUrl(route, "http://fallback.test/v1", "abcllm")).toBe("http://fixture.test/v1");
    expect(scopedRequestTimeout("product-search-profile", 30_000)).toBe(10_000);
    expect(await writeKeywords(evidence, { timeoutMs: 30_000, request })).toEqual({ ok: false, error: "no_key" });
    expect(await verifyKeywords({ evidence, keywords: ["document tool"] }, { timeoutMs: 30_000, request })).toEqual({ ok: false, error: "no_key" });
    expect(await writeTagline(tagline, { timeoutMs: 30_000, request })).toEqual({ ok: false, error: "no_key" });
  });
  expect(request).not.toHaveBeenCalled();
});
