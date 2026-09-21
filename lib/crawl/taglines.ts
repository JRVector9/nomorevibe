import { isDeepStrictEqual } from "node:util";
import { assertJobLease, requestJob, type JobLease } from "@/lib/jobs/control";
import { emitPipelineEvent } from "@/lib/observability/review-pipeline";
import { taglineEvidence, taglineHash } from "./tagline";
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

type AutomaticTaglineResult =
  | { kind: "success"; tagline: string; source: TaglineEvidenceSource; model: string }
  | { kind: "failure"; error: string }
  | { kind: "reuse" };

/** A worker result, source CAS, release and wake-up are a single fenced transaction. */
export async function recordTaglineResult(task: TaglineTask, lease: JobLease, result: AutomaticTaglineResult) {
  let request: Awaited<ReturnType<typeof requestJob>> | undefined;
  const recorded = await db.transaction(async tx => {
    const [candidate] = await tx.select().from(crawlCandidates).where(eq(crawlCandidates.id, task.candidate.id)).for("update");
    const [document] = await tx.select().from(crawlDocuments).where(eq(crawlDocuments.id, task.document.id)).for("share");
    const [written] = await tx.select().from(crawlTaglines).where(eq(crawlTaglines.repo, task.candidate.repo)).for("update");
    if (!candidate || candidate.state !== "needs_review" || candidate.reason !== "no_description" || candidate.decidedBy !== "auto"
      || written?.writtenBy || !isDeepStrictEqual(candidate, task.candidate) || !isDeepStrictEqual(document, task.document)
      || !isDeepStrictEqual(written ?? null, task.written)) return { stored: false, released: false };
    const sourceHash = taglineHash(taglineEvidence(candidate.repo, document!));
    let line = "";
    if (result.kind === "reuse") {
      if (!written || written.errorCode || written.sourceHash !== sourceHash) return { stored: false, released: false };
      line = written.tagline;
      await tx.update(crawlTaglines).set({ documentAt: document!.fetchedAt, updatedAt: sql`now()` })
        .where(eq(crawlTaglines.repo, candidate.repo));
    } else {
      line = result.kind === "success" ? result.tagline.slice(0, 200) : "";
      const common = { sourceHash, documentAt: document!.fetchedAt, updatedAt: sql`now()`,
        errorCode: result.kind === "failure" ? result.error.slice(0, 60) : null };
      const [saved] = await tx.insert(crawlTaglines).values({ repo: candidate.repo, ...common, tagline: line,
        source: result.kind === "success" ? result.source : "page", model: result.kind === "success" ? result.model : "",
        attempts: 1, retryAt: result.kind === "failure" ? sql`now() + interval '5 minutes'` : null,
      }).onConflictDoUpdate({ target: crawlTaglines.repo,
        set: { ...common, attempts: sql`${crawlTaglines.attempts} + 1`,
          ...(result.kind === "success" ? { tagline: line, source: result.source, model: result.model, retryAt: null }
            : { retryAt: sql`now() + least(interval '24 hours', interval '5 minutes' * power(2, ${crawlTaglines.attempts}))` }),
        },
        // An absent row can be inserted by an administrator after our SELECT. It always wins.
        setWhere: task.written ? sql`${crawlTaglines.writtenBy} is null AND date_trunc('milliseconds', ${crawlTaglines.updatedAt}) = ${task.written.updatedAt.toISOString()}::timestamp` : sql`false`,
      }).returning({ repo: crawlTaglines.repo });
      if (!saved) return { stored: false, released: false };
    }
    const released = Boolean(line);
    if (released) {
      await tx.update(crawlCandidates).set({ state: "approved", reason: "passed", updatedAt: new Date() })
        .where(eq(crawlCandidates.id, candidate.id));
      request = await requestJob("crawl-publish", tx);
    }
    // Scheduler locks publish before tagline. Check ownership last, rolling everything back on loss.
    await assertJobLease(tx, lease);
    return { stored: true, released };
  });
  if (recorded.stored) emitPipelineEvent("committed", { stage: "text", candidateId: task.candidate.id, job: lease.name, state: result.kind });
  if (request) emitPipelineEvent("requested", { stage: "text", candidateId: task.candidate.id,
    nextJob: request.job, requestedVersion: request.requestedVersion });
  return recorded;
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
