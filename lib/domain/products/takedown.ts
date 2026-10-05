import { createHmac } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ogImages, products, takedownRequests, type TakedownRequest } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";
import { type Result, ok, fail } from "./errors";
import { isUnclaimed } from "./view";
import { lockProductGeneration } from "./generation";
import * as repo from "./repository";
import { isDismissReason, type DismissReason, type TakedownEntry, type TakedownSummary } from "./takedown-view";

/**
 * 내려달라는 요청.
 *
 * 우리가 대신 올린 제품은 주인이 부탁한 적이 없다. 상세 페이지에 "원치 않으시면
 * 내려드립니다"라고 적어 두고 정작 말할 곳이 없으면 그 약속은 거짓말이 된다.
 *
 * 소유 증명을 요구하지 않는다. 증명을 받으려면 우리 토큰을 그 사이트에 올리라고 해야 하는데,
 * 내려달라는 사람에게 먼저 뭔가를 붙이라고 할 수는 없다. 대신 사람이 보고 처리한다.
 */

const MAX_REASON = 500;
const MAX_NOTE = 1000;

/**
 * 보낸이 해시 — 접속 주소를 그대로 두지 않고 서버 비밀값으로 해시한다. 방문자 해시(slug + "\0" + 방문자)와
 * 섞이지 않게 slug 에 올 수 없는 ":" 를 넣은 머리를 붙인다 — 같은 주소라도 방문 기록과 이어 볼 수 없다.
 * 주소를 모르면(신뢰 프록시 없음) null.
 */
export function takedownRequesterHash(ip: string | null, secret = process.env.VISITOR_HASH_SECRET): string | null {
  if (!ip || !secret || secret.length < 32) return null;
  return createHmac("sha256", secret).update("takedown:requester\0").update(ip).digest("hex");
}

export async function requestTakedown(
  slug: string,
  reason?: string | null,
  requesterHash: string | null = null,
): Promise<Result<{ slug: string }>> {
  const product = await repo.findBySlug(slug);
  if (!product || product.status === "banned") return fail({ kind: "not_found" });

  /**
   * 주인이 있는 제품은 이 창구가 아니다. 수정 키로 스스로 지울 수 있고, 남이 내려달라고
   * 요청할 수 있게 두면 멀쩡한 제품을 흔드는 길이 된다.
   */
  if (!isUnclaimed(product)) {
    return fail({
      kind: "forbidden",
      message: "주인이 있는 제품입니다. 수정 키로 직접 삭제할 수 있습니다",
    });
  }

  const trimmed = reason?.trim().slice(0, MAX_REASON) || null;
  const values = { slug, reason: trimmed, requestedAt: new Date(), requesterHash };
  // 같은 제품에 여러 번 오면 최신 요청 하나로 남긴다 — 큐가 같은 항목으로 차지 않게. 몇 번 왔는지와 지난 처리 결과만 남긴다
  await db
    .insert(takedownRequests)
    .values(values)
    .onConflictDoUpdate({
      target: takedownRequests.slug,
      set: {
        ...values, handledAt: null, handledBy: null, outcome: null, dismissReason: null, note: null,
        requestCount: sql`${takedownRequests.requestCount} + 1`,
        previousOutcome: sql`coalesce(${takedownRequests.outcome}, ${takedownRequests.previousOutcome})`,
      },
    });

  logger.info("takedown.requested", { slug, url: product.url });
  return ok({ slug });
}

/** 아직 사람이 보지 않은 요청 */
export async function pendingTakedowns(limit = 50): Promise<TakedownRequest[]> {
  return db
    .select()
    .from(takedownRequests)
    .where(isNull(takedownRequests.handledAt))
    .orderBy(desc(takedownRequests.requestedAt))
    .limit(limit);
}

/** UTC 로 저장된 시각을 같은 시계로 잰다(시각 열은 시간대 없이 UTC — JS Date 로 쓴다) */
const NOW = sql`(current_timestamp at time zone 'UTC')`;
const GITHUB_OWNER = (column: unknown) => sql`case when ${column} ~* '^https?://(www\.)?github\.com/[^/]+'
  then lower(split_part(regexp_replace(${column}, '^https?://(www\.)?github\.com/', '', 'i'), '/', 1)) end`;

/**
 * 처리 화면의 줄 — 대기 요청에 제품·계정·보낸이·방문을 붙인다. 오래 기다린 것부터.
 *
 * 계정의 공개 제품 수는 대기 요청에 나온 계정만 센다(제품 3만 건 전체를 계정별로 묶지 않는다).
 */
export async function takedownQueue(limit = 500): Promise<TakedownEntry[]> {
  const rows = await db.execute<{
    slug: string; reason: string | null; requested_iso: string; age_hours: number; requester_hash: string | null;
    request_count: number; previous_outcome: string | null; name: string | null; url: string | null; repo_url: string | null;
    category: string | null; listed_iso: string | null; status: string | null; stars: number | null; owner: string | null;
    owner_public: number; owner_pending: number; sender_pending: number; visits7d: number;
  }>(sql`
    with pending as (
      select t.*, extract(epoch from (${NOW} - t.requested_at)) / 3600 as age_hours
      from takedown_requests t where t.handled_at is null order by t.requested_at asc limit ${limit}
    ), enriched as (
      select q.*, p.name, p.url, p.repo_url, p.category, p.status, p.stars,
        to_char(q.requested_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as requested_iso,
        to_char(coalesce(p.verified_at, p.created_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as listed_iso,
        ${GITHUB_OWNER(sql`p.repo_url`)} as owner
      from pending q left join products p on p.slug = q.slug
    ), owners as (
      select distinct owner from enriched where owner is not null
    ), owner_public as (
      select o.owner, count(*)::int as n from owners o
      join products p on lower(p.repo_url) like 'https://github.com/' || o.owner || '/%' and p.status in ('seeded', 'verified')
      group by o.owner
    )
    select e.*, coalesce(op.n, 0)::int as owner_public,
      (select count(*) from enriched x where e.owner is not null and x.owner = e.owner)::int as owner_pending,
      (select count(*) from enriched x where e.requester_hash is not null and x.requester_hash = e.requester_hash)::int as sender_pending,
      coalesce((select sum(d.unique_visitors) from product_click_daily d where d.slug = e.slug and d.day > current_date - 7), 0)::int as visits7d
    from enriched e left join owner_public op on op.owner = e.owner
    order by e.requested_at asc
  `);
  // 시각은 SQL 에서 ISO(UTC)로 만든다 — 시간대 없는 열을 노드가 Date 로 읽으면 서버 시간대만큼 밀린다
  return rows.map((row) => ({
    slug: row.slug, reason: row.reason, requestedAt: row.requested_iso, ageHours: Number(row.age_hours),
    requesterHash: row.requester_hash, requestCount: Number(row.request_count), previousOutcome: row.previous_outcome,
    product: row.name === null ? null : { name: row.name, url: row.url ?? "", repoUrl: row.repo_url, category: row.category ?? "",
      listedAt: row.listed_iso ?? "", status: row.status ?? "", stars: row.stars },
    owner: row.owner, ownerPublic: Number(row.owner_public), ownerPending: Number(row.owner_pending),
    senderPending: Number(row.sender_pending), visits7d: Number(row.visits7d),
  }));
}

/** 메뉴 배지·심사 큐 띠·운영센터 조치·처리 화면 머리가 함께 쓰는 숫자 */
export async function takedownSummary(): Promise<TakedownSummary> {
  const [row] = await db.execute<{
    pending: number; overdue: number; oldest_hours: number | null; removed24h: number; dismissed24h: number;
    removed30d: number; dismissed30d: number; last_hour: number; senders: number; no_reason: number;
  }>(sql`
    select count(*) filter (where handled_at is null)::int as pending,
      count(*) filter (where handled_at is null and requested_at <= ${NOW} - interval '24 hours')::int as overdue,
      (max(extract(epoch from (${NOW} - requested_at))) filter (where handled_at is null)) / 3600 as oldest_hours,
      count(*) filter (where handled_at > ${NOW} - interval '24 hours' and outcome = 'removed')::int as removed24h,
      count(*) filter (where handled_at > ${NOW} - interval '24 hours' and outcome = 'dismissed')::int as dismissed24h,
      count(*) filter (where handled_at > ${NOW} - interval '30 days' and outcome = 'removed')::int as removed30d,
      count(*) filter (where handled_at > ${NOW} - interval '30 days' and outcome = 'dismissed')::int as dismissed30d,
      count(*) filter (where requested_at > ${NOW} - interval '1 hour')::int as last_hour,
      count(distinct requester_hash) filter (where requested_at > ${NOW} - interval '1 hour')::int as senders,
      count(*) filter (where requested_at > ${NOW} - interval '1 hour' and reason is null)::int as no_reason
    from takedown_requests`);
  let owners = 0;
  let topReason: { text: string; count: number } | null = null;
  if (Number(row.last_hour) > 0) {
    const [ownerRow] = await db.execute<{ owners: number }>(sql`
      select count(distinct ${GITHUB_OWNER(sql`p.repo_url`)})::int as owners
      from takedown_requests t join products p on p.slug = t.slug where t.requested_at > ${NOW} - interval '1 hour'`);
    owners = Number(ownerRow?.owners ?? 0);
    const [reasonRow] = await db.execute<{ reason: string; n: number }>(sql`
      select reason, count(*)::int as n from takedown_requests
      where requested_at > ${NOW} - interval '1 hour' and reason is not null group by reason order by n desc limit 1`);
    topReason = reasonRow ? { text: reasonRow.reason, count: Number(reasonRow.n) } : null;
  }
  return {
    pending: Number(row.pending), overdue: Number(row.overdue), oldestHours: row.oldest_hours === null ? null : Number(row.oldest_hours),
    handled24h: { removed: Number(row.removed24h), dismissed: Number(row.dismissed24h) },
    last30d: { removed: Number(row.removed30d), dismissed: Number(row.dismissed30d) },
    lastHour: { requests: Number(row.last_hour), owners, senders: Number(row.senders), noReason: Number(row.no_reason), topReason },
  };
}

/** 처리 기록 — 최근에 처리한 것부터 */
export async function takedownHistory(limit = 100) {
  return db.select({
    slug: takedownRequests.slug, reason: takedownRequests.reason, requestedAt: takedownRequests.requestedAt,
    handledAt: takedownRequests.handledAt, handledBy: takedownRequests.handledBy, outcome: takedownRequests.outcome,
    dismissReason: takedownRequests.dismissReason, note: takedownRequests.note, requestCount: takedownRequests.requestCount,
    requesterHash: takedownRequests.requesterHash, name: products.name, url: products.url,
  }).from(takedownRequests).leftJoin(products, eq(products.slug, takedownRequests.slug))
    .where(isNotNull(takedownRequests.handledAt)).orderBy(desc(takedownRequests.handledAt)).limit(limit);
}

export type TakedownAction = "remove" | "dismiss";
export type TakedownResolution = { dismissReason?: DismissReason | null; note?: string | null };

/**
 * 요청 처리.
 *
 * 내릴 때 행을 지우지 않고 banned로 둔다. 지우면 수집기가 다음 바퀴에 같은 URL을 다시 주워
 * 올린다 — 내려달라고 한 사람에게 그것만큼 무례한 일이 없다.
 */
export async function resolveTakedown(
  slug: string,
  action: TakedownAction,
  admin: string,
  resolution: TakedownResolution = {},
): Promise<Result<{ slug: string; action: TakedownAction }>> {
  // 둘 때만 이유가 뜻이 있다. 모르는 값은 받지 않는다(화면이 고르는 넷 중 하나)
  if (action === "dismiss" && resolution.dismissReason && !isDismissReason(resolution.dismissReason)) {
    return fail({ kind: "invalid", message: "알 수 없는 이유입니다" });
  }
  const note = resolution.note?.trim().slice(0, MAX_NOTE) || null;
  const result = await db.transaction(async (tx): Promise<Result<{ slug: string; action: TakedownAction }>> => {
    const [product] = await tx.select({ id: products.id }).from(products).where(eq(products.slug, slug));
    // Lifecycle writers lock the product before its related rows. Keep that order here too.
    if (product && !(await lockProductGeneration(tx, product.id, slug))) return fail({ kind: "not_found" });
    if (!product && action === "remove") return fail({ kind: "not_found" });
    const [request] = await tx.select().from(takedownRequests)
      .where(and(eq(takedownRequests.slug, slug), isNull(takedownRequests.handledAt))).for("update");
    if (!request) return fail({ kind: "not_found" });

    if (action === "remove" && product) {
      const banned = await repo.setStatusWithAudit({ id: product.id, slug, status: "banned", action: "admin.product.ban" }, tx);
      if (!banned) return fail({ kind: "not_found" });
      await tx.delete(ogImages).where(eq(ogImages.slug, slug));
    }

    await tx.update(takedownRequests)
      .set({ handledAt: new Date(), handledBy: admin, outcome: action === "remove" ? "removed" : "dismissed",
        dismissReason: action === "dismiss" ? resolution.dismissReason ?? null : null, note })
      .where(eq(takedownRequests.slug, slug));
    return ok({ slug, action });
  });

  if (result.ok) logger.info("takedown.resolved", { slug, action, admin });
  return result;
}

/**
 * 여러 건 한 번에 — 한 건씩 같은 검사(행 잠금·이미 처리됨)를 받는다. 그 사이 바뀐 것만 실패로 돌려준다.
 */
export async function resolveTakedowns(
  slugs: string[],
  action: TakedownAction,
  admin: string,
  resolution: TakedownResolution = {},
): Promise<{ done: string[]; failed: { slug: string; message: string }[] }> {
  const done: string[] = [];
  const failed: { slug: string; message: string }[] = [];
  for (const slug of [...new Set(slugs)]) {
    const result = await resolveTakedown(slug, action, admin, resolution);
    if (result.ok) done.push(slug);
    else failed.push({ slug, message: result.error.kind === "not_found" ? "이미 처리됐거나 제품이 없습니다" : "처리하지 못했습니다" });
  }
  return { done, failed };
}
