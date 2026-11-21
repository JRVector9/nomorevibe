import { afterEach, describe, expect, it } from "vitest";
import "@/lib/crawl/agent-review-serving-contract";
import "@/lib/crawl/second-review-serving-contract";
import "@/lib/llm/product-translation-serving-contract";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { cliEngineEndpoint, cliEngineRevision } from "@/lib/llm/cli-engine-config";
import type { AiTaskExecutionConfig, AiTaskPoolMember } from "@/lib/llm/ai-task-execution-config";
import { taskPoolEngineKey } from "@/lib/llm/ai-task-pool-identity";
import { resolveTextTaskRanks } from "@/lib/llm/ai-task-resolver";
import { setAiTaskModelsForTest } from "@/lib/llm/ai-task-models-snapshot";
import { chooseTaskWorkloadMember } from "@/lib/llm/ai-task-workload-selector";
import { setServingContractSnapshotForTest, textRouteAccess } from "@/lib/llm/serving-contract-store";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { TEST_CONNECTION_ID, TEST_TEXT_BASE_URL, textRankRow } from "./text-task-ranks-fixture";
import { abcllmContract, contractRow, totalBoundContract } from "./total-bound-direct-fixture";

/**
 * abcllm 이름표 정리 2단계 — 1단계(#1012) 리뷰가 찾은 시험 공백 중 단위로 고정하는 둘. 둘 다 새 모양(openai-chat-total-bound-v1, provider local-direct)에서만
 * 타는 가지이고, 가지를 #1012 이전 꼴로 되돌리면 아래 시험이 실패한다(PR 본문에 되돌림 확인을 적는다). 운영 값이 아니다.
 */
afterEach(() => { setServingContractSnapshotForTest(null); setAiTaskModelsForTest(null); });

describe("「동시에」 고르기: CLI 엔진(OpenCode) 구성원의 새 모양 계약 (ai-task-workload-selector.ts)", () => {
  const ROUTE = "product-translate", MODEL = "engine-name", DEVICE = "cli-device", BASE = "http://cli-engine.test:3031/v1", SECRET = "s".repeat(40);
  const MEMBER_ID = "0b0c0d0e-0000-4000-8000-00000000e0e0";
  const connection = Object.freeze({ id: TEST_CONNECTION_ID, label: "opencode-engine", kind: "cli" as const, baseUrl: BASE, cliTool: "opencode",
    deviceId: DEVICE, enabled: true, models: null, contextTokens: null, apiKey: SECRET, keyUnreadable: false });
  const member: AiTaskPoolMember = Object.freeze({ memberId: MEMBER_ID, position: 1, connectionId: connection.id, model: MODEL, options: {},
    canonicalModel: MODEL, deviceId: DEVICE, engineKey: taskPoolEngineKey(connection, MODEL), connection });
  const execution: AiTaskExecutionConfig = Object.freeze({ task: ROUTE, slot: 1, mode: "workload_pool", revision: 4, updatedAt: null, members: [member] });
  const extra = { deploymentRevision: cliEngineRevision({ connectionId: TEST_CONNECTION_ID }), endpoint: cliEngineEndpoint(BASE) };
  const stored = (contract: Record<string, unknown>) => ({ ...contractRow(contract), auth: "stored" as const, apiKey: SECRET });
  const policy = (provider: string): ModelCapacityPolicy => ({ version: 1, maxWaiting: 8, queueTtlMs: 60_000, reservationTtlMs: 60_000,
    groupLimits: { [DEVICE]: 1 }, routes: [{ routeId: ROUTE, provider, model: MODEL, providerBudgetId: "cli-budget", groupId: DEVICE }] });
  /** 고르기가 읽는 장부 control 한 행만 돌려주는 실행기(선호 구성원이 있으면 장비 상태는 읽지 않는다) */
  const executor = (value: ModelCapacityPolicy) => ({
    execute: async () => [],
    select: () => ({ from: () => ({ where: async () => [{ id: 1, mode: "open", epoch: 3, revision: 9, policy: value, policyHash: modelCapacityPolicyHash(value) }] }) }),
  }) as unknown as ProductTransaction;
  /** 실제 묶기(resolveTextTaskRanks → bindCliEngineTaskRank)로 구성원의 후보를 만든다 */
  function candidate() {
    const [bound] = resolveTextTaskRanks(ROUTE, execution).candidates;
    if (!bound?.binding) throw new Error(`binding_required:${bound?.unusable}`);
    return { ...bound.binding, memberId: MEMBER_ID };
  }

  it("takes a CLI-engine member bound to the new local-direct contract, as it takes one bound to an abcllm contract", async () => {
    setServingContractSnapshotForTest([stored(totalBoundContract(ROUTE, { model: MODEL, ...extra }))]);
    const next = candidate();
    expect(next).toMatchObject({ provider: "local-direct", identity: MODEL, cliEngine: { connectionId: TEST_CONNECTION_ID }, options: {} });
    expect(await chooseTaskWorkloadMember(execution, [next], { preferMemberId: MEMBER_ID, executor: executor(policy("local-direct")) }))
      .toMatchObject({ provider: "local-direct", identity: MODEL, deviceId: DEVICE,
        poolSelection: { task: ROUTE, slot: 1, configRevision: 4, memberId: MEMBER_ID, policyEpoch: 3, policyRevision: 9 } });
    // 오늘 모양(abcllm 형 CLI 엔진 계약)은 예전 그대로 고른다
    setServingContractSnapshotForTest([stored(abcllmContract(ROUTE, { model: MODEL, ...extra }))]);
    const old = candidate();
    expect(old).toMatchObject({ provider: "abcllm", cliEngine: { connectionId: TEST_CONNECTION_ID } });
    expect(await chooseTaskWorkloadMember(execution, [old], { preferMemberId: MEMBER_ID, executor: executor(policy("abcllm")) }))
      .toMatchObject({ provider: "abcllm", identity: MODEL });
  });

  it("still refuses a CLI-engine member whose candidate is another provider or lost its CLI-engine metadata", async () => {
    setServingContractSnapshotForTest([stored(totalBoundContract(ROUTE, { model: MODEL, ...extra }))]);
    const next = candidate();
    for (const provider of ["opencode-cli", "claude-cli"]) expect(await chooseTaskWorkloadMember(execution, [{ ...next, provider }],
      { preferMemberId: MEMBER_ID, executor: executor(policy(provider)) }), provider).toBeNull();
    for (const drop of ["options", "cliEngine"] as const) {
      const partial: Record<string, unknown> = { ...next };
      delete partial[drop];
      expect(await chooseTaskWorkloadMember(execution, [partial as typeof next], { preferMemberId: MEMBER_ID, executor: executor(policy("local-direct")) }), drop)
        .toBeNull();
    }
    // 정책 route 가 없는 이름표면 고르지 않는다(장부 입장과 같은 판정)
    expect(await chooseTaskWorkloadMember(execution, [next], { preferMemberId: MEMBER_ID, executor: executor(policy("abcllm")) })).toBeNull();
  });
});

describe("심사 순위 연결의 키 (serving-contract-store.ts reviewRankConnection)", () => {
  const LEDGER = "engine-name@0b0c0d0e", ENGINE = "engine-name", CONNECTION_KEY = "k".repeat(40), endpoint = `${TEST_TEXT_BASE_URL}/chat/completions`;

  it.each([["first-review", "crawl-agent-review"], ["second-review", "second-review"]] as const)(
    "%s: a new-shape contract whose model is the ledger name finds its rank's connection by engineModel and sends that connection's key", (task, routeId) => {
      setAiTaskModelsForTest([textRankRow(task, ENGINE, { apiKey: CONNECTION_KEY })]);
      setServingContractSnapshotForTest([contractRow(totalBoundContract(routeId, { model: LEDGER, endpoint, extra: { engineModel: ENGINE } }))]);
      expect(textRouteAccess(routeId, LEDGER, "local-direct")).toEqual({ block: null, bearer: CONNECTION_KEY });
      // 계약 행이 키를 요구하면(auth stored) 연결의 키가 나간다 — 계약 행의 키가 아니다
      setServingContractSnapshotForTest([{ ...contractRow(totalBoundContract(routeId, { model: LEDGER, endpoint, extra: { engineModel: ENGINE } })),
        auth: "stored", apiKey: "r".repeat(40) }]);
      expect(textRouteAccess(routeId, LEDGER, "local-direct")).toEqual({ block: null, bearer: CONNECTION_KEY });
      // 오늘 모양(abcllm 형)도 같은 규칙이다
      setServingContractSnapshotForTest([contractRow(abcllmContract(routeId, { model: LEDGER, endpoint, extra: { engineModel: ENGINE } }))]);
      expect(textRouteAccess(routeId, LEDGER, "abcllm")).toEqual({ block: null, bearer: CONNECTION_KEY });
    });

  it("a rank of another engine model is not that contract's connection — the contract row's own rule applies", () => {
    setAiTaskModelsForTest([textRankRow("second-review", "other-engine", { apiKey: CONNECTION_KEY })]);
    setServingContractSnapshotForTest([contractRow(totalBoundContract("second-review", { model: LEDGER, endpoint, extra: { engineModel: ENGINE } }))]);
    expect(textRouteAccess("second-review", LEDGER, "local-direct")).toEqual({ block: null, bearer: null });
  });
});
