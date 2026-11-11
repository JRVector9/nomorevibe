import { and, asc, inArray, isNull, like, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { cdnPurges, operationsObservations } from "@/lib/db/schema";
import { withJobLeaseWrite } from "@/lib/jobs/control";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import {
  DETAIL_REFRESH_PURGES, HTML_TAG, PURGE_BATCH, purgeByTags, purgeConfig, purgesLists, purgeTags, type PurgeConfig,
} from "@/lib/cdn/purge";

/**
 * 원 서버가 아직 옛 내용을 들고 있으면 지운 자리가 곧 다시 채워진다(진행 중이던 백그라운드 갱신 등).
 * 그래서 한 번 지우고 60초 뒤에 한 번 더 지운다.
 */
export const CONFIRM_AFTER_SECONDS = 60;

/**
 * 웹 릴리스가 바뀐 뒤 옛 HTML 지우기(2026-11-11).
 *
 * 엣지가 들고 있는 옛 HTML·RSC 는 옛 빌드의 JS·CSS 이름을 가리키고, 새 이미지에는 바뀐 파일의 옛 이름이 없다. 엣지는 그 사본을
 * 최대 5분(next.config.ts) 더 주므로 배포 뒤 한 번 지운다. 배포 도구(deploy_shared_images.py
 * purge_html)도 같은 일을 하지만 지우기 토큰이 macOS 키체인에만 있어 Linux 운영 호스트에서는 매번 건너뛰었다(no_purge_token).
 * 그래서 토큰을 가진 발행 워커가 웹의 생존 관측(service:app:*, 15초마다, lib/operations/web-observer.ts)을 보고 한다:
 * 지난 WEB_FRESH_SECONDS 안에 관측된 웹이 모두 같은 릴리스를 말하고 그것이 지난번에 지운 릴리스와 다르면 html 태그를 지운다.
 * 롤링 중 옛 컨테이너가 아직 관측을 남기면 릴리스가 갈려 기다린다. 같은 인스턴스 이름의 옛·새 컨테이너가 겹쳐 돈 사이에 옛 HTML 이
 * 다시 채워질 수 있어 HTML_CONFIRM_AFTER_SECONDS 뒤 한 번 더 지운다. 정적 파일(/_next/static)은 지우지 않는다 — 내용 해시 이름이다.
 */
export const WEB_FRESH_SECONDS = 60;
export const HTML_CONFIRM_AFTER_SECONDS = 120;
const WEB_OBSERVATION_PREFIX = "service:app:";

/** 마지막으로 html 을 지운 웹 릴리스 — 잡 커서에 둔다(없으면 지금 릴리스를 한 번 지운다) */
export type CdnPurgeCursor = { html?: { release: string; purgedAt: string; confirmedAt?: string } };

/**
 * 먼저 지울 줄 — 상태가 공개에서 빠진 것(트리거 0057)·내려달라는 요청이 앞이다. 감사 보류를 걸고 푼 줄(audit_hold·audit_release)은
 * 목록이 늦게 바뀌어도 되는 몫, 상세만 새로 받는 줄(edited·status, lib/cdn/purge.ts)은 그 뒤다.
 */
const PRIORITY = sql`case
  when ${cdnPurges.reason} in (${sql.join([...DETAIL_REFRESH_PURGES].map((reason) => sql`${reason}`), sql`, `)}) then 2
  when ${cdnPurges.reason} in ('audit_hold', 'audit_release') then 1
  else 0 end`;

/** 지금 웹이 모두 같은 릴리스면 그 값 — 관측이 없거나 갈리면 null */
export async function agreedWebRelease(): Promise<string | null> {
  const rows = await db.select({ release: sql<string | null>`${operationsObservations.value}->>'release'` })
    .from(operationsObservations)
    // 관측 시각은 시간대 없는 UTC 벽시계다(DB 세션도 UTC) — 다른 관측 판정과 같은 localtimestamp 로 잰다
    .where(and(like(operationsObservations.key, `${WEB_OBSERVATION_PREFIX}%`),
      sql`${operationsObservations.observedAt} >= localtimestamp - make_interval(secs => ${WEB_FRESH_SECONDS})`));
  const releases = new Set(rows.map((row) => row.release?.trim() ?? ""));
  if (releases.size !== 1) return null;
  const [release] = releases;
  return release && release !== "unknown" ? release : null;
}

async function purgeHtmlAfterWebRelease(ctx: JobContext<CdnPurgeCursor>, config: PurgeConfig, fetchImpl: typeof fetch | undefined,
  cursor: CdnPurgeCursor): Promise<CdnPurgeCursor> {
  const release = await agreedWebRelease();
  if (!release) return cursor;
  const marked = cursor.html;
  const now = Date.now();
  const first = marked?.release !== release;
  const confirm = !first && marked !== undefined && !marked.confirmedAt
    && now - Date.parse(marked.purgedAt) >= HTML_CONFIRM_AFTER_SECONDS * 1000;
  if (!first && !confirm) return cursor;
  const result = await purgeByTags(config, [HTML_TAG], fetchImpl);
  if (!result.ok) {
    ctx.log("cdn_purge.html_failed", { release, status: result.status, error: result.error });
    return cursor;
  }
  ctx.log("cdn_purge.html", { release, step: first ? "purged" : "confirmed" });
  const at = new Date(now).toISOString();
  return { ...cursor, html: first || !marked ? { release, purgedAt: at } : { ...marked, confirmedAt: at } };
}

/**
 * 내려간 제품을 Cloudflare 에서 지운다 — DB 트리거가 적은 cdn_purges 를 틱마다 한 요청으로 모아 보낸다.
 * 사람이 고친 제품의 상세(edited·status, lib/cdn/detail-purge.ts)도 같은 줄로 지우되, 그런 줄뿐이면 목록은 지우지 않는다.
 * 실패하면 행을 그대로 두고 다음 틱에 다시 보낸다(시도 수·마지막 오류만 남긴다). 설정이 없으면 쌓아만 둔다.
 * 웹 릴리스가 바뀌었으면 먼저 옛 HTML 을 지운다(위). 한 틱의 지우기 요청은 많아야 둘이다(Free: 계정 분당 5회).
 */
export async function purgeRemovedProducts(
  ctx: JobContext<CdnPurgeCursor>,
  deps: { config?: PurgeConfig | null; fetch?: typeof fetch } = {},
): Promise<JobOutcome<CdnPurgeCursor>> {
  // 커서를 늘 돌려준다 — done 만 돌려주면 러너가 커서를 비워 지운 릴리스를 잊는다(lib/jobs/runner.ts)
  let cursor: CdnPurgeCursor = ctx.cursor ?? {};
  const config = deps.config === undefined ? purgeConfig() : deps.config;
  if (config) cursor = await purgeHtmlAfterWebRelease(ctx, config, deps.fetch, cursor);

  const due = await db.select({ id: cdnPurges.id, slug: cdnPurges.slug, reason: cdnPurges.reason, purgedAt: cdnPurges.purgedAt })
    .from(cdnPurges)
    .where(and(isNull(cdnPurges.confirmedAt), or(
      isNull(cdnPurges.purgedAt),
      sql`${cdnPurges.purgedAt} < now() - ${CONFIRM_AFTER_SECONDS} * interval '1 second'`,
    )))
    .orderBy(PRIORITY, asc(cdnPurges.id))
    .limit(PURGE_BATCH);
  if (due.length === 0) return { done: true, cursor };

  if (!config) {
    ctx.log("cdn_purge.unconfigured", { pending: due.length });
    return { done: true, cursor };
  }

  const ids = due.map((row) => row.id);
  const tags = purgeTags(due.map((row) => row.slug), { lists: purgesLists(due.map((row) => row.reason)) });
  const result = await purgeByTags(config, tags, deps.fetch);
  if (!result.ok) {
    await withJobLeaseWrite(ctx.lease, (tx) => tx.update(cdnPurges)
      .set({ attempts: sql`${cdnPurges.attempts} + 1`, lastError: result.error })
      .where(inArray(cdnPurges.id, ids)));
    ctx.log("cdn_purge.failed", { status: result.status, error: result.error, products: due.length });
    return { done: true, cursor };
  }

  const first = due.filter((row) => !row.purgedAt).map((row) => row.id);
  const again = due.filter((row) => row.purgedAt).map((row) => row.id);
  await withJobLeaseWrite(ctx.lease, async (tx) => {
    if (first.length) await tx.update(cdnPurges).set({ purgedAt: sql`now()`, lastError: null }).where(inArray(cdnPurges.id, first));
    if (again.length) await tx.update(cdnPurges).set({ confirmedAt: sql`now()`, lastError: null }).where(inArray(cdnPurges.id, again));
  });
  ctx.log("cdn_purge.done", { purged: first.length, confirmed: again.length });
  return { done: true, cursor };
}
