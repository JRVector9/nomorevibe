import { and, asc, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { cdnPurges } from "@/lib/db/schema";
import { withJobLeaseWrite } from "@/lib/jobs/control";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { PURGE_BATCH, purgeByTags, purgeConfig, purgeTags, type PurgeConfig } from "@/lib/cdn/purge";

/**
 * 원 서버가 아직 옛 내용을 들고 있으면 지운 자리가 곧 다시 채워진다(진행 중이던 백그라운드 갱신 등).
 * 그래서 한 번 지우고 60초 뒤에 한 번 더 지운다.
 */
export const CONFIRM_AFTER_SECONDS = 60;

/**
 * 내려간 제품을 Cloudflare 에서 지운다 — DB 트리거가 적은 cdn_purges 를 틱마다 한 요청으로 모아 보낸다.
 * 실패하면 행을 그대로 두고 다음 틱에 다시 보낸다(시도 수·마지막 오류만 남긴다). 설정이 없으면 쌓아만 둔다.
 */
export async function purgeRemovedProducts(
  ctx: JobContext<null>,
  deps: { config?: PurgeConfig | null; fetch?: typeof fetch } = {},
): Promise<JobOutcome<null>> {
  const due = await db.select({ id: cdnPurges.id, slug: cdnPurges.slug, purgedAt: cdnPurges.purgedAt })
    .from(cdnPurges)
    .where(and(isNull(cdnPurges.confirmedAt), or(
      isNull(cdnPurges.purgedAt),
      sql`${cdnPurges.purgedAt} < now() - ${CONFIRM_AFTER_SECONDS} * interval '1 second'`,
    )))
    .orderBy(asc(cdnPurges.id))
    .limit(PURGE_BATCH);
  if (due.length === 0) return { done: true };

  const config = deps.config === undefined ? purgeConfig() : deps.config;
  if (!config) {
    ctx.log("cdn_purge.unconfigured", { pending: due.length });
    return { done: true };
  }

  const ids = due.map((row) => row.id);
  const result = await purgeByTags(config, purgeTags(due.map((row) => row.slug)), deps.fetch);
  if (!result.ok) {
    await withJobLeaseWrite(ctx.lease, (tx) => tx.update(cdnPurges)
      .set({ attempts: sql`${cdnPurges.attempts} + 1`, lastError: result.error })
      .where(inArray(cdnPurges.id, ids)));
    ctx.log("cdn_purge.failed", { status: result.status, error: result.error, products: due.length });
    return { done: true };
  }

  const first = due.filter((row) => !row.purgedAt).map((row) => row.id);
  const again = due.filter((row) => row.purgedAt).map((row) => row.id);
  await withJobLeaseWrite(ctx.lease, async (tx) => {
    if (first.length) await tx.update(cdnPurges).set({ purgedAt: sql`now()`, lastError: null }).where(inArray(cdnPurges.id, first));
    if (again.length) await tx.update(cdnPurges).set({ confirmedAt: sql`now()`, lastError: null }).where(inArray(cdnPurges.id, again));
  });
  ctx.log("cdn_purge.done", { purged: first.length, confirmed: again.length });
  return { done: true };
}
