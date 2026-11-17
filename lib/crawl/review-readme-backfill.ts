import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { operationsAudit } from "@/lib/db/schema";
import { README_SAMPLE_VERSION } from "./readme";
import { loadReviewDocument, reviewReadmeState } from "./jobs/review-document";

/**
 * README 없이 1차 판단 보류(ambiguous)가 된 후보에 README 를 붙인다(2026-11-17, 설치형 보류 535건).
 *
 * 1차는 「지금 입력에서 이미 시도한 후보」를 다시 고르지 않는다(currentReviewSource — 스냅숏 README 와 원본 README 를 대조).
 * 원본에 README 가 없으면 두 쪽이 모두 빈 글자라 보류가 그대로 남는다. 원본에 README 를 붙이면 입력이 달라져 그 후보는
 * 다음 1차 틱에서 README 를 보고 다시 심사된다(1차 고르기·재시도 상한·순위는 그대로). 이 도구는 README 를 붙이기만 하고
 * 후보 상태·시도 행·작업은 건드리지 않는다. 받는 길은 1차 심사와 같다(loadReviewDocument: raw.githubusercontent.com, GitHub API 0회).
 */
export type ReviewReadmeBackfillScope = { withUrl?: boolean };

function heldWithoutReadme(scope: ReviewReadmeBackfillScope) {
  return sql`c.state = 'needs_review' AND c.reason = 'ambiguous' AND c.decided_by = 'auto' AND c.published_slug IS NULL
    ${scope.withUrl ? sql`` : sql`AND d.product_url IS NULL`}
    AND NOT (jsonb_typeof(d.page_meta->'readmeSample') = 'string'
      AND d.page_meta->>'readmeSampleVersion' IS NOT DISTINCT FROM ${README_SAMPLE_VERSION})
    AND (SELECT coalesce(a.snapshot->'product'->>'readme', '') FROM crawl_review_attempts a
      WHERE a.candidate_id = c.id AND a.kind = 'automatic' AND a.state = 'succeeded'
      ORDER BY a.id DESC LIMIT 1) = ''`;
}

/** 읽기만 한다 — 대상 수(설치형·주소 있음)와 지금 기다리는 README 받기 실패 수 */
export async function countReviewReadmeBackfill() {
  const [row] = await db.execute<{ installable: number; with_url: number; waiting: number }>(sql`
    SELECT count(*) FILTER (WHERE d.product_url IS NULL)::int AS installable,
           count(*) FILTER (WHERE d.product_url IS NOT NULL)::int AS with_url,
           count(*) FILTER (WHERE d.page_meta ? 'readmeFetchError')::int AS waiting
      FROM crawl_candidates c JOIN crawl_documents d ON d.repo = c.repo
     WHERE ${heldWithoutReadme({ withUrl: true })}`);
  return { installable: row?.installable ?? 0, withUrl: row?.with_url ?? 0, readmeFetchFailed: row?.waiting ?? 0 };
}

/**
 * 대상 후보마다 README 를 받아 원본 옆에 붙인다(차례대로, intervalMs 간격). 결과 수를 operations_audit 한 줄에 남긴다.
 * attached = README 글이 붙음 → 다음 1차 틱이 다시 심사, absent = README 가 정말 없음("" — 입력은 그대로라 보류 유지),
 * failed = 받지 못함(까닭이 원본에 남고 1차가 기다린 뒤 다시 받는다), changed = 그사이 원본이 바뀜(다음 1차가 새 원본으로 받는다).
 */
export async function applyReviewReadmeBackfill(input: { limit: number; actor: string; intervalMs?: number } & ReviewReadmeBackfillScope) {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) throw new Error("review_readme_backfill_invalid_limit");
  if (!/^[\w.@:-]{1,120}$/.test(input.actor)) throw new Error("review_readme_backfill_invalid_actor");
  const rows = await db.execute<{ repo: string }>(sql`
    SELECT c.repo FROM crawl_candidates c JOIN crawl_documents d ON d.repo = c.repo
     WHERE ${heldWithoutReadme(input)} ORDER BY c.id LIMIT ${input.limit}`);
  const counts = { attached: 0, absent: 0, failed: 0, changed: 0 };
  for (const [index, { repo }] of [...rows].entries()) {
    if (index && input.intervalMs) await new Promise(resolve => setTimeout(resolve, input.intervalMs));
    const document = await loadReviewDocument(repo);
    const sample = document?.pageMeta?.readmeSample;
    if (document && typeof sample === "string" && document.pageMeta?.readmeSampleVersion === README_SAMPLE_VERSION)
      counts[sample ? "attached" : "absent"]++;
    else if (document && reviewReadmeState(document).kind !== "ready") counts.failed++;
    else counts.changed++;
  }
  await db.insert(operationsAudit).values({ actor: input.actor, actorKind: "local", action: "review-readme-backfill",
    target: "crawl_documents", detail: { examined: rows.length, ...counts, withUrl: Boolean(input.withUrl) } });
  return { examined: rows.length, ...counts };
}
