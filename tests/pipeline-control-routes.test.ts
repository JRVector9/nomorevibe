import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { deferredRoutes, modelRouteContracts, parsePipelineControlArgs, planPipelineControl, usedModelRoutes, type ControlSnapshot, type ModelEnv,
  type TransitionCommand } from "@/lib/operations/pipeline-control";
import type { Ai2DirectServingContract } from "@/lib/crawl/second-review-serving-contract";
import { pinReviewRanks, pinReviewRanksFromSettings } from "./review-task-ranks-fixture";
import { cliRankRow, pinTaskRanks } from "./fake-cli-path";

// 이 WT의 serving 계약 resolver는 모두 null이다. served에 넣은 model만 계약이 있는 배포처럼 답하게 한다.
const mocks = vi.hoisted(() => {
  const served = new Set<string>();
  const ai2Contracts = new Map<string, unknown>();
  const literal = (schema: unknown, key: string) => (schema as { shape: Record<string, { value: unknown }> }).shape[key].value;
  const gateway = (schema: unknown, model: string) => served.has(model) ? { version: 1, protocol: literal(schema, "protocol"),
    routeId: literal(schema, "routeId"), provider: "abcllm", model, responseModel: model, deploymentRevision: "pr06d",
    endpoint: "https://gateway.test/v1/chat/completions", totalTokenBound: 4096 } : null;
  const ai2 = (model: string, provider: string = "abcllm") => {
    const key = JSON.stringify([provider, model]);
    if (ai2Contracts.has(key)) return ai2Contracts.get(key);
    return provider === "abcllm" && served.has(model) ? { version: 1, protocol: "abcllm-raw-total-bound-v1",
      routeId: "second-review", provider, model, responseModel: model, deploymentRevision: "pr06d",
      endpoint: "https://gateway.test/v1/chat/completions", totalTokenBound: 4096 } : null;
  };
  return { served, gateway, ai2, ai2Contracts };
});
vi.mock("@/lib/crawl/agent-review-serving-contract", async load => { const m = await load<typeof import("@/lib/crawl/agent-review-serving-contract")>();
  return { ...m, resolveAi1GatewayServingContract: (model: string, provider = "abcllm") =>
    provider === "abcllm" ? mocks.gateway(m.ai1RawGatewayServingContractSchema, model) : null }; });
vi.mock("@/lib/crawl/second-review-serving-contract", async load => { const m = await load<typeof import("@/lib/crawl/second-review-serving-contract")>();
  return { ...m, resolveAi2GatewayServingContract: mocks.ai2 }; });
vi.mock("@/lib/llm/text-profile-serving-contract", async load => { const m = await load<typeof import("@/lib/llm/text-profile-serving-contract")>();
  return { ...m, resolveTextProfileServingContract: (model: string) => mocks.gateway(m.textProfileServingContractSchema, model) }; });
vi.mock("@/lib/llm/search-verify-serving-contract", async load => { const m = await load<typeof import("@/lib/llm/search-verify-serving-contract")>();
  return { ...m, resolveSearchVerifyServingContract: (model: string) => mocks.gateway(m.searchVerifyServingContractSchema, model) }; });
vi.mock("@/lib/llm/reason-translation-serving-contract", async load => { const m = await load<typeof import("@/lib/llm/reason-translation-serving-contract")>();
  return { ...m, resolveReasonTranslationServingContract: (model: string) => mocks.gateway(m.reasonTranslationServingContractSchema, model) }; });
vi.mock("@/lib/llm/product-translation-serving-contract", async load => { const m = await load<typeof import("@/lib/llm/product-translation-serving-contract")>();
  return { ...m, resolveProductTranslationServingContract: (model: string) => mocks.gateway(m.productTranslationServingContractSchema, model) }; });
vi.mock("@/lib/llm/product-tagline-ko-serving-contract", async load => { const m = await load<typeof import("@/lib/llm/product-tagline-ko-serving-contract")>();
  return { ...m, resolveProductTaglineKoServingContract: (model: string) => mocks.gateway(m.productTaglineKoServingContractSchema, model) }; });
vi.mock("@/lib/llm/crawl-tagline-serving-contract", async load => { const m = await load<typeof import("@/lib/llm/crawl-tagline-serving-contract")>();
  return { ...m, resolveCrawlTaglineServingContract: (model: string) => mocks.gateway(m.crawlTaglineServingContractSchema, model) }; });
vi.mock("@/lib/llm/websearch-query-serving-contract", async load => { const m = await load<typeof import("@/lib/llm/websearch-query-serving-contract")>();
  return { ...m, resolveWebsearchQueryServingContract: (model: string) => mocks.gateway(m.websearchQueryServingContractSchema, model) }; });
vi.mock("@/lib/llm/cli-serving-contract", async load => {
  const m = await load<typeof import("@/lib/llm/cli-serving-contract")>();
  const base = { version: 1, protocol: m.CLI_PROTOCOL, cliVersion: "pr06d", inputByteCap: 1000, costBoundUsdMicros: null };
  return { ...m, resolveCliServingContract: (routeId: string, provider: string, model: string) => !mocks.served.has(model) ? null
    : provider === "claude-cli" ? { ...base, routeId, provider, model, totalTokenBound: 100_000, boundProvenance: "derived",
      maxTurns: 2, outputTokensPerTurn: 2000, overheadTokenBound: 1000 }
      : { ...base, routeId, provider, model, totalTokenBound: 100_000, boundProvenance: "declared" } };
});

const audit = ["--operator=jr", "--reason=pr06d routes"];
function transition(...args: string[]): TransitionCommand {
  const command = parsePipelineControlArgs([...args, ...audit]);
  if (command.name === "status") throw new Error("unexpected status");
  return command;
}
const MODELS: ModelEnv = { translate: "tr", productTranslate: "pt", tagline: "tg", profile: "pf", verify: "vf", introCheck: "intro" };
const SETTINGS = { firstReview: { provider: "abcllm", model: "ai1-gw" },
  secondReview: { voters: [{ provider: "abcllm", model: "ai2-gw" }, { provider: "claude-cli", model: "opus" }],
    fallbacks: [{ provider: "grok-cli", model: "grok-4" }, { provider: "claude-cli", model: "opus" }] } };
const IN_USE = [
  ["crawl-agent-review", "abcllm", "ai1-gw"], ["second-review", "abcllm", "ai2-gw"], ["second-review", "claude-cli", "opus"],
  ["second-review", "grok-cli", "grok-4"], ["grok-session-check", "grok-cli", "grok-4"], ["product-search-profile", "abcllm", "pf"],
  ["product-search-verify", "abcllm", "vf"], ["reason-translate", "abcllm", "tr"], ["product-translate", "abcllm", "pt"],
  ["product-tagline-ko", "abcllm", "tr"], ["search-query-translate", "abcllm", "tr"], ["crawl-tagline", "abcllm", "tg"],
  ["product-intro-check", "claude-cli", "intro"], ["product-audit", "claude-cli", "sonnet"],
  ["crawl-publish-classify", "codex-cli", "gpt-5.6-terra"], ["crawl-publish-classify", "claude-cli", "sonnet"],
] as const;
const ALL_SERVED = ["ai1-gw", "ai2-gw", "opus", "grok-4", "pf", "vf", "tr", "pt", "tg", "intro", "sonnet"];

type Stage = ControlSnapshot["stages"][number];
function snapshot(overrides: Partial<ControlSnapshot> = {}, ai2: Partial<Stage> = {}): ControlSnapshot {
  const stage = (name: "ai1" | "ai2"): Stage => ({ stage: name, mode: "legacy", drainingFrom: null, epoch: 1, contract: 1,
    live: 0, unsettled: 0, legacyJobLive: false, consumers: 1, ...(name === "ai2" ? ai2 : {}) });
  return { now: "2026-10-17T00:00:00.000Z", fence: { state: "active", writerEpoch: 1 }, stages: [stage("ai1"), stage("ai2")],
    capacity: { mode: "disabled", epoch: 1, revision: 1, policy: null, policyHash: null, waiting: 0, reserved: 0, dispatched: 0, indeterminate: 0, oldGeneration: 0 },
    http: { mode: "disabled", epoch: 1, revision: 1, policy: null, policyHash: null, reserved: 0, dispatched: 0, indeterminate: 0 },
    batch: { mode: "legacy", drainingFrom: null, epoch: 1, contract: 0, policy: null, policyHash: null, liveJobs: 0, liveRoles: 0, liveItems: 0, liveSources: 0, liveAgentClaims: 0 },
    agentScan: { mode: "legacy", drainingFrom: null, epoch: 1, contract: 0, live: 0, unsettled: 0, legacyJobLive: false, consumers: 0, queue: [] },
    classificationObservations: [{ observedAt: "2026-10-17T00:00:00.000Z", value: { status: "running", classifyReady: true, busy: null,
      classificationCapacityVersion: 1, config: { primary: { model: "gpt-5.6-terra", effort: "xhigh" }, fallback: { model: "sonnet", effort: "high" } },
      classificationContracts: [
        { version: 1, protocol: "cli-process-v1", routeId: "crawl-publish-classify", provider: "codex-cli", model: "gpt-5.6-terra",
          cliVersion: "test", inputByteCap: 1000, totalTokenBound: 100_000, costBoundUsdMicros: null, boundProvenance: "declared" },
        { version: 1, protocol: "cli-process-v1", routeId: "crawl-publish-classify", provider: "claude-cli", model: "sonnet",
          cliVersion: "test", inputByteCap: 1000, totalTokenBound: 100_000, costBoundUsdMicros: null, boundProvenance: "derived",
          maxTurns: 2, outputTokensPerTurn: 4000, overheadTokenBound: 1000 },
      ] } }],
    recentInstances: [], uptimeSplitMode: "legacy", reviewSettings: SETTINGS, auditCampaign: { provider: "claude-cli", model: "sonnet" }, ...overrides };
}
const policyFor = (routes: readonly (readonly [string, string, string])[]): ModelCapacityPolicy => ({ version: 1, globalLimit: 4,
  providerLimits: { all: 4 }, groupLimits: { all: 4 }, poolLimits: { reviewer: 2, text: 2 }, weights: { first: 1, second: 1, background: 1 },
  maxWaiting: 16, queueTtlMs: 60_000, reservationTtlMs: 30_000,
  routes: routes.map(([routeId, provider, model]) => ({ routeId, provider, model, providerBudgetId: "all", groupId: "all" })) });
const capacity = (mode: "draining" | "open", policy: ModelCapacityPolicy) =>
  ({ ...snapshot().capacity, mode, revision: 2, policy, policyHash: modelCapacityPolicyHash(policy) });

/**
 * 1차·2차·Grok 로그인 유지의 조합은 「작업 ↔ 모델」 순위에서 온다(PR C1). 기본 순위는 SETTINGS 와 같은 심사자다 — 1차 1순위 ai1-gw,
 * 2차 칸 1 = ai2-gw → grok-4 → opus, 칸 2 = opus(투표자 ai2-gw·opus, 대체 grok-4), Grok 로그인 유지 1순위 grok-4. 스냅숏의 reviewSettings 는
 * 읽기 가능 여부(settingsUnreadable)만 정한다.
 */
const pinSettingsRanks = (settings: Parameters<typeof pinReviewRanksFromSettings>[0] = SETTINGS) => pinReviewRanksFromSettings(settings);
beforeEach(() => {
  mocks.served.clear(); mocks.ai2Contracts.clear();
  pinSettingsRanks(); pinTaskRanks([cliRankRow("grok-session-check", "grok-4")]);
});
afterEach(() => { vi.unstubAllEnvs(); pinReviewRanks(null); pinTaskRanks(null); });

const direct: Ai2DirectServingContract = { version: 1, protocol: "ai2-direct-openai-chat-v1", routeId: "second-review",
  provider: "local-direct", model: "direct-ai2", responseModel: "direct-engine", deploymentRevision: "direct-v1",
  endpoint: "http://gpu.test/v1/chat/completions", tokenizerEndpoint: "http://gpu.test/tokenize",
  backendId: "local-backend", physicalGroup: "gpu-engine", totalTokenBound: 65_536,
  requestTokenBound: 32_000, maxOutputTokens: 10_000 };
const directUse = { routeId: "second-review", provider: "local-direct", model: direct.model };
function directPolicy(): ModelCapacityPolicy {
  const policy = policyFor([...IN_USE, ["second-review", "local-direct", direct.model]]);
  return { ...policy, providerLimits: { ...policy.providerLimits, [direct.backendId]: 4 },
    groupLimits: { ...policy.groupLimits, [direct.physicalGroup]: 4 }, routes: policy.routes.map(route =>
      route.provider === "local-direct" ? { ...route, providerBudgetId: direct.backendId, groupId: direct.physicalGroup } : route) };
}

describe("AI2 direct provider reopen contracts", () => {
  const open = ["capacity", "mode", "--to=open", "--from-mode=draining", "--expect-epoch=1", "--expect-revision=2"];
  const key = JSON.stringify([direct.provider, direct.model]);
  it("reopens capacity and completes items only with the direct startup contract and matching physical mapping", () => {
    ALL_SERVED.forEach(model => mocks.served.add(model)); mocks.ai2Contracts.set(key, direct);
    const reviewSettings = { ...SETTINGS, secondReview: { voters: [{ provider: direct.provider, model: direct.model }],
      fallbacks: [{ provider: "abcllm", model: "ai2-gw" }] } };
    pinSettingsRanks(reviewSettings);
    const policy = directPolicy();
    const state = snapshot({ reviewSettings, capacity: capacity("draining", policy) }, { mode: "items" });
    const allowed = planPipelineControl(transition(...open), state, undefined, MODELS);
    expect(allowed.blocked).toEqual([]); expect(deferredRoutes(allowed.routes ?? [])).toEqual([]);
    expect(allowed.routes).toContainEqual({ ...directUse, status: "serving" });
    const complete = transition("stage", "complete", "--stage=ai2", "--draining-from=legacy", "--to=items", "--expect-epoch=1");
    const draining = snapshot({ reviewSettings, capacity: capacity("open", policy) }, { mode: "draining", drainingFrom: "legacy" });
    expect(planPipelineControl(complete, draining, undefined, MODELS).blocked).toEqual([]);
    mocks.ai2Contracts.delete(key);
    expect(planPipelineControl(transition(...open), state, undefined, MODELS).blocked).toEqual(["deferred_routes:1"]);
    expect(planPipelineControl(complete, draining, undefined, MODELS).blocked).toEqual(["items_consumer_defers:route_not_serving:ai2"]);
  });
  it.each([
    ["missing", null], ["provider", { provider: "abcllm" }], ["route", { routeId: "crawl-agent-review" }],
    ["model", { model: "another-engine" }], ["tokenizer", { tokenizerEndpoint: "http://another-gpu.test/tokenize" }],
    ["backend", { backendId: "another-backend" }], ["physical group", { physicalGroup: "another-engine" }],
  ])("refuses a missing or mismatched %s contract", (_name, change) => {
    mocks.ai2Contracts.set(key, change === null ? null : { ...direct, ...change });
    expect(modelRouteContracts(directPolicy(), "items", [directUse])).toContainEqual({ ...directUse, status: "no_contract" });
  });
  it("keeps the same model alias isolated by provider and preserves unknown, unused and legacy statuses", () => {
    mocks.ai2Contracts.set(key, direct);
    const abc = { ...directUse, provider: "abcllm" }, unknown = { ...directUse, provider: "unregistered" };
    const policy = directPolicy();
    const mapped = { ...policy, routes: [...policy.routes, { ...abc, providerBudgetId: "all", groupId: "all" }] };
    const rows = modelRouteContracts(mapped, "legacy", [directUse, abc, unknown]);
    expect(rows).toEqual(expect.arrayContaining([{ ...directUse, status: "serving" }, { ...abc, status: "no_contract" },
      { ...unknown, status: "unknown" }, { routeId: "second-review", provider: "legacy-job", model: null, status: "stage_legacy" }]));
    expect(modelRouteContracts(policyFor(IN_USE), "items", [directUse])).toContainEqual({ ...directUse, status: "unmapped" });
    expect(modelRouteContracts(mapped, "items", [abc])).toContainEqual({ ...directUse, status: "unused" });
  });
});

describe("stage → items refuses a stalled consumer by default", () => {
  const complete = ["stage", "complete", "--stage=ai2", "--draining-from=legacy", "--to=items", "--expect-epoch=1"];
  const draining = { mode: "draining" as const, drainingFrom: "legacy" as const };

  it("refuses in dry-run while capacity is not open and allows it only with --allow-stalled-stage, keeping the warning", () => {
    const state = snapshot({}, draining);
    const refused = planPipelineControl(transition(...complete), state, undefined, MODELS);
    expect([refused.blocked, refused.warnings]).toEqual([["items_consumer_defers:capacity_disabled:ai2"], []]);
    expect(planPipelineControl(transition(...complete, "--execute"), state, undefined, MODELS).blocked)
      .toEqual(["items_consumer_defers:capacity_disabled:ai2"]);
    const allowed = planPipelineControl(transition(...complete, "--allow-stalled-stage"), state, undefined, MODELS);
    expect([allowed.blocked, allowed.warnings]).toEqual([[], ["items_consumer_defers:capacity_disabled:ai2"]]);
    expect(planPipelineControl(transition(...complete), snapshot({ capacity: capacity("draining", policyFor(IN_USE)) }, draining),
      undefined, MODELS).blocked).toEqual(["items_consumer_defers:capacity_draining:ai2"]);
  });

  it("refuses while any combination the stage actually uses has no serving contract, and ignores combinations it does not use", () => {
    const state = snapshot({ capacity: capacity("open", policyFor(IN_USE)) }, draining);
    ["ai2-gw", "opus"].forEach(model => mocks.served.add(model));
    const refused = planPipelineControl(transition(...complete), state, undefined, MODELS);
    expect(refused.blocked).toEqual(["items_consumer_defers:route_not_serving:ai2"]);
    expect(refused.routes).toEqual([
      { routeId: "second-review", provider: "abcllm", model: "ai2-gw", status: "serving" },
      { routeId: "second-review", provider: "claude-cli", model: "opus", status: "serving" },
      { routeId: "second-review", provider: "grok-cli", model: "grok-4", status: "no_contract" },
    ]);
    mocks.served.add("grok-4");
    const allowed = planPipelineControl(transition(...complete), state, undefined, MODELS);
    expect([allowed.blocked, allowed.warnings]).toEqual([[], []]);
    const unmapped = snapshot({ capacity: capacity("open", policyFor(IN_USE.filter(([, , model]) => model !== "opus"))) }, draining);
    expect(planPipelineControl(transition(...complete), unmapped, undefined, MODELS).blocked).toEqual(["items_consumer_defers:route_not_serving:ai2"]);
    const ai1 = snapshot({ capacity: capacity("open", policyFor(IN_USE)), stages: snapshot().stages.map(row => ({ ...row, ...draining })) });
    expect(planPipelineControl(transition("stage", "complete", "--stage=ai1", "--draining-from=legacy", "--to=items", "--expect-epoch=1"),
      ai1, undefined, MODELS).blocked).toEqual(["items_consumer_defers:route_not_serving:ai1"]);
  });

  it("never blocks the drain from legacy or the way back to legacy", () => {
    const drain = planPipelineControl(transition("stage", "drain", "--stage=ai2", "--from-mode=legacy", "--expect-epoch=1"), snapshot(), undefined, MODELS);
    expect(drain.blocked).toEqual([]);
    expect(drain.warnings).toContain("items_consumer_defers:capacity_disabled:ai2");
    const back = planPipelineControl(transition("stage", "complete", "--stage=ai2", "--draining-from=items", "--to=legacy", "--expect-epoch=1"),
      snapshot({}, { mode: "draining", drainingFrom: "items" }), undefined, MODELS);
    expect([back.blocked, back.warnings]).toEqual([[], []]);
    expect(transition(...complete, "--allow-stalled-stage").allowStalledStage).toBe(true);
    expect(() => parsePipelineControlArgs(["stage", "drain", "--stage=ai2", "--from-mode=legacy", "--expect-epoch=1", "--allow-stalled-stage", ...audit]))
      .toThrow("pipeline_control_unknown_option");
  });
});

describe("capacity open is judged only on the combinations in use", () => {
  it("keeps independent Korean tagline and query identities in capacity route discovery", () => {
    const uses = usedModelRoutes(snapshot(), { ...MODELS, koreanTagline: "korean-role", searchQuery: "query-role" });
    expect(uses).toContainEqual({ routeId: "product-tagline-ko", provider: "abcllm", model: "korean-role" });
    expect(uses).toContainEqual({ routeId: "search-query-translate", provider: "abcllm", model: "query-role" });
    expect(uses).toContainEqual({ routeId: "reason-translate", provider: "abcllm", model: MODELS.translate });
  });
  it("judges a text route with an admin stage selection by each selected key's wire name, not the env constant", () => {
    // Engine connected directly: the text job sends the bare engine name inside its stage pool; '[MLX] …' is no longer called.
    const uses = usedModelRoutes(snapshot(), { ...MODELS, pooled: { "reason-translate": ["gpt-oss-120b", "gemma-direct"], "product-translate": [] } });
    expect(uses).toContainEqual({ routeId: "reason-translate", provider: "abcllm", model: "gpt-oss-120b" });
    expect(uses).toContainEqual({ routeId: "reason-translate", provider: "abcllm", model: "gemma-direct" });
    expect(uses.some(use => use.routeId === "reason-translate" && use.model === MODELS.translate)).toBe(false);
    // An empty selection keeps the env-only judgment.
    expect(uses).toContainEqual({ routeId: "product-translate", provider: "abcllm", model: MODELS.productTranslate });
  });
  const open = ["capacity", "mode", "--to=open", "--from-mode=draining", "--expect-epoch=1", "--expect-revision=2"];

  it("reads what each call site passes its resolver from the task ranks, model env and the running audit", () => {
    const uses = usedModelRoutes(snapshot(), MODELS);
    expect(uses).toHaveLength(IN_USE.length);
    expect(uses).toEqual(expect.arrayContaining(IN_USE.map(([routeId, provider, model]) => expect.objectContaining({ routeId, provider, model }))));
    // 순위가 고르는 것이다 — 스냅숏의 옛 설정이 다른 심사자를 적어도 route 목록은 순위를 따른다
    const legacy = usedModelRoutes(snapshot({ reviewSettings: { firstReview: { provider: "grok-cli", model: "legacy-grok" },
      secondReview: { voters: [{ provider: "grok-cli", model: "legacy-grok" }] } } }), MODELS);
    expect(legacy).toHaveLength(IN_USE.length);
    expect(legacy.some(use => use.model === "legacy-grok")).toBe(false);
    // 1차 순위가 없으면 claude-cli 의 모델 미상(null)이다 — CRAWL_REVIEW_MODEL 은 2026-10-31부터 읽지 않는다.
    // Grok 로그인 유지 순위가 없으면 그 route 는 쓰지 않는다
    vi.stubEnv("CRAWL_REVIEW_MODEL", "env-ai1");
    pinReviewRanks({ second: [[{ provider: "abcllm", model: "ai2-gw" }]] }); pinTaskRanks([]);
    const implicit = usedModelRoutes(snapshot({ reviewSettings: { secondReview: { voters: [{ provider: "abcllm", model: "ai2-gw" }] } },
      auditCampaign: { provider: "abcllm", model: "audit-gw" } }), MODELS);
    expect(implicit).toEqual(expect.arrayContaining([{ routeId: "crawl-agent-review", provider: "claude-cli", model: null },
      { routeId: "product-audit", provider: "abcllm", model: "audit-gw" }]));
    expect(implicit.some(use => use.model === "env-ai1")).toBe(false);
    expect(implicit.some(use => use.routeId === "grok-session-check")).toBe(false);
    expect(usedModelRoutes(snapshot({ auditCampaign: null }), MODELS).some(use => use.routeId === "product-audit")).toBe(false);
    // 남은 감사 모델 바꾸기(0112)로 Qwen 직접 심사가 묻는 감사는 공통 슬롯을 거치지 않는다
    expect(usedModelRoutes(snapshot({ auditCampaign: { provider: "qwen-direct", model: "qwen3.8-flash-next" } }), MODELS)
      .some(use => use.routeId === "product-audit")).toBe(false);
  });

  it("treats unreadable settings and empty model values as unknown and refuses open", () => {
    const corrupt = usedModelRoutes(snapshot({ reviewSettings: { reviewConcurrency: 99 } }), MODELS);
    expect(corrupt).toEqual(expect.arrayContaining([{ routeId: "crawl-agent-review", provider: "unknown", model: null },
      { routeId: "second-review", provider: "unknown", model: null }, { routeId: "grok-session-check", provider: "unknown", model: null }]));
    pinReviewRanks({ first: [] });
    const empty = usedModelRoutes(snapshot({ reviewSettings: {} }), { ...MODELS, tagline: "" });
    pinSettingsRanks();
    expect(empty).toEqual(expect.arrayContaining([{ routeId: "crawl-agent-review", provider: "claude-cli", model: null },
      { routeId: "crawl-tagline", provider: "abcllm", model: null }]));
    ALL_SERVED.forEach(model => mocks.served.add(model));
    const state = snapshot({ capacity: capacity("draining", policyFor(IN_USE)), reviewSettings: { reviewConcurrency: 99 } }, { mode: "items" });
    const plan = planPipelineControl(transition(...open), state, undefined, MODELS);
    expect(plan.routes?.filter(row => row.status === "unknown")).toHaveLength(3);
    expect(plan.blocked).toEqual(["deferred_routes:3"]);
    // model env를 받지 못하면 env에서 읽는 text 7개·소개 검수 1개가 미상이다
    expect(planPipelineControl(transition(...open), { ...state, reviewSettings: SETTINGS }, undefined, undefined).blocked)
      .toEqual(["deferred_routes:8"]);
  });

  it("requires a separate mapping for the selected product model while other translation routes keep their shared model", () => {
    [...ALL_SERVED, "product-qwen"].forEach(model => mocks.served.add(model));
    const models = { ...MODELS, productTranslate: "product-qwen" };
    const uses = usedModelRoutes(snapshot(), models);
    expect(uses).toEqual(expect.arrayContaining([
      { routeId: "product-translate", provider: "abcllm", model: "product-qwen" },
      ...["reason-translate", "product-tagline-ko", "search-query-translate"].map(routeId => ({ routeId, provider: "abcllm", model: "tr" })),
    ]));
    const state = snapshot({ capacity: capacity("draining", policyFor(IN_USE)) }, { mode: "items" });
    const refused = planPipelineControl(transition(...open), state, undefined, models);
    expect(refused.blocked).toEqual(["deferred_routes:1"]);
    expect(deferredRoutes(refused.routes ?? [])).toEqual([
      { routeId: "product-translate", provider: "abcllm", model: "product-qwen", status: "unmapped" },
    ]);
    const mapped = policyFor(IN_USE.map(([routeId, provider, model]) =>
      [routeId, provider, routeId === "product-translate" ? "product-qwen" : model]));
    const allowed = planPipelineControl(transition(...open), { ...state, capacity: capacity("draining", mapped) }, undefined, models);
    expect(allowed.blocked).toEqual([]);
    expect(allowed.routes).toContainEqual({ routeId: "product-translate", provider: "abcllm", model: "product-qwen", status: "serving" });
  });

  it("opens without --allow-deferred-routes once every combination in use is mapped and serving, listing the rest as unused", () => {
    ALL_SERVED.forEach(model => mocks.served.add(model));
    const policy = policyFor([...IN_USE, ["crawl-agent-review", "grok-cli", "grok-old"]]);
    const state = snapshot({ capacity: capacity("draining", policy) }, { mode: "items" });
    const allowed = planPipelineControl(transition(...open), state, undefined, MODELS);
    expect([allowed.blocked, allowed.warnings]).toEqual([[], []]);
    expect(deferredRoutes(allowed.routes ?? [])).toEqual([]);
    expect(allowed.routes).toEqual(expect.arrayContaining([
      { routeId: "crawl-agent-review", provider: "grok-cli", model: "grok-old", status: "unused" },
      { routeId: "crawl-agent-review", provider: "claude-cli", model: null, status: "unused" },
      { routeId: "product-audit", provider: "abcllm", model: null, status: "unused" },
    ]));
    // 실행 중 감사가 abcllm이면 그 분기에는 admission만 있어 open에서 항상 미뤄진다
    const gatewayAudit = planPipelineControl(transition(...open), { ...state, auditCampaign: { provider: "abcllm", model: "audit-gw" } }, undefined, MODELS);
    expect(deferredRoutes(gatewayAudit.routes ?? [])).toEqual([{ routeId: "product-audit", provider: "abcllm", model: "audit-gw", status: "admission_only" }]);
    mocks.served.delete("tg");
    const refused = planPipelineControl(transition(...open), state, undefined, MODELS);
    expect(refused.blocked).toEqual(["deferred_routes:1"]);
    expect(deferredRoutes(refused.routes ?? [])).toEqual([{ routeId: "crawl-tagline", provider: "abcllm", model: "tg", status: "no_contract" }]);
    const legacy = planPipelineControl(transition(...open), snapshot({ capacity: capacity("draining", policy) }), undefined, MODELS);
    expect(deferredRoutes(legacy.routes ?? []).map(row => row.status)).toEqual(["no_contract", "stage_legacy"]);
  });
});
