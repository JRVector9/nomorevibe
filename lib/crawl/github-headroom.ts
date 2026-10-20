import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { parseCoreQuota } from "./github-secret";

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
 */
export async function readGitHubCoreHeadroom(now = Date.now()): Promise<GitHubCoreHeadroom | null> {
  const rows = await db.execute<{ core_quota: unknown }>(sql`
    SELECT core_quota FROM github_collector_accounts WHERE enabled
    UNION ALL SELECT core_quota FROM github_collector_apps WHERE enabled
  `);
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
