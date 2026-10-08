import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { operationsAudit, operationsObservations } from '@/lib/db/schema';

/**
 * 운영센터 "조치할 일"의 기억 — 24시간 변화와 "확인함 · 7일 숨김"(2026-10-08 UX 감사 ADM-08).
 *
 * 새 표를 만들지 않는다. 시간별 수는 관측 표(operations_observations)의 한 줄에 최근 25시간치를 담고,
 * 확인함(숨김)은 지울 수 없는 관리자 작업 로그(operations_audit)에 남긴 뒤 항목마다 가장 최근 줄을 읽는다.
 */

/** 관측 표에서 시간별 조치 수를 담는 줄 */
export const ATTENTION_HISTORY_KEY = 'attention:history';
/** 한 시간에 한 번만 적는다 — 운영센터는 10초마다 다시 그린다 */
const SAMPLE_EVERY_MS = 55 * 60_000;
/** 24시간 전과 견주려면 그보다 조금 더 들고 있어야 한다 */
const KEEP_MS = 25 * 3_600_000;
/** 숨김은 7일 — 지나면 다시 보인다 */
export const ACK_DAYS = 7;
export const ACK_ACTION = 'attention-ack';
/**
 * 늘 떠 있는 백로그 — 오늘 손댈 장애가 아니라 추세다(근거 갱신 39,749·저장소 확인 범위 4%·생존 확인 90·감사 멈춤 5,176).
 * 이 열쇠의 조치는 critical 이 아니고 새로 생긴 것도 아니면 "쌓인 일"로 가고, 확인함으로 7일 숨길 수 있다.
 */
export const BACKLOG_KEYS: ReadonlySet<string> = new Set([
  'review', 'second', 'held', 'audit', 'audit-stalled', 'evidence-backlog', 'health-overdue', 'intro', 'repo-gone',
  'spam-auto-ban', 'repo-coverage',
]);
export const UNACK_ACTION = 'attention-unack';

export type AttentionSample = { at: string; counts: Record<string, number> };

/** 관측 줄의 값에서 시간별 수를 꺼낸다 — 모양이 어긋난 것은 버린다 */
export function readAttentionHistory(value: unknown): AttentionSample[] {
  const samples = (value as { samples?: unknown } | null)?.samples;
  if (!Array.isArray(samples)) return [];
  return samples.filter((sample): sample is AttentionSample => typeof sample?.at === 'string'
    && !Number.isNaN(Date.parse(sample.at)) && typeof sample.counts === 'object' && sample.counts !== null)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * 견줄 기준 — 24시간(조금 넘어도) 안에서 가장 오래된 것. 1시간이 안 된 것은 기준으로 삼지 않는다(변화가 없어 보인다).
 * 기록이 하루가 안 되면(배포 직후·아무도 안 연 날) 있는 것 중 가장 오래된 것이고, 화면은 그 시간만큼의 변화라고 적는다.
 */
export function attentionBaseline(samples: AttentionSample[], now: Date): AttentionSample | null {
  const at = now.getTime();
  return samples.find((sample) => {
    const age = at - Date.parse(sample.at);
    return age >= 3_600_000 && age <= 24.5 * 3_600_000;
  }) ?? null;
}

/**
 * 이번 시간의 수를 덧붙인다. 마지막 것이 55분이 안 됐으면 그대로 둔다.
 * 웹 두 대가 같은 때 부를 수 있어 줄을 잠그고 다시 읽은 뒤 적는다(observeService 와 같은 방식).
 */
export async function recordAttentionSample(counts: Record<string, number>, now = new Date()): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.insert(operationsObservations).values({ key: ATTENTION_HISTORY_KEY, value: { samples: [] }, observedAt: now })
      .onConflictDoNothing();
    const [row] = await tx.select().from(operationsObservations)
      .where(eq(operationsObservations.key, ATTENTION_HISTORY_KEY)).for('update');
    const samples = readAttentionHistory(row?.value);
    const last = samples.at(-1);
    if (last && now.getTime() - Date.parse(last.at) < SAMPLE_EVERY_MS) return false;
    const kept = samples.filter((sample) => now.getTime() - Date.parse(sample.at) <= KEEP_MS);
    await tx.update(operationsObservations)
      .set({ value: { samples: [...kept, { at: now.toISOString(), counts }] }, observedAt: now })
      .where(eq(operationsObservations.key, ATTENTION_HISTORY_KEY));
    return true;
  });
}

export type AttentionAck = { key: string; actor: string; at: Date; until: Date };

/**
 * 지금 숨겨 둔 항목 — 항목마다 7일 안의 확인함·다시 보이기 중 가장 최근 줄이 확인함이면 숨김.
 * (action, created_at) 색인을 탄다. 시각 비교는 DB 시계로 한다(작업 로그의 created_at 이 DB 시계다).
 */
export async function attentionAcks(): Promise<Map<string, AttentionAck>> {
  const rows = await db.selectDistinctOn([operationsAudit.target], {
    key: operationsAudit.target, action: operationsAudit.action, actor: operationsAudit.actor, at: operationsAudit.createdAt,
    until: sql`${operationsAudit.createdAt} + ${ACK_DAYS}::int * interval '1 day'`.mapWith(operationsAudit.createdAt),
  }).from(operationsAudit)
    .where(and(inArray(operationsAudit.action, [ACK_ACTION, UNACK_ACTION]), eq(operationsAudit.ok, true),
      gt(operationsAudit.createdAt, sql`now() - ${ACK_DAYS}::int * interval '1 day'`)))
    .orderBy(operationsAudit.target, desc(operationsAudit.createdAt), desc(operationsAudit.id));
  return new Map(rows.filter((row) => row.action === ACK_ACTION)
    .map((row) => [row.key, { key: row.key, actor: row.actor, at: row.at, until: row.until }]));
}
