import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createReviewInput, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { ai1DispatchBindingHash, ai1ModelDispatchSchema } from "@/lib/llm/capacity";
import type { PreparedAi1GatewayCall } from "@/lib/crawl/agent-review-gateway";
import { ABCLLM_STRICT_TERMINAL_HEADER, ABCLLM_STRICT_TERMINAL_OPT_IN, GATEWAY_SERVING_CONTRACT_ROUTES,
  type GatewayServingRoute } from "@/lib/llm/gateway-serving-contract-config";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";
import * as ai1 from "@/lib/crawl/agent-review-serving-contract";
import * as ai2 from "@/lib/crawl/second-review-serving-contract";
import * as profile from "@/lib/llm/text-profile-serving-contract";
import * as crawlTagline from "@/lib/llm/crawl-tagline-serving-contract";
import * as verify from "@/lib/llm/search-verify-serving-contract";
import * as reason from "@/lib/llm/reason-translation-serving-contract";
import * as product from "@/lib/llm/product-translation-serving-contract";
import * as korean from "@/lib/llm/product-tagline-ko-serving-contract";
import * as query from "@/lib/llm/websearch-query-serving-contract";

type Resolve = (model: string) => unknown;
type Kind = { route: GatewayServingRoute; protocol: string; strict: boolean; schema: unknown;
  hash: (value: never) => string; resolve: Resolve; load: () => Promise<Resolve> };
const KINDS: Kind[] = [
  { route: "crawl-agent-review", protocol: "abcllm-raw-total-bound-v1", strict: false, schema: ai1.ai1GatewayServingContractSchema,
    hash: ai1.ai1GatewayServingContractHash, resolve: ai1.resolveAi1GatewayServingContract,
    load: async () => (await import("@/lib/crawl/agent-review-serving-contract")).resolveAi1GatewayServingContract },
  { route: "second-review", protocol: "abcllm-raw-total-bound-v1", strict: false, schema: ai2.ai2GatewayServingContractSchema,
    hash: ai2.ai2GatewayServingContractHash, resolve: ai2.resolveAi2GatewayServingContract,
    load: async () => (await import("@/lib/crawl/second-review-serving-contract")).resolveAi2GatewayServingContract },
  { route: "product-search-profile", protocol: "abcllm-raw-total-bound-v1", strict: false, schema: profile.textProfileServingContractSchema,
    hash: profile.textProfileServingContractHash, resolve: profile.resolveTextProfileServingContract,
    load: async () => (await import("@/lib/llm/text-profile-serving-contract")).resolveTextProfileServingContract },
  { route: "crawl-tagline", protocol: "abcllm-crawl-tagline-total-bound-v1", strict: false, schema: crawlTagline.crawlTaglineServingContractSchema,
    hash: crawlTagline.crawlTaglineServingContractHash, resolve: crawlTagline.resolveCrawlTaglineServingContract,
    load: async () => (await import("@/lib/llm/crawl-tagline-serving-contract")).resolveCrawlTaglineServingContract },
  { route: "product-search-verify", protocol: "abcllm-search-verify-total-bound-v1", strict: false, schema: verify.searchVerifyServingContractSchema,
    hash: verify.searchVerifyServingContractHash, resolve: verify.resolveSearchVerifyServingContract,
    load: async () => (await import("@/lib/llm/search-verify-serving-contract")).resolveSearchVerifyServingContract },
  { route: "reason-translate", protocol: "abcllm-reason-total-bound-v1", strict: true, schema: reason.reasonTranslationServingContractSchema,
    hash: reason.reasonTranslationServingContractHash, resolve: reason.resolveReasonTranslationServingContract,
    load: async () => (await import("@/lib/llm/reason-translation-serving-contract")).resolveReasonTranslationServingContract },
  { route: "product-translate", protocol: "abcllm-product-translation-total-bound-v1", strict: true, schema: product.productTranslationServingContractSchema,
    hash: product.productTranslationServingContractHash, resolve: product.resolveProductTranslationServingContract,
    load: async () => (await import("@/lib/llm/product-translation-serving-contract")).resolveProductTranslationServingContract },
  { route: "product-tagline-ko", protocol: "abcllm-product-tagline-ko-total-bound-v1", strict: true, schema: korean.productTaglineKoServingContractSchema,
    hash: korean.productTaglineKoServingContractHash, resolve: korean.resolveProductTaglineKoServingContract,
    load: async () => (await import("@/lib/llm/product-tagline-ko-serving-contract")).resolveProductTaglineKoServingContract },
  { route: "search-query-translate", protocol: "abcllm-websearch-query-total-bound-v1", strict: true, schema: query.websearchQueryServingContractSchema,
    hash: query.websearchQueryServingContractHash, resolve: query.resolveWebsearchQueryServingContract,
    load: async () => (await import("@/lib/llm/websearch-query-serving-contract")).resolveWebsearchQueryServingContract },
];
const model = "[MLX] fixture-model", OPT_IN = ABCLLM_STRICT_TERMINAL_OPT_IN;
// 운영 값이 아니다 — 모양만 맞춘 고정 fixture 다
function contract(kind: Kind, change: Record<string, unknown> = {}) {
  return { version: 1, protocol: kind.protocol, routeId: kind.route, provider: "abcllm", model, responseModel: "fixture-upstream",
    deploymentRevision: "gateway=fixture;engine=fixture;C=8192", endpoint: "https://gateway.example/v1/chat/completions",
    totalTokenBound: 8192, ...(kind.strict ? { strictTerminalOptIn: OPT_IN } : {}), ...change };
}
/** The removed env list format — set only to prove it is ignored. */
const config = (contracts: unknown[]) => JSON.stringify({ version: 1, contracts });
/** Admin rows (model_serving_contracts) are the only contract source: one direct row per entry, keyed by the entry's route+model. */
const pin = (entries: Record<string, unknown>[]) => setServingContractSnapshotForTest(entries.map(entry => ({ routeId: String(entry.routeId),
  model: String(entry.model), contract: entry, auth: "none" as const, apiKey: null, transport: "direct" as const })));
function reviewInput() {
  const now = new Date("2026-10-17T00:00:00.000Z");
  return createReviewInput({ repo: "config/demo", productUrl: "https://demo.example", judgedAt: now } as CrawlCandidate,
    { id: 1, repo: "config/demo", productUrl: "https://demo.example", repoMeta: { description: "A usable task tracker" },
      pageMeta: { title: "Demo", textSample: "A task tracker" }, pageStatus: 200, fetchedAt: now } as CrawlDocument,
    DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, now);
}
function dispatch(value: ReviewInput, call: PreparedAi1GatewayCall) {
  const binding = { kind: "ai1_legacy_gateway" as const, version: 1 as const, logicalWorkKey: "ai1:1", candidateId: 1, attemptId: 2,
    inputHash: value.inputHash, sourceRevisionHash: value.sourceRevisionHash, reviewPolicyHash: value.policyHash,
    promptVersion: value.snapshot.policy.promptVersion, rulesVersion: value.snapshot.policy.rulesVersion,
    provider: "abcllm" as const, model, routeId: "crawl-agent-review" as const, stageEpoch: 1,
    wireHash: call.wireHash, servingContractHash: call.servingContractHash, totalTokenBound: call.totalTokenBound,
    chargedTokens: call.totalTokenBound, job: { name: "crawl-agent-review" as const, token: randomUUID(), requestedVersion: 1 } };
  return ai1ModelDispatchSchema.parse({ requestId: randomUUID(), owner: { instanceId: "local-test", bootId: randomUUID() },
    token: randomUUID(), epoch: 1, revision: 1, policyHash: "a".repeat(64), binding, bindingHash: ai1DispatchBindingHash(binding) });
}
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); setServingContractSnapshotForTest(null); });

it("keeps every kind deferred without an admin row, and never reads the removed env list", () => {
  vi.stubEnv("ABCLLM_SERVING_CONTRACTS", config(KINDS.map(kind => contract(kind))));
  expect([ABCLLM_STRICT_TERMINAL_HEADER, ABCLLM_STRICT_TERMINAL_OPT_IN]).toEqual(["X-Abcllm-Strict-Terminal", "abcllm-strict-terminal-v1"]);
  expect([...GATEWAY_SERVING_CONTRACT_ROUTES].sort()).toEqual(KINDS.map(kind => kind.route).sort());
  pin([]);
  for (const kind of KINDS) {
    expect(kind.hash(contract(kind) as never)).toMatch(/^[a-f0-9]{64}$/);
    expect(kind.resolve(model)).toBeNull();
  }
});

it("returns each kind's exact frozen contract per model from admin rows", () => {
  const second = "[supa] fixture-second";
  pin([...KINDS.map(kind => contract(kind)), contract(KINDS[1], { model: second })]);
  for (const kind of KINDS) {
    expect(kind.resolve(model)).toEqual(contract(kind));
    expect(Object.isFrozen(kind.resolve(model))).toBe(true);
    expect(kind.resolve("[MLX] other-model")).toBeNull();
  }
  expect(KINDS[1].resolve(second)).toEqual(contract(KINDS[1], { model: second }));
});

const WRONG: Record<string, unknown>[] = [{ version: 2 }, { protocol: "abcllm-other-total-bound-v1" }, { provider: "openai" },
  { responseModel: "fixture-upstream\u0007" }, { deploymentRevision: undefined },
  { deploymentRevision: "" }, { deploymentRevision: "r".repeat(201) }, { endpoint: "not a url" },
  { endpoint: "ftp://gateway.example/v1/chat/completions" }, { endpoint: "https://user:secret@gateway.example/v1/chat/completions" },
  { endpoint: "https://gateway.example/v1/chat/completions?key=1" }, { endpoint: "https://gateway.example/v1/chat/completions#part" },
  { endpoint: "https://gateway.example/v1/models" }, { totalTokenBound: 0 }, { totalTokenBound: 1.5 }, { totalTokenBound: "8192" },
  { totalTokenBound: 2 ** 53 }, { unexpected: true }];
it("closes only the row with any wrong field, without throwing", () => {
  for (const target of KINDS) for (const change of WRONG) {
    pin(KINDS.map(kind => kind === target ? contract(kind, change) : contract(kind)));
    for (const kind of KINDS) {
      if (kind === target) expect(kind.resolve(model)).toBeNull();
      else expect(kind.resolve(model)).toEqual(contract(kind));
    }
  }
  // 한 kind 의 다른 model 행이 틀려도 그 행만 닫힌다 — 같은 kind 의 맞는 행은 열린 채다
  for (const target of KINDS) {
    pin([contract(target), contract(target, { model: "[MLX] second", totalTokenBound: 0 })]);
    expect(target.resolve(model)).toEqual(contract(target));
    expect(target.resolve("[MLX] second")).toBeNull();
  }
});

it("never opens a translation kind without the PR3 strict terminal opt-in in its contract", () => {
  expect(KINDS.filter(kind => kind.strict).map(kind => kind.route))
    .toEqual(["reason-translate", "product-translate", "product-tagline-ko", "search-query-translate"]);
  for (const kind of KINDS.filter(kind => kind.strict)) {
    pin([contract(kind)]);
    expect(kind.resolve(model)).toEqual({ ...contract(kind), strictTerminalOptIn: "abcllm-strict-terminal-v1" });
    for (const strictTerminalOptIn of [undefined, "", "1", "abcllm-strict-terminal-v2", ABCLLM_STRICT_TERMINAL_HEADER]) {
      pin([contract(kind, { strictTerminalOptIn })]);
      expect(kind.resolve(model)).toBeNull();
    }
  }
  for (const kind of KINDS.filter(kind => !kind.strict)) {
    pin([contract(kind, { strictTerminalOptIn: OPT_IN })]);
    expect(kind.resolve(model)).toBeNull();
  }
});

it("follows the admin rows as they change, and any changed contract value changes its hash", () => {
  pin(KINDS.map(kind => contract(kind)));
  for (const kind of KINDS) expect(kind.resolve(model)).toEqual(contract(kind));
  pin(KINDS.map(kind => contract(kind, { deploymentRevision: "gateway=fixture;engine=next" })));
  for (const kind of KINDS) expect(kind.resolve(model)).toEqual(contract(kind, { deploymentRevision: "gateway=fixture;engine=next" }));
  for (const kind of KINDS) for (const change of [{ responseModel: "fixture-next" }, { deploymentRevision: "next" },
    { endpoint: "https://internal.example/v1/chat/completions" }, { totalTokenBound: 8193 }, ...kind.strict ? [{ strictTerminalOptIn: undefined }] : []])
    expect(kind.hash(contract(kind, change) as never)).not.toBe(kind.hash(contract(kind) as never));
});

it("never mixes a dispatch bound under one configured contract with a call prepared under another", async () => {
  const input = reviewInput();
  const gateway = await import("@/lib/crawl/agent-review-gateway");
  const prepare = (entries: Record<string, unknown>[]) => {
    pin(entries);
    return { gateway, call: gateway.prepareAi1GatewayCall(input, { model, timeoutMs: 1_000 }) };
  };
  expect(prepare([]).call).toEqual({ kind: "unsupported", reason: "provider_contract_unavailable" });
  const first = prepare([contract(KINDS[0])]);
  const next = prepare([contract(KINDS[0], { deploymentRevision: "gateway=fixture;engine=next" })]);
  if (first.call.kind !== "prepared" || next.call.kind !== "prepared") throw new Error("fixture_not_prepared");
  expect(first.call.servingContractHash).toBe(ai1.ai1GatewayServingContractHash(contract(KINDS[0]) as never));
  expect(next.call.wireHash).toBe(first.call.wireHash);
  expect(next.call.servingContractHash).not.toBe(first.call.servingContractHash);
  // 앞 계약으로 묶인 dispatch 는 바뀐 계약의 호출을 쓸 수 없다 — POST 전에 거절된다
  await expect(next.gateway.reviewWithReservedAi1Gateway(input, dispatch(input, first.call), next.call)).rejects.toThrow("ai1_gateway_call_mismatch");
});
