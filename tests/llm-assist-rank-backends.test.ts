import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASSIST_LANE_TASK, ASSIST_RANK_MAX_CLAIMS, assistLanePlan, assistLaneWork, type AssistLaneDeps } from "@/lib/domain/llm-assist/rank-backends";
import { assistWorkTaskSchema, isAuditAssistTask } from "@/lib/domain/llm-assist/work";
import { aiAssistRouteId, aiTask, aiTaskOwnsLedgerRoute, AI_ASSIST_TASK_IDS } from "@/lib/llm/ai-tasks";
import type { AiTaskRank } from "@/lib/llm/ai-task-resolver";
import { localModelRoute } from "@/lib/llm/local-model-capacity-contract";
import type { LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import { taskOfRoute } from "@/lib/operations/llm-display";
import { setServingContractSnapshotForTest } from "@/lib/llm/serving-contract-store";

/**
 * LLM 보강의 모델 고르기(2026-11-11) — 「작업 ↔ 모델」 LLM 보강·LLM 보강 독립 감사 순위가 있으면 순위만, 없으면 옛 env(LLM_ASSIST_BACKENDS).
 * 순위 스냅숏·용량 정책·계약 찾기는 deps 로 고정한다(DB·네트워크 없음).
 */
const GPU = "11111111-1111-4111-8111-111111111111", M3 = "22222222-2222-4222-8222-222222222222", OPENCODE = "33333333-3333-4333-8333-333333333333";
const contract = (patch: Partial<LocalModelServingContract> = {}): LocalModelServingContract => ({ version: 1, protocol: "local-openai-chat-v1", backendId: "gpu3090-qwen",
  provider: "local-direct", physicalGroup: "gpu3090-qwen", endpoint: "http://100.77.43.63:8090/v1/chat/completions", model: "qwen3.8-flash-next",
  responseModel: "qwen3.8-flash-next", modelFamily: "qwen3.8-flash-next", deploymentRevision: "fixture", contextWindowTokens: 32000, totalTokenBound: 32000,
  maxOutputTokens: 4096, maxInputBytes: 100000, capabilities: { vision: false, jsonSchema: true },
  thinking: { mode: "disabled", parameter: "chat_template_kwargs.enable_thinking" }, termination: { kind: "response_only" }, ...patch });
const DEEPSEEK = contract({ backendId: "m3-deepseek", physicalGroup: "m3-mlx", endpoint: "http://100.92.77.66:8010/v1/chat/completions", model: "deepseek-v4.1-flash-1017",
  responseModel: "deepseek-v4.1-flash-1017", modelFamily: "deepseek-v4.1-flash-1017" });
const connection = (id: string, label: string, baseUrl: string | null, patch: Partial<AiTaskRank["connection"]> = {}): AiTaskRank["connection"] => ({ id, label, kind: "api", baseUrl,
  cliTool: null, deviceId: label, enabled: true, models: null, contextTokens: null, apiKey: null, keyUnreadable: false, ...patch });
const rank = (task: string, order: number, conn: AiTaskRank["connection"], model: string, patch: Partial<AiTaskRank> = {}): AiTaskRank =>
  ({ task, slot: 1, rank: order, model, enabled: true, options: {}, connection: conn, ...patch });
const gpu = connection(GPU, "gpu3090", "http://100.77.43.63:8090/v1", { apiKey: "sk-gpu" });
const m3 = connection(M3, "M3", "http://100.92.77.66:8010/v1");
const routes = (backendId: string, model: string, group: string, works: readonly string[]) => works.map(work => ({ routeId: aiAssistRouteId(work, backendId),
  provider: "local-direct", model, providerBudgetId: backendId, groupId: group }));
const REGULAR = ["uptime", "repo_move", "intro_recheck", "news"], AUDIT = ["decision_audit", "semantic_exception"];
const deps = (ranks: readonly AiTaskRank[], patch: Partial<AssistLaneDeps> = {}): AssistLaneDeps => ({
  ranks: task => ranks.filter(row => row.task === task), loaded: () => true,
  policy: async () => ({ mode: "open", policy: { routes: [...routes("gpu3090-qwen", "qwen3.8-flash-next", "gpu3090-qwen", REGULAR),
    ...routes("m3-deepseek", "deepseek-v4.1-flash-1017", "m3-mlx", AUDIT), ...routes("gpu3090-qwen", "qwen3.8-flash-next", "gpu3090-qwen", AUDIT)] } }),
  contract: (endpoint, model) => [contract(), DEEPSEEK].find(entry => entry.endpoint === endpoint && entry.model === model) ?? null,
  families: () => ({ primary: "qwen3.8-flash-next", audit: "deepseek-v4.1-flash-1017" }), ...patch });
// 경로 판정은 장비 표의 물리 상한(30초 스냅숏)을 본다 — 시험은 env 상한으로 준다
const AUDIT_POLICY = { LLM_ACTION_AUDIT_POLICY: JSON.stringify({ enabled: true, lookbackDays: 7, perStratum: 5, maxAuditsPerWeek: 50, maxExceptionsPerWeek: 5, maxCandidates: 100 }),
  LLM_ACTION_AUDIT_SEED: "s".repeat(32) };
// 장비 표 스냅숏은 비워 고정한다(DB 를 읽지 않는다) — 물리 상한은 env 로 준다
beforeAll(() => setServingContractSnapshotForTest([]));
afterAll(() => setServingContractSnapshotForTest(null));
const ENV = { LOCAL_MODEL_PHYSICAL_LIMITS: JSON.stringify({ "gpu3090-qwen": 4, "m3-mlx": 1 }), ...AUDIT_POLICY };

describe("작업 목록 ↔ 보강 일 ↔ 장부 route", () => {
  it("두 AI 작업이 보강 일 여섯을 빠짐없이 나눠 맡고(감사 일 = 독립 감사), route 꼴은 장부의 localModelRoute 와 같다", () => {
    const all = AI_ASSIST_TASK_IDS.flatMap(id => aiTask(id)!.assistWork);
    expect([...all].sort()).toEqual([...assistWorkTaskSchema.options].sort());
    expect(aiTask("assist-audit")!.assistWork.every(isAuditAssistTask)).toBe(true);
    expect(aiTask("assist-review")!.assistWork.some(isAuditAssistTask)).toBe(false);
    expect(ASSIST_LANE_TASK).toEqual({ regular: "assist-review", audit: "assist-audit" });
    for (const work of all) expect(aiAssistRouteId(work, "gpu3090-qwen")).toBe(localModelRoute({ kind: "assist", purpose: "assist_review",
      workId: "00000000-0000-4000-8000-000000000000", workRevision: 1, claimToken: "00000000-0000-4000-8000-000000000001",
      task: assistWorkTaskSchema.parse(work), subjectId: 1, backendId: "gpu3090-qwen" } as never));
  });
  it("장부 route → 작업: local-assist-<일>-<backend> 는 그 일의 AI 작업, 다른 route 는 아니다", () => {
    expect(taskOfRoute("local-assist-intro_recheck-gpu3090-qwen")?.id).toBe("assist-review");
    expect(taskOfRoute("local-assist-uptime-api-0123456789abcdef0123456789abcde")?.id).toBe("assist-review");
    expect(taskOfRoute("local-assist-semantic_exception-m3-deepseek")?.id).toBe("assist-audit");
    expect(taskOfRoute("local-audit")?.id).toBe("audit-review");
    const review = aiTask("assist-review")!;
    expect(aiTaskOwnsLedgerRoute(review, "local-assist-uptime-")).toBe(false);
    expect(aiTaskOwnsLedgerRoute(review, "local-assist-decision_audit-gpu3090-qwen")).toBe(false);
  });
});

describe("assistLanePlan", () => {
  it("순위가 없으면 예전처럼 env 길 — 순위 표를 한 번도 못 읽었으면 env 로 대신 부르지 않는다", async () => {
    expect(await assistLanePlan("regular", {}, deps([]))).toEqual({ source: "env", drains: [] });
    const unread = await assistLanePlan("regular", { LLM_ASSIST_BACKENDS: "[]" }, deps([], { loaded: () => false }));
    expect(unread).toMatchObject({ source: "ranks", drains: [], degraded: { code: "task_models_unreadable" } });
  });
  it("1순위를 쓸 수 있으면 그 연결·모델의 로컬 계약 하나로 이 줄의 일을 모두 맡는다 — 키는 연결의 키, 일 수는 1", async () => {
    const plan = await assistLanePlan("regular", ENV, deps([rank("assist-review", 1, gpu, "qwen3.8-flash-next"), rank("assist-review", 2, m3, "deepseek-v4.1-flash-1017")]));
    expect(plan.source).toBe("ranks");
    if (plan.source !== "ranks") return;
    expect(plan.drains).toHaveLength(1);
    expect(plan.drains[0]).toMatchObject({ backendId: "gpu3090-qwen", tasks: REGULAR, maxClaims: ASSIST_RANK_MAX_CLAIMS, apiKey: "sk-gpu",
      rank: { rank: 1, connectionId: GPU, connectionLabel: "gpu3090", model: "qwen3.8-flash-next" } });
    expect(plan.degraded).toBeNull();
    expect(plan.summary).toEqual({ ranks: 2, "served.1": 0 });
  });
  it("앞 순위를 쓸 수 없으면 까닭을 남기고 다음 순위로 — 계약 없음·계열 아님·경로 없음·연결 꺼짐·CLI", async () => {
    const opencode = connection(OPENCODE, "M3 OpenCode", "http://100.92.77.66:4096", { kind: "cli", cliTool: "opencode" });
    const cases: [AiTaskRank, string][] = [
      [rank("assist-review", 1, connection(GPU, "gpu3090", "http://other.test/v1"), "qwen3.8-flash-next"), "no_local_contract"],
      [rank("assist-review", 1, m3, "deepseek-v4.1-flash-1017"), "assist_family_mismatch"],
      [rank("assist-review", 1, gpu, "qwen3.8-flash-next", { enabled: false }), "rank_disabled"],
      [rank("assist-review", 1, { ...gpu, enabled: false }, "qwen3.8-flash-next"), "connection_disabled"],
      [rank("assist-review", 1, { ...gpu, keyUnreadable: true }, "qwen3.8-flash-next"), "stored_key_unreadable"],
      [rank("assist-review", 1, { ...gpu, allowedTasks: ["reason-translate"] }, "qwen3.8-flash-next"), "connection_task_not_allowed"],
      [rank("assist-review", 1, opencode, "deepseek/deepseek-v4.1-flash"), "connection_not_api"],
    ];
    for (const [first, code] of cases) {
      const plan = await assistLanePlan("regular", ENV, deps([first, rank("assist-review", 2, gpu, "qwen3.8-flash-next")].filter((row, index, all) =>
        all.findIndex(other => other.rank === row.rank) === index)));
      if (plan.source !== "ranks") throw new Error("ranks");
      expect(plan.unusable, code).toEqual([expect.objectContaining({ rank: 1, code })]);
      expect(plan.drains.map(drain => drain.rank.rank), code).toEqual([2]);
      expect(plan.summary, code).toEqual({ ranks: 2, [`unusable.1.${code}`]: 1, "served.2": 0 });
    }
    // 경로: 정책에 이 backend 의 보강 route 가 없거나 장비에 물리 상한이 없으면 그 일을 맡지 않는다 — 하나도 없으면 그 순위를 쓰지 않는다
    const noRoutes = await assistLanePlan("regular", ENV, deps([rank("assist-review", 1, gpu, "qwen3.8-flash-next")], { policy: async () => ({ mode: "open", policy: { routes: [] } }) }));
    expect(noRoutes).toMatchObject({ drains: [], degraded: { code: "all_ranks_unusable", detail: expect.stringContaining("1순위 gpu3090 · qwen3.8-flash-next: 용량 정책에 보강 경로") } });
    const partial = await assistLanePlan("regular", ENV, deps([rank("assist-review", 1, gpu, "qwen3.8-flash-next")], { policy: async () => ({ mode: "open",
      policy: { routes: routes("gpu3090-qwen", "qwen3.8-flash-next", "gpu3090-qwen", ["intro_recheck"]) } }) }));
    expect(partial.drains[0]?.tasks).toEqual(["intro_recheck"]);
    const noLimit = await assistLanePlan("regular", {}, deps([rank("assist-review", 1, gpu, "qwen3.8-flash-next")]));
    expect(noLimit).toMatchObject({ drains: [], degraded: { code: "all_ranks_unusable" } });
    // 장부가 열려 있지 않으면 경로를 미리 보지 않는다(부르는 길이 미룬다)
    const draining = await assistLanePlan("regular", {}, deps([rank("assist-review", 1, gpu, "qwen3.8-flash-next")], { policy: async () => ({ mode: "draining", policy: null }) }));
    expect(draining.drains[0]?.tasks).toEqual(REGULAR);
  });
  it("JSON 스키마를 받지 않는 계약은 쓰지 않는다", async () => {
    const plan = await assistLanePlan("regular", ENV, deps([rank("assist-review", 1, gpu, "qwen3.8-flash-next")],
      { contract: () => contract({ capabilities: { vision: false, jsonSchema: false } }) }));
    expect(plan).toMatchObject({ drains: [], unusable: [expect.objectContaining({ code: "assist_json_schema_missing" })] });
  });
  it("독립 감사 줄: 두 계열을 받고 감사 일만 맡는다 — 감사 정책이 꺼져 있으면 맡을 일이 없어 부르지 않는다(설정의 일이 아님)", async () => {
    const ranks = [rank("assist-audit", 1, m3, "deepseek-v4.1-flash-1017")];
    const plan = await assistLanePlan("audit", ENV, deps(ranks));
    expect(plan.drains[0]).toMatchObject({ backendId: "m3-deepseek", tasks: AUDIT });
    const qwen = await assistLanePlan("audit", ENV, deps([rank("assist-audit", 1, gpu, "qwen3.8-flash-next")]));
    expect(qwen.drains[0]).toMatchObject({ backendId: "gpu3090-qwen", tasks: AUDIT });
    const off = await assistLanePlan("audit", { LOCAL_MODEL_PHYSICAL_LIMITS: ENV.LOCAL_MODEL_PHYSICAL_LIMITS }, deps(ranks));
    expect(off).toEqual({ source: "ranks", drains: [], ranks: 1, unusable: [], degraded: null, summary: { ranks: 1 } });
    expect(assistLaneWork("audit", {})).toEqual([]);
    expect(assistLaneWork("audit", AUDIT_POLICY)).toEqual(AUDIT);
    expect(assistLaneWork("regular", {})).toEqual(REGULAR);
  });
  it("보강 줄의 순위는 독립 감사 줄이 읽지 않는다(작업마다 따로)", async () => {
    const plan = await assistLanePlan("audit", ENV, deps([rank("assist-review", 1, gpu, "qwen3.8-flash-next")]));
    expect(plan).toEqual({ source: "env", drains: [] });
  });
});
