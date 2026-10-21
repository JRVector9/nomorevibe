import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { crawlReviewAttempts, type CrawlReviewAttempt } from "@/lib/db/schema";
import { sameOpinionModel } from "./second-opinion-rules";
import { DEFAULT_HELD_QWEN_RETRY, type CrawlSettings, type HeldQwenReason, type HeldQwenRetrySettings } from "./settings-schema";

/**
 * 보류 Qwen-v2 재심사(held-qwen-retry.ts)가 남기는 시도 행의 이름과, 관문이 그 승인을 1차 승인으로 받는 조건.
 *
 * 2차 심사(second-review.ts)·발행 조건(agent-review-repository.ts)이 이 모듈만 끌어온다 — 제공자 모듈(qwen-direct-review.ts)을
 * 끌어오면 게이트웨이 모듈이 관문 쪽 import 순환에 들어간다. 그래서 여기에는 문자열 상수와 순수 판단만 둔다.
 *
 * 시도 행: kind 'delegated'(DeepSeek 위임과 같은 갈래 — 1차 심사의 시도 수·지표·replay 에 섞이지 않는다),
 * provider 'qwen-direct', actor 'qwen-v2:<덧붙임 판>'. 거부한 후보의 decided_by 는 'qwen-v2'.
 */
export const HELD_QWEN_PROVIDER = "qwen-direct";
export const HELD_QWEN_ACTOR = "qwen-v2";
export const HELD_QWEN_DECIDED_BY = "qwen-v2";
/** 시도 행의 actor — 덧붙임 판이 바뀌면 같은 입력도 다시 묻는다(DeepSeek 의 'm3-deepseek:<세대>'와 같은 꼴) */
export const heldQwenActor = (promptVersion: string) => `${HELD_QWEN_ACTOR}:${promptVersion}`;
/** 거부·승인으로 적용하는 확신의 하한 — DeepSeek 위임(DEEPSEEK_MIN_CONFIDENCE)과 같다. 아래면 판단 보류로 둔다 */
export const HELD_QWEN_MIN_CONFIDENCE = 0.9;

/** 칸이 없는 설정 객체(부분 설정을 넘기는 호출)는 꺼진 것으로 읽는다 — 저장된 행은 mergeWithDefaults 가 늘 채운다(qwenAuto.heldRetry, 기본 꺼짐) */
const OFF: HeldQwenRetrySettings = { ...DEFAULT_HELD_QWEN_RETRY, enabled: false };
export function heldQwenRetry(settings: CrawlSettings): HeldQwenRetrySettings {
  return (settings.qwenAuto as CrawlSettings["qwenAuto"] | undefined)?.heldRetry ?? OFF;
}

/** 이 사유의 보류를 지금 Qwen-v2 가 맡는가 — DeepSeek 위임은 맡은 것을 집지 않는다(human-review-repository.ts) */
export function heldQwenOwns(settings: CrawlSettings, reason: string | null | undefined): boolean {
  const policy = heldQwenRetry(settings);
  return settings.enabled && settings.reviewMode === "enforce" && policy.enabled
    && policy.reasons.some((value: HeldQwenReason) => value === reason);
}
export function heldQwenOwnedReasons(settings: CrawlSettings): HeldQwenReason[] {
  const policy = heldQwenRetry(settings);
  return settings.enabled && settings.reviewMode === "enforce" && policy.enabled ? [...policy.reasons] : [];
}

/**
 * 지금 2차 투표자 중 이 모델과 다른 모델이 있는가 — 관문의 독립 2차 표가 설 수 있는가.
 *
 * 관문의 "같은 모델"은 '[MLX] ' 만 떼고 견준다(review-model-identity.ts). 그런데 게이트웨이는 gpu3090 의 같은 Qwen 을
 * '[gpu3090] qwen3.8-flash-next' 로 부르고, 직접 부르는 Qwen-v2 는 'qwen3.8-flash-next' 다. 관문은 둘을 다른 모델로 보고 그 표를
 * 독립 표로 셀 것이라, 앞의 대괄호 덩이를 모두 떼는 sameOpinionModel 로 다시 견준다. 이렇게 다른 투표자가 하나라도 있으면 관문은
 * 모든 독립 칸의 승인을 요구하므로(secondApproved) 그 투표자의 승인 없이는 발행되지 않는다. 하나도 없으면 Qwen-v2 승인을 관문에 넣지 않는다.
 */
export function heldQwenIndependentVoters(settings: CrawlSettings, model: string | null | undefined) {
  return settings.secondReview.voters.filter((voter) => !sameOpinionModel(voter.model, model));
}

/**
 * 대체 모델(fallbacks) 중 이 모델과 같은 모델이 있는가 — 독립 투표자가 실패하면 대체 모델이 그 칸을 대신 채운다. 대체 모델이 같은 Qwen 이면
 * 그 칸의 표는 독립이 아니다(관문은 그 표를 되풀이로 보고 사람에게 넘긴다 — second-review.ts sameUnderlyingModel). 그런 설정에서는 승인을 관문에 넣지 않는다
 */
export function heldQwenSameModelFallback(settings: CrawlSettings, model: string | null | undefined): boolean {
  return (settings.secondReview.fallbacks ?? []).some((fallback) => sameOpinionModel(fallback.model, model));
}

/** Qwen-v2 승인을 관문(두 모델 승인)에 넣을 수 있는가 — 적용 모드·2차 심사가 켜져 있고 독립 투표자가 있으며 같은 모델의 대체 모델이 없다 */
export function heldQwenGateable(settings: CrawlSettings, model: string | null | undefined): boolean {
  return settings.enabled && settings.reviewMode === "enforce" && settings.secondReview.enabled
    && heldQwenRetry(settings).enabled && heldQwenIndependentVoters(settings, model).length > 0 && !heldQwenSameModelFallback(settings, model);
}

/** 후보에 적용된 보류 Qwen-v2 승인의 시도 id — applyOutcome 이 관문에 넣을 때만 적는다(signals.heldQwenAttemptId) */
export const appliedHeldQwenAttemptId = (signals: unknown): number | null => {
  const value = signals && typeof signals === "object" ? (signals as Record<string, unknown>).heldQwenAttemptId : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;
};

/**
 * 관문이 1차 승인으로 받는 Qwen-v2 시도 행인가(행 하나, TS). 아래 SQL 과 같은 조건이다.
 * 끄거나 독립 투표자가 사라지면 받지 않는다 — 그 후보는 AI 1차가 다시 보거나(재시도 사유) 사람에게 돌아간다(소진 사유).
 * applyOutcome 이 실제로 관문에 넣은 승인만 받는다 — 후보 signals.heldQwenAttemptId 가 그 시도 id 여야 한다(DeepSeek 위임의
 * delegatedReviewAttemptId 와 같다). 소개 없음(no_description)의 "승인 의견"은 넣지 않았으니, 소개를 지어 후보가 풀려도 그 의견은 1차 승인이 아니다.
 */
export function heldQwenGateFirst(settings: CrawlSettings, attempt: Pick<CrawlReviewAttempt, "id" | "kind" | "provider" | "actor" | "state" | "outcome" | "model">,
  candidate: { signals?: unknown } | null | undefined): boolean {
  return attempt.kind === "delegated" && attempt.provider === HELD_QWEN_PROVIDER && attempt.state === "succeeded"
    && typeof attempt.actor === "string" && attempt.actor.startsWith(`${HELD_QWEN_ACTOR}:`)
    && attempt.outcome?.decision === "approve" && Boolean(attempt.model?.trim()) && heldQwenGateable(settings, attempt.model)
    && appliedHeldQwenAttemptId(candidate?.signals) === attempt.id;
}

/** JS 로 읽은 후보의 적용된 시도 id 를 heldQwenGateFirstSql 의 appliedAttemptId 로 */
export const appliedHeldQwenAttemptSql = (candidate: { signals?: unknown } | null | undefined): SQL => {
  const id = appliedHeldQwenAttemptId(candidate?.signals);
  return id === null ? sql`NULL::text` : sql`${String(id)}::text`;
};
/** 테이블의 후보 열로 heldQwenGateFirstSql 의 appliedAttemptId 를 — signals->>'heldQwenAttemptId' */
export const appliedHeldQwenAttemptColumn = (signals: AnyPgColumn | SQL): SQL => sql`(${signals}->>'heldQwenAttemptId')`;

/** 앞의 대괄호 덩이를 모두 뗀 모델 이름 — sameOpinionModel·review-model-identity.ts sameUnderlyingModel 의 SQL 짝 */
export const underlyingModelSql = (name: SQL) => sql`regexp_replace(lower(trim(${name})), '^\\[[^]]*\\][[:space:]]*', '')`;

/**
 * heldQwenGateFirst 의 SQL — crawl_review_attempts 행(또는 같은 열을 가진 별칭)에 건다. appliedAttemptId 는 그 후보에 적용된 시도 id 의 글자 값이다
 * (보통 crawl_candidates.signals->>'heldQwenAttemptId'). null 은 보류 재심사 자신이 "이제 관문에 넣을 수 있게 된 승인 의견"을 고를 때만 쓴다 —
 * 아직 적용하지 않은 의견이라 적용 여부를 보지 않는다(관문은 늘 적용된 것만 받는다).
 * 독립 투표자 조건은 행의 모델로 잰다(모델 이름을 바꿔 부른 뒤에도 그 행이 부른 모델로 견준다).
 */
export function heldQwenGateFirstSql(settings: CrawlSettings, appliedAttemptId: SQL | null, attempts: {
  id: AnyPgColumn | SQL; kind: AnyPgColumn | SQL; provider: AnyPgColumn | SQL; actor: AnyPgColumn | SQL; state: AnyPgColumn | SQL;
  outcome: AnyPgColumn | SQL; model: AnyPgColumn | SQL;
} = crawlReviewAttempts): SQL {
  const open = settings.enabled && settings.reviewMode === "enforce" && settings.secondReview.enabled && heldQwenRetry(settings).enabled;
  if (!open) return sql`false`;
  const voters = JSON.stringify(settings.secondReview.voters.map((voter) => voter.model));
  const fallbacks = JSON.stringify((settings.secondReview.fallbacks ?? []).map((fallback) => fallback.model));
  return sql`(${attempts.kind} = 'delegated' AND ${attempts.provider} = ${HELD_QWEN_PROVIDER}
    AND ${attempts.state} = 'succeeded' AND ${attempts.actor} LIKE ${`${HELD_QWEN_ACTOR}:%`}
    AND ${attempts.outcome}->>'decision' = 'approve' AND btrim(coalesce(${attempts.model}, '')) <> ''
    AND ${appliedAttemptId === null ? sql`true` : sql`${attempts.id}::text IS NOT DISTINCT FROM (${appliedAttemptId})`}
    AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(${voters}::jsonb) AS held_qwen_voter(model)
      WHERE ${underlyingModelSql(sql`held_qwen_voter.model`)} <> ${underlyingModelSql(sql`${attempts.model}`)})
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(${fallbacks}::jsonb) AS held_qwen_fallback(model)
      WHERE ${underlyingModelSql(sql`held_qwen_fallback.model`)} = ${underlyingModelSql(sql`${attempts.model}`)}))`;
}
