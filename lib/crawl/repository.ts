import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  crawlFrontier,
  crawlDocuments,
  crawlCandidates,
  type FrontierEntry,
  type FrontierState,
  type CrawlDocument,
  type CrawlCandidate,
  type CandidateState,
  type DecisionReason,
} from "@/lib/db/schema";

/** 크롤 파이프라인 데이터 접근 — 파이프라인 바깥에서 이 테이블들을 직접 만지지 않는다 */

// ─────────────────────────── 프론티어 ───────────────────────────

/** 실패 시 재시도 간격 (분). 소진되면 failed로 내린다 */
const BACKOFF_MINUTES = [5, 30, 180];
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;

/**
 * 시각은 DB 것만 쓴다.
 *
 * next_attempt_at은 DB의 now()로 들어가는데 비교값을 클라이언트에서 만들어 보내면,
 * 두 시계의 스큐(로컬 Docker에서 실측 20ms)만큼 큐가 어긋난다. 방금 넣은 항목이
 * "아직 시간이 안 됐다"며 안 꺼내지는 식이다. 프로덕션에서도 앱 서버와 DB 시계는
 * 항상 다르므로, 비교 기준을 한쪽으로 몰아야 한다.
 *
 * 테스트에서 백오프를 검증하려면 시각을 밀어야 해서 주입은 열어둔다.
 */
function nowExpr(at?: Date) {
  return at ? sql`${at.toISOString()}::timestamp` : sql`now()`;
}

/**
 * 발견한 레포를 큐에 넣는다.
 * 이미 있으면 아무것도 하지 않는다 — 같은 레포가 여러 검색 결과에 나와도 한 번만 조사한다.
 */
export async function enqueue(
  entries: { repo: string; signal: string; priority?: number }[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const inserted = await db
    .insert(crawlFrontier)
    .values(entries.map((e) => ({ repo: e.repo, signal: e.signal, priority: e.priority ?? 0 })))
    .onConflictDoNothing({ target: crawlFrontier.repo })
    .returning({ id: crawlFrontier.id });
  return inserted.length;
}

/**
 * 조사할 대상을 꺼낸다.
 *
 * FOR UPDATE SKIP LOCKED로 잠근 뒤 상태를 바꾼다. 작업 러너가 이름별 잠금을 걸지만,
 * 죽은 프로세스의 잠금을 회수하는 순간에는 두 프로세스가 겹칠 수 있다.
 * 그때 같은 항목을 둘이 가져가면 GitHub 호출이 낭비된다.
 */
export async function dequeue(limit: number, now?: Date): Promise<FrontierEntry[]> {
  const at = nowExpr(now);

  // 잠금과 갱신을 한 트랜잭션에 둔다. SELECT ... FOR UPDATE의 잠금은 트랜잭션이
  // 끝날 때 풀리므로, 두 문장을 트랜잭션 밖에서 나눠 쓰면 잠금이 무의미해진다.
  const rows = await db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: crawlFrontier.id })
      .from(crawlFrontier)
      .where(
        and(
          inArray(crawlFrontier.state, ["pending", "fetching"]),
          lte(crawlFrontier.nextAttemptAt, at),
        ),
      )
      .orderBy(desc(crawlFrontier.priority), asc(crawlFrontier.nextAttemptAt))
      .limit(limit)
      .for("update", { skipLocked: true });

    if (locked.length === 0) return [];

    return tx
      .update(crawlFrontier)
      .set({
        state: "fetching",
        attempts: sql`${crawlFrontier.attempts} + 1`,
        nextAttemptAt: sql`${at} + interval '10 minutes'`,
        updatedAt: sql`${at}`,
      })
      .where(
        inArray(
          crawlFrontier.id,
          locked.map((l) => l.id),
        ),
      )
      .returning();
  });

  // RETURNING은 순서를 보장하지 않는다 — 갱신된 순서로 나올 뿐이다.
  // 무엇을 꺼낼지는 SQL이 정하고, 어떤 순서로 처리할지는 여기서 확정한다.
  return rows.sort(
    (a, b) => b.priority - a.priority || a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime(),
  );
}

export async function markFrontier(
  repo: string,
  state: Extract<FrontierState, "done" | "skipped">,
): Promise<void> {
  await db
    .update(crawlFrontier)
    .set({ state, lastError: null, updatedAt: new Date() })
    .where(eq(crawlFrontier.repo, repo));
}

/**
 * 실패 기록. 재시도가 남았으면 백오프로 미루고, 소진되면 failed로 내린다.
 * 일시적 장애(rate limit, 네트워크)와 영구적 실패를 같게 다루면 큐가 막히거나 영원히 돈다.
 */
export async function markFailed(repo: string, error: string, now?: Date): Promise<void> {
  const current = await db.query.crawlFrontier.findFirst({ where: eq(crawlFrontier.repo, repo) });
  if (!current) return;

  const exhausted = current.attempts >= MAX_ATTEMPTS;
  const backoff = BACKOFF_MINUTES[Math.min(current.attempts - 1, BACKOFF_MINUTES.length - 1)] ?? 5;
  const at = nowExpr(now);

  await db
    .update(crawlFrontier)
    .set({
      state: exhausted ? "failed" : "pending",
      // 소진됐으면 다음 시도 시각을 건드리지 않는다 (어차피 다시 꺼내지 않는다)
      nextAttemptAt: exhausted
        ? crawlFrontier.nextAttemptAt
        : sql`${at} + ${`${backoff} minutes`}::interval`,
      lastError: error.slice(0, 2000),
      updatedAt: sql`${at}`,
    })
    .where(eq(crawlFrontier.repo, repo));
}

/**
 * 다시 조사할 대상으로 되돌린다.
 *
 * 판정 기준을 바꿀 때는 재판정으로 끝나지만, 원본에서 뽑는 방법을 바꿀 때는 여기까지 와야 한다.
 * crawl_documents의 pageMeta는 원본이 아니라 가져올 때 뽑아 둔 가공물이라, 추출 로직을
 * 고쳐도 이미 저장된 값은 그대로다. 실제로 제목의 실체 참조를 늦게 고쳤을 때 겪었다.
 */
export async function requeue(repos: string[], now?: Date): Promise<number> {
  if (repos.length === 0) return 0;
  const at = nowExpr(now);
  const updated = await db
    .update(crawlFrontier)
    .set({ state: "pending", attempts: 0, nextAttemptAt: at, lastError: null, updatedAt: at })
    .where(inArray(crawlFrontier.repo, repos))
    .returning({ id: crawlFrontier.id });
  return updated.length;
}

export async function frontierCounts(): Promise<Record<string, number>> {
  const rows = await db
    .select({ state: crawlFrontier.state, count: sql<number>`count(*)::int` })
    .from(crawlFrontier)
    .groupBy(crawlFrontier.state);
  return Object.fromEntries(rows.map((r) => [r.state, r.count]));
}

// ─────────────────────────── 원본 ───────────────────────────

/** 원본을 저장한다. 다시 가져오면 덮어쓴다 (재방문 시 최신 상태로) */
export async function putDocument(doc: {
  repo: string;
  repoMeta: Record<string, unknown>;
  productUrl?: string | null;
  pageStatus?: number | null;
  pageMeta?: Record<string, unknown> | null;
}): Promise<void> {
  const values = {
    repo: doc.repo,
    repoMeta: doc.repoMeta,
    productUrl: doc.productUrl ?? null,
    pageStatus: doc.pageStatus ?? null,
    pageMeta: doc.pageMeta ?? null,
    fetchedAt: new Date(),
  };
  await db
    .insert(crawlDocuments)
    .values(values)
    .onConflictDoUpdate({ target: crawlDocuments.repo, set: values });
}

export async function getDocument(repo: string): Promise<CrawlDocument | undefined> {
  return db.query.crawlDocuments.findFirst({ where: eq(crawlDocuments.repo, repo) });
}

/**
 * 아직 판정되지 않은 원본을 가져온다.
 * 판정 규칙을 바꾼 뒤 재판정할 때는 후보의 state를 new로 되돌리면 여기로 다시 들어온다.
 */
export async function documentsAwaitingJudgement(limit: number): Promise<CrawlDocument[]> {
  return db
    .select()
    .from(crawlDocuments)
    .leftJoin(crawlCandidates, eq(crawlDocuments.repo, crawlCandidates.repo))
    .where(sql`${crawlCandidates.id} IS NULL OR ${crawlCandidates.state} = 'new'`)
    .limit(limit)
    .then((rows) => rows.map((r) => r.crawl_documents));
}

// ─────────────────────────── 후보 ───────────────────────────

export async function recordJudgement(judgement: {
  repo: string;
  productUrl: string | null;
  state: CandidateState;
  reason: DecisionReason;
  decidedBy: "auto" | "admin";
  signals?: Record<string, unknown>;
}): Promise<void> {
  const now = new Date();
  const values = {
    repo: judgement.repo,
    productUrl: judgement.productUrl,
    state: judgement.state,
    reason: judgement.reason,
    decidedBy: judgement.decidedBy,
    signals: judgement.signals ?? null,
    judgedAt: now,
    decidedAt: judgement.decidedBy === "admin" ? now : null,
    updatedAt: now,
  };
  await db
    .insert(crawlCandidates)
    .values(values)
    .onConflictDoUpdate({ target: crawlCandidates.repo, set: values });
}

export async function listCandidates(
  states: CandidateState[],
  limit: number,
): Promise<CrawlCandidate[]> {
  return db
    .select()
    .from(crawlCandidates)
    .where(inArray(crawlCandidates.state, states))
    .orderBy(desc(crawlCandidates.updatedAt))
    .limit(limit);
}

export async function getCandidate(repo: string): Promise<CrawlCandidate | undefined> {
  return db.query.crawlCandidates.findFirst({ where: eq(crawlCandidates.repo, repo) });
}

/** 발행 완료 표시 — products에 올라간 뒤에만 부른다 */
export async function markPublished(repo: string, slug: string): Promise<void> {
  await db
    .update(crawlCandidates)
    .set({ state: "published", publishedSlug: slug, updatedAt: new Date() })
    .where(eq(crawlCandidates.repo, repo));
}

export async function candidateCounts(): Promise<Record<string, number>> {
  const rows = await db
    .select({ state: crawlCandidates.state, count: sql<number>`count(*)::int` })
    .from(crawlCandidates)
    .groupBy(crawlCandidates.state);
  return Object.fromEntries(rows.map((r) => [r.state, r.count]));
}

/** 규칙별로 얼마나 거르고 있는지 — 자동 판정이 블랙박스가 되지 않으려면 필요하다 */
export async function rejectionBreakdown(): Promise<{ reason: string; count: number }[]> {
  return db
    .select({ reason: sql<string>`${crawlCandidates.reason}`, count: sql<number>`count(*)::int` })
    .from(crawlCandidates)
    .where(and(eq(crawlCandidates.state, "rejected"), lte(sql`1`, sql`1`)))
    .groupBy(crawlCandidates.reason)
    .orderBy(desc(sql`count(*)`));
}
