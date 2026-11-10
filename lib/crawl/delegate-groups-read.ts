import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlReviewAttempts } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { REVIEW_QUEUE_SCAN_LIMIT } from "./admin-review";
import { currentReviewSource } from "./agent-review-repository";
import { DEEPSEEK_REVIEW_PROVIDER, deepseekActor } from "./deepseek-review-policy";
import { readDelegatedModelOutcome } from "./delegated-hold";
import { groupDelegateFacts, type DelegateGroups } from "./delegate-groups";
import type { CrawlSettings } from "./settings-schema";

type Executor = ProductTransaction | typeof db;
type Row = { id: number; decided_by: string | null; attempt_id: number | null; model_outcome: unknown };

/** jsonb 는 드라이버가 객체로 준다 — 글자로 오면(드라이버 설정이 바뀌면) 풀어서 같은 검사를 거친다 */
function parsedOutcome(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

/**
 * 보류 후보 전부를 「AI 위임 결과」 갈래로 나눈다(delegate-groups.ts). 후보마다 지금 원본의 마지막 성공 위임 시도 하나만 본다 —
 * 위임 잡의 고르기(human-review-repository.ts humanReviewRepos)와 같은 조건(kind·provider·지금 세대 actor·currentReviewSource)이다.
 * 심사 목록은 거르기에 쓰므로 주 DB 로(결정한 뒤 바로 맞게), 운영 홈은 복제본 트랜잭션을 넘겨 읽는다.
 * 보류 갈래(reviewQueueAiDecisions)와 같은 상한·순서로 읽는다.
 */
export async function readDelegateGroups(settings: CrawlSettings, executor: Executor = db): Promise<DelegateGroups> {
  const actor = deepseekActor(settings.humanReview.generation);
  // currentReviewSource 는 표 이름(crawl_candidates·crawl_review_attempts)으로 쓰므로 별칭 없이 묶는다
  const rows = await executor.execute<Row>(sql`
    SELECT ${crawlCandidates.id} AS id, ${crawlCandidates.decidedBy} AS decided_by,
      latest.attempt_id, latest.model_outcome
    FROM ${crawlCandidates}
    LEFT JOIN LATERAL (
      SELECT ${crawlReviewAttempts.id} AS attempt_id, ${crawlReviewAttempts.modelOutcome} AS model_outcome
      FROM ${crawlReviewAttempts}
      WHERE ${crawlCandidates.decidedBy} = 'auto'
        AND ${crawlReviewAttempts.candidateId} = ${crawlCandidates.id} AND ${crawlReviewAttempts.kind} = 'delegated'
        AND ${crawlReviewAttempts.provider} = ${DEEPSEEK_REVIEW_PROVIDER} AND ${crawlReviewAttempts.actor} = ${actor}
        AND ${crawlReviewAttempts.state} = 'succeeded' AND ${currentReviewSource(settings)}
      ORDER BY ${crawlReviewAttempts.id} DESC
      LIMIT 1
    ) latest ON true
    WHERE ${crawlCandidates.state} = 'needs_review'
    ORDER BY ${crawlCandidates.id}
    LIMIT ${REVIEW_QUEUE_SCAN_LIMIT}`);
  return groupDelegateFacts([...rows].map(row => ({
    id: Number(row.id), decidedBy: row.decided_by,
    attemptId: row.attempt_id === null ? null : Number(row.attempt_id),
    outcome: row.attempt_id === null ? null : readDelegatedModelOutcome(parsedOutcome(row.model_outcome)),
  })));
}
