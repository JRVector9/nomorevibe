import { inArray, sql, type SQLWrapper } from "drizzle-orm";

export const MAX_PROFILE_ATTEMPTS = 5;

/** 명확한 공급자 장애만 품질 실패 상한에서 제외한다. timeout은 원인을 구별할 수 없다. */
const PROVIDER_ERRORS = ["rate_limited", "rate_limit", "model_unavailable", "network", "no_key"];
const providerErrors = new Set(PROVIDER_ERRORS);

export function isProfileProviderError(error: string | null): boolean {
  return error !== null && providerErrors.has(error);
}

export function canRetryProfileGeneration(error: string | null, attempts: number): boolean {
  return attempts < MAX_PROFILE_ATTEMPTS || isProfileProviderError(error);
}

/** selector와 ready 관측이 같은 오류 분류를 사용한다. retry_at 조건은 호출자가 유지한다. */
export function profileGenerationRetryAllowedSql(error: SQLWrapper, attempts: SQLWrapper) {
  return sql`(${attempts} < ${MAX_PROFILE_ATTEMPTS} or ${inArray(error, PROVIDER_ERRORS)})`;
}
