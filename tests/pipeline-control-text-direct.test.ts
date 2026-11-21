import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { setServingContractSnapshotForTest, type StoredServingContract } from "@/lib/llm/serving-contract-store";
import { deferredRoutes, parsePipelineControlArgs, planPipelineControl, textRouteUseProvider, usedModelRoutes, type ControlSnapshot, type ModelEnv,
  type TransitionCommand } from "@/lib/operations/pipeline-control";
import { pinReviewRanks, pinReviewRanksFromSettings } from "./review-task-ranks-fixture";
import { cliRankRow, pinTaskRanks } from "./fake-cli-path";
import { textContract } from "./text-task-ranks-fixture";
import { abcllmContract, contractRow, totalBoundContract } from "./total-bound-direct-fixture";

/**
 * OPEN 경로 판정(2026-11-21 abcllm 이름표 정리 1단계): text 일곱 경로를 abcllm 으로만 보던 판정이 계약의 provider 를 읽는다.
 * - 지금의 계약 묶음(전부 abcllm)에서는 dry-run 결과가 한 글자도 바뀌지 않는다 — 아래 fixture 는 같은 장면을 이 PR 직전 코드
 *   (origin/main c390c6b7)로 돌려 받은 계획 전체(blocked·warnings·routes)다.
 * - 엔진 직접 계약(local-direct — openai-chat-total-bound-v1, direct-openai-chat-v1)을 쓰는 순위는 (경로, local-direct, 모델)로 판정한다.
 * 실제 resolver 와 계약 스냅숏으로 본다(mock 없음).
 */
const SETTINGS = { firstReview: { provider: "abcllm", model: "ai1-gw" },
  secondReview: { voters: [{ provider: "abcllm", model: "ai2-gw" }, { provider: "claude-cli", model: "opus" }], fallbacks: [{ provider: "grok-cli", model: "grok-4" }] } };
const TEXT = ["product-search-profile", "product-search-verify", "reason-translate", "product-translate", "product-tagline-ko", "search-query-translate", "crawl-tagline"] as const;
type Text = (typeof TEXT)[number];
const pooled = Object.fromEntries(TEXT.map(route => [route, [`${route}-served`, `${route}-unmapped`, `${route}-nocontract`]]));
const MODELS: ModelEnv = { translate: "reason-translate-served", productTranslate: "product-translate-served", tagline: "crawl-tagline-served",
  profile: "product-search-profile-served", verify: "product-search-verify-served", introCheck: "intro", pooled };
const review = (routeId: string, model: string): StoredServingContract => ({ routeId, model, auth: "none", apiKey: null, transport: "direct",
  contract: { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId, provider: "abcllm", model, responseModel: model, deploymentRevision: "pin",
    endpoint: "http://engine.test:8000/v1/chat/completions", totalTokenBound: 4096 } });
const REVIEW_ROUTES = [["crawl-agent-review", "abcllm", "ai1-gw"], ["second-review", "abcllm", "ai2-gw"], ["second-review", "claude-cli", "opus"]];
const policyOf = (routes: readonly (readonly string[])[]): ModelCapacityPolicy => ({ version: 1, globalLimit: 4, providerLimits: { all: 4 }, groupLimits: { all: 4 },
  poolLimits: { reviewer: 2, text: 2 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 16, queueTtlMs: 60_000, reservationTtlMs: 30_000,
  routes: routes.map(([routeId, provider, model]) => ({ routeId, provider, model, providerBudgetId: "all", groupId: "all" })) });
const abcllmPolicy = policyOf([...REVIEW_ROUTES,
  ...TEXT.flatMap(route => [[route, "abcllm", `${route}-served`], [route, "abcllm", `${route}-nocontract`], [route, "abcllm", `${route}-retired`]])]);
function snapshot(policy: ModelCapacityPolicy): ControlSnapshot {
  const stage = (name: "ai1" | "ai2") => ({ stage: name, mode: "items" as const, drainingFrom: null, epoch: 1, contract: 1, live: 0, unsettled: 0, legacyJobLive: false, consumers: 1 });
  return { now: "2026-11-21T00:00:00.000Z", fence: { state: "active", writerEpoch: 1 }, stages: [stage("ai1"), stage("ai2")],
    capacity: { mode: "draining", epoch: 1, revision: 2, policy, policyHash: modelCapacityPolicyHash(policy), waiting: 0, reserved: 0, dispatched: 0, indeterminate: 0, oldGeneration: 0 },
    http: { mode: "disabled", epoch: 1, revision: 1, policy: null, policyHash: null, reserved: 0, dispatched: 0, indeterminate: 0 },
    batch: { mode: "legacy", drainingFrom: null, epoch: 1, contract: 0, policy: null, policyHash: null, liveJobs: 0, liveRoles: 0, liveItems: 0, liveSources: 0, liveAgentClaims: 0 },
    agentScan: { mode: "legacy", drainingFrom: null, epoch: 1, contract: 0, live: 0, unsettled: 0, legacyJobLive: false, consumers: 0, queue: [] },
    recentInstances: [], uptimeSplitMode: "legacy", reviewSettings: SETTINGS, auditCampaign: null };
}
const OPEN = parsePipelineControlArgs(["capacity", "mode", "--to=open", "--from-mode=draining", "--expect-epoch=1", "--expect-revision=2", "--operator=jr", "--reason=pin"]) as TransitionCommand;
const reviews = [review("crawl-agent-review", "ai1-gw"), review("second-review", "ai2-gw")];
const BEFORE = JSON.parse(readFileSync(path.join(__dirname, "fixtures/pipeline-control-abcllm-routes-c390c6b7.json"), "utf8")) as Record<"open" | "keyMissing" | "noModels", unknown>;

beforeEach(() => { pinReviewRanksFromSettings(SETTINGS); pinTaskRanks([cliRankRow("grok-session-check", "grok-4")]); });
afterEach(() => { setServingContractSnapshotForTest(null); pinReviewRanks(null); pinTaskRanks(null); });

describe("today's contract set (every text contract abcllm)", () => {
  it("gives the same OPEN dry-run plan as before this change, route for route", () => {
    setServingContractSnapshotForTest([...reviews, ...TEXT.flatMap(route => [textContract(route, `${route}-served`), textContract(route, `${route}-unmapped`)])]);
    expect(planPipelineControl(OPEN, snapshot(abcllmPolicy), undefined, MODELS)).toEqual(BEFORE.open);
    const keyMissing: ModelEnv = { ...MODELS, pooled: { ...pooled, "crawl-tagline": [] }, keyMissing: ["crawl-tagline"] };
    expect(planPipelineControl(OPEN, snapshot(abcllmPolicy), undefined, keyMissing)).toEqual(BEFORE.keyMissing);
    expect(planPipelineControl(OPEN, snapshot(abcllmPolicy), undefined, null)).toEqual(BEFORE.noModels);
    // 판정 목록에 text 경로의 local-direct 자리 행이 생기지 않는다
    const routes = planPipelineControl(OPEN, snapshot(abcllmPolicy), undefined, MODELS).routes ?? [];
    expect(routes.filter(row => (TEXT as readonly string[]).includes(row.routeId) && row.provider !== "abcllm")).toEqual([]);
  });
});

describe("engine-direct text contracts (provider local-direct)", () => {
  const model = (route: Text) => `${route}-direct`;
  const directModels: ModelEnv = { ...MODELS, pooled: Object.fromEntries(TEXT.map(route => [route, [model(route)]])) };
  const directPolicy = policyOf([...REVIEW_ROUTES, ...TEXT.map(route => [route, "local-direct", model(route)])]);

  it("judges a rank whose contract is openai-chat-total-bound-v1 as (route, local-direct, model) and serves it when the ledger maps that provider", () => {
    setServingContractSnapshotForTest([...reviews, ...TEXT.map(route => contractRow(totalBoundContract(route, { model: model(route) })))]);
    for (const route of TEXT) expect(textRouteUseProvider(route, model(route))).toBe("local-direct");
    const plan = planPipelineControl(OPEN, snapshot(directPolicy), undefined, directModels);
    for (const route of TEXT) expect(plan.routes).toContainEqual({ routeId: route, provider: "local-direct", model: model(route), status: "serving" });
    expect(deferredRoutes(plan.routes ?? []).filter(row => (TEXT as readonly string[]).includes(row.routeId))).toEqual([]);
    // 예전 판정은 같은 이름을 abcllm 으로 찾아 「계약 없음」으로 미뤘다 — 그 행은 이제 없고, abcllm 은 쓰지 않는 자리 행(unused)만 남는다
    expect((plan.routes ?? []).filter(row => (TEXT as readonly string[]).includes(row.routeId) && row.provider === "abcllm" && row.status !== "unused")).toEqual([]);
  });

  it("defers it as unmapped while the policy only maps the abcllm provider, and the old mapping shows as unused", () => {
    setServingContractSnapshotForTest([...reviews, ...TEXT.map(route => contractRow(totalBoundContract(route, { model: model(route) })))]);
    const policy = policyOf([...REVIEW_ROUTES, ...TEXT.map(route => [route, "abcllm", model(route)])]);
    const plan = planPipelineControl(OPEN, snapshot(policy), undefined, directModels);
    for (const route of TEXT) {
      expect(plan.routes).toContainEqual({ routeId: route, provider: "local-direct", model: model(route), status: "unmapped" });
      expect(plan.routes).toContainEqual({ routeId: route, provider: "abcllm", model: model(route), status: "unused" });
    }
    expect(deferredRoutes(plan.routes ?? []).filter(row => (TEXT as readonly string[]).includes(row.routeId))).toHaveLength(7);
    expect(plan.blocked.some(reason => reason.startsWith("deferred_routes:"))).toBe(true);
  });

  it("keeps an abcllm contract's verdict when both shapes are in the ranks of one route, and reads direct-openai-chat-v1 the same way", () => {
    const legacyDirect = { version: 1, protocol: "direct-openai-chat-v1", routeId: "crawl-tagline", provider: "local-direct", model: "tagline-direct-v1",
      responseModel: "served", deploymentRevision: "pin", endpoint: "http://engine.test:8000/v1/chat/completions", tokenizerEndpoint: "http://engine.test:8000/tokenize",
      backendId: "backend", physicalGroup: "device", totalTokenBound: 50_000, requestTokenBound: 32_000, maxOutputTokens: 1024 };
    setServingContractSnapshotForTest([...reviews, contractRow(abcllmContract("reason-translate", { model: "old-shape" })),
      contractRow(totalBoundContract("reason-translate", { model: "new-shape" })), contractRow(legacyDirect)]);
    const models: ModelEnv = { ...MODELS, pooled: { "reason-translate": ["old-shape", "new-shape", "no-contract"], "crawl-tagline": ["tagline-direct-v1"] } };
    const policy = policyOf([...REVIEW_ROUTES, ["reason-translate", "abcllm", "old-shape"], ["reason-translate", "local-direct", "new-shape"],
      ["reason-translate", "abcllm", "no-contract"], ["crawl-tagline", "local-direct", "tagline-direct-v1"]]);
    const uses = usedModelRoutes(snapshot(policy), models);
    expect(uses).toEqual(expect.arrayContaining([{ routeId: "reason-translate", provider: "abcllm", model: "old-shape" },
      { routeId: "reason-translate", provider: "local-direct", model: "new-shape" },
      // 계약이 없는 이름은 예전처럼 abcllm 으로 남아 no_contract 로 미뤄진다(새 provider 로 기록되지 않는다)
      { routeId: "reason-translate", provider: "abcllm", model: "no-contract" }, { routeId: "crawl-tagline", provider: "local-direct", model: "tagline-direct-v1" }]));
    const routes = planPipelineControl(OPEN, snapshot(policy), undefined, models).routes ?? [];
    expect(routes).toEqual(expect.arrayContaining([{ routeId: "reason-translate", provider: "abcllm", model: "old-shape", status: "serving" },
      { routeId: "reason-translate", provider: "local-direct", model: "new-shape", status: "serving" },
      { routeId: "reason-translate", provider: "abcllm", model: "no-contract", status: "no_contract" },
      { routeId: "crawl-tagline", provider: "local-direct", model: "tagline-direct-v1", status: "serving" }]));
  });

  it("serves the review routes under a new-shape contract without a device mapping check, like an abcllm contract", () => {
    const settings = { firstReview: { provider: "local-direct", model: "ai1-direct" }, secondReview: { voters: [{ provider: "local-direct", model: "ai2-direct" }], fallbacks: [] } };
    pinReviewRanksFromSettings(settings);
    setServingContractSnapshotForTest([contractRow(totalBoundContract("crawl-agent-review", { model: "ai1-direct" })),
      contractRow(totalBoundContract("second-review", { model: "ai2-direct" }))]);
    const policy = policyOf([["crawl-agent-review", "local-direct", "ai1-direct"], ["second-review", "local-direct", "ai2-direct"]]);
    const routes = planPipelineControl(OPEN, { ...snapshot(policy), reviewSettings: settings }, undefined, null).routes ?? [];
    expect(routes).toEqual(expect.arrayContaining([{ routeId: "crawl-agent-review", provider: "local-direct", model: "ai1-direct", status: "serving" },
      { routeId: "second-review", provider: "local-direct", model: "ai2-direct", status: "serving" }]));
  });
});
