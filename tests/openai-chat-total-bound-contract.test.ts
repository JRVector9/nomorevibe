import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import "@/lib/crawl/agent-review-serving-contract";
import "@/lib/crawl/second-review-serving-contract";
import { bindReviewTaskRank } from "@/lib/crawl/review-task-ranks";
import { textRedirect, textWireFor } from "@/lib/crawl/agent-review-gateway";
import { bindApiTaskRank, type AiTaskRank } from "@/lib/llm/ai-task-resolver";
import { setAiTaskModelsForTest } from "@/lib/llm/ai-task-models-snapshot";
import { cliEngineEndpoint, cliEngineRevision } from "@/lib/llm/cli-engine-config";
import { OPENAI_CHAT_TOTAL_BOUND_PROTOCOL, servingContractWireModel } from "@/lib/llm/direct-serving-contract";
import { setServingContractSnapshotForTest, textRouteAccess } from "@/lib/llm/serving-contract-store";
import { servingContractHash, validateAdminServingContract } from "@/lib/operations/admin-serving-contracts";
import { LIMITS_TASKS } from "@/lib/operations/admin-limits-view";
import { TEST_CONNECTION_ID, TEST_TEXT_BASE_URL, textRankRow } from "./text-task-ranks-fixture";
import { abcllmContract, contractRow, prepareRouteCall, STRICT_TERMINAL_ROUTES, TOTAL_BOUND_ROUTES, totalBoundContract,
  type TotalBoundRoute } from "./total-bound-direct-fixture";

/**
 * 2026-11-21 abcllm 이름표 정리 1단계 — 엔진 직접 총량 상한 계약(openai-chat-total-bound-v1, provider local-direct).
 * - 열 경로의 스키마가 새 모양을 추가로 받는다. 저장된 옛 두 모양(abcllm 총량 상한·direct-openai-chat-v1)의 hash 는 한 바이트도 바뀌지 않는다.
 * - 새 모양의 wire 는 그 경로가 abcllm 계약으로 보내는 바이트 그대로다(실제 준비 함수의 wireHash 로 견준다).
 * 운영 값이 아니다(모양만 맞춘 고정 fixture).
 */
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

  it("prepares the same wire bytes for the new shape as for today's abcllm contract of the same engine", async () => {
    const variants: Record<string, unknown>[] = [{}, { engineModel: "engine-name" }];
    if (routeId === "reason-translate" || routeId === "product-tagline-ko") variants.push({ reasoningTokenReserve: 2048 });
    for (const extra of variants) {
      const model = extra.engineModel ? "engine-name@0b0c0d0e" : "fixture-model";
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
      expect(stale, JSON.stringify(extra)).toEqual({ kind: "unsupported", reason: "provider_contract_unavailable" });
      for (const call of [old, oldDefault, next, nextDefault]) expect(call.kind, JSON.stringify(extra)).toBe("prepared");
      if (old.kind !== "prepared" || next.kind !== "prepared" || oldDefault.kind !== "prepared" || nextDefault.kind !== "prepared") throw new Error("prepared_required");
      expect(next.wireHash, JSON.stringify(extra)).toBe(old.wireHash);
      expect(oldDefault.wireHash).toBe(old.wireHash); expect(nextDefault.wireHash).toBe(old.wireHash);
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

  it("is the route's own wire: gateway-era fields stay, the engine name comes from engineModel, the contract model is the fallback", () => {
    expect(textWireFor(base, "ledger-name", build)).toBe(build("ledger-name"));
    expect(textWireFor(base, "ledger-name", build)).toBe(textWireFor(gateway, "ledger-name", build));
    expect(textWireFor({ ...base, engineModel: "engine-name" }, "ledger-name", build)).toBe(build("engine-name"));
    expect(textWireFor({ ...base, engineModel: "engine-name" }, "ledger-name", build)).toBe(textWireFor({ ...gateway, engineModel: "engine-name" }, "ledger-name", build));
    // local-direct 는 등록부 키로도 고를 수 있다 — 선택 글자가 아니라 계약의 이름이 나간다
    expect(textWireFor(base, "device:registry-key", build)).toBe(build("ledger-name"));
    // direct-openai-chat-v1 은 예전 그대로다(게이트웨이 칸을 빼고 thinking 을 끈다)
    const direct = JSON.parse(textWireFor({ ...base, protocol: "direct-openai-chat-v1", maxOutputTokens: 400 }, "ledger-name", build));
    expect(direct).toMatchObject({ model: "ledger-name", max_tokens: 400 }); expect("context_strategy" in direct || "reasoning_effort" in direct).toBe(false);
  });

  it("caps max_tokens only when the contract carries maxOutputTokens", () => {
    expect(JSON.parse(textWireFor({ ...base, maxOutputTokens: 400 }, "ledger-name", build))).toEqual({ ...JSON.parse(build("ledger-name")), max_tokens: 400 });
    expect(textWireFor({ ...base, maxOutputTokens: 900 }, "ledger-name", build)).toBe(build("ledger-name"));
    expect(textWireFor({ ...base, maxOutputTokens: 5000 }, "ledger-name", build)).toBe(build("ledger-name"));
  });

  it("takes a CLI-engine revision the way an abcllm contract does, which direct-openai-chat-v1 still refuses", () => {
    for (const reasoningEffort of [undefined, "high"]) {
      const deploymentRevision = cliEngineRevision({ connectionId: TEST_CONNECTION_ID, ...(reasoningEffort ? { reasoningEffort } : {}) });
      const wire = textWireFor({ ...base, deploymentRevision }, "ledger-name", build);
      expect(wire).toBe(textWireFor({ ...gateway, deploymentRevision }, "ledger-name", build));
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
  it("asks the tokenizer with the same request and sends the same wire as the abcllm contract with a requestBudget", async () => {
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
      expect(next.wireHash).toBe(old.wireHash);
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
