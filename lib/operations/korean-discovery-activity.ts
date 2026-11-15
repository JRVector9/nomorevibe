import { sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { withDbDeadline } from "@/lib/db/pool";
import { DISCOVERY_PROGRESS_PREFIX } from "@/lib/crawl/discovery-progress-contract";
import { KOREAN_STAGING_MAX_PENDING } from "@/lib/crawl/korean-discovery/contracts";

/**
 * 한국어 탐색(Oracle `github-ko-discovery` consumer)이 실제로 일했는가 — 운영 홈 할 일 「한국어 탐색 멈춤」의 입력(console-tasks.ts).
 *
 * 2026-11-15: 짧은 DB 불통 뒤 Oracle consumer 가 systemd 시작 한도에 걸려 03:16~10:53Z 7.5시간 멈췄다. 11-13 뒤로 한글 검색어는 Oracle 만 검색하므로
 * 한국어 탐색 전체가 0이었는데, M3 의 적용 잡(crawl-ko-apply)은 계속 돌아 겉으로는 정상이었다. 켜짐 스위치·살아 있음은 일의 증거가 아니다 —
 * 그래서 「일」은 그 consumer 가 남기는 탐색 진행 기록(discovery-progress:korean:*, 검색 페이지를 쌓을 때와 언어 확인 한 건마다 쓴다)의 마지막 시각이다.
 * Oracle 일꾼 신호(heartbeat)는 원인을 가르는 사실 한 줄로만 쓴다.
 */
export type KoreanDiscoveryActivity = {
  /** 읽은 DB 시계(UTC ISO) — 나이는 이 시계로 잰다(웹·워커 시계 차이와 무관) */
  at: string;
  /** github_ko_discovery_control.enabled — 행이 없으면 false(아직 켜지 않음) */
  enabled: boolean;
  /** 수집 전체 스위치(crawl_settings.values.enabled). 꺼져 있으면 consumer 는 일부러 쉰다 */
  collectionEnabled: boolean;
  /** Oracle 한국어 consumer 의 마지막 탐색 진행 기록(검색 페이지 적재·언어 확인). 기록이 없으면 null */
  workAt: string | null;
  /** Oracle 한국어 consumer 의 마지막 running heartbeat. 없으면 null */
  heartbeatAt: string | null;
  /** 언어 확인 대기(pending) — KOREAN_STAGING_MAX_PENDING 까지만 센다 */
  pending: number;
  pendingTruncated: boolean;
};

const iso = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** DB 행 → 입력. 모양이 틀리면 던진다(읽기 실패 = 「셀 수 없음」, 0 이나 꺼짐이 아니다) */
export function buildKoreanDiscoveryActivity(row: { at: unknown; enabled: unknown; collectionEnabled: unknown; workAt: unknown;
  heartbeatAt: unknown; pending: unknown }): KoreanDiscoveryActivity {
  const at = iso(row.at), pending = Number(row.pending);
  if (!at || typeof row.enabled !== "boolean" || typeof row.collectionEnabled !== "boolean" || !Number.isSafeInteger(pending) || pending < 0)
    throw new Error("invalid_korean_discovery_activity");
  return { at, enabled: row.enabled, collectionEnabled: row.collectionEnabled, workAt: iso(row.workAt), heartbeatAt: iso(row.heartbeatAt),
    pending: Math.min(pending, KOREAN_STAGING_MAX_PENDING), pendingTruncated: pending > KOREAN_STAGING_MAX_PENDING };
}

/** 주 DB 읽기 전용 거래 한 번(3초 문장 상한). 실패는 던진다 — 부르는 쪽이 null(셀 수 없음)로 바꾼다 */
export async function loadKoreanDiscoveryActivity(): Promise<KoreanDiscoveryActivity> {
  const prefix = `${DISCOVERY_PROGRESS_PREFIX}korean:%`;
  return withDbDeadline(Date.now() + 4000, () => onPrimary(() => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    const [row] = await tx.execute<Parameters<typeof buildKoreanDiscoveryActivity>[0]>(sql`
      SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
        coalesce((SELECT enabled FROM github_ko_discovery_control WHERE id = 1), false) AS enabled,
        coalesce((SELECT (values->>'enabled')::boolean FROM crawl_settings WHERE id = 1), false) AS "collectionEnabled",
        (SELECT to_char(max(observed_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM operations_observations
          WHERE key LIKE ${prefix} AND value->>'worker' LIKE 'github-ko-discovery-consumer-%') AS "workAt",
        (SELECT to_char(max(observed_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM operations_observations
          WHERE key LIKE 'service:crawler:github-ko-discovery-consumer-%' AND value->>'status' = 'running') AS "heartbeatAt",
        (SELECT count(*)::integer FROM (SELECT repo FROM github_ko_discovery_staging WHERE state = 'pending'
          LIMIT ${KOREAN_STAGING_MAX_PENDING + 1}) p) AS pending`);
    if (!row) throw new Error("korean_discovery_activity_missing");
    return buildKoreanDiscoveryActivity(row);
  }, { accessMode: "read only" })));
}
