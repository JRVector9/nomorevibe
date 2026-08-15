import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { logger } from "@/lib/observability/logger";

/**
 * 백그라운드 작업 러너.
 *
 * 큐 서버를 두지 않는다. 작업당 행 하나에 커서를 남기고, 매 틱이 그 지점부터 이어받는다.
 *
 * 핵심 제약은 "한 틱은 유한하다"는 것이다. HTTP 요청 안에서 돌기 때문에 무한정 이어갈 수
 * 없고, GitHub 수집기처럼 rate limit에 걸리는 작업은 애초에 한 번에 끝낼 수도 없다.
 * 그래서 작업은 시간 예산 안에서 할 수 있는 만큼만 하고 커서를 저장한 뒤 물러난다.
 */

/** 잠금이 이 시간보다 오래되면 죽은 프로세스가 남긴 것으로 보고 회수한다 */
const STALE_LOCK_MS = 10 * 60 * 1000;

/** 한 틱의 기본 시간 예산 — HTTP 타임아웃보다 넉넉히 짧게 */
const DEFAULT_BUDGET_MS = 25_000;

export type JobContext<C> = {
  /** 지난 틱이 남긴 재개 지점 (첫 실행이면 null) */
  cursor: C | null;
  /**
   * 진행 지점을 즉시 저장한다.
   * 여기까지는 프로세스가 죽어도 남으므로, 되풀이하면 곤란한 작업 직후에 부른다.
   */
  save: (cursor: C) => Promise<void>;
  /** 시간 예산이 남았는지 — 반복문마다 확인해서 넘기 전에 물러난다 */
  hasBudget: () => boolean;
  log: (event: string, fields?: Record<string, unknown>) => void;
};

export type JobOutcome<C> = {
  /** true면 커서를 비워 다음 틱이 처음부터 시작한다 (주기 작업의 한 사이클 완료) */
  done: boolean;
  cursor?: C | null;
};

export type RunResult =
  | { status: "completed"; done: boolean; durationMs: number }
  | { status: "skipped"; reason: "locked" }
  | { status: "failed"; error: string; durationMs: number };

/** 잠금 획득 — 유휴 상태이거나 잠금이 오래된 작업만 가져간다 (조건부 UPDATE로 원자적) */
async function acquireLock(name: string, now: Date): Promise<{ cursor: unknown } | null> {
  // 행이 없으면 먼저 만든다. 이미 있으면 아무것도 하지 않는다.
  await db.insert(jobs).values({ name }).onConflictDoNothing();

  const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
  const claimed = await db
    .update(jobs)
    .set({ lockedAt: now, lastRunAt: now, runs: sql`${jobs.runs} + 1`, updatedAt: now })
    .where(and(eq(jobs.name, name), or(isNull(jobs.lockedAt), lt(jobs.lockedAt, staleBefore))))
    .returning({ cursor: jobs.cursor });

  return claimed[0] ?? null;
}

async function releaseLock(name: string, fields: Partial<typeof jobs.$inferInsert>) {
  await db
    .update(jobs)
    .set({ lockedAt: null, updatedAt: new Date(), ...fields })
    .where(eq(jobs.name, name));
}

/**
 * 작업을 한 틱 실행한다.
 * 이미 실행 중이면 건너뛴다 — 스케줄러가 겹쳐 호출해도 중복 실행되지 않는다.
 */
export async function runJob<C>(
  name: string,
  handler: (ctx: JobContext<C>) => Promise<JobOutcome<C>>,
  options: { budgetMs?: number } = {},
): Promise<RunResult> {
  const startedAt = Date.now();
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const now = new Date();

  const claimed = await acquireLock(name, now);
  if (!claimed) {
    logger.info("job.skipped", { job: name, reason: "locked" });
    return { status: "skipped", reason: "locked" };
  }

  let cursor = (claimed.cursor ?? null) as C | null;

  const ctx: JobContext<C> = {
    get cursor() {
      return cursor;
    },
    save: async (next) => {
      cursor = next;
      await db.update(jobs).set({ cursor: next, updatedAt: new Date() }).where(eq(jobs.name, name));
    },
    hasBudget: () => Date.now() - startedAt < budgetMs,
    log: (event, fields) => logger.info(event, { job: name, ...fields }),
  };

  try {
    const outcome = await handler(ctx);
    const nextCursor = outcome.done ? null : (outcome.cursor ?? cursor);
    const finishedAt = new Date();

    await releaseLock(name, {
      cursor: nextCursor as never,
      lastSuccessAt: finishedAt,
      lastError: null,
    });

    const durationMs = Date.now() - startedAt;
    logger.info("job.completed", { job: name, done: outcome.done, durationMs });
    return { status: "completed", done: outcome.done, durationMs };
  } catch (error) {
    // 실패해도 커서는 건드리지 않는다 — 다음 틱이 같은 지점에서 다시 시도한다
    const message = error instanceof Error ? error.message : String(error);
    await releaseLock(name, { lastError: message.slice(0, 2000) });

    const durationMs = Date.now() - startedAt;
    logger.error("job.failed", { job: name, durationMs, error });
    return { status: "failed", error: message, durationMs };
  }
}

/** 작업 상태 조회 (운영 점검용) */
export async function getJobState(name: string) {
  return db.query.jobs.findFirst({ where: eq(jobs.name, name) });
}
