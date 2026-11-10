import { and, eq, sql, type SQL } from "drizzle-orm";
import { crawlCandidates, crawlReviewAttempts, type CrawlReviewAttempt } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import type { ReviewInput } from "./agent-review-contract";
import { currentReviewSource } from "./agent-review-repository";
import { DEEPSEEK_REVIEW_PROVIDER } from "./deepseek-review-policy";
import { HELD_QWEN_ACTOR, HELD_QWEN_COUNTED_FAILURES, HELD_QWEN_MAX_FAILURES, HELD_QWEN_PROVIDER, heldQwenConcluded,
  heldQwenGateFirstSql } from "./held-qwen-retry-policy";
import type { CrawlSettings } from "./settings-schema";

/**
 * 보류 재심사(Qwen-v2, held-qwen-retry.ts) → 사람 몫 위임 검수(DeepSeek, human-review-repository.ts) 넘김.
 * 2026-11-10 운영자 결정 "Deepseek 위임검수로 넘겨".
 *
 * 보류 재심사가 맡은 사유(heldQwenOwns — 소개 없음·재시도 소진·판단 보류)는 전에는 Qwen-v2 만 봤다. Qwen-v2 가 보류로 끝내면
 * DeepSeek 은 그 후보를 끝내 보지 않고 사람에게 남았다(프로드 24시간: 보류 148·거부 13·복귀 6). 이제 Qwen-v2 가 지금 입력에서
 * 끝냈으면(heldQwenConcluded) DeepSeek 위임이 다른 보류처럼 이어 본다. 끝내기 전 — 아직 묻지 않았거나, 보는 중이거나,
 * 다시 볼 실패가 남았으면 — 은 그대로 Qwen-v2 몫이다. 원본이 바뀌면(새 입력) 다시 Qwen-v2 차례다.
 *
 * Qwen 모델·덧붙임 판은 가르지 않는다 — 어느 세대든 이 입력에서 끝낸 것이 있으면 넘긴다. Qwen 모델 이름은 보류 재심사 쪽 등록부 설정이 정해,
 * 위임 잡·호출 직전 증명이 같은 값을 안다고 믿을 수 없다.
 *
 * 되풀이 막기(heldQwenHandedOff): 넘긴 입력에 DeepSeek 위임의 시도 행이 생기면(어느 상태든) 보류 재심사는 그 입력을 다시 묻지 않는다.
 * 같은 세대는 원래 한 번만 묻지만 Qwen 모델·덧붙임 판이 바뀐 새 세대는 다시 물을 수 있어, DeepSeek 이 보류한 뒤 Qwen 이 다시 묻고 또 넘기는
 * 일이 생긴다. 모델을 부르지 않는 승인 의견 다시 넣기(reapplied)는 막지 않는다. DeepSeek 은 자기 판단이 이 입력에서 끝이다(humanReviewRepos).
 *
 * 고르기(SQL)는 currentReviewSource 로, claim·호출 직전 증명(TS)은 입력·원본 해시로 지금 입력을 잰다 — 두 위임 claim 의 자기 시도 대조와 같다.
 */

/** 이 재심사의 시도 행(crawl_review_attempts 이름 그대로) — 바깥 쿼리의 crawl_candidates 행에 묶는다 */
const heldQwenRows = sql`${crawlReviewAttempts.candidateId} = ${crawlCandidates.id} AND ${crawlReviewAttempts.kind} = 'delegated'
  AND ${crawlReviewAttempts.provider} = ${HELD_QWEN_PROVIDER} AND ${crawlReviewAttempts.actor} LIKE ${`${HELD_QWEN_ACTOR}:%`}`;

/**
 * heldQwenConcluded 의 SQL — 바깥 쿼리가 crawl_candidates 를 별칭 없이 읽을 때 건다(별칭이면 SELECT … FROM crawl_candidates WHERE id = c.id 로 감싼다).
 * 진행 중 행은 입력과 상관없이 본다(한 후보에 하나 — crawl_review_one_active_idx).
 */
export function heldQwenConcludedSql(settings: CrawlSettings): SQL {
  return sql`(NOT EXISTS (SELECT 1 FROM ${crawlReviewAttempts} WHERE ${heldQwenRows} AND ${crawlReviewAttempts.state} = 'running')
    AND (EXISTS (SELECT 1 FROM ${crawlReviewAttempts} WHERE ${heldQwenRows} AND ${currentReviewSource(settings)}
        AND ${crawlReviewAttempts.state} = 'succeeded'
        AND NOT (${crawlCandidates.reason} <> 'no_description' AND ${heldQwenGateFirstSql(settings, null)}))
      OR EXISTS (SELECT 1 FROM ${crawlReviewAttempts} WHERE ${heldQwenRows} AND ${currentReviewSource(settings)}
        AND ${crawlReviewAttempts.state} = 'failed'
        AND ${crawlReviewAttempts.errorCode} IN (${sql.join(HELD_QWEN_COUNTED_FAILURES.map((code) => sql`${code}`), sql`, `)})
        GROUP BY ${crawlReviewAttempts.actor}, ${crawlReviewAttempts.model} HAVING count(*) >= ${HELD_QWEN_MAX_FAILURES})))`;
}

/** heldQwenHandedOff 의 SQL — 끝냈고 DeepSeek 위임이 지금 입력에 시도 행을 남겼다. heldQwenConcludedSql 과 같이 건다 */
export function heldQwenHandedOffSql(settings: CrawlSettings): SQL {
  return sql`(${heldQwenConcludedSql(settings)} AND EXISTS (SELECT 1 FROM ${crawlReviewAttempts}
    WHERE ${crawlReviewAttempts.candidateId} = ${crawlCandidates.id} AND ${crawlReviewAttempts.kind} = 'delegated'
      AND ${crawlReviewAttempts.provider} = ${DEEPSEEK_REVIEW_PROVIDER} AND ${currentReviewSource(settings)}))`;
}

type HandoffRow = Pick<CrawlReviewAttempt, "kind" | "provider" | "actor" | "state" | "outcome" | "model" | "errorCode">;

/** 넘긴 뒤인가(TS) — 끝냈고 DeepSeek 위임이 이 입력에 시도 행을 남겼다. rows 는 지금 입력의 위임 시도 행(inputDelegatedAttempts) */
export function heldQwenHandedOff(settings: CrawlSettings, reason: string | null | undefined, rows: readonly HandoffRow[]): boolean {
  return heldQwenConcluded(settings, reason, rows)
    && rows.some((row) => row.kind === "delegated" && row.provider === DEEPSEEK_REVIEW_PROVIDER);
}

/**
 * 지금 입력(입력·원본 해시)의 위임 시도 행 — Qwen-v2 와 DeepSeek 의 것을 함께 읽는다. 잠그지 않는다: 부르는 claim·증명이 후보 행을 먼저
 * 잠가(lockedInput) 두 잡의 claim·기록과 줄을 서고, 잠그지 않는 쓰기(주인 없음 정리·용량 미룸)는 진행 중 행을 끝낼 뿐이라 끝냄을 거짓으로 만들지 않는다
 */
export function inputDelegatedAttempts(tx: ProductTransaction, candidateId: number, input: Pick<ReviewInput, "inputHash" | "sourceRevisionHash">) {
  return tx.select().from(crawlReviewAttempts).where(and(eq(crawlReviewAttempts.candidateId, candidateId), eq(crawlReviewAttempts.kind, "delegated"),
    eq(crawlReviewAttempts.inputHash, input.inputHash), eq(crawlReviewAttempts.sourceRevisionHash, input.sourceRevisionHash)));
}
