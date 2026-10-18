import { sql } from "drizzle-orm";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { DB_CLOCK_SQL, replicaCache } from "./replica-cache";
import type { ReplicaRead } from "./replica-hold";
import { buildWorkerProgress, evidenceProgress, withProviderBackoff } from "./worker-progress-query";
import { parseAgentProviderFailure, type ProgressStageInput, type StageProgress } from "./worker-progress";

/**
 * 운영센터 개편 v8 의 새 숫자 — 지금 화면에 없던 수만 여기서 읽는다. 지금 있는 숫자는 지금처럼 렌더마다 읽는다(render-reads.ts).
 *
 * 모두 복제본 전용(readReplicaOnly)이고, 못 읽으면 보류다. 값마다 DB 시각(at)을 달아 화면이 "기준 08:44:02 (DB)"로 보인다.
 * 캐시는 인스턴스마다 따로라 m3·mini 가 같은 시각 근처에서 조금 다른 수를 보일 수 있다 — 그래서 DB 시각을 단다.
 */

/** 이번 시(정시부터 DB 지금까지) 프론티어에 들어온 레포를 신호별로 — 들어오는 곳 칸의 GitHub / Show HN 나눔 */
export type SourceSplit = { at: string; signals: { signal: string; count: number }[] };

/** 프론티어(작은 표, 인덱스 없는 discovered_at)를 한 번 훑는다. 정시 경계도 DB 시계로 잰다 */
const SOURCE_SPLIT_SQL = sql`
  WITH clock AS MATERIALIZED (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at)
  SELECT ${DB_CLOCK_SQL} AS at, coalesce((
    SELECT jsonb_agg(jsonb_build_object('signal', s.signal, 'count', s.n) ORDER BY s.n DESC, s.signal) FROM (
      SELECT f.signal, count(*)::int AS n FROM crawl_frontier f, clock
      WHERE f.discovered_at >= date_trunc('hour', clock.at) AND f.discovered_at <= clock.at GROUP BY f.signal
    ) s), '[]'::jsonb) AS signals`;

const splitCache = replicaCache<SourceSplit>({ event: "operations.source_split_unavailable", ttlMs: 60_000, bypass: false });

function signalRows(value: unknown): SourceSplit["signals"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => row && typeof row.signal === "string" && Number.isSafeInteger(row.count) && row.count >= 0
    ? [{ signal: row.signal as string, count: row.count as number }] : []);
}

/** 복제본 전용 · 60초 캐시(새로고침도 건너뛰지 않는다) · 열쇠는 이번 시 — 정시가 지나면 새로 센다 */
export function readSourceSplit(now = new Date()): Promise<ReplicaRead<SourceSplit>> {
  return splitCache(String(Math.floor(now.getTime() / 3_600_000)), async (replica) => {
    const [row] = await replica.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL jit = off`);
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      return tx.execute<{ at: string; signals: unknown }>(SOURCE_SPLIT_SQL);
    }, { accessMode: "read only" });
    return { at: row.at, signals: signalRows(row.signals) };
  });
}

/** 보강 근거 3단계(공개 근거·개발 AI 근거·AI 단계)의 판정 — 배포 관문과 같은 SQL·같은 판정, 복제본에서 */
export type EvidenceVerdicts = { at: string; stages: StageProgress[] };

/** 근거 CTE 는 무겁다(3초 상한) — 20초 캐시, 새로고침이 건너뛰어도 인스턴스당 1분에 3번까지 */
const evidenceCache = replicaCache<{ at: string; rows: ProgressStageInput[] }>({
  event: "operations.evidence_verdicts_unavailable", ttlMs: 20_000, bypass: true, perMinute: 3,
});

type EvidenceJob = { name: string; nextScheduledAt: Date | null; notBefore: Date | null; lockedAt?: Date | null;
  leaseToken?: string | null; cursor?: unknown; lastError?: string | null };

export async function readEvidenceVerdicts(input: {
  settings: CrawlSettings; jobs: EvidenceJob[];
  observations: Array<{ key: string; value: Record<string, unknown>; observedAt: Date | string }>;
  batch: { mode: string; writerContractVersion: number } | null; now: Date; fresh: boolean;
}): Promise<ReplicaRead<EvidenceVerdicts>> {
  const { settings, jobs, now } = input;
  // readWorkerProgress 와 같은 입력 — AI 단계의 안 본 대상 쉬기, 개발 AI 근거의 공급자 실패
  const aiCursor = jobs.find((job) => job.name === "ai-level-refresh")?.cursor as { unseenIdleUntil?: unknown } | null;
  const idleUntil = typeof aiCursor?.unseenIdleUntil === "string" ? Date.parse(aiCursor.unseenIdleUntil) : NaN;
  const skipUnseen = Number.isFinite(idleUntil) && idleUntil > now.getTime();
  const agentCursor = jobs.find((job) => job.name === "agent-evidence-refresh")?.cursor as { providerFailure?: unknown } | null;
  const failure = parseAgentProviderFailure(agentCursor?.providerFailure);
  const key = JSON.stringify([settings.agentEvidence.enabled, settings.agentEvidence.backgroundRefreshDays, skipUnseen, failure]);
  const read = await evidenceCache(key, async (replica) => {
    const [clock] = await replica.execute<{ at: string }>(sql`SELECT ${DB_CLOCK_SQL} AS at`);
    return { at: clock.at, rows: await evidenceProgress(replica, settings, new Date(clock.at), skipUnseen, failure) };
  }, input.fresh);
  if (!read.ok) return read;
  // 판정은 렌더마다 지금 잡 상태로 한다(재시도 보정·일시 중지·워커 생존) — 숫자만 캐시에서 온다
  const report = buildWorkerProgress({ measuredAt: read.value.at, stages: [] }, withProviderBackoff(jobs, now), input.observations, now,
    input.batch ?? { mode: "legacy", writerContractVersion: 0 }, read.value.rows);
  return { ok: true, value: { at: read.value.at, stages: report.stages } };
}
