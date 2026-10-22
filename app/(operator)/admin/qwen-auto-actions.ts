'use server';

import { revalidatePath } from 'next/cache';
import { currentAdmin } from '@/lib/auth/admin';
import { setQwenAutoStep } from '@/lib/crawl/settings';
import { QWEN_AUTO_STEPS, type QwenAutoStep } from '@/lib/crawl/settings-schema';
import { logger } from '@/lib/observability/logger';
import { webWriteAction } from '@/lib/operations/dr/web-gate';

export type QwenAutoActionState = { error?: string; message?: string } | null;

const LABEL: Record<QwenAutoStep, string> = {
  auditSecondOpinion: 'Qwen-v2 감사 두 번째 의견', publishedFilter: 'Qwen-v2 공개분 2차 거르기', splitTiebreak: '2차 갈림 판가름(Qwen-v2)',
  heldRetry: 'Qwen-v2 보류 재심사', screenReview: '화면 판별(m1 Qwen 화면+글)',
};
const PATHS: Record<QwenAutoStep, string[]> = {
  auditSecondOpinion: ['/admin/audit', '/admin/status'], publishedFilter: ['/admin/audit', '/admin/review'],
  splitTiebreak: ['/admin/review', '/admin'], heldRetry: ['/admin/review', '/admin', '/admin/status'],
  screenReview: ['/admin/audit', '/admin/status'],
};

/**
 * Qwen-v2 자동 단계 하나를 켜고 끈다 — 감사 화면·심사 큐의 스위치가 부른다. 화면이 본 값(expected)과 잠근 설정 행을 견줘 다르면 쓰지 않고,
 * 켜는 바꿈은 사유를 꼭 받는다. 작업 로그(qwen-auto-settings)는 setQwenAutoStep 이 같은 트랜잭션에 남긴다.
 */
export const saveQwenAutoStep = webWriteAction(async function saveQwenAutoStep(_previous: QwenAutoActionState, form: FormData): Promise<QwenAutoActionState> {
  const admin = await currentAdmin();
  if (!admin) return { error: '권한이 없습니다. 다시 로그인해주세요.' };
  const step = String(form.get('step') ?? '');
  if (!(QWEN_AUTO_STEPS as readonly string[]).includes(step)) return { error: '단계를 읽지 못했습니다. 새로고침해주세요.' };
  let next: unknown, expected: unknown;
  try {
    next = JSON.parse(String(form.get('next') ?? ''));
    expected = JSON.parse(String(form.get('expected') ?? ''));
  } catch { return { error: '설정 값을 읽을 수 없습니다. 새로고침해주세요.' }; }
  const key = step as QwenAutoStep;
  const result = await setQwenAutoStep({ step: key, next: next as never, expected: expected as never, actor: admin.login,
    reason: String(form.get('reason') ?? '') });
  if (!result.ok) return { error: result.issues.join(' · ') };
  logger.info('admin.qwen_auto_saved', { login: admin.login, step: key, enabled: result.after.enabled });
  for (const path of PATHS[key]) revalidatePath(path);
  return { message: result.after.enabled ? `${LABEL[key]}을(를) 켰습니다 — 다음 틱부터 돕니다.` : `${LABEL[key]}을(를) 껐습니다. 받는 중인 답도 반영하지 않습니다.` };
});
