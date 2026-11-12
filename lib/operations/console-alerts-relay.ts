import { and, asc, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { consoleAlerts } from "@/lib/db/schema";
import { CONSOLE_ALERT_RULES, consoleAlertRelay, type ConsoleAlertRelay } from "./console-alerts";

/**
 * 감시(monitor)가 주기마다 읽는 휴대폰 알림 줄(운영 콘솔 개편 조각 4b) — 닫히지 않았고 내보낸 줄(console_alerts, 0183)만.
 * 감시는 이것을 자기 건강 파일(monitorHealth.consoleAlerts)에 적고, 복구 게이트웨이가 검사해 Oracle watchdog 에 넘기며, Oracle 이 줄 id 마다 한 번 Telegram 으로 보낸다.
 * 읽기 하나(부분 색인 console_alerts_released_idx). 실패는 던진다 — 감시는 그 칸을 빼고 쓴다(빈 목록이 아니다: Oracle 은 「모름」으로 보고 지우지 않는다).
 */
export async function readConsoleAlertRelay(): Promise<ConsoleAlertRelay[]> {
  const rows = await db.select({ id: consoleAlerts.id, title: consoleAlerts.title, fact: consoleAlerts.fact, href: consoleAlerts.href }).from(consoleAlerts)
    .where(and(isNull(consoleAlerts.closedAt), isNotNull(consoleAlerts.releasedAt))).orderBy(asc(consoleAlerts.id)).limit(CONSOLE_ALERT_RULES.maxRelay);
  return consoleAlertRelay(rows);
}
