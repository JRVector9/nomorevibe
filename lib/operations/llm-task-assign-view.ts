import { AI_CLI_TOOL_LABELS, AI_TASK_GROUP_LABELS, type AiTaskDef, type AiTaskGroup } from "@/lib/llm/ai-tasks";
import { aiTaskWorkloadPoolApiOnly } from "@/lib/llm/ai-task-execution-config";
import { aiConnectionHost, aiConnectionLabel, aiRankPendingText, aiSameUnderlyingModel, aiTaskRanksUnread, type AiConnectionView, type AiCurrentUse } from "./admin-ai-tasks";
import type { AiTaskExecutionAdminView } from "./admin-ai-task-execution";
import type { AiTaskSlotView } from "./admin-ai-tasks-repository";
import type { AdminModelsObservation } from "./admin-models-observation";
import type { FlowRankEditor, RankDeviceLimit } from "./flow-rank-editor";
import { llmReasonShort, observationReadable, RUNTIME_FRESH_MS, taskOfRoute, UNREADABLE, type JobPause, type LlmOpsLevel } from "./llm-ops-view";

/**
 * 작업 배정(/admin/models/tasks, 2026-11-07 승인 시안 PR 4) — 「어느 작업이 어느 모델로 가나? 설정대로 가고 있나?」 표의 화면 모형. DB 를 읽지 않는 순수 함수다.
 * 작업 × 칸마다 설정(1·2·3순위 · 작업 분산 구성원 · 실제 적용 설정)과 실제(장부의 최근 1시간 정산을 모델별로)를 한 줄에 놓고, 다르면 경고한다.
 * 장부 route → 작업은 LLM 운영과 같은 taskOfRoute 다. 장부는 2차 투표자를 가르지 않으므로 여러 칸 작업의 「실제」는 작업 전체 기준이다.
 * 읽지 못한 값은 0 으로 꾸미지 않는다(「확인 불가」).
 */

export type TaskAssignSlotInput = Pick<AiTaskSlotView, "task" | "slot" | "label" | "rows" | "options" | "current" | "sameAsCurrent" | "readiness" | "live" | "runtime">
  & Partial<Pick<AiTaskSlotView, "revision" | "savedAt">>;
export type TaskAssignInput = Readonly<{
  now: string;
  observation: AdminModelsObservation;
  connections: readonly AiConnectionView[];
  slots: readonly TaskAssignSlotInput[];
  /** 실행 방식(대체 실행·작업 분산). null = 읽지 못함 */
  executions: readonly Pick<AiTaskExecutionAdminView, "task" | "slot" | "mode" | "members">[] | null;
  /** 잡 멈춤. null = 읽지 못함 */
  jobs: readonly JobPause[] | null;
  /**
   * 순위 없는 작업을 「쓰지 않음」으로 가르는 사실(2026-11-09) — 진행 중인 감사 캠페인이 있나(null = 읽지 못함), 연결 목록을 읽었나.
   * 없거나 읽지 못했으면 모른다로 보고 지금 표시(「멈춤 · 순위 없음」)를 그대로 둔다.
   */
  facts?: Readonly<{ auditRunning: boolean | null; connectionsRead: boolean;
    /** 공개분 변경 재검수 줄에 사람을 기다리는 거절이 있나(0171, null·없음 = 모름) — 감사 두 번째 의견은 감사 캠페인이 없어도 이것을 묻는다 */
    recheckRejectsOpen?: boolean | null }>;
}>;

/** fallback = 대체 실행(작업 순위), workload_pool = 작업 분산, classifier = 기존 CLI 분류(발행 분류의 대체 실행), effective = 실행 쪽이 순위를 읽지 않는 작업(실제 적용 설정) */
export type TaskAssignMode = "fallback" | "workload_pool" | "classifier" | "effective";
export type TaskAssignChoice = Readonly<{
  /** 순위(대체 실행) 또는 모델 번호(분산·실제 적용) */
  position: number; connectionId: string | null; connection: string; model: string; effort: string | null;
  /** 쓰이지 않는 까닭(순위 꺼짐 · 연결 꺼짐 · 연결 없음) */
  off: string | null;
}>;
export type TaskAssignCall = Readonly<{
  key: string; model: string; device: string; connectionId: string | null; settled: number; failed: number;
  /** 설정의 몇 번째(순위·모델 번호)가 맡았나. null = 설정에 없는 모델 */
  position: number | null;
}>;
export type TaskAssignActual = Readonly<{
  /** 장부를 읽었나 · 이 작업이 장부를 거치나(용량 route 가 있나) */
  readable: boolean; tracked: boolean;
  settled: number | null; failed: number | null; calls: TaskAssignCall[];
  /** 호출이 없을 때의 말(까닭을 알면 괄호 안에) */
  empty: string | null;
  /** 설정과 다름 — 비면 경고 없음 */
  warnings: string[];
  /** 여러 칸(2차 투표자) 작업 — 장부가 투표자를 가르지 않아 작업 전체 기준 */
  shared: boolean;
  /** 설정과 견줄 수 있었나 — 실행 방식·실제 적용 설정을 못 읽었으면 false(「설정 밖」이라 하지 않는다) */
  compared: boolean;
  /** 최근 1시간 안에 순위를 저장해 장부에 그 전 순위의 호출이 섞여 있다 — 순위와 견주지 않는다(경고 아님) */
  mixed: boolean;
  /** 경고가 아닌 메모(순위를 막 바꿈 등) */
  note: string | null;
}>;
export type TaskAssignStatus = Readonly<{ level: LlmOpsLevel; text: string; reason: string | null; detail: string | null }>;
export type TaskAssignRow = Readonly<{
  key: string; anchor: string; task: string; slot: number; slots: number; label: string; group: AiTaskGroup; groupLabel: string;
  mode: TaskAssignMode | null; modeText: string;
  /** 대체 실행은 1·2·3순위 칸 셋, 나머지는 한 칸에 모델 목록 */
  choices: TaskAssignChoice[]; merged: boolean; source: string | null;
  /** 작업 분산 중일 때 보관된 대체 순위(지금은 쓰지 않음 — 대체 실행으로 돌리면 쓴다) */
  archived: TaskAssignChoice[];
  actual: TaskAssignActual; status: TaskAssignStatus; paused: boolean;
  /** 실행 쪽이 순위를 읽지 않는 작업에 남은 옛 순위 행(실행 안 함) — 「기록 지우기」가 그 판(revision)으로 지운다 */
  records: Readonly<{ count: number; revision: string }> | null;
}>;
export type TaskAssignView = Readonly<{
  readable: boolean; observedAt: string | null; rows: TaskAssignRow[];
  counts: Readonly<Record<LlmOpsLevel, number>>; errors: string[];
}>;

const fmt = (value: number) => value.toLocaleString("ko-KR");
const HOUR_MS = 60 * 60_000;
/** 감사 항목(감사 캠페인)이 있어야 일하는 작업 — 발행분 감사 · 직접 모델(audit-qwen)·감사 두 번째 의견(audit-second-opinion) */
const AUDIT_FED_TASKS: ReadonlySet<string> = new Set(["audit-review", "audit-second-opinion"]);
/** 실행 쪽이 「이 틱만 칸이 없어」 다음 순위로 넘기는 까닭 — lib/llm/ai-task-resolver.ts 의 SATURATION 과 같은 목록(그 모듈은 서버 전용이라 여기 둔다) */
const SATURATION: ReadonlySet<string> = new Set(["capacity", "queue_full", "route_quota", "model_quota"]);
const KST = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const kstParts = (at: number) => Object.fromEntries(KST.formatToParts(new Date(at)).map(part => [part.type, part.value]));
/** KST 「HH:MM」 */
const kstClock = (at: number) => { const part = kstParts(at); return `${part.hour}:${part.minute}`; };
/** KST 「MM-DD HH:MM」 */
const kstStamp = (at: number) => { const part = kstParts(at); return `${part.month}-${part.day} ${part.hour}:${part.minute}`; };
const LEVEL_RANK: Readonly<Record<LlmOpsLevel, number>> = { ok: 0, idle: 1, unknown: 2, warn: 3, bad: 4 };
const STATUS_WORD: Readonly<Record<LlmOpsLevel, string>> = { ok: "정상", warn: "주의", bad: "멈춤", idle: "의도적 중지", unknown: UNREADABLE };
const trimDot = (text: string) => text.trim().replace(/[.。]$/, "");
const effortOf = (options: Readonly<Record<string, unknown>> | undefined) => typeof options?.reasoningEffort === "string" && options.reasoningEffort ? options.reasoningEffort : null;
/** 장부 모델 이름에서 연결로 가른 꼬리(@xxxxxxxx)를 뗀 표시 이름 */
export const ledgerModelText = (model: string) => model.replace(/@[0-9a-f]{8}$/, "");

/** 이 작업의 잡이 모두 사람 손으로 멈췄으면 그 잡 이름들(웹 요청 작업·잡 상태를 못 읽음 = null) */
function pausedJobs(task: AiTaskDef, jobs: readonly JobPause[] | null): string[] | null {
  if (!jobs || !task.jobs.length) return null;
  const paused = new Set(jobs.filter(job => job.paused).map(job => job.name));
  return task.jobs.every(job => paused.has(job)) ? [...task.jobs] : null;
}

type Agg = { key: string; model: string; device: string; settled: number; failed: number; succeeded: number; indeterminate: number; withdrawn: number;
  /** 24시간 안 마지막 성공(ms) — 장부 관측의 lastSuccessAt 은 24시간 창 안의 값이다(그보다 오래면 null) */
  lastSuccess: number | null };
type Expect = { position: number; connectionId: string | null; model: string; identity: string | null; deviceId: string | null; first: boolean };

const matches = (agg: Agg, entry: Expect) => agg.model === entry.identity || agg.model === entry.model || aiSameUnderlyingModel(agg.model, entry.model);
/**
 * 실행 쪽 마지막 틱이 순위대로 대체했나 — 처리한 가장 뒤 순위보다 앞의 켜진 순위가 모두 건너뛰어졌고 그 까닭이 포화(칸·대기열·몫·상한)뿐이면
 * 그 순위들·까닭·처리한 순위. 다른 까닭이 하나라도 섞였거나 앞 순위가 건너뛴 기록이 없으면 null(설명되지 않는다 — 경고는 그대로).
 */
function saturationFallback(runtime: NonNullable<TaskAssignSlotInput["runtime"]>, ranks: readonly number[]): { skipped: number[]; codes: string[]; served: number } | null {
  const served = runtime.served.filter(entry => entry.count > 0).map(entry => entry.rank);
  if (!served.length) return null;
  const last = Math.max(...served);
  const skipped = ranks.filter(rank => rank < last).sort((a, b) => a - b);
  const before = runtime.unusable.filter(entry => entry.rank < last && entry.count > 0);
  if (!skipped.length || !before.every(entry => SATURATION.has(entry.code)) || !skipped.every(rank => before.some(entry => entry.rank === rank))) return null;
  return { skipped, codes: [...new Set(before.map(entry => entry.code))], served: last };
}

/** 장부 한 줄을 맡은 설정 — 같은 모델이 여러 칸에 있으면 장부 이름(identity) → 같은 장비 → 앞 칸 차례로 고른다 */
function owner(agg: Agg, entries: readonly Expect[]): Expect | null {
  const hits = entries.filter(entry => matches(agg, entry));
  return hits.find(entry => entry.identity === agg.model) ?? hits.find(entry => entry.deviceId === agg.device) ?? hits[0] ?? null;
}

function currentConnectionLabel(use: AiCurrentUse, connections: readonly AiConnectionView[]): string {
  if (use.kind === "cli") {
    const connection = connections.find(row => row.kind === "cli" && row.cliTool === use.cliTool);
    return connection ? aiConnectionLabel(connection) : use.provider;
  }
  const connection = use.baseUrl ? connections.find(row => row.baseUrl === use.baseUrl) : undefined;
  return connection ? aiConnectionLabel(connection) : aiConnectionHost(use.baseUrl) ?? "서버 모름";
}

export function buildTaskAssignView(input: TaskAssignInput): TaskAssignView {
  const { observation, connections } = input;
  const readable = observationReadable(observation);
  const now = Date.parse(input.now);
  const connectionOf = (id: string) => connections.find(row => row.id === id) ?? null;
  const errors: string[] = [];
  if (!readable) errors.push("LLM 장부(운영 DB)를 읽지 못했습니다 — 「지금 실제」는 확인 불가로 보입니다.");
  if (!input.executions) errors.push("실행 방식을 읽지 못했습니다 — 확인할 때까지 순위를 저장할 수 없습니다.");
  if (!input.jobs) errors.push("잡 상태를 읽지 못했습니다 — 일시중지 여부가 빠질 수 있습니다.");

  // 장부: 작업마다 (모델, 장비) 한 줄로 모은다
  const ledger = new Map<string, Agg[]>();
  if (readable) for (const row of observation.rows) {
    const task = taskOfRoute(row.routeId);
    if (!task) continue;
    const list = ledger.get(task.id) ?? [];
    const key = `${row.model}|${row.groupId}`;
    let agg = list.find(entry => entry.key === key);
    if (!agg) { agg = { key, model: row.model, device: row.groupId, settled: 0, failed: 0, succeeded: 0, indeterminate: 0, withdrawn: 0, lastSuccess: null }; list.push(agg); }
    agg.settled += row.succeeded1h + row.failed1h + row.unclassified1h;
    agg.failed += row.failed1h; agg.succeeded += row.succeeded1h; agg.indeterminate += row.indeterminate; agg.withdrawn += row.withdrawn1h;
    const success = row.lastSuccessAt ? Date.parse(row.lastSuccessAt) : NaN;
    if (Number.isFinite(success) && (agg.lastSuccess === null || success > agg.lastSuccess)) agg.lastSuccess = success;
    ledger.set(task.id, list);
  }

  const executionOf = (task: string, slot: number) => input.executions?.find(row => row.task === task && row.slot === slot) ?? null;
  const modeOf = (slot: TaskAssignSlotInput): TaskAssignMode | null => {
    if (!input.executions) return slot.live ? "fallback" : null;
    if (executionOf(slot.task.id, slot.slot)?.mode === "workload_pool") return "workload_pool";
    if (aiTaskWorkloadPoolApiOnly(slot.task.id)) return "classifier";
    return slot.live ? "fallback" : "effective";
  };
  const expected = (slot: TaskAssignSlotInput, mode: TaskAssignMode | null): Expect[] => {
    if (mode === "workload_pool") return (executionOf(slot.task.id, slot.slot)?.members ?? []).map(member => ({ position: member.position, connectionId: member.connectionId,
      model: member.model, identity: null, deviceId: connectionOf(member.connectionId)?.deviceId ?? null, first: false }));
    if (mode === "fallback") {
      const enabled = slot.rows.filter(row => row.enabled).sort((a, b) => a.rank - b.rank);
      return enabled.map((row, index) => ({ position: row.rank, connectionId: row.connectionId, model: row.model,
        identity: slot.readiness.find(ready => ready.rank === row.rank)?.identity ?? null, deviceId: connectionOf(row.connectionId)?.deviceId ?? null, first: index === 0 }));
    }
    return (slot.current?.uses ?? []).map((use, index) => ({ position: index + 1, connectionId: null, model: use.model, identity: null, deviceId: use.deviceId, first: index === 0 }));
  };

  // 여러 칸 작업은 모든 칸의 설정을 합쳐 「설정 밖」을 가른다
  const taskEntries = new Map<string, Expect[]>();
  const taskFirsts = new Map<string, Expect[]>();
  // 작업마다 순위를 마지막으로 저장한 때 — 장부는 칸(투표자)을 가르지 않으므로 여러 칸이면 가장 늦은 칸
  const taskSaved = new Map<string, number>();
  for (const slot of input.slots) {
    const entries = expected(slot, modeOf(slot));
    taskEntries.set(slot.task.id, [...taskEntries.get(slot.task.id) ?? [], ...entries]);
    taskFirsts.set(slot.task.id, [...taskFirsts.get(slot.task.id) ?? [], ...entries.filter(entry => entry.first)]);
    const saved = slot.savedAt ? Date.parse(slot.savedAt) : NaN;
    if (Number.isFinite(saved)) taskSaved.set(slot.task.id, Math.max(taskSaved.get(slot.task.id) ?? saved, saved));
  }
  // 장부 1시간 창의 끝 — 장부를 읽은 DB 시각(없으면 화면 시각)
  const observedMs = readable && observation.observedAt ? Date.parse(observation.observedAt) : now;
  const cliConnected = (task: AiTaskDef) => connections.some(row => row.kind === "cli" && (task.cliTools as readonly string[]).includes(row.cliTool ?? ""));

  const rows: TaskAssignRow[] = input.slots.map(slot => {
    const task = slot.task;
    const mode = modeOf(slot);
    const execution = executionOf(task.id, slot.slot);
    const entries = expected(slot, mode);
    const paused = pausedJobs(task, input.jobs);
    const aggs = ledger.get(task.id) ?? [];
    const tracked = !!task.routeId;
    const total = aggs.reduce((sum, agg) => sum + agg.settled, 0);
    const failed = aggs.reduce((sum, agg) => sum + agg.failed, 0);
    const succeeded = aggs.reduce((sum, agg) => sum + agg.succeeded, 0);
    const indeterminate = aggs.reduce((sum, agg) => sum + agg.indeterminate, 0);
    const withdrawn = aggs.reduce((sum, agg) => sum + agg.withdrawn, 0);
    const lastSuccess = aggs.reduce<number | null>((latest, agg) => agg.lastSuccess !== null && (latest === null || agg.lastSuccess > latest) ? agg.lastSuccess : latest, null);
    const multi = task.slots > 1;
    // 장부·실행 쪽 순위 사정은 작업 전체 기준이다 — 여러 칸 작업이면 첫 칸에만 싣는다
    const taskLevel = !multi || slot.slot === 1;
    const runtime = slot.runtime && now - Date.parse(slot.runtime.at) <= RUNTIME_FRESH_MS ? slot.runtime : null;
    // 순위가 없는 2차 투표자 칸 — 작업 전체 신호를 싣지 않고 「비어 있음」
    const emptyExtra = mode === "fallback" && multi && slot.slot > 1 && !entries.length;
    // 1시간 안에 순위를 저장했으면 장부에 그 전 순위의 호출이 섞여 있다 — 순위와 견주지 않는다
    const savedMs = taskSaved.get(task.id);
    const mixed = mode === "fallback" && savedMs !== undefined && savedMs > observedMs - HOUR_MS;
    // 실행 쪽 마지막 틱이 앞 순위의 포화로 뒤 순위를 쓴 것(설계대로의 대체) — 「설정과 다름」이 아니다. 여러 칸 작업은 순위 사정이 투표자를 가르지 않아 보지 않는다
    const fallback = mode === "fallback" && !multi && runtime ? saturationFallback(runtime, entries.map(entry => entry.position)) : null;
    // 쓰지 않는 작업(2026-11-09) — 순위가 없고 사실이 그 까닭을 말할 때만. 감사 캠페인은 진행 중인 감사가 없음, CLI 전용 작업은 받는 CLI 도구의 연결이 없음.
    // 모르거나(못 읽음) 쓸 일이 생겼으면(감사 진행 중·연결 있음) 지금처럼 「멈춤 · 순위 없음」
    const unused = mode !== "fallback" || slot.slot !== 1 || entries.length ? null
      : task.id === "product-audit" ? input.facts?.auditRunning === false ? "진행 중인 감사 없음" : null
      : !task.api && task.cliTools.length > 0 && input.facts?.connectionsRead === true && !cliConnected(task)
        ? `${task.cliTools.map(tool => AI_CLI_TOOL_LABELS[tool]).join("·")} 연결 없음` : null;

    // 설정 칸
    const ranks: TaskAssignChoice[] = slot.rows.map(row => {
      const connection = connectionOf(row.connectionId);
      return { position: row.rank, connectionId: row.connectionId, connection: connection ? aiConnectionLabel(connection) : "지워진 연결", model: row.model, effort: effortOf(row.options),
        off: !row.enabled ? "순위 꺼짐" : !connection ? "연결 없음" : !connection.enabled ? "연결 꺼짐" : null };
    });
    const choices: TaskAssignChoice[] = mode === "fallback" ? ranks : mode === "workload_pool" ? (execution?.members ?? []).map(member => {
      const connection = connectionOf(member.connectionId);
      return { position: member.position, connectionId: member.connectionId, connection: connection ? aiConnectionLabel(connection) : "지워진 연결", model: member.model,
        effort: effortOf(member.options), off: !connection ? "연결 없음" : !connection.enabled ? "연결 꺼짐" : null };
    }) : (slot.current?.uses ?? []).map((use, index) => ({ position: index + 1, connectionId: null, connection: currentConnectionLabel(use, connections), model: use.model,
      effort: effortOf(use.options), off: null }));
    const source = mode === "effective" || mode === "classifier" ? slot.current?.error ? null : slot.current?.source ?? null : null;

    // 실제 — 설정의 몇 번째가 몇 건을 맡았나
    const counted = new Map<Expect, { settled: number; failed: number; aggs: Agg[] }>();
    const outside: Agg[] = [];
    const all = taskEntries.get(task.id) ?? [];
    for (const agg of aggs) {
      const mine = owner(agg, entries);
      if (mine) { const entry = counted.get(mine) ?? { settled: 0, failed: 0, aggs: [] }; entry.settled += agg.settled; entry.failed += agg.failed; entry.aggs.push(agg); counted.set(mine, entry); }
      else if (!owner(agg, all) && agg.settled > 0) outside.push(agg);
    }
    const calls: TaskAssignCall[] = [];
    if (readable && tracked) {
      for (const entry of entries) {
        const hit = counted.get(entry);
        if (!hit?.settled && !entry.first && mode !== "workload_pool") continue;
        calls.push({ key: `p${entry.position}:${entry.connectionId ?? ""}:${entry.model}`, model: entry.model, device: hit?.aggs[0]?.device ?? entry.deviceId ?? "",
          connectionId: entry.connectionId, settled: hit?.settled ?? 0, failed: hit?.failed ?? 0, position: entry.position });
      }
      if (taskLevel || !multi) for (const agg of outside)
        calls.push({ key: `x:${agg.key}`, model: agg.model, device: agg.device, connectionId: null, settled: agg.settled, failed: agg.failed, position: null });
    }

    // 설정과 다름 — 순위를 막 바꿨거나(mixed) 앞 순위가 포화로만 건너뛰어진 대체(fallback)는 순위와 견준 경고를 내지 않는다. 실패·미확정 신호는 그대로다
    const warnings: string[] = [];
    // 실행 방식이나 실제 적용 설정을 모르면 어느 설정과 견줄지 모른다 — 경고하지 않는다
    const compared = !!input.executions && (mode === "fallback" || mode === "workload_pool" || (!!slot.current && !slot.current.error));
    if (readable && tracked && total > 0 && !paused && compared) {
      const first = entries.find(entry => entry.first);
      const firstGap = mode === "fallback" && !!first && !(counted.get(first)?.settled);
      if (firstGap && !mixed && !fallback) warnings.push(`1순위 ${ledgerModelText(first!.model)} 0건 — 다른 모델이 처리`);
      if (mode === "workload_pool") for (const entry of entries) if (!counted.get(entry)?.settled) warnings.push(`모델 ${entry.position} ${ledgerModelText(entry.model)} 0건 — 다른 모델만 호출`);
      if (mode === "fallback" && taskLevel && !firstGap && !mixed && !fallback) {
        const firsts = taskFirsts.get(task.id) ?? [];
        const onFirst = aggs.filter(agg => firsts.some(entry => matches(agg, entry))).reduce((sum, agg) => sum + agg.settled, 0);
        const share = Math.round((total - onFirst) / total * 100);
        if (firsts.length && (total - onFirst) * 2 >= total) warnings.push(`1순위가 아닌 모델이 ${share}%를 처리`);
      }
      if (taskLevel && !mixed) for (const agg of outside) warnings.push(`${mode === "workload_pool" ? "분산 구성" : mode === "fallback" ? "순위" : "실제 적용 설정"}에 없는 모델 호출: ${ledgerModelText(agg.model)} ${fmt(agg.settled)}건`);
    }
    const ago = savedMs === undefined ? 0 : Math.max(0, Math.round((observedMs - savedMs) / 60_000));
    const note = mixed && readable && tracked && total > 0 && !emptyExtra
      ? `순위를 ${ago < 1 ? "방금" : `${fmt(ago)}분 전에`} 바꿈 — 그 전 호출이 섞여 있어 ${kstClock(savedMs! + HOUR_MS)} 이후 비교` : null;

    // 호출이 없을 때의 까닭(없으면 「최근 1시간」 — 그때만 멈춤 신호를 더 본다)
    const enabledConnections = entries.filter(entry => entry.connectionId).map(entry => connectionOf(entry.connectionId!));
    const skipText = (mode === "effective" || mode === "classifier") && slot.current?.skip ? slot.current.skipStatus ?? trimDot(slot.current.skip) : null;
    // 감사 항목을 받아서만 일하는 작업 — 진행 중인 감사가 없으면 일감이 없어 쉬는 것이지 멈춘 것이 아니다(「24시간 성공 0건」으로 보이지 않게)
    // 감사 두 번째 의견은 공개분 변경 재검수 줄의 거절도 묻는다(0171) — 그 거절이 없다고 읽었을 때만 쉰다
    const auditIdle = AUDIT_FED_TASKS.has(task.id) && input.facts?.auditRunning === false
      && (task.id !== "audit-second-opinion" || input.facts.recheckRejectsOpen === false) ? "진행 중인 감사 없음" : null;
    const idleWhy = paused ? "잡 일시중지" : unused ? "쓰지 않음" : mode === "fallback" && !entries.length ? "순위 없음"
      : runtime?.degraded ? llmReasonShort(runtime.degraded.code) ?? runtime.degraded.code
      : skipText ?? auditIdle ?? (enabledConnections.length && enabledConnections.every(connection => !connection?.enabled) ? "연결 꺼짐"
      : !task.jobs.length ? "최근 웹 요청 없음" : null);
    const empty = emptyExtra ? "쓰지 않는 칸" : !readable ? `${UNREADABLE} — 장부를 읽지 못했습니다` : !tracked ? "장부 밖 작업 — 호출 수를 세지 않습니다" : total > 0 ? null
      : `호출 없음 (${idleWhy ?? "최근 1시간"})`;
    // 잡이 멈추지 않았는데(잡 상태를 읽었다) 1시간 정산이 없고 다른 까닭도 없다 — 입장 철회만 쌓이거나 24시간 성공이 없으면 멈춘 것으로 본다.
    // 무엇을 쓰는지 모르는 줄(실행 방식·실제 적용 설정을 못 읽음)은 그 까닭이 이미 보이므로 더하지 않는다
    const quiet = readable && tracked && compared && !emptyExtra && total === 0 && idleWhy === null && taskLevel && input.jobs !== null;

    // 상태 — 가장 나쁜 신호, 없으면 기본. notes 는 경고가 아닌 설명(순위대로 대체)
    const signals: TaskAssignStatus[] = [];
    const notes: string[] = [];
    const signal = (level: LlmOpsLevel, reason: string, detail: string | null = null) => signals.push({ level, text: STATUS_WORD[level], reason, detail });
    if (mode === null) signal("unknown", "실행 방식을 읽지 못함 — 저장 잠김");
    if (mode === "fallback") {
      const enabled = slot.rows.filter(row => row.enabled);
      if (!enabled.length && slot.slot === 1 && !unused) signal("bad", "순위 없음 — 이 작업은 돌지 않습니다");
      const blocked = slot.readiness.filter(ready => ready.blocking.length > 0 && enabled.some(row => row.rank === ready.rank));
      if (enabled.length && blocked.length === enabled.length) signal("bad", "저장된 순위를 모두 쓸 수 없음", blocked.flatMap(ready => ready.blocking).join(" / "));
      else if (blocked.length) signal("warn", `${blocked.map(ready => `${ready.rank}순위`).join("·")} 쓸 수 없음`, blocked.flatMap(ready => ready.blocking).join(" / "));
      if (slot.options.some(option => option.saved)) signal("warn", "저장한 모델이 서버 목록에 없음");
      const pending = slot.readiness.flatMap(ready => aiRankPendingText(ready));
      if (pending.length) signal("warn", "빠진 계약·경로 — 다시 저장하면 만듦", pending.join(" / "));
      const readinessNotes = slot.readiness.flatMap(ready => ready.warnings);
      if (readinessNotes.length) signal("warn", "알림 있음", readinessNotes.join(" / "));
      if (slot.sameAsCurrent === false) signal("warn", "실행 설정과 다름");
      if (runtime && taskLevel) for (const entry of runtime.unusable) {
        if (fallback && entry.rank < fallback.served) continue;
        signal("warn", `${entry.rank}순위 건너뜀: ${llmReasonShort(entry.code)} ${fmt(entry.count)}회`, entry.text);
      }
      if (fallback) notes.push(`${fallback.skipped.join("·")}순위 ${fallback.codes.map(code => llmReasonShort(code) ?? code).join("·")} → ${fallback.served}순위가 처리(순위대로 대체)`);
    }
    if (mode === "workload_pool") {
      if (!execution?.members.length) signal("bad", "분산 모델 없음");
      else if (execution.members.some(member => !connectionOf(member.connectionId)?.enabled)) signal("bad", "꺼졌거나 없는 연결");
    }
    if ((mode === "fallback" || mode === "workload_pool") && runtime?.degraded && taskLevel && !(unused && runtime.degraded.code === "no_task_models"))
      signal("bad", llmReasonShort(runtime.degraded.code) ?? runtime.degraded.code, runtime.degraded.detail);
    if (mode === "effective" || mode === "classifier") {
      if (!slot.current) signal("unknown", "실제 적용 설정을 읽지 못함");
      else if (slot.current.error) signal("warn", "실제 적용 설정을 읽지 못함", slot.current.error);
    }
    if (readable && tracked && taskLevel) {
      if (failed > 0 && succeeded === 0) signal("bad", `1시간 실패 ${fmt(failed)}건 · 성공 0건`);
      else if (failed > 0) signal("warn", `1시간 실패 ${fmt(failed)}건 / 정산 ${fmt(total)}`);
      if (indeterminate > 0) signal("warn", `결과 미확정 ${fmt(indeterminate)}건`);
    }
    // 이미 멈춤(bad)으로 설명되면 더하지 않는다
    const stalled = quiet && !signals.some(entry => entry.level === "bad");
    if (stalled && withdrawn > 0) signal("warn", `1시간 입장 철회 ${fmt(withdrawn)}건 · 정산 0`);
    if (stalled && lastSuccess === null) signal("warn", "24시간 성공 0건", "장부의 최근 24시간에 성공한 호출이 없습니다(잡은 멈추지 않았습니다)");
    if (warnings.length) signal("warn", `설정과 다름: ${warnings[0]}`, warnings.join(" / "));

    // 장부 밖 작업은 「정상」이라 하지 않는다 — 호출을 세지 않아 이 표로는 확인하지 못한다(같은 수준의 신호에 자리를 내준다)
    const untracked: TaskAssignStatus = { level: "unknown", text: "장부 밖", reason: "호출을 세지 않아 이 표로는 확인하지 못함", detail: null };
    const base: TaskAssignStatus = paused ? { level: "idle", text: "의도적 중지", reason: `잡 일시중지: ${paused.join(" · ")}`, detail: null }
      : unused ? { level: "idle", text: "쓰지 않음", reason: unused, detail: null }
      : skipText ? { level: "idle", text: "의도적 중지", reason: skipText, detail: null }
      : emptyExtra ? { level: "idle", text: "비어 있음", reason: "이 칸은 쓰지 않습니다", detail: null }
      : !tracked ? untracked
      : !readable ? { level: "unknown", text: UNREADABLE, reason: "장부를 읽지 못했습니다", detail: null }
      : total > 0 ? { level: "ok", text: "정상", reason: `1시간 정산 ${fmt(total)}${multi ? " (작업 전체)" : ""}`, detail: null }
      : auditIdle ? { level: "idle", text: "쉼", reason: auditIdle, detail: null }
      : { level: "idle", text: "쉼", reason: lastSuccess !== null ? `최근 1시간 호출 없음 · 마지막 성공 ${kstStamp(lastSuccess)}` : "최근 1시간 호출 없음", detail: null };
    const worst = signals.reduce<TaskAssignStatus | null>((current, entry) => !current || LEVEL_RANK[entry.level] > LEVEL_RANK[current.level] ? entry : current, null);
    let status: TaskAssignStatus;
    if (paused) {
      // 멈춘 작업은 늘 「의도적 중지」 — 고칠 것이 있으면 까닭 옆에 함께 적는다
      status = { ...base, detail: [...signals.map(entry => entry.reason), ...notes].filter(Boolean).join(" / ") || null };
    } else if (worst && (LEVEL_RANK[worst.level] > LEVEL_RANK[base.level] || (base === untracked && worst.level === base.level))) {
      const others = signals.filter(entry => entry !== worst && entry.level !== "ok").map(entry => entry.reason).filter((text): text is string => !!text);
      status = { level: worst.level, text: worst.text, reason: [worst.reason, others[0] ?? notes[0]].filter(Boolean).join(" · ") || null,
        detail: [worst.detail, ...signals.filter(entry => entry !== worst).map(entry => entry.detail ?? entry.reason), ...notes].filter(Boolean).join(" / ") || null };
    } else status = notes.length ? { ...base, reason: [...notes, base.reason].filter(Boolean).join(" · ") } : base;

    const modeText = mode === null || !input.executions ? "실행 방식 미확인" : mode === "workload_pool" ? `작업 분산 · ${execution?.members.length ?? 0}칸`
      : mode === "classifier" ? "기존 CLI 분류" : mode === "effective" ? "실제 적용 설정" : "대체 실행";
    return { key: `${task.id}#${slot.slot}`, anchor: `execution-${task.id}-${slot.slot}`, task: task.id, slot: slot.slot, slots: task.slots, label: slot.label,
      group: task.group, groupLabel: AI_TASK_GROUP_LABELS[task.group], mode, modeText, choices, merged: mode !== "fallback", source,
      archived: mode === "workload_pool" ? ranks : [],
      actual: { readable, tracked, settled: readable && tracked ? total : null, failed: readable && tracked ? failed : null, calls, empty, warnings, shared: multi, compared,
        mixed, note },
      status, paused: !!paused,
      records: aiTaskRanksUnread(task.id) && slot.rows.length > 0 && slot.revision ? { count: slot.rows.length, revision: slot.revision } : null };
  });

  const counts: Record<LlmOpsLevel, number> = { ok: 0, warn: 0, bad: 0, idle: 0, unknown: 0 };
  for (const row of rows) counts[row.status.level] += 1;
  return { readable, observedAt: observation.observedAt, rows, counts, errors };
}

/** 서랍 「바뀌는 내용」의 장비 한도 — 장부 관측의 장비 행·정책 대체 한도와 점유. 장비 행을 못 읽었으면 null(모른다). */
export function taskAssignDeviceLimits(observation: AdminModelsObservation): RankDeviceLimit[] | null {
  if (!observationReadable(observation) || !observation.devicesRead) return null;
  const ids = new Set([...observation.devices.map(device => device.deviceId), ...observation.groups.map(group => group.groupId)]);
  return [...ids].sort().map(deviceId => {
    const device = observation.devices.find(row => row.deviceId === deviceId);
    const group = observation.groups.find(row => row.groupId === deviceId);
    return { deviceId, limit: device?.limitSlots ?? group?.limit ?? null, held: group?.held ?? 0, source: device?.source ?? group?.source ?? null };
  });
}

/** 서랍의 줄에 저장된 순위의 준비 상태를 붙인다 — 막힘·알림(notes)과, 다시 저장하면 만들 것(pending). 예전 순위판 「자세히」·「다시 저장」과 같은 글이다. */
export function withTaskReadiness(editor: FlowRankEditor, slots: readonly Pick<TaskAssignSlotInput, "task" | "slot" | "readiness">[]): FlowRankEditor {
  return { ...editor, lines: editor.lines.map(line => {
    const slot = slots.find(entry => entry.task.id === line.task && entry.slot === line.slot);
    if (!slot) return line;
    const pending = slot.readiness.flatMap(ready => aiRankPendingText(ready));
    const notes = slot.readiness.flatMap(ready => [...ready.blocking.map(text => ({ tone: "bad" as const, text })), ...ready.warnings.map(text => ({ tone: "warn" as const, text }))]);
    return { ...line, ...(pending.length ? { pending } : {}), ...(notes.length ? { notes } : {}) };
  }) };
}
