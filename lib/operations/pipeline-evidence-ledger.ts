import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { STALE_LOCK_MS } from "@/lib/jobs/lease";

/**
 * 처리량 2배 판정용 증거 장부(0097 pipeline_evidence_events, append-only).
 *
 * 운영자가 기록 시작 marker(startEvidenceRecorder)를 남긴 뒤에만 행이 쌓인다 — 그 전에는 모든 기록이 같은 문장
 * 안에서 아무 행도 만들지 않는다. 판정은 marker가 구간 시작 이전인 구간만 장부로 센다(수집기).
 * replay 범위의 제한 역할에는 이 표 권한이 없어 기록하지 않는다.
 */
export type EvidenceStage = "ai1" | "ai2";
type Subject = { stage: EvidenceStage; candidateId?: number | null; firstAttemptId?: number | null; secondReviewId?: number | null };
export type EvidenceOwnership = { kind: "job"; name: string; token: string } | { kind: "item"; stage: EvidenceStage; workKey: string; token: string };
type Executor = ProductTransaction | typeof db;

async function record(executor: Executor, kind: string, subject: Subject, condition: SQL,
  extra: { rootReviewId?: number; failed?: boolean; code?: string | null } = {}): Promise<void> {
  if (currentReplayDb()) return;
  // 결과 트랜잭션 안의 기록이다 — 공급자 오류 문자열 때문에 CHECK에 걸려 결과 저장까지 되감기지 않게 한다.
  const code = extra.code?.trim().slice(0, 60) || null;
  await executor.execute(sql`insert into pipeline_evidence_events
      (kind, stage, candidate_id, first_attempt_id, second_review_id, root_review_id, failed, code)
    select ${kind}::varchar, ${subject.stage}::varchar, ${subject.candidateId ?? null}::int, ${subject.firstAttemptId ?? null}::int,
      ${subject.secondReviewId ?? null}::int, ${extra.rootReviewId ?? null}::int, ${extra.failed ?? null}::boolean, ${code}::varchar
    where exists (select 1 from pipeline_evidence_events m where m.kind = 'recorder_started') and ${condition}`);
}
const humanDecided = (candidateId: number) =>
  sql`exists (select 1 from crawl_candidates c where c.id = ${candidateId}::int and c.decided_by = 'admin')`;

/** 자동 결과가 반영되지 않았고 그 후보가 사람 결정 상태다(같은 트랜잭션, 후보 행은 이미 잠겨 있다). */
export function recordHumanDecisionRefused(tx: ProductTransaction, subject: Subject & { candidateId: number }): Promise<void> {
  return record(tx, "human_decision_refused", subject, humanDecided(subject.candidateId));
}

/** 자동 후보 갱신 직전 pre-image. 가드가 바뀌어도 사람 결정 위의 쓰기는 같은 커밋에 위반으로 남는다. */
export function recordHumanDecisionOverride(tx: ProductTransaction, subject: Subject & { candidateId: number }): Promise<void> {
  return record(tx, "human_decision_overridden", subject, humanDecided(subject.candidateId));
}

/**
 * 최종 소유권 확인 직전. 만료된 lease는 되살아나지 않으므로 여기서 위반이면 뒤의 확인도 던져 이 행까지 되감긴다 —
 * 커밋된 위반 행은 최종 확인이 늦은 저장을 통과시켰다는 뜻이다.
 */
export function recordLeaseViolation(tx: ProductTransaction, subject: Subject, ownership: EvidenceOwnership): Promise<void> {
  const owned = ownership.kind === "item"
    ? sql`exists (select 1 from pipeline_item_leases l where l.stage = ${ownership.stage} and l.work_key = ${ownership.workKey}
        and l.token = ${ownership.token}::uuid and l.lease_until > clock_timestamp())`
    : sql`exists (select 1 from jobs j where j.name = ${ownership.name} and j.lease_token = ${ownership.token}
        and j.locked_at >= clock_timestamp() - ${STALE_LOCK_MS} * interval '1 millisecond')`;
  return record(tx, "lease_violation", subject, sql`not ${owned}`, { code: ownership.kind });
}

/** AI2 호출 한 번의 결과. second_reviews 행은 재시도마다 덮이지만 장부는 호출 시각에 남는다. */
export function recordAi2Attempt(tx: ProductTransaction, subject: Subject & { secondReviewId: number },
  result: { rootReviewId: number; failed: boolean; code: string | null }): Promise<void> {
  return record(tx, "ai2_attempt", { ...subject, stage: "ai2" }, sql`true`, result);
}

const OWNERSHIP_LOST = new Set(["item_lease_lost", "job_lease_lost", "agent_review_ownership_lost", "second_review_ownership_lost"]);
export function ownershipLostCode(error: unknown): string | null {
  return error instanceof Error && OWNERSHIP_LOST.has(error.message) ? error.message : null;
}

/** 소유권을 잃어 결과 트랜잭션이 되감긴 뒤 별도 문장으로 남긴다. 원래 오류를 가리지 않도록 기록 실패는 삼킨다. */
export async function recordLateWriteRefused(subject: Subject, error: unknown): Promise<void> {
  const code = ownershipLostCode(error);
  if (!code) return;
  try { await record(db, "late_write_refused", subject, sql`true`, { code }); }
  catch { /* 거부 이력은 참고값이다 — 호출자는 원래 오류를 그대로 던진다 */ }
}

/** 모든 쓰기 프로세스가 이 기록기를 실행한다고 운영자가 확인한 뒤 한 번 남긴다. 이미 있으면 그대로 둔다. */
export async function startEvidenceRecorder(executor: Executor, input: { revision: string; operator: string }): Promise<{ startedAt: string }> {
  await executor.execute(sql`insert into pipeline_evidence_events (kind, revision, operator)
    values ('recorder_started', ${input.revision}, ${input.operator}) on conflict (kind) where kind = 'recorder_started' do nothing`);
  const [row] = await executor.execute<{ started_at: string }>(sql`select to_char(created_at at time zone 'utc',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as started_at from pipeline_evidence_events where kind = 'recorder_started'`);
  return { startedAt: row.started_at };
}
