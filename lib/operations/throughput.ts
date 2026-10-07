import { and, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlPublicationChanges,
  crawlReviewAttempts, secondReviews } from "@/lib/db/schema";
import { reviewApprovalPredicate, reviewCandidatePredicate, starAutoApprovalPredicate } from "@/lib/crawl/agent-review-repository";
import { SECOND_REVIEW_TRANSIENT_ERRORS, SECOND_REVIEW_RETRY_MS, TRANSIENT_RETRY_MS } from "@/lib/crawl/second-review";
import { judgementQueuePredicate } from "@/lib/crawl/repository";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { classificationReadyPredicate } from "./categories";
import { throughputStatus, type ThroughputSnapshot, type ThroughputStage } from "./throughput-model";

/**
 * One statement, one window cutoff. Count persisted items, not job ticks or log samples.
 * Documents, rule verdicts and second votes retain their latest timestamp only;
 * these rates intentionally do not claim to measure every retry/network call.
 */
export async function pipelineThroughput(settings: CrawlSettings, now = new Date()): Promise<ThroughputSnapshot> {
  const at = sql`${now.toISOString()}::timestamp`;
  const recent = (column: SQL, minutes: number) => sql`${column} > ${at} - ${minutes} * interval '1 minute' AND ${column} <= ${at}`;
  const counts = (column: SQL) => sql`count(*) FILTER (WHERE ${recent(column, 1)})::int AS one,
    count(*) FILTER (WHERE ${recent(column, 5)})::int AS five`;
  const age = (column: SQL) => sql`extract(epoch FROM (${at} - min(${column}))) / 60`;
  const fetchReady = sql`(${crawlFrontier.state} = 'pending' AND ${crawlFrontier.nextAttemptAt} <= ${at}) OR ${crawlFrontier.state} = 'fetching'`;
  // 발행 잡(jobs/publish.ts)과 같은 기준 — 분류 보류 중인 후보는 잡이 집지 않으니 대기가 아니다(별 자동 승인은 보류를 건너뛴다).
  // 재는 컨테이너의 CONNECT_AGENT_URL 로 가르지 않는다: crawler·reviewer 컨테이너엔 그 변수가 없어 보류 건이 "대기"로
  // 잡혔고, 발행 단계가 no_progress 경보를 내 릴리스 게이트(check-worker-progress)가 섰다(2026-10-03).
  const publishReady = and(reviewApprovalPredicate(settings), or(classificationReadyPredicate(), starAutoApprovalPredicate(settings)))!;

  const rows = await db.transaction(async tx => {
    // This small result has complex shared worker predicates. On production JIT compilation
    // alone took 7.3s; disabling it for this transaction reduced execution to 156ms.
    await tx.execute(sql`SET LOCAL jit = off`);
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    return tx.execute<{
    key: ThroughputStage["key"]; one: number; five: number; waiting: number;
    oldest: number | null; errors: number | null; extra: number; progress: number; manual: number;
  }>(sql`
    WITH fetched AS (
      SELECT ${counts(sql`${crawlDocuments.fetchedAt}`)} FROM ${crawlDocuments}
      WHERE ${recent(sql`${crawlDocuments.fetchedAt}`, 5)}
    ), fetch_queue AS (
      SELECT count(*) FILTER (WHERE ${fetchReady})::int AS waiting,
        extract(epoch FROM (${at} - min(CASE WHEN ${crawlFrontier.state} = 'fetching' THEN ${crawlFrontier.updatedAt}
          ELSE greatest(${crawlFrontier.discoveredAt}, ${crawlFrontier.nextAttemptAt}) END) FILTER (WHERE ${fetchReady}))) / 60 AS oldest,
        count(*) FILTER (WHERE ${crawlFrontier.state} = 'pending' AND ${crawlFrontier.nextAttemptAt} > ${at})::int AS extra,
        count(*) FILTER (WHERE ${crawlFrontier.state} IN ('pending','failed') AND ${crawlFrontier.lastError} IS NOT NULL
          AND ${recent(sql`${crawlFrontier.updatedAt}`, 5)})::int AS errors
      FROM ${crawlFrontier}
    ), judged AS (
      SELECT ${counts(sql`${crawlCandidates.judgedAt}`)} FROM ${crawlCandidates}
      WHERE ${crawlCandidates.decidedBy} = 'auto' AND ${crawlCandidates.state} <> 'new'
        AND ${recent(sql`${crawlCandidates.judgedAt}`, 5)}
    ), judge_queue AS (
      SELECT count(*)::int AS waiting, ${age(sql`greatest(${crawlDocuments.fetchedAt}, ${crawlCandidates.updatedAt})`)} AS oldest
      FROM ${crawlDocuments} LEFT JOIN ${crawlCandidates} ON ${crawlDocuments.repo} = ${crawlCandidates.repo}
      WHERE ${judgementQueuePredicate()}
    ), first_done AS (
      SELECT count(DISTINCT ${crawlReviewAttempts.candidateId}) FILTER (WHERE ${crawlReviewAttempts.state} = 'succeeded'
          AND ${crawlReviewAttempts.provider} <> 'rules' AND ${crawlReviewAttempts.reusedFromAttemptId} IS NULL AND ${recent(sql`${crawlReviewAttempts.completedAt}`, 1)})::int AS one,
        count(DISTINCT ${crawlReviewAttempts.candidateId}) FILTER (WHERE ${crawlReviewAttempts.state} = 'succeeded'
          AND ${crawlReviewAttempts.provider} <> 'rules' AND ${crawlReviewAttempts.reusedFromAttemptId} IS NULL)::int AS five,
        count(DISTINCT ${crawlReviewAttempts.candidateId}) FILTER (WHERE ${crawlReviewAttempts.state} = 'failed'
          AND ${crawlReviewAttempts.provider} <> 'rules' AND ${crawlReviewAttempts.reusedFromAttemptId} IS NULL AND ${crawlReviewAttempts.errorCode} IS DISTINCT FROM 'cancelled')::int AS errors,
        count(DISTINCT ${crawlReviewAttempts.candidateId}) FILTER (WHERE ${crawlReviewAttempts.state} = 'succeeded'
          AND ${crawlReviewAttempts.reusedFromAttemptId} IS NOT NULL)::int AS extra,
        count(DISTINCT ${crawlReviewAttempts.candidateId}) FILTER (WHERE ${crawlReviewAttempts.state} = 'succeeded')::int AS progress
      FROM ${crawlReviewAttempts} WHERE ${crawlReviewAttempts.kind} = 'automatic'
        AND ${recent(sql`${crawlReviewAttempts.completedAt}`, 5)}
    ), first_queue AS (
      SELECT count(*)::int AS waiting, ${age(sql`greatest(${crawlCandidates.updatedAt}, ${crawlDocuments.fetchedAt})`)} AS oldest
      FROM ${crawlCandidates} LEFT JOIN ${crawlDocuments} ON ${crawlCandidates.repo} = ${crawlDocuments.repo}
      WHERE ${reviewCandidatePredicate(settings, { readyOnly: true })}
    ), second_stats AS (
      SELECT count(*) FILTER (WHERE ${secondReviews.secondDecision} IS NOT NULL AND ${secondReviews.errorCode} IS NULL
          AND ${recent(sql`${secondReviews.reviewedAt}`, 1)})::int AS one,
        count(*) FILTER (WHERE ${secondReviews.secondDecision} IS NOT NULL AND ${secondReviews.errorCode} IS NULL
          AND ${recent(sql`${secondReviews.reviewedAt}`, 5)})::int AS five,
        count(*) FILTER (WHERE ${secondReviews.status} = 'pending')::int AS waiting,
        extract(epoch FROM (${at} - min(greatest(${secondReviews.createdAt},
          CASE WHEN ${secondReviews.errorCode} IS NOT NULL THEN ${secondReviews.reviewedAt} +
            (CASE WHEN ${inArray(secondReviews.errorCode, SECOND_REVIEW_TRANSIENT_ERRORS)} THEN ${TRANSIENT_RETRY_MS}
              ELSE ${SECOND_REVIEW_RETRY_MS} END)::integer * interval '1 millisecond' END)) FILTER (WHERE ${secondReviews.status} = 'pending'))) / 60 AS oldest,
        count(*) FILTER (WHERE ${secondReviews.errorCode} IS NOT NULL AND ${secondReviews.errorCode} <> 'cancelled'
          AND ${recent(sql`${secondReviews.reviewedAt}`, 5)})::int AS errors,
        count(*) FILTER (WHERE ${secondReviews.status} = 'failed')::int AS extra
      FROM ${secondReviews}
    ), published AS (
      SELECT ${counts(sql`${crawlPublicationChanges.occurredAt}`)} FROM ${crawlPublicationChanges}
      WHERE ${crawlPublicationChanges.delta} = 1 AND ${recent(sql`${crawlPublicationChanges.occurredAt}`, 5)}
    ), manual_holds AS (
      SELECT count(*) FILTER (WHERE ${crawlCandidates.reason} = 'source_refresh_failed')::int AS fetch,
        count(*) FILTER (WHERE ${crawlCandidates.reason} = 'ai_review_exhausted')::int AS first
      FROM ${crawlCandidates} WHERE ${crawlCandidates.state} = 'needs_review'
    ), publish_candidates AS MATERIALIZED (
      -- 분류 보류는 retry_at 이 지나야 발행 대상이 된다. 보류를 건 시각(updated_at)으로 재면 막 풀린 후보가
      -- "1시간 기다림"으로 보여, 5분 주기 발행 잡이 돌기 전에 감시가 발행 워커를 멈춘 것으로 보고 재시작했다(2026-10-08 두 번)
      SELECT ${publishReady} AS ready, greatest(${crawlCandidates.updatedAt},
        (SELECT max(a.completed_at) FROM crawl_review_attempts a WHERE a.candidate_id = ${crawlCandidates.id}),
        (SELECT max(s.reviewed_at) FROM second_reviews s WHERE s.candidate_id = ${crawlCandidates.id}),
        (SELECT max(greatest(cd.updated_at, cd.retry_at)) FROM category_decisions cd WHERE cd.repo = ${crawlCandidates.repo})) AS changed_at
      FROM ${crawlCandidates} WHERE ${crawlCandidates.state} = 'approved'
    ), publish_queue AS (
      SELECT count(*) FILTER (WHERE ready)::int AS waiting,
        extract(epoch FROM (${at} - min(changed_at) FILTER (WHERE ready))) / 60 AS oldest,
        count(*) FILTER (WHERE NOT ready)::int AS extra FROM publish_candidates
    )
    SELECT 'fetch' AS key, one, five, waiting, oldest, errors, extra, five AS progress, manual_holds.fetch AS manual
      FROM fetched CROSS JOIN fetch_queue CROSS JOIN manual_holds
    UNION ALL SELECT 'judge', one, five, waiting, oldest, NULL, 0, five, 0 FROM judged CROSS JOIN judge_queue
    UNION ALL SELECT 'first', one, five, waiting, oldest, errors, extra, progress, manual_holds.first
      FROM first_done CROSS JOIN first_queue CROSS JOIN manual_holds
    UNION ALL SELECT 'second', one, five, waiting, oldest, errors, extra, five, 0 FROM second_stats
    UNION ALL SELECT 'publish', one, five, waiting, oldest, NULL, extra, five, 0 FROM published CROSS JOIN publish_queue
  `);
  }, { accessMode: "read only" });

  const labels = { fetch: "원본 수집", judge: "규칙 판정", first: "AI 1차", second: "AI 2차", publish: "발행" };
  const details = {
    fetch: "최근 원본을 저장한 저장소 수입니다. 같은 저장소의 반복 수집은 한 건입니다. 대기는 지금 수집 가능한 항목과 선점한 항목을 포함합니다.",
    judge: "최근 자동 규칙 판정이 저장된 후보 수입니다. 관리자 판정과 아직 판정하지 않은 원본은 완료에서 제외합니다.",
    first: "최근 모델 심사가 완료된 후보 수입니다. 같은 후보는 한 건이며, 규칙 처리와 결과 재사용은 제외합니다. 대기는 현재 워커가 선택할 수 있는 후보이며 진행 중 심사와 재시도 유예는 제외합니다. 상태 판단은 규칙·재사용을 포함한 자동 처리 기록을 사용하며, 대기 경과는 후보·원본 갱신 시각 기준의 추정입니다.",
    second: "최근 완료된 모델별 심사표 수입니다. 한 후보를 여러 모델이 보므로 후보 수와 다릅니다. 대기에 심사 중인 표도 포함하며, 같은 표의 재시도는 마지막 기록만 셉니다.",
    publish: "수집 후보가 발행 상태로 전환된 횟수입니다. 대기는 현재 심사·분류 조건을 충족한 승인 후보입니다. 최종 발행 검사는 작업 실행 시 진행됩니다. 경과 시간은 후보·심사·분류의 최근 갱신 기준이며, 실제 발행 가능 시각과 다를 수 있습니다.",
  };
  return { measuredAt: now.toISOString(), stages: rows.map(row => {
    const extra = Number(row.extra);
    const queueNote = row.key === "fetch" ? `대기·선점${extra ? ` · 재시도 예약 ${extra.toLocaleString("ko-KR")}건 별도` : ""}`
      : row.key === "first" ? `실행 가능 대기${extra ? ` · 5분 내 재사용 ${extra.toLocaleString("ko-KR")}건` : ""}`
      : row.key === "second" ? `대기·심사 중${extra ? ` · 실패 보류 ${extra.toLocaleString("ko-KR")}표 별도` : ""}`
      : row.key === "publish" ? `실행 가능 대기${extra ? ` · 심사·분류 조건 대기 ${extra.toLocaleString("ko-KR")}건 별도` : ""}` : "판정 대기";
    const stage = {
      key: row.key, label: labels[row.key], unit: row.key === "second" ? "표" as const : "건" as const,
      completed1m: Number(row.one), completed5m: Number(row.five), progress5m: Number(row.progress), waiting: Number(row.waiting),
      manualAttention: Number(row.manual),
      deferred: row.key === "fetch" ? extra : undefined,
      ageLabel: row.key === "first" ? "후보·원본 갱신 후" : row.key === "publish" ? "승인·심사 갱신 후" : "가장 오래된 대기",
      oldestMinutes: row.oldest === null ? null : Math.max(0, Number(row.oldest)),
      enabled: settings.enabled && (row.key !== "first" || settings.reviewMode !== "off")
        && (row.key !== "second" || settings.secondReview.enabled),
      errors5m: row.errors === null ? null : Number(row.errors), queueNote, detail: details[row.key],
    };
    return { ...stage, status: throughputStatus(stage) };
  }) };
}
