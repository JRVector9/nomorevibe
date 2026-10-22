'use server';

import { revalidatePath } from 'next/cache';
import { currentAdmin } from '@/lib/auth/admin';
import { applyAuditPolicyChunk, policyRunExceptions, previewAuditPolicy, startAuditPolicyRun, startAuditPolicyUndo, undoAuditPolicyChunk,
  type PolicyPreview, type PolicyRunProgress } from '@/lib/crawl/audit-policy';
import { policyRequestSchema, policyStartSchema } from '@/lib/crawl/audit-policy-filter';
import { logger } from '@/lib/observability/logger';
import { webWriteAction } from '@/lib/operations/dr/web-gate';

/**
 * 감사 정책 처리(0116) — 미리보기·실행 만들기·나눠 적용·되돌리기. 화면(PolicyBuilder·PolicyRuns)이 부른다.
 *
 * 화면이 보낸 거르기는 믿지 않고 다시 읽는다(zod). 쓰는 것은 모두 웹 쓰기 관문(webWriteAction — DR writer fence)을 지나고,
 * 라이브러리도 쓰기 트랜잭션마다 fence 를 다시 본다. 미리보기는 읽기만 한다. 적용은 사람이 수를 적어 누른 실행만 — 저절로 시작하는 길은 없다.
 * 작업 로그는 실행마다 한 줄(lib/crawl/audit-policy.ts finishIfDone)이라 여기서 항목마다 남기지 않는다.
 */

export type PolicyActionResult<T> = { ok: true; value: T } | { ok: false; error: string };
const UNAUTHORIZED = { ok: false as const, error: '권한이 없습니다. 다시 로그인해주세요.' };
const BAD_INPUT = { ok: false as const, error: '거르기를 읽지 못했습니다. 새로고침해주세요.' };

function runIdOf(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function refresh(progress: PolicyRunProgress | null) {
  if (!progress?.done) return;
  revalidatePath('/admin/audit');
  revalidatePath('/admin/products');
}

/**
 * 미리보기 — 읽기만. seed 는 표본을 섞는 글자(같으면 같은 표본). 읽기지만 이 파일의 다른 액션처럼 관문을 지난다(관리자 액션 파일의 규칙 —
 * tests/dr-web-fence.test.ts): fenced DB 에서는 미리볼 까닭도 없다(적용할 수 없다)
 */
export const previewAuditPolicyAction = webWriteAction(async function previewAuditPolicyAction(input: unknown, seed?: string):
  Promise<PolicyActionResult<PolicyPreview>> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const parsed = policyRequestSchema.safeParse(input);
  if (!parsed.success) return BAD_INPUT;
  const cleanSeed = typeof seed === 'string' && /^[a-z0-9]{1,16}$/.test(seed) ? seed : undefined;
  return { ok: true, value: await previewAuditPolicy({ ...parsed.data, seed: cleanSeed }) };
});

/** 실행을 만든다 — 적은 수가 지금 손댈 수와 같을 때만. 만든 뒤 화면이 applyPolicyChunkAction 을 끝날 때까지 부른다 */
export const startPolicyRunAction = webWriteAction(async function startPolicyRunAction(input: unknown):
  Promise<PolicyActionResult<{ runId: number; planned: number }>> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const parsed = policyStartSchema.safeParse(input);
  if (!parsed.success) return BAD_INPUT;
  const result = await startAuditPolicyRun({ ...parsed.data, by: admin.login });
  if (!result.ok) return result;
  logger.info('admin.audit_policy_started', { run: result.runId, action: parsed.data.action, planned: result.planned, login: admin.login });
  return { ok: true, value: { runId: result.runId, planned: result.planned } };
});

/** 적용 한 묶음 — 남은 것부터. 몇 번 불러도 같다 */
export const applyPolicyChunkAction = webWriteAction(async function applyPolicyChunkAction(runId: unknown):
  Promise<PolicyActionResult<PolicyRunProgress>> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const id = runIdOf(runId);
  if (!id) return BAD_INPUT;
  const progress = await applyAuditPolicyChunk({ runId: id, by: admin.login });
  if (!progress) return { ok: false, error: '정책 실행을 찾지 못했습니다.' };
  refresh(progress);
  return { ok: true, value: progress };
});

/** 되돌리기를 시작한다 — 적용 중이면 남은 것은 취소한다 */
export const startPolicyUndoAction = webWriteAction(async function startPolicyUndoAction(runId: unknown):
  Promise<PolicyActionResult<PolicyRunProgress>> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const id = runIdOf(runId);
  if (!id) return BAD_INPUT;
  const result = await startAuditPolicyUndo({ runId: id, by: admin.login });
  if (!result.ok) return result;
  logger.info('admin.audit_policy_undo_started', { run: id, login: admin.login });
  return { ok: true, value: result.progress };
});

/** 되돌리기 한 묶음 */
export const undoPolicyChunkAction = webWriteAction(async function undoPolicyChunkAction(runId: unknown):
  Promise<PolicyActionResult<PolicyRunProgress>> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const id = runIdOf(runId);
  if (!id) return BAD_INPUT;
  const progress = await undoAuditPolicyChunk({ runId: id, by: admin.login });
  if (!progress) return { ok: false, error: '정책 실행을 찾지 못했습니다.' };
  refresh(progress);
  return { ok: true, value: progress };
});

/** 그 실행에서 건너뛴 것·되돌리지 못한 것 — 읽기만(관문은 미리보기와 같은 까닭으로 지난다) */
export const policyRunExceptionsAction = webWriteAction(async function policyRunExceptionsAction(runId: unknown):
  Promise<PolicyActionResult<Awaited<ReturnType<typeof policyRunExceptions>>>> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const id = runIdOf(runId);
  if (!id) return BAD_INPUT;
  return { ok: true, value: await policyRunExceptions(id) };
});
