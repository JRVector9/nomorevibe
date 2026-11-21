import { JobLeaseLostError } from "@/lib/jobs/lease";
import { RoleLeaseLostError } from "@/lib/jobs/role-leader";
import type { JobContext, JobOutcome } from "@/lib/jobs/runner";
import { DrWriterFencedError } from "@/lib/operations/dr/epoch";
import { DB_RETENTION_PARTS, pruneDiscoveryEvidence, pruneHealthDaily, pruneLedger, pruneMaintainerEmails, pruneScans, shrinkDocuments,
  type DbRetentionCursor, type DbRetentionPart, type PartResult } from "@/lib/operations/db-retention";

/** 틱 마감(deadlineAt)을 모를 때 한 부분이 쓰는 시간의 상한 */
export const DB_RETENTION_PART_SLICE_MS = 8_000;
/**
 * 한 부분의 몫 — 남은 틱 시간을 아직 돌지 않은 부분 수로 나눈다. 일이 없는 부분은 바로 끝나므로 그 시간이 뒤 부분에게 간다
 * (첫 바퀴의 원본 줄이기처럼 밀린 부분이 다른 부분을 굶기지도, 남는 시간을 버리지도 않게).
 */
export function partSliceMs(deadlineAt: number | undefined, remainingParts: number, now = Date.now()): number {
  if (!deadlineAt || remainingParts < 1) return DB_RETENTION_PART_SLICE_MS;
  return Math.max(0, Math.floor((deadlineAt - now) / remainingParts));
}

/**
 * DB 보관 정리 잡(maintenance, 한 시간마다 — 2026-11-15 소유자 승인 DB 보관 ④⑤⑥). 규칙은 lib/operations/db-retention.ts.
 *
 * 한 틱은 여섯 부분(모델 장부 · 발굴 근거 · 수집 원본 줄이기 · 저장소 스캔 · 일일 가동 집계 · 제작자 이메일 1년 보관·공개 제품 아님)을 차례로 돈다. 부분마다 짧은 트랜잭션 묶음을
 * 예산(ctx.hasBudget)과 부분 몫(남은 틱 시간 ÷ 남은 부분 수, partSliceMs) 안에서만 열고, 다 못 한 부분은 커서(jobs.cursor)에 이어 할 자리를 남긴다. 먼저 서는 부분은 틱마다 돌아가므로
 * 한 부분의 밀린 일이 다른 부분을 굶기지 않는다. 원본 줄이기·스캔·가동 집계는 한 바퀴를 마치면 20시간 쉰다(하루 한 번).
 * 모델 장부 부분은 0187, 제작자 이메일 부분은 0194 가 적용된 DB 에서만 돈다(아니면 건너뛰고 skipped=migration_pending 을 남긴다).
 * 부분마다 지운·줄인 수를 db.retention 한 줄에 남긴다.
 */
export async function runDbRetention(ctx: JobContext<DbRetentionCursor>): Promise<JobOutcome<DbRetentionCursor>> {
  const cursor: DbRetentionCursor = ctx.cursor?.v === 1 ? { ...ctx.cursor } : { v: 1 };
  const lead = Number.isSafeInteger(cursor.lead) ? Math.abs(cursor.lead!) % DB_RETENTION_PARTS.length : 0;
  const order = [...DB_RETENTION_PARTS.slice(lead), ...DB_RETENTION_PARTS.slice(0, lead)];
  const results: Partial<Record<DbRetentionPart, PartResult["counts"] & { caughtUp?: boolean }>> = {};
  const next: DbRetentionCursor = { ...cursor, lead: (lead + 1) % DB_RETENTION_PARTS.length };
  const failures: string[] = [];
  for (const [index, part] of order.entries()) {
    if (!ctx.hasBudget()) break;
    const sliceEnd = Date.now() + partSliceMs(ctx.deadlineAt, order.length - index);
    const more = () => ctx.hasBudget() && Date.now() < sliceEnd && !ctx.signal?.aborted;
    try {
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
        case "maintainerEmails": {
          const result = await pruneMaintainerEmails(ctx.lease, cursor.maintainerEmails, more);
          if (result.state) next.maintainerEmails = result.state;
          results.maintainerEmails = { ...result.counts, caughtUp: result.caughtUp };
          break;
        }
      }
    } catch (error) {
      // 소유권을 잃은 것은 이 틱 전체를 멈춘다. 그 밖의 실패(잠금 시간 초과 등)는 그 부분만 접고 다른 부분은 돈다 — 다음 틱에 커서에서 이어 한다
      if (error instanceof JobLeaseLostError || error instanceof RoleLeaseLostError || error instanceof DrWriterFencedError) throw error;
      // drizzle 은 "Failed query: <SQL>" 로 감싼다 — 관측에는 DB 의 까닭(cause)만 남긴다
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      const message = cause instanceof Error ? cause.message : String(cause);
      failures.push(`${part}: ${message.slice(0, 120)}`);
      results[part] = { failed: true };
    }
  }
  ctx.log("db.retention", flatten(results));
  return failures.length ? { done: true, cursor: next, degraded: { code: "retention_part_failed", detail: failures.join(" · ").slice(0, 300) } }
    : { done: true, cursor: next };
}

/** 관측 줄은 평평한 값만 — part.key 꼴로 편다 */
function flatten(results: Partial<Record<DbRetentionPart, Record<string, number | string | boolean>>>): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const [part, counts] of Object.entries(results)) for (const [key, value] of Object.entries(counts ?? {})) out[`${part}.${key}`] = value;
  return out;
}
