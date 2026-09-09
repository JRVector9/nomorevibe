import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, products } from "@/lib/db/schema";

/**
 * 파이프라인 단계별 적체와 흐름.
 *
 * 적체 수만 보면 어디가 막혔는지 알 수 없다 — 100건이 쌓여 있어도 하루 100건이 빠지면
 * 막힌 것이 아니고, 4건이 쌓여 있어도 하루 0건이 빠지면 막힌 것이다. 들어온 양과 빠진
 * 양을 함께 봐야 병목이 보인다.
 */
export type PipelineStage = {
  key: string;
  label: string;
  /** 지금 이 단계에 있는 수 */
  waiting: number;
  /** 지난 24시간 동안 들어온 수 (모르면 null) */
  entered: number | null;
  /** 지난 24시간 동안 빠진 수 (모르면 null) */
  left: number | null;
  /** 이 단계를 처리하는 작업. 사람이 하는 단계면 null */
  job: string | null;
};

export type PipelineFlow = {
  stages: PipelineStage[];
  /** 들어온 것보다 빠진 것이 적으면서 가장 많이 쌓인 단계 */
  bottleneck: string | null;
  published: number;
};

/**
 * 빠진 것이 없는데 쌓여 있는 단계가 병목이다.
 *
 * left 가 null 인 단계(누적·공개)는 빠지는 것을 재지 않으므로 후보가 아니다 — 0으로
 * 취급하면 가장 큰 누적값이 늘 병목으로 잡힌다.
 */
export function findBottleneck(stages: PipelineStage[]): string | null {
  return stages
    .filter((stage) => stage.left === 0 && stage.waiting > 0)
    .sort((a, b) => b.waiting - a.waiting)[0]?.key ?? null;
}

const count = sql<number>`count(*)::int`;
const since = () => new Date(Date.now() - 24 * 3_600_000);

/** 한 번의 왕복으로 단계별 수를 센다 — 화면 한 장에 쿼리를 흩뿌리지 않는다 */
export async function pipelineFlow(): Promise<PipelineFlow> {
  const from = since();
  const [frontier, candidates, published, discovered, fetched, judged, decided, listed] = await Promise.all([
    db.select({ state: crawlFrontier.state, count }).from(crawlFrontier).groupBy(crawlFrontier.state),
    db.select({ state: crawlCandidates.state, count }).from(crawlCandidates).groupBy(crawlCandidates.state),
    db.select({ count }).from(products).where(inArray(products.status, ["verified", "seeded"])),
    db.select({ count }).from(crawlFrontier).where(gte(crawlFrontier.discoveredAt, from)),
    db.select({ count }).from(crawlDocuments).where(gte(crawlDocuments.fetchedAt, from)),
    db.select({ count }).from(crawlCandidates).where(gte(crawlCandidates.judgedAt, from)),
    db.select({ count }).from(crawlCandidates).where(and(gte(crawlCandidates.decidedAt, from), isNotNull(crawlCandidates.decidedAt))),
    db.select({ count }).from(products).where(gte(products.createdAt, from)),
  ]);

  const byState = (rows: { state: string; count: number }[], ...states: string[]) =>
    rows.filter((row) => states.includes(row.state)).reduce((sum, row) => sum + row.count, 0);

  // 사람 심사에서 빠진 수 = 지난 24시간에 사람이 결정한 것
  const reviewed = decided[0].count;
  const stages: PipelineStage[] = [
    // 프론티어는 발견과 수집 사이의 큐 하나다. 두 단계가 같은 행을 세면 적체가 부풀려진다.
    { key: "discover", label: "발견 누적", waiting: byState(frontier, "pending", "fetching", "done", "failed", "skipped"),
      entered: discovered[0].count, left: null, job: "crawl-seed" },
    { key: "fetch", label: "원본 수집 대기", waiting: byState(frontier, "pending", "fetching"),
      entered: discovered[0].count, left: fetched[0].count, job: "crawl-fetch" },
    { key: "judge", label: "규칙 판정", waiting: byState(candidates, "new"),
      entered: judged[0].count, left: judged[0].count, job: "crawl-judge" },
    { key: "review", label: "사람 심사", waiting: byState(candidates, "needs_review"),
      entered: null, left: reviewed, job: null },
    { key: "publish", label: "분류·발행", waiting: byState(candidates, "approved"),
      entered: null, left: listed[0].count, job: "crawl-publish" },
    { key: "public", label: "공개", waiting: published[0].count,
      entered: listed[0].count, left: null, job: null },
  ];

  return { stages, bottleneck: findBottleneck(stages), published: published[0].count };
}

/** 심사 큐에서 가장 오래 기다린 후보의 나이(일). 없으면 null */
export async function oldestReviewWaitDays(): Promise<number | null> {
  const [row] = await db.select({ at: sql<Date | null>`min(${crawlCandidates.judgedAt})` })
    .from(crawlCandidates).where(eq(crawlCandidates.state, "needs_review"));
  if (!row?.at) return null;
  return Math.floor((Date.now() - new Date(row.at).getTime()) / 86_400_000);
}

/** 판정한 지 오래됐는데 아직 큐에 있는 수 — 기준이 바뀌었는지 의심할 근거 */
export async function stalledReviewCount(days = 14): Promise<number> {
  const [row] = await db.select({ count }).from(crawlCandidates).where(and(
    eq(crawlCandidates.state, "needs_review"),
    lt(crawlCandidates.judgedAt, new Date(Date.now() - days * 86_400_000)),
  ));
  return row.count;
}
