import { JOB_CATALOG } from "@/lib/jobs/catalog";
import { aiTaskSupportsWorkloadPool, aiTaskWorkloadPoolApiOnly } from "@/lib/llm/ai-task-execution-config";
import { AI_TASKS, aiTask, aiTaskSlotLabel, AUDIT_DIRECT_ROUTE } from "@/lib/llm/ai-tasks";
import type { AiRankChoice } from "./admin-ai-tasks";
import type { AiTaskExecutionAdminView } from "./admin-ai-task-execution";
import type { ChangeWatchRow } from "./change-watch";
import { buildConsoleFlow, type ConsoleTone } from "./console-home-model";
import {
  formatCount, formatDuration, formatKst, formatShare, idleModels, josa, modelStats, skipSentence,
  type ConsoleConnection, type ConsoleDevice, type ConsoleTaskBoard, type ConsoleTaskInputs,
} from "./console-tasks";
import type { Conveyor } from "./conveyor-model";
import { STAGE_PANELS, stagePanel, type StagePanelDef, type StagePanelKey } from "./stage-panel-catalog";

/**
 * 단계 패널(운영 콘솔 개편 조각 2a, 2026-11-12 최종 시안 「화면 2 단계 패널」) — 순수 함수만. DB·서버 동작 없음.
 *
 * 다섯 구역: ① 머리(이름·상태·대기·가장 오래된 것·최근 처리·24시간·시간별 추이) ② 왜 이런가 ③ 모델 ④ 한도 ⑤ 최근 바뀐 것.
 * ② 는 읽은 사실만 줄로 적는다 — 사람이 멈춤(누가·언제·사유), 접수 중단, 워커가 남긴 건너뜀·degraded·오류, 실행 쪽의 순위 사정,
 *   배정된 모델마다 지금 쓰는 칸/한도와 그 칸을 쓰는 다른 단계, 시간별 처리량이 꺾인 시각. 추측 문장은 만들지 않고, 까닭을 못 읽었으면 「원인 미확인」.
 * ③ 의 저장 전 확인(assignmentPreview)은 바뀌는 값(전 → 후)과 영향을 받는 단계(같은 모델을 쓰는 다른 단계)를 센다. 저장은 기존 서버 동작이 한다.
 * 상태·대기는 홈 「흐름」 표(buildConsoleFlow)와 같은 판정을 쓴다 — 표와 패널이 다른 말을 하지 않게.
 */

const MINUTE = 60_000;
/** 실행 쪽 순위 사정·잡 관측을 「지금」으로 보는 시간 — 작업 배정 화면과 같은 30분 */
export const STAGE_RUNTIME_FRESH_MS = 30 * MINUTE;
/** 추이의 꺾임: 앞 6시간 평균이 시간당 10건 이상이고, 그 시간과 뒤의 평균이 앞 평균의 절반 이하 */
export const TREND_BREAK = Object.freeze({ windowHours: 6, minPerHour: 10, dropRatio: 0.5 });

// ── 입력 ───────────────────────────────────────────────────────────────────────────────────────────────

/** 잡 행(listJobStates) — 패널의 마지막 실행·성공·오류 */
export type StageJobState = { name: string; paused: boolean; lastRunAt: string | null; lastSuccessAt: string | null; lastError: string | null; notBefore: string | null };
/** 사람이 멈춘 기록 — 그 잡의 마지막 job-pause 작업 로그 */
export type StagePauseRecord = { job: string; actor: string; at: string; reason: string };
/** 잡 관측(operations_observations job:<잡>)의 지금 degraded — 막 끝난 틱이 제 일을 못 한 까닭 */
export type StageJobDegraded = { job: string; code: string; detail: string | null; streak: number | null; since: string | null; at: string };
/** 실행 쪽 순위 사정(readAiTaskRuntime) — 그 작업 잡의 마지막 틱이 순위마다 맡긴 수와 못 쓴 까닭 */
export type StageRuntime = { task: string; at: string; served: readonly { rank: number; count: number }[];
  unusable: readonly { rank: number; code: string; text: string; count: number }[]; degraded: { code: string; detail: string | null } | null };

export type StagePanelInput = {
  key: StagePanelKey;
  now: string;
  conveyor: Pick<Conveyor, "stations" | "hours" | "human" | "published" | "publishedHour"> | null;
  /** 홈 할 일의 입력(진행·잡·접수·연결·순위·작업 분산·장비·24시간 장부) — 홈과 같은 읽기 */
  inputs: ConsoleTaskInputs;
  board: Pick<ConsoleTaskBoard, "marks">;
  jobStates: readonly StageJobState[] | null;
  pauses: readonly StagePauseRecord[] | null;
  degraded: readonly StageJobDegraded[] | null;
  runtime: readonly StageRuntime[] | null;
  executions: readonly AiTaskExecutionAdminView[] | null;
};

// ── 출력 ───────────────────────────────────────────────────────────────────────────────────────────────

export type StageFact = { label: string; value: string | null };
export type StageWhy = { label: string; text: string };
export type StageJobView = { job: string; label: string; paused: boolean | null; text: string; pause: StagePauseRecord | null;
  /** 잡 행의 not_before — 멈춤·재개 폼이 판으로 보낸다(JobControl expectedNotBefore) */
  notBefore: string | null };
export type StageMemberView = { tag: string; connectionId: string; name: string; model: string; facts: string };
export type StageModelLine = {
  key: string; task: string; slot: number; label: string;
  mode: "fallback" | "workload_pool";
  /** 「동시에」(작업 분산)를 지금 그 작업이 받는가 — stagePoolSupported 한 곳에서 묻는다 */
  poolSupported: boolean;
  /** 작업 분산에 API·OpenCode 연결만 받는 작업(발행 분류) */
  apiOnly: boolean;
  members: StageMemberView[];
  /** 작업 분산 중일 때 보관된 대체 순위(지금은 쓰지 않음) */
  archived: string | null;
  /** 남는 모델 — 24시간 사용률 5% 미만(홈 「쌓임」과 같은 계산) */
  idle: { connectionId: string; name: string; text: string }[];
};
export type StagePanel = {
  key: StagePanelKey; label: string; tone: ConsoleTone; status: string;
  facts: StageFact[];
  /** 지난 23시간 시간별 처리(이번 시간은 덜 차서 뺀다) — 시간별 기록이 없는 단계는 null */
  spark: number[] | null;
  why: StageWhy[];
  jobs: StageJobView[];
  /** 모델을 쓰지 않는 단계는 null */
  models: StageModelLine[] | null;
  /** 칸 사용을 셀 수 없음(장비 관측을 못 읽음) */
  slotsUnknown: boolean;
  links: StagePanelDef["links"];
  tasks: readonly string[];
  /** 이 단계의 장부 route — 최근 바뀐 것을 거른다 */
  routes: string[];
};

// ── 이름 ───────────────────────────────────────────────────────────────────────────────────────────────

/** 작업 → 단계 이름(홈의 말) — 「그 칸을 쓰는 다른 단계」·「같은 모델을 쓰는 단계」에 쓴다 */
const TASK_STAGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "first-review": "AI 1차", "second-review": "AI 2차", "crawl-tagline": "소개 짓기", "publish-classify": "발행 분류",
  "product-search-profile": "키워드 짓기", "product-search-verify": "키워드 검수", "product-tagline-ko": "한국어 소개",
  "product-translate": "공개 번역", "reason-translate": "사유 번역", "product-intro-check": "소개 검수",
  "human-review": "사람 몫 AI 위임", "split-confirm": "갈림 재확인", "split-tiebreak": "갈림 판가름", "held-review-retry": "보류 재심사",
});
export const taskStageLabel = (taskId: string) => TASK_STAGE_LABELS[taskId] ?? aiTask(taskId)?.label ?? taskId;

/** 작업의 장부 route — 감사 직접 경로를 함께 쓰는 작업은 그것도 */
export function taskRoutes(taskId: string): string[] {
  const task = aiTask(taskId);
  if (!task) return [];
  return [...(task.routeId ? [task.routeId] : []), ...(task.wiring === "audit-direct" ? [AUDIT_DIRECT_ROUTE] : [])];
}
/** 장부 route → 그 칸을 쓰는 단계 이름 */
export function routeStageLabel(routeId: string): string {
  const task = AI_TASKS.find(row => row.routeId === routeId) ?? (routeId === AUDIT_DIRECT_ROUTE ? AI_TASKS.find(row => row.wiring === "audit-direct") : undefined);
  return task ? taskStageLabel(task.id) : routeId;
}

/** 「동시에」(작업 분산)를 이 작업·칸이 지금 받는가 — 지원 범위는 ai-task-execution-config 한 곳이 정한다(넓히면 패널도 따라 켜진다) */
export const stagePoolSupported = (taskId: string, slot = 1): boolean => aiTaskSupportsWorkloadPool(taskId, slot);

const intervalText = (ms: number | null) => ms === null ? null : ms < 60 * MINUTE ? `${Math.round(ms / MINUTE)}분` : `${Math.round(ms / (60 * MINUTE))}시간`;

// ── 추이 ───────────────────────────────────────────────────────────────────────────────────────────────

export type TrendBreak = { at: string; before: number; value: number; low: { at: string; value: number } | null };

/**
 * 시간별 처리에서 꺾인 시각 — 앞 6시간 평균이 시간당 10건 이상인데, 그 시간이 평균의 절반 이하로 떨어지고 뒤로도 절반 이하에 머문 첫 시간.
 * 그 뒤 가장 낮았던 시간(꺾인 시간보다 낮을 때만)도 함께 낸다. 시각만 말하고 까닭은 말하지 않는다.
 */
export function trendBreak(hours: readonly string[], values: readonly number[]): TrendBreak | null {
  const { windowHours, minPerHour, dropRatio } = TREND_BREAK;
  const count = Math.min(hours.length, values.length);
  for (let index = windowHours; index < count; index += 1) {
    const before = values.slice(index - windowHours, index).reduce((sum, value) => sum + value, 0) / windowHours;
    if (before < minPerHour || values[index] > before * dropRatio) continue;
    const rest = values.slice(index, count);
    if (rest.reduce((sum, value) => sum + value, 0) / rest.length > before * dropRatio) continue;
    let lowest: { value: number; index: number } = { value: values[index], index };
    rest.forEach((value, offset) => { if (value < lowest.value) lowest = { value, index: index + offset }; });
    return { at: hours[index], before, value: values[index], low: lowest.index !== index ? { at: hours[lowest.index], value: lowest.value } : null };
  }
  return null;
}

/** 「11-12 01시대」 — 같은 날의 두 번째 시간은 「06시대」 */
function hourText(at: string, sameDayAs?: string): string {
  const text = formatKst(at);
  const day = text.slice(0, 5), hour = text.slice(6, 8);
  return sameDayAs && formatKst(sameDayAs).slice(0, 5) === day ? `${hour}시대` : `${day} ${hour}시대`;
}
export function trendText(found: TrendBreak): string {
  const head = `${hourText(found.at)}에 시간당 ${formatCount(found.before)}건에서 ${formatCount(found.value)}건으로 떨어졌`;
  return found.low ? `${head}고, ${hourText(found.low.at, found.at)}는 ${formatCount(found.low.value)}건이었습니다. 원인 미확인.` : `${head}습니다. 원인 미확인.`;
}

// ── 칸 ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * 모델 하나의 지금 칸 — 「supa는 3칸 중 3칸을 쓰고 있고, 쓰는 쪽은 키워드 검수입니다.」 장비를 여러 연결이 나눠 쓰면 주어는 「…이 있는 장비」.
 * ownRoutes 는 이 단계의 route — 이 단계가 쥔 칸은 「이 단계」로 적는다. 장비 관측이 없으면 null.
 */
export function slotSentence(connection: ConsoleConnection, connections: readonly ConsoleConnection[], devices: readonly ConsoleDevice[] | null,
  ownRoutes: readonly string[]): string | null {
  if (!devices) return null;
  const device = devices.find(row => row.deviceId === connection.deviceId);
  const shared = connections.filter(row => row.deviceId === connection.deviceId).length > 1;
  const subject = shared ? `${connection.label}이(가) 있는 장비` : connection.label;
  const limit = device?.limit ?? connection.capacitySlots;
  const active = device?.active ?? 0;
  if (active === 0) return `${josa(subject, "은/는")} ${formatCount(limit)}칸이 모두 비어 있습니다.`;
  const users = (device?.routes ?? []).filter(row => row.active > 0)
    .map(row => ({ label: ownRoutes.includes(row.routeId) ? "이 단계" : routeStageLabel(row.routeId), active: row.active }));
  const head = `${josa(subject, "은/는")} ${formatCount(limit)}칸 중 ${formatCount(active)}칸을 쓰고 있`;
  if (!device?.routes) return `${head}습니다.`;
  if (!users.length) return `${head}습니다(쓰는 단계를 읽지 못함).`;
  const who = users.length === 1 ? users[0].label : users.map(row => `${row.label} ${formatCount(row.active)}칸`).join(" · ");
  return `${head}고, 쓰는 쪽은 ${who}입니다.`;
}

// ── 패널 ───────────────────────────────────────────────────────────────────────────────────────────────

export function buildStagePanel(input: StagePanelInput): StagePanel | null {
  const def = stagePanel(input.key);
  if (!def) return null;
  const now = Date.parse(input.now);
  const { inputs } = input;
  const flow = buildConsoleFlow(input.conveyor as Conveyor | null, inputs.progress, input.board);
  const row = [...flow.main, ...flow.post].find(entry => entry.key === def.key) ?? null;
  const station = def.station ? input.conveyor?.stations.find(entry => entry.key === def.station) ?? null : null;
  const progress = def.progress.map(key => inputs.progress?.stages.find(stage => stage.stage === key)).filter(stage => !!stage);
  const routes = [...new Set(def.tasks.flatMap(taskRoutes))];
  const label = station?.label ?? def.label;
  const jobLabel = (job: string) => def.jobs.find(entry => entry.job === job)?.label ?? job;

  // ① 머리 — 흐름 칸이 있으면 그 수(전체 흐름), 없으면 워커 진행과 24시간 장부
  const settled24 = inputs.ledger ? inputs.ledger.filter(entry => routes.includes(entry.routeId)).reduce((sum, entry) => sum + entry.settled, 0) : null;
  const waiting = station ? station.waiting : progress.length ? progress.reduce<number | null>((sum, stage) => stage.waiting == null || sum === null ? null : sum + stage.waiting, 0) : null;
  const oldest = station ? station.oldestMinutes : progress.reduce<number | null>((max, stage) => stage.oldestMinutes == null ? max : Math.max(max ?? 0, stage.oldestMinutes), null);
  const facts: StageFact[] = [
    { label: "대기", value: waiting === null ? (station?.key === "discover" ? "—" : null) : formatCount(waiting) },
    { label: "가장 오래된 것", value: waiting ? oldest === null ? null : formatDuration(oldest) : "—" },
    station?.doneHour != null ? { label: "최근 1시간", value: formatCount(station.doneHour) }
      : { label: "최근 5분", value: station ? station.done5m === null ? null : formatCount(station.done5m)
        : progress.length && progress.every(stage => stage.completed5m != null) ? formatCount(progress.reduce((sum, stage) => sum + (stage.completed5m ?? 0), 0)) : null },
    station ? { label: "24시간", value: station.done24h === null ? null : formatCount(station.done24h) }
      : { label: "24시간 모델 처리", value: settled24 === null ? null : formatCount(settled24) },
  ];
  const spark = station?.spark?.length ? station.spark.slice(0, -1) : null;

  // ② 왜 이런가 — 읽은 사실만
  const why: StageWhy[] = [];
  let explained = false;
  const states = new Map((input.jobStates ?? []).map(state => [state.name, state]));
  const jobs: StageJobView[] = def.jobs.map(({ job, label: name }) => {
    const state = states.get(job) ?? null;
    const consoleJob = inputs.jobs?.find(entry => entry.name === job) ?? null;
    const paused = state ? state.paused : consoleJob ? consoleJob.paused : null;
    const pause = paused ? input.pauses?.find(record => record.job === job) ?? null : null;
    const interval = intervalText(JOB_CATALOG.find(entry => entry.name === job)?.intervalMs ?? null);
    const last = state?.lastSuccessAt ? `마지막 성공 ${formatKst(state.lastSuccessAt)}` : state ? "성공 기록 없음" : null;
    const text = [paused === null ? "상태 셀 수 없음" : paused ? "사람이 멈춤" : "도는 중", interval ? `주기 ${interval}` : null, last].filter(Boolean).join(" · ");
    return { job, label: name, paused, text, pause, notBefore: state?.notBefore ?? consoleJob?.notBefore ?? null };
  });
  for (const job of jobs.filter(entry => entry.paused)) {
    explained = true;
    why.push({ label: "사람이 멈춤", text: job.pause
      ? `${job.label} 작업을 ${job.pause.actor}이(가) ${formatKst(job.pause.at)}에 멈췄습니다 — 사유: ${job.pause.reason || "(적지 않음)"}`
      : input.pauses ? `${job.label} 작업이 멈춰 있습니다 — 멈춘 기록(작업 로그)을 찾지 못했습니다.` : `${job.label} 작업이 멈춰 있습니다 — 멈춘 기록을 읽지 못했습니다.` });
  }
  if (def.tasks.length && inputs.admission && inputs.admission.mode !== "open") {
    explained = true;
    why.push({ label: "접수", text: `모델 접수가 ${inputs.admission.mode === "draining" ? "중단" : "꺼짐"} 상태입니다${inputs.admission.since ? `(${formatKst(inputs.admission.since)}부터)` : ""}.` });
  }
  const skipCodes = new Set<string>();
  for (const stage of progress) if (stage.skipBlock) {
    explained = true;
    skipCodes.add(stage.skipBlock.code);
    const sentence = skipSentence(stage.skipBlock).replace(/^워커가 /, "").replace(/니다\.$/, "니다");
    const reasons = [...(stage.skipBlock.detail ?? "").matchAll(/([a-z_]+)=\d+/g)].map(match => match[1]);
    why.push({ label: "워커", text: `${sentence}${reasons.length ? `(건너뜀 사유 ${reasons.join(", ")})` : ""}.` });
  }
  for (const entry of input.degraded ?? []) {
    if (!def.jobs.some(job => job.job === entry.job) || skipCodes.has(entry.code) || now - Date.parse(entry.at) > STAGE_RUNTIME_FRESH_MS) continue;
    explained = true;
    skipCodes.add(entry.code);
    why.push({ label: "워커", text: `${jobLabel(entry.job)} 작업의 마지막 틱이 제 일을 못 했습니다(${entry.code}${entry.detail ? ` — ${entry.detail}` : ""})`
      + `${entry.streak && entry.streak > 1 ? ` · ${formatCount(entry.streak)}번 연속${entry.since ? `, ${formatKst(entry.since)}부터` : ""}` : ""}.` });
  }
  for (const job of def.jobs) {
    const error = states.get(job.job)?.lastError;
    if (!error) continue;
    explained = true;
    why.push({ label: "오류", text: `${job.label} 작업의 마지막 틱이 오류로 끝났습니다 — ${error.replace(/\s+/g, " ").slice(0, 160)}` });
  }
  for (const runtime of input.runtime ?? []) {
    if (!def.tasks.includes(runtime.task) || now - Date.parse(runtime.at) > STAGE_RUNTIME_FRESH_MS) continue;
    const parts = [...runtime.served.filter(entry => entry.count > 0).map(entry => `${entry.rank}순위로 ${formatCount(entry.count)}건`),
      ...runtime.unusable.map(entry => `${entry.rank}순위 못 씀(${entry.text}) ${formatCount(entry.count)}회`)];
    if (runtime.degraded && !skipCodes.has(runtime.degraded.code)) {
      explained = true;
      parts.push(`제 일 못 함(${runtime.degraded.code}${runtime.degraded.detail ? ` — ${runtime.degraded.detail}` : ""})`);
    }
    if (runtime.unusable.length) explained = true;
    if (parts.length) why.push({ label: "실행 쪽", text: `${def.tasks.length > 1 ? `${taskStageLabel(runtime.task)} · ` : ""}마지막 틱(${formatKst(runtime.at).slice(6)}): ${parts.join(" · ")}` });
  }

  // ③ 모델 — 배정(순위 또는 작업 분산)과 칸·24시간, 남는 모델
  const connections = inputs.connections ?? [];
  const stats = modelStats(inputs);
  const connectionOf = (id: string) => connections.find(entry => entry.id === id) ?? null;
  const memberFacts = (task: string, connection: ConsoleConnection | null, model: string) => {
    if (!connection) return "지워진 연결";
    const device = inputs.devices?.find(entry => entry.deviceId === connection.deviceId) ?? null;
    const slots = !inputs.devices ? "칸 셀 수 없음" : `지금 ${formatCount(device?.active ?? 0)}/${formatCount(device?.limit ?? connection.capacitySlots)}칸`;
    const own = taskRoutes(task);
    const rows = inputs.ledger?.filter(entry => own.includes(entry.routeId) && entry.groupId === connection.deviceId && entry.model === model) ?? null;
    const settled = rows?.reduce((sum, entry) => sum + entry.settled, 0) ?? null;
    const seconds = rows && settled ? rows.reduce((sum, entry) => sum + (entry.avgSeconds ?? 0) * entry.settled, 0) / settled : null;
    return [slots, settled === null ? "24시간 셀 수 없음" : `24시간 ${formatCount(settled)}건`, seconds === null ? null : `${seconds.toFixed(1)}초`].filter(Boolean).join(" · ");
  };
  const models: StageModelLine[] | null = def.tasks.length ? def.tasks.flatMap(taskId => {
    const task = aiTask(taskId);
    if (!task) return [];
    return Array.from({ length: task.slots }, (_, index) => index + 1).map((slot): StageModelLine => {
      const execution = input.executions?.find(entry => entry.task === taskId && entry.slot === slot) ?? null;
      const mode = execution?.mode ?? "fallback";
      const ranks = (inputs.ranks ?? []).filter(entry => entry.task === taskId && entry.slot === slot && entry.enabled).sort((a, b) => a.rank - b.rank);
      const name = (id: string) => connectionOf(id)?.label ?? "지워진 연결";
      const members = mode === "workload_pool" && execution
        ? execution.members.map(member => ({ tag: "함께", connectionId: member.connectionId, name: name(member.connectionId), model: member.model,
          facts: memberFacts(taskId, connectionOf(member.connectionId), member.model) }))
        : ranks.map(entry => ({ tag: `${entry.rank}순위`, connectionId: entry.connectionId, name: name(entry.connectionId), model: entry.model,
          facts: memberFacts(taskId, connectionOf(entry.connectionId), entry.model) }));
      const idle = idleModels(inputs, taskId, stats).map(stat => ({ connectionId: stat.connection.id, name: stat.connection.label,
        text: `${formatShare(stat.utilization!, stat.calls ?? 0)} · ${formatCount(stat.connection.capacitySlots)}칸` }));
      return { key: `${taskId}#${slot}`, task: taskId, slot, label: aiTaskSlotLabel(task, slot), mode, poolSupported: stagePoolSupported(taskId, slot),
        apiOnly: aiTaskWorkloadPoolApiOnly(taskId), members, idle,
        archived: mode === "workload_pool" && ranks.length ? ranks.map(entry => `${entry.rank}순위 ${name(entry.connectionId)}`).join(" → ") : null };
    });
  }) : null;
  // 배정된 모델마다 지금 칸과 그 칸을 쓰는 단계 — 같은 연결은 한 번만
  if (models) {
    const seen = new Set<string>();
    for (const line of models) for (const member of line.members) {
      const connection = connectionOf(member.connectionId);
      if (!connection || seen.has(connection.id)) continue;
      seen.add(connection.id);
      const sentence = slotSentence(connection, connections, inputs.devices, routes);
      if (sentence) why.push({ label: member.tag, text: sentence });
    }
  }
  const slotsUnknown = !!models && !inputs.devices;

  // 추이 — 꺾인 시각(까닭은 말하지 않는다)
  const hours = input.conveyor?.hours?.slice(0, -1) ?? null;
  const found = spark && hours ? trendBreak(hours, spark) : null;
  if (found) why.push({ label: "추이", text: trendText(found) });
  const tone = row?.tone ?? "off";
  if (!explained && !found && (tone === "bad" || tone === "warn")) why.push({ label: "원인", text: "원인 미확인 — 위의 값 말고 까닭을 읽지 못했습니다." });

  return { key: def.key, label, tone, status: row?.status ?? "미확인", facts, spark, why, jobs, models, slotsUnknown, links: def.links, tasks: def.tasks, routes };
}

/** 이 단계에 닿은 바꾼 것 — 같은 route(순위·한도·모델 저장), 이 단계 잡의 멈춤·재개, 이 단계 작업의 순위·실행 방식 저장 */
export function stageChanges(rows: readonly ChangeWatchRow[], panel: Pick<StagePanel, "routes" | "tasks" | "jobs">): ChangeWatchRow[] {
  return rows.filter(row => (row.routes ?? []).some(route => panel.routes.includes(route))
    || ((row.action === "job-pause" || row.action === "job-resume") && panel.jobs.some(job => job.job === row.target))
    || ((row.action === "ai-task-models-save" || row.action === "ai-task-execution-save") && panel.tasks.includes(row.target.split("#")[0])));
}

// ── 저장 전 확인 ───────────────────────────────────────────────────────────────────────────────────────

/** 배정 하나의 상태 — 방식과 순위(대체 실행) 또는 함께 쓰는 모델(작업 분산) */
export type AssignmentState = { mode: "fallback" | "workload_pool"; ranks: readonly (AiRankChoice | null)[]; members: readonly (AiRankChoice | null)[] };
/** 확인에 필요한 둘레 — 연결·장비 칸·「어느 단계가 어느 연결을 쓰나」(켜진 순위 + 작업 분산 구성원) */
export type PreviewContext = {
  connections: readonly { id: string; label: string; deviceId: string; capacitySlots: number; models: readonly string[] }[];
  devices: readonly { deviceId: string; active: number; limit?: number }[] | null;
  uses: readonly { task: string; slot: number; connectionId: string }[];
};
export type AssignmentPreview = {
  rows: { label: string; before: string; after: string }[];
  impact: { tone: "bad" | "warn" | "info"; text: string }[];
  /** 부를 기존 저장 — execution = 실행 방식(saveTaskExecutionAction), ranks = 순위(saveAiTaskRanksAction) */
  saves: ("execution" | "ranks")[];
};

export const MODE_LABELS = Object.freeze({ fallback: "순위대로", workload_pool: "동시에" } as const);

/** 둘레를 만든다 — 홈 읽기(연결·순위·작업 분산·장비)에서 */
export function previewContext(inputs: Pick<ConsoleTaskInputs, "connections" | "ranks" | "pools" | "devices">): PreviewContext {
  return {
    connections: (inputs.connections ?? []).map(row => ({ id: row.id, label: row.label, deviceId: row.deviceId, capacitySlots: row.capacitySlots, models: row.models })),
    devices: inputs.devices?.map(row => ({ deviceId: row.deviceId, active: row.active, ...(row.limit !== undefined ? { limit: row.limit } : {}) })) ?? null,
    uses: [...(inputs.ranks ?? []).filter(row => row.enabled).map(row => ({ task: row.task, slot: row.slot, connectionId: row.connectionId })),
      ...(inputs.pools ?? []).map(row => ({ task: row.task, slot: row.slot, connectionId: row.connectionId }))],
  };
}

const chosen = (rows: readonly (AiRankChoice | null)[]) => rows.filter((row): row is AiRankChoice => !!row);
const sameRows = (a: readonly (AiRankChoice | null)[], b: readonly (AiRankChoice | null)[]) => {
  const x = chosen(a), y = chosen(b);
  return x.length === y.length && x.every((row, index) => row.provider === y[index].provider && row.model === y[index].model
    && (row.reasoningEffort ?? "") === (y[index].reasoningEffort ?? ""));
};

/**
 * 저장 전 확인 — 바뀌는 값(방식 · 동시 처리 · 순위 또는 함께 쓰는 모델의 전 → 후)과 영향(바뀐 뒤 쓰는 모델마다 지금 칸과 같은 모델을 쓰는 다른 단계 수,
 * 이 단계에서 빠지는 모델, 1순위가 비는 것). 바뀐 것이 없으면 rows·saves 가 비어 있다.
 * 작업 분산 → 순위대로로 돌아갈 때는 순위를 함께 바꾸지 않는다(보관된 순위로 돌아간다 — 실행 방식 저장이 그렇게 한다).
 */
export function assignmentPreview(input: { task: string; slot: number; before: AssignmentState; after: AssignmentState; context: PreviewContext }): AssignmentPreview {
  const { before, after, context, task, slot } = input;
  const connection = (id: string) => context.connections.find(row => row.id === id) ?? null;
  const name = (choice: AiRankChoice) => {
    const found = connection(choice.provider);
    if (!found) return "지워진 연결";
    return found.models.length > 1 ? `${found.label}(${choice.model})` : found.label;
  };
  const chain = (rows: readonly (AiRankChoice | null)[]) => chosen(rows).length ? chosen(rows).map(name).join(" → ") : "비어 있음";
  const together = (rows: readonly (AiRankChoice | null)[]) => chosen(rows).length ? chosen(rows).map(name).join(" + ") : "비어 있음";
  const limitOf = (id: string) => { const found = connection(id); if (!found) return 0; return context.devices?.find(row => row.deviceId === found.deviceId)?.limit ?? found.capacitySlots; };
  const concurrency = (state: AssignmentState) => {
    if (state.mode === "fallback") return "1순위 모델 하나씩(막히면 다음 순위)";
    const devices = new Map<string, number>();
    for (const row of chosen(state.members)) { const found = connection(row.provider); if (found) devices.set(found.deviceId, limitOf(row.provider)); }
    const slots = [...devices.values()].reduce((sum, value) => sum + value, 0);
    return `모델 ${formatCount(chosen(state.members).length)}개가 나눠 처리 · 장비 칸 합 ${formatCount(slots)}칸(다른 단계와 함께 씀)`;
  };

  const modeChanged = before.mode !== after.mode;
  const membersChanged = after.mode === "workload_pool" && !sameRows(before.members, after.members);
  const ranksChanged = after.mode === "fallback" && before.mode === "fallback" && !sameRows(before.ranks, after.ranks);
  const rows: AssignmentPreview["rows"] = [];
  const saves: AssignmentPreview["saves"] = [];
  if (modeChanged) rows.push({ label: "방식", before: MODE_LABELS[before.mode], after: MODE_LABELS[after.mode] });
  if (modeChanged || membersChanged) rows.push({ label: "동시 처리", before: concurrency(before), after: concurrency(after) });
  if (after.mode === "workload_pool" && (modeChanged || membersChanged))
    rows.push({ label: "함께 쓰는 모델", before: before.mode === "workload_pool" ? together(before.members) : "없음", after: together(after.members) });
  if (modeChanged && after.mode === "fallback") rows.push({ label: "순위", before: "쓰지 않음(보관)", after: chain(after.ranks) });
  if (ranksChanged) rows.push({ label: "순위", before: chain(before.ranks), after: chain(after.ranks) });
  if (modeChanged || membersChanged) saves.push("execution");
  if (ranksChanged) saves.push("ranks");

  const impact: AssignmentPreview["impact"] = [];
  if (!rows.length) return { rows, impact, saves };
  const used = (state: AssignmentState) => chosen(state.mode === "workload_pool" ? state.members : state.ranks);
  const afterIds = [...new Set(used(after).map(row => row.provider))], beforeIds = [...new Set(used(before).map(row => row.provider))];
  const others = (id: string) => [...new Set(context.uses.filter(row => row.connectionId === id && !(row.task === task && row.slot === slot)).map(row => taskStageLabel(row.task)))];
  for (const id of afterIds) {
    const found = connection(id);
    if (!found) { impact.push({ tone: "bad", text: "지워진 연결을 고르고 있습니다." }); continue; }
    const device = context.devices?.find(row => row.deviceId === found.deviceId) ?? null;
    const limit = limitOf(id);
    const slots = !context.devices ? "지금 칸 셀 수 없음" : `지금 ${formatCount(limit)}칸 중 ${formatCount(device?.active ?? 0)}칸 사용${(device?.active ?? 0) >= limit ? "(가득 참)" : ""}`;
    const share = others(id);
    impact.push({ tone: (device?.active ?? 0) >= limit ? "warn" : "info",
      text: `${found.label}: ${slots} · ${share.length ? `같은 모델을 쓰는 다른 단계 ${formatCount(share.length)}개(${share.slice(0, 4).join(" · ")}${share.length > 4 ? ` 외 ${share.length - 4}` : ""})와 칸을 나눕니다` : "다른 단계는 이 모델을 쓰지 않습니다"}` });
  }
  for (const id of beforeIds.filter(entry => !afterIds.includes(entry))) {
    const found = connection(id);
    const share = others(id);
    impact.push({ tone: "info", text: `${found?.label ?? "지워진 연결"}을(를) 이 단계에서 뺍니다${share.length ? ` — 다른 단계 ${formatCount(share.length)}개는 계속 씁니다` : ""}.` });
  }
  if (after.mode === "fallback" && !after.ranks[0]) impact.push({ tone: "bad", text: "1순위가 비면 이 단계가 멈춥니다(no_task_models)." });
  if (after.mode === "workload_pool" && !chosen(after.members).length) impact.push({ tone: "bad", text: "함께 쓸 모델이 없습니다 — 하나 이상 고르세요." });
  return { rows, impact, saves };
}

/**
 * 작업 분산 구성원 검사 — 작업 배정 화면 실행 방식 폼(TaskExecutionForm)과 같은 검사(서버 saveAiTaskExecutionConfig 가 다시 검사한다).
 * connections 는 화면이 아는 연결(켜짐·종류·CLI 도구).
 */
export function poolMemberIssues(values: readonly (AiRankChoice | null)[], connections: readonly { id: string; enabled: boolean; kind: "api" | "cli"; cliTool: string | null }[],
  apiOnly: boolean): string[] {
  const selected = chosen(values);
  const issues: string[] = [];
  if (!selected.length) issues.push("분산할 모델을 하나 이상 선택하세요.");
  if (selected.some(choice => !connections.some(row => row.id === choice.provider && row.enabled))) issues.push("꺼졌거나 없는 연결을 바꿔주세요.");
  if (apiOnly && selected.some(choice => !connections.some(row => row.id === choice.provider && (row.kind === "api" || row.cliTool === "opencode"))))
    issues.push("발행 분류에는 API 또는 OpenCode 연결을 선택하세요.");
  if (selected.some((choice, index) => connections.some(row => row.id === choice.provider && row.kind === "cli")
    && selected.slice(0, index).some(previous => previous.provider === choice.provider && previous.model === choice.model
      && (previous.reasoningEffort ?? "") !== (choice.reasoningEffort ?? ""))))
    issues.push("같은 CLI 연결·모델은 추론 강도를 같게 설정하세요.");
  return issues;
}

/** 모든 패널 열쇠 — 시험·주소 검사 */
export const STAGE_PANEL_KEYS: readonly StagePanelKey[] = STAGE_PANELS.map(panel => panel.key);
