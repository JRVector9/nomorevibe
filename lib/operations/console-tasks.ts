import { HUMAN_BACKLOG_LIMIT } from "@/lib/crawl/human-queue";
import { AI_TASKS, aiTaskAccepts, type AiTaskDef } from "@/lib/llm/ai-tasks";
import type { Conveyor } from "./conveyor-model";

/**
 * 운영 콘솔 홈의 「지금 할 일」 규칙(2026-11-12 최종 시안 「할 일이 생기는 조건」 11줄).
 *
 * DB 를 읽지 않는 순수 함수다 — 입력은 관리자 화면이 이미 쓰는 읽기 값(console-home-read.ts 가 모은다)이고,
 * 출력은 네 묶음(멈춤 · 평소와 다름 · 쌓임 · 정리)의 할 일이다. 할 일은 사람이 적지 않는다 — 이 규칙에서만 나온다.
 * 판단은 사람이 한다: 접수를 열거나 멈춘 작업을 다시 켜는 것은 단추가 보내는 기존 화면·서버 동작이 하고, 여기서는 고르지 않는다.
 * 읽기 하나를 못 읽으면 그 읽기에 기대는 규칙만 「셀 수 없음」으로 남기고 나머지 할 일은 그대로 낸다.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 할 일 규칙의 기준값 — 바꿀 때는 여기 한 곳만 고친다(시안 「할 일이 생기는 조건」 표와 같은 값) */
export const CONSOLE_TASK_LIMITS = Object.freeze({
  /** 멈춤: 대기가 있는데 1시간 처리가 대기의 이 비율(10분의 1)에 못 미치는 단계 */
  stalledRatio: 0.1,
  /** 멈춤: 사람이 멈춘 작업이 이만큼(하루)을 넘김 */
  pausedJobMs: DAY,
  /** 멈춤: 모델 접수 중단이 이만큼(30분)을 넘김 */
  admissionPausedMs: 30 * MINUTE,
  /** 멈춤: 내림 요청 약속 시간 — takedownSummary 의 overdue 가 이 기준(24시간)으로 센다. 화면 글자에만 쓴다 */
  takedownHours: 24,
  /** 평소와 다름: 보류 사유 하나가 24시간에 이만큼(50건)보다 많이 늘고 */
  holdSurge: 50,
  /** 평소와 다름: 그 사유 누적의 이 비율(절반) 이상이 24시간 안의 것 */
  holdNewShare: 0.5,
  /** 쌓임: 지금 속도(24시간 정산 수)로 이 날수(3일)를 넘게 걸리는 단계 */
  backlogDays: 3,
  /** 쌓임: 사람 확인 대기가 이만큼(500건)을 넘김 — 심사 큐·운영센터의 쌓임 경고와 같은 수 */
  humanWaiting: HUMAN_BACKLOG_LIMIT,
  /** 쌓임: 감사 거절이 이 날수(7일)를 넘게 기다림 — openBacklogStats 의 overdue(AUDIT_BACKLOG_OVERDUE_DAYS)가 센다. 화면 글자에만 쓴다 */
  auditOverdueDays: 7,
  /** 정리: 결과 없이 끝난 호출이 하루 이만큼(10건) 이상인 모델 */
  noResultPerDay: 10,
  /** 정리: 키 만료 이 날수(7일) 전부터 */
  keyExpiryDays: 7,
  /** 남는 모델: 24시간 사용률(호출 시간 합 ÷ (86,400초 × 동시 한도))이 이 값(5%) 미만 */
  idleUtilization: 0.05,
});

export type ConsoleGroupKey = "stop" | "odd" | "pile" | "tidy";
/** 묶음 순서와 알림 — 휴대폰 알림(조각 ④)은 멈춤과 평소와 다름만 보낸다 */
export const CONSOLE_GROUPS: readonly { key: ConsoleGroupKey; label: string; notify: boolean }[] = Object.freeze([
  { key: "stop", label: "멈춤", notify: true },
  { key: "odd", label: "평소와 다름", notify: true },
  { key: "pile", label: "쌓임", notify: false },
  { key: "tidy", label: "정리", notify: false },
]);

export type ConsoleRuleKey =
  | "stage-stalled" | "job-paused" | "admission-paused" | "takedown-overdue"
  | "hold-surge" | "change-drop"
  | "backlog-eta" | "human-or-audit"
  | "no-result" | "unused-or-duplicate" | "key-expiry";

/** 끝내는 단추 — 링크(기존 화면) 또는 기존 작업 멈춤·재개 서버 동작(사유 필수, 작업 로그 job-pause·job-resume) */
export type ConsoleAction =
  | { kind: "link"; label: string; href: string }
  | { kind: "job-resume"; label: string; job: string; fallbackHref: string };

export type ConsoleTask = {
  /** 같은 할 일이 다음 읽기에도 같은 열쇠를 갖는다(알림·지켜보기가 이어 붙인다) */
  id: string;
  group: ConsoleGroupKey;
  rule: ConsoleRuleKey;
  /** 점 색 — 멈춤 bad, 평소와 다름·쌓임 warn, 정리 off */
  tone: "bad" | "warn" | "off";
  title: string;
  /** 사실 한 줄 — 읽은 값만 */
  fact: string;
  /** 이유 한 줄 — 읽은 값으로 말할 수 있을 때만 */
  why: string | null;
  actions: ConsoleAction[];
  /** 휴대폰 알림 대상(묶음의 notify) */
  notify: boolean;
  /** 쌓임 정렬 — 지금 속도로 며칠(못 줄면 Infinity) */
  days?: number;
  /** 쌓임(backlog-eta)의 AI 작업 id — 모델 추가의 「쓸 단계」 권하기가 같은 계산을 쓴다(조각 3a) */
  stageTask?: string;
};

export type ConsoleTaskGroup = { key: ConsoleGroupKey; label: string; notify: boolean; tasks: ConsoleTask[];
  /** 읽지 못해 확인하지 못한 규칙 — 화면은 「셀 수 없음」으로 적는다 */
  unknown: string[] };

export type ConsoleTaskBoard = {
  /** 이 목록을 만든 시각(마지막 확인) */
  checkedAt: string;
  groups: ConsoleTaskGroup[];
  total: number;
  /** 흐름 표가 같은 판정을 쓰게 — 멈춤으로 올린 칸(StationKey)과 쌓임으로 올린 공개 뒤 단계(진행 단계 열쇠) */
  marks: { stopped: string[]; piling: string[] };
};

// ── 입력 ───────────────────────────────────────────────────────────────────────────────────────────────

/** 워커 진행(readWorkerProgress) 단계 — 쓰는 칸만 */
export type ConsoleProgressStage = {
  stage: string; job?: string | null; reason: string; alarm?: boolean; waiting?: number | null; oldestMinutes?: number | null;
  completed5m?: number | null;
  /** 막 끝난 틱이 일을 모두 건너뛴 까닭(worker-progress-query 의 StageSkipDetail) */
  skipBlock?: { reason: string; code: string; detail: string | null } | null;
};
export type ConsoleProgress = { stages: readonly ConsoleProgressStage[]; liveness?: readonly { role: string; reason: string }[] };
/** listJobStates — 사람이 멈췄는가(isPausedJob)와 마지막 실행 */
export type ConsoleJob = { name: string; paused: boolean; lastRunAt: string | null; notBefore?: string | null };
/** listAiConnections 의 쓰는 칸 — models 는 서버 목록·직접 적은 모델·CLI 모델을 합친 것 */
export type ConsoleConnection = {
  id: string; label: string; kind: "api" | "cli"; cliTool: string | null; deviceId: string; capacitySlots: number; enabled: boolean;
  models: readonly string[]; allowedTasks: readonly string[]; keySetAt: string | null; keyValidDays: number | null; updatedAt: string;
};
export type ConsoleRank = { task: string; slot: number; rank: number; connectionId: string; model: string; enabled: boolean };
/** 작업 분산(workload_pool)으로 묶은 구성원 */
export type ConsolePoolMember = { task: string; slot: number; connectionId: string; model: string };
/** 장비 점유(readAdminModelsObservation devices) */
export type ConsoleDevice = { deviceId: string; active: number; models: readonly { model: string; active: number }[] };
/** 24시간 장부(model_capacity_requests) — route·장비·모델로 묶은 것 */
export type ConsoleLedgerRow = { routeId: string; groupId: string; model: string; calls: number; settled: number; avgSeconds: number | null; noResult: number };
/**
 * 조각 1c(바꾼 것 지켜보기)가 넣는 입력 자리 — 바꾼 것 하나와 그 앞뒤의 시간당 처리.
 * 규칙(바꾼 뒤 처리량이 바꾸기 전보다 떨어짐)은 여기서 판정한다.
 */
export type ConsoleChangeDrop = { key: string; label: string; changedAt: string; beforePerHour: number; afterPerHour: number; undoHref?: string | null };

export type ConsoleTaskInputs = {
  now: string;
  conveyor: Pick<Conveyor, "stations" | "human" | "holdsByReason"> | null;
  progress: ConsoleProgress | null;
  jobs: readonly ConsoleJob[] | null;
  /** 모델 접수(model_capacity_control) — 상태와 바뀐 때 */
  admission: { mode: "open" | "draining" | "disabled"; since: string | null } | null;
  /** 오늘 할 일(sharedInbox)의 내림 요청 칸 */
  takedown: { count: number; overdue: number } | null;
  /** 두 모델이 같은 결론을 낸 사람 몫(sharedHumanQueueOverview.agreed — 오늘 할 일의 「확정 필요」와 같은 수) */
  agreed: { approve: number; reject: number } | null;
  /** 감사 거절 적체(openBacklogStats) */
  audit: { open: number; overdue: number; oldestWaitDays: number | null } | null;
  connections: readonly ConsoleConnection[] | null;
  ranks: readonly ConsoleRank[] | null;
  pools: readonly ConsolePoolMember[] | null;
  devices: readonly ConsoleDevice[] | null;
  ledger: readonly ConsoleLedgerRow[] | null;
  /** 조각 1c 가 채운다. 넣지 않으면(undefined) 이 규칙을 보지 않고, null 이면 「셀 수 없음」 */
  changeDrops?: readonly ConsoleChangeDrop[] | null;
  /** 시험용 — 기본은 AI_TASKS */
  tasks?: readonly AiTaskDef[];
};

// ── 글자 ───────────────────────────────────────────────────────────────────────────────────────────────

export const formatCount = (value: number) => Math.round(value).toLocaleString("ko-KR");

/** 분 → 「8시간 2분」「5.7일」(시안 dur 와 같은 끊음) */
export function formatDuration(minutes: number): string {
  if (minutes < 1) return "1분 미만";
  if (minutes < 60) return `${Math.floor(minutes)}분`;
  if (minutes < 2880) {
    const hours = Math.floor(minutes / 60), rest = Math.floor(minutes % 60);
    return rest >= 1 ? `${hours}시간 ${rest}분` : `${hours}시간`;
  }
  const days = minutes / 1440;
  return days >= 10 ? `${Math.round(days)}일` : `${days.toFixed(1)}일`;
}

/** 지금 속도로 걸리는 날 — 10일부터는 정수 */
export const formatDays = (days: number) => days >= 10 ? `${Math.round(days)}일` : `${days.toFixed(1)}일`;

/** 사용률(0~1) → 「1%」「1% 미만」 */
export function formatShare(value: number, calls: number): string {
  if (!calls) return "0%";
  const percent = value * 100;
  return percent > 0 && percent < 1 ? "1% 미만" : `${Math.round(percent)}%`;
}

const KST = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
/** KST 「11-12 07:07」, 날짜만이면 「11-12」 */
export function formatKst(value: string | number, dateOnly = false): string {
  const parts = Object.fromEntries(KST.formatToParts(new Date(value)).map(part => [part.type, part.value]));
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return dateOnly ? `${parts.month}-${parts.day}` : `${parts.month}-${parts.day} ${hour}:${parts.minute}`;
}
export function formatKstTime(value: string | number): string {
  return formatKst(value).slice(6);
}

/** 이름 끝소리 — 한글은 받침, 숫자는 읽는 소리, 영문은 대략의 발음(L·M·N·R 로 끝나는 머리글자, -m·-n·-l·-ng, -me·-ne·-le) */
function endsWithConsonant(word: string): boolean {
  const text = word.trim().replace(/[\s)\]」』"'.,·]+$/u, "");
  const last = text.at(-1);
  if (!last) return false;
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (/[0-9]/.test(last)) return "013678".includes(last);
  const latin = /[A-Za-z]+$/.exec(text)?.[0];
  if (!latin) return false;
  if (latin.length <= 3 && latin === latin.toUpperCase()) return "LMNR".includes(latin.at(-1)!);
  return /(ng|m|n|l)$/i.test(latin) || /(m|n|l)e$/i.test(latin);
}
/** 조사 붙이기 — josa("gpu3090-qwen", "은/는") → 「gpu3090-qwen은」 */
export function josa(word: string, pair: "이/가" | "을/를" | "은/는"): string {
  const [withFinal, withoutFinal] = pair.split("/");
  return `${word}${endsWithConsonant(word) ? withFinal : withoutFinal}`;
}

/** 공개 뒤·진행 단계 이름 — 시안의 말(공개 번역 등). 없는 열쇠는 작업 이름으로 */
export const CONSOLE_STAGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  fetch: "원본 수집", judge: "규칙 심사", first: "AI 1차", second: "AI 2차", publish: "발행",
  evidence: "공개 근거", "agent-evidence": "개발 AI 근거", "ai-level": "AI 단계", uptime: "응답 점검",
  "crawl-tagline": "소개 짓기", keywords: "키워드 짓기", "keyword-verify": "키워드 검수",
  "product-translate": "공개 번역", "reason-translate": "사유 번역", "tagline-ko": "한국어 소개", "intro-check": "소개 검수",
});

/** 「단계 열기」가 여는 지금의 단계 상세(흐름 상세 탭의 선택한 단계·모델 순위 서랍). 단계 패널(조각 ②)이 생기면 바꾼다 */
export const consoleStageHref = (station: string) => `/admin/flow?tab=detail&stage=${encodeURIComponent(station)}#prototype-selected-stage`;
const jobHref = (job: string) => `/admin/status?tab=jobs&job=${encodeURIComponent(job)}`;
const connectionHref = (id: string) => `/admin/models/llm?edit=${encodeURIComponent(id)}#conn-${encodeURIComponent(id)}`;
const taskHref = (task: string, slot = 1) => `/admin/models/tasks#execution-${task}-${slot}`;
const link = (label: string, href: string): ConsoleAction => ({ kind: "link", label, href });

/** 보류 사유가 생긴 칸 → 심사 큐의 그 칸(심사 큐 ?cause= 가 없는 사유) */
const HOLD_FALLBACK_HREF: Readonly<Record<string, string>> = {
  judge: "/admin/review?tab=all&stage=judge", first: "/admin/review?tab=all&stage=ai", second: "/admin/review?tab=all&stage=second",
  profile: "/admin/review?tab=publish&stage=publish", publish: "/admin/review?tab=publish&stage=publish", human: "/admin/review?tab=human",
};

/** 멈춤(1시간 처리 비율)을 보는 칸 — 일감 줄(worker 대기)이 있는 칸만. 프로필 준비의 대기는 보류·재분류 수라 빼고, 키워드 등록은 쌓임 규칙이 본다 */
const QUEUE_STATIONS = new Set(["fetch", "judge", "first", "second", "publish"]);

/** 워커가 틱마다 건너뛴 까닭(agent_review_all_skipped 의 detail 「running=2」) — 알려진 열쇠만 쉬운 말로 */
const SKIP_LABELS: Readonly<Record<string, string>> = { running: "「이미 처리 중」으로" };
function skipSentence(skip: NonNullable<ConsoleProgressStage["skipBlock"]>): string {
  if (skip.reason === "key_missing") return "모든 순위의 연결에 키가 없어 워커가 틱마다 건너뜁니다.";
  const pairs = [...(skip.detail ?? "").matchAll(/([a-z_]+)=(\d+)/g)];
  if (!pairs.length) return `워커가 틱마다 후보를 모두 건너뛰고 끝납니다(${skip.code}).`;
  const parts = pairs.map(([, key, count]) => `${formatCount(Number(count))}건을 ${SKIP_LABELS[key] ?? `「${key}」(으)로`}`);
  return `워커가 틱마다 후보 ${parts.join(", ")} 건너뛰고 끝납니다.`;
}

// ── 모델 계산 ──────────────────────────────────────────────────────────────────────────────────────────

type ModelStat = {
  connection: ConsoleConnection;
  /** 24시간 장부 — 못 읽었으면 null */
  calls: number | null; settled: number | null; noResult: number | null;
  /** 24시간 사용률(0~1) — 호출 시간 합 ÷ (86,400초 × 동시 한도) */
  utilization: number | null;
  /** 지금 쓰는 칸 — 장비 관측을 못 읽었으면 null */
  active: number | null;
  /** 이 모델을 순위·작업 분산에 둔 작업 */
  tasks: Set<string>;
};

function modelStats(inputs: ConsoleTaskInputs): Map<string, ModelStat> {
  const stats = new Map<string, ModelStat>();
  for (const connection of inputs.connections ?? []) {
    const used = [...(inputs.ranks ?? []).filter(row => row.connectionId === connection.id && row.enabled),
      ...(inputs.pools ?? []).filter(row => row.connectionId === connection.id)];
    const models = new Set([...connection.models, ...used.map(row => row.model)]);
    const rows = inputs.ledger?.filter(row => row.groupId === connection.deviceId && models.has(row.model)) ?? null;
    const seconds = rows?.reduce((total, row) => total + (row.avgSeconds ?? 0) * row.settled, 0) ?? null;
    const device = inputs.devices?.find(row => row.deviceId === connection.deviceId) ?? null;
    const perModel = device?.models.filter(row => models.has(row.model)) ?? [];
    stats.set(connection.id, {
      connection,
      calls: rows ? rows.reduce((total, row) => total + row.calls, 0) : null,
      settled: rows ? rows.reduce((total, row) => total + row.settled, 0) : null,
      noResult: rows ? rows.reduce((total, row) => total + row.noResult, 0) : null,
      utilization: seconds === null ? null : seconds / (86_400 * Math.max(1, connection.capacitySlots)),
      active: !inputs.devices ? null : !device ? 0 : perModel.length ? perModel.reduce((total, row) => total + row.active, 0) : device.models.length ? 0 : device.active,
      tasks: new Set(used.map(row => row.task)),
    });
  }
  return stats;
}

// ── 규칙 ───────────────────────────────────────────────────────────────────────────────────────────────

export function buildConsoleTasks(inputs: ConsoleTaskInputs): ConsoleTaskBoard {
  const now = Date.parse(inputs.now);
  const tasks = inputs.tasks ?? AI_TASKS;
  const limits = CONSOLE_TASK_LIMITS;
  const groups = Object.fromEntries(CONSOLE_GROUPS.map(group => [group.key, { ...group, tasks: [] as ConsoleTask[], unknown: [] as string[] }])) as
    Record<ConsoleGroupKey, ConsoleTaskGroup>;
  const add = (group: ConsoleGroupKey, task: Omit<ConsoleTask, "group" | "notify" | "tone"> & { tone?: ConsoleTask["tone"] }) =>
    groups[group].tasks.push({ tone: group === "stop" ? "bad" : group === "tidy" ? "off" : "warn", ...task, group, notify: groups[group].notify });
  const unknown = (group: ConsoleGroupKey, what: string) => { if (!groups[group].unknown.includes(what)) groups[group].unknown.push(what); };

  const stats = modelStats(inputs);
  const pausedJobs = new Set((inputs.jobs ?? []).filter(job => job.paused).map(job => job.name));
  const taskDef = (id: string) => tasks.find(task => task.id === id) ?? null;
  /** 진행 단계의 잡을 맡는 AI 작업(장부 route 가 있는 첫 작업) */
  const taskForJob = (job: string | null | undefined) => job ? tasks.find(task => task.routeId && task.jobs.includes(job)) ?? null : null;
  const taskPaused = (id: string) => { const def = taskDef(id); return !!def && def.jobs.length > 0 && def.jobs.every(job => pausedJobs.has(job)); };
  const progressOf = (stage: string) => inputs.progress?.stages.find(row => row.stage === stage) ?? null;
  const name = (stat: ModelStat) => stat.connection.label;

  /** 남는 모델 — 24시간 사용률 5% 미만, 자주 거절하지 않고, 쓰는 단계가 모두 멈춰 비어 있는 것도 아닌 켜진 모델. 그 작업이 받는 것만, 이미 그 작업에 있는 것은 뺀다 */
  const idleFor = (taskId: string) => {
    const def = taskDef(taskId);
    return [...stats.values()].filter(stat => stat.connection.enabled && stat.utilization !== null && stat.utilization < limits.idleUtilization
      && (stat.noResult ?? 0) < limits.noResultPerDay && !(stat.tasks.size > 0 && [...stat.tasks].every(taskPaused))
      && !stat.tasks.has(taskId) && (!def || aiTaskAccepts(def, stat.connection)))
      .sort((a, b) => b.connection.capacitySlots - a.connection.capacitySlots || a.utilization! - b.utilization! || name(a).localeCompare(name(b)));
  };
  const idleText = (taskId: string) => {
    const idle = idleFor(taskId);
    return idle.length ? `남는 모델: ${idle.map(stat => `${name(stat)}(${formatShare(stat.utilization!, stat.calls ?? 0)})`).join(" · ")}` : null;
  };
  const rankStats = (taskId: string) => {
    const seen = new Set<string>();
    return (inputs.ranks ?? []).filter(row => row.task === taskId && row.enabled).sort((a, b) => a.slot - b.slot || a.rank - b.rank)
      .flatMap(row => { if (seen.has(row.connectionId)) return []; seen.add(row.connectionId); const stat = stats.get(row.connectionId); return stat ? [stat] : []; });
  };

  // ── 멈춤 1: 대기가 있는데 1시간 처리가 대기의 1/10 미만인 단계
  const stopped: string[] = [];
  if (!inputs.conveyor) unknown("stop", "단계 처리");
  for (const station of inputs.conveyor?.stations ?? []) {
    if (!QUEUE_STATIONS.has(station.key) || !station.waiting) continue;
    const progress = progressOf(station.key);
    // 사람이 멈춘 잡의 칸은 「멈춘 작업」 규칙이 맡는다(하루가 지나면)
    if (progress?.reason === "paused" || (progress?.job && pausedJobs.has(progress.job))) continue;
    const perHour = station.doneHour ?? (station.done5m !== null ? station.done5m * 12 : null);
    if (perHour === null) { unknown("stop", `${station.label} 처리 수`); continue; }
    if (perHour >= station.waiting * limits.stalledRatio) continue;
    const def = taskForJob(progress?.job);
    const free = def ? rankStats(def.id).filter(stat => stat.active === 0)
      .map(stat => `${josa(name(stat), "은/는")} ${stat.connection.capacitySlots}칸이 모두 비어 있습니다.`) : [];
    const why = [progress?.skipBlock ? skipSentence(progress.skipBlock) : null, ...free].filter(Boolean).join(" ");
    stopped.push(station.key);
    add("stop", {
      id: `stop:stage:${station.key}`, rule: "stage-stalled",
      title: `${josa(station.label, "이/가")} ${perHour === 0 ? "멈췄습니다" : "거의 멈췄습니다"}`,
      fact: [`대기 ${formatCount(station.waiting)}건`, station.oldestMinutes !== null ? `가장 오래된 것 ${formatDuration(station.oldestMinutes)}` : null,
        station.doneHour !== null ? `최근 1시간 ${formatCount(station.doneHour)}건` : `최근 5분 ${formatCount(station.done5m ?? 0)}건`].filter(Boolean).join(" · "),
      why: why || null, actions: [link("단계 열기", consoleStageHref(station.key))],
    });
  }

  // ── 멈춤 2: 사람이 멈춘 작업이 하루를 넘김
  if (!inputs.jobs) unknown("stop", "멈춘 작업");
  const jobLabel = (job: string) => {
    const stage = inputs.progress?.stages.find(row => row.job === job);
    return (stage && CONSOLE_STAGE_LABELS[stage.stage]) ?? tasks.find(task => task.jobs.includes(job))?.label ?? job;
  };
  const pausedRows = (inputs.jobs ?? []).filter(job => job.paused).map(job => ({ job, since: job.lastRunAt ? Date.parse(job.lastRunAt) : null }))
    .filter(row => row.since === null || now - row.since > limits.pausedJobMs)
    .sort((a, b) => (a.since ?? -Infinity) - (b.since ?? -Infinity) || a.job.name.localeCompare(b.job.name));
  for (const { job, since } of pausedRows) {
    const label = jobLabel(job.name);
    const waiting = inputs.progress?.stages.find(row => row.job === job.name)?.waiting;
    add("stop", {
      id: `stop:job:${job.name}`, rule: "job-paused",
      title: since === null ? `${josa(label, "이/가")} 멈춰 있습니다` : `${josa(label, "이/가")} ${Math.floor((now - since) / DAY)}일째 멈춰 있습니다`,
      fact: [typeof waiting === "number" ? `대기 ${formatCount(waiting)}건` : null, "사람이 멈춤", since === null ? "마지막 실행 기록 없음" : null].filter(Boolean).join(" · "),
      why: null,
      actions: [{ kind: "job-resume", label: "재개", job: job.name, fallbackHref: jobHref(job.name) }, link("작업 보기", jobHref(job.name))],
    });
  }

  // ── 멈춤 3: 접수 중단이 30분을 넘김(DRAIN). 다시 여는 것은 사람이 모델 화면의 접수 제어에서 한다
  if (!inputs.admission) unknown("stop", "접수 상태");
  else if (inputs.admission.mode === "draining") {
    const since = inputs.admission.since ? Date.parse(inputs.admission.since) : NaN;
    if (!Number.isFinite(since)) unknown("stop", "접수 중단 시각");
    else if (now - since > limits.admissionPausedMs) add("stop", {
      id: "stop:admission", rule: "admission-paused",
      title: `접수가 ${formatDuration((now - since) / MINUTE)}째 멈춰 있습니다`,
      fact: `모델 접수 중단 · ${formatKst(since)}부터`, why: null, actions: [link("접수 열기", "/admin/models")],
    });
  }

  // ── 멈춤 4: 내림 요청이 24시간을 넘김
  if (!inputs.takedown) unknown("stop", "내림 요청");
  else if (inputs.takedown.overdue > 0) add("stop", {
    id: "stop:takedown", rule: "takedown-overdue", title: `내림 요청이 ${limits.takedownHours}시간을 넘겼습니다`,
    fact: `요청 ${formatCount(inputs.takedown.count)}건 · ${limits.takedownHours}시간 넘은 것 ${formatCount(inputs.takedown.overdue)}건`, why: null,
    actions: [link("요청 열기", "/admin/requests?tab=correction&kind=takedown")],
  });

  // ── 평소와 다름 1: 보류 사유 하나가 24시간에 50건 넘게 늘고, 그 사유의 절반 이상이 새것
  if (!inputs.conveyor) unknown("odd", "보류 사유");
  for (const hold of inputs.conveyor?.holdsByReason ?? []) {
    const recent = hold.recent24h ?? 0;
    if (!(recent > limits.holdSurge && recent >= hold.count * limits.holdNewShare)) continue;
    const where = hold.station === "human" ? "사람 확인" : inputs.conveyor!.stations.find(station => station.key === hold.station)?.label ?? hold.station;
    const before = hold.count - recent;
    add("odd", {
      id: `odd:hold:${hold.reason}`, rule: "hold-surge", title: `${where} 보류가 갑자기 늘었습니다`,
      fact: `${hold.label} · 24시간 +${formatCount(recent)}건 · 누적 ${formatCount(hold.count)}건`,
      why: `${before * 10 <= recent ? "어제까지는 거의 없던 보류입니다." : "누적의 절반 넘게 최근 24시간에 생겼습니다."} 어제 들어간 변경과 나란히 볼 것.`,
      actions: [link("보류 보기", hold.href ?? HOLD_FALLBACK_HREF[hold.station] ?? "/admin/review"), link("기록 보기", "/admin/activity")],
    });
  }

  // ── 평소와 다름 2: 바꾼 뒤 처리량이 바꾸기 전보다 떨어짐 — 입력은 조각 1c(바꾼 것 지켜보기)가 넣는다
  if (inputs.changeDrops === null) unknown("odd", "바꾼 뒤 처리량");
  for (const drop of inputs.changeDrops ?? []) {
    if (!(drop.afterPerHour < drop.beforePerHour)) continue;
    add("odd", {
      id: `odd:change:${drop.key}`, rule: "change-drop", title: `${drop.label} 뒤 처리가 줄었습니다`,
      fact: `${formatKst(drop.changedAt)} 바꿈 · 바꾸기 전 시간당 ${formatCount(drop.beforePerHour)}건 → 지금 ${formatCount(drop.afterPerHour)}건`, why: null,
      actions: [...(drop.undoHref ? [link("되돌리기", drop.undoHref)] : []), link("기록 보기", "/admin/activity")],
    });
  }

  // ── 쌓임 1: 지금 속도(24시간 정산 수)로 3일 넘게 걸리는 단계 — 오래 걸리는 순
  const piling: string[] = [];
  if (!inputs.progress) unknown("pile", "단계 대기");
  else if (!inputs.ledger) unknown("pile", "지금 속도(24시간 장부)");
  else {
    const eta: (ConsoleTask & { days: number })[] = [];
    for (const stage of inputs.progress.stages) {
      const waiting = stage.waiting ?? 0;
      if (waiting <= 0 || stopped.includes(stage.stage) || stage.reason === "paused" || (stage.job && pausedJobs.has(stage.job))) continue;
      const def = taskForJob(stage.job);
      if (!def?.routeId) continue;
      const settled = inputs.ledger.filter(row => row.routeId === def.routeId).reduce((total, row) => total + row.settled, 0);
      const days = settled > 0 ? waiting / settled : Infinity;
      if (days <= limits.backlogDays) continue;
      const label = CONSOLE_STAGE_LABELS[stage.stage] ?? def.label;
      const models = rankStats(def.id);
      const why = [models.length === 1 ? `쓰는 모델이 ${name(models[0])} 하나입니다.` : null, idleText(def.id)].filter(Boolean).join(" ");
      piling.push(stage.stage);
      eta.push({
        id: `pile:stage:${stage.stage}`, group: "pile", rule: "backlog-eta", tone: "warn", notify: groups.pile.notify, days, stageTask: def.id,
        title: `${josa(label, "이/가")} 쌓입니다`,
        fact: settled > 0 ? `대기 ${formatCount(waiting)}건 · 하루 ${formatCount(settled)}건 처리 · 지금 속도로 ${formatDays(days)}`
          : `대기 ${formatCount(waiting)}건 · 24시간 처리 0건 · 지금 속도로는 줄지 않음`,
        why: why || null, actions: [link("모델 붙이기", taskHref(def.id))],
      });
    }
    groups.pile.tasks.push(...eta.sort((a, b) => b.days - a.days));
  }

  // ── 쌓임 2: 사람 확인 500건 초과, 또는 감사 거절이 7일 넘음
  const human = inputs.conveyor?.human ?? null;
  if (!human) unknown("pile", "사람 확인");
  else if (human.waiting > limits.humanWaiting) {
    const agreedTotal = inputs.agreed ? inputs.agreed.approve + inputs.agreed.reject : human.agreed;
    const agreedText = !agreedTotal ? null : !inputs.agreed ? `두 모델이 같은 결론을 낸 ${formatCount(agreedTotal)}건`
      : inputs.agreed.reject === 0 ? `두 모델이 모두 승인한 ${formatCount(agreedTotal)}건` : inputs.agreed.approve === 0 ? `두 모델이 모두 거절한 ${formatCount(agreedTotal)}건`
      : `두 모델이 같은 결론을 낸 ${formatCount(agreedTotal)}건(승인 ${formatCount(inputs.agreed.approve)} · 거절 ${formatCount(inputs.agreed.reject)})`;
    add("pile", {
      id: "pile:human", rule: "human-or-audit", title: "사람 확인이 줄지 않습니다",
      fact: [`대기 ${formatCount(human.waiting)}건`, human.oldestDays !== null ? `가장 오래된 것 ${formatCount(human.oldestDays)}일` : null,
        human.decided24h !== null ? `24시간 동안 사람이 끝낸 것 ${formatCount(human.decided24h)}건` : null].filter(Boolean).join(" · "),
      why: agreedText ? `${agreedText}은 표본만 보고 한 번에 끝낼 수 있습니다.` : null,
      actions: [link("묶음 보기", agreedTotal ? "/admin/review?tab=human&stage=agreed" : "/admin/review?tab=human")],
    });
  }
  if (!inputs.audit) unknown("pile", "감사 거절");
  else if (inputs.audit.overdue > 0) add("pile", {
    id: "pile:audit", rule: "human-or-audit", title: "감사 거절이 쌓여 있습니다",
    fact: [`열린 거절 ${formatCount(inputs.audit.open)}건`, `${limits.auditOverdueDays}일 넘은 것 ${formatCount(inputs.audit.overdue)}건`,
      inputs.audit.oldestWaitDays !== null ? `가장 오래된 것 ${formatCount(inputs.audit.oldestWaitDays)}일` : null].filter(Boolean).join(" · "),
    why: null, actions: [link("묶음 보기", "/admin/audit")],
  });

  // ── 정리 1: 결과 없이 끝난 호출이 하루 10건 이상인 모델
  if (!inputs.connections) unknown("tidy", "모델 목록");
  else if (!inputs.ledger) unknown("tidy", "결과 없이 끝난 호출(24시간 장부)");
  for (const stat of stats.values()) {
    if (!stat.connection.enabled || stat.noResult === null || stat.noResult < limits.noResultPerDay) continue;
    add("tidy", {
      id: `tidy:no-result:${stat.connection.id}`, rule: "no-result", title: `${josa(name(stat), "이/가")} 자주 거절합니다`,
      fact: `24시간 ${formatCount(stat.calls ?? 0)}건 중 ${formatCount(stat.noResult)}건이 결과 없이 끝남`, why: null,
      actions: [link("쉬게 하기", connectionHref(stat.connection.id))],
    });
  }

  // ── 정리 2: 쓰는 단계가 없는 모델 · 순위에 같은 모델이 두 번
  if (inputs.connections && (!inputs.ranks || !inputs.pools)) unknown("tidy", "모델을 쓰는 단계");
  else if (inputs.connections) for (const stat of stats.values()) {
    if (!stat.connection.enabled || stat.tasks.size) continue;
    add("tidy", {
      id: `tidy:unused:${stat.connection.id}`, rule: "unused-or-duplicate", title: `${josa(name(stat), "을/를")} 아직 안 씁니다`,
      fact: [`${formatKst(stat.connection.updatedAt)} 저장`, stat.calls === null ? "호출 셀 수 없음" : `호출 ${formatCount(stat.calls)}건`, "쓰는 단계 없음"].join(" · "),
      why: null, actions: [link("단계에 붙이기", "/admin/models/tasks")],
    });
  }
  if (inputs.ranks) {
    const repeats: { task: string; slot: number; text: string }[] = [];
    const slots = new Map<string, ConsoleRank[]>();
    for (const row of inputs.ranks) if (row.enabled) slots.set(`${row.task}#${row.slot}`, [...(slots.get(`${row.task}#${row.slot}`) ?? []), row]);
    for (const rows of slots.values()) {
      const byModel = new Map<string, number[]>();
      for (const row of rows) byModel.set(`${row.connectionId}\u0000${row.model}`, [...(byModel.get(`${row.connectionId}\u0000${row.model}`) ?? []), row.rank]);
      const twice = [...byModel.values()].filter(ranks => ranks.length > 1);
      if (!twice.length) continue;
      const def = taskDef(rows[0].task);
      const label = `${def?.label ?? rows[0].task}${def && def.slots > 1 ? ` ${def.slotLabel ?? "칸"} ${rows[0].slot}` : ""}`;
      repeats.push({ task: rows[0].task, slot: rows[0].slot, text: twice.map(ranks => `${label}(${ranks.sort((a, b) => a - b).join("·")}순위)`).join(" · ") });
    }
    if (repeats.length) add("tidy", {
      id: "tidy:duplicate-ranks", rule: "unused-or-duplicate", title: "순위에 같은 모델이 두 번 들어 있습니다",
      fact: repeats.map(row => row.text).join(" · "), why: "같은 모델을 다시 부르는 순위는 앞 순위가 못 할 때 대신하지 못합니다.",
      actions: [link("순위 고치기", taskHref(repeats[0].task, repeats[0].slot))],
    });
  }

  // ── 정리 3: 키 만료 7일 전
  for (const stat of stats.values()) {
    const { keySetAt, keyValidDays, enabled } = stat.connection;
    if (!enabled || !keySetAt || !keyValidDays) continue;
    const expires = Date.parse(keySetAt) + keyValidDays * DAY;
    if (!Number.isFinite(expires) || expires - now > limits.keyExpiryDays * DAY) continue;
    add("tidy", {
      id: `tidy:key:${stat.connection.id}`, rule: "key-expiry",
      title: expires > now ? `${name(stat)} 키가 ${Math.ceil((expires - now) / DAY)}일 뒤 만료됩니다` : `${name(stat)} 키가 만료됐습니다`,
      fact: `${formatKst(keySetAt, true)} 넣음 · ${formatKst(expires, true)} 만료`, why: null, actions: [link("키 바꾸기", connectionHref(stat.connection.id))],
    });
  }

  const list = CONSOLE_GROUPS.map(group => groups[group.key]);
  return { checkedAt: inputs.now, groups: list, total: list.reduce((total, group) => total + group.tasks.length, 0), marks: { stopped, piling } };
}
