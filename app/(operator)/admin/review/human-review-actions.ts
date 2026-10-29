'use server';

import { revalidatePath } from 'next/cache';
import { currentAdmin } from '@/lib/auth/admin';
import { getSettings, setHumanReviewEnabled } from '@/lib/crawl/settings';
import { configuredHumanModelsReady } from '@/lib/operations/admin-models-human';
import { webWriteAction } from '@/lib/operations/dr/web-gate';

export type HumanReviewActionState = { error?: string; message?: string } | null;

export const setHumanReview = webWriteAction(async function setHumanReview(_previous: HumanReviewActionState, form: FormData): Promise<HumanReviewActionState> {
  const admin = await currentAdmin();
  if (!admin) return { error: '권한이 없습니다. 다시 로그인해주세요.' };
  const enabled = form.get('enabled');
  const rawGeneration = form.get('generation');
  if ((enabled !== 'true' && enabled !== 'false') || typeof rawGeneration !== 'string' || !/^\d+$/.test(rawGeneration)
    || !Number.isSafeInteger(Number(rawGeneration))) {
    return { error: '스위치 값을 읽을 수 없습니다.' };
  }
  const keys = enabled === 'true' ? (await getSettings())?.stageModelPools?.['human-review'] ?? [] : [];
  if (enabled === 'true' && !await configuredHumanModelsReady(keys)) {
    return { error: '사람 위임 검수에 선택한 모델의 연결을 확인하지 못했습니다. 설정은 바꾸지 않았습니다.' };
  }
  const result = await setHumanReviewEnabled({ enabled: enabled === 'true', expectedGeneration: Number(rawGeneration), actor: admin.login,
    ...(keys.length ? { expectedModelPoolKeys: keys } : {}) });
  if (!result.ok) return { error: result.issues.join(' ') };
  for (const path of ['/admin', '/admin/models', '/admin/review', '/admin/status']) revalidatePath(path);
  return { message: enabled === 'true' ? '선택한 사람 위임 검수 모델에 맡깁니다.' : '모델 자동 판단을 껐습니다. 진행 중인 결과도 적용하지 않습니다.' };
});
