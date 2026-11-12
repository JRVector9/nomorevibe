import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { humanBatchGates, type HumanBatchGate } from "@/lib/db/schema";
import { HUMAN_BATCH_KEYS, type HumanBatchKey, type HumanBatchMember, type HumanBatchResult, type HumanBatchUndoResult,
  type HumanBatchVerdict } from "./human-batch-model";

/**
 * 사람 확인 묶음의 관문 줄(human_batch_gates, 0181) 읽기·쓰기. 판단은 하지 않는다 — 규칙은 human-batch-model.ts, 순서는 human-batch-run.ts.
 * 쓰기는 모두 조건부다: 실행한 줄의 표본은 바꾸지 않고, 실행·되돌리기는 한 번만 잡는다(두 창에서 눌러도 한쪽만 된다).
 */

export type { HumanBatchGate };

export async function insertHumanBatchGate(input: { key: HumanBatchKey; actor: string; members: HumanBatchMember[]; snapshotHash: string;
  sampleIds: number[]; excluded: number[] }): Promise<HumanBatchGate> {
  const [row] = await db.insert(humanBatchGates).values({ batchKey: input.key, actor: input.actor, members: input.members,
    snapshotHash: input.snapshotHash, sampleIds: input.sampleIds, excluded: input.excluded }).returning();
  return row;
}

export async function readHumanBatchGate(id: number): Promise<HumanBatchGate | null> {
  const [row] = await db.select().from(humanBatchGates).where(eq(humanBatchGates.id, id)).limit(1);
  return row ?? null;
}

/** 운영자의 묶음별 마지막 줄 — 화면은 이 줄의 표본·결과를 그린다 */
export async function latestHumanBatchGates(actor: string): Promise<Partial<Record<HumanBatchKey, HumanBatchGate>>> {
  const rows = await db.selectDistinctOn([humanBatchGates.batchKey]).from(humanBatchGates)
    .where(eq(humanBatchGates.actor, actor)).orderBy(humanBatchGates.batchKey, desc(humanBatchGates.id));
  return Object.fromEntries(rows.filter(row => (HUMAN_BATCH_KEYS as readonly string[]).includes(row.batchKey)).map(row => [row.batchKey, row]));
}

/** 표본 하나의 「맞음/아님」 — 실행 전·그 운영자의 줄·표본 안의 후보일 때만. 바꿨으면 true */
export async function markHumanBatchVerdict(input: { id: number; actor: string; candidateId: number; verdict: HumanBatchVerdict }): Promise<boolean> {
  const rows = await db.update(humanBatchGates).set({
    verdicts: sql`${humanBatchGates.verdicts} || jsonb_build_object(${String(input.candidateId)}::text, ${input.verdict}::text)`,
    updatedAt: sql`now()`,
  }).where(and(eq(humanBatchGates.id, input.id), eq(humanBatchGates.actor, input.actor), isNull(humanBatchGates.executedAt),
    sql`${input.candidateId}::integer = ANY(${humanBatchGates.sampleIds})`)).returning({ id: humanBatchGates.id });
  return rows.length > 0;
}

/** 실행을 잡는다 — 아직 실행하지 않은 그 운영자의 줄만, 한 번. 잡은 줄을 돌려준다(못 잡으면 null) */
export async function claimHumanBatchRun(input: { id: number; actor: string; decision: "approve" | "reject" }): Promise<HumanBatchGate | null> {
  const [row] = await db.update(humanBatchGates).set({ executedAt: sql`now()`, decision: input.decision, updatedAt: sql`now()` })
    .where(and(eq(humanBatchGates.id, input.id), eq(humanBatchGates.actor, input.actor), isNull(humanBatchGates.executedAt))).returning();
  return row ?? null;
}

export async function saveHumanBatchResult(id: number, result: HumanBatchResult): Promise<void> {
  await db.update(humanBatchGates).set({ result, updatedAt: sql`now()` }).where(eq(humanBatchGates.id, id));
}

/** 묶음째 되돌리기를 잡는다 — 실행이 끝나 결과가 있고 아직 되돌리지 않은 줄만, 한 번 */
export async function claimHumanBatchUndo(input: { id: number; actor: string }): Promise<HumanBatchGate | null> {
  const [row] = await db.update(humanBatchGates).set({ undoneAt: sql`now()`, undoneBy: input.actor, updatedAt: sql`now()` })
    .where(and(eq(humanBatchGates.id, input.id), isNotNull(humanBatchGates.executedAt), isNotNull(humanBatchGates.result),
      isNull(humanBatchGates.undoneAt))).returning();
  return row ?? null;
}

export async function saveHumanBatchUndo(id: number, undoResult: HumanBatchUndoResult): Promise<void> {
  await db.update(humanBatchGates).set({ undoResult, updatedAt: sql`now()` }).where(eq(humanBatchGates.id, id));
}

/** 일괄 결정 기록 — 실행한 줄을 최근 것부터(모든 운영자) */
export async function recentHumanBatchRuns(limit = 10): Promise<HumanBatchGate[]> {
  return db.select().from(humanBatchGates).where(isNotNull(humanBatchGates.executedAt))
    .orderBy(desc(humanBatchGates.executedAt), desc(humanBatchGates.id)).limit(limit);
}
