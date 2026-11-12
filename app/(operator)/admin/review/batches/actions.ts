'use server';

import { revalidatePath } from 'next/cache';
import { currentAdmin } from '@/lib/auth/admin';
import { markHumanBatchSample, runHumanBatch, startHumanBatchSample, undoHumanBatch } from '@/lib/crawl/human-batch-run';
import { HUMAN_BATCHES_HREF, isHumanBatchKey, isHumanBatchVerdict } from '@/lib/crawl/human-batch-model';
import { webWriteAction } from '@/lib/operations/dr/web-gate';

/**
 * 사람 확인 · 묶음의 서버 동작(운영 콘솔 개편 조각 3b). 자격을 다시 보고 입력 모양만 거른 뒤 lib/crawl/human-batch-run.ts 에 넘긴다 —
 * 결정은 거기서 기존 건별 경로(overrideCandidate·undoAdminDecision)를 부르고 작업 로그를 남긴다.
 * 결과는 { error } 또는 { message } — 알림(Toast)과 확인 창(ConfirmAction)이 그대로 읽는다.
 */
export type HumanBatchActionState = { error: string } | { message: string; gateId?: number };

const DENIED = { error: '권한이 없습니다. 다시 로그인해주세요.' } as const;
const id = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const done = (result: { ok: boolean; message: string; gateId?: number }): HumanBatchActionState => {
  revalidatePath(HUMAN_BATCHES_HREF);
  return result.ok ? { message: result.message, ...(result.gateId ? { gateId: result.gateId } : {}) } : { error: result.message };
};

export const startHumanBatchSampleAction = webWriteAction(async function startHumanBatchSampleAction(key: unknown): Promise<HumanBatchActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  if (!isHumanBatchKey(key)) return { error: '알 수 없는 묶음입니다.' };
  return done(await startHumanBatchSample(admin.login, key));
});

export const markHumanBatchSampleAction = webWriteAction(async function markHumanBatchSampleAction(gateId: unknown, candidateId: unknown, verdict: unknown): Promise<HumanBatchActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  if (!id(gateId) || !id(candidateId) || !isHumanBatchVerdict(verdict)) return { error: '표본 판정을 읽을 수 없습니다.' };
  return done(await markHumanBatchSample(admin.login, gateId as number, candidateId as number, verdict));
});

export const runHumanBatchAction = webWriteAction(async function runHumanBatchAction(gateId: unknown, values: unknown): Promise<HumanBatchActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  const input = values && typeof values === 'object' ? values as Record<string, unknown> : {};
  if (!id(gateId)) return { error: '묶음을 읽을 수 없습니다.' };
  const reason = typeof input.reason === 'string' ? input.reason.slice(0, 40) : undefined;
  const note = typeof input.note === 'string' ? input.note.slice(0, 2000) : undefined;
  const result = await runHumanBatch(admin.login, gateId as number, { reason, note });
  revalidatePath('/admin/review');
  return done(result);
});

export const undoHumanBatchAction = webWriteAction(async function undoHumanBatchAction(gateId: unknown): Promise<HumanBatchActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  if (!id(gateId)) return { error: '묶음을 읽을 수 없습니다.' };
  const result = await undoHumanBatch(admin.login, gateId as number);
  revalidatePath('/admin/review');
  return done(result);
});
