import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlReviewAttempts } from "@/lib/db/schema";
import { currentReviewSource } from "./agent-review-repository";
import { DEEPSEEK_REVIEW_PROVIDER, deepseekActor } from "./deepseek-review-policy";
import { readDelegatedModelOutcome } from "./delegated-hold";
import type { DelegateOpinion } from "./delegate-groups";
import type { CrawlSettings } from "./settings-schema";

/**
 * 심사 목록 한 쪽의 후보마다 위임 검수(human-deepseek-review)의 마지막 성공 판단 하나 — 상세가 의견·확신·사유·남긴 까닭을 그린다.
 * 지금 원본·지금 세대의 시도를 먼저 고른다(갈래 readDelegateGroups 와 같은 시도). 없으면 이전 원본의 마지막 판단을 current=false 로 준다.
 * admin-review.ts 가 부른다 — 이 파일은 admin-review 를 부르지 않는다(순환 import 를 만들지 않게).
 */
export async function delegateOpinions(settings: CrawlSettings, ids: number[]): Promise<Map<number, DelegateOpinion>> {
  if (!ids.length) return new Map();
  const current = sql<boolean>`(${crawlReviewAttempts.actor} = ${deepseekActor(settings.humanReview.generation)}
    AND ${currentReviewSource(settings)})`;
  const rows = await db.selectDistinctOn([crawlReviewAttempts.candidateId], {
    candidateId: crawlReviewAttempts.candidateId, outcome: crawlReviewAttempts.outcome, modelOutcome: crawlReviewAttempts.modelOutcome,
    reason: crawlReviewAttempts.reason, model: crawlReviewAttempts.model, startedAt: crawlReviewAttempts.startedAt,
    completedAt: crawlReviewAttempts.completedAt, current,
  }).from(crawlReviewAttempts).innerJoin(crawlCandidates, eq(crawlCandidates.id, crawlReviewAttempts.candidateId)).where(and(
    inArray(crawlReviewAttempts.candidateId, ids), eq(crawlReviewAttempts.kind, "delegated"),
    eq(crawlReviewAttempts.provider, DEEPSEEK_REVIEW_PROVIDER), eq(crawlReviewAttempts.state, "succeeded"),
  )).orderBy(crawlReviewAttempts.candidateId, desc(current), desc(crawlReviewAttempts.id));
  return new Map(rows.map((row): [number, DelegateOpinion] => {
    const model = readDelegatedModelOutcome(row.modelOutcome);
    const applied = row.outcome?.decision ?? null;
    const confidence = model?.confidence ?? (typeof row.outcome?.confidence === "number" ? row.outcome.confidence : null);
    // 근거 나이·저장소 확인으로 남긴 행은 reason 칸이 표지(stale_evidence_refresh·repo_deleted)다 — 모델의 말은 outcome 에 있다
    return [row.candidateId, { model, applied, confidence, reason: row.outcome?.reason ?? row.reason ?? null, reasonKo: null,
      modelName: row.model, at: (row.completedAt ?? row.startedAt).toISOString(), current: Boolean(row.current) }];
  }));
}
