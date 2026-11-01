import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DIRECT_OPENAI_CHAT_PROTOCOL, DIRECT_REQUEST_TOKEN_BOUND, servingContractProvider } from "@/lib/llm/direct-serving-contract";
import { ABCLLM_STRICT_TERMINAL_OPT_IN, parseGatewayServingContract,
  type GatewayServingRoute } from "@/lib/llm/gateway-serving-contract-config";
import { devicePhysicalLimit, setServingContractSnapshotForTest, servingContractSnapshotFromRows, textRouteCallable } from "@/lib/llm/serving-contract-store";
import { textProfileDispatchBindingHash, textProfileDispatchBindingSchema, textProfileInputHash, type TextProfileDispatchBinding } from "@/lib/llm/capacity";
import { directTextWire } from "@/lib/crawl/agent-review-gateway";
import * as profile from "@/lib/llm/text-profile-serving-contract";
import * as verify from "@/lib/llm/search-verify-serving-contract";
import * as crawlTagline from "@/lib/llm/crawl-tagline-serving-contract";
import * as korean from "@/lib/llm/product-tagline-ko-serving-contract";
import * as reason from "@/lib/llm/reason-translation-serving-contract";
import * as product from "@/lib/llm/product-translation-serving-contract";
import * as query from "@/lib/llm/websearch-query-serving-contract";
import { localModelContractHash, localModelServingContractSchema, resolveLocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import { localModelContractRouteId, resolveLocalModelContract } from "@/lib/llm/local-model-contract-table";
import { localModelRouteReady } from "@/lib/llm/local-model-capacity";

/**
 * PR 3b-E: text 7경로가 local-direct 를 기록한다. 계약은 abcLLM raw 모양(바이트·hash 그대로) 또는 공통 direct-openai-chat-v1 모양이고,
 * provider 는 계약 모듈이 정한다. 아래 fixture 는 운영 값이 아니다(모양만 맞춘 로컬 값).
 */
type Shape = { routeId: string; model: string; provider: string; strictTerminalOptIn?: string };
type Kind = { route: GatewayServingRoute; protocol: string; strict: boolean; raw: z.ZodType<Shape>; union: z.ZodType<Shape>; hash: (value: never) => string;
  resolve: (model: string, provider?: "abcllm" | "local-direct") => unknown; provider: (model: string) => string };
const KINDS: Kind[] = [
  { route: "product-search-profile", protocol: "abcllm-raw-total-bound-v1", strict: false, raw: profile.textProfileServingContractSchema,
    union: profile.textProfileRouteServingContractSchema, hash: profile.textProfileServingContractHash as never, resolve: profile.resolveTextProfileServingContract,
    provider: profile.textProfileServingProvider },
  { route: "product-search-verify", protocol: "abcllm-search-verify-total-bound-v1", strict: false, raw: verify.searchVerifyServingContractSchema,
    union: verify.searchVerifyRouteServingContractSchema, hash: verify.searchVerifyServingContractHash as never, resolve: verify.resolveSearchVerifyServingContract,
    provider: verify.searchVerifyServingProvider },
  { route: "crawl-tagline", protocol: "abcllm-crawl-tagline-total-bound-v1", strict: false, raw: crawlTagline.crawlTaglineServingContractSchema,
    union: crawlTagline.crawlTaglineRouteServingContractSchema, hash: crawlTagline.crawlTaglineServingContractHash as never,
    resolve: crawlTagline.resolveCrawlTaglineServingContract, provider: crawlTagline.crawlTaglineServingProvider },
  { route: "product-tagline-ko", protocol: "abcllm-product-tagline-ko-total-bound-v1", strict: true, raw: korean.productTaglineKoServingContractSchema,
    union: korean.productTaglineKoRouteServingContractSchema, hash: korean.productTaglineKoServingContractHash as never,
    resolve: korean.resolveProductTaglineKoServingContract, provider: korean.productTaglineKoServingProvider },
  { route: "reason-translate", protocol: "abcllm-reason-total-bound-v1", strict: true, raw: reason.reasonTranslationServingContractSchema,
    union: reason.reasonTranslationRouteServingContractSchema, hash: reason.reasonTranslationServingContractHash as never,
    resolve: reason.resolveReasonTranslationServingContract, provider: reason.reasonTranslationServingProvider },
  { route: "product-translate", protocol: "abcllm-product-translation-total-bound-v1", strict: true, raw: product.productTranslationServingContractSchema,
    union: product.productTranslationRouteServingContractSchema, hash: product.productTranslationServingContractHash as never,
    resolve: product.resolveProductTranslationServingContract, provider: product.productTranslationServingProvider },
  { route: "search-query-translate", protocol: "abcllm-websearch-query-total-bound-v1", strict: true, raw: query.websearchQueryServingContractSchema,
    union: query.websearchQueryRouteServingContractSchema, hash: query.websearchQueryServingContractHash as never,
    resolve: query.resolveWebsearchQueryServingContract, provider: query.websearchQueryServingProvider },
];
const gatewayModel = "[MLX] fixture-model", engineModel = "fixture/engine-7b";
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Field order deliberately shuffled: the schema parse restores the stored order the hash depends on.
const raw = (kind: Kind) => ({ totalTokenBound: 8192, endpoint: "https://gateway.example/v1/chat/completions", deploymentRevision: "gateway=abc;C=8192",
  responseModel: "served-model", model: gatewayModel, provider: "abcllm", routeId: kind.route, protocol: kind.protocol, version: 1,
  ...(kind.strict ? { strictTerminalOptIn: ABCLLM_STRICT_TERMINAL_OPT_IN } : {}) });
const direct = (kind: Kind, change: Record<string, unknown> = {}) => ({ version: 1, protocol: DIRECT_OPENAI_CHAT_PROTOCOL, routeId: kind.route, provider: "local-direct",
  model: engineModel, responseModel: "local-llm", deploymentRevision: "vllm-0.9;C=50000", endpoint: "http://engine.local:8000/v1/chat/completions",
  tokenizerEndpoint: "http://engine.local:8000/tokenize", backendId: "engine-local-7b", physicalGroup: "engine-local", totalTokenBound: 50_000,
  requestTokenBound: DIRECT_REQUEST_TOKEN_BOUND, maxOutputTokens: 1024, ...change });
const row = (routeId: string, contract: Record<string, unknown>, auth: "none" | "gateway" | "stored" = "none") =>
  ({ routeId, model: String(contract.model), contract, auth, apiKey: auth === "stored" ? "engine-key" : null, transport: "direct" as const });

afterEach(() => { setServingContractSnapshotForTest(null); vi.unstubAllEnvs(); });

describe("text route contract shapes (PR 3b-E)", () => {
  it.each(KINDS.map(kind => [kind.route, kind] as const))("%s: the raw abcllm contract keeps its byte-identical hash and the union accepts only the direct shape for local-direct", (_route, kind) => {
    const parsedRaw = kind.raw.parse(raw(kind));
    // The pre-3b-E hash was sha256(JSON.stringify(rawSchema.parse(value))); the union parse yields the same bytes.
    expect(kind.hash(raw(kind) as never)).toBe(sha(parsedRaw));
    expect(JSON.stringify(kind.union.parse(raw(kind)))).toBe(JSON.stringify(parsedRaw));
    expect(Object.keys(parsedRaw).slice(0, 4)).toEqual(["version", "protocol", "routeId", "provider"]);
    // local-direct lives only in the direct-openai-chat-v1 shape; the raw shape stays provider abcllm.
    expect(kind.union.safeParse({ ...raw(kind), provider: "local-direct" }).success).toBe(false);
    const parsedDirect = kind.union.parse(direct(kind));
    expect(parsedDirect).toMatchObject({ provider: "local-direct", protocol: DIRECT_OPENAI_CHAT_PROTOCOL, routeId: kind.route, backendId: "engine-local-7b" });
    expect(kind.hash(direct(kind) as never)).toBe(sha(parsedDirect));
    expect(kind.union.safeParse(direct(kind, { provider: "abcllm" })).success).toBe(false);
    expect(kind.union.safeParse(direct(kind, { routeId: "crawl-agent-review" })).success).toBe(false);
    expect(kind.union.safeParse(direct(kind, { tokenizerEndpoint: "http://other.local:8000/tokenize" })).success).toBe(false);
    expect(kind.union.safeParse(direct(kind, { protocol: "ai2-direct-openai-chat-v1" })).success).toBe(false);
  });

  it("a direct contract of a strict-terminal translation route opens without the gateway opt-in; a raw row without it stays closed and does not close the direct row", () => {
    for (const kind of KINDS.filter(kind => kind.strict)) {
      expect(parseGatewayServingContract(direct(kind), kind.route, kind.union)).toMatchObject({ provider: "local-direct" });
      const { strictTerminalOptIn: _dropped, ...withoutOptIn } = raw(kind);
      void _dropped;
      expect(parseGatewayServingContract(withoutOptIn, kind.route, kind.union)).toBeNull();
      setServingContractSnapshotForTest([row(kind.route, direct(kind)), row(kind.route, withoutOptIn)]);
      expect(kind.resolve(engineModel, "local-direct")).toMatchObject({ provider: "local-direct" });
      expect(kind.resolve(gatewayModel)).toBeNull();
    }
  });

  it.each(KINDS.map(kind => [kind.route, kind] as const))("%s: resolves a local-direct admin contract by engine name and decides the provider from the contracts present", (_route, kind) => {
    setServingContractSnapshotForTest([row(kind.route, direct(kind))]);
    expect(kind.resolve(engineModel)).toBeNull();
    expect(kind.resolve(engineModel, "local-direct")).toMatchObject({ provider: "local-direct", model: engineModel });
    expect(kind.provider(engineModel)).toBe("local-direct");
    // No contract at all keeps the old default so the route defers as provider_contract_unavailable, never records a new provider.
    expect(kind.provider("unknown-model")).toBe("abcllm");
    // An abcllm contract for the same selection wins over the direct one.
    setServingContractSnapshotForTest([row(kind.route, direct(kind)), row(kind.route, { ...raw(kind), model: engineModel }, "gateway")]);
    expect(kind.provider(engineModel)).toBe("abcllm");
    expect(kind.resolve(engineModel)).toMatchObject({ provider: "abcllm" });
    // A direct contract under another text route never serves this one.
    setServingContractSnapshotForTest([row(KINDS.find(other => other !== kind)!.route, direct(KINDS.find(other => other !== kind)!))]);
    expect(kind.resolve(engineModel, "local-direct")).toBeNull();
    expect(kind.provider(engineModel)).toBe("abcllm");
  });

  it("servingContractProvider prefers abcllm, then a unique local-direct match, else the abcllm default", () => {
    const contracts = new Map<string, { provider: string; model: string; endpoint: string; maxOutputTokens?: number }>([
      ["[MLX] a", { provider: "abcllm", model: "[MLX] a", endpoint: "https://g/v1/chat/completions" }],
      ["engine-b", { provider: "local-direct", model: "engine-b", endpoint: "http://e/v1/chat/completions", maxOutputTokens: 100 }]]);
    expect(servingContractProvider(contracts, "[MLX] a")).toBe("abcllm");
    expect(servingContractProvider(contracts, "engine-b")).toBe("local-direct");
    expect(servingContractProvider(contracts, "engine-c")).toBe("abcllm");
  });
});

describe("text route ledger and key gate with provider local-direct", () => {
  it("the key gate follows the sender's bearer rule for local-direct: no admin row or gateway auth needs no gateway key", () => {
    vi.stubEnv("ABCLLM_API_KEY", "");
    setServingContractSnapshotForTest([]);
    expect(textRouteCallable("product-search-profile", engineModel)).toBe(false);
    expect(textRouteCallable("product-search-profile", engineModel, "abcllm")).toBe(false);
    expect(textRouteCallable("product-search-profile", engineModel, "local-direct")).toBe(true);
    setServingContractSnapshotForTest([row("product-search-profile", direct(KINDS[0]), "gateway")]);
    expect(textRouteCallable("product-search-profile", engineModel, "local-direct")).toBe(true);
    // A stored key that does not open still refuses, whatever the provider.
    setServingContractSnapshotForTest([{ ...row("product-search-profile", direct(KINDS[0]), "stored"), apiKey: null }]);
    expect(textRouteCallable("product-search-profile", engineModel, "local-direct")).toBe(false);
  });

  it("a text dispatch binding records provider local-direct and keeps the abcllm binding hash unchanged", () => {
    const input = { productId: 7, slug: "fixture", evidenceHash: "a".repeat(64), profile: { kind: "absent" as const }, model: engineModel };
    const binding = { ...input, kind: "text_profile_gateway" as const, version: 1 as const, logicalWorkKey: "text:profile:7", inputHash: textProfileInputHash(input),
      provider: "local-direct" as const, routeId: "product-search-profile" as const, wireHash: "b".repeat(64), servingContractHash: "c".repeat(64),
      totalTokenBound: 50_000, chargedTokens: 50_000, job: { name: "product-search-profile" as const, token: "11111111-2222-4333-8444-555555555555", requestedVersion: 1 },
      role: { role: "text" as const, instanceId: "text-1", bootId: "11111111-2222-4333-8444-555555555555", release: "r1", kind: "primary" as const, epoch: 1,
        batch: { mode: "legacy" as const } } };
    expect(textProfileDispatchBindingSchema.parse(binding).provider).toBe("local-direct");
    const abcllm = { ...binding, provider: "abcllm" as const } as TextProfileDispatchBinding;
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1).map(([key, item]) => [key, canonical(item)])) : value;
    expect(textProfileDispatchBindingHash(abcllm)).toBe(sha(canonical(abcllm)));
    expect(textProfileDispatchBindingSchema.safeParse({ ...binding, provider: "claude-cli" }).success).toBe(false);
  });

  it("directTextWire drops the gateway-only fields, names the engine model, clamps max_tokens and turns thinking off", () => {
    const gateway = JSON.stringify({ context_strategy: "raw", model: gatewayModel, stream: false, temperature: 0, max_tokens: 4096, reasoning_effort: "low",
      chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_object" }, messages: [{ role: "system", content: "<s>" }, { role: "user", content: "<u>" }] });
    const wire = JSON.parse(directTextWire({ model: engineModel, maxOutputTokens: 1024 }, gateway));
    expect(wire).toEqual({ model: engineModel, stream: false, temperature: 0, max_tokens: 1024, chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_object" }, messages: [{ role: "system", content: "<s>" }, { role: "user", content: "<u>" }] });
    // A route whose output bound is below the contract keeps its own bound; a wire without chat_template_kwargs gets thinking off appended.
    const translate = JSON.stringify({ model: gatewayModel, stream: false, temperature: 0.1, reasoning_effort: "low", max_tokens: 400, messages: [] });
    expect(JSON.parse(directTextWire({ model: engineModel, maxOutputTokens: 1024 }, translate)))
      .toEqual({ model: engineModel, stream: false, temperature: 0.1, max_tokens: 400, messages: [], chat_template_kwargs: { enable_thinking: false } });
  });
});

describe("local contract table and device physical limit come first (3b-C leftover 3)", () => {
  const local = localModelServingContractSchema.parse({ version: 1, protocol: "local-openai-chat-v1", backendId: "fixture-gpu",
    provider: "local-direct", physicalGroup: "shared-device", endpoint: "http://fixture.invalid/v1/chat/completions", model: "qwen", responseModel: "qwen",
    modelFamily: "qwen3.8-flash-next", deploymentRevision: "pinned", contextWindowTokens: 8192, totalTokenBound: 8192,
    maxOutputTokens: 512, maxInputBytes: 100_000, capabilities: { vision: true, jsonSchema: true },
    thinking: { mode: "disabled", parameter: "chat_template_kwargs.enable_thinking" }, termination: { kind: "response_only" } });
  const env = (value = local) => ({ LOCAL_MODEL_SERVING_CONTRACTS: JSON.stringify([value]), LOCAL_MODEL_PHYSICAL_LIMITS: JSON.stringify({ [value.physicalGroup]: 1 }) });
  const tableRow = (value: Record<string, unknown>, routeId = localModelContractRouteId(String(value.backendId))) =>
    ({ routeId, model: String(value.model), contract: { ...value, routeId }, auth: "none" as const, apiKey: null, transport: "direct" as const });
  const policy = { version: 1 as const, maxWaiting: 20, queueTtlMs: 60_000, reservationTtlMs: 60_000,
    routes: [{ routeId: "local-audit", provider: "local-direct", model: "qwen", providerBudgetId: "fixture-gpu", groupId: "shared-device" }] };
  const target = { kind: "audit" as const, purpose: "audit" as const, itemId: 5, slug: "demo" };

  it("resolveLocalModelContract reads the table row for a backend first and falls back to env only when the table has none", () => {
    setServingContractSnapshotForTest([]);
    expect(resolveLocalModelContract("fixture-gpu", env())).toEqual(local);
    expect(resolveLocalModelContract("fixture-gpu", {})).toBeNull();
    expect(resolveLocalModelServingContract("fixture-gpu", env())).toEqual(local);
    const older = { ...local, deploymentRevision: "older-env" };
    setServingContractSnapshotForTest([tableRow(local)]);
    expect(resolveLocalModelContract("fixture-gpu", env(older))).toEqual(local);
    expect(localModelContractHash(resolveLocalModelContract("fixture-gpu", {})!)).toBe(localModelContractHash(local));
    // Another backend is still an env lookup; a malformed table row for this backend closes instead of falling back.
    expect(resolveLocalModelContract("other-gpu", env({ ...local, backendId: "other-gpu", endpoint: "http://other.invalid/v1/chat/completions" }))).toMatchObject({ backendId: "other-gpu" });
    setServingContractSnapshotForTest([tableRow({ ...local, totalTokenBound: 4096 })]);
    expect(resolveLocalModelContract("fixture-gpu", env())).toBeNull();
    // The pure env resolver is untouched by the table.
    expect(resolveLocalModelServingContract("fixture-gpu", env())).toEqual(local);
  });

  it("localModelRouteReady takes the device table's physical_limit before the env map", () => {
    setServingContractSnapshotForTest([]);
    expect(devicePhysicalLimit("shared-device")).toBeNull();
    expect(localModelRouteReady(policy, target, local, env())).toBe(true);
    expect(localModelRouteReady(policy, target, local, { LOCAL_MODEL_PHYSICAL_LIMITS: undefined })).toBe(false);
    expect(localModelRouteReady(policy, target, local, { LOCAL_MODEL_PHYSICAL_LIMITS: JSON.stringify({ other: 1 }) })).toBe(false);
    setServingContractSnapshotForTest([], [], [{ deviceId: "shared-device", physicalLimit: 2 }]);
    expect(devicePhysicalLimit("shared-device")).toBe(2);
    expect(localModelRouteReady(policy, target, local, { LOCAL_MODEL_PHYSICAL_LIMITS: undefined })).toBe(true);
    expect(localModelRouteReady(policy, target, local, { LOCAL_MODEL_PHYSICAL_LIMITS: "not json" })).toBe(true);
    // The route mapping is still required, and another device's limit does not count.
    expect(localModelRouteReady({ ...policy, routes: [] }, target, local, env())).toBe(false);
    setServingContractSnapshotForTest([], [], [{ deviceId: "other-device", physicalLimit: 2 }]);
    expect(localModelRouteReady(policy, target, local, { LOCAL_MODEL_PHYSICAL_LIMITS: undefined })).toBe(false);
  });

  it("the store snapshot carries only enabled rows with a positive limit and keeps its token when none are present", () => {
    const rows = [{ route_id: "crawl-agent-review", model: "m", contract: {}, auth: "gateway" as const, api_key_ciphertext: null, updated_at: "t" }];
    const without = servingContractSnapshotFromRows(rows, 1), withEmpty = servingContractSnapshotFromRows(rows, 1, [], null, []);
    expect(withEmpty.token).toBe(without.token);
    expect(withEmpty.devices).toEqual([]);
    const withDevices = servingContractSnapshotFromRows(rows, 1, [], null,
      [{ device_id: "a", physical_limit: 3 }, { device_id: "b", physical_limit: "2" }, { device_id: "c", physical_limit: null }, { device_id: "d", physical_limit: 0 }]);
    expect(withDevices.devices).toEqual([{ deviceId: "a", physicalLimit: 3 }, { deviceId: "b", physicalLimit: 2 }]);
    expect(withDevices.token).not.toBe(without.token);
  });
});
