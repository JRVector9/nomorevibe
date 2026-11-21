import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import "@/lib/crawl/agent-review-serving-contract";
import "@/lib/crawl/second-review-serving-contract";
import { bindReviewTaskRank } from "@/lib/crawl/review-task-ranks";
import { reviewWithGateway, textRedirect, textWireFor } from "@/lib/crawl/agent-review-gateway";
import { crawlTaglineGatewayWire } from "@/lib/crawl/tagline";
import { productTaglineKoGatewayWire, productTranslationGatewayWire, reasonTranslationGatewayWire, websearchQueryGatewayWire } from "@/lib/crawl/translate";
import { profileGatewayWire } from "@/lib/domain/products/search-profile";
import { searchVerifyGatewayWire } from "@/lib/domain/products/search-verify";
import { bindApiTaskRank, type AiTaskRank } from "@/lib/llm/ai-task-resolver";
import { setAiTaskModelsForTest } from "@/lib/llm/ai-task-models-snapshot";
import { cliEngineEndpoint, cliEngineRevision } from "@/lib/llm/cli-engine-config";
import { OPENAI_CHAT_TOTAL_BOUND_PROTOCOL, servingContractWireModel } from "@/lib/llm/direct-serving-contract";
import { setServingContractSnapshotForTest, textRouteAccess } from "@/lib/llm/serving-contract-store";
import { servingContractHash, validateAdminServingContract } from "@/lib/operations/admin-serving-contracts";
import { LIMITS_TASKS } from "@/lib/operations/admin-limits-view";
import { TEST_CONNECTION_ID, TEST_TEXT_BASE_URL, textRankRow } from "./text-task-ranks-fixture";
import { abcllmContract, contractRow, prepareRouteCall, queryInput, reasonTexts, reviewInput, STRICT_TERMINAL_ROUTES, taglineEvidence, taglineKoItems,
  TOTAL_BOUND_ROUTES, totalBoundContract, translationItems, verifyItem, profileEvidence, type TotalBoundRoute } from "./total-bound-direct-fixture";

/**
 * 2026-11-21 abcllm 이름표 정리 1단계 — 엔진 직접 총량 상한 계약(openai-chat-total-bound-v1, provider local-direct).
 * - 열 경로의 스키마가 새 모양을 추가로 받는다. 저장된 옛 두 모양(abcllm 총량 상한·direct-openai-chat-v1)의 hash 는 한 바이트도 바뀌지 않는다.
 * - 새 모양의 wire 는 그 경로가 abcllm 계약으로 보내는 바이트에서 게이트웨이 전용 칸 context_strategy 하나만 뺀 것이다(2단계, 소유자 결정 D-6).
 *   그 칸이 없는 경로(번역 4경로·카테고리 분류)는 바이트까지 같다. 실제 준비 함수의 wireHash 로 견준다.
 * 운영 값이 아니다(모양만 맞춘 고정 fixture).
 */
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const shaBytes = (value: string) => createHash("sha256").update(value).digest("hex");
/** D-6 이 빼는 칸 하나만 뺀 같은 바이트(나머지 칸 순서 그대로) — 기대값을 시험 쪽에서 따로 만든다 */
const withoutContextStrategy = (wire: string): string => {
  const body = JSON.parse(wire) as Record<string, unknown>;
  delete body.context_strategy;
  return JSON.stringify(body);
};
/** abcllm 계약의 wire 가 context_strategy 를 싣는 경로 — 게이트웨이 raw 심사 wire 를 쓰는 둘과 그 칸을 직접 적는 text 셋 */
const CONTEXT_STRATEGY_ROUTES: ReadonlySet<TotalBoundRoute> = new Set(["crawl-agent-review", "second-review", "product-search-profile",
  "crawl-tagline", "product-search-verify"]);
/**
 * 같은 엔진의 abcllm 계약이 보내는 바이트를 그 경로의 wire 함수로 따로 만든다(시험이 준비 함수의 wireHash 와 견줘 같은 바이트임을 먼저 확인한다).
 * 심사 두 경로는 게이트웨이 raw wire(비공개 함수)를 reviewWithGateway 가 보내는 본문으로 받는다. 카테고리 분류의 wire 함수는 비공개라 null 이다
 * (그 경로는 wireHash 가 그대로임으로 본다).
 */
async function abcllmWireBytes(routeId: TotalBoundRoute, engine: string, extra: Record<string, unknown>): Promise<string | null> {
  const reserve = typeof extra.reasoningTokenReserve === "number" ? extra.reasoningTokenReserve : 0;
  switch (routeId) {
    case "crawl-agent-review": case "second-review": {
      let sent: string | null = null;
      const capture = (async (_url: unknown, init?: RequestInit) => { sent = String(init?.body); throw new Error("captured"); }) as unknown as typeof fetch;
      await reviewWithGateway(reviewInput(), { model: engine, endpoint: { baseUrl: "http://engine.test:8000/v1", apiKey: null }, request: capture });
      return sent;
    }
    case "product-search-profile": return profileGatewayWire(profileEvidence(), engine);
    case "product-search-verify": return searchVerifyGatewayWire(verifyItem(), engine);
    case "crawl-tagline": return crawlTaglineGatewayWire(taglineEvidence(), engine);
    case "reason-translate": return reasonTranslationGatewayWire(reasonTexts(), engine, reserve);
    case "product-translate": return productTranslationGatewayWire(translationItems(), engine);
    case "product-tagline-ko": return productTaglineKoGatewayWire(taglineKoItems(), engine, reserve);
    case "search-query-translate": return websearchQueryGatewayWire(queryInput(), engine);
    case "crawl-publish-classify": return null;
  }
}
/**
 * 새 모양의 기본 계약(선택 칸 없음, model fixture-model)이 보내는 wire 바이트의 sha256 — 이 PR(2단계, D-6)의 코드로 계산해 박았다.
 * 경로의 프롬프트·출력 상한이 바뀌면 함께 바뀐다(그때는 abcllm 계약의 바이트도 바뀐다 — 아래 견줌이 둘의 관계를 따로 지킨다).
 */
const NEW_WIRE_SHA: Readonly<Record<TotalBoundRoute, string>> = {
  // 심사 두 경로는 같은 raw 심사 wire 다(같은 입력·같은 모델)
  "crawl-agent-review": "cea9b64daca663aba96691ea3af9a409edfb1b273c158dbeb9b207ecdede4fa5",
  "second-review": "cea9b64daca663aba96691ea3af9a409edfb1b273c158dbeb9b207ecdede4fa5",
  "product-search-profile": "7e542375b5f57bab0a1e2c8151fe90dc405e1d15e5782565fae2a008b084750e",
  "crawl-tagline": "647e0c92ae471d6eb9a0ed1fe98b8dbe9d776c748c36aeef1fadaad2e589465e",
  "product-search-verify": "d1215309343e2a6fcde9afee57b6d3f932bd139be1a4aeb19de0cbd236d2fd72",
  "reason-translate": "c8913e18897e0e077c3753c7bf079ca70ce69a6e024ff7d82df9fb4335e4fe47",
  "product-translate": "83c70fe49023f854aa89e4f878761ce4b028657a21e8c755a4b1de64e41e0e1c",
  "product-tagline-ko": "e31372a9d7e4a91c89ceffb6cc3fde9888ce5157a155862f271044aa53c5c7e4",
  "search-query-translate": "281d1e8af8e5db4a031e40f21913594986f7dcf1664c7f422234901f3147244e",
  "crawl-publish-classify": "0eb25431da61b430beac159a1d7e98e3d525d288ba0fcf8c7e34ab5f5b70391c",
};
const adminHash = (routeId: string, contract: unknown) => {
  const checked = validateAdminServingContract(routeId, contract);
  if (!checked.ok) throw new Error(`${routeId}:${checked.reason}`);
  return servingContractHash(checked.contract);
};
const reversed = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).reverse());
afterEach(() => { setServingContractSnapshotForTest(null); setAiTaskModelsForTest(null); });

/**
 * 이 PR 과 무관하게 계산한 값이다 — 아래 fixture 를 스키마 칸 순서로 적은 객체의 sha256(JSON.stringify(…))(node 만으로 계산).
 * 이 PR 직전 코드(origin/main c390c6b7)에서도 같은 fixture 가 같은 값이었다(같은 시험을 그 코드로 돌려 확인).
 */
const BEFORE: Readonly<Record<TotalBoundRoute, { gateway: string; direct: string }>> = {
  "crawl-agent-review": { gateway: "4c2adb85bda877452955582595137439c31133cf01458fe6e2a687f4bc4773d2", direct: "7e0f78531073368f8ebc8baabd503753924f48f6feeb21b7774ea787e6626d6c" },
  "second-review": { gateway: "4c0f97249ae629f68e8515899e8f20c9daf0a1807404bf07589a3611934dbde6", direct: "d5977f16c19b8cb53bca99b8485f5af9e9c7c02783e72ae0b8f15dc6d7172d25" },
  "product-search-profile": { gateway: "089a111f0f1b4e037004e70aff6a1cee6332a95c824c9094d1beab77c216ca3a", direct: "39fd24727d315f73ad1db5a8e01aff897be318fb9cb6644ec69f43f9382e1d50" },
  "crawl-tagline": { gateway: "5cd731f307df1c2c253a50f500425ae94c6e32b791c97a2cb3298ed1e7b8fc3f", direct: "b95e7231cc0b529193f47194e6e89971d9ff1363bf8f7c2d745a7ae3e56b666e" },
  "product-search-verify": { gateway: "b9e6c1ceeaa33b18f2b549e56ca1a9b541ce1bcbab4b6f8d3dcfc35c24c3e685", direct: "3bb993c7ed65e6135eedf5869c6179746b08993ff55e460b6fd454fc07f02094" },
  "reason-translate": { gateway: "1e383371854d4f46dacf7c729d079871155615b408ac21b166596232ed5d7d4b", direct: "e30e46f6e000faac00c41f42863f26eb6b606c8c8438548cb922cac46f8c5c4e" },
  "product-translate": { gateway: "70ec3469350e1083c8dd6bcb2f6486169eb3da1e1f05d43dc564f172f0e25fab", direct: "b4cb936191bb02878e2028909a48da4b0e7a738592c1aacfef277c3fa950e885" },
  "product-tagline-ko": { gateway: "0a6db0d4610cce53ac9d0d940ddd9c24cbd3ce824786d98d2e21c64af331030d", direct: "1c2125b2083438ba8402465ec755327d7454f3db33bc0b9296ca178dca021bbd" },
  "search-query-translate": { gateway: "29edf78d09c6e026447192bad0d615a7d1c94c75d8ac15cc8fd1f8f9a6820bae", direct: "b1f24e20e044a003735c45fb98a475c56ca0d71e38e7691deb65929de1c28b37" },
  "crawl-publish-classify": { gateway: "f7ef932e21cc486b17d28819ebd179cabba07c22281e873e44f2c4bfe97428d9", direct: "bec1e8737cf0d230d4ece9fdd90543ba4152b1518f15f3ef80b45311ee304914" },
};
/** 저장된 abcllm 계약 — 그 경로가 받는 선택 칸을 모두 채운 것(스키마 칸 순서). */
function storedGateway(routeId: TotalBoundRoute): Record<string, unknown> {
  return abcllmContract(routeId, { model: "fixture-model@0b0c0d0e", deploymentRevision: "direct-fixture-C65536", extra: { engineModel: "fixture-model",
    ...(routeId === "reason-translate" || routeId === "product-tagline-ko" ? { reasoningTokenReserve: 2048 } : {}),
    ...(routeId === "product-tagline-ko" ? { rateLimitBackoff: { initialBackoffMs: 60_000, maxBackoffMs: 600_000, honorQuotaHeaders: true } } : {}) } });
}
const storedDirect = (routeId: TotalBoundRoute): Record<string, unknown> => ({ version: 1, protocol: "direct-openai-chat-v1", routeId, provider: "local-direct",
  model: "fixture-engine", responseModel: "served-fixture", deploymentRevision: "engine-fixture;C=50000", endpoint: "http://engine.test:8000/v1/chat/completions",
  tokenizerEndpoint: "http://engine.test:8000/tokenize", backendId: "fixture-backend", physicalGroup: "fixture-device", totalTokenBound: 50_000,
  requestTokenBound: 32_000, maxOutputTokens: 4096 });

describe.each(TOTAL_BOUND_ROUTES)("%s", routeId => {
  it("keeps the stored abcllm and direct-openai-chat-v1 contract hashes byte-identical", () => {
    expect(adminHash(routeId, storedGateway(routeId))).toBe(BEFORE[routeId].gateway);
    expect(adminHash(routeId, storedDirect(routeId))).toBe(BEFORE[routeId].direct);
    // 칸 순서가 뒤섞인 입력도 스키마 순서로 파싱돼 같은 hash 다
    expect(adminHash(routeId, reversed(storedGateway(routeId)))).toBe(BEFORE[routeId].gateway);
    expect(adminHash(routeId, reversed(storedDirect(routeId)))).toBe(BEFORE[routeId].direct);
  });

  it("accepts openai-chat-total-bound-v1 with a fixed field order and no device-name or gateway field", () => {
    const full = totalBoundContract(routeId, { extra: { engineModel: "fixture-engine", maxOutputTokens: 4096,
      tokenizer: { endpoint: "http://engine.test:8000/tokenize", requestTokenBound: 32_000 } } });
    const checked = validateAdminServingContract(routeId, reversed(full));
    expect(checked).toMatchObject({ ok: true });
    if (!checked.ok) throw new Error("expected_valid");
    expect(Object.keys(checked.contract)).toEqual(["version", "protocol", "routeId", "provider", "model", "responseModel", "deploymentRevision", "endpoint",
      "totalTokenBound", "engineModel", "maxOutputTokens", "tokenizer"]);
    expect(checked.contract).toMatchObject({ protocol: OPENAI_CHAT_TOTAL_BOUND_PROTOCOL, provider: "local-direct" });
    expect(adminHash(routeId, full)).toBe(sha(checked.contract));
    // 필수 칸만 있는 계약도 열리고, 번역 4경로도 엄격 terminal 표시 없이 열린다
    expect(Object.keys((validateAdminServingContract(routeId, totalBoundContract(routeId)) as { contract: object }).contract)).toEqual(
      ["version", "protocol", "routeId", "provider", "model", "responseModel", "deploymentRevision", "endpoint", "totalTokenBound"]);
    for (const refused of [{ backendId: "device" }, { physicalGroup: "device" }, { strictTerminalOptIn: "abcllm-strict-terminal-v1" },
      { tokenizerEndpoint: "http://engine.test:8000/tokenize" }, { requestTokenBound: 32_000 }, { requestBudget: {} }, { provider: "abcllm" },
      { routeId: routeId === "crawl-tagline" ? "second-review" : "crawl-tagline" }, { endpoint: "http://engine.test:8000/v1/completions" },
      { tokenizer: { endpoint: "http://other.test:8000/tokenize", requestTokenBound: 32_000 } },
      { tokenizer: { endpoint: "http://engine.test:8000/tokenize", requestTokenBound: 70_000 } },
      { tokenizer: { endpoint: "http://engine.test:8000/tokenize" } },
      { maxOutputTokens: 70_000 }, { maxOutputTokens: 0 }, { tokenizer: { endpoint: "http://engine.test:8000/tokenize", requestTokenBound: 1000 }, maxOutputTokens: 2000 }])
      expect(validateAdminServingContract(routeId, { ...totalBoundContract(routeId), ...refused }), JSON.stringify(refused)).toEqual({ ok: false, reason: "contract_schema_invalid" });
    // 경로마다 받는 선택 칸: 추론 토큰 여유는 사유 번역·한국어 소개, 429 쉼 정책은 한국어 소개만(그 칸을 wire·쉼에 쓰는 경로)
    const reserve = validateAdminServingContract(routeId, totalBoundContract(routeId, { extra: { reasoningTokenReserve: 2048 } }));
    expect(reserve.ok).toBe(routeId === "reason-translate" || routeId === "product-tagline-ko");
    const backoff = validateAdminServingContract(routeId, totalBoundContract(routeId, { extra: { rateLimitBackoff: { initialBackoffMs: 60_000, maxBackoffMs: 600_000 } } }));
    expect(backoff.ok).toBe(routeId === "product-tagline-ko");
  });

  it("prepares today's abcllm wire bytes minus exactly context_strategy for the new shape of the same engine (D-6)", async () => {
    const variants: Record<string, unknown>[] = [{}, { engineModel: "engine-name" }];
    if (routeId === "reason-translate" || routeId === "product-tagline-ko") variants.push({ reasoningTokenReserve: 2048 });
    for (const extra of variants) {
      const label = JSON.stringify(extra), model = extra.engineModel ? "engine-name@0b0c0d0e" : "fixture-model";
      const before = abcllmContract(routeId, { model, extra }), after = totalBoundContract(routeId, { model, extra });
      setServingContractSnapshotForTest([contractRow(before)]);
      const old = await prepareRouteCall(routeId, model, "abcllm");
      // provider 를 주지 않은 준비는 그 선택이 가리키는 계약의 provider 로 열린다(예전 기본값 abcllm 과 같은 결과)
      const oldDefault = routeId === "crawl-publish-classify" ? old : await prepareRouteCall(routeId, model, undefined);
      setServingContractSnapshotForTest([contractRow(after, "gateway")]);
      const next = await prepareRouteCall(routeId, model, "local-direct");
      const nextDefault = routeId === "crawl-publish-classify" || routeId === "crawl-agent-review" ? next : await prepareRouteCall(routeId, model, undefined);
      // 새 계약만 있는 선택을 abcllm 으로 부르면 닫힌다(줄에 서 있던 옛 provider 요청은 보내지지 않는다)
      const stale = await prepareRouteCall(routeId, model, "abcllm");
      expect(stale, label).toEqual({ kind: "unsupported", reason: "provider_contract_unavailable" });
      for (const call of [old, oldDefault, next, nextDefault]) expect(call.kind, label).toBe("prepared");
      if (old.kind !== "prepared" || next.kind !== "prepared" || oldDefault.kind !== "prepared" || nextDefault.kind !== "prepared") throw new Error("prepared_required");
      expect(oldDefault.wireHash).toBe(old.wireHash); expect(nextDefault.wireHash).toBe(next.wireHash);
      // abcllm 계약의 바이트를 경로의 wire 함수로 따로 만들고, 그것이 준비 함수가 묶은 바이트와 같음을 먼저 확인한다
      const oldBytes = await abcllmWireBytes(routeId, typeof extra.engineModel === "string" ? extra.engineModel : model, extra);
      if (oldBytes !== null) expect(shaBytes(oldBytes), label).toBe(old.wireHash);
      if (CONTEXT_STRATEGY_ROUTES.has(routeId)) {
        if (oldBytes === null) throw new Error("abcllm_bytes_required");
        const oldBody = JSON.parse(oldBytes) as Record<string, unknown>, expected = withoutContextStrategy(oldBytes);
        expect(oldBody.context_strategy, label).toBe("raw");
        // 새 wire 의 바이트 = abcllm 바이트에서 그 칸 하나만 뺀 것(나머지 칸의 값·순서 그대로) — sha 가 같으면 바이트가 같다
        expect(next.wireHash, label).toBe(shaBytes(expected));
        expect(next.wireHash, label).not.toBe(old.wireHash);
        const nextBody = JSON.parse(expected) as Record<string, unknown>;
        expect(Object.keys(oldBody).filter(key => !Object.hasOwn(nextBody, key)), label).toEqual(["context_strategy"]);
        expect(Object.keys(nextBody), label).toEqual(Object.keys(oldBody).filter(key => key !== "context_strategy"));
        for (const key of Object.keys(nextBody)) expect(nextBody[key], `${label} ${key}`).toEqual(oldBody[key]);
        // 추론 강도 칸은 남는다(D-6 은 context_strategy 만 뺀다)
        expect(nextBody.reasoning_effort, label).toBe(oldBody.reasoning_effort);
      } else {
        // 그 칸을 싣지 않는 경로: 새 wire 는 abcllm 계약과 바이트까지 같다
        if (oldBytes !== null) expect(Object.hasOwn(JSON.parse(oldBytes), "context_strategy"), label).toBe(false);
        expect(next.wireHash, label).toBe(old.wireHash);
      }
      if (Object.keys(extra).length === 0) expect(next.wireHash, "new-shape wire pin").toBe(NEW_WIRE_SHA[routeId]);
      expect(next).toMatchObject({ model, totalTokenBound: old.totalTokenBound });
      // 계약 hash 는 모양마다 다르다 — binding 이 어느 계약으로 보냈는지 묶는다
      expect(old.servingContractHash).toBe(adminHash(routeId, before)); expect(next.servingContractHash).toBe(adminHash(routeId, after));
      expect(next.servingContractHash).not.toBe(old.servingContractHash);
    }
  });

  it("opens the new shape as a direct engine whatever the row's transport flag says, and sends no strict-terminal marker", () => {
    const contract = totalBoundContract(routeId);
    setServingContractSnapshotForTest([contractRow(contract, "gateway")]);
    expect(textRouteAccess(routeId, "fixture-model", "local-direct")).toEqual({ block: null, bearer: null });
    expect(textRouteAccess(routeId, "fixture-model")).toEqual({ block: null, bearer: null });
    expect(STRICT_TERMINAL_ROUTES.has(routeId) ? "strictTerminalOptIn" in abcllmContract(routeId) : true).toBe(true);
    expect("strictTerminalOptIn" in contract).toBe(false);
  });
});

it("product-translate prepares the same bytes for a ja batch under both shapes", async () => {
  setServingContractSnapshotForTest([contractRow(abcllmContract("product-translate"))]);
  const old = await prepareRouteCall("product-translate", "fixture-model", "abcllm", { locale: "ja" });
  setServingContractSnapshotForTest([contractRow(totalBoundContract("product-translate"))]);
  const next = await prepareRouteCall("product-translate", "fixture-model", "local-direct", { locale: "ja" });
  if (old.kind !== "prepared" || next.kind !== "prepared") throw new Error("prepared_required");
  expect(next.wireHash).toBe(old.wireHash);
});

describe("wire rules of the new shape", () => {
  const build = (model: string) => JSON.stringify({ context_strategy: "raw", model, stream: false, temperature: 0, max_tokens: 900, reasoning_effort: "low",
    chat_template_kwargs: { enable_thinking: false }, messages: [{ role: "user", content: "hi" }] });
  const base = { routeId: "product-search-profile", provider: "local-direct", protocol: OPENAI_CHAT_TOTAL_BOUND_PROTOCOL, model: "ledger-name",
    endpoint: "http://engine.test:8000/v1/chat/completions", totalTokenBound: 65_536, deploymentRevision: "fixture" };
  const gateway = { ...base, provider: "abcllm", protocol: "abcllm-raw-total-bound-v1" };

  it("is the route's own wire minus context_strategy (D-6): reasoning_effort stays, the engine name comes from engineModel, the contract model is the fallback", () => {
    expect(textWireFor(base, "ledger-name", build)).toBe(withoutContextStrategy(build("ledger-name")));
    expect(textWireFor(base, "ledger-name", build)).toBe(withoutContextStrategy(textWireFor(gateway, "ledger-name", build)));
    // abcllm 계약은 예전 바이트 그대로 — 그 칸을 보낸다
    expect(textWireFor(gateway, "ledger-name", build)).toBe(build("ledger-name"));
    expect(JSON.parse(textWireFor(base, "ledger-name", build))).toEqual({ model: "ledger-name", stream: false, temperature: 0, max_tokens: 900,
      reasoning_effort: "low", chat_template_kwargs: { enable_thinking: false }, messages: [{ role: "user", content: "hi" }] });
    expect(textWireFor({ ...base, engineModel: "engine-name" }, "ledger-name", build)).toBe(withoutContextStrategy(build("engine-name")));
    expect(textWireFor({ ...base, engineModel: "engine-name" }, "ledger-name", build))
      .toBe(withoutContextStrategy(textWireFor({ ...gateway, engineModel: "engine-name" }, "ledger-name", build)));
    // local-direct 는 등록부 키로도 고를 수 있다 — 선택 글자가 아니라 계약의 이름이 나간다
    expect(textWireFor(base, "device:registry-key", build)).toBe(withoutContextStrategy(build("ledger-name")));
    // 그 칸이 없는 경로의 wire(번역·분류 꼴)는 바이트까지 그대로다
    const plain = (model: string) => JSON.stringify({ model, stream: false, temperature: 0.1, reasoning_effort: "low", max_tokens: 900, messages: [{ role: "user", content: "hi" }] });
    expect(textWireFor(base, "ledger-name", plain)).toBe(plain("ledger-name"));
    expect(textWireFor(base, "ledger-name", plain)).toBe(textWireFor(gateway, "ledger-name", plain));
    // direct-openai-chat-v1 은 예전 그대로다(게이트웨이 칸을 빼고 thinking 을 끈다)
    const direct = JSON.parse(textWireFor({ ...base, protocol: "direct-openai-chat-v1", maxOutputTokens: 400 }, "ledger-name", build));
    expect(direct).toMatchObject({ model: "ledger-name", max_tokens: 400 }); expect("context_strategy" in direct || "reasoning_effort" in direct).toBe(false);
  });

  it("caps max_tokens only when the contract carries maxOutputTokens", () => {
    expect(textWireFor({ ...base, maxOutputTokens: 400 }, "ledger-name", build))
      .toBe(withoutContextStrategy(JSON.stringify({ ...JSON.parse(build("ledger-name")), max_tokens: 400 })));
    expect(textWireFor({ ...base, maxOutputTokens: 900 }, "ledger-name", build)).toBe(withoutContextStrategy(build("ledger-name")));
    expect(textWireFor({ ...base, maxOutputTokens: 5000 }, "ledger-name", build)).toBe(withoutContextStrategy(build("ledger-name")));
  });

  it("takes a CLI-engine revision the way an abcllm contract does, which direct-openai-chat-v1 still refuses", () => {
    for (const reasoningEffort of [undefined, "high"]) {
      const deploymentRevision = cliEngineRevision({ connectionId: TEST_CONNECTION_ID, ...(reasoningEffort ? { reasoningEffort } : {}) });
      const wire = textWireFor({ ...base, deploymentRevision }, "ledger-name", build);
      const old = textWireFor({ ...gateway, deploymentRevision }, "ledger-name", build);
      // abcllm 형 CLI 엔진 계약은 예전처럼 그 칸을 보내고, 새 모양은 그 칸 하나만 빠진다
      expect(JSON.parse(old).context_strategy).toBe("raw");
      expect(wire).toBe(withoutContextStrategy(old));
      expect(JSON.parse(wire).reasoning_effort).toBe(reasoningEffort);
      expect(() => textWireFor({ ...base, protocol: "direct-openai-chat-v1", maxOutputTokens: 400, deploymentRevision }, "ledger-name", build))
        .toThrow("invalid_cli_engine_revision");
    }
  });

  it("keeps the abcllm redirect handling and names the wire model for rank binding", () => {
    expect(textRedirect(base)).toBe("manual"); expect(textRedirect(gateway)).toBe("manual");
    expect(textRedirect({ ...base, protocol: "direct-openai-chat-v1" })).toBe("error");
    expect(textRedirect({ provider: "local-direct", protocol: "abcllm-raw-total-bound-v1" })).toBe("error");
    expect(servingContractWireModel({ ...base, engineModel: "engine-name" })).toBe("engine-name");
    expect(servingContractWireModel(base)).toBe("ledger-name");
    expect(servingContractWireModel({ ...gateway, engineModel: "engine-name" })).toBe("engine-name");
    // direct-openai-chat-v1 과 1차의 raw local-direct 는 예전처럼 model 뿐이다
    expect(servingContractWireModel({ provider: "local-direct", protocol: "direct-openai-chat-v1", model: "ledger-name", engineModel: "engine-name" })).toBe("ledger-name");
    expect(servingContractWireModel({ provider: "local-direct", protocol: "abcllm-raw-total-bound-v1", model: "ledger-name", engineModel: "engine-name" })).toBe("ledger-name");
  });
});

describe("rank binding", () => {
  const endpoint = `${TEST_TEXT_BASE_URL}/chat/completions`, ledgerName = "engine-name@0b0c0d0e";
  it("binds a text rank to a new-shape contract by its engine model and records provider local-direct", () => {
    const rank = textRankRow("product-translate", "engine-name") as AiTaskRank;
    setServingContractSnapshotForTest([contractRow(totalBoundContract("product-translate", { model: ledgerName, endpoint, extra: { engineModel: "engine-name" } }))]);
    expect(bindApiTaskRank("product-translate", rank)).toMatchObject({ unusable: null,
      binding: { identity: ledgerName, engineModel: "engine-name", provider: "local-direct", connectionId: TEST_CONNECTION_ID } });
    // 같은 연결·모델의 abcllm 계약이 함께 있으면 예전처럼 abcllm 형을 먼저 고른다
    setServingContractSnapshotForTest([contractRow(totalBoundContract("product-translate", { model: ledgerName, endpoint, extra: { engineModel: "engine-name" } })),
      contractRow(abcllmContract("product-translate", { model: "engine-name", endpoint }))]);
    expect(bindApiTaskRank("product-translate", rank)).toMatchObject({ binding: { identity: "engine-name", provider: "abcllm" } });
  });

  it("binds a CLI-engine rank (OpenCode) to a new-shape contract as it does to an abcllm one, and to no other local-direct shape", () => {
    const base = "http://cli-engine.test:3031/v1", secret = "s".repeat(40);
    const row = textRankRow("product-translate", "engine-name", { baseUrl: base, apiKey: secret });
    const rank = { ...row, connection: { ...row.connection, kind: "cli" as const, cliTool: "opencode" } } as unknown as AiTaskRank;
    const extra = { deploymentRevision: cliEngineRevision({ connectionId: TEST_CONNECTION_ID }), endpoint: cliEngineEndpoint(base) };
    const stored = (contract: Record<string, unknown>) => ({ ...contractRow(contract), auth: "stored" as const, apiKey: secret });
    setServingContractSnapshotForTest([stored(totalBoundContract("product-translate", { model: "engine-name", ...extra }))]);
    const next = bindApiTaskRank("product-translate", rank);
    expect(next).toMatchObject({ unusable: null, binding: { identity: "engine-name", engineModel: "engine-name", provider: "local-direct",
      cliEngine: { connectionId: TEST_CONNECTION_ID } } });
    setServingContractSnapshotForTest([stored(abcllmContract("product-translate", { model: "engine-name", ...extra }))]);
    const old = bindApiTaskRank("product-translate", rank);
    expect(old).toMatchObject({ unusable: null, binding: { identity: "engine-name", provider: "abcllm", cliEngine: { connectionId: TEST_CONNECTION_ID } } });
    expect({ ...next.binding, provider: "abcllm" }).toEqual(old.binding);
    // direct-openai-chat-v1 은 CLI 엔진 계약이 되지 못한다(예전 그대로)
    setServingContractSnapshotForTest([stored({ version: 1, protocol: "direct-openai-chat-v1", routeId: "product-translate", provider: "local-direct", model: "engine-name",
      responseModel: "served", ...extra, tokenizerEndpoint: "http://cli-engine.test:3031/tokenize", backendId: "backend", physicalGroup: "device",
      totalTokenBound: 50_000, requestTokenBound: 32_000, maxOutputTokens: 1024 })]);
    expect(bindApiTaskRank("product-translate", rank)).toMatchObject({ binding: null, unusable: "cli_contract_missing" });
  });

  it("binds a review rank to a new-shape contract the same way", () => {
    for (const [task, routeId] of [["first-review", "crawl-agent-review"], ["second-review", "second-review"]] as const) {
      const rank = textRankRow(task, "engine-name") as AiTaskRank;
      setServingContractSnapshotForTest([contractRow(totalBoundContract(routeId, { model: ledgerName, endpoint, extra: { engineModel: "engine-name" } }))]);
      expect(bindReviewTaskRank(task, rank)).toMatchObject({ unusable: null,
        binding: { routeId, identity: ledgerName, engineModel: "engine-name", provider: "local-direct" } });
    }
  });
});

describe("second-review requestBudget moves to the tokenizer block", () => {
  it("asks the tokenizer with the same request and sends the abcllm requestBudget wire minus context_strategy", async () => {
    const asked: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk as Buffer));
      request.on("end", () => { asked.push(`${request.url} ${Buffer.concat(chunks).toString("utf8")}`);
        response.end(JSON.stringify({ count: 90, max_model_len: 65_536, tokens: Array.from({ length: 90 }, (_, index) => index + 1) })); });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("local_address");
      const origin = `http://127.0.0.1:${address.port}`, options = { endpoint: `${origin}/v1/chat/completions` };
      setServingContractSnapshotForTest([contractRow(abcllmContract("second-review", { ...options, extra: { requestBudget: { requestTokenBound: 32_000,
        maxOutputTokens: 4096, tokenizerEndpoint: `${origin}/tokenize`, tokenizerModel: "fixture-model" } } }))]);
      const old = await prepareRouteCall("second-review", "fixture-model", "abcllm");
      setServingContractSnapshotForTest([contractRow(totalBoundContract("second-review", { ...options, extra: { maxOutputTokens: 4096,
        tokenizer: { endpoint: `${origin}/tokenize`, requestTokenBound: 32_000 } } }))]);
      const next = await prepareRouteCall("second-review", "fixture-model", "local-direct");
      if (old.kind !== "prepared" || next.kind !== "prepared") throw new Error("prepared_required");
      // abcllm requestBudget 계약의 바이트(raw wire, max_tokens = requestBudget.maxOutputTokens)에서 context_strategy 만 빠진다
      const raw = await abcllmWireBytes("second-review", "fixture-model", {});
      if (raw === null) throw new Error("abcllm_bytes_required");
      const oldBytes = JSON.stringify({ ...JSON.parse(raw), max_tokens: 4096 });
      expect(shaBytes(oldBytes)).toBe(old.wireHash);
      expect(next.wireHash).toBe(shaBytes(withoutContextStrategy(oldBytes))); expect(next.wireHash).not.toBe(old.wireHash);
      expect(asked).toHaveLength(2); expect(asked[0].startsWith("/tokenize ")).toBe(true); expect(asked[1]).toBe(asked[0]);
      // tokenizer 묶음이 없는 새 계약은 tokenizer 를 부르지 않는다(tokenizer 가 없는 서버)
      setServingContractSnapshotForTest([contractRow(totalBoundContract("second-review", options))]);
      expect((await prepareRouteCall("second-review", "fixture-model", "local-direct")).kind).toBe("prepared");
      expect(asked).toHaveLength(2);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
});

it("the limits view already classifies both gateway-kind providers of first review with the same ladder cap", () => {
  const first = LIMITS_TASKS.find(task => task.id === "first-review");
  expect(first?.providerCaps?.["local-direct"]).toEqual(first?.providerCaps?.abcllm);
  expect(first?.providerCaps?.abcllm).toBeDefined();
});
