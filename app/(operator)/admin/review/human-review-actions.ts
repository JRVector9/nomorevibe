'use server';

import { revalidatePath } from 'next/cache';
import { currentAdmin } from '@/lib/auth/admin';
import { setHumanReviewEnabled } from '@/lib/crawl/settings';
import { deepseekReviewReady } from '@/lib/crawl/deepseek-review';
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
  if (enabled === 'true' && !await deepseekReviewReady()) {
    return { error: 'M3 Ultra에서 DeepSeek 모델을 확인하지 못했습니다. 설정은 바꾸지 않았습니다.' };
  }
  const result = await setHumanReviewEnabled({ enabled: enabled === 'true', expectedGeneration: Number(rawGeneration), actor: admin.login });
  if (!result.ok) return { error: result.issues.join(' ') };
  for (const path of ['/admin', '/admin/review', '/admin/status']) revalidatePath(path);
  return { message: enabled === 'true' ? '사람 검토를 M3 Ultra DeepSeek에 맡깁니다.' : 'DeepSeek 자동 판단을 껐습니다. 진행 중인 결과도 적용하지 않습니다.' };
});
