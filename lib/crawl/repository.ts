import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { db } from "@/lib/db";
import {
  crawlFrontier,
  crawlDocuments,
  crawlCandidates,
  crawlSettings,
  type FrontierEntry,
  type FrontierState,
  type CrawlDocument,
  type CrawlCandidate,
  type CandidateState,
  type DecisionReason,
} from "@/lib/db/schema";
import { mergeWithDefaults } from "./settings";
import type { CrawlSettings } from "./settings-schema";
import { factsFromRepoMeta } from "./rules";
import { assertJobLease, type JobLease } from "@/lib/jobs/control";

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
 *
 * 그래서 여러 신호에 걸리는 레포는 **첫 발견 신호가 이긴다.** signal도 builder도 그때 굳고
 * 나중 신호는 덮지 않는다. Claude·Codex 두 트레일러가 같이 찾은 레포가 실측 5%였다.
 */
export async function enqueue(
  entries: { repo: string; signal: string; builder?: string | null; priority?: number }[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const inserted = await db
    .insert(crawlFrontier)
    .values(
      entries.map((e) => ({
        repo: e.repo,
        signal: e.signal,
        builder: e.builder ?? null,
        priority: e.priority ?? 0,
      })),
    )
    .onConflictDoNothing({ target: crawlFrontier.repo })
    .returning({ id: crawlFrontier.id });
  return inserted.length;
}

/**
 * 발견 시점에 굳은 "만든 AI" 추정값. 발행이 이것을 그대로 쓴다.
 *
 * 자유 텍스트인 signal로 현재 설정을 되짚지 않는다 — 라벨을 고치면 밀려 있던 후보가 추정을
 * 잃고, 라벨을 재사용하면 과거 발견분이 소급 재라벨된다.
 */
export async function getFrontierBuilder(repo: string): Promise<string | null> {
  const row = await db.query.crawlFrontier.findFirst({
    where: eq(crawlFrontier.repo, repo),
    columns: { builder: true },
  });
  return row?.builder ?? null;
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

/**
 * 꺼낼 때 받은 소유권. dequeue가 attempts와 next_attempt_at을 함께 바꾸므로, 둘이 그대로면
 * 아직 내 것이다. 10분이 지나 회수돼 다른 워커가 다시 꺼냈으면 둘 다 바뀌어 있다.
 */
export type FrontierClaim = Pick<FrontierEntry, "id" | "attempts" | "nextAttemptAt">;

/** RETURNING으로 받은 시각은 밀리초까지라, 비교도 밀리초에서 자른다 */
function claimed(claim: FrontierClaim) {
  return sql`(${crawlFrontier.state} = 'fetching' and ${crawlFrontier.id} = ${claim.id}
    and ${crawlFrontier.attempts} = ${claim.attempts}
    and date_trunc('milliseconds', ${crawlFrontier.nextAttemptAt}) = ${claim.nextAttemptAt.toISOString()}::timestamp)`;
}

/** claim을 주면 아직 내 것일 때만 바꾼다 — 회수된 항목을 옛 워커가 끝내 버리지 않도록 */
export async function markFrontier(
  repo: string,
  state: Extract<FrontierState, "done" | "skipped">,
  claim?: FrontierClaim,
): Promise<void> {
  await db
    .update(crawlFrontier)
    .set({ state, lastError: null, updatedAt: new Date() })
    .where(claim ? and(eq(crawlFrontier.repo, repo), claimed(claim)) : eq(crawlFrontier.repo, repo));
}

/** Return only this batch's still-owned claims; quota/budget waits are not failed attempts. */
export async function deferFrontier(entries: FrontierEntry[], retryAt?: Date): Promise<void> {
  if (entries.length === 0) return;
  const at = nowExpr();
  await db.update(crawlFrontier).set({
    state: "pending",
    attempts: sql`greatest(0, ${crawlFrontier.attempts} - 1)`,
    nextAttemptAt: retryAt ? sql`greatest(${at}, ${retryAt.toISOString()}::timestamp)` : at,
    updatedAt: at,
  }).where(sql.join(entries.map(claimed), sql` or `));
}

/**
 * 실패 기록. 재시도가 남았으면 백오프로 미루고, 소진되면 failed로 내린다.
 * 일시적 장애(rate limit, 네트워크)와 영구적 실패를 같게 다루면 큐가 막히거나 영원히 돈다.
 *
 * claim을 주면 아직 내 것일 때만 기록한다. 회수된 항목에 옛 워커가 실패를 적으면 새 워커의
 * claim이 풀려, 그 워커가 받아 온 원본까지 버려진다.
 */
export async function markFailed(repo: string, error: string, now?: Date, claim?: FrontierClaim): Promise<void> {
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
    .where(claim ? and(eq(crawlFrontier.repo, repo), claimed(claim)) : eq(crawlFrontier.repo, repo));
}

/**
 * 발행된 제품의 본문 글자를 다시 채운다.
 *
 * 판정 규칙이 본문을 보게 됐는데, 이미 발행된 것들은 그 값이 없던 시절에 수집됐다.
 * 생존 확인이 어차피 같은 주소를 여는 김에 본문을 실어 보내면 새 요청 없이 채워진다.
 * 그래야 발행분 재검수가 지금 기준으로 다시 태울 수 있다. 다만 즉시는 아니다 —
 * 생존 확인은 1분마다 15건(시간당 900건)이라 3천 건이면 한 바퀴에 3시간 반쯤 걸린다.
 * 재검수 화면이 아직 못 태운 몫을 숫자로 밝히는 이유가 이것이다.
 *
 * 본문만 덮는다 — 제목·소개는 발행 시점의 것이 남아야 한다.
 */
/** AI 심사 입력용 README 앞부분을 원본 옆에 둔다. "" 은 없음 표시 — 다시 찾지 않는다 */
export async function setReadmeSample(repo: string, readmeSample: string): Promise<void> {
  await db.execute(sql`
    update crawl_documents
       set page_meta = coalesce(page_meta, '{}'::jsonb) || jsonb_build_object('readmeSample', ${readmeSample}::text)
     where repo = ${repo}
  `);
}

export async function refreshTextSample(slug: string, textSample: string): Promise<void> {
  await db.execute(sql`
    update crawl_documents
       set page_meta = coalesce(page_meta, '{}'::jsonb) || jsonb_build_object('textSample', ${textSample}::text)
     where repo in (select repo from crawl_candidates where published_slug = ${slug})
  `);
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

/**
 * 가져온 원본을 저장하고 프론티어 항목을 끝낸다 — 소유권 확인과 한 트랜잭션이다.
 *
 * 저장·재판정 되돌림·완료 표시를 따로 커밋하던 때는, 리스를 잃고 멈췄던 워커가 재개하면서
 * 그사이 다른 워커가 저장한 최신 원본을 옛것으로 덮어썼다. 리스 검사는 그다음 함수에서야
 * 실패했고, 이미 커밋된 원본은 되돌릴 수 없었다(codex 재현). 그래서 셋을 묶고 소유권을
 * 함께 본다 — 잡 리스, 그리고 이 항목을 꺼낼 때 받은 claim. 잡 리스가 살아 있어도 항목은
 * 회수돼 다른 워커에게 갔을 수 있다.
 *
 * 원본이 판정 입력 쪽에서 바뀌면 자동·미발행 결정을 new로 되돌린다. 주소만 보던 때는 같은
 * 주소가 200에서 404로 바뀌어도 승인이 그대로 남아, 발행이 규칙을 다시 태우지 않는 모드
 * (reviewMode off/observe)에서 죽은 페이지가 올라갔다. 관리자·발행된 결정은 건드리지 않는다.
 * 후보가 아직 없던 사이 판정이 끼어들어 옛 원본으로 승인을 만든 경우는 여기서 못 본다 —
 * 없는 행은 잠글 수 없다. 그것은 발행 직전 재판정(publish.ts)이 받친다.
 *
 * 잠금 순서는 관리자 심사(lockedInput)·발행 가드와 같다: 후보 → 원본 → 프론티어 → 잡.
 * 판정 요청(requestJob)은 여기서 하지 않는다 — 부른 쪽이 묶음이 끝날 때 한 번 한다.
 *
 * @returns claim을 잃었으면 null. 저장했으면 판정할 것이 새로 생겼는지.
 */
export async function saveFetchedDocument(
  claim: FrontierClaim,
  doc: {
    repo: string;
    repoMeta: Record<string, unknown>;
    productUrl: string | null;
    pageStatus: number | null;
    pageMeta: Record<string, unknown> | null;
  },
  lease?: JobLease,
): Promise<{ needsJudgement: boolean } | null> {
  return db.transaction(async (tx) => {
    const [candidate] = await tx.select().from(crawlCandidates).where(eq(crawlCandidates.repo, doc.repo)).for("update");
    const [previous] = await tx.select().from(crawlDocuments).where(eq(crawlDocuments.repo, doc.repo)).for("update");
    const [owned] = await tx.update(crawlFrontier)
      .set({ state: "done", lastError: null, updatedAt: new Date() })
      .where(claimed(claim))
      .returning({ id: crawlFrontier.id });
    if (lease) await assertJobLease(tx, lease);
    if (!owned) return null;

    const values = { ...doc, fetchedAt: new Date() };
    const [saved] = await tx.insert(crawlDocuments).values(values)
      .onConflictDoUpdate({ target: crawlDocuments.repo, set: values })
      .returning();
    if (!candidate || candidate.state === "new") return { needsJudgement: true };
    if (candidate.decidedBy !== "auto" || candidate.publishedSlug
      || !["approved", "needs_review"].includes(candidate.state)
      || (candidate.productUrl === saved.productUrl && previous && !judgedSourceChanged(previous, saved))) {
      return { needsJudgement: false };
    }
    await tx.update(crawlCandidates).set({
      productUrl: saved.productUrl, state: "new", reason: "source_changed", decidedAt: null, updatedAt: new Date(),
    }).where(eq(crawlCandidates.id, candidate.id));
    return { needsJudgement: true };
  });
}

/**
 * 판정이 보는 쪽이 바뀌었는지.
 *
 * 레포 메타 전체를 비교하지 않는다 — updated_at·watchers 같은 것은 다시 받을 때마다 바뀌어,
 * 모든 재수집이 재판정이 된다. 레포는 규칙이 쓰는 사실(RepoFacts)만 보고, 페이지는 메타를
 * 통째로 본다. 규칙이 쓰는 제목·본문·생성기·도착 주소에 더해, 개발 근거 판정이 쓰는
 * repositoryKeys(agent-evidence.ts)와 발행이 그대로 쓰는 소개·이미지가 모두 거기 있다.
 */
function judgedSourceChanged(previous: CrawlDocument, next: CrawlDocument): boolean {
  return previous.productUrl !== next.productUrl
    || previous.pageStatus !== next.pageStatus
    || !isDeepStrictEqual(previous.pageMeta, next.pageMeta)
    || !isDeepStrictEqual(factsFromRepoMeta(previous.repo, previous.repoMeta), factsFromRepoMeta(next.repo, next.repoMeta));
}

export async function getDocument(repo: string): Promise<CrawlDocument | undefined> {
  return db.query.crawlDocuments.findFirst({ where: eq(crawlDocuments.repo, repo) });
}

/**
 * 아직 판정되지 않은 원본을 가져온다.
 * 판정 규칙을 바꾼 뒤 재판정할 때는 후보의 state를 new로 되돌리면 여기로 다시 들어온다.
 */
export async function documentsAwaitingJudgement(limit: number): Promise<CrawlDocument[]> {
  return (await judgementQueue(limit)).map((row) => row.document);
}

/**
 * 판정 대기 원본과, 같은 조회로 읽은 후보.
 *
 * 대기 목록은 원래 후보를 조인해서 고른다. 그 후보를 버리고 판정 잡이 원본마다 다시 읽으면
 * 묶음(50건)마다 SELECT가 50번 더 나간다. 조인한 것을 그대로 넘긴다 — 판정을 저장하는 쪽
 * (recordAutomaticJudgement)이 잠근 뒤 이 스냅샷과 비교하므로 조금 오래된 값이어도 안전하다.
 */
export async function judgementQueue(
  limit: number,
): Promise<{ document: CrawlDocument; candidate: CrawlCandidate | undefined }[]> {
  const rows = await db
    .select()
    .from(crawlDocuments)
    .leftJoin(crawlCandidates, eq(crawlDocuments.repo, crawlCandidates.repo))
    .where(sql`${crawlCandidates.id} IS NULL OR ${crawlCandidates.state} = 'new'`)
    .limit(limit);
  // 후보가 없으면 null이 아니라 undefined다 — 저장 쪽이 잠근 행(없으면 undefined)과 그대로 비교한다
  return rows.map((row) => ({ document: row.crawl_documents, candidate: row.crawl_candidates ?? undefined }));
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

/** Automatic results may only replace the exact pending inputs read before asynchronous checks. */
export async function recordAutomaticJudgement(input: {
  document:CrawlDocument; settings:CrawlSettings; candidate:CrawlCandidate|undefined;
  verdict:{state:"approved"|"rejected"|"needs_review";reason:DecisionReason;signals:Record<string,unknown>};
}):Promise<boolean> {
  return db.transaction(async tx => {
    const [candidate] = await tx.select().from(crawlCandidates).where(eq(crawlCandidates.repo,input.document.repo)).for("update");
    const [document] = await tx.select().from(crawlDocuments).where(eq(crawlDocuments.id,input.document.id)).for("share");
    const [settingsRow] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id,1)).for("share");
    // A pre-existing admin `new` is an explicit rejudge request. A later admin decision is never replaced.
    if ((candidate && candidate.state !== "new") || !isDeepStrictEqual(candidate,input.candidate)
      || !isDeepStrictEqual(document,input.document) || !isDeepStrictEqual(mergeWithDefaults(settingsRow?.values),input.settings)) return false;
    const now = new Date();
    const values = {repo:input.document.repo,productUrl:input.document.productUrl,state:input.verdict.state,
      reason:input.verdict.reason,signals:{ ...input.verdict.signals,
        ...(typeof candidate?.signals?.adminEvidenceRefreshConsumedId === "number"
          ? { adminEvidenceRefreshConsumedId: candidate.signals.adminEvidenceRefreshConsumedId } : {}),
      },decidedBy:"auto" as const,
      judgedAt:now,updatedAt:now,decidedAt:null};
    if (candidate) {
      await tx.update(crawlCandidates).set(values).where(eq(crawlCandidates.id,candidate.id));
      return true;
    }
    // A missing row cannot be locked. A concurrent manual insert wins its unique-key race.
    const inserted = await tx.insert(crawlCandidates).values(values).onConflictDoNothing().returning({id:crawlCandidates.id});
    return inserted.length === 1;
  });
}

export async function listCandidates(
  states: CandidateState[],
  limit: number,
  condition?: import("drizzle-orm").SQL,
): Promise<CrawlCandidate[]> {
  return db
    .select()
    .from(crawlCandidates)
    .where(and(inArray(crawlCandidates.state, states), condition))
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

/**
 * 신호별 수율.
 *
 * 어떤 검색어가 쓸 만한 것을 데려오는지는 켜고 끄기 전에 숫자로 봐야 한다. 프론티어에만
 * 남는 signal과 후보의 판정 결과를 이어 붙여 센다 — 그래서 프론티어 행을 지우지 않는다.
 */
export async function yieldBySignal(): Promise<{ signal: string; state: CandidateState; count: number }[]> {
  return db
    .select({
      signal: crawlFrontier.signal,
      state: sql<CandidateState>`${crawlCandidates.state}`,
      count: sql<number>`count(*)::int`,
    })
    .from(crawlFrontier)
    .innerJoin(crawlCandidates, eq(crawlCandidates.repo, crawlFrontier.repo))
    .groupBy(crawlFrontier.signal, crawlCandidates.state);
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
