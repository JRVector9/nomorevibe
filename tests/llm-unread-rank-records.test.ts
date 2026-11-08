import { describe, expect, it } from "vitest";
import { aiTask, isAiLiveTask } from "@/lib/llm/ai-tasks";
import { aiTaskRanksUnread, type AiCurrentSlot, type AiTaskRankRow } from "@/lib/operations/admin-ai-tasks";
import { buildLlmOpsView, type LlmOpsInput } from "@/lib/operations/llm-ops-view";
import { buildAdminModelsObservation } from "@/lib/operations/admin-models-observation";
import { modelCapacityPolicyHash } from "@/lib/llm/capacity";
import { buildTaskAssignView, type TaskAssignSlotInput } from "@/lib/operations/llm-task-assign-view";
import { GPU, LLM_NOW, llmClassifier, llmCliContracts, llmConnections, llmDevices, llmJobs, llmObservation, llmPolicy, llmRankRows, llmRuntime } from "./fixtures/llm-ops";

/**
 * 2026-11-08 「1단계 배정 정리」 — 실행 쪽이 1·2·3순위를 읽지 않는 작업의 순위 행은 옛 기록이다. LLM 운영 칩은 「옛」으로 흐리게, 그 작업의 실제 출처(단계 풀·감사 설정)는
 * 「실제」 칩으로 보이고, 작업 배정 줄은 「옛 순위 기록 n개 · 실행 안 함」과 기록 지우기 판을 받는다. 검색 벡터·재정렬 순위는 검색 설정이 읽으므로 옛 기록이 아니다.
 */
const stale: AiTaskRankRow = { task: "held-review-retry", slot: 1, rank: 1, connectionId: GPU, model: "qwen3.8-flash-next", options: {}, enabled: true };
const current: AiCurrentSlot[] = [{ task: "held-review-retry", slot: 1, source: "단계별 모델 풀", error: null, skip: null, notes: [],
  uses: [{ kind: "api", baseUrl: "http://100.77.43.63:8090/v1", cliTool: null, model: "qwen3.8-flash-next", provider: "local-direct", origin: "단계 풀", deviceId: "gpu3090-qwen", keyFrom: null }] }];
const llm = (patch: Partial<LlmOpsInput> = {}) => buildLlmOpsView({ now: LLM_NOW, observation: llmObservation(), connections: llmConnections, rows: [...llmRankRows, stale],
  executions: [], current, runtime: llmRuntime, jobs: llmJobs, cliContracts: llmCliContracts, classifier: llmClassifier, ...patch });

describe("순위를 읽지 않는 작업 가르기", () => {
  it("순위를 읽는 작업·검색 벡터·재정렬은 아니고, 감사·보류·갈림 판가름 같은 단계 풀 작업은 옛 기록이다", () => {
    for (const task of ["first-review", "second-review", "product-translate", "product-search-verify", "product-audit", "grok-session-check"]) expect(aiTaskRanksUnread(task), task).toBe(false);
    for (const task of ["product-embedding", "search-embedding", "search-rerank"]) { expect(isAiLiveTask(task)).toBe(false); expect(aiTaskRanksUnread(task), task).toBe(false); }
    for (const task of ["assist-review", "audit-review", "audit-second-opinion", "held-review-retry", "published-filter", "screen-review", "split-tiebreak",
      "assist-audit", "human-review", "split-confirm", "korean-translation-direct", "product-intro-check"]) expect(aiTaskRanksUnread(task), task).toBe(true);
  });
});

describe("LLM 운영 칩", () => {
  it("옛 순위 행은 「record」 칩(잡 고치기 없음), 실제 출처는 주소가 같은 연결에 「current」 칩 — 둘 다 같은 모델 줄에 붙는다", () => {
    const gpu = llm().rows.find(row => row.key === GPU)!;
    const record = gpu.tasks.find(chip => chip.key === "record:held-review-retry:1:1")!;
    expect(record).toMatchObject({ source: "record", rank: 1, model: "qwen3.8-flash-next", fix: null, href: "/admin/models/tasks#execution-held-review-retry-1" });
    expect(gpu.tasks.find(chip => chip.key === "current:held-review-retry:1:qwen3.8-flash-next")).toMatchObject({ source: "current", rank: null, label: "보류 재심사" });
    expect(gpu.modelTasks["qwen3.8-flash-next"].map(chip => chip.source)).toEqual(expect.arrayContaining(["rank", "record", "current"]));
    // 다른 연결에는 붙지 않는다
    for (const row of llm().rows.filter(entry => entry.key !== GPU)) expect(row.tasks.some(chip => chip.task === "held-review-retry"), row.label).toBe(false);
  });
  it("옛 기록만 남은 연결은 「배정 없음」 — 실행되지 않는 순위를 배정으로 세지 않는다", () => {
    // 장부 경보가 상태를 덮지 않게 장부 행이 없는 관측으로 본다
    const quiet = buildAdminModelsObservation({ observedAt: LLM_NOW, control: { mode: "open", epoch: 4, revision: 12, policy: llmPolicy, policyHash: modelCapacityPolicyHash(llmPolicy),
      updatedAt: "2026-11-07T07:15:00.000Z" }, metrics: [], requests: [], devices: llmDevices });
    const view = llm({ rows: [stale], current: null, observation: quiet });
    const gpu = view.rows.find(row => row.key === GPU)!;
    expect(gpu.tasks.map(chip => chip.source)).toEqual(["record"]);
    expect(gpu.status.text).toBe("배정 없음");
  });
});

describe("작업 배정 줄", () => {
  const slot = (taskId: string, rows: readonly AiTaskRankRow[], revision: string | undefined): TaskAssignSlotInput => {
    const task = aiTask(taskId)!;
    return { task, slot: 1, label: task.label, rows, options: [], current: null, sameAsCurrent: null, readiness: [], live: isAiLiveTask(taskId), runtime: null,
      ...(revision ? { revision } : {}) };
  };
  it("순위를 읽지 않는 작업에 남은 행이 있으면 개수와 판, 없거나 순위를 읽는 작업이면 null", () => {
    const view = buildTaskAssignView({ now: LLM_NOW, observation: llmObservation(), connections: llmConnections, executions: [], jobs: llmJobs,
      slots: [slot("held-review-retry", [stale], "a".repeat(64)), slot("split-tiebreak", [], "b".repeat(64)),
        slot("crawl-tagline", llmRankRows.filter(row => row.task === "crawl-tagline"), "c".repeat(64)), slot("audit-review", [{ ...stale, task: "audit-review" }], undefined)] });
    const records = Object.fromEntries(view.rows.map(row => [row.task, row.records]));
    expect(records).toEqual({ "held-review-retry": { count: 1, revision: "a".repeat(64) }, "split-tiebreak": null, "crawl-tagline": null, "audit-review": null });
  });
});
