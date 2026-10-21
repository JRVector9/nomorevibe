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

/** 칸이 없는 설정 객체(부분 설정을 넘기는 호출)는 꺼진 것으로 읽는다 — 저장된 행은 mergeWithDefaults 가 늘 채운다 */
const OFF: HeldQwenRetrySettings = { ...DEFAULT_HELD_QWEN_RETRY, enabled: false };
export function heldQwenRetry(settings: CrawlSettings): HeldQwenRetrySettings {
  return (settings.review as CrawlSettings["review"] | undefined)?.qwenHeldRetry ?? OFF;
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

/** Qwen-v2 승인을 관문(두 모델 승인)에 넣을 수 있는가 — 적용 모드·2차 심사가 켜져 있고 독립 투표자가 있다 */
export function heldQwenGateable(settings: CrawlSettings, model: string | null | undefined): boolean {
  return settings.enabled && settings.reviewMode === "enforce" && settings.secondReview.enabled
    && heldQwenRetry(settings).enabled && heldQwenIndependentVoters(settings, model).length > 0;
}

/**
 * 관문이 1차 승인으로 받는 Qwen-v2 시도 행인가(행 하나, TS). 아래 SQL 과 같은 조건이다.
 * 끄거나 독립 투표자가 사라지면 받지 않는다 — 그 후보는 AI 1차가 다시 보거나(재시도 사유) 사람에게 돌아간다(소진 사유).
 */
export function heldQwenGateFirst(settings: CrawlSettings, attempt: Pick<CrawlReviewAttempt, "kind" | "provider" | "actor" | "state" | "outcome" | "model">): boolean {
  return attempt.kind === "delegated" && attempt.provider === HELD_QWEN_PROVIDER && attempt.state === "succeeded"
    && typeof attempt.actor === "string" && attempt.actor.startsWith(`${HELD_QWEN_ACTOR}:`)
    && attempt.outcome?.decision === "approve" && Boolean(attempt.model?.trim()) && heldQwenGateable(settings, attempt.model);
}

/** 앞의 대괄호 덩이를 모두 뗀 모델 이름 — sameOpinionModel 의 SQL 짝 */
const bareModel = (name: SQL) => sql`regexp_replace(lower(trim(${name})), '^\\[[^]]*\\][[:space:]]*', '')`;

/**
 * heldQwenGateFirst 의 SQL — crawl_review_attempts 행(또는 같은 열을 가진 별칭)에 건다.
 * 독립 투표자 조건은 행의 모델로 잰다(모델 이름을 바꿔 부른 뒤에도 그 행이 부른 모델로 견준다).
 */
export function heldQwenGateFirstSql(settings: CrawlSettings, attempts: {
  kind: AnyPgColumn | SQL; provider: AnyPgColumn | SQL; actor: AnyPgColumn | SQL; state: AnyPgColumn | SQL; outcome: AnyPgColumn | SQL; model: AnyPgColumn | SQL;
} = crawlReviewAttempts): SQL {
  const open = settings.enabled && settings.reviewMode === "enforce" && settings.secondReview.enabled && heldQwenRetry(settings).enabled;
  if (!open) return sql`false`;
  const voters = JSON.stringify(settings.secondReview.voters.map((voter) => voter.model));
  return sql`(${attempts.kind} = 'delegated' AND ${attempts.provider} = ${HELD_QWEN_PROVIDER}
    AND ${attempts.state} = 'succeeded' AND ${attempts.actor} LIKE ${`${HELD_QWEN_ACTOR}:%`}
    AND ${attempts.outcome}->>'decision' = 'approve' AND btrim(coalesce(${attempts.model}, '')) <> ''
    AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(${voters}::jsonb) AS held_qwen_voter(model)
      WHERE ${bareModel(sql`held_qwen_voter.model`)} <> ${bareModel(sql`${attempts.model}`)}))`;
}
