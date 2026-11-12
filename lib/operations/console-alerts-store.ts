import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { consoleAlerts, operationsAudit } from "@/lib/db/schema";
import { withJobLeaseWrite, type JobLease } from "@/lib/jobs/control";
import { adminAuditRow } from "./admin-log";
import { alertSettingsFrom, CONSOLE_ALERT_DEFAULTS, CONSOLE_ALERT_RULES, CONSOLE_ALERT_SETTINGS_ACTION,
  type ConsoleAlertPlan, type ConsoleAlertRow, type ConsoleAlertSettings } from "./console-alerts";

/**
 * 휴대폰 알림의 읽기·쓰기(운영 콘솔 개편 조각 4b) — 판단은 순수 함수(console-alerts.ts), 여기서는 표(console_alerts, 0183)와 작업 로그만 다룬다.
 * 잡(console-alerts, maintenance)이 쓰는 것은 자기 lease 의 쓰기 관문(withJobLeaseWrite — DR writer fence·lease 확인) 안에서 한다.
 * 알림 설정은 새 표 없이 작업 로그 한 줄(console-alert-settings — 전·후, 사람·때)이 저장이고, 마지막 줄이 지금 설정이다.
 * 이 모듈은 "server-only" 를 달지 않는다 — maintenance 워커가 가져온다(브라우저 쪽 모듈은 이것을 가져오지 않는다).
 */

export type ConsoleAlertSettingsRead = { settings: ConsoleAlertSettings; at: string | null; actor: string | null };

/** 지금 설정 — 작업 로그(action, created_at 색인)의 마지막 성공 줄. 없으면 기본(꺼짐). 실패는 던진다 */
export async function readConsoleAlertSettings(): Promise<ConsoleAlertSettingsRead> {
  const [row] = await db.select({ detail: operationsAudit.detail, at: operationsAudit.createdAt, actor: operationsAudit.actor }).from(operationsAudit)
    .where(and(eq(operationsAudit.action, CONSOLE_ALERT_SETTINGS_ACTION), eq(operationsAudit.ok, true)))
    .orderBy(desc(operationsAudit.id)).limit(1);
  return row ? { settings: alertSettingsFrom(row.detail), at: row.at.toISOString(), actor: row.actor } : { settings: CONSOLE_ALERT_DEFAULTS, at: null, actor: null };
}

/** 설정 저장 = 작업 로그 한 줄(전·후). 웹 쓰기 관문 안의 서버 동작이 부른다 */
export async function saveConsoleAlertSettings(before: ConsoleAlertSettings, after: ConsoleAlertSettings, actor: string): Promise<void> {
  await onPrimary(() => db.transaction(async tx => {
    await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: CONSOLE_ALERT_SETTINGS_ACTION, target: "console-alerts",
      detail: { before, after } }));
  }));
}

const rowOf = (row: typeof consoleAlerts.$inferSelect): ConsoleAlertRow => ({ id: row.id, taskId: row.taskId, group: row.groupKey, title: row.title, fact: row.fact,
  href: row.href, openedAt: row.openedAt.toISOString(), seenAt: row.seenAt.toISOString(), missingSince: row.missingSince?.toISOString() ?? null,
  releasedAt: row.releasedAt?.toISOString() ?? null });

/** 열린 줄 — 잡이 할 일과 견준다(주 DB 에서: 방금 쓴 줄을 다시 읽는다) */
export async function readOpenConsoleAlerts(): Promise<ConsoleAlertRow[]> {
  const rows = await onPrimary(() => db.select().from(consoleAlerts).where(isNull(consoleAlerts.closedAt)).orderBy(consoleAlerts.id).limit(500));
  return rows.map(rowOf);
}

/** 할 것을 한 트랜잭션으로 — 새 줄은 열린 줄이 이미 있으면 넘긴다(부분 유일 색인, 다른 잡 틱과 겹쳐도 한 줄) */
export async function applyConsoleAlertPlan(plan: ConsoleAlertPlan, lease: JobLease | undefined): Promise<{ opened: number; released: number; closed: number }> {
  return withJobLeaseWrite(lease, async tx => {
    let opened = 0, released = 0;
    for (const { candidate, release } of plan.open) {
      const inserted = await tx.insert(consoleAlerts).values({ taskId: candidate.taskId, rule: candidate.rule, groupKey: candidate.group,
        title: candidate.title, fact: candidate.fact, href: candidate.href, ...(release ? { releasedAt: sql`clock_timestamp()` } : {}) })
        .onConflictDoNothing({ target: consoleAlerts.taskId, where: sql`${consoleAlerts.closedAt} IS NULL` }).returning({ id: consoleAlerts.id });
      opened += inserted.length;
      if (release) released += inserted.length;
    }
    for (const { id, candidate, release } of plan.seen) {
      await tx.update(consoleAlerts).set({ seenAt: sql`clock_timestamp()`, missingSince: null, title: candidate.title, fact: candidate.fact, href: candidate.href,
        ...(release ? { releasedAt: sql`coalesce(${consoleAlerts.releasedAt}, clock_timestamp())` } : {}) })
        .where(and(eq(consoleAlerts.id, id), isNull(consoleAlerts.closedAt)));
      if (release) released += 1;
    }
    if (plan.missing.length) await tx.update(consoleAlerts).set({ missingSince: sql`clock_timestamp()` })
      .where(and(inArray(consoleAlerts.id, plan.missing), isNull(consoleAlerts.closedAt), isNull(consoleAlerts.missingSince)));
    for (const reason of ["resolved", "kept", "disabled"] as const) {
      const ids = plan.close.filter(row => row.reason === reason).map(row => row.id);
      if (ids.length) await tx.update(consoleAlerts).set({ closedAt: sql`clock_timestamp()`, closeReason: reason })
        .where(and(inArray(consoleAlerts.id, ids), isNull(consoleAlerts.closedAt)));
    }
    return { opened, released, closed: plan.close.length };
  });
}

/** 닫힌 지 30일 지난 줄을 지운다(쌓이는 양에 끝이 있게) */
export async function pruneConsoleAlerts(lease: JobLease | undefined): Promise<number> {
  return withJobLeaseWrite(lease, async tx => (await tx.delete(consoleAlerts)
    .where(and(isNotNull(consoleAlerts.closedAt), lt(consoleAlerts.closedAt, sql`now() - ${CONSOLE_ALERT_RULES.retentionDays} * interval '1 day'`)))
    .returning({ id: consoleAlerts.id })).length);
}

export type ConsoleAlertView = ConsoleAlertRow & { closedAt: string | null; closeReason: string | null };

/** 알림 화면 — 열린 줄과 최근 닫힌 줄(최근 것부터) */
export async function readConsoleAlertsView(limit = 50): Promise<ConsoleAlertView[]> {
  const rows = await db.select().from(consoleAlerts).orderBy(desc(consoleAlerts.id)).limit(limit);
  return rows.map(row => ({ ...rowOf(row), closedAt: row.closedAt?.toISOString() ?? null, closeReason: row.closeReason ?? null }));
}
