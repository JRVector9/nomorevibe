import type { JobContext, JobOutcome } from "./runner";
import { seedFrontier } from "@/lib/crawl/jobs/seed";
import { fetchCrawlDocuments } from "@/lib/crawl/jobs/fetch";
import { judgeCrawlDocuments } from "@/lib/crawl/jobs/judge";

/**
 * 이름 → 작업 매핑.
 *
 * 진입점(HTTP cron, CLI)이 이 목록만 보고 실행한다.
 * 앞으로 붙을 것: click-rollup(집계), uptime-ping(생존 확인).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 작업마다 커서 타입이 다르다
export type AnyJob = (ctx: JobContext<any>) => Promise<JobOutcome<any>>;

export const JOBS: Record<string, AnyJob> = {
  /**
   * 러너와 스케줄러 연결이 살아 있는지 확인하는 작업.
   * 실행될 때마다 카운터를 올리므로, 커서가 늘고 있으면 스케줄이 도는 것이다.
   */
  heartbeat: async (ctx) => {
    const count = ((ctx.cursor as { count?: number } | null)?.count ?? 0) + 1;
    await ctx.save({ count });
    ctx.log("heartbeat.tick", { count });
    return { done: false, cursor: { count } };
  },

  /** GitHub 검색으로 프론티어를 채운다 — 파이프라인의 입구 */
  "crawl-seed": seedFrontier,

  /** 프론티어에서 꺼낸 레포의 원본(레포 메타 + 배포 페이지)을 확보한다 */
  "crawl-fetch": fetchCrawlDocuments,

  /** 수집한 원본에 현재 기준을 적용해 후보로 남긴다 */
  "crawl-judge": judgeCrawlDocuments,
};

export const JOB_NAMES = Object.keys(JOBS);
