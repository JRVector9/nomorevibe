import "server-only";
import { and, desc, eq, gt, gte, inArray, like, lt, or, sql, type SQL } from "drizzle-orm";
import { sharedStore } from "@/lib/cache/shared";
import { db, onReplica } from "@/lib/db";
import { aiConnections, aiTaskExecutionConfigs, aiTaskModels, aiTaskPoolMembers, modelCapacityRequests, operationsAudit } from "@/lib/db/schema";
import { formatListTime } from "@/lib/format/time";
import { aiAssistRouteId, aiTask, aiTaskSlotLabel, AI_TASKS, AUDIT_DIRECT_ROUTE, type AiTaskDef } from "@/lib/llm/ai-tasks";
import { CHANGE_ACTIONS, CHANGE_UNDO, type DeskUndo } from "./operator-desk-model";
import { JOB_CALL_ROUTES, JOB_LABELS, runtimeSettingLabel } from "./runtime-settings-schema";
import { sharedLoader } from "./shared-cache";
import { aiModelDisplayName } from "./admin-ai-tasks";
import { readConsoleProgress } from "./console-progress-read";

/**
 * 바꾼 것 지켜보기(운영 콘솔 개편 조각 1c, 2026-11-12 최종 시안 「홈 · 바꾼 것 지켜보기」·「기록 · 그 뒤」).
 *
 * 운영자가 설정을 바꾸면 그 단계(용량 장부 route)의 처리량을 바꾸기 전과 뒤로 대신 견준다. 읽기만 한다:
 * - 변경: 작업 로그(operations_audit)의 최근 24시간 성공 줄 — 「최근 바뀐 설정」(operator-desk-model CHANGE_ACTIONS)과 작업 로그의 「설정·연결」 갈래에서
 *   값을 바꾸는 것, 그리고 모델 접수 중단·열림. 자동 처리자(모델·잡·system:)의 줄은 뺀다.
 * - 처리량: 용량 장부(model_capacity_requests)의 settled 수를 5분 칸으로 센다(settled_at 부분 색인 — 바꾸기 전 6시간 + 24시간 범위, 영향받는 route 만).
 * - 판정은 순수 함수(judgeChange)다. 기준값은 CHANGE_WATCH_RULES 한곳에 있다.
 *
 * 「다시 떨어짐」·「나빠짐」은 홈 할 일 「평소와 다름」의 외부 입력으로 내보낸다(changeWatchTasks — 규칙 엔진은 조각 1b).
 *
 * 잘못된 경고를 막는 규칙(2026-11-12 배포 직후 운영 실측 — 평소와 다름 11건 중 10건이 이 표의 잘못된 경고였다):
 * - 잡 멈춤 → 재개 한 쌍은 한 줄(걸린 분)로 합치고 견주지 않는다 — 재개는 설정 변경이 아니라 원상 복구다(배포 창은 잡 여럿을 같은 분에 멈췄다 재개한다).
 * - 잰 구간(바꾸기 전 6시간·첫 1시간·지금 1시간)이 접수 중단이나 그 단계 잡의 멈춤과 겹치면 겹친 5분 칸을 빼고 시간당으로 고쳐 견주고,
 *   남은 시간이 구간의 절반에 못 미치면 판정하지 않는다(collectOutages · measureChange).
 * - 한 단계에는 가장 최근 변경 하나만 견준다 — 그 뒤 같은 단계에 변경(멈춤·재개 포함)이 있으면 앞의 변경은 「그 뒤 또 바꿈」이다(시간 제한 없음).
 * - 처리가 줄었다는 판정(다시 떨어짐·나빠짐)은 그 단계에 지금 대기가 있을 때만 — 대기 0건이면 「일감 없음」, 대기를 셀 수 없으면 판정 못 함(backlogFromProgress).
 * 화면을 기다리게 하지 않게 웹 여러 대가 1분 나눠 쓰고, 15분 안의 값이면 기다리지 않고 준 뒤 뒤에서 다시 센다(desk.ts 와 같은 sharedLoader).
 */

export const CHANGE_WATCH_RULES = Object.freeze({
  /** 지켜보는 기간(시간) — 이보다 오래된 변경은 읽지 않는다 */
  windowHours: 24,
  /** 바꾸기 전 평균을 내는 시간 */
  beforeHours: 6,
  /** 장부를 이 단위(분)로 묶어 센다 — 창의 경계가 반 칸(2분 30초)까지 어긋날 수 있다 */
  bucketMinutes: 5,
  /** 첫 판정까지(분) — 이 전에는 「세는 중」 */
  earlyMinutes: 10,
  /** 「바꾼 뒤 첫 1시간」(분) */
  firstMinutes: 60,
  /** 늘었다고 보는 비율(바꾸기 전 시간당 평균의 몇 배 이상)과 최소 차이(시간당 건) */
  upRatio: 1.25,
  /** 줄었다고 보는 비율 */
  downRatio: 0.75,
  minDelta: 3,
  /**
   * 잰 구간에서 접수 중단·그 단계 잡의 멈춤과 겹친 5분 칸은 빼고 남은 시간으로 시간당을 고친다 — 남은 시간이 구간의 이 비율(절반) 미만이면 판정하지 않는다.
   * 같은 단계를 그 뒤 또 바꾸면(멈춤·재개 포함, 시간 제한 없음) 앞의 변경은 판정하지 않는다.
   */
  minCoveredShare: 0.5,
  /** 같은 연결의 연달은 저장(분)·연달은 한도 저장(분)은 한 줄로 합친다 */
  mergeConnectionMinutes: 30,
  mergeRuntimeMinutes: 10,
  /** 한 번에 읽는 작업 로그 줄 상한 */
  maxAuditRows: 400,
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BUCKET_MS = CHANGE_WATCH_RULES.bucketMinutes * MINUTE;
const PER_HOUR = 60 / CHANGE_WATCH_RULES.bucketMinutes;

const CAPACITY_MODE_ACTION = "pipeline-control-capacity-mode";
const JOB_CONTROL_ACTIONS: readonly string[] = ["job-pause", "job-resume"];
/**
 * 지켜볼 작업 — 「최근 바뀐 설정」(CHANGE_ACTIONS)에 작업 로그 「설정·연결」 갈래의 값 바꾸기(읽기·시험·확인함은 뺀다)와 접수 중단·열림을 더했다.
 * 확인 못한 호출 닫기(model-capacity-unknown-reviewed)는 설정이 아니라 조치라 뺀다.
 */
export const CHANGE_WATCH_ACTIONS: readonly string[] = Object.freeze([...new Set([
  ...CHANGE_ACTIONS.filter(action => action !== "model-capacity-unknown-reviewed"),
  CAPACITY_MODE_ACTION, "llm-assist-control", "ai-connection-model-hide", "search-model-settings-save", "evidence-settings",
  "ranking-schedule", "ranking-cancel", "github-collector-token-save", "github-collector-enable", "github-collector-disable",
  "github-collector-app-save", "github-collector-app-enable", "github-collector-app-disable",
  // 수집원 추가·고침(조각 4a, lib/crawl/feed-source-store.ts) — 잡 주기 바꾸기는 위의 runtime-settings-save(jobs.<잡>.intervalMs)로 뜬다
  "crawl-source-save",
])]);

export type ChangeVerdict = "better" | "same" | "worse" | "fell_back" | "unused" | "unknown" | "counting";
export const CHANGE_VERDICT_LABELS: Readonly<Record<ChangeVerdict, string>> = Object.freeze({
  better: "좋아짐", same: "그대로", worse: "나빠짐", fell_back: "다시 떨어짐", unused: "아직 안 씀", unknown: "판정 못 함", counting: "세는 중" });
/** 상태 점(StatusDot)의 모양 — 색은 상태에만 쓴다 */
export const CHANGE_VERDICT_TONES: Readonly<Record<ChangeVerdict, "ok" | "failed" | "idle">> = Object.freeze({
  better: "ok", same: "ok", worse: "failed", fell_back: "failed", unused: "idle", unknown: "idle", counting: "idle" });

/** 작업 로그 한 줄(읽은 그대로 — detail 은 큰 칸을 줄여 읽는다) */
export type WatchAuditRow = Readonly<{ id: number; at: string; actor: string; actorKind: string | null; action: string; target: string;
  detail: Readonly<Record<string, unknown>> }>;

export type WatchContext = Readonly<{
  /** 연결 id → 지금 그 연결을 쓰는 작업 id(순위·작업 분산 구성원) */
  connectionTasks: ReadonlyMap<string, readonly string[]>;
  /** 연결 id → 연결 이름(순위 바꿈의 제목) */
  connectionLabels: ReadonlyMap<string, string>;
}>;

/** 지켜볼 변경 하나 — 연달은 저장·접수 중단과 열림은 한 줄로 합쳐 ids 에 모두 싣는다 */
export type WatchChange = Readonly<{
  key: string; ids: readonly number[]; at: string;
  /** 접수 중단 → 다시 열림의 열린 때 */
  until: string | null;
  actor: string; action: string; target: string;
  title: string;
  /** 영향받는 단계 이름 — 정할 수 없으면 null(「—」) */
  stage: string | null;
  routes: readonly string[]; prefixes: readonly string[];
  /** 모델을 저장했는데 그 모델을 쓰는 단계가 없다 */
  noStage: boolean;
  /** 단계를 정하지 못한 까닭(stage 가 null 일 때) */
  why: string | null;
  kind: "capacity" | "pause" | "change";
  /** 원상 복구 — 잡 멈춤 → 재개 한 쌍, 또는 멈춘 때가 읽은 범위 밖인 재개. 처리량을 견주지 않는다 */
  restore: boolean;
}>;

/**
 * 처리를 못 하던 구간 — 접수 중단(모든 단계) 또는 잡 멈춤(그 잡의 단계). 다른 변경의 잰 구간에서 이 시간을 뺀다.
 * 작업 로그의 모든 줄(자동 처리자 포함)에서 읽는다 — 멈춘 때를 모르는 재개·열림은 from 이 -Infinity, 아직 안 끝난 것은 to 가 지금.
 */
export type WatchOutage = Readonly<{ kind: "drain" | "pause"; from: number; to: number; all: boolean; routes: readonly string[]; prefixes: readonly string[];
  ids: readonly number[] }>;

/** 단계(장부 route) → 지금 대기 수(worker progress). 없는 route 는 셀 수 없음 */
export type StageBacklog = ReadonlyMap<string, number>;

export type ChangeMeasure = Readonly<{
  /** 바꾸기 전 6시간의 시간당 평균과 시간별 수(오래된 것부터) */
  beforePerHour: number; beforeHours: readonly number[];
  /** 바꾼 뒤 첫 10분 — 아직 10분이 안 됐으면 null(세는 중) */
  early: number | null;
  /** 바꾼 뒤 첫 1시간 — 아직 1시간이 안 됐으면 null(세는 중) */
  firstHour: number | null;
  /** 지금 최근 1시간 — 첫 1시간이 끝나야 센다 */
  lastHour: number | null;
  /** 바꾼 뒤 지금까지 모두 */
  sinceChange: number;
  /** 접수 중단·그 단계 잡의 멈춤과 겹쳐 뺀 시간(분) — 바꾸기 전 6시간 · 첫 1시간 · 지금 1시간 */
  excluded: Readonly<{ before: number; first: number; last: number }>;
  /** 뺀 시간을 빼고 시간당으로 고친 첫 1시간·지금 1시간(겹친 것이 없으면 firstHour·lastHour 와 같다). beforePerHour 는 처음부터 고친 값이다 */
  firstRate: number | null; lastRate: number | null;
}>;

export type ChangeWatchRow = Readonly<{
  key: string; ids: readonly number[]; at: string; until: string | null; actor: string; action: string; target: string;
  title: string; stage: string | null; kind: WatchChange["kind"];
  /** 영향받는 장부 route(정확히)와 route 머리 — 단계 패널이 「이 단계에 닿은 변경」을 거른다 */
  routes: readonly string[]; prefixes: readonly string[];
  measure: ChangeMeasure | null;
  verdict: ChangeVerdict;
  /** 판정의 까닭(마우스를 올리면 보인다) */
  reason: string | null;
  /** 10분~1시간 사이의 판정 — 첫 10분만 보고 냈다(할 일로 올리지 않는다) */
  provisional: boolean;
  /** 「시간당 17건」 — 단계가 없으면 null */
  beforeText: string | null;
  /** 「첫 1시간 86건 → 지금 3건」 */
  afterText: string;
  /** 접수 중단과 겹친 것 등 판정을 읽을 때 같이 볼 것 */
  notes: readonly string[];
  /** 되돌리는 곳 — 기존 「최근 바뀐 설정」의 되돌리기 안내 그대로(새 쓰기 경로가 없다) */
  undo: DeskUndo | null;
  recordHref: string;
}>;

export type ChangeWatchSnapshot = Readonly<{ measuredAt: string; windowHours: number; rows: readonly ChangeWatchRow[];
  /** 단계 대기(worker progress)를 읽지 못했다 — 줄었다는 판정을 하지 못했으므로 홈 할 일은 「셀 수 없음」이다 */
  waitingUnread?: boolean }>;

/** 홈 할 일 「평소와 다름」의 외부 입력(조각 1b 규칙 엔진이 받는다) */
export type ChangeWatchTask = Readonly<{
  key: string; verdict: "fell_back" | "worse";
  title: string; fact: string; why?: string;
  actions: readonly { label: string; href: string }[];
  notify: boolean;
}>;

// ── 순수: 작업 로그 → 변경 ───────────────────────────────────────────────────────────────────────────

/** 자동 처리자 — 모델·잡이 남긴 줄(actorKind model·system, system:·auto: 처리자). 사람과 운영 도구(jr-claude 등)의 줄만 지켜본다 */
export function isAutomaticActor(actor: string, actorKind: string | null): boolean {
  return actorKind === "model" || actorKind === "system" || /^(system|auto):/i.test(actor);
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === "string" && value ? value : null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 작업 → 장부 route(정확히)와 route 머리(LLM 보강의 local-assist-<일>-) */
function taskRoutes(task: AiTaskDef): { routes: string[]; prefixes: string[] } {
  const routes = task.routeId ? [task.routeId] : [];
  // 「발행분 감사 · 변경 재판정」의 API 순위는 감사 직접 경로(local-audit)로 부른다 — CLI 순위는 product-audit 경로
  if (task.wiring === "audit-direct") routes.push(AUDIT_DIRECT_ROUTE);
  return { routes, prefixes: task.assistWork.map(work => aiAssistRouteId(work, "")) };
}

const tasksWithJob = (job: string) => AI_TASKS.filter(task => task.jobs.includes(job));

/** 실시간 한도의 바뀐 칸(경로) → 그 칸을 쓰는 작업. 경로 이름이 장부 route 와 다른 것(review-gateway 등)은 잡의 호출 경로표(JOB_CALL_ROUTES)로 잇는다 */
export function runtimePathTasks(path: string): AiTaskDef[] {
  const [group, part, name] = path.split(".");
  if (group === "routes" && name) {
    const direct = AI_TASKS.filter(task => task.routeId === name);
    if (direct.length) return direct;
    const jobs = Object.entries(JOB_CALL_ROUTES).filter(([, call]) => call.route === name || call.orRoutes?.includes(name)).map(([job]) => job);
    return AI_TASKS.filter(task => task.jobs.some(job => jobs.includes(job)));
  }
  if ((group === "jobs" || group === "budgets") && part) return tasksWithJob(part);
  if (group === "translation") { const task = aiTask("product-translate"); return task ? [task] : []; }
  return [];
}

function scopeOf(tasks: readonly AiTaskDef[]): { routes: string[]; prefixes: string[] } {
  const routes = new Set<string>(), prefixes = new Set<string>();
  for (const task of tasks) {
    const own = taskRoutes(task);
    own.routes.forEach(route => routes.add(route));
    own.prefixes.forEach(prefix => prefixes.add(prefix));
  }
  return { routes: [...routes].sort(), prefixes: [...prefixes].sort() };
}

const listNames = (names: readonly string[], max = 2) => {
  const unique = [...new Set(names)];
  return unique.length > max ? `${unique.slice(0, max).join(" · ")} 외 ${unique.length - max}` : unique.join(" · ");
};

type RankRow = { rank: number; connectionId: string; model: string };
const rankRows = (value: unknown): RankRow[] => Array.isArray(value)
  ? value.map(record).filter(row => typeof row.rank === "number" && typeof row.connectionId === "string" && typeof row.model === "string")
    .map(row => ({ rank: row.rank as number, connectionId: row.connectionId as string, model: row.model as string })) : [];

/** 순위 저장의 한 줄 제목 — 처음으로 달라진 순위를 적는다(「1차 AI 검수 1순위를 supa로」) */
function rankTitle(stage: string, detail: Readonly<Record<string, unknown>>, labels: ReadonlyMap<string, string>): string {
  if (detail.reason === "unread_records_cleared") return `${stage} 옛 순위 기록 지움`;
  const before = rankRows(detail.before), after = rankRows(detail.after);
  if (!after.length) return `${stage} 순위 비움`;
  const ranks = [...new Set([...before, ...after].map(row => row.rank))].sort((a, b) => a - b);
  const changed = ranks.filter(rank => {
    const was = before.find(row => row.rank === rank), now = after.find(row => row.rank === rank);
    return was?.connectionId !== now?.connectionId || was?.model !== now?.model;
  });
  if (!changed.length) return `${stage} 순위 다시 저장`;
  const rank = changed[0];
  const now = after.find(row => row.rank === rank);
  // 모델은 사용자가 정한 이름으로만 부른다(운영 콘솔 통합) — 서버가 알려 준 모델 이름은 제목에 넣지 않는다(기록의 전·후에 남는다)
  const name = !now ? null : labels.get(now.connectionId) ?? "지워진 연결";
  const head = name ? `${stage} ${rank}순위를 ${name}로` : `${stage} ${rank}순위 뺌`;
  return changed.length > 1 ? `${head} 외 ${changed.length - 1}` : head;
}

const runtimeTitle = (names: readonly string[]) => names.length ? `한도 저장 · ${listNames(names, 1)}` : "한도 저장";
const CAPACITY_TEXT: Record<string, string> = { draining: "접수 중단", open: "접수 열림", disabled: "접수 끔" };
const capacityMode = (row: WatchAuditRow): string | null => text(row.detail.mode) ?? text(record(row.detail.after).mode);
const jobName = (job: string) => JOB_LABELS[job] ?? tasksWithJob(job)[0]?.label ?? job;

type Draft = { -readonly [K in keyof Omit<WatchChange, "key" | "ids">]: WatchChange[K] } & { ids: number[]; names?: string[] };

function draftOf(row: WatchAuditRow, ctx: WatchContext, label: (action: string) => string): Draft {
  const base = { at: row.at, until: null, actor: row.actor, action: row.action, target: row.target, ids: [row.id], kind: "change" as const,
    noStage: false, restore: false, why: null, routes: [] as string[], prefixes: [] as string[], stage: null as string | null };
  const withTasks = (draft: Draft, tasks: readonly AiTaskDef[], stage?: string): Draft => {
    const scope = scopeOf(tasks);
    if (!scope.routes.length && !scope.prefixes.length) return { ...draft, why: tasks.length ? "장부에 남지 않는 단계입니다" : draft.why ?? "영향받는 단계를 정할 수 없습니다" };
    return { ...draft, ...scope, stage: stage ?? listNames(tasks.map(task => task.label)) };
  };
  switch (row.action) {
    case "ai-task-models-save":
    case "ai-task-execution-save": {
      const [id, slotText] = row.target.split("#");
      const task = aiTask(id);
      if (!task) return { ...base, title: `${label(row.action)} · ${row.target}`, why: "모르는 작업입니다" };
      const stage = aiTaskSlotLabel(task, Number(slotText) || 1);
      if (row.action === "ai-task-execution-save") {
        // 시안 흐름 1의 4번 「AI 1차 배정을 「동시에」로」 — 방식 이름은 단계 패널·작업 배정과 같은 말
        const mode = row.detail.mode === "workload_pool" ? "동시에" : "순위대로";
        return withTasks({ ...base, title: `${stage} 배정을 「${mode}」로` }, [task], stage);
      }
      const title = rankTitle(stage, row.detail, ctx.connectionLabels);
      // 실행 쪽이 읽지 않는 옛 순위 행을 지운 것 — 처리에 영향이 없다
      if (row.detail.reason === "unread_records_cleared") return { ...base, title, stage, why: "실행에 영향이 없는 기록 정리입니다" };
      return withTasks({ ...base, title }, [task], stage);
    }
    case "llm-assist-control": {
      const task = aiTask(text(row.detail.aiTask) ?? row.target);
      return task ? withTasks({ ...base, title: `${task.label} 제어 저장` }, [task]) : { ...base, title: `LLM 보강 제어 · ${row.target}`, why: "모르는 작업입니다" };
    }
    case "ai-connection-save": {
      const id = text(row.detail.id);
      // 지금 이름(사용자가 정한 이름)이 있으면 그것 — 저장 때의 이름표는 지운 연결에만 쓴다
      const name = (id ? ctx.connectionLabels.get(id) : undefined) ?? text(row.detail.label) ?? text(record(row.detail.after).label) ?? row.target;
      const title = `모델 ${name} ${row.detail.created ? "추가" : "고침"}${row.detail.keyChanged ? " · 키 바꿈" : ""}`;
      const tasks = (id ? ctx.connectionTasks.get(id) ?? [] : []).map(aiTask).filter((task): task is AiTaskDef => !!task);
      if (!tasks.length) return { ...base, title, noStage: true, why: "이 모델을 쓰는 단계가 없습니다" };
      return withTasks({ ...base, title }, tasks);
    }
    case "runtime-settings-save": {
      const changes = Array.isArray(row.detail.changes) ? row.detail.changes.map(record) : [];
      const paths = changes.map(change => text(change.path)).filter((path): path is string => !!path);
      const names = changes.map(change => text(change.label) ?? (text(change.path) ? runtimeSettingLabel(change.path as string) : null)).filter((name): name is string => !!name);
      return withTasks({ ...base, title: runtimeTitle(names), names }, [...new Set(paths.flatMap(runtimePathTasks))]);
    }
    case "job-pause":
    case "job-resume": {
      const title = `${jobName(row.target)} ${row.action === "job-pause" ? "멈춤" : "재개"}`;
      const draft = { ...base, title, kind: "pause" as const };
      const tasks = tasksWithJob(row.target);
      return tasks.length ? withTasks(draft, tasks) : { ...draft, why: "모델 단계가 아닌 작업입니다" };
    }
    default:
      return { ...base, title: `${label(row.action)} · ${row.target}`, why: "영향받는 단계를 정할 수 없습니다" };
  }
}

/** 두 변경이 같은 단계를 건드리는가(같은 route, 같은 머리, 또는 머리가 route 를 덮음) */
function sameStage(a: Pick<WatchChange, "routes" | "prefixes">, b: Pick<WatchChange, "routes" | "prefixes">): boolean {
  if (a.routes.some(route => b.routes.includes(route)) || a.prefixes.some(prefix => b.prefixes.includes(prefix))) return true;
  return a.prefixes.some(prefix => b.routes.some(route => route.startsWith(prefix))) || b.prefixes.some(prefix => a.routes.some(route => route.startsWith(prefix)));
}

const minutesBetween = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / MINUTE));

/**
 * 작업 로그 줄(오래된 것부터) → 지켜볼 변경. 자동 처리자 줄은 뺀다. 접수 중단 → 다음 접수 줄이 열림이면 한 줄(걸린 분)로,
 * 잡 멈춤 → 그 잡의 다음 제어 줄이 재개이면 한 줄(걸린 분, 원상 복구)로, 같은 사람의 같은 연결 저장(30분)·한도 저장(10분)은 한 줄로 합친다(때는 첫 저장).
 */
export function collectChanges(rows: readonly WatchAuditRow[], ctx: WatchContext, label: (action: string) => string = action => action): WatchChange[] {
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const human = sorted.filter(row => !isAutomaticActor(row.actor, row.actorKind));
  const out: Draft[] = [];
  const used = new Set<number>();
  human.forEach((row, index) => {
    if (used.has(row.id)) return;
    if (JOB_CONTROL_ACTIONS.includes(row.action)) {
      const draft = draftOf(row, ctx, label);
      if (row.action === "job-resume") { out.push({ ...draft, restore: true }); return; }
      // 그 잡의 다음 제어 줄(누가 했든) — 재개이면 멈춤 → 재개 한 줄. 작업 제어는 멈춘 잡만 재개하므로 다음 줄이 곧 짝이다
      const next = sorted.find(other => other.id > row.id && other.target === row.target && JOB_CONTROL_ACTIONS.includes(other.action));
      if (next?.action !== "job-resume") { out.push(draft); return; }
      used.add(next.id);
      const byPerson = !isAutomaticActor(next.actor, next.actorKind);
      out.push({ ...draft, ids: byPerson ? [row.id, next.id] : [row.id], until: next.at, restore: true,
        title: `${jobName(row.target)} 멈춤 → 재개 (${minutesBetween(row.at, next.at)}분)` });
      return;
    }
    if (row.action === CAPACITY_MODE_ACTION) {
      const mode = capacityMode(row);
      const next = mode === "draining" ? human.slice(index + 1).find(other => other.action === CAPACITY_MODE_ACTION) : undefined;
      const base = { at: row.at, actor: row.actor, action: row.action, target: row.target, kind: "capacity" as const, noStage: false,
        routes: [], prefixes: [], stage: null, why: "모든 단계에 걸친 조작이라 단계별로 견주지 않습니다" };
      if (next && capacityMode(next) === "open") {
        used.add(next.id);
        out.push({ ...base, ids: [row.id, next.id], until: next.at, restore: false, title: `접수 중단 → 다시 열림 (${minutesBetween(row.at, next.at)}분)` });
      } else out.push({ ...base, ids: [row.id], until: null, restore: false, title: CAPACITY_TEXT[mode ?? ""] ?? "모델 접수 바꿈" });
      return;
    }
    const draft = draftOf(row, ctx, label);
    const mergeMinutes = row.action === "ai-connection-save" ? CHANGE_WATCH_RULES.mergeConnectionMinutes
      : row.action === "runtime-settings-save" ? CHANGE_WATCH_RULES.mergeRuntimeMinutes : 0;
    const host = mergeMinutes ? [...out].reverse().find(prior => prior.action === row.action && prior.actor === row.actor
      && (row.action === "runtime-settings-save" || prior.target === row.target) && Date.parse(row.at) - Date.parse(prior.at) <= mergeMinutes * MINUTE) : undefined;
    if (!host) { out.push(draft); return; }
    // 연달은 저장 — 때와 제목은 첫 저장(모델 추가 뒤의 고침은 추가 한 줄로), 한도 저장은 바뀐 칸과 단계를 모두 모은다
    host.ids.push(row.id);
    if (row.action === "runtime-settings-save") {
      host.names = [...new Set([...host.names ?? [], ...draft.names ?? []])];
      host.title = runtimeTitle(host.names);
      host.routes = [...new Set([...host.routes, ...draft.routes])].sort();
      host.prefixes = [...new Set([...host.prefixes, ...draft.prefixes])].sort();
      const stages = [host.stage, draft.stage].filter((stage): stage is string => !!stage).flatMap(stage => stage.split(" · "));
      host.stage = stages.length ? listNames(stages) : null;
      if (host.routes.length || host.prefixes.length) host.why = null;
    }
  });
  return out.map(draft => {
    const change: Draft = { ...draft, ids: [...draft.ids] };
    delete change.names;
    return { ...change, key: String(draft.ids[0]) };
  });
}

/**
 * 작업 로그의 모든 줄(자동 처리자 포함, 아무 차례) → 처리를 못 하던 구간. 접수: 중단·끔부터 다음 열림까지(열림 줄의 이전 상태가 중단이면 그 앞은 모름).
 * 잡: 멈춤부터 다음 재개까지(재개만 있으면 그 앞은 모름). 아직 안 끝난 것은 지금까지. 단계가 없는 잡의 멈춤은 뺀다.
 */
export function collectOutages(rows: readonly WatchAuditRow[], nowMs: number): WatchOutage[] {
  const out: WatchOutage[] = [];
  let drain: { from: number; ids: number[] } | null = null;
  const paused = new Map<string, { from: number; ids: number[] }>();
  const jobScope = (job: string) => scopeOf(tasksWithJob(job));
  for (const row of [...rows].sort((a, b) => a.id - b.id)) {
    const at = Date.parse(row.at);
    if (row.action === CAPACITY_MODE_ACTION) {
      const mode = capacityMode(row);
      if (mode === "draining" || mode === "disabled") {
        drain ??= { from: at, ids: [] };
        drain.ids.push(row.id);
      } else if (mode === "open") {
        const before = text(row.detail.beforeMode) ?? text(record(row.detail.before).mode);
        if (drain || before === "draining" || before === "disabled")
          out.push({ kind: "drain", from: drain?.from ?? -Infinity, to: at, all: true, routes: [], prefixes: [], ids: [...drain?.ids ?? [], row.id] });
        drain = null;
      }
      continue;
    }
    if (!JOB_CONTROL_ACTIONS.includes(row.action)) continue;
    const scope = jobScope(row.target);
    if (!scope.routes.length && !scope.prefixes.length) continue;
    const open = paused.get(row.target);
    if (row.action === "job-pause") { if (!open) paused.set(row.target, { from: at, ids: [row.id] }); continue; }
    out.push({ kind: "pause", from: open?.from ?? -Infinity, to: at, all: false, ...scope, ids: [...open?.ids ?? [], row.id] });
    paused.delete(row.target);
  }
  if (drain) out.push({ kind: "drain", from: drain.from, to: nowMs, all: true, routes: [], prefixes: [], ids: drain.ids });
  for (const [job, open] of paused) out.push({ kind: "pause", from: open.from, to: nowMs, all: false, ...jobScope(job), ids: open.ids });
  return out;
}

/** 워커 진행 단계(잡 · 대기) → 그 잡을 맡는 작업의 장부 route 별 대기. 대기를 못 센 단계는 넣지 않는다 */
export function backlogFromProgress(stages: readonly { job?: string | null; waiting?: number | null }[]): StageBacklog {
  const backlog = new Map<string, number>();
  for (const stage of stages) {
    if (!stage.job || typeof stage.waiting !== "number") continue;
    for (const task of tasksWithJob(stage.job)) for (const route of taskRoutes(task).routes) backlog.set(route, (backlog.get(route) ?? 0) + stage.waiting);
  }
  return backlog;
}

// ── 순수: 장부 → 처리량 ─────────────────────────────────────────────────────────────────────────────

/** 장부 한 칸 — route 별 5분 칸(번호 = epoch ms / 5분, 내림)의 settled 수 */
export type LedgerBucket = Readonly<{ route: string; bucket: number; settled: number }>;
type LedgerIndex = ReadonlyMap<string, ReadonlyMap<number, number>>;

export function indexLedger(buckets: readonly LedgerBucket[]): LedgerIndex {
  const index = new Map<string, Map<number, number>>();
  for (const row of buckets) {
    const own = index.get(row.route) ?? new Map<number, number>();
    own.set(row.bucket, (own.get(row.bucket) ?? 0) + row.settled);
    index.set(row.route, own);
  }
  return index;
}

/**
 * 변경을 재는 칸들 — 바꾼 때는 가장 가까운 5분 경계로 맞춘다. 칸 [from, to) 의 합.
 * outages(이 변경의 단계에 걸린 접수 중단·잡 멈춤)와 조금이라도 겹친 칸은 시간당을 낼 때 수와 시간에서 함께 뺀다 — 화면의 건수(beforeHours·firstHour·lastHour)는 그대로 센 값이다.
 */
export function measureChange(change: Pick<WatchChange, "at" | "routes" | "prefixes">, ledger: LedgerIndex, nowMs: number,
  outages: readonly Pick<WatchOutage, "from" | "to">[] = []): ChangeMeasure {
  const own = [...ledger].filter(([route]) => change.routes.includes(route) || change.prefixes.some(prefix => route.startsWith(prefix))).map(([, series]) => series);
  const at = (bucket: number) => own.reduce((total, series) => total + (series.get(bucket) ?? 0), 0);
  const out = (bucket: number) => outages.some(outage => outage.from < (bucket + 1) * BUCKET_MS && outage.to > bucket * BUCKET_MS);
  /** [from, to) — 센 수, 겹치지 않은 칸 수와 그 수 */
  const span = (from: number, to: number) => {
    let sum = 0, clean = 0, cleanSum = 0;
    for (let bucket = from; bucket < to; bucket += 1) {
      const settled = at(bucket);
      sum += settled;
      if (!out(bucket)) { clean += 1; cleanSum += settled; }
    }
    return { sum, cleanSum, clean, excluded: (to - from - clean) * CHANGE_WATCH_RULES.bucketMinutes };
  };
  const perHour = (part: { clean: number; cleanSum: number }) => part.clean ? part.cleanSum / (part.clean / PER_HOUR) : 0;
  const anchor = Math.round(Date.parse(change.at) / BUCKET_MS);
  // 지금 칸(아직 세는 중)은 「다 센 칸」에 넣지 않는다
  const current = Math.floor(nowMs / BUCKET_MS);
  const hours = CHANGE_WATCH_RULES.beforeHours;
  const before = span(anchor - hours * PER_HOUR, anchor);
  const beforeHours = Array.from({ length: hours }, (_, hour) => span(anchor - (hours - hour) * PER_HOUR, anchor - (hours - hour - 1) * PER_HOUR).sum);
  const earlyEnd = anchor + CHANGE_WATCH_RULES.earlyMinutes / CHANGE_WATCH_RULES.bucketMinutes;
  const firstEnd = anchor + CHANGE_WATCH_RULES.firstMinutes / CHANGE_WATCH_RULES.bucketMinutes;
  const first = firstEnd <= current ? span(anchor, firstEnd) : null;
  const last = first ? span(current - PER_HOUR, current) : null;
  return {
    beforePerHour: perHour(before), beforeHours,
    early: earlyEnd <= current ? span(anchor, earlyEnd).sum : null,
    firstHour: first?.sum ?? null,
    lastHour: last?.sum ?? null,
    sinceChange: span(anchor, current + 1).sum,
    excluded: { before: before.excluded, first: first?.excluded ?? 0, last: last?.excluded ?? 0 },
    firstRate: first ? perHour(first) : null, lastRate: last ? perHour(last) : null,
  };
}

export type JudgeFlags = {
  noStage?: boolean;
  /** 그 뒤 같은 단계의 변경(「3시간 뒤 · 키워드 검수 멈춤 → 재개 (14분)」) */
  superseded?: string | null;
  why?: string | null;
  /** 잡 멈춤 → 재개(원상 복구) */
  restore?: boolean;
  /** 그 단계의 지금 대기 — 넣지 않으면(undefined) 보지 않고, null 이면 셀 수 없음 */
  waiting?: number | null;
};

/**
 * 판정 — 좋아짐 / 그대로 / 나빠짐 / 다시 떨어짐(바꾼 직후엔 늘었다가 지금은 바꾸기 전보다 낮거나 비슷) / 아직 안 씀(호출 0) / 판정 못 함 / 세는 중(10분 전).
 * 1시간이 안 됐으면 첫 10분을 시간당으로 늘려 견준다(provisional). 늘었다·줄었다는 비율과 최소 차이를 함께 넘어야 한다 — 작은 수의 흔들림을 판정하지 않는다.
 * 접수 중단·잡 멈춤과 겹친 시간은 뺀 시간당(firstRate·lastRate·beforePerHour)으로 견주고, 구간의 절반 넘게 겹쳤으면 판정하지 않는다.
 * 줄었다(나빠짐·다시 떨어짐)는 그 단계에 지금 대기가 있을 때만이다 — 대기 0건은 「일감 없음」, 셀 수 없으면 판정 못 함.
 */
export function judgeChange(measure: ChangeMeasure | null, flags: JudgeFlags = {}): { verdict: ChangeVerdict; reason: string | null; provisional: boolean } {
  const rules = CHANGE_WATCH_RULES;
  if (flags.noStage) return { verdict: "unused", reason: flags.why ?? "이 모델을 쓰는 단계가 없습니다", provisional: false };
  if (flags.restore) return { verdict: "unknown", reason: "멈췄다 다시 켠 것은 설정 변경이 아니라 원상 복구라 처리량을 견주지 않습니다", provisional: false };
  if (!measure) return { verdict: "unknown", reason: flags.why ?? "영향받는 단계를 정할 수 없습니다", provisional: false };
  if (flags.superseded) return { verdict: "unknown", reason: `그 뒤 같은 단계를 또 바꿨습니다(${flags.superseded}) — 가장 최근 변경에서 봅니다`, provisional: false };
  if (measure.early === null) return { verdict: "counting", reason: `바꾼 지 ${rules.earlyMinutes}분이 안 됐습니다`, provisional: false };
  const before = measure.beforePerHour;
  if (measure.sinceChange === 0 && before === 0) return { verdict: "unused", reason: "바꾸기 전에도 뒤에도 호출이 0건입니다", provisional: false };
  const provisional = measure.firstHour === null;
  // 잰 구간의 절반 넘게 접수 중단·잡 멈춤과 겹쳤으면 남은 시간으로 견주지 않는다
  const limit = (minutes: number) => minutes * (1 - rules.minCoveredShare);
  const short = [
    measure.excluded.before > limit(rules.beforeHours * 60) ? `바꾸기 전 ${rules.beforeHours}시간` : null,
    !provisional && measure.excluded.first > limit(rules.firstMinutes) ? "첫 1시간" : null,
    measure.lastHour !== null && measure.excluded.last > limit(60) ? "지금 1시간" : null,
  ].filter((part): part is string => !!part);
  if (short.length) return { verdict: "unknown", reason: `${short.join(" · ")}의 절반 넘게 접수 중단·작업 멈춤과 겹쳐 견줄 수 없습니다`, provisional };
  const first = measure.firstRate ?? measure.firstHour ?? measure.early * (rules.firstMinutes / rules.earlyMinutes);
  const latest = measure.lastHour === null ? first : measure.lastRate ?? measure.lastHour;
  const up = (value: number) => value >= before * rules.upRatio && value - before >= rules.minDelta;
  const down = (value: number) => value <= before * rules.downRatio && before - value >= rules.minDelta;
  const head = provisional ? `첫 ${rules.earlyMinutes}분으로 본 판정 — ` : "";
  const fell = !provisional && up(first) && !up(latest);
  if (!fell && up(latest)) return { verdict: "better", reason: `${head}바꾸기 전 ${rules.beforeHours}시간 평균보다 많습니다`, provisional };
  if (!fell && !down(latest)) return { verdict: "same", reason: `${head}바꾸기 전과 비슷합니다`, provisional };
  // 줄었다 — 그 단계에 일감이 있을 때만(일감이 없어 준 것은 문제가 아니다)
  if (flags.waiting === 0) return { verdict: "unknown", reason: "일감 없음 — 지금 이 단계의 대기가 0건이라 처리가 준 것을 견주지 않습니다", provisional };
  if (flags.waiting === null) return { verdict: "unknown", reason: "이 단계의 대기를 셀 수 없어 일감이 없어서 준 것인지 가를 수 없습니다", provisional };
  if (fell) return { verdict: "fell_back", reason: "바꾼 직후에는 늘었다가 지금은 바꾸기 전과 비슷하거나 낮습니다", provisional };
  return { verdict: "worse", reason: `${head}바꾸기 전 ${rules.beforeHours}시간 평균보다 적습니다`, provisional };
}

const count = (value: number) => value.toLocaleString("ko-KR");
/** 시간당 평균 — 10건 아래는 소수 한 자리까지 */
export const perHourText = (value: number) => value >= 10 ? count(Math.round(value)) : String(Number(value.toFixed(1)));

/** 「전 → 후」의 두 조각 — 표는 「시간당 17건 → 첫 1시간 86건 → 지금 3건」, 기록의 「그 뒤」는 뒤 조각만 */
export function watchTexts(measure: ChangeMeasure | null, verdict: ChangeVerdict, noStage = false): { beforeText: string | null; afterText: string } {
  if (noStage) return { beforeText: null, afterText: "호출 0건 · 쓰는 단계 없음" };
  if (!measure) return { beforeText: null, afterText: "—" };
  const beforeText = `시간당 ${perHourText(measure.beforePerHour)}건`;
  if (verdict === "unused") return { beforeText: null, afterText: "호출 0건" };
  if (measure.early === null) return { beforeText, afterText: "세는 중" };
  if (measure.firstHour === null) return { beforeText, afterText: `첫 ${CHANGE_WATCH_RULES.earlyMinutes}분 ${count(measure.early)}건 · 1시간 세는 중` };
  return { beforeText, afterText: `첫 1시간 ${count(measure.firstHour)}건 → 지금 ${count(measure.lastHour ?? 0)}건` };
}

/** 「12분」「3시간 5분」 */
const spanText = (minutes: number) => minutes < 60 ? `${minutes}분` : minutes % 60 ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분` : `${minutes / 60}시간`;
const staged = (change: Pick<WatchChange, "routes" | "prefixes">) => change.routes.length > 0 || change.prefixes.length > 0;

/** 이 변경의 단계에 걸린 대기 — 단계 route 중 대기를 센 것의 합. 하나도 못 셌으면 null */
function waitingOf(change: Pick<WatchChange, "routes" | "prefixes">, backlog: StageBacklog): number | null {
  const hits = [...backlog].filter(([route]) => change.routes.includes(route) || change.prefixes.some(prefix => route.startsWith(prefix)));
  return hits.length ? hits.reduce((total, [, waiting]) => total + waiting, 0) : null;
}

export type BuildWatchOptions = {
  /** 접수 중단·잡 멈춤 구간(collectOutages) — 잰 구간에서 뺀다 */
  outages?: readonly WatchOutage[];
  /** 단계 대기(backlogFromProgress) — 넣지 않으면 보지 않고, null 이면 읽지 못함(줄었다는 판정을 하지 않는다) */
  backlog?: StageBacklog | null;
};

/**
 * 변경 → 화면 줄. 같은 단계를 그 뒤 또 바꿨으면(멈춤·재개 포함) 앞의 것은 판정하지 않고, 멈춤 → 재개는 견주지 않으며,
 * 잰 구간에서 그 단계에 걸린 접수 중단·잡 멈춤(자기 자신의 멈춤은 빼고)을 빼고 견준다.
 */
export function buildChangeWatch(changes: readonly WatchChange[], buckets: readonly LedgerBucket[], nowMs: number, options: BuildWatchOptions = {}): ChangeWatchSnapshot {
  const ledger = indexLedger(buckets);
  const outages = options.outages ?? [];
  const order = (change: WatchChange) => [Date.parse(change.at), change.ids[0] ?? 0] as const;
  const after = (a: WatchChange, b: WatchChange) => { const [at, id] = order(a), [bt, bid] = order(b); return at > bt || (at === bt && id > bid); };
  const rows = changes.map((change): ChangeWatchRow => {
    const at = Date.parse(change.at);
    // 한 단계에는 가장 최근 변경 하나만 — 그 뒤 같은 단계의 변경(접수 전환은 모든 단계라 빼고 잰 구간에서 뺀다)이 있으면 앞의 것은 견주지 않는다
    const later = staged(change) ? changes.filter(other => other !== change && other.kind !== "capacity" && staged(other) && sameStage(change, other) && after(other, change))
      .sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1])[0] : undefined;
    const own = outages.filter(outage => !outage.ids.every(id => change.ids.includes(id)) && (outage.all || sameStage(outage, change)));
    const measure = staged(change) && !change.restore ? measureChange(change, ledger, nowMs, own) : null;
    const judged = judgeChange(measure, {
      noStage: change.noStage, why: change.why, restore: change.restore,
      superseded: later ? `${spanText(Math.max(1, Math.round((Date.parse(later.at) - at) / MINUTE)))} 뒤 · ${later.title}` : null,
      waiting: options.backlog === undefined ? undefined : options.backlog === null ? null : waitingOf(change, options.backlog),
    });
    const notes: string[] = [];
    const excluded = measure ? measure.excluded.before + measure.excluded.first + measure.excluded.last : 0;
    if (measure && excluded > 0 && judged.verdict !== "unused" && judged.verdict !== "counting" && !later)
      notes.push(`잰 구간에서 접수 중단·작업 멈춤 ${excluded}분을 빼고 시간당으로 견줬습니다`);
    return {
      key: change.key, ids: change.ids, at: change.at, until: change.until, actor: change.actor, action: change.action, target: change.target,
      title: change.title, stage: change.stage, kind: change.kind, routes: change.routes, prefixes: change.prefixes,
      measure, ...judged, ...watchTexts(measure, judged.verdict, change.noStage), notes,
      // 멈춤 → 재개 한 쌍은 이미 원래대로다 — 되돌릴 것이 없다
      undo: change.restore && change.until ? null : CHANGE_UNDO[change.action]?.(change.target) ?? null,
      recordHref: `/admin/activity?target=${encodeURIComponent(change.target)}`,
    };
  });
  return { measuredAt: new Date(nowMs).toISOString(), windowHours: CHANGE_WATCH_RULES.windowHours,
    rows: rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || Number(b.key) - Number(a.key)), ...(options.backlog === null ? { waitingUnread: true } : {}) };
}

// ── 순수: 할 일로 올리기 ────────────────────────────────────────────────────────────────────────────

/**
 * 「다시 떨어짐」·「나빠짐」 → 홈 할 일 「평소와 다름」(시안 「할 일이 생기는 조건」: 바꾼 뒤 처리량이 바꾸기 전보다 떨어짐 · 되돌리기 · 알림 보냄).
 * 첫 10분만 본 판정(provisional), 사람이 일부러 멈춘 작업(job-pause), 접수 중단은 올리지 않는다.
 */
export function changeWatchTasksFrom(snapshot: ChangeWatchSnapshot): ChangeWatchTask[] {
  return snapshot.rows.filter(row => (row.verdict === "fell_back" || row.verdict === "worse") && !row.provisional && row.action !== "job-pause" && row.kind !== "capacity")
    .map(row => {
      const verdict = row.verdict as ChangeWatchTask["verdict"];
      const stage = row.stage ?? "이 단계";
      const why = [row.reason, ...row.notes].filter(Boolean).join(" · ");
      return {
        key: `change-watch:${row.key}`, verdict,
        title: verdict === "fell_back" ? `${stage} 처리가 바꾼 뒤 다시 줄었습니다` : `${stage} 처리가 바꾼 뒤 줄었습니다`,
        fact: `${row.title} · ${formatListTime(row.at, snapshot.measuredAt)} · ${row.beforeText ? `${row.beforeText} → ` : ""}${row.afterText}`,
        ...(why ? { why } : {}),
        actions: [...(row.undo?.href ? [{ label: "되돌리러 가기", href: row.undo.href }] : []), { label: "기록 보기", href: row.recordHref }],
        notify: true,
      };
    });
}

// ── 읽기(서버) ─────────────────────────────────────────────────────────────────────────────────────

/** 큰 detail 은 필요한 칸만 — 접수 전환은 정책 전체를, 한도 저장은 그룹 전·후 전체를 싣는다 */
const auditDetail = sql<Record<string, unknown>>`case ${operationsAudit.action}
  when ${CAPACITY_MODE_ACTION} then jsonb_build_object('mode', ${operationsAudit.detail}->'after'->'mode', 'beforeMode', ${operationsAudit.detail}->'before'->'mode')
  when 'runtime-settings-save' then jsonb_build_object('group', ${operationsAudit.detail}->'group', 'revision', ${operationsAudit.detail}->'revision',
    'changes', coalesce((select jsonb_agg(jsonb_build_object('path', c->'path', 'label', c->'label'))
      from jsonb_array_elements(case when jsonb_typeof(${operationsAudit.detail}->'changes') = 'array' then ${operationsAudit.detail}->'changes' else '[]'::jsonb end) c), '[]'::jsonb))
  when 'ai-connection-save' then jsonb_build_object('id', ${operationsAudit.detail}->'id', 'created', ${operationsAudit.detail}->'created',
    'keyChanged', ${operationsAudit.detail}->'keyChanged', 'label', ${operationsAudit.detail}->'after'->'label')
  else ${operationsAudit.detail} end`;

type Reader = Pick<typeof db, "select">;

async function readAuditRows(reader: Reader, since: Date): Promise<WatchAuditRow[]> {
  const rows = await reader.select({ id: operationsAudit.id, at: operationsAudit.createdAt, actor: operationsAudit.actor, actorKind: operationsAudit.actorKind,
    action: operationsAudit.action, target: operationsAudit.target, detail: auditDetail })
    .from(operationsAudit)
    .where(and(inArray(operationsAudit.action, [...CHANGE_WATCH_ACTIONS]), eq(operationsAudit.ok, true), gt(operationsAudit.createdAt, since)))
    .orderBy(desc(operationsAudit.id)).limit(CHANGE_WATCH_RULES.maxAuditRows);
  return rows.reverse().map(row => ({ ...row, at: row.at.toISOString(), detail: record(row.detail) }));
}

/** 연결을 지금 쓰는 작업(켜진 순위 + 작업 분산으로 도는 칸의 구성원)과 연결 이름 */
async function readConnections(reader: Reader, ids: readonly string[]): Promise<WatchContext> {
  if (!ids.length) return { connectionTasks: new Map(), connectionLabels: new Map() };
  const [ranks, pool, labels] = [
    await reader.select({ id: aiTaskModels.connectionId, task: aiTaskModels.task }).from(aiTaskModels)
      .where(and(inArray(aiTaskModels.connectionId, [...ids]), eq(aiTaskModels.enabled, true))),
    await reader.select({ id: aiTaskPoolMembers.connectionId, task: aiTaskPoolMembers.task }).from(aiTaskPoolMembers)
      .innerJoin(aiTaskExecutionConfigs, and(eq(aiTaskExecutionConfigs.task, aiTaskPoolMembers.task), eq(aiTaskExecutionConfigs.slot, aiTaskPoolMembers.slot)))
      .where(and(inArray(aiTaskPoolMembers.connectionId, [...ids]), eq(aiTaskExecutionConfigs.mode, "workload_pool"))),
    await reader.select({ id: aiConnections.id, label: aiConnections.label, options: aiConnections.options }).from(aiConnections).where(inArray(aiConnections.id, [...ids])),
  ];
  const connectionTasks = new Map<string, string[]>();
  for (const row of [...ranks, ...pool]) connectionTasks.set(row.id, [...new Set([...(connectionTasks.get(row.id) ?? []), row.task])]);
  // 이름은 사용자가 정한 이름 하나(운영 콘솔 3a aiModelDisplayName — options.displayName, 없으면 이름표)
  return { connectionTasks, connectionLabels: new Map(labels.map(row => [row.id, aiModelDisplayName({ label: row.label,
    displayName: typeof (row.options as Record<string, unknown> | null)?.displayName === "string" ? (row.options as Record<string, unknown>).displayName as string : null })])) };
}

/** 장부 settled 를 route × 5분 칸으로 — settled_at 부분 색인 범위 + route 조건 */
async function readLedger(reader: Reader, from: Date, to: Date, routes: readonly string[], prefixes: readonly string[]): Promise<LedgerBucket[]> {
  const scope: SQL[] = [...(routes.length ? [inArray(modelCapacityRequests.routeId, [...routes])] : []),
    ...prefixes.map(prefix => like(modelCapacityRequests.routeId, `${prefix.replace(/[\\%_]/g, "\\$&")}%`))];
  if (!scope.length) return [];
  // 칸 너비는 글자로 넣는다 — 매개변수로 넣으면 SELECT 와 GROUP BY 의 식이 서로 다른 $n 이 되어 PostgreSQL 이 같은 식으로 보지 않는다
  const bucket = sql<number>`floor(extract(epoch from ${modelCapacityRequests.settledAt}) * 1000 / ${sql.raw(String(BUCKET_MS))})::bigint`;
  const rows = await reader.select({ route: modelCapacityRequests.routeId, bucket, settled: sql<number>`count(*)::int` })
    .from(modelCapacityRequests)
    .where(and(eq(modelCapacityRequests.state, "settled"), gte(modelCapacityRequests.settledAt, from), lt(modelCapacityRequests.settledAt, to), or(...scope)))
    .groupBy(modelCapacityRequests.routeId, bucket);
  return rows.map(row => ({ route: row.route, bucket: Number(row.bucket), settled: Number(row.settled) }));
}

/** 연결 id — 모델 저장(그 연결을 쓰는 단계)과 순위 저장(순위 제목의 연결 이름) */
function connectionIdsOf(rows: readonly WatchAuditRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.action === "ai-connection-save" && typeof row.detail.id === "string") ids.add(row.detail.id);
    if (row.action === "ai-task-models-save") for (const rank of [...rankRows(row.detail.before), ...rankRows(row.detail.after)]) ids.add(rank.connectionId);
  }
  return [...ids].filter(id => UUID.test(id));
}

async function loadChangeWatch(): Promise<ChangeWatchSnapshot> {
  const nowMs = Date.now();
  // 바꾸기 전 6시간에 걸린 접수 중단·잡 멈춤도 보게 지켜보는 기간보다 6시간 더 읽는다(줄은 24시간 안의 것만)
  const since = new Date(nowMs - (CHANGE_WATCH_RULES.windowHours + CHANGE_WATCH_RULES.beforeHours) * HOUR);
  const windowStart = nowMs - CHANGE_WATCH_RULES.windowHours * HOUR;
  // 단계 대기 — 홈과 같은 공유 캐시. 못 읽으면 줄었다는 판정을 하지 않는다(홈은 「셀 수 없음」)
  const progress = await readConsoleProgress().catch(() => null);
  return onReplica(() => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    const audit = await readAuditRows(tx, since);
    const changes = collectChanges(audit, await readConnections(tx, connectionIdsOf(audit)))
      .filter(change => Date.parse(change.until ?? change.at) > windowStart);
    const staged = changes.filter(change => change.routes.length || change.prefixes.length);
    const routes = [...new Set(staged.flatMap(change => change.routes))], prefixes = [...new Set(staged.flatMap(change => change.prefixes))];
    const earliest = Math.min(...staged.map(change => Date.parse(change.at)));
    const buckets = staged.length
      ? await readLedger(tx, new Date(earliest - CHANGE_WATCH_RULES.beforeHours * HOUR - BUCKET_MS), new Date(nowMs + BUCKET_MS), routes, prefixes) : [];
    return buildChangeWatch(changes, buckets, nowMs, { outages: collectOutages(audit, nowMs), backlog: progress ? backlogFromProgress(progress.stages) : null });
  }, { accessMode: "read only" }));
}

// v2: 줄마다 route 를 싣는다(단계 패널의 「최근 바뀐 것」). v3: 뺀 시간·고친 시간당·단계 대기(잘못된 경고 고침)
const shared = sharedLoader<ChangeWatchSnapshot>({ namespace: "admin:change-watch:v3", ttlMs: 60_000, staleMs: 15 * 60_000, store: sharedStore });

/** 바꾼 것 지켜보기 — 웹들이 1분 나눠 쓰고, 15분 안의 값이면 기다리지 않는다. 실패는 던진다(부르는 쪽이 「읽지 못함」으로 그린다) */
export function readChangeWatch(fresh = false): Promise<ChangeWatchSnapshot> {
  return shared("watch", loadChangeWatch, fresh);
}

/** 홈 할 일 「평소와 다름」의 외부 입력 — 못 읽었으면(단계 대기를 못 읽은 것 포함) null(0건이 아니다) */
export async function changeWatchTasks(fresh = false): Promise<ChangeWatchTask[] | null> {
  return readChangeWatch(fresh).then(snapshot => snapshot.waitingUnread ? null : changeWatchTasksFrom(snapshot), () => null);
}

/** 기록 화면의 줄이 지켜보기 대상인가 — 이 줄을 담은 지켜보기 줄이 있을 수 있는가(성공, 사람의 줄, 지켜보는 작업, 24시간 안) */
export function isWatchedAuditRow(row: { action: string; ok: boolean; actor: string; actorKind: string | null; createdAt: Date }, nowMs: number): boolean {
  return row.ok && CHANGE_WATCH_ACTIONS.includes(row.action) && !isAutomaticActor(row.actor, row.actorKind)
    && nowMs - row.createdAt.getTime() < CHANGE_WATCH_RULES.windowHours * HOUR;
}
