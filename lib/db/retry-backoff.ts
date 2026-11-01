import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * 실패를 다시 볼 시각. 5분×2^attempts, 최대 24시간.
 *
 * 지수를 먼저 9로 자른다. 5분×2^9 = 2560분(약 42.7시간)이라 least(24시간)가 항상 그 뒤를 자른다.
 * 8로 자르면 5분×2^8 = 1280분(21.3시간)이라 24시간 상한에 닿기 전에 지연이 짧아진다.
 * interval 곱이 int64 마이크로초를 넘으면 22008이 난다. 이 작업 Postgres에서는
 * 5분×2^34는 되고 2^35에서 interval out of range다(운영 오류의 attempts=35와 같다).
 * least(24시간, …)는 그 곱을 만든 뒤에야 고르므로, 지수 상한이 먼저여야 한다.
 */
export function retryBackoffSql(attempts: SQLWrapper): SQL {
  return sql`now() + least(interval '24 hours', interval '5 minutes' * power(2, least(${attempts}, 9)))`;
}
