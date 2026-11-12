import "server-only";
import { sql } from "drizzle-orm";
import { db, onReplica } from "@/lib/db";
import { withDbDeadline } from "@/lib/db/pool";
import { sharedStore } from "@/lib/cache/shared";
import { getSettings } from "@/lib/crawl/settings";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { EMBEDDING_MODEL } from "@/lib/domain/products/embedding";
import { JOB_CATALOG } from "@/lib/jobs/catalog";
import { jobIntervalOverrides } from "@/lib/jobs/job-intervals";
import { listJobStates } from "@/lib/jobs/runner";
import { logger } from "@/lib/observability/logger";
import { adminJobControlVersions } from "./admin-job-control";
import { modelServerHealth, type ModelServerHealth } from "./model-servers";
import { readRuntimeSettingsRow } from "./runtime-settings";
import { sharedLoader } from "./shared-cache";
import { sourcesFromSettings } from "./sources-defs";
import { cronJobDefs, type DegradedView, type JobView, type PauseView, type SignalStateRow, type SourceDef, type SourcesViewInput } from "./sources-model";
import { readDegraded, readPauses } from "./stage-panel-read";
import { readWorkerProgress } from "./worker-progress-query";

/**
 * 수집·작업 화면(조각 4a)의 읽기 — 모두 읽기 전용이고 읽기마다 따로 실패한다(못 읽은 칸은 null, 화면은 「읽지 못함」).
 * 무거운 집계는 웹 여러 대가 나눠 쓴다(sharedLoader, Valkey): 신호 × 후보 상태 7일(5분, 30분까지 지난 값), 워커 진행 대기(30초), 공개·벡터 수(5분).
 * 신호 집계는 시안 probe 의 found24·funnel7 과 같은 조인(crawl_frontier ⨝ crawl_candidates)을 7일 시간 범위로 한 번에 센다.
 */
export type SourcesRead = SourcesViewInput & {
  settings: CrawlSettings | null;
  defs: SourceDef[];
  funnel: { rows: SignalStateRow[]; measuredAt: string } | null;
  jobs: JobView[] | null;
  pauses: PauseView[] | null;
  degraded: DegradedView[] | null;
  /** 운영 설정의 잡 주기 덮어쓰기와 그 판(revision — 저장의 compare-and-set) */
  intervals: { overrides: Record<string, number>; revision: number } | null;
  waiting: Record<string, number | null> | null;
  embedding: { public: number; embedded: number; measuredAt: string } | null;
  servers: ModelServerHealth[] | null;
  versions: Record<string, number> | null;
  feedReads: Record<string, string>;
};

const funnelCache = sharedLoader<{ rows: SignalStateRow[]; measuredAt: string }>({ namespace: "admin:sources:funnel7", ttlMs: 300_000, staleMs: 1_800_000, store: sharedStore });
const waitingCache = sharedLoader<Record<string, number | null>>({ namespace: "admin:sources:waiting", ttlMs: 30_000, staleMs: 300_000, store: sharedStore });
const embeddingCache = sharedLoader<{ public: number; embedded: number; measuredAt: string }>({ namespace: "admin:sources:embedding", ttlMs: 300_000, staleMs: 1_800_000, store: sharedStore });

const quiet = (event: string) => (error: unknown) => {
  logger.warn(event, { errorName: error instanceof Error ? error.name : "unknown" });
  return null;
};
const iso = (value: Date | null | undefined) => value ? value.toISOString() : null;

function readOnly<T extends Record<string, unknown>>(timeout: string, query: ReturnType<typeof sql>) {
  return withDbDeadline(Date.now() + 10_000, () => onReplica(() => db.transaction(async tx => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeout}'`));
    await tx.execute(sql`SET LOCAL jit = off`);
    return Array.from(await tx.execute<T>(query));
  }, { accessMode: "read only" })));
}

/** 신호 × 후보 상태 — 7일 찾음과 그중 24시간 찾음. 시각은 DB 의 시각 칸(시간대 없음)과 같은 UTC 로 견준다 */
async function loadFunnel(): Promise<{ rows: SignalStateRow[]; measuredAt: string }> {
  const now = new Date();
  const at = sql`${now.toISOString()}::timestamp`;
  const rows = await readOnly<{ signal: string; state: string; n7: number; n24: number }>("8s", sql`
    SELECT f.signal AS signal, coalesce(c.state::text, 'none') AS state, count(*)::int AS n7,
      count(*) FILTER (WHERE f.discovered_at > ${at} - interval '24 hours')::int AS n24
    FROM crawl_frontier f LEFT JOIN crawl_candidates c ON c.repo = f.repo
    WHERE f.discovered_at > ${at} - interval '7 days'
    GROUP BY 1, 2`);
  return { rows: rows.map(row => ({ signal: row.signal, state: row.state, n7: Number(row.n7), n24: Number(row.n24) })), measuredAt: now.toISOString() };
}

/** 공개 제품 수와 지금 임베딩 모델로 벡터가 있는 수 — 제품 벡터의 대기(= 공개 − 벡터) */
async function loadEmbedding(): Promise<{ public: number; embedded: number; measuredAt: string }> {
  const [row] = await readOnly<{ public: number; embedded: number }>("6s", sql`
    SELECT (SELECT count(*) FROM products WHERE status IN ('seeded', 'verified'))::int AS public,
      (SELECT count(*) FROM products p JOIN product_embeddings e ON e.product_id = p.id AND e.model = ${EMBEDDING_MODEL}
        WHERE p.status IN ('seeded', 'verified'))::int AS embedded`);
  return { public: Number(row?.public ?? 0), embedded: Number(row?.embedded ?? 0), measuredAt: new Date().toISOString() };
}

/** 워커 진행의 단계 대기 — 잡 이름으로(원본 수집·규칙 심사·응답 점검·근거·AI 단계) */
async function loadWaiting(): Promise<Record<string, number | null>> {
  const report = await readWorkerProgress(new Date(), { includeText: false });
  return Object.fromEntries(report.stages.filter(stage => stage.job).map(stage => [stage.job!, stage.waiting ?? null]));
}

export async function readSources(fresh = false): Promise<SourcesRead> {
  const jobNames = [...new Set([...JOB_CATALOG.map(job => job.name)])];
  const [settings, funnel, jobs, pauses, degraded, row, waiting, embedding, servers, versions] = await Promise.all([
    getSettings().catch(quiet("admin.sources_settings_unavailable")),
    funnelCache("v1", loadFunnel, fresh).catch(quiet("admin.sources_funnel_unavailable")),
    listJobStates().catch(quiet("admin.sources_jobs_unavailable")),
    readPauses(jobNames).catch(quiet("admin.sources_pauses_unavailable")),
    readDegraded(jobNames).catch(quiet("admin.sources_degraded_unavailable")),
    readRuntimeSettingsRow().catch(quiet("admin.sources_runtime_unavailable")),
    waitingCache("v1", loadWaiting, fresh).catch(quiet("admin.sources_waiting_unavailable")),
    embeddingCache("v1", loadEmbedding, fresh).catch(quiet("admin.sources_embedding_unavailable")),
    modelServerHealth().catch(quiet("admin.sources_servers_unavailable")),
    adminJobControlVersions().catch(quiet("admin.sources_versions_unavailable")),
  ]);
  // 화면에서 더한 글 목록 수집원이 마지막으로 피드를 읽은 시각 — 글 목록 작업의 커서(feeds.<id>.readAt)
  const feedCursor = jobs?.find(job => job.name === "gn-show-seed")?.cursor as { feeds?: Record<string, { readAt?: unknown }> } | null | undefined;
  const feedReads = Object.fromEntries(Object.entries(feedCursor?.feeds ?? {}).flatMap(([id, state]) =>
    typeof state?.readAt === "string" && Number.isFinite(Date.parse(state.readAt)) ? [[id, state.readAt]] : []));
  return {
    checkedAt: new Date().toISOString(), settings, defs: settings ? sourcesFromSettings(settings) : [], funnel, feedReads,
    jobs: jobs ? jobs.map(job => ({ name: job.name, lastRunAt: iso(job.lastRunAt), lastSuccessAt: iso(job.lastSuccessAt), lastError: job.lastError,
      notBefore: iso(job.notBefore), nextScheduledAt: iso(job.nextScheduledAt), lockedAt: iso(job.lockedAt) })) : null,
    pauses: pauses ? pauses.map(({ job, actor, at, reason }) => ({ job, actor, at, reason })) : null,
    degraded: degraded ? degraded.map(({ job, code, detail, streak, since }) => ({ job, code, detail, streak, since })) : null,
    intervals: row ? { overrides: Object.fromEntries(jobIntervalOverrides(row.values)), revision: row.revision } : null,
    waiting, embedding, servers, versions,
  };
}

/** 주기 작업 표의 줄(카탈로그) — 화면이 그대로 쓴다 */
export const CRON_JOBS = cronJobDefs();
