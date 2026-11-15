import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { DB_RETENTION_PARTS, pruneDiscoveryEvidence, pruneHealthDaily, pruneLedger, pruneScans, shrinkDocuments,
  type DbRetentionCursor, type DbRetentionPart, type PartResult } from "@/lib/operations/db-retention";

/** 한 부분이 한 틱에 쓰는 시간의 상한 — 틱 예산(기본 25초) 안에서 다섯 부분이 차례로 서도록 */
export const DB_RETENTION_PART_SLICE_MS = 8_000;

/**
 * DB 보관 정리 잡(maintenance, 한 시간마다 — 2026-11-15 소유자 승인 DB 보관 ④⑤⑥). 규칙은 lib/operations/db-retention.ts.
 *
 * 한 틱은 다섯 부분(모델 장부 · 발굴 근거 · 수집 원본 줄이기 · 저장소 스캔 · 일일 가동 집계)을 차례로 돈다. 부분마다 짧은 트랜잭션 묶음을
 * 예산(ctx.hasBudget)과 부분 몫(8초) 안에서만 열고, 다 못 한 부분은 커서(jobs.cursor)에 이어 할 자리를 남긴다. 먼저 서는 부분은 틱마다 돌아가므로
 * 한 부분의 밀린 일이 다른 부분을 굶기지 않는다. 원본 줄이기·스캔·가동 집계는 한 바퀴를 마치면 20시간 쉰다(하루 한 번).
 * 모델 장부 부분은 0187 이 적용된 DB 에서만 돈다(아니면 건너뛰고 skipped=migration_pending 을 남긴다).
 * 부분마다 지운·줄인 수를 db.retention 한 줄에 남긴다.
 */
export async function runDbRetention(ctx: JobContext<DbRetentionCursor>): Promise<JobOutcome<DbRetentionCursor>> {
  const cursor: DbRetentionCursor = ctx.cursor?.v === 1 ? { ...ctx.cursor } : { v: 1 };
  const lead = Number.isSafeInteger(cursor.lead) ? Math.abs(cursor.lead!) % DB_RETENTION_PARTS.length : 0;
  const order = [...DB_RETENTION_PARTS.slice(lead), ...DB_RETENTION_PARTS.slice(0, lead)];
  const results: Partial<Record<DbRetentionPart, PartResult["counts"] & { caughtUp?: boolean }>> = {};
  const next: DbRetentionCursor = { ...cursor, lead: (lead + 1) % DB_RETENTION_PARTS.length };
  for (const part of order) {
    if (!ctx.hasBudget()) break;
    const sliceEnd = Date.now() + DB_RETENTION_PART_SLICE_MS;
    const more = () => ctx.hasBudget() && Date.now() < sliceEnd && !ctx.signal?.aborted;
    switch (part) {
      case "ledger": {
        const result = await pruneLedger(ctx.lease, more);
        results.ledger = { ...result.counts, caughtUp: result.caughtUp };
        break;
      }
      case "evidence": {
        const result = await pruneDiscoveryEvidence(ctx.lease, cursor.evidence, more);
        next.evidence = result.state; results.evidence = { ...result.counts, caughtUp: result.caughtUp };
        break;
      }
      case "documents": {
        const result = await shrinkDocuments(ctx.lease, cursor.documents, more);
        next.documents = result.state; results.documents = { ...result.counts, caughtUp: result.caughtUp };
        break;
      }
      case "scans": {
        const result = await pruneScans(ctx.lease, cursor.scans, more);
        next.scans = result.state; results.scans = { ...result.counts, caughtUp: result.caughtUp };
        break;
      }
      case "health": {
        const result = await pruneHealthDaily(ctx.lease, cursor.health, more);
        next.health = result.state; results.health = { ...result.counts, caughtUp: result.caughtUp };
        break;
      }
    }
  }
  ctx.log("db.retention", flatten(results));
  return { done: true, cursor: next };
}

/** 관측 줄은 평평한 값만 — part.key 꼴로 편다 */
function flatten(results: Partial<Record<DbRetentionPart, Record<string, number | string | boolean>>>): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const [part, counts] of Object.entries(results)) for (const [key, value] of Object.entries(counts ?? {})) out[`${part}.${key}`] = value;
  return out;
}
