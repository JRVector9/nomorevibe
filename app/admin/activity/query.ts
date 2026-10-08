import { and, desc, eq, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, operationsAudit } from "@/lib/db/schema";
import { ADMIN_LOG_PAGE_SIZE } from "@/lib/operations/admin-log";
import { ACTION_GROUPS, type ActionGroup } from "./labels";

/**
 * 작업 로그 읽기 — 화면과 내보내기(/admin/export?view=activity)가 같이 쓴다.
 * 거르기는 lib/operations/admin-log adminLog 와 같고, 대상(target)으로 찾기를 더했다(2026-10-08 UX 감사 ADM-20).
 */
export type ActivityFilter = { actions?: string[]; actor?: string; failedOnly?: boolean; before?: number; target?: string };

type Params = { group?: string | null; actor?: string | null; failed?: string | null; before?: string | null; target?: string | null };

/** 주소의 거르기(?group·actor·failed·before·target)를 읽는다 — 화면과 내보내기가 같은 결과를 내게 */
export function activityFilter(params: Params): ActivityFilter & { group: ActionGroup | null; failedOnly: boolean } {
  const group = params.group && Object.hasOwn(ACTION_GROUPS, params.group) ? params.group as ActionGroup : null;
  const parsedBefore = Number(params.before);
  return {
    group, actions: group ? [...ACTION_GROUPS[group].actions] : undefined,
    actor: params.actor?.slice(0, 120) || undefined,
    failedOnly: params.failed === "1",
    // id 는 serial(int4)이다 — 그보다 큰 값을 넘기면 DB 가 범위 오류를 내 화면이 깨진다
    before: Number.isSafeInteger(parsedBefore) && parsedBefore > 0 && parsedBefore <= 2_147_483_647 ? parsedBefore : undefined,
    target: normalizeTarget(params.target) || undefined,
  };
}

export async function activityLog(filter: ActivityFilter = {}, limit = ADMIN_LOG_PAGE_SIZE) {
  const where: SQL[] = [];
  if (filter.actions?.length) where.push(inArray(operationsAudit.action, filter.actions));
  if (filter.actor) where.push(eq(operationsAudit.actor, filter.actor));
  if (filter.failedOnly) where.push(eq(operationsAudit.ok, false));
  if (filter.before) where.push(lt(operationsAudit.id, filter.before));
  if (filter.target) where.push(await targetCondition(filter.target));
  return db.select().from(operationsAudit).where(where.length ? and(...where) : undefined)
    .orderBy(desc(operationsAudit.id)).limit(limit);
}

/**
 * 찾는 대상 다듬기 — 앞뒤 공백을 떼고, GitHub 주소를 붙여 넣었으면 owner/repo 로 줄인다. 대상 칸(200자)을 넘으면 자른다.
 */
export function normalizeTarget(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  const github = value.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+\/[^/\s?#]+)/i);
  return (github ? github[1].replace(/\.git$/i, "") : value).replace(/\/+$/, "").slice(0, 200);
}

/**
 * 한 제품·저장소의 기록을 찾는 조건. 대상이 지금 어떻게 남는지에 맞춘다:
 *
 * - target 칸 그대로(대소문자 무시) — 제품 행동은 slug(차단·내리기·감사·요청·업데이트), 후보 행동은 owner/repo(승인·거부·
 *   근거·분류·중복 정리·다시 판정)로 남는다.
 * - slug ↔ 저장소를 서로 잇는다 — 발행된 후보(crawl_candidates.published_slug)로. slug 로 찾아도 그 저장소의 후보 심사 기록이,
 *   저장소로 찾아도 발행된 제품의 기록이 함께 나온다.
 * - 스크립트의 일괄 줄 — 제품 여러 건(detail.slugs, 예: ban-spam-campaign)과 후보 여러 건(target 이 crawl_candidates 이고
 *   detail.ids 에 후보 id, 예: requeue-evidence-gated·relabel-repo-deleted).
 *
 * 찾지 못하는 것: 수만 남긴 일괄 줄(requeue-resolved·requeue-rejected-* 처럼 id 없이 건수만), 소식(news:id)·감사 회차(campaign:id)·
 * 설정처럼 제품이 아닌 대상, 메이커가 직접 올려 후보가 없는 제품의 저장소 이름. 부분 일치는 하지 않는다 — 대상 하나를 정확히 찾는다.
 */
export async function targetCondition(raw: string): Promise<SQL> {
  const target = normalizeTarget(raw);
  const key = target.toLowerCase();
  const keys = new Set([key]);
  const slugs = new Set<string>();
  const candidateIds = new Set<number>();
  const linked = key.includes("/")
    ? await db.select({ id: crawlCandidates.id, repo: crawlCandidates.repo, slug: crawlCandidates.publishedSlug }).from(crawlCandidates)
      .where(sql`lower(${crawlCandidates.repo}) = ${key}`)
    : await db.select({ id: crawlCandidates.id, repo: crawlCandidates.repo, slug: crawlCandidates.publishedSlug }).from(crawlCandidates)
      .where(eq(crawlCandidates.publishedSlug, target));
  if (!key.includes("/")) slugs.add(target);
  for (const row of linked) {
    candidateIds.add(row.id);
    keys.add(row.repo.toLowerCase());
    if (row.slug) { keys.add(row.slug.toLowerCase()); slugs.add(row.slug); }
  }
  const conditions: SQL[] = [inArray(sql`lower(${operationsAudit.target})`, [...keys])];
  for (const slug of slugs) conditions.push(sql`${operationsAudit.detail}->'slugs' @> jsonb_build_array(${slug}::text)`);
  for (const id of candidateIds) {
    conditions.push(sql`(${operationsAudit.target} = 'crawl_candidates' and ${operationsAudit.detail}->'ids' @> jsonb_build_array(${id}::int))`);
  }
  return or(...conditions)!;
}
