import { describe, expect, it } from "vitest";
import { aiTask, isAiLiveTask } from "@/lib/llm/ai-tasks";
import type { AiCurrentSlot, AiTaskRankRow } from "@/lib/operations/admin-ai-tasks";
import type { AiTaskRuntimeView } from "@/lib/operations/admin-ai-tasks-repository";
import { buildAdminModelsObservation, unavailableAdminModels, type AdminModelMetrics } from "@/lib/operations/admin-models-observation";
import { buildTaskRankEditor, rankDeviceImpact, rankResaves } from "@/lib/operations/flow-rank-editor";
import { buildTaskAssignView, taskAssignDeviceLimits, withTaskReadiness, type TaskAssignInput, type TaskAssignSlotInput } from "@/lib/operations/llm-task-assign-view";
import { CLAUDE, GPU, LLM_NOW, llmConnections, llmDevices, llmJobs, llmMetrics, llmObservation, llmPolicy, llmRankRows, llmRequests, llmRuntime, MLX, OPENCODE, SUPA } from "./fixtures/llm-ops";
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
