import { aiTask, aiTaskSlotLabel } from "@/lib/llm/ai-tasks";
import { aiTaskRankOptions, type AiConnectionView, type AiTaskRankRow } from "./admin-ai-tasks";
import type { AiTaskExecutionAdminView } from "./admin-ai-task-execution";
import type { AiTaskSlotView } from "./admin-ai-tasks-repository";
import { buildTaskRankEditor } from "./flow-rank-editor";
import type { TaskAssignChoice, TaskAssignRow, TaskAssignView } from "./llm-task-assign-view";
import { buildModelConsole, type ModelDeviceState } from "./model-console";
import type { ModelUnifiedRead } from "./model-unified-read";
import { unifiedModelTaskUses } from "./model-unified-view";
import preview from "./model-unified-preview.json";

export const MODEL_UNIFIED_FIXTURE_AT = "2026-11-12T12:42:00.000Z";
const revision = "a".repeat(64);
const cid = (name: string) => `fixture-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
const LABELS: Record<string, TaskAssignRow["group"]> = { review: "review", text: "text", search: "search", assist: "audit" };

/**
 * 승인 HTML의 model-data/task-data와 같은 9모델·28작업. 주소는 .example, 키와 운영 접속 정보는 없다.
 * DB·서버 조회·액션·환경변수를 import하지 않는 순수 빌더라 스크린샷/상호작용 하네스에서도 실제 구성 요소에 바로 넘길 수 있다.
 * 앱 경로는 currentAdmin + ADMIN_WORKSPACE_PREVIEW_READ_ONLY=1을 확인한 뒤에만 사용한다.
 */
export function buildModelUnifiedFixture(): ModelUnifiedRead {
  const now = MODEL_UNIFIED_FIXTURE_AT;
  const connections: AiConnectionView[] = preview.model.map(row => {
    const cliTool = row.name === "Claude CLI" ? "claude" as const : row.name === "M3 OpenCode" ? "opencode" as const : null;
    return { id: cid(row.name), label: row.name, displayName: row.name, machine: row.machine, kind: cliTool ? "cli" : "api",
      baseUrl: cliTool === "claude" ? null : `https://${cid(row.name)}.example/v1`, host: `${cid(row.name)}.example`, hasKey: true,
      cliTool, cliModels: cliTool ? [row.name] : [], models: cliTool ? null : [{ id: row.name, maxModelLen: 131072 }],
      modelsReadAt: now, modelsError: null, deviceId: row.machine, capacitySlots: row.limit, contextTokens: 131072,
      reasoningTokenReserve: 20000, manualModels: [], enabled: true, version: 1, note: null, updatedBy: "JR", updatedAt: now, cliVersion: cliTool ? "preview" : null,
      keySetAt: "2026-11-11T00:00:00.000Z", keyValidDays: 30 };
  });
  const connectionOf = (name: string) => connections.find(row => row.label === name);
  const ranks: AiTaskRankRow[] = preview.task.flatMap(task => task.ranks.flatMap((name, index) => {
    const connection = connectionOf(name);
    return connection ? [{ task: task.id, slot: task.slot, rank: index + 1, connectionId: connection.id, model: name, enabled: true, options: {} }] : [];
  }));
  const executions: AiTaskExecutionAdminView[] = preview.task.filter(task => task.mode !== "external").map(task => ({
    task: task.id, slot: task.slot, mode: task.mode === "workload_pool" ? "workload_pool" : "fallback", revision: 1, updatedAt: now, reserveRanks: task.reserve,
    members: task.members.flatMap((member, index) => {
      const connection = connectionOf(member.model);
      return connection ? [{ memberId: `preview-${index + 1}`, position: index + 1, connectionId: connection.id, model: member.model,
        options: {}, canonicalModel: member.model, deviceId: connection.deviceId, engineKey: member.model, maxSlots: member.slots }] : [];
    }),
  }));
  const slots: AiTaskSlotView[] = preview.task.map(row => {
    const task = aiTask(row.id)!;
    const own = ranks.filter(rank => rank.task === task.id && rank.slot === row.slot);
    return { task, slot: row.slot, label: row.label || aiTaskSlotLabel(task, row.slot), revision, rows: own, options: aiTaskRankOptions(task, connections, own),
      current: null, currentLabels: [], sameAsCurrent: null, readiness: [], live: row.mode !== "external", runtime: null, savedAt: null };
  });
  const rows: TaskAssignRow[] = preview.task.map(row => {
    const choices: TaskAssignChoice[] = (row.mode === "workload_pool" ? row.members.map(member => member.model) : row.ranks).flatMap((name, index) => {
      if (!name) return [];
      const connection = connectionOf(name);
      return [{ position: index + 1, connectionId: connection?.id ?? null, connection: name, model: name, effort: null, off: null }];
    });
    const mode = row.mode === "external" ? "effective" : row.mode === "workload_pool" ? "workload_pool" : "fallback";
    const level = row.tone === "warn" ? "warn" : row.tone === "idle" ? "idle" : "ok";
    return { key: row.key, anchor: `execution-${row.id}-${row.slot}`, task: row.id, slot: row.slot, slots: aiTask(row.id)?.slots ?? 1, label: row.label,
      group: LABELS[row.group] ?? "text", groupLabel: ({ review: "검수", text: "소개·번역", search: "검색·분류", assist: "감사·보강" })[row.group] ?? row.group,
      mode, modeText: mode === "fallback" ? "대체 실행" : mode === "workload_pool" ? "작업 분산" : "실제 적용 설정", choices, merged: mode !== "fallback",
      source: mode === "effective" ? "실제 적용 설정" : null, archived: [],
      actual: { readable: row.id !== "screen-review", tracked: !["product-embedding", "search-embedding", "search-rerank"].includes(row.id),
        settled: row.actualCount, failed: row.id === "product-tagline-ko" ? 2 : 0,
        calls: row.actualCount === null || !row.actualModel ? [] : [{ key: row.actualModel, model: row.actualModel,
          device: connectionOf(row.actualModel)?.deviceId ?? "", connectionId: connectionOf(row.actualModel)?.id ?? null,
          settled: row.actualCount, failed: row.id === "product-tagline-ko" ? 2 : 0, position: 1 }],
        empty: row.actualCount === null ? row.actualNote : null, warnings: [], shared: row.id === "second-review", compared: true, mixed: false, note: row.actualNote },
      status: { level, text: row.status, reason: row.note, detail: null }, paused: row.status === "의도적 중지", records: null,
      manage: row.id.startsWith("assist-") ? { href: "#assist-controls", label: "보강 켜기·끄기" } : null };
  });
  const assignments: TaskAssignView = { readable: true, observedAt: now, rows, errors: [],
    counts: { ok: rows.filter(row => row.status.level === "ok").length, warn: rows.filter(row => row.status.level === "warn").length,
      idle: rows.filter(row => row.status.level === "idle").length, bad: 0, unknown: 0 } };
  const devices: ModelDeviceState[] = [...new Set(preview.model.map(row => row.machine))].map(machine => ({ deviceId: machine, source: "table", version: 1,
    limitSlots: preview.model.filter(row => row.machine === machine).reduce((total, row) => total + row.limit, 0),
    active: preview.model.filter(row => row.machine === machine).reduce((total, row) => total + row.active, 0),
    models: preview.model.filter(row => row.machine === machine).map(row => ({ model: row.name, active: row.active, maxSlots: row.limit, engineMax: row.limit })) }));
  const base = buildModelConsole({ now, connections, devices, ranks, pools: executions.flatMap(execution => execution.members.map(member => ({
    task: execution.task, slot: execution.slot, connectionId: member.connectionId, model: member.model }))), ledger: [], pausedJobs: [] });
  const taskUses = unifiedModelTaskUses(assignments);
  const modelRows = base.rows.map(row => {
    const source = preview.model.find(model => cid(model.name) === row.id)!;
    const responseSeconds = Number.parseFloat(source.response);
    return { ...row, active: source.active, utilization: source.usage / 100, utilizationText: source.usage < 1 ? "1% 미만" : `${source.usage}%`,
      bar: Math.max(1, source.usage), calls: source.calls, settled: source.calls, avgSeconds: Number.isFinite(responseSeconds) ? responseSeconds : null,
      indeterminate: source.name === "supa-direct" ? 19 : 0, rejected: source.name === "LG EXAONE" ? 57 : 0,
      stageCount: taskUses[row.id]?.length ?? 0, status: { tone: source.tone === "warn" ? "warn" as const : source.tone === "idle" ? "off" as const : "ok" as const, text: source.status } };
  }).sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0));
  return { now, models: { view: { ...base, rows: modelRows }, devices, secretBox: false, admission: { mode: "open", since: now } },
    assignments, editor: buildTaskRankEditor(connections, ranks, () => revision, executions),
    devices: devices.map(device => ({ deviceId: device.deviceId, limit: device.limitSlots, held: device.active, source: device.source })),
    poolHelp: { devices: devices.map(device => ({ deviceId: device.deviceId, limitSlots: device.limitSlots, enabled: true,
      modelLimits: device.models.map(model => ({ model: model.model, maxSlots: model.maxSlots! })) })), bases: {} },
    tasks: { connections, rows: ranks, slots, audit: [], errors: {}, secretBox: false, policyMode: "enforce", keyConflicts: [] },
    assist: { error: null, controls: ([
      { task: "uptime", label: "연결 확인", mode: "confirm", confirmationRequired: true },
      { task: "repo_move", label: "스팸 재확인", mode: "shadow", confirmationRequired: false },
      { task: "intro_recheck", label: "소개 보강", mode: "confirm", confirmationRequired: false },
      { task: "decision_audit", label: "보강 독립 감사", mode: "shadow", confirmationRequired: false },
    ] as const).map(row => ({ ...row, dispatchEnabled: false, applyEnabled: false, revision: 1, updatedAt: now, queue: {}, aiTask: "assist-review", aiTaskLabel: "LLM 보강" })) },
    concurrency: { revision: 1, rowError: null, fields: [
      { path: "jobs.second-review.consumerConcurrency", label: "2차 심사 동시 업무", kind: "int", value: 2, defaultValue: 2, input: "2", defaultInput: "2", overridden: true },
      { path: "jobs.crawl-publish.classifierConcurrency", label: "발행 분류 묶음", kind: "int", value: 1, defaultValue: 1, input: "1", defaultInput: "1", overridden: true },
    ] }, importPreview: { hash: revision, error: null, servers: [], keyWarnings: [], connectionLabels: {},
      plan: { connections: [], warnings: [], slots: preview.task.map(task => ({ task: task.id, slot: task.slot,
        action: task.id === "second-review" && task.slot > 1 ? "empty" : "unchanged", ranks: [] })) } },
    retired: [{ task: "legacy-product-tagline-ko", slot: 1, count: 1, revision, label: "한국어 소개 번역 · 직접 경로" }],
    changes: { rows: [], more: false, error: null }, taskUses, ranksReadable: true, taskUsesReadable: true, retiredReadable: true, retiredError: null,
    lockReason: "읽기 전용 미리보기 — 여기서는 저장할 수 없습니다." };
}

export const MODEL_UNIFIED_FIXTURE_RECENT = [
  { id: 3, at: "2026-11-12T12:35:00.000Z", title: "gpu3090-qwen · 쓰는 작업 변경", detail: "검색 키워드 짓기 2순위에 붙임 · JR", ok: true },
  { id: 2, at: "2026-11-12T12:12:00.000Z", title: "카테고리 분류 · 동시에", detail: "m3-deepseek · gpu3090-qwen, 모델 2개 · JR", ok: true },
  { id: 1, at: "2026-11-12T11:48:00.000Z", title: "M1max · 연결 추가", detail: "쓸 작업을 아직 고르지 않음 · JR", ok: true },
] as const;
