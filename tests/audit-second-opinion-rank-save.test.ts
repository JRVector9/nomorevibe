import { afterEach, describe, expect, it, vi } from "vitest";
import { AI_TASKS, aiTask, aiTaskRankScopeNote, aiTaskReadsRanks, isAiLiveTask, isAiRankSavableTask } from "@/lib/llm/ai-tasks";
import { aiRankPendingText, aiRankReadiness, aiRanksReadiness, aiTaskRanksUnread, type AiConnectionView, type AiReadinessInput } from "@/lib/operations/admin-ai-tasks";
import { aiTaskEditTarget } from "@/lib/operations/ai-task-edit-target";
import { auditSecondOpinionRankIssues, auditSecondOpinionSavedScope } from "@/lib/operations/audit-second-opinion-ranks";
import { buildTaskRankEditor } from "@/lib/operations/flow-rank-editor";

/**
 * 2026-11-17 「deepseek 2순위로 넣어」(PR #988 이어서) — 감사 두 번째 의견 순위를 화면·CLI 로 저장받는다.
 * 1순위 = 기본 Qwen 직접 설정(다르면 거절), 2·3순위 = 같은 모델 재판정 거절의 두 번째 의견(저장이 local-second-opinion 계약·정책 route 를 둔다).
 * 다른 작업(공개분 추가 검수 등)의 live 여부·저장 거절은 그대로다.
 */
const QWEN = "11111111-1111-4111-8111-111111111111", DS = "22222222-2222-4222-8222-222222222222", OTHER_QWEN = "33333333-3333-4333-8333-333333333333";
const QWEN_BASE = "http://100.77.43.63:8090/v1", DS_BASE = "http://100.92.77.66:8010/v1";
const QWEN_MODEL = "qwen3.8-flash-next", DS_MODEL = "deepseek-v4.1-flash-1017";
const connection = (patch: Partial<AiConnectionView> & Pick<AiConnectionView, "id" | "label" | "kind">): AiConnectionView => ({ baseUrl: null, host: null, hasKey: false,
  cliTool: null, cliModels: [], models: null, modelsReadAt: null, modelsError: null, deviceId: patch.label.toLowerCase(), capacitySlots: 2, contextTokens: null, enabled: true,
  version: 1, note: null, updatedBy: "t", updatedAt: "2026-11-17T00:00:00.000Z", cliVersion: null, ...patch });
const qwen = connection({ id: QWEN, label: "gpu3090-qwen", kind: "api", baseUrl: QWEN_BASE, deviceId: "gpu3090-qwen", models: [{ id: QWEN_MODEL, maxModelLen: 131072 }] });
const deepseek = connection({ id: DS, label: "m3-deepseek", kind: "api", baseUrl: DS_BASE, deviceId: "m3", models: [{ id: DS_MODEL, maxModelLen: 131072 }] });
const otherQwen = connection({ id: OTHER_QWEN, label: "supa", kind: "api", baseUrl: "http://supa.test:8000/v1", deviceId: "supa", models: [{ id: `Inferact/${QWEN_MODEL}`, maxModelLen: 32768 }] });
const CONNECTIONS = [qwen, deepseek, otherQwen];
const PRIMARY = { baseUrl: QWEN_BASE, model: QWEN_MODEL };
const pick = (provider: string, model: string) => ({ provider, model });

describe("저장받는 작업 — 감사 두 번째 의견만 늘고, 다른 작업의 live 여부는 그대로", () => {
  it("감사 두 번째 의견은 저장받지만 live(1순위부터 실행이 읽음)는 아니다 — 편집기로 열리고 옛 기록이 아니다", () => {
    expect(isAiLiveTask("audit-second-opinion")).toBe(false);
    expect(aiTaskReadsRanks("audit-second-opinion", true)).toBe(false);
    expect(isAiRankSavableTask("audit-second-opinion")).toBe(true);
    expect(aiTaskRankScopeNote("audit-second-opinion")).toContain("2·3순위는 변경 재판정 거절을 1순위와 같은 모델이 냈을 때");
    expect(aiTaskEditTarget("audit-second-opinion")).toBeNull();
    expect(aiTaskRanksUnread("audit-second-opinion")).toBe(false);
  });
  it("공개분 추가 검수 등 다른 작업은 바뀌지 않는다 — 같은 잡(audit-second-opinion)을 쓰는 published-filter 도 저장 거절·실제 적용 설정 안내 그대로", () => {
    expect(aiTask("published-filter")).toMatchObject({ jobs: ["audit-second-opinion"], routeId: "local-published-filter", wiring: "local-direct" });
    for (const id of ["published-filter", "audit-review", "screen-review", "held-review-retry", "split-tiebreak", "split-confirm", "human-review", "product-intro-check"]) {
      expect(isAiLiveTask(id), id).toBe(false);
      expect(isAiRankSavableTask(id), id).toBe(false);
      expect(aiTaskRankScopeNote(id), id).toBeNull();
      expect(aiTaskEditTarget(id), id).not.toBeNull();
      expect(aiTaskRanksUnread(id), id).toBe(true);
    }
    // 순위 일부만 읽는 작업은 감사 두 번째 의견 하나뿐이고, 나머지 작업의 live 는 isAiLiveTask 그대로다
    expect(AI_TASKS.filter(task => aiTaskRankScopeNote(task.id)).map(task => task.id)).toEqual(["audit-second-opinion"]);
    expect(AI_TASKS.filter(task => isAiRankSavableTask(task.id) !== isAiLiveTask(task.id)).map(task => task.id)).toEqual(["audit-second-opinion"]);
  });
});

describe("1순위 규칙 — 기본 Qwen 직접 설정과 다르면 거절(경고가 아니라)", () => {
  it("1순위가 기본 설정의 서버·모델이고 2순위가 다른 모델이면 통과(주소 끝의 / 차이는 같다)", () => {
    expect(auditSecondOpinionRankIssues([pick(QWEN, QWEN_MODEL), pick(DS, DS_MODEL)], CONNECTIONS, PRIMARY)).toEqual([]);
    expect(auditSecondOpinionRankIssues([pick(QWEN, QWEN_MODEL)], CONNECTIONS, { baseUrl: `${QWEN_BASE}/`, model: QWEN_MODEL })).toEqual([]);
  });
  it("1순위가 다른 모델·다른 서버·빈칸이면 거절하고, 왜 거절하는지(실행은 기본 설정을 읽음)를 적는다", () => {
    const [wrongModel] = auditSecondOpinionRankIssues([pick(DS, DS_MODEL)], CONNECTIONS, PRIMARY);
    expect(wrongModel).toContain("1순위는 기본 Qwen 직접 설정(100.77.43.63:8090 · qwen3.8-flash-next)과 같은 서버·모델이어야 합니다");
    expect(wrongModel).toContain("실행 모델이 바뀐다고 오해");
    expect(auditSecondOpinionRankIssues([pick(OTHER_QWEN, `Inferact/${QWEN_MODEL}`)], CONNECTIONS, PRIMARY)[0]).toContain("1순위는 기본 Qwen 직접 설정");
    expect(auditSecondOpinionRankIssues([null, pick(DS, DS_MODEL)], CONNECTIONS, PRIMARY)[0]).toContain("1순위는 기본 Qwen 직접 설정");
  });
  it("2·3순위가 기본 모델과 같은 모델(다른 서버라도)이면 독립 의견이 아니라 거절한다", () => {
    expect(auditSecondOpinionRankIssues([pick(QWEN, QWEN_MODEL), pick(OTHER_QWEN, `Inferact/${QWEN_MODEL}`)], CONNECTIONS, PRIMARY))
      .toEqual([`2순위: 기본 모델(${QWEN_MODEL})과 같은 모델이라 독립된 두 번째 의견이 되지 않습니다. 다른 계열의 모델을 고르세요.`]);
  });
  it("모두 비우기는 받는다(실행은 PR #988 전과 같다). 기본 설정을 못 읽으면 거절한다", () => {
    expect(auditSecondOpinionRankIssues([], CONNECTIONS, PRIMARY)).toEqual([]);
    expect(auditSecondOpinionRankIssues([null, null], CONNECTIONS, null)).toEqual([]);
    expect(auditSecondOpinionRankIssues([pick(QWEN, QWEN_MODEL)], CONNECTIONS, null)[0]).toContain("기본 Qwen 직접 설정");
  });
  it("저장 결과 설명: 1순위는 실행을 바꾸지 않고, 2순위는 같은 모델 재판정 거절에만 쓴다", () => {
    expect(auditSecondOpinionSavedScope("audit-second-opinion", [pick(QWEN, QWEN_MODEL), pick(DS, DS_MODEL)], CONNECTIONS)).toBe(
      "1순위 gpu3090-qwen · qwen3.8-flash-next은(는) 기본 Qwen 직접 설정과 같아 실행 모델이 바뀌지 않습니다. 2순위 m3-deepseek · deepseek-v4.1-flash-1017은(는) "
      + "변경 재판정 거절을 1순위와 같은 모델이 냈을 때 그 항목의 두 번째 의견에만 씁니다. 공개분 추가 검수와 다른 감사 의견은 그대로입니다.");
    expect(auditSecondOpinionSavedScope("audit-second-opinion", [pick(QWEN, QWEN_MODEL)], CONNECTIONS)).toContain("2순위가 없어 변경 재판정 거절에 다른 모델을 고르지 않습니다");
    expect(auditSecondOpinionSavedScope("audit-second-opinion", [], CONNECTIONS)).toContain("순위를 비웠습니다");
    expect(auditSecondOpinionSavedScope("crawl-tagline", [pick(QWEN, QWEN_MODEL)], CONNECTIONS)).toBeNull();
  });
});

describe("저장 전 준비 확인 — 2·3순위는 local-second-opinion 로컬 계약·정책 route 를 둔다", () => {
  const task = aiTask("audit-second-opinion")!;
  const backend = (connectionId: string, model: string) => `api-${connectionId.slice(0, 8)}-${model}`;
  const qwenRoute = { routeId: "local-second-opinion", provider: "local-direct", model: QWEN_MODEL, providerBudgetId: "gpu3090-qwen", groupId: "gpu3090-qwen" };
  const humanDeepseek = { routeId: "local-human-deepseek", provider: "local-direct", model: DS_MODEL, providerBudgetId: "m3-deepseek", groupId: "m3" };
  const input = (patch: Partial<AiReadinessInput> = {}): AiReadinessInput => ({ contracts: [], engineRoutes: [], cliContractRoutes: [],
    localContract: id => id === "gpu3090-qwen" ? { model: QWEN_MODEL, endpoint: `${QWEN_BASE}/chat/completions` }
      : id === "m3-deepseek" ? { model: DS_MODEL, endpoint: `${DS_BASE}/chat/completions` } : null,
    localContracts: [{ backendId: "gpu3090-qwen", model: QWEN_MODEL, endpoint: `${QWEN_BASE}/chat/completions`, physicalGroup: "gpu3090-qwen" },
      { backendId: "m3-deepseek", model: DS_MODEL, endpoint: `${DS_BASE}/chat/completions`, physicalGroup: "m3" }],
    localContractTableCount: 2, localBackendId: backend,
    policy: { mode: "open", routes: [qwenRoute, humanDeepseek], groupLimits: { "gpu3090-qwen": 2, m3: 1 } },
    devices: new Map([["gpu3090-qwen", { enabled: true, limitSlots: 2, physicalLimit: 2 }], ["m3", { enabled: true, limitSlots: 1, physicalLimit: 1 }]]), ...patch });

  it("1순위는 예전 그대로 이미 있는 정책 route·로컬 계약만 확인하고 아무것도 만들지 않는다", () => {
    const ready = aiRankReadiness(task, 1, qwen, QWEN_MODEL, input());
    expect(ready).toMatchObject({ blocking: [], provider: "local-direct", appendRoute: null, createDevice: null });
    expect(ready).not.toHaveProperty("createLocalContract");
    // 1순위 경로가 없으면 예전처럼 막는다(1순위로 새 경로를 만들지 않는다)
    expect(aiRankReadiness(task, 1, qwen, QWEN_MODEL, input({ policy: { mode: "open", routes: [humanDeepseek], groupLimits: {} } })).blocking[0])
      .toContain("용량 정책에 local-second-opinion / local-direct / qwen3.8-flash-next 경로가 없습니다");
  });
  it("2순위 M3 DeepSeek: 같은 주소·모델의 기존 계약(위임 검수가 쓰는 것)을 다시 쓰고 local-second-opinion route 만 덧붙인다 — 새 계약·엔진 시험 없음", () => {
    const [, ready] = aiRanksReadiness(task, [{ rank: 1, connection: qwen, model: QWEN_MODEL }, { rank: 2, connection: deepseek, model: DS_MODEL }], input());
    expect(ready).toMatchObject({ blocking: [], warnings: [], provider: "local-direct", createContract: null, createDevice: null,
      appendRoute: { routeId: "local-second-opinion", provider: "local-direct", model: DS_MODEL, providerBudgetId: "m3-deepseek", groupId: "m3" } });
    expect(ready).not.toHaveProperty("createLocalContract");
    expect(aiRankPendingText(ready)).toEqual([`2순위 ${DS_MODEL}: 용량 정책에 local-second-opinion / local-direct 경로가 없습니다 — 저장하면 덧붙입니다(DRAIN 없음).`]);
    // 이미 있으면 아무것도 만들지 않는다(다시 저장해도 같다)
    const known = { routeId: "local-second-opinion", provider: "local-direct", model: DS_MODEL, providerBudgetId: "m3-deepseek", groupId: "m3" };
    const again = aiRankReadiness(task, 2, deepseek, DS_MODEL, input({ policy: { mode: "open", routes: [qwenRoute, humanDeepseek, known], groupLimits: {} } }));
    expect(again).toMatchObject({ blocking: [], appendRoute: null });
    expect(again).not.toHaveProperty("createLocalContract");
  });
  it("2순위 계약이 없으면 그 연결 주소의 로컬 계약(두 번째 의견 경로)을 만들 것으로 적는다", () => {
    const bare = input({ localContracts: [{ backendId: "gpu3090-qwen", model: QWEN_MODEL, endpoint: `${QWEN_BASE}/chat/completions`, physicalGroup: "gpu3090-qwen" }],
      policy: { mode: "open", routes: [qwenRoute], groupLimits: {} } });
    const ready = aiRankReadiness(task, 2, deepseek, DS_MODEL, bare);
    expect(ready).toMatchObject({ blocking: [], provider: "local-direct",
      createLocalContract: { routeId: "local-second-opinion", backendId: backend(DS, DS_MODEL), endpoint: `${DS_BASE}/chat/completions`, model: DS_MODEL, physicalGroup: "m3" },
      appendRoute: { routeId: "local-second-opinion", provider: "local-direct", model: DS_MODEL, providerBudgetId: backend(DS, DS_MODEL), groupId: "m3" } });
    expect(aiRankPendingText(ready)[0]).toBe(`2순위 ${DS_MODEL}: 두 번째 의견 경로(local-second-opinion)의 로컬 계약이 없습니다 — 이 줄을 저장하면 연결 주소를 확인하고 만듭니다.`);
  });
  it("같은 주소의 계약이 다른 장비에 있으면 막는다(감사 직접 경로와 같은 규칙, 문장은 두 번째 의견 경로)", () => {
    const ready = aiRankReadiness(task, 2, { ...deepseek, deviceId: "m3-other" }, DS_MODEL, input());
    expect(ready.blocking[0]).toContain("이 서버·모델의 로컬 계약(m3-deepseek)은 장비 m3입니다");
    const known = { routeId: "local-second-opinion", provider: "local-direct", model: DS_MODEL, providerBudgetId: "elsewhere", groupId: "m3" };
    const conflict = aiRankReadiness(task, 2, deepseek, DS_MODEL, input({ policy: { mode: "open", routes: [qwenRoute, known], groupLimits: {} },
      localContract: () => ({ model: DS_MODEL, endpoint: "http://other.test:8010/v1/chat/completions" }) }));
    expect(conflict.blocking[0]).toContain("두 번째 의견 경로(local-second-opinion)의 deepseek-v4.1-flash-1017은(는) 이미 다른 서버");
  });
  it("공개분 추가 검수(같은 local-direct 배선)는 2순위라도 예전 규칙 그대로 — 경로를 만들지 않는다", () => {
    const ready = aiRankReadiness(aiTask("published-filter")!, 2, deepseek, DS_MODEL, input());
    expect(ready.blocking[0]).toContain("용량 정책에 local-published-filter / local-direct / deepseek-v4.1-flash-1017 경로가 없습니다");
    expect(ready.appendRoute).toBeNull();
  });
});

describe("관리 화면 편집기 줄", () => {
  it("감사 두 번째 의견 줄은 잠기지 않고 설명(scope)을 싣는다 — 공개분 추가 검수 줄은 그대로 실제 적용 설정으로 보낸다", () => {
    const editor = buildTaskRankEditor(CONNECTIONS, [], () => "0".repeat(64));
    const line = editor.lines.find(entry => entry.task === "audit-second-opinion")!;
    expect(line).toMatchObject({ live: false, lock: null, scope: aiTaskRankScopeNote("audit-second-opinion") });
    expect(line.options.map(option => `${option.provider}|${option.model}`)).toEqual(expect.arrayContaining([`${QWEN}|${QWEN_MODEL}`, `${DS}|${DS_MODEL}`]));
    const published = editor.lines.find(entry => entry.task === "published-filter")!;
    expect(published.lock).toContain("실제 적용 설정에서 변경하세요");
    expect(published).not.toHaveProperty("scope");
  });
});

describe("운영 스크립트 set — 결과 JSON 한 줄 + stderr 「범위 …」", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.doUnmock("@/lib/operations/admin-ai-tasks-repository"); vi.resetModules(); });
  it("감사 두 번째 의견 저장은 scope 를 stdout JSON 과 stderr 범위 줄로 보이고, 거절은 종료 코드 1", async () => {
    const scope = auditSecondOpinionSavedScope("audit-second-opinion", [pick(QWEN, QWEN_MODEL), pick(DS, DS_MODEL)], CONNECTIONS)!;
    const save = vi.fn().mockResolvedValue({ ok: true, revision: "r".repeat(64), warnings: [], created: { devices: [], contracts: [], routes: ["local-second-opinion / local-direct / x → m3"] }, scope });
    vi.doMock("@/lib/operations/admin-ai-tasks-repository", () => ({ previewAiTaskImport: vi.fn(), applyAiTaskImport: vi.fn(), saveAiTaskRanks: save,
      readAiTasksAdminView: vi.fn().mockResolvedValue({ connections: CONNECTIONS, slots: [{ task: aiTask("audit-second-opinion"), slot: 1, revision: "0".repeat(64) }] }) }));
    const { runAiTaskRanks } = await import("../scripts/ops/ai-task-ranks");
    const log = vi.spyOn(console, "log").mockImplementation(() => {}), err = vi.spyOn(console, "error").mockImplementation(() => {});
    const argv = ["set", "--operator=it", "--task=audit-second-opinion", "--slot=1", `--rank1=gpu3090-qwen|${QWEN_MODEL}`, `--rank2=m3-deepseek|${DS_MODEL}`];
    expect(await runAiTaskRanks(argv)).toBe(0);
    expect(save).toHaveBeenCalledWith({ task: "audit-second-opinion", slot: 1, revision: "0".repeat(64), ranks: [pick(QWEN, QWEN_MODEL), pick(DS, DS_MODEL)] }, "it");
    expect(log.mock.calls).toHaveLength(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ task: "audit-second-opinion", slot: 1, ok: true, scope });
    expect(err.mock.calls.flat()).toEqual([`범위 ${scope}`]);
    save.mockResolvedValue({ ok: false, issues: ["1순위는 기본 Qwen 직접 설정(…)과 같은 서버·모델이어야 합니다"] });
    expect(await runAiTaskRanks(["set", "--operator=it", "--task=audit-second-opinion", `--rank1=m3-deepseek|${DS_MODEL}`])).toBe(1);
    // --operator 가 없으면 사용법(2) — 운영 명령에는 --operator=<이름> 이 꼭 있어야 한다
    expect(await runAiTaskRanks(["set", "--task=audit-second-opinion", "--slot=1", `--rank1=gpu3090-qwen|${QWEN_MODEL}`])).toBe(2);
  });
});
