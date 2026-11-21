import { describe, expect, it } from "vitest";
import { OPENAI_CHAT_TOTAL_BOUND_PROTOCOL } from "@/lib/llm/direct-serving-contract";
import { engineRouteContract, ENGINE_CONNECT_ROUTES } from "@/lib/operations/admin-engine-connect";
import { servingContractHash, validateAdminServingContract } from "@/lib/operations/admin-serving-contracts";
import { DIRECT_SHAPE_SAVE_EXCLUDED_ROUTES, engineContractShape, engineContractShapeText, isTotalBoundShape, routeContractState,
  TOTAL_BOUND_PROTOCOL_NAME } from "@/lib/operations/engine-contract-shape";
import { conversionRefusalText, totalBoundContractFromAbcllm } from "@/lib/operations/serving-contract-convert";
import { abcllmContract, TOTAL_BOUND_ROUTES, totalBoundContract, type TotalBoundRoute } from "./total-bound-direct-fixture";

/**
 * 2026-11-21 abcllm 이름표 정리 2단계 — abcllm 계약 → 엔진 직접 총량 상한 계약 옮겨 적기(순수)와 저장이 새로 만드는 계약 모양.
 * 옮겨 적기는 장부 이름(model)·엔진 이름·주소·상한·추론 여유·429 쉼 정책을 글자 그대로 두고, 담지 못하는 것은 거절한다.
 */
const BACKOFF = { initialBackoffMs: 60_000, maxBackoffMs: 600_000, honorQuotaHeaders: true };
/** 그 경로의 abcllm 계약이 받는 선택 칸 — 경로 스키마가 받는 것만(받지 않는 칸은 abcllm 모양 검사에서 이미 거절된다) */
const EXTRAS: Partial<Record<TotalBoundRoute, Record<string, unknown>>> = {
  "reason-translate": { engineModel: "engine-name", reasoningTokenReserve: 2048 },
  "product-tagline-ko": { engineModel: "engine-name", reasoningTokenReserve: 1024, rateLimitBackoff: BACKOFF },
  "crawl-tagline": { engineModel: "engine-name" }, "product-search-profile": { engineModel: "engine-name" },
};

describe("abcllm 계약 → 엔진 직접 총량 상한 계약", () => {
  it.each(TOTAL_BOUND_ROUTES.map(route => [route] as const))("%s: 같은 주소·장부 이름·상한·선택 칸으로 옮기고 엄격 terminal 표시는 버린다", routeId => {
    const extra = EXTRAS[routeId] ?? {};
    const old = abcllmContract(routeId, { model: "ledger-name@1a2b3c4d", extra });
    // 옛 계약은 그 경로 스키마를 그대로 지난다(시험 재료가 운영 모양과 같은지)
    expect(validateAdminServingContract(routeId, old).ok).toBe(true);
    const mapped = totalBoundContractFromAbcllm(routeId, old);
    expect(mapped).toMatchObject({ ok: true });
    if (!mapped.ok) return;
    const expected = validateAdminServingContract(routeId, totalBoundContract(routeId, { model: "ledger-name@1a2b3c4d", extra }));
    expect(expected.ok).toBe(true);
    // 칸 순서까지 경로 스키마의 결과와 같다 — hash 가 같다
    expect(mapped.contract).toEqual(expected.ok ? expected.contract : null);
    expect(servingContractHash(mapped.contract)).toBe(servingContractHash(expected.ok ? expected.contract : {}));
    expect(mapped.contract).toMatchObject({ protocol: OPENAI_CHAT_TOTAL_BOUND_PROTOCOL, provider: "local-direct", model: "ledger-name@1a2b3c4d",
      endpoint: old.endpoint, totalTokenBound: old.totalTokenBound, deploymentRevision: old.deploymentRevision, responseModel: old.responseModel, ...extra });
    expect(mapped.contract).not.toHaveProperty("strictTerminalOptIn");
    expect(Object.keys(mapped.contract).some(key => ["backendId", "physicalGroup", "tokenizerEndpoint"].includes(key))).toBe(false);
  });

  it("2차 requestBudget 은 tokenizer 묶음 + maxOutputTokens 로 옮긴다; tokenizer 이름이 엔진 이름과 다르면 거절한다", () => {
    const budget = { requestTokenBound: 32_000, maxOutputTokens: 4096, tokenizerEndpoint: "http://engine.test:8000/tokenize", tokenizerModel: "fixture-model" };
    const mapped = totalBoundContractFromAbcllm("second-review", abcllmContract("second-review", { extra: { requestBudget: budget } }));
    expect(mapped).toMatchObject({ ok: true, contract: { maxOutputTokens: 4096, tokenizer: { endpoint: budget.tokenizerEndpoint, requestTokenBound: 32_000 } } });
    // engineModel 이 있으면 tokenizer 이름은 그것과 같아야 한다
    expect(totalBoundContractFromAbcllm("second-review", abcllmContract("second-review", { model: "fixture-model@1a2b3c4d",
      extra: { engineModel: "fixture-model", requestBudget: budget } }))).toMatchObject({ ok: true });
    const differs = totalBoundContractFromAbcllm("second-review", abcllmContract("second-review", { extra: { requestBudget: { ...budget, tokenizerModel: "alias-name" } } }));
    expect(differs).toEqual({ ok: false, reason: "tokenizer_model_differs", detail: "alias-name ≠ fixture-model" });
    if (!differs.ok) expect(conversionRefusalText(differs)).toContain("tokenizer 이름이 엔진에 보내는 이름과 다릅니다");
    // tokenizer 가 다른 origin 이면 새 모양 검사가 거절한다
    expect(totalBoundContractFromAbcllm("second-review", abcllmContract("second-review", { extra: { requestBudget: { ...budget,
      tokenizerEndpoint: "http://other.test:8000/tokenize" } } }))).toMatchObject({ ok: false, reason: "new_shape_invalid" });
  });

  it("abcllm 이 아니거나 모르는 칸이 있으면 옮기지 않는다", () => {
    expect(totalBoundContractFromAbcllm("crawl-tagline", totalBoundContract("crawl-tagline"))).toEqual({ ok: false, reason: "not_abcllm" });
    expect(totalBoundContractFromAbcllm("crawl-tagline", abcllmContract("product-search-profile"))).toEqual({ ok: false, reason: "not_abcllm" });
    expect(totalBoundContractFromAbcllm("crawl-tagline", { ...abcllmContract("crawl-tagline"), gatewayLabel: "x", note: "y" }))
      .toEqual({ ok: false, reason: "unmapped_field", detail: "gatewayLabel,note" });
    expect(totalBoundContractFromAbcllm("crawl-tagline", null)).toEqual({ ok: false, reason: "not_abcllm" });
  });
});

describe("저장이 새로 만드는 엔진 직접 계약", () => {
  it("새 모양은 관문이 열리고 그 경로에 켜진 abcllm 계약이 없을 때만(전환 뒤·새 경로) — 전환 전·일부만 옮긴 경로는 abcllm 형", () => {
    expect(TOTAL_BOUND_PROTOCOL_NAME).toBe(OPENAI_CHAT_TOTAL_BOUND_PROTOCOL);
    expect(DIRECT_SHAPE_SAVE_EXCLUDED_ROUTES).toEqual(["second-review"]);
    const abcllm = { routeId: "crawl-tagline", provider: "abcllm", protocol: "abcllm-crawl-tagline-total-bound-v1" };
    const direct = { routeId: "crawl-tagline", provider: "local-direct", protocol: OPENAI_CHAT_TOTAL_BOUND_PROTOCOL };
    const other = [{ routeId: "cli:opencode-cli:crawl-tagline", provider: "abcllm" }, { routeId: "local-direct:crawl-tagline", provider: "local-direct" },
      { routeId: "crawl-tagline", provider: "local-direct", protocol: "direct-openai-chat-v1" }];
    const state = (...rows: Record<string, unknown>[]) => routeContractState([...rows, ...other] as never, "crawl-tagline");
    const fresh = state(), unconverted = state(abcllm, abcllm), partial = state(abcllm, direct), converted = state(direct, direct);
    expect([fresh, unconverted, partial, converted]).toEqual([{ abcllm: 0, direct: 0 }, { abcllm: 2, direct: 0 }, { abcllm: 1, direct: 1 }, { abcllm: 0, direct: 2 }]);
    // 관문이 열려 있어도 전환 전·일부만 옮긴 경로는 abcllm 형 — 전환 도구가 경로를 끝까지 옮긴 뒤나 새 경로만 새 모양
    expect(engineContractShape("crawl-tagline", true, unconverted)).toEqual({ provider: "abcllm", reason: "route_unconverted" });
    expect(engineContractShape("crawl-tagline", true, partial)).toEqual({ provider: "abcllm", reason: "route_unconverted" });
    expect(engineContractShape("crawl-tagline", true, converted)).toEqual({ provider: "local-direct", reason: null });
    expect(engineContractShape("crawl-tagline", true, fresh)).toEqual({ provider: "local-direct", reason: null });
    expect(engineContractShape("crawl-tagline", false, converted)).toEqual({ provider: "abcllm", reason: "gate_closed" });
    // 새 경로라도 2차·CLI 엔진은 abcllm 형, 전환 도구로 옮긴 경로면 새 모양
    expect(engineContractShape("second-review", true, fresh)).toEqual({ provider: "abcllm", reason: "excluded" });
    expect(engineContractShape("crawl-publish-classify", true, fresh, true)).toEqual({ provider: "abcllm", reason: "excluded" });
    expect(engineContractShape("second-review", true, converted)).toEqual({ provider: "local-direct", reason: null });
    expect(engineContractShape("crawl-publish-classify", true, converted, true)).toEqual({ provider: "local-direct", reason: null });
    expect(engineContractShapeText("crawl-tagline", engineContractShape("crawl-tagline", true, partial), partial))
      .toContain("crawl-tagline: 이 경로는 아직 전환 전 — abcllm 모양으로 저장합니다(켜진 abcllm 계약 1개)");
    expect(engineContractShapeText("crawl-tagline", engineContractShape("crawl-tagline", false, fresh), fresh)).toBeNull();
    expect(isTotalBoundShape({ provider: "local-direct", protocol: OPENAI_CHAT_TOTAL_BOUND_PROTOCOL })).toBe(true);
    expect(isTotalBoundShape({ provider: "local-direct", protocol: "direct-openai-chat-v1" })).toBe(false);
    expect(isTotalBoundShape({ provider: "abcllm", protocol: OPENAI_CHAT_TOTAL_BOUND_PROTOCOL })).toBe(false);
  });

  it.each(ENGINE_CONNECT_ROUTES.map(route => [route] as const))("%s: 새 모양은 주소·모델·상한만 — 장비 이름 없는 리비전, engineModel, 받는 경로만 추론 여유", routeId => {
    const endpoint = "http://engine.test:8000/v1/chat/completions";
    const direct = engineRouteContract(routeId, "ledger@1a2b3c4d", "served", endpoint, 65_536, "m3-mlx", "operator", "engine-name", 2048, "local-direct");
    expect(direct).not.toBeNull();
    expect(direct).toMatchObject({ protocol: OPENAI_CHAT_TOTAL_BOUND_PROTOCOL, provider: "local-direct", routeId, model: "ledger@1a2b3c4d", engineModel: "engine-name",
      responseModel: "served", endpoint, totalTokenBound: 65_536, deploymentRevision: "direct-ledger@1a2b3c4d-C65536-operator-bound" });
    expect(String(direct!.deploymentRevision)).not.toContain("m3-mlx");
    expect(direct).not.toHaveProperty("strictTerminalOptIn");
    expect("reasoningTokenReserve" in direct!).toBe(["reason-translate", "product-tagline-ko"].includes(routeId));
    // abcllm 형은 예전 그대로(장비 이름 리비전)
    const gateway = engineRouteContract(routeId, "plain-model", "served", endpoint, 65_536, "m3-mlx", "engine");
    expect(gateway).toMatchObject({ provider: "abcllm", deploymentRevision: "direct-m3-mlx-plain-model-C65536" });
  });
});
