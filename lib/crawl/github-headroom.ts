import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { parseCoreQuota, type CollectorScope } from "./github-secret";

/** 전체 core 남은 비율이 이 아래면 뒤로 미뤄도 되는 수집(제작 근거 스캔)은 새 일을 시작하지 않는다 */
export const GITHUB_HEADROOM_MIN_RATIO = 0.25;
/** reset 이 이만큼 안에 오면 미루지 않는다 — 곧 새 창이 열린다 */
const RESET_GRACE_MS = 5 * 60_000;

export type GitHubCoreHeadroom = { remaining: number; limit: number; low: boolean };

/**
 * 켜진 수집 자격(개인 토큰·GitHub App 설치)이 마지막으로 본 core 한도의 합.
 *
 * 한도는 observeCollectorQuota(github-accounts.ts)가 응답 헤더에서 30초 단위로 적는다. reset 이 지난 행은 새 창이 열려
 * 가득 찬 것으로 본다. 관측이 없는 자격은 셈에서 뺀다. 셀 행이 없으면(환경 토큰만 쓰는 배포 등) null — 미루지 않는다.
 * 환경 토큰(GITHUB_TOKEN)은 한도를 적지 않아 이 합에 들지 않는다.
 *
 * scope(collectorScope, github-secret.ts)를 주면 이 프로세스가 실제로 쓰는 자격만 센다 — 자격 종류와 App 설치 허용·제외 목록이
 * collectorTokens 와 같다. 쓰지 않는 자격의 표는 읽지도 않는다(App 전용 Oracle 계정은 개인 토큰 표 권한이 없다). null 이면 지금처럼 전부.
 */
export async function readGitHubCoreHeadroom(now = Date.now(), scope: CollectorScope | null = null): Promise<GitHubCoreHeadroom | null> {
  const uses = (source: "accounts" | "apps") => scope === null || scope.sources.has(source);
  const installations = (ids: number[] | null, negate: boolean) => !ids ? sql`` : negate
    ? sql` AND installation_id NOT IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`
    : sql` AND installation_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`;
  const parts: SQL[] = [];
  if (uses("accounts")) parts.push(sql`SELECT core_quota FROM github_collector_accounts WHERE enabled`);
  if (uses("apps")) parts.push(sql`SELECT core_quota FROM github_collector_apps WHERE enabled${installations(scope?.onlyInstallations ?? null, false)}${
    installations(scope?.excludedInstallations ?? null, true)}`);
  if (parts.length === 0) return null;
  const rows = await db.execute<{ core_quota: unknown }>(sql.join(parts, sql` UNION ALL `));
  let remaining = 0, limit = 0, soonestReset = Infinity;
  for (const row of rows) {
    const quota = parseCoreQuota(row.core_quota);
    if (!quota || quota.limit === 0) continue;
    limit += quota.limit;
    if (quota.reset * 1_000 <= now) { remaining += quota.limit; continue; }
    remaining += Math.min(quota.remaining, quota.limit);
    soonestReset = Math.min(soonestReset, quota.reset * 1_000);
  }
  if (limit === 0) return null;
  return { remaining, limit, low: remaining / limit < GITHUB_HEADROOM_MIN_RATIO && soonestReset - now > RESET_GRACE_MS };
}
