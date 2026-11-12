import "server-only";
import { and, desc, eq, gt } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { operationsAudit } from "@/lib/db/schema";
import { controllableJob } from "./admin-job-control";
import { adminAuditRow } from "./admin-log";
import { CONSOLE_KEEP_ID, CONSOLE_KEEP_REASON_MAX, CONSOLE_TASK_LIMITS, type ConsoleKept } from "./console-tasks";

/**
 * 운영 홈 할 일의 「사유 남기고 유지」·「그대로 두기」(운영 콘솔 개편 조각 2a) — 사람이 할 일을 확인했고 지금은 그대로 둔다는 표시.
 *
 * 새 표를 만들지 않는다: 표시 한 번이 작업 로그(operations_audit) 한 줄이다(action console-task-keep, target = 할 일 열쇠, detail = 사유·기간·대상 판).
 * 작업 로그는 덧붙이기만 하므로 표시는 지울 수 없고, 기간(CONSOLE_TASK_LIMITS.keepMs)이 지나면 할 일이 다시 올라온다. 일찍 다시 보려면 그 작업을 고치면 된다
 * (사람이 멈춘 작업은 재개·다시 멈춤으로 판이 바뀌면 표시가 더는 맞지 않는다 — ref).
 * 읽기는 (action, created_at) 색인으로 최근 기간만 본다. 잡·모델·접수 상태는 바꾸지 않는다 — 그대로 두는 것이 이 동작의 뜻이다.
 */
export const CONSOLE_TASK_KEEP_ACTION = "console-task-keep";

export type ConsoleKeepInput = { taskId: string; ref: string | null; reason: string; title: string };

/** 서버 동작이 받는 값 검사 — 할 일 열쇠는 그대로 둘 수 있는 규칙(사람이 멈춘 작업 · 자주 거절하는 모델)의 모양만 받는다 */
export function parseConsoleKeep(input: { taskId?: unknown; ref?: unknown; reason?: unknown; title?: unknown }): ConsoleKeepInput | null {
  const taskId = typeof input.taskId === "string" ? input.taskId : "";
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  const ref = input.ref === null || input.ref === undefined || input.ref === "" ? null : typeof input.ref === "string" && /^\d{1,15}$/.test(input.ref) ? input.ref : undefined;
  if (!CONSOLE_KEEP_ID.test(taskId) || !reason || reason.length > CONSOLE_KEEP_REASON_MAX || ref === undefined) return null;
  if (taskId.startsWith("stop:job:") && !controllableJob(taskId.slice("stop:job:".length))) return null;
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 200) : "";
  return { taskId, ref, reason, title };
}

/** 표시 한 줄을 남긴다(쓰기 관문 안에서 — 주 DB 쓰기 TX 는 fence 를 먼저 잡는다). 돌려주는 것은 다시 올라오는 시각 */
export async function keepConsoleTask(input: ConsoleKeepInput, actor: string, now = new Date()): Promise<{ until: string }> {
  const until = new Date(now.getTime() + CONSOLE_TASK_LIMITS.keepMs).toISOString();
  await onPrimary(() => db.transaction(async tx => {
    await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: CONSOLE_TASK_KEEP_ACTION, target: input.taskId,
      detail: { reason: input.reason, until, ref: input.ref, title: input.title, keepDays: Math.round(CONSOLE_TASK_LIMITS.keepMs / 86_400_000) } }));
  }));
  return { until };
}

/** 작업 로그 줄 → 표시(같은 할 일은 가장 최근 줄). 순수 — 시험이 쓴다 */
export function keptFromAudit(rows: readonly { id: number; at: Date; actor: string; target: string; detail: Record<string, unknown> | null }[]): ConsoleKept[] {
  const latest = new Map<string, ConsoleKept>();
  for (const row of [...rows].sort((a, b) => b.id - a.id)) {
    if (latest.has(row.target) || !CONSOLE_KEEP_ID.test(row.target)) continue;
    const detail = row.detail ?? {};
    const until = typeof detail.until === "string" && Number.isFinite(Date.parse(detail.until)) ? detail.until
      : new Date(row.at.getTime() + CONSOLE_TASK_LIMITS.keepMs).toISOString();
    latest.set(row.target, { taskId: row.target, at: row.at.toISOString(), until, actor: row.actor,
      reason: typeof detail.reason === "string" ? detail.reason : "", ...(typeof detail.ref === "string" ? { ref: detail.ref } : {}) });
  }
  return [...latest.values()];
}

/** 기간 안의 표시 — 운영 홈 읽기(console-home-read.ts)가 부른다. 실패는 던진다(부르는 쪽이 null = 「읽지 못함」으로 둔다) */
export async function readConsoleKept(now = new Date()): Promise<ConsoleKept[]> {
  const rows = await db.select({ id: operationsAudit.id, at: operationsAudit.createdAt, actor: operationsAudit.actor, target: operationsAudit.target,
    detail: operationsAudit.detail }).from(operationsAudit)
    .where(and(eq(operationsAudit.action, CONSOLE_TASK_KEEP_ACTION), eq(operationsAudit.ok, true),
      gt(operationsAudit.createdAt, new Date(now.getTime() - CONSOLE_TASK_LIMITS.keepMs))))
    .orderBy(desc(operationsAudit.id)).limit(200);
  return keptFromAudit(rows).filter(row => Date.parse(row.until) > now.getTime());
}
