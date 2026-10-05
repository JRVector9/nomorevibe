import { and, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db';
import { operationsAudit } from '@/lib/db/schema';
import { logger } from '@/lib/observability/logger';
import { trustedClientIp } from '@/lib/rate-limit';

/**
 * 관리자 작업 로그(operations_audit).
 *
 * 관리자가 무엇을 바꿨는지 한 줄씩 덧붙인다 — 누가(로그인·방식), 어디서(접속 주소·브라우저), 무엇을, 성공했는지.
 * 표는 DB 트리거가 고치기·지우기·비우기를 거부한다(0056). 여기에도 지우는 함수는 없다.
 *
 * 한 트랜잭션으로 끝나는 작업(설정 저장, 내려달라는 요청 처리, 작업 요청 등)은 그 트랜잭션 안에서
 * adminAuditRow 로 쓰고, 나머지는 액션이 끝난 뒤 recordAdminActions 로 쓴다.
 */

export type ActorKind = 'github' | 'local' | 'token';
export type AdminLogEntry = {
  action: string;
  target: string;
  detail?: Record<string, unknown>;
  ok?: boolean;
  error?: string | null;
};

/**
 * 로컬 로그인이 켜져 있으면 모든 방문이 'local' 이다 — 그때는 접속 주소가 사람을 가르는 유일한 단서다.
 * 판정은 lib/auth/admin 과 같다. 그 모듈은 next/headers 를 바로 불러 설정 저장을 거치는 워커에 넣지 않는다.
 */
export function actorKind(login: string): ActorKind {
  return process.env.ADMIN_LOCAL_LOGIN === '1' && login === 'local' ? 'local' : 'github';
}

/** 요청한 곳. 서버 액션·라우트 밖(워커·스크립트·테스트)에서는 머리가 없으니 비운다 */
async function requestOrigin(): Promise<{ ip: string | null; userAgent: string | null }> {
  try {
    // 워커도 설정 저장 경로를 거친다 — Next 서버 모듈은 요청 안에서만 부른다
    const { headers } = await import('next/headers');
    const list = await headers();
    return { ip: trustedClientIp({ headers: list }), userAgent: list.get('user-agent')?.slice(0, 300) || null };
  } catch {
    return { ip: null, userAgent: null };
  }
}

export async function adminAuditRow(actor: string, entry: AdminLogEntry, kind: ActorKind = actorKind(actor)) {
  const origin = await requestOrigin();
  return {
    actor: actor.slice(0, 120), actorKind: kind, ip: origin.ip, userAgent: origin.userAgent,
    action: entry.action, target: entry.target.slice(0, 200), detail: entry.detail ?? {},
    ok: entry.ok ?? true, error: entry.error?.slice(0, 300) ?? null,
  } satisfies typeof operationsAudit.$inferInsert;
}

/**
 * 끝난 작업을 남긴다. 작업은 이미 반영됐다 — 기록이 실패해도 화면을 깨뜨리지 않고, 놓친 기록을 운영 로그에 남긴다.
 */
export async function recordAdminActions(actor: string, entries: AdminLogEntry[], kind?: ActorKind): Promise<void> {
  if (!entries.length) return;
  try {
    const rows = await Promise.all(entries.map((entry) => adminAuditRow(actor, entry, kind)));
    await db.insert(operationsAudit).values(rows);
  } catch (error) {
    logger.error('admin.audit_log_failed', {
      actor, entries: entries.slice(0, 20).map((entry) => `${entry.action}:${entry.target}:${entry.ok ?? true}`),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function recordAdminAction(actor: string, entry: AdminLogEntry, kind?: ActorKind): Promise<void> {
  return recordAdminActions(actor, [entry], kind);
}

/**
 * 설정에서 바뀐 값만 — 점으로 이은 경로마다 전과 후. 배열은 통째로 비교한다(검색 신호 목록 등).
 */
export function settingsChanges(before: unknown, after: unknown, path = ''): { path: string; before: unknown; after: unknown }[] {
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (isObject(before) && isObject(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
      .flatMap((key) => settingsChanges(before[key], after[key], path ? `${path}.${key}` : key));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path: path || '(전체)', before: before ?? null, after: after ?? null }];
}

export type AdminLogRow = typeof operationsAudit.$inferSelect;
export const ADMIN_LOG_PAGE_SIZE = 100;

/** 작업 로그 화면 — 최근 것부터. before 는 앞 쪽의 마지막 id(그보다 오래된 것을 읽는다) */
export async function adminLog(filter: { actions?: string[]; actor?: string; failedOnly?: boolean; before?: number } = {}) {
  const where: SQL[] = [];
  if (filter.actions?.length) where.push(inArray(operationsAudit.action, filter.actions));
  if (filter.actor) where.push(eq(operationsAudit.actor, filter.actor));
  if (filter.failedOnly) where.push(eq(operationsAudit.ok, false));
  if (filter.before) where.push(lt(operationsAudit.id, filter.before));
  return db.select().from(operationsAudit).where(where.length ? and(...where) : undefined)
    .orderBy(desc(operationsAudit.id)).limit(ADMIN_LOG_PAGE_SIZE);
}

/** 거르기 칩에 쓸 수 — 작업 종류별·처리자별 */
export async function adminLogFacets() {
  const [actions, actors] = await Promise.all([
    db.select({ action: operationsAudit.action, count: sql<number>`count(*)::int` }).from(operationsAudit)
      .groupBy(operationsAudit.action),
    db.select({ actor: operationsAudit.actor, count: sql<number>`count(*)::int` }).from(operationsAudit)
      .groupBy(operationsAudit.actor).orderBy(desc(sql`count(*)`)).limit(20),
  ]);
  return { actions, actors };
}
