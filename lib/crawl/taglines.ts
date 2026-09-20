import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlTaglines, type CrawlCandidate, type CrawlDocument, type CrawlTagline } from "@/lib/db/schema";
import type { TaglineEvidenceSource } from "./tagline";

/**
 * 지은 소개의 보관과 대기열.
 *
 * 짓는 일(게이트웨이 호출)은 tagline.ts, 고르고 남기는 일은 여기다 — translate.ts/translations.ts 와 같다.
 */

/** 이만큼 실패하면 손을 뗀다. 남은 건 사람이 본다 */
const MAX_ATTEMPTS = 5;

export type TaglineTask = { candidate: CrawlCandidate; document: CrawlDocument; written: CrawlTagline | null };

/**
 * 소개를 지어 줘야 하는 후보.
 *
 * 소개가 없어 발행이 멈춘 자동 후보만이다(사람이 본 것은 사람의 결정이다). 다시 집는 경우는 셋 —
 * 아직 한 번도 안 지었거나, 실패가 다시 볼 때가 됐거나, **지은 뒤에 원본이 바뀌었거나**.
 * 세 번째가 있어야 "증거로는 알 수 없다"(빈 줄)로 남은 후보가 페이지가 바뀌었을 때 다시 불린다.
 * 원본이 그대로면 잡이 해시를 보고 부르지 않고 넘어간다(touchTagline).
 */
export async function pendingTaglines(limit: number): Promise<TaglineTask[]> {
  const rows = await db.select({ candidate: crawlCandidates, document: crawlDocuments, written: crawlTaglines })
    .from(crawlCandidates)
    .innerJoin(crawlDocuments, eq(crawlDocuments.repo, crawlCandidates.repo))
    .leftJoin(crawlTaglines, eq(crawlTaglines.repo, crawlCandidates.repo))
    .where(and(
      eq(crawlCandidates.state, "needs_review"),
      eq(crawlCandidates.reason, "no_description"),
      eq(crawlCandidates.decidedBy, "auto"),
      // 사람이 적은 줄은 다시 짓지 않는다 — 그 사람이 페이지를 보고 적었다
      sql`${crawlTaglines.writtenBy} is null`,
      sql`(${crawlTaglines.repo} is null
        or (${crawlTaglines.errorCode} is not null and ${crawlTaglines.attempts} < ${MAX_ATTEMPTS}
            and (${crawlTaglines.retryAt} is null or ${crawlTaglines.retryAt} <= now()))
        or ${crawlTaglines.documentAt} is distinct from ${crawlDocuments.fetchedAt})`,
    ))
    // 오래 기다린 것부터. 실패한 것이 새 후보를 밀어내지 않도록 시도 적은 순이 먼저다
    .orderBy(sql`coalesce(${crawlTaglines.attempts}, 0) asc, ${crawlCandidates.updatedAt} asc`)
    .limit(limit);
  return rows.map((row) => ({ candidate: row.candidate, document: row.document, written: row.written ?? null }));
}

/** 지은 줄을 남긴다. 빈 줄도 남긴다 — "증거로는 알 수 없다"는 답도 답이라 다시 묻지 않는다 */
export async function recordTagline(row: {
  repo: string; tagline: string; source: TaglineEvidenceSource; model: string; sourceHash: string; documentAt: Date;
}): Promise<void> {
  const line = row.tagline.slice(0, 200);
  await db.insert(crawlTaglines).values({
    repo: row.repo, tagline: line, source: row.source, model: row.model,
    sourceHash: row.sourceHash, documentAt: row.documentAt, attempts: 1, errorCode: null, retryAt: null, updatedAt: sql`now()`,
  }).onConflictDoUpdate({
    target: crawlTaglines.repo,
    set: {
      tagline: line, source: row.source, model: row.model, sourceHash: row.sourceHash, documentAt: row.documentAt,
      errorCode: null, retryAt: null, updatedAt: sql`now()`, attempts: sql`${crawlTaglines.attempts} + 1`,
    },
  });
}

/** 실패는 5분·10분·20분… 뒤에 다시(최대 하루). 원본 해시는 그 실패가 무엇을 보다 났는지다 */
export async function recordTaglineFailure(row: { repo: string; sourceHash: string; documentAt: Date; error: string }): Promise<void> {
  const code = row.error.slice(0, 60);
  await db.insert(crawlTaglines).values({
    repo: row.repo, tagline: "", source: "page", model: "", sourceHash: row.sourceHash, documentAt: row.documentAt,
    attempts: 1, errorCode: code, retryAt: sql`now() + interval '5 minutes'`, updatedAt: sql`now()`,
  }).onConflictDoUpdate({
    target: crawlTaglines.repo,
    set: {
      sourceHash: row.sourceHash, documentAt: row.documentAt, errorCode: code, updatedAt: sql`now()`,
      attempts: sql`${crawlTaglines.attempts} + 1`,
      retryAt: sql`now() + least(interval '24 hours', interval '5 minutes' * power(2, ${crawlTaglines.attempts}))`,
    },
  });
}

/**
 * 원본을 다시 긁었지만 내용이 그대로일 때 — 본 판만 새 판으로 적는다.
 *
 * 이게 없으면 다시 긁을 때마다 같은 증거로 모델을 또 부른다(재수집은 하루에 한 번씩 돈다).
 */
export async function touchTagline(repo: string, documentAt: Date): Promise<void> {
  await db.update(crawlTaglines).set({ documentAt, updatedAt: sql`now()` }).where(eq(crawlTaglines.repo, repo));
}

/**
 * 사람이 적은 한 줄을 남긴다. 심사에서 페이지를 열어 본 사람이 적는다.
 *
 * 모델이 지은 줄을 덮어써도 된다 — 사람이 그 줄을 보고도 직접 적기로 한 것이다.
 */
export async function writeTaglineByHand(row: { repo: string; tagline: string; by: string; documentAt: Date }): Promise<void> {
  const line = row.tagline.trim().slice(0, 200);
  await db.insert(crawlTaglines).values({
    repo: row.repo, tagline: line, source: "page", model: "", sourceHash: "",
    documentAt: row.documentAt, attempts: 0, errorCode: null, retryAt: null, writtenBy: row.by, updatedAt: sql`now()`,
  }).onConflictDoUpdate({
    target: crawlTaglines.repo,
    set: { tagline: line, source: "page", model: "", sourceHash: "", documentAt: row.documentAt,
      errorCode: null, retryAt: null, writtenBy: row.by, updatedAt: sql`now()` },
  });
}

/** 발행이 쓸 줄. 지을 때 본 원본이 지금 원본과 같을 때만 준다(사람이 적은 줄은 원본이 바뀌어도 쓴다) */
export async function writtenTagline(repo: string): Promise<CrawlTagline | undefined> {
  const [row] = await db.select().from(crawlTaglines).where(eq(crawlTaglines.repo, repo));
  return row;
}

/**
 * 소개를 지었으니 발행 대기로 되돌린다.
 *
 * 되돌리는 곳은 "승인됨"이다 — 심사를 다시 받는 자리이기도 하다. 승인이 유효기간을 넘겼으면
 * 1차 심사가 이 후보를 다시 집고(listReviewCandidates 가 approved 를 본다), 유효하면 발행 잡이
 * 곧바로 집는다. 판정 기록(signals·decidedBy)은 건드리지 않는다 — 소개를 지었을 뿐 다시 판정한 것이 아니다.
 *
 * 사람이 그 사이 손댔으면(decidedBy·state 가 바뀌었으면) 아무것도 하지 않는다.
 */
export async function releaseForPublish(candidateId: number): Promise<boolean> {
  const done = await db.update(crawlCandidates)
    .set({ state: "approved", reason: "passed", updatedAt: new Date() })
    .where(and(
      eq(crawlCandidates.id, candidateId),
      eq(crawlCandidates.state, "needs_review"),
      eq(crawlCandidates.reason, "no_description"),
      eq(crawlCandidates.decidedBy, "auto"),
    ))
    .returning({ id: crawlCandidates.id });
  return done.length > 0;
}
