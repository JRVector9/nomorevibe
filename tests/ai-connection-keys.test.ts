import { afterEach, describe, expect, it } from "vitest";
import { bindReviewTaskRank, firstReviewRanks, resolveReviewTaskRanks } from "@/lib/crawl/review-task-ranks";
import { aiTaskKeylessApiConnection, setAiTaskModelsForTest } from "@/lib/llm/ai-task-models-snapshot";
import { resolveTextTaskRanks, TEXT_RANK_UNUSABLE_TEXT, textRankUnusableText, TextTaskRanks } from "@/lib/llm/ai-task-resolver";
import { setServingContractSnapshotForTest, TEXT_ROUTE_BLOCK_DETAIL, textRouteAccess, type StoredServingContract } from "@/lib/llm/serving-contract-store";
import { AI_KEY_CONFLICT_TEXT, aiUnreadConnections, type AiConnectionView } from "@/lib/operations/admin-ai-tasks";
import { contractKeyMatch } from "@/lib/operations/ai-connection-key-fill";
import { pinReviewRanks } from "./review-task-ranks-fixture";
import { TEST_CONNECTION_ID, TEST_TEXT_BASE_URL, textContract, textRankRow } from "./text-task-ranks-fixture";

/**
 * 키 없는 연결(2026-11-02 사고) — ② 키가 필요한 서버(계약 auth stored)에 키 없는 연결로 보내지 않고 다음 순위로 넘긴다(text·심사),
 * 키 없이 도는 서버(auth none·local-direct)는 그대로. ① 같은 주소 계약 키 출처 고르기(순수). 화면 알림 까닭. 시험 키는 모두 가짜다.
 */
const FAKE_KEY = "test-fake-key-aaaa", OTHER_FAKE_KEY = "test-fake-key-bbbb";
afterEach(() => { setAiTaskModelsForTest(null); setServingContractSnapshotForTest(null); pinReviewRanks(null); });

/** 심사 경로 abcllm 형 직접 계약(키 auth 를 고른다). */
function reviewContract(routeId: "crawl-agent-review" | "second-review", model: string, options: Partial<{ auth: StoredServingContract["auth"]; apiKey: string | null;
  baseUrl: string }> = {}): StoredServingContract {
  return { routeId, model, auth: options.auth ?? "none", apiKey: options.apiKey ?? null, transport: "direct",
    contract: { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId, provider: "abcllm", model, responseModel: model, deploymentRevision: `test-${model}`,
      endpoint: `${options.baseUrl ?? TEST_TEXT_BASE_URL}/chat/completions`, totalTokenBound: 32_768 } };
}
/** 키 없이 도는 local-direct 계약(M1 mlx_lm.server·gpu3090 처럼 auth none). */
function localDirect(model: string): StoredServingContract {
  const origin = new URL(TEST_TEXT_BASE_URL).origin;
  return { routeId: "crawl-agent-review", model, auth: "none", apiKey: null, transport: "direct",
    contract: { version: 1, protocol: "direct-openai-chat-v1", routeId: "crawl-agent-review", provider: "local-direct", model, responseModel: model,
      deploymentRevision: `direct-${model}`, endpoint: `${TEST_TEXT_BASE_URL}/chat/completions`, tokenizerEndpoint: `${origin}/tokenize`,
      backendId: "test-backend", physicalGroup: "test-group", totalTokenBound: 65_536, requestTokenBound: 32_000, maxOutputTokens: 10_000 } };
}

describe("② text 작업 — 키가 필요한 서버에 키 없는 연결이면 그 순위를 쓰지 않는다", () => {
  it("계약 auth stored + 연결 키 없음 → connection_key_missing, 2순위(키 있는 연결)가 맡는다", async () => {
    const second = "0b0c0d0e-0000-4000-8000-0000000000bb", secondBase = "http://keyed.test:8000/v1";
    setServingContractSnapshotForTest([textContract("reason-translate", "m3-model", { auth: "stored", apiKey: FAKE_KEY }),
      textContract("reason-translate", "m3-model@0b0c0d0e", { auth: "stored", apiKey: FAKE_KEY, baseUrl: secondBase, engineModel: "m3-model" })]);
    setAiTaskModelsForTest([textRankRow("reason-translate", "m3-model"),
      textRankRow("reason-translate", "m3-model", { rank: 2, connectionId: second, baseUrl: secondBase, label: "keyed", apiKey: OTHER_FAKE_KEY })]);
    const resolution = resolveTextTaskRanks("reason-translate");
    expect(resolution.candidates.map(candidate => [candidate.rank.rank, candidate.unusable, candidate.binding?.bearer ?? null]))
      .toEqual([[1, "connection_key_missing", null], [2, null, OTHER_FAKE_KEY]]);
    const ranks = new TextTaskRanks(resolution);
    expect(ranks.earlyDegraded()).toBeNull();
    const run = await ranks.run(async binding => binding.rank);
    expect(run).toMatchObject({ kind: "served", value: 2 });
    expect(ranks.summary()).toMatchObject({ ranks: 2, "served.2": 1, "unusable.1.connection_key_missing": 1 });
  });

  it("순위가 그것뿐이면 all_ranks_unusable — degraded 에 한국어 까닭(키 없이 부르지 않는다)", () => {
    setServingContractSnapshotForTest([textContract("product-tagline-ko", "m3-model", { auth: "stored", apiKey: FAKE_KEY })]);
    setAiTaskModelsForTest([textRankRow("product-tagline-ko", "m3-model", { label: "m3-mlx" })]);
    const ranks = new TextTaskRanks(resolveTextTaskRanks("product-tagline-ko"));
    expect(ranks.earlyDegraded()).toEqual({ code: "all_ranks_unusable",
      detail: `한국어 소개 번역: 1순위 m3-mlx · m3-model: ${TEXT_RANK_UNUSABLE_TEXT.connection_key_missing}`.slice(0, 300), cause: "connection_key_missing" });
    expect(textRankUnusableText("connection_key_missing")).toMatch(/^연결에 키가 없음/);
  });

  it("계약 행의 키가 이 프로세스에서 열리지 않아도(apiKey null) auth stored 면 키가 필요한 서버다", () => {
    setServingContractSnapshotForTest([textContract("crawl-tagline", "m3-model", { auth: "stored", apiKey: null })]);
    setAiTaskModelsForTest([textRankRow("crawl-tagline", "m3-model")]);
    expect(resolveTextTaskRanks("crawl-tagline").candidates[0]).toMatchObject({ binding: null, unusable: "connection_key_missing" });
  });

  it("회귀: 키 없이 도는 서버(계약 auth none, gpu3090 qwen 같은)는 키 없는 연결로 그대로 쓴다 — Authorization 없음", async () => {
    setServingContractSnapshotForTest([textContract("crawl-tagline", "qwen3.8-flash-next")]);
    setAiTaskModelsForTest([textRankRow("crawl-tagline", "qwen3.8-flash-next", { label: "gpu3090" })]);
    const resolution = resolveTextTaskRanks("crawl-tagline");
    expect(resolution.candidates[0]).toMatchObject({ unusable: null, binding: { bearer: null, identity: "qwen3.8-flash-next" } });
    const inside = await new TextTaskRanks(resolution).run(async () => textRouteAccess("crawl-tagline", "qwen3.8-flash-next"));
    expect(inside).toMatchObject({ kind: "served", value: { block: null, bearer: null } });
  });

  it("키 있는 연결은 그대로 그 키를 보낸다; 열리지 않는 연결 키는 예전처럼 stored_key_unreadable", () => {
    setServingContractSnapshotForTest([textContract("crawl-tagline", "m3-model", { auth: "stored", apiKey: FAKE_KEY })]);
    setAiTaskModelsForTest([textRankRow("crawl-tagline", "m3-model", { apiKey: OTHER_FAKE_KEY })]);
    expect(resolveTextTaskRanks("crawl-tagline").candidates[0].binding?.bearer).toBe(OTHER_FAKE_KEY);
    setAiTaskModelsForTest([textRankRow("crawl-tagline", "m3-model", { keyUnreadable: true })]);
    expect(resolveTextTaskRanks("crawl-tagline").candidates[0].unusable).toBe("stored_key_unreadable");
  });

  it("보내는 길(순위 범위 안 textRouteAccess)도 같은 규칙: auth stored 에 키 없는 순위면 막는다", async () => {
    setServingContractSnapshotForTest([textContract("crawl-tagline", "m3-model", { auth: "stored", apiKey: FAKE_KEY })]);
    const { runInTextTaskRank } = await import("@/lib/llm/ai-task-rank-scope");
    const binding = { routeId: "crawl-tagline", rank: 1, connectionId: TEST_CONNECTION_ID, connectionLabel: "m3-mlx", identity: "m3-model", engineModel: "m3-model",
      provider: "abcllm" as const, bearer: null, deviceId: "test-device" };
    expect(runInTextTaskRank(binding, () => textRouteAccess("crawl-tagline", "m3-model"))).toEqual({ block: "connection_key_missing" });
    expect(TEXT_ROUTE_BLOCK_DETAIL.connection_key_missing).toContain("연결에 키가 없습니다");
  });
});

describe("② 심사(1차·2차) — 묶기와 보내는 길(reviewRankConnection)이 같은 규칙", () => {
  it("1차: auth stored 계약 + 키 없는 연결 → 장부 이름은 알고 connection_key_missing; 보내는 길은 block(예전에는 bearer null 로 보냈다)", () => {
    pinReviewRanks(null);
    setServingContractSnapshotForTest([reviewContract("crawl-agent-review", "m3-review", { auth: "stored", apiKey: FAKE_KEY })]);
    setAiTaskModelsForTest([textRankRow("first-review", "m3-review", { label: "m3-mlx" })]);
    expect(resolveReviewTaskRanks("first-review").candidates[0]).toMatchObject({ unusable: "connection_key_missing",
      binding: { identity: "m3-review", provider: "abcllm" } });
    expect(firstReviewRanks()).toMatchObject({ pool: [{ provider: "abcllm", model: "m3-review" }], usable: 0 });
    expect(textRouteAccess("crawl-agent-review", "m3-review", "abcllm")).toEqual({ block: "connection_key_missing" });
  });

  it("2차 투표자 칸도 같다 — 키 있는 연결이면 그 연결의 키를 보낸다", () => {
    pinReviewRanks(null);
    setServingContractSnapshotForTest([reviewContract("second-review", "m3-voter", { auth: "stored", apiKey: FAKE_KEY })]);
    setAiTaskModelsForTest([textRankRow("second-review", "m3-voter")]);
    expect(bindReviewTaskRank("second-review", resolveReviewTaskRanks("second-review").candidates[0].rank).unusable).toBe("connection_key_missing");
    expect(textRouteAccess("second-review", "m3-voter", "abcllm")).toEqual({ block: "connection_key_missing" });
    setAiTaskModelsForTest([textRankRow("second-review", "m3-voter", { apiKey: OTHER_FAKE_KEY })]);
    expect(resolveReviewTaskRanks("second-review").candidates[0].unusable).toBeNull();
    expect(textRouteAccess("second-review", "m3-voter", "abcllm")).toEqual({ block: null, bearer: OTHER_FAKE_KEY });
  });

  it("회귀: 키 없이 도는 서버(auth none abcllm 형·local-direct)는 키 없는 연결로 그대로 쓴다", () => {
    pinReviewRanks(null);
    setServingContractSnapshotForTest([reviewContract("crawl-agent-review", "qwen-review"), localDirect("mlx-qwen")]);
    setAiTaskModelsForTest([textRankRow("first-review", "qwen-review", { label: "gpu3090" }), textRankRow("first-review", "mlx-qwen", { rank: 2, label: "M1" })]);
    expect(resolveReviewTaskRanks("first-review").candidates.map(candidate => [candidate.unusable, candidate.binding?.provider]))
      .toEqual([[null, "abcllm"], [null, "local-direct"]]);
    expect(textRouteAccess("crawl-agent-review", "qwen-review", "abcllm")).toEqual({ block: null, bearer: null });
    expect(textRouteAccess("crawl-agent-review", "mlx-qwen", "local-direct")).toEqual({ block: null, bearer: null });
  });
});

describe("① 같은 주소 계약 키 출처(contractKeyMatch, 순수)", () => {
  const stored = (routeId: string, model: string, apiKey: string | null, endpoint = "http://m3.test:8100/v1/chat/completions", auth: StoredServingContract["auth"] = "stored") =>
    ({ routeId, model, auth, apiKey, contract: { endpoint } });
  const BASE = "http://m3.test:8100/v1";

  it("auth stored · 키가 열림 · endpoint origin/v1 = 연결 주소인 계약만 출처 — 모두 같으면 same(그 키)", () => {
    const match = contractKeyMatch(BASE, [stored("reason-translate", "m3-model", FAKE_KEY), stored("crawl-agent-review", "m3-review", FAKE_KEY),
      stored("product-search-profile", "x", OTHER_FAKE_KEY, "http://other.test:8100/v1/chat/completions"),
      stored("product-translate", "y", null), stored("crawl-tagline", "z", OTHER_FAKE_KEY, "http://m3.test:8100/v1/chat/completions", "none")]);
    expect(match).toEqual({ status: "same", key: FAKE_KEY, sources: [{ routeId: "reason-translate", model: "m3-model" }, { routeId: "crawl-agent-review", model: "m3-review" }] });
  });
  it("열린 키가 서로 다르면 conflict(키는 돌려주지 않는다), 출처가 없으면 none", () => {
    const conflict = contractKeyMatch(BASE, [stored("a", "m", FAKE_KEY), stored("b", "m", OTHER_FAKE_KEY)]);
    expect(conflict).toEqual({ status: "conflict", sources: [{ routeId: "a", model: "m" }, { routeId: "b", model: "m" }] });
    expect(JSON.stringify(conflict)).not.toContain("test-fake-key");
    expect(contractKeyMatch(BASE, [stored("a", "m", null), stored("b", "m", FAKE_KEY, "not a url")])).toEqual({ status: "none", sources: [] });
    expect(contractKeyMatch(null, [stored("a", "m", FAKE_KEY)]).status).toBe("none");
  });
  it("순위 스냅숏에 키 없는 켜진 API 연결이 있을 때만 채우기를 부른다(열리지 않는 키·CLI·꺼진 연결은 아니다)", () => {
    expect(aiTaskKeylessApiConnection([textRankRow("crawl-tagline", "m")])).toBe(true);
    expect(aiTaskKeylessApiConnection([textRankRow("crawl-tagline", "m", { apiKey: FAKE_KEY }), textRankRow("crawl-tagline", "m", { rank: 2, keyUnreadable: true }),
      textRankRow("crawl-tagline", "m", { rank: 3, connectionEnabled: false })])).toBe(false);
  });
});

describe("화면 위 「모델 목록을 못 읽은 서버」 알림 까닭", () => {
  const view = (patch: Partial<AiConnectionView>): AiConnectionView => ({ id: "11111111-1111-4111-8111-111111111111", label: "m3-mlx", kind: "api",
    baseUrl: "http://m3.test:8100/v1", host: "m3.test:8100", hasKey: false, cliTool: null, cliModels: [], models: null, modelsReadAt: null, modelsError: "http_401",
    deviceId: "m3-mlx", capacitySlots: 1, contextTokens: null, enabled: true, version: 1, note: null, updatedBy: "t", updatedAt: "2026-11-02T00:00:00.000Z",
    cliVersion: null, ...patch });
  it("같은 주소의 계약 키가 서로 다르면 그 까닭을 보이고, 목록을 읽은 연결이라도 키가 없으면 알린다", () => {
    const conflicted = view({});
    const listed = view({ id: "22222222-2222-4222-8222-222222222222", label: "m3-mlx (2)", models: [{ id: "m", maxModelLen: null }], modelsError: null });
    expect(aiUnreadConnections([conflicted, listed], [conflicted.id, listed.id])).toEqual([
      { id: conflicted.id, label: "m3-mlx", reason: `키 없음 · ${AI_KEY_CONFLICT_TEXT} · 거절됨(HTTP 401 — 키 확인)` },
      { id: listed.id, label: "m3-mlx (2)", reason: `키 없음 · ${AI_KEY_CONFLICT_TEXT}` }]);
    // 충돌이 없으면 예전 그대로(목록을 읽은 연결은 알리지 않는다)
    expect(aiUnreadConnections([conflicted, listed])).toEqual([{ id: conflicted.id, label: "m3-mlx", reason: "키 없음 · 거절됨(HTTP 401 — 키 확인)" }]);
  });
});
