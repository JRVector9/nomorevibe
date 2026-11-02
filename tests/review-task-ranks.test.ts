import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { bindReviewTaskRank, firstReviewRanks, resolveReviewTaskRanks, reviewRouteContracts, secondReviewRankSets, secondReviewRanks,
  secondReviewSlotFallbacks } from "@/lib/crawl/review-task-ranks";
import { firstReviewRankState, firstReviewerKey, firstReviewers } from "@/lib/crawl/first-reviewers";
import { bareModelName, canonicalReviewModel, sameReviewModel, sameUnderlyingModel } from "@/lib/crawl/review-model-identity";
import { underlyingModelSql } from "@/lib/crawl/held-qwen-retry-policy";
import { setAiTaskModelsForTest, type AiTaskModelSnapshotRow } from "@/lib/llm/ai-task-models-snapshot";
import { setServingContractSnapshotForTest, type StoredServingContract } from "@/lib/llm/serving-contract-store";
import { cliDbContract } from "@/lib/llm/cli-db-contracts";
import { cliContractRouteId, type CliProvider } from "@/lib/llm/cli-serving-contract";
import { pinReviewRanks } from "./review-task-ranks-fixture";
import { TEST_CONNECTION_ID, TEST_TEXT_BASE_URL, textRankRow } from "./text-task-ranks-fixture";

/**
 * 1차·2차 심사의 「작업 ↔ 모델」 순위 → 심사자 묶기(PR C1, lib/crawl/review-task-ranks.ts)를 실제 스냅숏(순위·계약)으로 본다.
 * 다른 시험은 묶기가 끝난 순위를 고정한다(tests/review-task-ranks-fixture.ts) — 여기서는 고정하지 않는다(pinReviewRanks(null)).
 */
const OTHER_BASE_URL = "http://engine-two.test:8000/v1", OTHER_CONNECTION_ID = "0b0c0d0e-0000-4000-8000-000000000002";
type Route = "crawl-agent-review" | "second-review";

/** 엔진 직접 abcllm 형 계약 행(abcllm-raw-total-bound-v1, transport direct, 키 없음). model 은 장부 이름, engineModel 은 엔진에 보내는 이름. */
function rawContract(routeId: Route, model: string, options: Partial<{ baseUrl: string; engineModel: string; transport: "direct" | "gateway";
  auth: StoredServingContract["auth"] }> = {}): StoredServingContract {
  const engine = options.engineModel ?? model;
  return { routeId, model, auth: options.auth ?? "none", apiKey: null, transport: options.transport ?? "direct",
    contract: { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId, provider: "abcllm", model, responseModel: engine,
      deploymentRevision: `test-${model}`, endpoint: `${options.baseUrl ?? TEST_TEXT_BASE_URL}/chat/completions`, totalTokenBound: 32_768,
      ...(options.engineModel ? { engineModel: options.engineModel } : {}) } };
}
/** 엔진 직접 local-direct 계약 행(direct-openai-chat-v1). */
function localDirectContract(model: string, baseUrl = TEST_TEXT_BASE_URL): StoredServingContract {
  const origin = new URL(baseUrl).origin;
  return { routeId: "crawl-agent-review", model, auth: "none", apiKey: null, transport: "direct",
    contract: { version: 1, protocol: "direct-openai-chat-v1", routeId: "crawl-agent-review", provider: "local-direct", model, responseModel: model,
      deploymentRevision: `direct-${model}`, endpoint: `${baseUrl}/chat/completions`, tokenizerEndpoint: `${origin}/tokenize`,
      backendId: "test-backend", physicalGroup: "test-group", totalTokenBound: 65_536, requestTokenBound: 32_000, maxOutputTokens: 10_000 } };
}
/** 순위 저장이 CLI 연결에서 만드는 DB CLI 계약 행(cli:<provider>:<route>). */
function cliContract(routeId: Route, provider: CliProvider, model: string): StoredServingContract {
  const stored = cliContractRouteId(provider, routeId);
  return { routeId: stored, model, auth: "none", apiKey: null, transport: "direct",
    contract: { ...cliDbContract(routeId, provider, model, "2.1.0 (Claude Code)")!, routeId: stored } };
}
/** CLI 연결 하나를 가리키는 순위 한 줄. */
function cliRank(task: string, model: string, options: Partial<{ slot: number; rank: number; cliTool: string }> = {}): AiTaskModelSnapshotRow {
  const rank = options.rank ?? 1;
  return Object.freeze({ task, slot: options.slot ?? 1, rank, model, enabled: true, options: Object.freeze({}),
    connection: Object.freeze({ id: `0c0d0e0f-0000-4000-8000-${String(rank + 10 * (options.slot ?? 1)).padStart(12, "0")}`, label: "test-cli",
      kind: "cli" as const, baseUrl: null, cliTool: options.cliTool ?? "claude", deviceId: "test-device", enabled: true, models: null,
      contextTokens: null, apiKey: null, keyUnreadable: false }) });
}
const other = { connectionId: OTHER_CONNECTION_ID, baseUrl: OTHER_BASE_URL, label: "engine-two" };

afterEach(() => { pinReviewRanks(null); setAiTaskModelsForTest(null); setServingContractSnapshotForTest(null); });

describe("순위 하나 → 심사자 묶기", () => {
  it("API 순위는 연결 주소 + 엔진 모델이 같은 abcllm 형 직접 계약에 묶인다(장부 이름 = 계약 행의 model)", () => {
    setServingContractSnapshotForTest([rawContract("crawl-agent-review", "qwen-review")]);
    setAiTaskModelsForTest([textRankRow("first-review", "qwen-review"), textRankRow("first-review", "qwen-review", { rank: 2, ...other }),
      textRankRow("first-review", "unlisted", { rank: 3 })]);
    const resolution = resolveReviewTaskRanks("first-review");
    expect(resolution).toMatchObject({ task: "first-review", slot: 1, routeId: "crawl-agent-review", status: "ok" });
    const [bound, otherEndpoint, unlisted] = resolution.candidates;
    expect(bound).toMatchObject({ unusable: null, binding: { task: "first-review", slot: 1, rank: 1, routeId: "crawl-agent-review",
      connectionId: TEST_CONNECTION_ID, provider: "abcllm", identity: "qwen-review", engineModel: "qwen-review" } });
    // 같은 모델이라도 연결 주소가 계약 끝점과 다르면 묶지 않는다 — 계약 없음
    expect(otherEndpoint).toMatchObject({ binding: null, unusable: "no_direct_contract" });
    expect(unlisted).toMatchObject({ binding: null, unusable: "no_direct_contract" });
    // 계약이 없어 장부 이름을 모르는 순위는 「지금 1차 심사자」에서 빠진다
    expect(firstReviewRanks().pool).toEqual([{ provider: "abcllm", model: "qwen-review" }]);
    expect(firstReviewers()).toEqual([{ provider: "abcllm", model: "qwen-review" }]);
  });

  it("같은 모델을 다른 연결에도 둔 순위는 연결로 가른 장부 이름(<모델>@<연결 8자>)의 계약에 engineModel 로 묶인다", () => {
    const alias = `qwen-review@${OTHER_CONNECTION_ID.slice(0, 8)}`;
    setServingContractSnapshotForTest([rawContract("crawl-agent-review", "qwen-review"),
      rawContract("crawl-agent-review", alias, { baseUrl: OTHER_BASE_URL, engineModel: "qwen-review" })]);
    setAiTaskModelsForTest([textRankRow("first-review", "qwen-review"), textRankRow("first-review", "qwen-review", { rank: 2, ...other })]);
    const [first, second] = resolveReviewTaskRanks("first-review").candidates;
    expect(first.binding).toMatchObject({ identity: "qwen-review", engineModel: "qwen-review", connectionId: TEST_CONNECTION_ID });
    expect(second).toMatchObject({ unusable: null, binding: { identity: alias, engineModel: "qwen-review", connectionId: OTHER_CONNECTION_ID,
      connectionLabel: "engine-two", provider: "abcllm" } });
    expect(firstReviewers()).toEqual([{ provider: "abcllm", model: "qwen-review" }, { provider: "abcllm", model: alias }]);
    // 두 이름은 같은 모델이다(같은 가중치) — 2차의 같은 모델 판정·대체 제외가 꼬리를 뗀다
    expect(canonicalReviewModel(alias)).toBe(canonicalReviewModel("qwen-review"));
  });

  it("abcllm 형 직접 계약을 local-direct 계약보다 먼저 쓰고, local-direct 만 있으면 그것에 묶는다", () => {
    setServingContractSnapshotForTest([localDirectContract("qwen-review"), rawContract("crawl-agent-review", "qwen-review")]);
    setAiTaskModelsForTest([textRankRow("first-review", "qwen-review")]);
    expect(resolveReviewTaskRanks("first-review").candidates[0].binding).toMatchObject({ provider: "abcllm", identity: "qwen-review" });
    setServingContractSnapshotForTest([localDirectContract("qwen-review")]);
    setAiTaskModelsForTest([textRankRow("first-review", "qwen-review")]);
    expect(resolveReviewTaskRanks("first-review").candidates[0]).toMatchObject({ unusable: null,
      binding: { provider: "local-direct", identity: "qwen-review", engineModel: "qwen-review" } });
  });

  it("게이트웨이 전송(transport gateway) abcllm 행은 열지 않는다 — 계약 없음", () => {
    setServingContractSnapshotForTest([rawContract("crawl-agent-review", "qwen-review", { transport: "gateway" })]);
    setAiTaskModelsForTest([textRankRow("first-review", "qwen-review")]);
    expect(reviewRouteContracts("crawl-agent-review")).toEqual([]);
    expect(resolveReviewTaskRanks("first-review").candidates[0]).toMatchObject({ binding: null, unusable: "no_direct_contract" });
    expect(firstReviewers()).toEqual([]);
  });

  it("계약은 있는데 닫힌 순위(게이트웨이 인증·키를 못 엶)는 장부 이름을 알아 목록에 남고 쓸 수 없음으로 표시된다", () => {
    setServingContractSnapshotForTest([rawContract("crawl-agent-review", "qwen-review", { auth: "gateway" }),
      rawContract("crawl-agent-review", "gemma", { baseUrl: OTHER_BASE_URL })]);
    setAiTaskModelsForTest([textRankRow("first-review", "qwen-review"),
      textRankRow("first-review", "gemma", { rank: 2, ...other, keyUnreadable: true })]);
    const [gateway, unreadable] = resolveReviewTaskRanks("first-review").candidates;
    expect(gateway).toMatchObject({ unusable: "gateway_auth", binding: { identity: "qwen-review" } });
    expect(unreadable).toMatchObject({ unusable: "stored_key_unreadable", binding: { identity: "gemma" } });
    const state = firstReviewRankState();
    expect(state.pool).toEqual([{ provider: "abcllm", model: "qwen-review" }, { provider: "abcllm", model: "gemma" }]);
    expect([...state.unusable.entries()]).toEqual([[firstReviewerKey({ provider: "abcllm", model: "qwen-review" }), "gateway_auth"],
      [firstReviewerKey({ provider: "abcllm", model: "gemma" }), "stored_key_unreadable"]]);
  });

  it("CLI 순위는 DB CLI 계약이 없으면 cli_contract_missing 이지만 목록에 남고, 계약이 있으면(버전 확인 전 프로세스) 쓸 수 있다", () => {
    setServingContractSnapshotForTest([]);
    setAiTaskModelsForTest([cliRank("first-review", "sonnet"), cliRank("first-review", "grok-4.7", { rank: 2, cliTool: "grok" })]);
    const [claude, grok] = resolveReviewTaskRanks("first-review").candidates;
    expect(claude).toMatchObject({ unusable: "cli_contract_missing", binding: { provider: "claude-cli", identity: "sonnet", engineModel: "sonnet" } });
    expect(grok).toMatchObject({ unusable: "cli_contract_missing", binding: { provider: "grok-cli", identity: "grok-4.7" } });
    const state = firstReviewRankState();
    expect(state.pool).toEqual([{ provider: "claude-cli", model: "sonnet" }, { provider: "grok-cli", model: "grok-4.7" }]);
    expect(state.unusable.get(firstReviewerKey({ provider: "claude-cli", model: "sonnet" }))).toBe("cli_contract_missing");
    // 순위 저장이 만든 CLI 계약이 있으면 쓸 수 있다 — 버전은 워커가 부를 때 견준다
    setServingContractSnapshotForTest([cliContract("crawl-agent-review", "claude-cli", "sonnet")]);
    setAiTaskModelsForTest([cliRank("first-review", "sonnet"), cliRank("first-review", "grok-4.7", { rank: 2, cliTool: "grok" })]);
    expect(resolveReviewTaskRanks("first-review").candidates.map(candidate => candidate.unusable)).toEqual([null, "cli_contract_missing"]);
  });

  it("CLI 가 아닌 도구(codex)·꺼진 순위·꺼진 연결은 묶지 않고 목록에서 빠진다", () => {
    setServingContractSnapshotForTest([rawContract("crawl-agent-review", "qwen-review"), rawContract("crawl-agent-review", "gemma")]);
    const rows = [textRankRow("first-review", "qwen-review", { enabled: false }), textRankRow("first-review", "gemma", { rank: 2, connectionEnabled: false }),
      cliRank("first-review", "gpt-5", { rank: 3, cliTool: "codex" })];
    setAiTaskModelsForTest(rows);
    expect(resolveReviewTaskRanks("first-review").candidates.map(candidate => [candidate.binding, candidate.unusable]))
      .toEqual([[null, "rank_disabled"], [null, "connection_disabled"], [null, "cli_tool_unsupported"]]);
    expect(firstReviewers()).toEqual([]);
    // 같은 줄을 bindReviewTaskRank 로 바로 묶어도 같다
    expect(bindReviewTaskRank("first-review", rows[0])).toMatchObject({ binding: null, unusable: "rank_disabled" });
  });
});

describe("1차 순위의 제 일 못 함(degraded)", () => {
  it("표를 한 번도 못 읽었으면 task_models_unreadable, 읽었는데 비었으면 no_task_models — 옛 설정·기본값으로 대신 부르지 않는다", () => {
    const legacy = { firstReview: { provider: "abcllm" as const, model: "legacy-first" } };
    setAiTaskModelsForTest(null);
    expect(firstReviewRankState(legacy)).toMatchObject({ pool: [], degraded: { code: "task_models_unreadable" } });
    setAiTaskModelsForTest([]);
    expect(firstReviewRankState(legacy)).toMatchObject({ pool: [], degraded: { code: "no_task_models" } });
    // 다른 작업(2차)의 순위만 있어도 1차는 순위 없음이다
    setAiTaskModelsForTest([textRankRow("second-review", "qwen-review")]);
    expect(firstReviewRankState(legacy).degraded?.code).toBe("no_task_models");
  });

  it("모든 순위를 쓸 수 없으면 all_ranks_unusable(순위마다 까닭), 하나라도 쓸 수 있으면 degraded 가 없다", () => {
    setServingContractSnapshotForTest([]);
    setAiTaskModelsForTest([cliRank("first-review", "sonnet"), textRankRow("first-review", "qwen-review", { rank: 2 })]);
    const blocked = firstReviewRankState();
    expect(blocked.degraded?.code).toBe("all_ranks_unusable");
    expect(blocked.degraded?.detail).toContain("1순위 test-cli · sonnet: ");
    expect(blocked.degraded?.detail).toContain("2순위 test-engine · qwen-review: ");
    setServingContractSnapshotForTest([rawContract("crawl-agent-review", "qwen-review")]);
    setAiTaskModelsForTest([cliRank("first-review", "sonnet"), textRankRow("first-review", "qwen-review", { rank: 2 })]);
    const open = firstReviewRankState();
    expect(open.degraded).toBeNull();
    expect(open.pool).toEqual([{ provider: "claude-cli", model: "sonnet" }, { provider: "abcllm", model: "qwen-review" }]);
    expect([...open.unusable.keys()]).toEqual([firstReviewerKey({ provider: "claude-cli", model: "sonnet" })]);
  });
});

describe("2차 투표자 칸", () => {
  const slot = (value: number) => ({ slot: value });
  it("칸의 1순위를 쓸 수 없으면 그 칸의 2순위가 표를 낸다 — 장부 이름을 아는 쓸 수 없는 순위는 대체 목록에만 남는다", () => {
    setServingContractSnapshotForTest([rawContract("second-review", "gemma"), rawContract("second-review", "llama", { baseUrl: OTHER_BASE_URL })]);
    setAiTaskModelsForTest([cliRank("second-review", "opus"), textRankRow("second-review", "gemma", { rank: 2 }),
      textRankRow("second-review", "missing", { ...slot(2) }), textRankRow("second-review", "llama", { ...slot(2), rank: 2, ...other })]);
    const ranks = secondReviewRanks();
    expect(ranks.status).toBe("ok");
    expect(ranks.slots.map(entry => [entry.slot, entry.voter?.identity ?? null, entry.voter?.rank ?? null])).toEqual([[1, "gemma", 2], [2, "llama", 2], [3, null, null]]);
    // 칸 1 의 CLI(계약 없음)는 장부 이름을 알아 칸의 심사자로 남고, 칸 2 의 계약 없는 순위는 빠진다
    expect(ranks.slots[0].members.map(member => member.identity)).toEqual(["opus", "gemma"]);
    expect(ranks.slots[1].members.map(member => member.identity)).toEqual(["llama"]);
    expect(ranks.slots[2].resolution.status).toBe("no_task_models");
    expect(secondReviewRankSets(ranks)).toEqual({ voters: [{ provider: "abcllm", model: "gemma" }, { provider: "abcllm", model: "llama" }],
      fallbacks: [{ provider: "claude-cli", model: "opus" }] });
  });

  it("한 모델이 두 칸에 있으면(연결로 가른 이름 포함) 앞 칸만 표를 낸다", () => {
    const alias = `qwen@${OTHER_CONNECTION_ID.slice(0, 8)}`;
    setServingContractSnapshotForTest([rawContract("second-review", "qwen"), rawContract("second-review", alias, { baseUrl: OTHER_BASE_URL, engineModel: "qwen" }),
      rawContract("second-review", "gemma", { baseUrl: OTHER_BASE_URL })]);
    setAiTaskModelsForTest([textRankRow("second-review", "qwen"), textRankRow("second-review", "qwen", { ...slot(2), ...other }),
      textRankRow("second-review", "gemma", { ...slot(2), rank: 2, ...other })]);
    const ranks = secondReviewRanks();
    expect(ranks.slots[1].voter?.identity).toBe(alias);
    const sets = secondReviewRankSets(ranks);
    expect(sets.voters).toEqual([{ provider: "abcllm", model: "qwen" }]);
    expect(sets.voters.some(voter => voter.model === alias)).toBe(false);
    expect(sets.fallbacks).toEqual([{ provider: "abcllm", model: "gemma" }]);
  });

  it("대체 차례는 첫 표 모델이 든 칸의 다음 순위 중 쓸 수 있는 것뿐이고, 다른 칸의 모델은 들지 않는다", () => {
    setServingContractSnapshotForTest([rawContract("second-review", "a"), rawContract("second-review", "c"), rawContract("second-review", "d"),
      rawContract("second-review", "e")]);
    // 칸 1: a → b(CLI 계약 없음, 쓸 수 없음) → c, 칸 2: d
    setAiTaskModelsForTest([textRankRow("second-review", "a"), cliRank("second-review", "b", { rank: 2 }), textRankRow("second-review", "c", { rank: 3 }),
      textRankRow("second-review", "d", { ...slot(2) })]);
    expect(secondReviewSlotFallbacks("a")).toEqual([{ provider: "abcllm", model: "c" }]);
    expect(secondReviewSlotFallbacks("[MLX] A")).toEqual([{ provider: "abcllm", model: "c" }]);
    expect(secondReviewSlotFallbacks("c")).toEqual([]);
    expect(secondReviewSlotFallbacks("d")).toEqual([]);
    // 순위에서 빠진 모델은 대체가 없다
    expect(secondReviewSlotFallbacks("legacy-voter")).toEqual([]);
    // 두 칸에 있는 모델(저장이 막지만 옛 행·가져오기)은 한 칸의 것이다 — 표를 내는 칸, 없으면 앞 칸. 다른 칸의 대체가 되지 않는다(한 모델이 한 항목에 두 표를 내지 않는다)
    // 칸 1: a → e → c, 칸 2: d → e — e 는 어느 칸에서도 표를 내지 않아 앞 칸(1)의 것이다
    setAiTaskModelsForTest([textRankRow("second-review", "a"), textRankRow("second-review", "e", { rank: 2 }), textRankRow("second-review", "c", { rank: 3 }),
      textRankRow("second-review", "d", { ...slot(2) }), textRankRow("second-review", "e", { ...slot(2), rank: 2 })]);
    expect(secondReviewSlotFallbacks("a")).toEqual([{ provider: "abcllm", model: "e" }, { provider: "abcllm", model: "c" }]);
    expect(secondReviewSlotFallbacks("d")).toEqual([]);
    // 칸 1: a → d → c, 칸 2: d — d 는 칸 2 에서 표를 내므로 칸 2 의 것이다: 칸 1 의 대체가 아니고, d 의 대체는 칸 2 에서 찾는다
    setAiTaskModelsForTest([textRankRow("second-review", "a"), textRankRow("second-review", "d", { rank: 2 }), textRankRow("second-review", "c", { rank: 3 }),
      textRankRow("second-review", "d", { ...slot(2) }), textRankRow("second-review", "e", { ...slot(2), rank: 2 })]);
    expect(secondReviewRankSets().voters).toEqual([{ provider: "abcllm", model: "a" }, { provider: "abcllm", model: "d" }]);
    expect(secondReviewSlotFallbacks("a")).toEqual([{ provider: "abcllm", model: "c" }]);
    expect(secondReviewSlotFallbacks("d")).toEqual([{ provider: "abcllm", model: "e" }]);
  });
});

describe("장부 이름의 연결 꼬리(@<8 hex>)", () => {
  it("canonicalReviewModel·bareModelName·SQL 짝이 꼬리를 뗀다 — 8자 소문자 hex 만", () => {
    expect(canonicalReviewModel("qwen-review@0a1b2c3d")).toBe("qwen-review");
    expect(canonicalReviewModel(" [MLX] GPT-OSS-120B@0a1b2c3d ")).toBe("gpt-oss-120b");
    expect(sameReviewModel("qwen-review@0a1b2c3d", "qwen-review")).toBe(true);
    // 꼬리 모양이 아니면 이름의 일부다
    expect(canonicalReviewModel("qwen@0a1b2c3")).toBe("qwen@0a1b2c3");
    expect(canonicalReviewModel("qwen@0A1B2C3D")).toBe("qwen@0a1b2c3d");
    expect(canonicalReviewModel("qwen@0a1b2c3d4")).toBe("qwen@0a1b2c3d4");
    expect(bareModelName("[supa] org/Qwen3.8@0a1b2c3d")).toBe("qwen3.8");
    expect(sameUnderlyingModel("qwen3.8-flash-next@0a1b2c3d", "[gpu3090] qwen3.8-flash-next")).toBe(true);
    const query = new PgDialect().sqlToQuery(underlyingModelSql(sql`model`));
    expect(query.sql).toContain("'@[0-9a-f]{8}$'");
  });
});
