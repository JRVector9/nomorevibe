import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, productEvidenceAudit, products } from "@/lib/db/schema";
import { spamSignals, SPAM_DETECTOR_VERSION } from "@/lib/crawl/spam-signals";
import { setStatusWithAudit, SPAM_AUTO_BAN_ACTOR, SPAM_AUTO_BAN_REASON } from "@/lib/domain/products/repository";
import { withJobLeaseWrite } from "@/lib/jobs/control";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";

/**
 * 공개 제품에 스팸·악성 배포 판정(spam-signals.ts)을 다시 태우고, 잡히면 내린다 — 2026-10-08 운영자 결정(자동 차단).
 *
 * 후보는 규칙 판정·AI 심사 직전·발행 직전에 이 판정을 지나지만(#317), 이미 올라간 제품에는 다시 닿지 않는다.
 * 그래서 판정을 고쳐도 이미 공개된 것은 그대로 남았다 — 판정이 생기기 전에 올라간 캠페인 257건이 그렇게 쌓였고,
 * 판정을 고친 뒤 새로 잡힌 3건(랜딩에만 틀 제목을 둔 변형 등)도 공개 중이었다.
 * 판정 버전이 바뀌면 곧바로, 아니면 하루에 한 바퀴 모든 공개분을 다시 본다 — 원본이 다시 수집돼 바뀐 것도 잡힌다.
 *
 * 내리는 길은 관리자 '차단'과 같다(admin.product.ban, 되돌리기는 차단 해제). 감사 행에 actor·reason 을 남겨
 * 어드민 '스팸 자동 차단' 거르기와 하루 한도가 센다. 빼는 것:
 * - 사람이 승인한 후보(decidedBy admin)·스타 자동 승인 — 발행 관문(publish.ts)과 같은 예외
 * - 메이커가 클레임·검증한 제품(verified 포함)
 * - 관리자가 차단을 해제한 적 있는 제품 — 사람이 "유지"라고 한 것을 다시 내리지 않는다
 */
export const RESCAN_BATCH = 1_000;
/**
 * 하루에 자동으로 내리는 최대 수. 판정이 잘못 바뀌어 멀쩡한 제품을 한꺼번에 내리는 일을 막는다 —
 * 넘으면 내리지 않고 기록만 하며, 운영센터가 critical 로 알린다(spamRescanSummary).
 * 2026-10-08 공개 37,298건에서 판정에 걸린 것은 260건(그중 257건은 운영자가 이미 내림)이었다.
 */
export const MAX_AUTO_BANS_PER_DAY = 50;
/** 한 바퀴를 마치면 이만큼 쉰다. 판정 버전이 바뀌면 기다리지 않는다 */
const PASS_INTERVAL_MS = 24 * 60 * 60_000;

export type SpamRescanCursor = { version: string; afterId: number; idleUntil: number | null };

/** 지난 24시간 자동 차단 수 — 시각은 DB 시계로 잰다(created_at 은 시간대 없는 DB 시각) */
async function autoBansLastDay(): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(productEvidenceAudit).where(and(
    eq(productEvidenceAudit.action, "admin.product.ban"), eq(productEvidenceAudit.actor, SPAM_AUTO_BAN_ACTOR),
    eq(productEvidenceAudit.reason, SPAM_AUTO_BAN_REASON), sql`${productEvidenceAudit.createdAt} > now() - interval '24 hours'`,
  ));
  return row?.count ?? 0;
}

export async function rescanPublishedSpam(ctx: JobContext<SpamRescanCursor>): Promise<JobOutcome<SpamRescanCursor>> {
  const now = Date.now();
  const current = ctx.cursor?.version === SPAM_DETECTOR_VERSION ? ctx.cursor : null;
  if (current?.idleUntil && current.idleUntil > now) return { done: true, cursor: current };
  const afterId = current?.afterId ?? 0;

  const rows = await db.select({
    id: products.id, slug: products.slug, status: products.status, claimedAt: products.claimedAt, verifiedAt: products.verifiedAt,
    decidedBy: crawlCandidates.decidedBy,
    starAutoApproved: sql<boolean>`coalesce(${crawlCandidates.signals}->'starAutoApproval' is not null
      and ${crawlCandidates.signals}->'starAutoApproval' <> 'null'::jsonb, false)`,
    unbanned: sql<boolean>`exists (select 1 from ${productEvidenceAudit} a where a.slug = ${products.slug} and a.action = 'admin.product.unban')`,
    repo: crawlDocuments.repo, productUrl: crawlDocuments.productUrl, repoMeta: crawlDocuments.repoMeta, pageMeta: crawlDocuments.pageMeta,
  }).from(products)
    .innerJoin(crawlCandidates, eq(crawlCandidates.publishedSlug, products.slug))
    .innerJoin(crawlDocuments, eq(crawlDocuments.repo, crawlCandidates.repo))
    .where(and(inArray(products.status, ["verified", "seeded"]), gt(products.id, afterId)))
    .orderBy(asc(products.id))
    .limit(RESCAN_BATCH);

  // 한 제품에 후보가 여럿이면(별칭) 하나라도 사람이 승인했으면 뺀다
  const byProduct = new Map<number, typeof rows>();
  for (const row of rows) byProduct.set(row.id, [...(byProduct.get(row.id) ?? []), row]);

  let bansLeft = Math.max(0, MAX_AUTO_BANS_PER_DAY - await autoBansLastDay());
  const banned: string[] = [], exempt: string[] = [], capped: string[] = [];
  let lastId = afterId;
  for (const [id, group] of byProduct) {
    if (!ctx.hasBudget() || ctx.signal?.aborted) break;
    const row = group[0];
    const verdict = spamSignals({ repo: row.repo, repoMeta: row.repoMeta, productUrl: row.productUrl, pageMeta: row.pageMeta });
    if (verdict.flagged) {
      const owned = row.status === "verified" || row.claimedAt !== null || row.verifiedAt !== null;
      if (owned || row.unbanned || group.some((each) => each.decidedBy === "admin" || each.starAutoApproved)) exempt.push(row.slug);
      else if (bansLeft === 0) capped.push(row.slug);
      else if (await withJobLeaseWrite(ctx.lease, (tx) => setStatusWithAudit({
        id, slug: row.slug, status: "banned", action: "admin.product.ban", actor: SPAM_AUTO_BAN_ACTOR, reason: SPAM_AUTO_BAN_REASON,
        metadata: { detector: SPAM_DETECTOR_VERSION, confidence: verdict.confidence, score: verdict.score,
          signals: verdict.signals.map((signal) => signal.key) },
      }, tx))) {
        banned.push(row.slug);
        bansLeft -= 1;
      }
    }
    lastId = id;
  }

  const finished = rows.length < RESCAN_BATCH && lastId === (rows.at(-1)?.id ?? afterId);
  ctx.log("spam_rescan.checked", { detector: SPAM_DETECTOR_VERSION, afterId, checked: byProduct.size, banned, exempt, capped: capped.length });
  if (capped.length) ctx.log("spam_rescan.capped", { limit: MAX_AUTO_BANS_PER_DAY, slugs: capped.slice(0, 50) });
  return { done: true, cursor: finished
    ? { version: SPAM_DETECTOR_VERSION, afterId: 0, idleUntil: now + PASS_INTERVAL_MS }
    : { version: SPAM_DETECTOR_VERSION, afterId: lastId, idleUntil: null } };
}

/** 운영센터 — 지난 24시간 자동 차단 수와 한도에 닿았는지 */
export async function spamRescanSummary(): Promise<{ bannedDay: number; limit: number; capped: boolean }> {
  const bannedDay = await autoBansLastDay();
  return { bannedDay, limit: MAX_AUTO_BANS_PER_DAY, capped: bannedDay >= MAX_AUTO_BANS_PER_DAY };
}
