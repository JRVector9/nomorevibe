import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * 심사자 identity 의 provider 동등 규칙 — 한 곳(2026-11-21 소유자 결정: abcllm 이름표를 없애고 모델에 API 주소로 바로 붙는다,
 * docs/plans/2026-11-21-abcllm-label-cleanup.md 1단계).
 *
 * 엔진 직접 호출의 이름표가 `abcllm` 에서 `local-direct` 로 옮겨 간다. 같은 장부 이름 M 의 (abcllm, M) 과 (local-direct, M) 은 같은 경로의 같은 계약 행
 * (model_serving_contracts 의 route·model)이 가리키는 같은 엔진이다 — 계약을 다시 저장해 이름표만 바뀐다. 그래서 **남은 기록이 지금 심사자의 것인가**를
 * 가를 때는 두 이름표를 한 심사자로 본다: 1차 유효 판정·발행 관문·2차가 붙는 1차 판단·2차 표의 투표자 자격. 이 규칙이 없으면 이름표가 바뀌는 순간 통과한 1차가
 * 무효로 읽혀 대량 재심사가 나고, 받은 2차 표가 model_removed 로 버려진다.
 *
 * 규칙의 범위:
 * - 이 묶음뿐이다. CLI(claude-cli·grok-cli·opencode-cli)·rules·위임 검수의 이름표(qwen-direct·m3-deepseek)는 예전처럼 글자 그대로 견준다.
 * - provider 만 고른다. 모델 쪽 견줌은 자리마다 쓰던 것 그대로다(1차: 장부 이름 글자 그대로 / 2차 투표자: sameReviewModel).
 * - 「서로 다른 모델이 함께 승인」(독립 표)은 처음부터 provider 를 보지 않는다 — 모델 이름으로만 가른다(review-model-identity.ts
 *   sameUnderlyingModel·reviewIndependenceKey). 이 규칙은 그 판정을 건드리지 않는다.
 * - **지금 보내는 호출**은 글자 그대로다: 장부 행(model_capacity_requests)·정책 route·계약·item binding·receipt·결과 기록은 부른 이름표로 끝난다
 *   (보낸 abcllm 행은 abcllm 으로 정산된다). 그런 자리는 이 모듈을 쓰지 않는다.
 * - 저장하는 값은 바꾸지 않는다. reviewerProviderKey 는 견줄 때만 쓰는 열쇠다 — 행·binding·hash 에 넣지 않는다.
 */
export const DIRECT_REVIEW_PROVIDERS = ["abcllm", "local-direct"] as const;
const DIRECT: ReadonlySet<string> = new Set(DIRECT_REVIEW_PROVIDERS);
/** 묶음의 견줌 열쇠 — 남는 이름표. */
const DIRECT_KEY = "local-direct";

/** 견줌 열쇠: 엔진 직접 묶음은 한 값, 나머지는 그대로. 저장하지 않는다. */
export const reviewerProviderKey = (provider: string): string => DIRECT.has(provider) ? DIRECT_KEY : provider;

/** 같은 심사자 provider 인가. 한쪽이라도 없으면(null) 다르다 — 예전의 `a === b`(pool 쪽은 늘 값이 있다)와 같다. */
export function sameReviewerProvider(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && reviewerProviderKey(a) === reviewerProviderKey(b);
}

/** 같은 심사자인가 — provider 는 동등 규칙, 모델은 장부 이름 글자 그대로. */
export function sameReviewer(a: { provider: string | null | undefined; model: string | null | undefined },
  b: { provider: string | null | undefined; model: string | null | undefined }): boolean {
  return sameReviewerProvider(a.provider, b.provider) && typeof a.model === "string" && a.model === b.model;
}

/** 이 provider 와 같은 심사자로 보는 이름표 모두(자기 포함). */
export const equivalentReviewerProviders = (provider: string): readonly string[] => DIRECT.has(provider) ? DIRECT_REVIEW_PROVIDERS : [provider];

const literals = (values: readonly string[]): SQL => sql.join(values.map(value => sql`${value}`), sql`, `);

/** reviewerProviderKey 의 SQL — 열·식 어느 쪽에도 건다. NULL 은 NULL 로 남는다. */
export function reviewerProviderKeySql(provider: SQLWrapper): SQL {
  return sql`(CASE WHEN ${provider} IN (${literals(DIRECT_REVIEW_PROVIDERS)}) THEN ${DIRECT_KEY} ELSE ${provider} END)`;
}

/** 열이 이 provider 와 같은 심사자 provider 인가 — 열을 감싸지 않아 색인 조건으로 남는다. */
export function reviewerProviderMatchSql(column: SQLWrapper, provider: string): SQL {
  const providers = equivalentReviewerProviders(provider);
  return providers.length === 1 ? sql`${column} = ${provider}` : sql`${column} IN (${literals(providers)})`;
}

/** 두 열(식)이 같은 심사자 provider 인가. NULL 은 어느 것과도 같지 않다(`a = b` 와 같다). */
export function sameReviewerProviderSql(a: SQLWrapper, b: SQLWrapper): SQL {
  return sql`${reviewerProviderKeySql(a)} = ${reviewerProviderKeySql(b)}`;
}

/** sameReviewer 의 SQL — 행의 (provider, model) 이 이 심사자의 것인가. */
export function sameReviewerSql(columns: { provider: SQLWrapper; model: SQLWrapper }, reviewer: { provider: string; model: string }): SQL {
  return sql`(${reviewerProviderMatchSql(columns.provider, reviewer.provider)} AND ${columns.model} = ${reviewer.model})`;
}
