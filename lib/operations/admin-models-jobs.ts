import "server-only";
import { inArray, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { JOB_CATALOG } from "@/lib/jobs/catalog";

/**
 * 합성 잡 분해(PR 3a-C, lib/jobs/catalog.ts)로 생긴 reviewer 의 새 잡 다섯 — 스케줄러가 요청해야 돈다(새 잡 → scheduler 먼저).
 * 한 화면의 「새 잡 등록」 작은 표가 jobs 표의 등록 여부·다음 예정·마지막 실행을 보인다. 카탈로그에서 줄(lane)로 고른다 — 이름을 따로 적지 않는다.
 */
export const REVIEWER_SPLIT_LANES = Object.freeze(["held", "confirm", "tiebreak", "audit-qwen", "audit-opinion"] as const);
export const REVIEWER_SPLIT_JOBS: readonly { name: string; intervalMs: number | null }[] = JOB_CATALOG
  .filter(job => job.role === "reviewer" && job.lane !== undefined && (REVIEWER_SPLIT_LANES as readonly string[]).includes(job.lane))
  .map(job => ({ name: job.name, intervalMs: job.intervalMs }));

export type CatalogJobRegistration = { name: string; intervalMs: number | null; registered: boolean;
  /** 음수 = 아직 남은 초, 양수 = 지난 초. null = 예정 없음 */
  nextInSeconds: number | null; lastRunAgoSeconds: number | null; lastSuccessAgoSeconds: number | null; runs: number | null; lastError: string | null };
export type CatalogJobRegistrationView = { rows: CatalogJobRegistration[]; error: string | null };

/** jobs 표 읽기만. 행이 없으면 「미등록」(스케줄러가 아직 요청하지 않았다). 시각 차는 DB 시계(localtimestamp)로 센다 — 노드 시간대에 흔들리지 않는다. */
export async function readCatalogJobRegistration(catalog: readonly { name: string; intervalMs: number | null }[] = REVIEWER_SPLIT_JOBS): Promise<CatalogJobRegistrationView> {
  if (!catalog.length) return { rows: [], error: null };
  try {
    const age = (column: AnyPgColumn) => sql<number | null>`extract(epoch from (localtimestamp - ${column}))::double precision`;
    const found = await db.select({ name: jobs.name, nextAgo: age(jobs.nextScheduledAt), lastRunAgo: age(jobs.lastRunAt), lastSuccessAgo: age(jobs.lastSuccessAt),
      runs: jobs.runs, lastError: jobs.lastError }).from(jobs).where(inArray(jobs.name, catalog.map(job => job.name)));
    const seconds = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.round(Number(value));
    return { error: null, rows: catalog.map(job => {
      const row = found.find(item => item.name === job.name);
      return { name: job.name, intervalMs: job.intervalMs, registered: !!row, nextInSeconds: seconds(row?.nextAgo), lastRunAgoSeconds: seconds(row?.lastRunAgo),
        lastSuccessAgoSeconds: seconds(row?.lastSuccessAgo), runs: row ? Number(row.runs) : null, lastError: row?.lastError?.slice(0, 200) ?? null };
    }) };
  } catch (error) {
    return { rows: catalog.map(job => ({ name: job.name, intervalMs: job.intervalMs, registered: false, nextInSeconds: null, lastRunAgoSeconds: null,
      lastSuccessAgoSeconds: null, runs: null, lastError: null })), error: error instanceof Error ? error.message : "read_failed" };
  }
}
