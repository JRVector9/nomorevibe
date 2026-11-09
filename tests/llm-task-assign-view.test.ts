import { describe, expect, it } from "vitest";
import { aiTask, isAiLiveTask } from "@/lib/llm/ai-tasks";
import type { AiCurrentSlot, AiTaskRankRow } from "@/lib/operations/admin-ai-tasks";
import type { AiTaskRuntimeView } from "@/lib/operations/admin-ai-tasks-repository";
import { buildAdminModelsObservation, unavailableAdminModels, type AdminModelMetrics } from "@/lib/operations/admin-models-observation";
import { buildTaskRankEditor, rankDeviceImpact, rankResaves } from "@/lib/operations/flow-rank-editor";
import { buildTaskAssignView, taskAssignDeviceLimits, withTaskReadiness, type TaskAssignInput, type TaskAssignSlotInput } from "@/lib/operations/llm-task-assign-view";
import { CLAUDE, GPU, LLM_NOW, llmConnections, llmDevices, llmJobs, llmMetrics, llmObservation, llmPolicy, llmRankRows, llmRequests, llmRuntime, M1, MLX, OPENCODE, SUPA } from "./fixtures/llm-ops";
import { modelCapacityPolicyHash } from "@/lib/llm/capacity";

/** 작업 × 칸 하나의 입력 — 화면이 readAiTasksAdminView 에서 받는 값과 같은 모양(운영 DB 를 읽지 않는다) */
function slotOf(taskId: string, slot = 1, patch: Partial<TaskAssignSlotInput> = {}, rows: readonly AiTaskRankRow[] = llmRankRows): TaskAssignSlotInput {
  const task = aiTask(taskId)!;
  const own = rows.filter(row => row.task === taskId && row.slot === slot).sort((a, b) => a.rank - b.rank);
  return { task, slot, label: task.slots > 1 ? `${task.label} · 투표자 ${slot}` : task.label, rows: own, options: [], current: null, sameAsCurrent: null,
    readiness: own.map(row => ({ rank: row.rank, connectionId: row.connectionId, model: row.model, identity: row.model, blocking: [], warnings: [], createDevice: null,
      createContract: null, appendRoute: null, createCliContract: null, provider: null } as TaskAssignSlotInput["readiness"][number])),
    live: isAiLiveTask(taskId), runtime: llmRuntime[taskId] ?? null, ...patch };
}
const ALL = ["first-review#1", "second-review#1", "second-review#2", "second-review#3", "crawl-tagline#1", "product-search-profile#1", "product-search-verify#1",
  "search-query-translate#1", "product-embedding#1", "product-intro-check#1", "publish-classify#1"];
const input = (patch: Partial<TaskAssignInput> = {}): TaskAssignInput => ({ now: LLM_NOW, observation: llmObservation(), connections: llmConnections,
  slots: ALL.map(key => { const [task, slot] = key.split("#"); return slotOf(task, Number(slot)); }), executions: [], jobs: llmJobs, ...patch });
const rowOf = (view: ReturnType<typeof buildTaskAssignView>, key: string) => view.rows.find(row => row.key === key)!;
const observationWith = (metrics: AdminModelMetrics[]) => buildAdminModelsObservation({ observedAt: LLM_NOW, control: { mode: "open", epoch: 4, revision: 12, policy: llmPolicy,
  policyHash: modelCapacityPolicyHash(llmPolicy), updatedAt: "2026-11-07T07:15:00.000Z" }, metrics, requests: llmRequests, devices: llmDevices });
const metric = (routeId: string, provider: string, model: string, groupId: string, succeeded1h: number, patch: Partial<AdminModelMetrics> = {}): AdminModelMetrics => ({
  routeId, provider, model, groupId, providerBudgetId: groupId, succeeded1h, failed1h: 0, withdrawn1h: 0, unclassified1h: 0, waiting: 0, reserved: 0, dispatched: 0,
  indeterminate: 0, lastSuccessAt: null, ...patch });

describe("작업 배정 — 설정 vs 실제(buildTaskAssignView)", () => {
  it("1·2·3순위 칸과 장부의 모델별 1시간 정산을 한 줄에 — 1순위가 아닌 모델이 절반 이상이면 「설정과 다름」", () => {
    const first = rowOf(buildTaskAssignView(input()), "first-review#1");
    expect(first).toMatchObject({ anchor: "execution-first-review-1", mode: "fallback", modeText: "대체 실행", merged: false });
    expect(first.choices.map(choice => [choice.position, choice.connection, choice.model])).toEqual([
      [1, "M3 OpenCode(OpenCode CLI)", "deepseek/deepseek-v4.1-flash"], [2, "gpu3090-qwen", "qwen3.8-flash-next"]]);
    // 장부: OpenCode 84 성공 + 2 실패 = 86, qwen 93
    expect(first.actual.calls.map(call => [call.position, call.model, call.settled, call.failed])).toEqual([
      [1, "deepseek/deepseek-v4.1-flash", 86, 2], [2, "qwen3.8-flash-next", 93, 0]]);
    expect(first.actual.settled).toBe(179);
    expect(first.actual.warnings).toEqual(["1순위가 아닌 모델이 52%를 처리"]);
    // 상태: 실행 쪽이 마지막 틱(30분 안)에 1순위를 시간 초과로 건너뛴 까닭이 먼저, 실패·미확정이 뒤따른다
    expect(first.status).toMatchObject({ level: "warn", text: "주의", reason: "1순위 건너뜀: 시간 초과 1회 · 1시간 실패 2건 / 정산 179" });
    expect(first.status.detail).toContain("결과 미확정 1건");
  });

  it("1순위가 0건인데 다른 모델이 처리했으면 경고하고, 순위에 없는 모델이 불렸으면 그 모델과 건수를 적는다", () => {
    const metrics = [metric("crawl-tagline", "abcllm", "deepseek-v4.1-flash-1017", "m3-mlx", 40), metric("crawl-tagline", "abcllm", "qwen3.6-35b-heretic", "m3-mlx", 3)];
    const rows = [...llmRankRows, { task: "crawl-tagline", slot: 1, rank: 2, connectionId: MLX, model: "deepseek-v4.1-flash-1017", options: {}, enabled: true }];
    const row = rowOf(buildTaskAssignView(input({ observation: observationWith(metrics), slots: [slotOf("crawl-tagline", 1, {}, rows)] })), "crawl-tagline#1");
    expect(row.actual.calls.map(call => [call.position, call.model, call.settled])).toEqual([[1, "gpt-oss-120b", 0], [2, "deepseek-v4.1-flash-1017", 40], [null, "qwen3.6-35b-heretic", 3]]);
    expect(row.actual.warnings).toEqual(["1순위 gpt-oss-120b 0건 — 다른 모델이 처리", "순위에 없는 모델 호출: qwen3.6-35b-heretic 3건"]);
    expect(row.status).toMatchObject({ level: "warn", reason: "설정과 다름: 1순위 gpt-oss-120b 0건 — 다른 모델이 처리" });
    // 1순위가 거의 다 맡으면 경고 없음 — 2순위가 49%면 아직 아니다
    const ok = rowOf(buildTaskAssignView(input({ observation: observationWith([metric("crawl-tagline", "abcllm", "gpt-oss-120b", "m3-mlx", 51),
      metric("crawl-tagline", "abcllm", "deepseek-v4.1-flash-1017", "m3-mlx", 49)]), slots: [slotOf("crawl-tagline", 1, {}, rows)] })), "crawl-tagline#1");
    expect(ok.actual.warnings).toEqual([]);
    expect(ok.status).toMatchObject({ level: "ok", text: "정상", reason: "1시간 정산 100" });
  });

  it("연결로 가른 장부 이름(model@연결8자)·제공자 접두어가 달라도 같은 순위로 센다", () => {
    const metrics = [metric("crawl-agent-review", "opencode-cli", "deepseek-v4.1-flash", "m3-opencode-host", 10),
      metric("crawl-agent-review", "local-direct", `qwen3.8-flash-next@${GPU.slice(0, 8)}`, "gpu3090-qwen", 2)];
    const row = rowOf(buildTaskAssignView(input({ observation: observationWith(metrics), slots: [slotOf("first-review")] })), "first-review#1");
    expect(row.actual.calls.map(call => [call.position, call.settled])).toEqual([[1, 10], [2, 2]]);
    expect(row.actual.warnings).toEqual([]);
  });

  it("2차 투표자: 장부는 투표자를 가르지 않는다 — 칸마다 1순위 0건을 보고, 작업 전체 경고는 투표자 1 줄에만", () => {
    const view = buildTaskAssignView(input());
    const voter1 = rowOf(view, "second-review#1"), voter2 = rowOf(view, "second-review#2"), voter3 = rowOf(view, "second-review#3");
    expect(voter1.actual).toMatchObject({ shared: true, warnings: [], settled: 105 });
    expect(voter1.status).toMatchObject({ level: "ok", reason: "1시간 정산 105 (작업 전체)" });
    expect(voter2.actual.calls).toEqual([expect.objectContaining({ position: 1, model: "gpt-oss-120b", settled: 0 })]);
    expect(voter2.actual.warnings).toEqual(["1순위 gpt-oss-120b 0건 — 다른 모델이 처리"]);
    // 빈 투표자 칸은 작업을 멈추지 않는다
    expect(voter3.status).toMatchObject({ level: "idle", text: "비어 있음" });
    expect(voter3.choices).toEqual([]);
  });

  it("호출이 없을 때 까닭: 잡 일시중지 · 순위 없음 · 모든 순위 사용 불가 · 웹 요청 없음 · 장부 밖 작업 · 장부를 못 읽음", () => {
    const view = buildTaskAssignView(input());
    const verify = rowOf(view, "product-search-verify#1");
    expect(verify.actual).toMatchObject({ empty: "호출 없음 (잡 일시중지)", calls: [expect.objectContaining({ position: 1, settled: 0 })], warnings: [] });
    expect(verify.status).toMatchObject({ level: "idle", text: "의도적 중지", reason: "잡 일시중지: product-search-verify" });
    expect(verify.paused).toBe(true);
    const query = rowOf(view, "search-query-translate#1");
    expect(query.actual.empty).toBe("호출 없음 (순위 없음)");
    expect(query.status).toMatchObject({ level: "bad", text: "멈춤", reason: "순위 없음 — 이 작업은 돌지 않습니다" });
    const embedding = rowOf(view, "product-embedding#1");
    expect(embedding.actual).toMatchObject({ tracked: false, settled: null, empty: "장부 밖 작업 — 호출 수를 세지 않습니다" });
    // 모든 순위를 쓸 수 없던 틱(30분 안) — 까닭을 괄호에, 상태는 멈춤
    const degraded: AiTaskRuntimeView = { from: "job", at: "2026-11-07T07:10:00.000Z", served: [], unusable: [{ rank: 1, code: "provider_contract_unavailable", text: "전송 계약이 닫힘", count: 4 }],
      degraded: { code: "all_ranks_unusable", detail: "1순위 m3-mlx · gpt-oss-120b: 전송 계약이 닫힘" } };
    const stuck = rowOf(buildTaskAssignView(input({ observation: observationWith([]), slots: [slotOf("product-search-profile", 1, { runtime: degraded })] })), "product-search-profile#1");
    expect(stuck.actual.empty).toBe("호출 없음 (쓸 수 있는 순위 없음)");
    expect(stuck.status).toMatchObject({ level: "bad", reason: "쓸 수 있는 순위 없음 · 1순위 건너뜀: 계약 닫힘 4회" });
    // 웹 요청 작업(잡 없음)은 순위가 있어도 요청이 없으면 쉰다
    const rows = [...llmRankRows, { task: "search-query-translate", slot: 1, rank: 1, connectionId: MLX, model: "gpt-oss-120b", options: {}, enabled: true }];
    const web = rowOf(buildTaskAssignView(input({ slots: [slotOf("search-query-translate", 1, {}, rows)] })), "search-query-translate#1");
    expect(web.actual.empty).toBe("호출 없음 (최근 웹 요청 없음)");
    expect(web.status).toMatchObject({ level: "idle", text: "쉼" });
    // 장부를 못 읽으면 0 으로 꾸미지 않는다
    const unread = buildTaskAssignView(input({ observation: unavailableAdminModels() }));
    expect(rowOf(unread, "first-review#1").actual).toMatchObject({ readable: false, settled: null, calls: [], empty: "확인 불가 — 장부를 읽지 못했습니다" });
    expect(rowOf(unread, "crawl-tagline#1").status).toMatchObject({ level: "unknown", text: "확인 불가" });
    expect(unread.errors[0]).toContain("LLM 장부(운영 DB)를 읽지 못했습니다");
  });

  it("잡이 멈춘 작업은 늘 「의도적 중지」 — 순위 문제는 자세히에 남는다; 잡 상태를 못 읽으면 멈춤으로 보지 않는다", () => {
    const blocked = slotOf("product-search-verify", 1, { readiness: [{ ...slotOf("product-search-verify").readiness[0], blocking: ["1순위 supa: 키가 없습니다"] }] });
    const row = rowOf(buildTaskAssignView(input({ slots: [blocked] })), "product-search-verify#1");
    expect(row.status).toMatchObject({ level: "idle", text: "의도적 중지" });
    expect(row.status.detail).toContain("저장된 순위를 모두 쓸 수 없음");
    const noJobs = buildTaskAssignView(input({ jobs: null, slots: [blocked] }));
    expect(rowOf(noJobs, "product-search-verify#1").status).toMatchObject({ level: "bad", reason: "저장된 순위를 모두 쓸 수 없음" });
    expect(noJobs.errors).toContain("잡 상태를 읽지 못했습니다 — 일시중지 여부가 빠질 수 있습니다.");
  });

  it("실행 쪽이 순위를 읽지 않는 작업은 실제 적용 설정과 견주고, 그 설정을 못 읽으면 「설정 밖」이라 하지 않는다", () => {
    const current: AiCurrentSlot = { task: "publish-classify", slot: 1, source: "connect 에이전트 분류 설정", error: null, skip: null, notes: [],
      uses: [{ kind: "cli", baseUrl: null, cliTool: "codex", model: "gpt-5.6-terra", provider: "codex-cli", origin: "classification", deviceId: "openai-cli", keyFrom: null, options: { reasoningEffort: "high" } }] };
    const classify = rowOf(buildTaskAssignView(input({ slots: [slotOf("publish-classify", 1, { current })] })), "publish-classify#1");
    expect(classify).toMatchObject({ mode: "classifier", modeText: "기존 CLI 분류", merged: true, source: "connect 에이전트 분류 설정" });
    expect(classify.choices).toEqual([expect.objectContaining({ position: 1, connection: "codex-cli", model: "gpt-5.6-terra", effort: "high" })]);
    expect(classify.actual).toMatchObject({ compared: true, warnings: [], calls: [expect.objectContaining({ position: 1, settled: 12 })] });
    const unknown = rowOf(buildTaskAssignView(input({ slots: [slotOf("publish-classify")] })), "publish-classify#1");
    expect(unknown.actual).toMatchObject({ compared: false, warnings: [], calls: [expect.objectContaining({ position: null, settled: 12 })] });
    expect(unknown.status).toMatchObject({ level: "unknown", reason: "실제 적용 설정을 읽지 못함" });
    // 꺼 둔 감사 작업(skip)은 의도적 중지
    const audit = rowOf(buildTaskAssignView(input({ slots: [slotOf("audit-review", 1, { current: { task: "audit-review", slot: 1, uses: [], source: "등록부·env 기본값", error: null,
      skip: "지금 꺼져 있습니다.", notes: [] } })] })), "audit-review#1");
    expect(audit).toMatchObject({ mode: "effective", modeText: "실제 적용 설정" });
    expect(audit.status).toMatchObject({ level: "idle", text: "의도적 중지", reason: "지금 꺼져 있습니다" });
    expect(audit.actual.empty).toBe("호출 없음 (지금 꺼져 있습니다)");
  });

  it("작업 분산: 구성원을 한 칸에 모으고, 구성원 하나가 0건이거나 구성에 없는 모델이 불리면 경고한다", () => {
    const members = [{ memberId: "m1", position: 1, connectionId: OPENCODE, model: "deepseek/deepseek-v4.1-flash", options: { reasoningEffort: "max" } },
      { memberId: "m2", position: 2, connectionId: GPU, model: "qwen3.8-flash-next", options: {} }, { memberId: "m3", position: 3, connectionId: MLX, model: "gpt-oss-120b", options: {} }];
    const view = buildTaskAssignView(input({ slots: [slotOf("first-review")], executions: [{ task: "first-review", slot: 1, mode: "workload_pool", members } as never] }));
    const row = rowOf(view, "first-review#1");
    expect(row).toMatchObject({ mode: "workload_pool", modeText: "작업 분산 · 3칸", merged: true });
    expect(row.choices.map(choice => [choice.position, choice.effort])).toEqual([[1, "max"], [2, null], [3, null]]);
    // 보관된 대체 순위도 보인다(지금은 쓰지 않음)
    expect(row.archived.map(choice => [choice.position, choice.model])).toEqual([[1, "deepseek/deepseek-v4.1-flash"], [2, "qwen3.8-flash-next"]]);
    expect(row.actual.calls.map(call => [call.position, call.settled])).toEqual([[1, 86], [2, 93], [3, 0]]);
    expect(row.actual.warnings).toEqual(["모델 3 gpt-oss-120b 0건 — 다른 모델만 호출"]);
    // 꺼진 연결이 구성원이면 멈춤
    const off = buildTaskAssignView(input({ connections: llmConnections.map(connection => connection.id === MLX ? { ...connection, enabled: false } : connection),
      slots: [slotOf("first-review")], executions: [{ task: "first-review", slot: 1, mode: "workload_pool", members } as never] }));
    expect(rowOf(off, "first-review#1").status).toMatchObject({ level: "bad", reason: expect.stringContaining("꺼졌거나 없는 연결") });
    // 실행 방식을 못 읽으면 견주지 않고, 저장이 잠긴다고 적는다
    const unread = buildTaskAssignView(input({ executions: null }));
    expect(rowOf(unread, "first-review#1")).toMatchObject({ modeText: "실행 방식 미확인", actual: expect.objectContaining({ warnings: [], compared: false }) });
    expect(unread.errors).toContain("실행 방식을 읽지 못했습니다 — 확인할 때까지 순위를 저장할 수 없습니다.");
  });

  it("상태 수 합계와 추론 강도·꺼진 순위 표시", () => {
    const rows = llmRankRows.map(row => row.task === "first-review" && row.rank === 1 ? { ...row, options: { reasoningEffort: "high" } }
      : row.task === "first-review" && row.rank === 2 ? { ...row, enabled: false } : row);
    const view = buildTaskAssignView(input({ slots: [slotOf("first-review", 1, {}, rows), slotOf("crawl-tagline")] }));
    expect(rowOf(view, "first-review#1").choices.map(choice => [choice.effort, choice.off])).toEqual([["high", null], [null, "순위 꺼짐"]]);
    // 꺼진 2순위의 qwen 호출은 「순위에 없는 모델」로 센다(실행이 그 순위를 쓰지 않는다)
    expect(rowOf(view, "first-review#1").actual.warnings).toContain("순위에 없는 모델 호출: qwen3.8-flash-next 93건");
    expect(Object.values(view.counts).reduce((sum, count) => sum + count, 0)).toBe(view.rows.length);
  });
});

describe("2026-11-09 상태 문구 — 운영 관측(19:27 UTC)에서 틀렸던 말", () => {
  const rank = (task: string, order: number, connectionId: string, model: string, slot = 1): AiTaskRankRow => ({ task, slot, rank: order, connectionId, model, options: {}, enabled: true });
  const current = (task: string, model: string, patch: Partial<AiCurrentSlot> = {}): AiCurrentSlot => ({ task, slot: 1, source: "단계 풀", error: null, skip: null, notes: [],
    uses: [{ kind: "api", baseUrl: "http://100.92.77.66:8010/v1", cliTool: null, model, provider: "local-direct", origin: "단계 풀", deviceId: "m3-mlx", keyFrom: null }], ...patch });
  const fresh = (patch: Partial<AiTaskRuntimeView>): AiTaskRuntimeView => ({ from: "job", at: "2026-11-07T07:19:00.000Z", served: [], unusable: [], degraded: null, ...patch });
  const quota = (order: number) => ({ rank: order, code: "model_quota", text: "이 장비에서 이 모델의 상한이 가득 참", count: 1 });

  it("F1 순위를 1시간 안에 저장했으면 그 전 호출이 섞인 장부와 견주지 않는다 — 「설정과 다름」 대신 중립 메모, 미확정·실패 신호는 그대로", () => {
    // 심사 사유 번역: 07:14Z 에 1순위를 m1 로 바꿨고, 장부 1시간에는 옛 1순위 gpt-oss 65건이 남아 있다
    const rows = [rank("reason-translate", 1, M1, "m1-gemma")];
    const metrics = [metric("reason-translate", "abcllm", "gpt-oss-120b", "m3-mlx", 65, { indeterminate: 3 }), metric("reason-translate", "abcllm", "m1-gemma", "m1-qwen", 9)];
    const at = (savedAt: string | null) => rowOf(buildTaskAssignView(input({ observation: observationWith(metrics),
      slots: [slotOf("reason-translate", 1, { savedAt }, rows)] })), "reason-translate#1");
    const saved = at("2026-11-07T07:14:00.000Z");
    expect(saved.actual).toMatchObject({ warnings: [], mixed: true, note: "순위를 6분 전에 바꿈 — 그 전 호출이 섞여 있어 17:14 이후 비교" });
    expect(saved.actual.calls.map(call => [call.position, call.model, call.settled])).toEqual([[1, "m1-gemma", 9], [null, "gpt-oss-120b", 65]]);
    expect(saved.status).toMatchObject({ level: "warn", reason: "결과 미확정 3건" });
    expect(`${saved.status.reason} ${saved.status.detail}`).not.toContain("설정과 다름");
    // 1시간이 지난 저장(또는 저장 시각 모름)은 지금처럼 견준다
    for (const old of [at("2026-11-07T06:10:00.000Z"), at(null)]) {
      expect(old.actual).toMatchObject({ mixed: false, note: null, warnings: ["1순위가 아닌 모델이 88%를 처리", "순위에 없는 모델 호출: gpt-oss-120b 65건"] });
      expect(old.status.reason).toBe("결과 미확정 3건 · 설정과 다름: 1순위가 아닌 모델이 88%를 처리");
    }
    // 1순위 0건(firstGap)도 같은 규칙
    const gap = rowOf(buildTaskAssignView(input({ observation: observationWith([metric("reason-translate", "abcllm", "gpt-oss-120b", "m3-mlx", 20)]),
      slots: [slotOf("reason-translate", 1, { savedAt: "2026-11-07T07:19:40.000Z" }, rows)] })), "reason-translate#1");
    expect(gap.actual).toMatchObject({ warnings: [], note: "순위를 방금 바꿈 — 그 전 호출이 섞여 있어 17:19 이후 비교" });
    expect(gap.status).toMatchObject({ level: "ok", text: "정상", reason: "1시간 정산 20" });
  });

  it("F2 앞 순위가 상한·칸 가득으로만 건너뛰어져 뒤 순위가 처리했으면 순위대로 대체 — 「설정과 다름」이 아니다; 다른 까닭이 섞이면 지금 경고 그대로", () => {
    // 제품 다국어 번역: 1·2순위 m3 gpt-oss 가 모델 상한 가득, 3순위 m1 이 98건을 처리
    const rows = [rank("product-translate", 1, MLX, "gpt-oss-120b"), rank("product-translate", 2, MLX, "gpt-oss-120b"), rank("product-translate", 3, M1, "m1-gemma")];
    const metrics = (indeterminate: number) => [metric("product-translate", "abcllm", "m1-gemma", "m1-qwen", 98),
      metric("product-translate", "abcllm", "mlx-community--gemma-4-26b-a4b-it-4bit", "m1-qwen", 0, { indeterminate })];
    const view = (runtime: AiTaskRuntimeView, indeterminate = 0) => rowOf(buildTaskAssignView(input({ observation: observationWith(metrics(indeterminate)),
      slots: [slotOf("product-translate", 1, { runtime }, rows)] })), "product-translate#1");
    const designed = fresh({ served: [{ rank: 3, count: 1 }], unusable: [quota(1), quota(2)] });
    const row = view(designed);
    expect(row.actual.warnings).toEqual([]);
    expect(row.status).toMatchObject({ level: "ok", text: "정상", reason: "1·2순위 모델 상한 가득 → 3순위가 처리(순위대로 대체) · 1시간 정산 98" });
    // 미확정은 그대로 주의 — 대체 설명은 까닭 옆에
    const unsettled = view(designed, 1);
    expect(unsettled.status).toMatchObject({ level: "warn", reason: "결과 미확정 1건 · 1·2순위 모델 상한 가득 → 3순위가 처리(순위대로 대체)" });
    expect(unsettled.status.detail).not.toContain("건너뜀");
    // 2순위가 계약 때문에 건너뛰어졌으면 설명되지 않는다 — 1순위 0건 경고와 건너뜀 신호를 그대로 낸다
    const broken = view(fresh({ served: [{ rank: 3, count: 1 }], unusable: [quota(1), { rank: 2, code: "no_direct_contract", text: "계약 없음", count: 1 }] }));
    expect(broken.actual.warnings).toEqual(["1순위 gpt-oss-120b 0건 — 다른 모델이 처리"]);
    expect(broken.status).toMatchObject({ level: "warn", reason: "1순위 건너뜀: 모델 상한 가득 1회 · 2순위 건너뜀: 계약 없음 1회" });
    // 오래된 순위 사정(30분 넘음)으로는 설명하지 않는다
    expect(view(fresh({ at: "2026-11-07T06:00:00.000Z", served: [{ rank: 3, count: 1 }], unusable: [quota(1), quota(2)] })).actual.warnings)
      .toEqual(["1순위 gpt-oss-120b 0건 — 다른 모델이 처리"]);
  });

  it("F3 순위 없는 2차 투표자 칸은 「비어 있음」 — 미확정·실패·순위 사정 같은 작업 전체 신호는 투표자 1 줄에만", () => {
    const rows = [rank("second-review", 1, SUPA, "supa"), rank("second-review", 2, MLX, "gpt-oss-120b")];
    const metrics = [metric("second-review", "abcllm", "supa", "supa-direct", 82, { indeterminate: 1, failed1h: 2 })];
    const runtime = fresh({ unusable: [{ rank: 1, code: "engine_slow", text: "느림", count: 2 }], served: [{ rank: 1, count: 4 }] });
    const view = buildTaskAssignView(input({ observation: observationWith(metrics), slots: [1, 2, 3].map(slot => slotOf("second-review", slot, { runtime }, rows)) }));
    const voter1 = rowOf(view, "second-review#1");
    expect(voter1.status).toMatchObject({ level: "warn" });
    expect(`${voter1.status.reason} ${voter1.status.detail}`).toContain("결과 미확정 1건");
    expect(`${voter1.status.reason} ${voter1.status.detail}`).toContain("1순위 건너뜀");
    for (const key of ["second-review#2", "second-review#3"]) {
      const row = rowOf(view, key);
      expect(row.status, key).toEqual({ level: "idle", text: "비어 있음", reason: "이 칸은 쓰지 않습니다", detail: null });
      expect(row.actual, key).toMatchObject({ calls: [], warnings: [], empty: "쓰지 않는 칸", note: null });
    }
  });

  it("F4 계약 버전만 다른 CLI 순위는 「빠진 계약·경로 — 다시 저장하면 만듦」이 아니다 — 알림으로만, 서랍도 다시 저장을 권하지 않는다", () => {
    const warning = "1순위 M3 OpenCode · deepseek/deepseek-v4.1-flash: CLI 계약은 opencode v2.2.6인데 이 연결에 기록된 M3 호스트 버전은 opencode v2.2.5입니다 — 기록은 …";
    const base = slotOf("first-review");
    const slot = slotOf("first-review", 1, { readiness: [{ ...base.readiness[0], warnings: [warning],
      createCliContract: { routeId: "crawl-agent-review", provider: "opencode-cli", model: "deepseek/deepseek-v4.1-flash", cliVersion: "opencode v2.2.5", replaces: "opencode v2.2.6" } },
      base.readiness[1]] });
    const row = rowOf(buildTaskAssignView(input({ slots: [slot] })), "first-review#1");
    expect(`${row.status.reason} ${row.status.detail}`).not.toContain("다시 저장하면");
    expect(row.status.detail).toContain(warning);
    const line = withTaskReadiness(buildTaskRankEditor(llmConnections, llmRankRows, () => "a".repeat(64)), [slot]).lines.find(entry => entry.key === "first-review#1")!;
    expect(line).not.toHaveProperty("pending");
    expect(line.notes).toEqual([{ tone: "warn", text: warning }]);
  });

  it("F5 「쉼」이 멈춤을 가리지 않는다 — 입장 철회만 쌓이면 주의, 24시간 성공이 없으면 주의, 있으면 마지막 성공 시각; 멈춘 잡·웹 요청 작업은 경고하지 않는다", () => {
    const split = (metrics: AdminModelMetrics[], jobs = llmJobs) => rowOf(buildTaskAssignView(input({ observation: observationWith(metrics), jobs,
      slots: [slotOf("split-confirm", 1, { current: current("split-confirm", "deepseek-v4.1-flash-1017") })] })), "split-confirm#1");
    // 2차 갈림 재확인: 입장 철회만 54건, 정산 0
    const withdrawn = split([metric("local-deepseek-confirm", "local-direct", "deepseek-v4.1-flash-1017", "m3-mlx", 0, { withdrawn1h: 54 })]);
    expect(withdrawn.actual.empty).toBe("호출 없음 (최근 1시간)");
    expect(withdrawn.status).toMatchObject({ level: "warn", text: "주의", reason: "1시간 입장 철회 54건 · 정산 0 · 24시간 성공 0건" });
    // 사람 몫 위임 검수: 24시간 안 마지막 성공이 있으면 그 시각(KST)을 「쉼」 옆에
    const human = (lastSuccessAt: string | null, jobs = llmJobs) => rowOf(buildTaskAssignView(input({ jobs,
      observation: observationWith([metric("local-human-deepseek", "local-direct", "deepseek-v4.1-flash-1017", "m3-mlx", 0, { lastSuccessAt })]),
      slots: [slotOf("human-review", 1, { current: current("human-review", "deepseek-v4.1-flash-1017") })] })), "human-review#1");
    expect(human("2026-11-07T01:05:00.000Z").status).toEqual({ level: "idle", text: "쉼", reason: "최근 1시간 호출 없음 · 마지막 성공 11-07 10:05", detail: null });
    expect(human(null).status).toMatchObject({ level: "warn", text: "주의", reason: "24시간 성공 0건" });
    // 잡을 멈췄으면 경고하지 않는다; 잡 상태를 못 읽었으면 멈췄는지 몰라 경고하지 않는다
    expect(human(null, [{ name: "human-deepseek-review", paused: true }]).status).toMatchObject({ level: "idle", text: "의도적 중지" });
    expect(human(null, null as never).status).toMatchObject({ level: "idle", text: "쉼", reason: "최근 1시간 호출 없음" });
    // 실제 적용 설정을 못 읽은 줄(무엇을 쓰는지 모름)에는 멈춤 신호를 더하지 않는다 — 그 까닭이 이미 보인다
    const unknownSetting = rowOf(buildTaskAssignView(input({ observation: observationWith([]),
      slots: [slotOf("screen-review", 1, { current: current("screen-review", "x", { uses: [], error: "model_purpose_not_unique:screen-review" }) })] })), "screen-review#1");
    expect(unknownSetting.status).toEqual({ level: "warn", text: "주의", reason: "실제 적용 설정을 읽지 못함", detail: "model_purpose_not_unique:screen-review" });
    // 웹 요청 작업(잡 없음)은 요청이 없으면 쉰다
    const web = rowOf(buildTaskAssignView(input({ observation: observationWith([]),
      slots: [slotOf("search-query-translate", 1, {}, [rank("search-query-translate", 1, MLX, "gpt-oss-120b")])] })), "search-query-translate#1");
    expect(web.status).toEqual({ level: "idle", text: "쉼", reason: "최근 1시간 호출 없음", detail: null });
    // 감사 항목을 받아서만 일하는 작업은 진행 중인 감사가 없으면 쉬는 것 — 「24시간 성공 0건」이 아니다. 감사가 있거나 모르면 지금 규칙 그대로
    const audit = (facts: TaskAssignInput["facts"]) => rowOf(buildTaskAssignView(input({ facts, observation: observationWith([]),
      slots: [slotOf("audit-review", 1, { current: current("audit-review", "qwen3.8-flash-next") })] })), "audit-review#1");
    expect(audit({ auditRunning: false, connectionsRead: true }).status).toEqual({ level: "idle", text: "쉼", reason: "진행 중인 감사 없음", detail: null });
    expect(audit({ auditRunning: false, connectionsRead: true }).actual.empty).toBe("호출 없음 (진행 중인 감사 없음)");
    expect(audit({ auditRunning: true, connectionsRead: true }).status).toMatchObject({ level: "warn", reason: "24시간 성공 0건" });
    expect(audit({ auditRunning: null, connectionsRead: true }).status).toMatchObject({ level: "warn", reason: "24시간 성공 0건" });
    // 감사 두 번째 의견은 공개분 변경 재검수 줄(0171)의 거절도 묻는다 — 감사 캠페인이 없어도 그 거절이 있거나 모르면 쉬는 것이 아니다
    const opinion = (facts: TaskAssignInput["facts"]) => rowOf(buildTaskAssignView(input({ facts, observation: observationWith([]),
      slots: [slotOf("audit-second-opinion", 1, { current: current("audit-second-opinion", "qwen3.8-flash-next") })] })), "audit-second-opinion#1");
    expect(opinion({ auditRunning: false, connectionsRead: true, recheckRejectsOpen: false }).status).toEqual({ level: "idle", text: "쉼", reason: "진행 중인 감사 없음", detail: null });
    expect(opinion({ auditRunning: false, connectionsRead: true, recheckRejectsOpen: true }).status).toMatchObject({ level: "warn", reason: "24시간 성공 0건" });
    expect(opinion({ auditRunning: false, connectionsRead: true }).status).toMatchObject({ level: "warn", reason: "24시간 성공 0건" });
    // 재검수 줄은 Qwen 직접 감사(audit-review)의 일감이 아니다 — 그 작업은 감사 캠페인만 본다
    expect(audit({ auditRunning: false, connectionsRead: true, recheckRejectsOpen: true }).status).toMatchObject({ level: "idle", reason: "진행 중인 감사 없음" });
  });

  it("F6 장부 밖 작업은 「정상」이라 하지 않는다 — 「장부 밖」(확인 불가 수준), 정상 수에 세지 않는다", () => {
    const slots = [slotOf("product-embedding", 1, { current: current("product-embedding", "bge-m3") }),
      slotOf("assist-review", 1, { current: current("assist-review", "qwen3.8-flash-next") }), slotOf("assist-audit")];
    const view = buildTaskAssignView(input({ slots }));
    expect(rowOf(view, "product-embedding#1").status).toEqual({ level: "unknown", text: "장부 밖", reason: "호출을 세지 않아 이 표로는 확인하지 못함", detail: null });
    expect(rowOf(view, "assist-review#1").status).toMatchObject({ level: "unknown", text: "장부 밖" });
    // 실제 적용 설정을 못 읽은 장부 밖 작업은 그 까닭이 앞선다
    expect(rowOf(view, "assist-audit#1").status).toMatchObject({ level: "unknown", text: "확인 불가", reason: "실제 적용 설정을 읽지 못함" });
    expect(view.rows.map(row => row.status.text)).not.toContain("정상");
    expect(view.counts).toMatchObject({ ok: 0, unknown: 3 });
  });

  it("F7 검색 재정렬의 주소 없음은 상태 칸에 상태의 말로 — 가져오기 계획의 「옮기지 않습니다」를 쓰지 않는다", () => {
    const skip = "환경 API 설정에 RERANK_URL 이(가) 없어 옮기지 않습니다.";
    const row = rowOf(buildTaskAssignView(input({ slots: [slotOf("search-rerank", 1, { current: { task: "search-rerank", slot: 1, uses: [], source: "환경 API 설정", error: null,
      skip, skipStatus: "재정렬 서버 주소(RERANK_URL)가 없어 쓰지 않음", notes: [] } })] })), "search-rerank#1");
    expect(row.status).toEqual({ level: "idle", text: "의도적 중지", reason: "재정렬 서버 주소(RERANK_URL)가 없어 쓰지 않음", detail: null });
    expect(JSON.stringify(row)).not.toContain("옮기지 않습니다");
    // 상태 말이 없는 skip 은 지금처럼
    const audit = rowOf(buildTaskAssignView(input({ slots: [slotOf("audit-review", 1, { current: { task: "audit-review", slot: 1, uses: [], source: "x", error: null,
      skip: "지금 꺼져 있습니다.", notes: [] } })] })), "audit-review#1");
    expect(audit.status.reason).toBe("지금 꺼져 있습니다");
  });

  it("F8 쓰지 않는 작업 — 진행 중인 감사가 없는 감사 캠페인·Grok 연결이 없는 Grok 로그인 유지는 「쓰지 않음」; 모르거나 쓸 일이 생기면 지금처럼 「멈춤 · 순위 없음」", () => {
    const degraded = fresh({ degraded: { code: "no_task_models", detail: "Grok 로그인 유지: 작업 ↔ 모델에 순위가 없습니다" } });
    const view = (facts: TaskAssignInput["facts"], connections = llmConnections) => buildTaskAssignView(input({ facts, connections,
      slots: [slotOf("product-audit"), slotOf("grok-session-check", 1, { runtime: degraded })] }));
    const unused = view({ auditRunning: false, connectionsRead: true });
    expect(rowOf(unused, "product-audit#1").status).toEqual({ level: "idle", text: "쓰지 않음", reason: "진행 중인 감사 없음", detail: null });
    expect(rowOf(unused, "product-audit#1").actual.empty).toBe("호출 없음 (쓰지 않음)");
    expect(rowOf(unused, "grok-session-check#1").status).toEqual({ level: "idle", text: "쓰지 않음", reason: "Grok CLI 연결 없음", detail: null });
    expect(unused.counts).toMatchObject({ bad: 0, idle: 2 });
    const stopped = { level: "bad", text: "멈춤", reason: "순위 없음 — 이 작업은 돌지 않습니다" };
    // 진행 중인 감사가 생겼거나 Grok 연결이 생겼는데 순위가 없으면 멈춤
    const grok = { ...llmConnections[5], id: "77777777-7777-4777-8777-777777777777", label: "Grok CLI", cliTool: "grok" as const, deviceId: "grok-cli", cliModels: ["grok-4.7"] };
    const needed = view({ auditRunning: true, connectionsRead: true }, [...llmConnections, grok]);
    expect(rowOf(needed, "product-audit#1").status).toMatchObject(stopped);
    expect(rowOf(needed, "grok-session-check#1").status).toMatchObject({ level: "bad", text: "멈춤", reason: expect.stringContaining("순위 없음 — 이 작업은 돌지 않습니다") });
    // 감사가 진행 중이면 OpenCode 연결이 없어도 「쓰지 않음」이 아니다
    expect(rowOf(view({ auditRunning: true, connectionsRead: true }, llmConnections.filter(row => row.cliTool !== "opencode")), "product-audit#1").status).toMatchObject(stopped);
    // 못 읽었으면 꾸미지 않는다
    for (const facts of [undefined, { auditRunning: null, connectionsRead: false }]) {
      const unknown = view(facts);
      expect(rowOf(unknown, "product-audit#1").status, JSON.stringify(facts)).toMatchObject(stopped);
      expect(rowOf(unknown, "grok-session-check#1").status.level, JSON.stringify(facts)).toBe("bad");
    }
  });
});

describe("작업 배정 서랍의 자료", () => {
  it("모든 AI 작업의 줄을 만든다 — 흐름 칸 밖(검색어 번역·감사·Grok)은 station off_belt", () => {
    const editor = buildTaskRankEditor(llmConnections, llmRankRows, () => "a".repeat(64));
    expect(editor.lines.find(line => line.task === "search-query-translate")).toMatchObject({ station: "off_belt", live: true, lock: null });
    expect(editor.lines.find(line => line.task === "first-review")).toMatchObject({ station: "first" });
    expect(editor.lines.filter(line => line.task === "second-review").map(line => line.key)).toEqual(["second-review#1", "second-review#2", "second-review#3"]);
    expect(editor.lines.find(line => line.task === "product-intro-check")?.lock).toContain("Claude CLI 전용");
  });

  it("준비 상태를 줄에 붙이고(막힘·알림·다시 저장할 것), 다시 저장은 고른 줄·빠진 것이 있는 줄만", () => {
    const pendingSlot = slotOf("crawl-tagline", 1, { readiness: [{ ...slotOf("crawl-tagline").readiness[0], warnings: ["알림 하나"],
      createDevice: { deviceId: "m3-mlx", limitSlots: 1 } } as never] });
    const editor = withTaskReadiness(buildTaskRankEditor(llmConnections, llmRankRows, () => "a".repeat(64)), [pendingSlot, slotOf("first-review")]);
    const line = editor.lines.find(entry => entry.key === "crawl-tagline#1")!;
    expect(line.pending).toEqual(["1순위 gpt-oss-120b: 장비 행 m3-mlx이(가) 없습니다 — 저장하면 1칸으로 만듭니다."]);
    expect(line.notes).toEqual([{ tone: "warn", text: "알림 하나" }]);
    expect(editor.lines.find(entry => entry.key === "first-review#1")).not.toHaveProperty("pending");
    expect(rankResaves(editor, [line], {}, new Set())).toEqual([]);
    const [resave] = rankResaves(editor, [line], {}, new Set([line.key]));
    expect(resave).toMatchObject({ resave: true, before: line.saved, after: line.saved });
    // 이미 바꾼 줄은 다시 저장이 아니라 바뀐 것으로 센다
    expect(rankResaves(editor, [line], { [line.key]: [{ provider: SUPA, model: "supa" }] }, new Set([line.key]))).toEqual([]);
  });

  it("장비 한도 미리보기: 한도·점유, 장비 행이 없으면 만들 칸 수, 같은 장비를 나눠 쓰는 다른 작업", () => {
    const editor = buildTaskRankEditor(llmConnections, llmRankRows, () => "a".repeat(64));
    const devices = taskAssignDeviceLimits(llmObservation())!;
    expect(devices.find(device => device.deviceId === "gpu3090-qwen")).toEqual({ deviceId: "gpu3090-qwen", limit: 5, held: 2, source: "table" });
    const line = editor.lines.find(entry => entry.key === "crawl-tagline#1")!;
    const impact = rankDeviceImpact(editor, [{ line, before: line.saved, after: [{ provider: GPU, model: "qwen3.8-flash-next" }], beforeText: "", afterText: "" }], devices);
    expect(impact).toEqual([{ deviceId: "gpu3090-qwen", connections: ["gpu3090-qwen"], limit: 5, held: 2, create: null, sharing: ["1차 AI 검수"] }]);
    const claude = rankDeviceImpact(editor, [{ line, before: line.saved, after: [{ provider: CLAUDE, model: "sonnet" }], beforeText: "", afterText: "" }],
      devices.filter(device => device.deviceId !== "anthropic-cli"));
    expect(claude[0]).toMatchObject({ deviceId: "anthropic-cli", create: 4 });
    expect(taskAssignDeviceLimits(unavailableAdminModels())).toBeNull();
    expect(llmMetrics.length).toBeGreaterThan(0);
  });
});
