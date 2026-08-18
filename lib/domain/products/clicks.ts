import { and, gte, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clickEvents } from "@/lib/db/schema";
import { rateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/observability/logger";

/**
 * 아웃바운드 클릭.
 *
 * 지표가 있어야 랭킹이 생긴다. 다만 세는 것 자체가 어뷰징 대상이므로, 같은 사람이 연타한
 * 것을 한 번으로 묶는다 — 한 번 누른 것과 백 번 누른 것이 같은 무게일 수는 없다.
 */

/** 같은 클라이언트의 같은 제품 클릭을 이 시간 안에서는 한 번으로 본다 */
const DEDUPE_MS = 10 * 60 * 1000;

/**
 * 클릭 기록. 이미 센 클릭이면 조용히 넘긴다.
 *
 * 기록 실패가 이동을 막아서는 안 된다 — 지표는 부가물이고 사용자는 제품으로 가는 중이다.
 */
export async function recordClick(slug: string, client: string): Promise<void> {
  try {
    const fresh = await rateLimit(`click:${slug}:${client}`, 1, DEDUPE_MS);
    if (!fresh) return;
    await db.insert(clickEvents).values({ slug });
  } catch (error) {
    logger.warn("click.record_failed", { slug, error });
  }
}

/** 창 안의 클릭 수 (지금부터 과거 windowMs 동안) */
export async function clicksSince(slug: string, windowMs: number, offsetMs = 0): Promise<number> {
  const end = new Date(Date.now() - offsetMs);
  const start = new Date(end.getTime() - windowMs);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(clickEvents)
    .where(
      and(
        sql`${clickEvents.slug} = ${slug}`,
        gte(clickEvents.occurredAt, start),
        lt(clickEvents.occurredAt, end),
      ),
    );
  return row?.count ?? 0;
}
