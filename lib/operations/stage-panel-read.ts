import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { operationsAudit, operationsObservations } from "@/lib/db/schema";
import { ensureServingContracts } from "@/lib/llm/serving-contract-store";
import { logger } from "@/lib/observability/logger";
import { readAiTaskRuntime } from "./admin-ai-tasks-repository";
import { readLimitsAdminView } from "./admin-limits-repository";
import { LIMITS_TASKS, type LimitsView } from "./admin-limits-view";
import { readChangeWatch, runtimePathTasks, type ChangeWatchSnapshot } from "./change-watch";
import { readFlowRankEditor } from "./flow-rank-editor-read";
import type { FlowRankEditor } from "./flow-rank-editor";
import type { StagePanelDef } from "./stage-panel-catalog";
import { taskStageLabel, type StageJobDegraded, type StagePauseRecord, type StageRuntime } from "./stage-panel-model";

/**
 * 단계 패널(조각 2a)의 덧읽기 — 홈 읽기(console-home-read.ts)에 없는 것만, 패널이 열렸을 때만 읽는다. 쓰기는 하지 않는다.
 * 읽기마다 따로 실패한다 — 못 읽은 것은 null 이고 패널은 그 자리에 「읽지 못함」을 적는다.
 * - 사람이 멈춘 기록: 그 단계 잡의 마지막 job-pause·job-resume 작업 로그((action, created_at) 색인)
 * - 워커가 남긴 degraded: 잡 관측(operations_observations job:<잡>)의 지금 degraded
 * - 실행 쪽 순위 사정: readAiTaskRuntime(작업 배정 화면과 같은 읽기)
 * - 순위 편집기: readFlowRankEditor(흐름 상세의 서랍과 같은 읽기 — 연결 키를 채우는 쓰기가 섞인 readAiTasksAdminView 는 부르지 않는다)
 * - 한도: readLimitsAdminView(실시간 한도 화면과 같은 행·측정 — 측정은 웹들이 60초 나눠 쓴다)
 * - 바뀐 것: readChangeWatch(홈의 「바꾼 것 지켜보기」와 같은 캐시)
 */
export type StagePanelExtra = {
  pauses: StagePauseRecord[] | null;
  degraded: StageJobDegraded[] | null;
  runtime: StageRuntime[] | null;
  editor: FlowRankEditor | null;
  limits: LimitsView | null;
  /** 패널에 그릴 한도 줄(실시간 한도의 줄 id) */
  limitRows: string[];
  /** 한도 칸(경로) → 그 값을 쓰는 단계 — 저장 전 확인의 「영향을 받는 단계」 */
  limitImpact: Record<string, string[]>;
  changes: ChangeWatchSnapshot | null;
};

const quiet = (event: string) => (error: unknown) => {
  logger.warn(event, { errorName: error instanceof Error ? error.name : "unknown" });
  return null;
};
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** 잡마다 마지막 멈춤·재개 — 마지막이 멈춤이면 그 기록(누가·언제·사유), 재개면 없음 */
async function readPauses(jobs: readonly string[]): Promise<StagePauseRecord[]> {
  if (!jobs.length) return [];
  const rows = await db.select({ id: operationsAudit.id, action: operationsAudit.action, target: operationsAudit.target, actor: operationsAudit.actor,
    at: operationsAudit.createdAt, detail: operationsAudit.detail }).from(operationsAudit)
    .where(and(inArray(operationsAudit.action, ["job-pause", "job-resume"]), inArray(operationsAudit.target, [...jobs]), eq(operationsAudit.ok, true)))
    .orderBy(desc(operationsAudit.id)).limit(Math.max(20, jobs.length * 4));
  const out: StagePauseRecord[] = [];
  for (const job of jobs) {
    const last = rows.find(row => row.target === job);
    if (last?.action !== "job-pause") continue;
    const reason = record(last.detail).reason;
    out.push({ job, actor: last.actor, at: last.at.toISOString(), reason: typeof reason === "string" ? reason : "" });
  }
  return out;
}

/** 잡 관측의 지금 degraded(막 끝난 틱이 제 일을 못 했을 때만 있다 — 다음 성공 틱이 lastDegraded 로 옮긴다) */
async function readDegraded(jobs: readonly string[]): Promise<StageJobDegraded[]> {
  if (!jobs.length) return [];
  const rows = await onPrimary(() => db.select({ key: operationsObservations.key, value: operationsObservations.value, observedAt: operationsObservations.observedAt })
    .from(operationsObservations).where(inArray(operationsObservations.key, jobs.map(job => `job:${job}`))));
  return rows.flatMap(row => {
    const degraded = record(record(row.value).degraded);
    if (typeof degraded.code !== "string") return [];
    return [{ job: row.key.slice("job:".length), code: degraded.code, detail: typeof degraded.detail === "string" ? degraded.detail.slice(0, 300) : null,
      streak: typeof degraded.streak === "number" && Number.isSafeInteger(degraded.streak) ? degraded.streak : null,
      since: typeof degraded.since === "string" ? degraded.since : null, at: row.observedAt.toISOString() }];
  });
}

async function readRuntime(tasks: readonly string[]): Promise<StageRuntime[]> {
  if (!tasks.length) return [];
  const runtime = await readAiTaskRuntime();
  return tasks.flatMap(task => {
    const view = runtime[task];
    return view ? [{ task, at: view.at, served: view.served, unusable: view.unusable, degraded: view.degraded }] : [];
  });
}

/** 단계의 한도 줄과 그 칸들의 영향 — 실시간 한도 화면의 작업 줄 가운데 이 단계 작업의 것 */
export function stageLimitScope(def: Pick<StagePanelDef, "tasks">, view: LimitsView | null): { rows: string[]; impact: Record<string, string[]> } {
  const rows = LIMITS_TASKS.filter(spec => spec.aiTask && def.tasks.includes(spec.aiTask)).map(spec => spec.id);
  const impact: Record<string, string[]> = {};
  for (const row of view?.groups.flatMap(group => group.rows).filter(entry => rows.includes(entry.id)) ?? []) {
    const fields = [row.cap.kind === "field" ? row.cap.field : null, row.tick.kind === "field" ? row.tick.field : null,
      row.concurrency.kind === "field" ? row.concurrency.field : null, ...row.details];
    for (const field of fields) if (field) impact[field.path] = [...new Set(runtimePathTasks(field.path).map(task => taskStageLabel(task.id)))];
  }
  return { rows, impact };
}

export async function readStagePanelExtra(def: StagePanelDef, fresh = false): Promise<StagePanelExtra> {
  const jobs = def.jobs.map(job => job.job);
  const usesModels = def.tasks.length > 0;
  const [pauses, degraded, runtime, editor, limits, changes] = await Promise.all([
    readPauses(jobs).catch(quiet("stage_panel.pauses_unavailable")),
    readDegraded(jobs).catch(quiet("stage_panel.degraded_unavailable")),
    readRuntime(def.tasks).catch(quiet("stage_panel.runtime_unavailable")),
    usesModels ? readFlowRankEditor() : Promise.resolve(null),
    usesModels ? ensureServingContracts().then(() => readLimitsAdminView(new Date())).catch(quiet("stage_panel.limits_unavailable")) : Promise.resolve(null),
    readChangeWatch(fresh).catch(quiet("stage_panel.changes_unavailable")),
  ]);
  const scope = stageLimitScope(def, limits);
  return { pauses, degraded, runtime, editor, limits, limitRows: scope.rows, limitImpact: scope.impact, changes };
}
