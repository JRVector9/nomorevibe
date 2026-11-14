'use server';

import { revalidatePath } from 'next/cache';
import { currentAdmin } from '@/lib/auth/admin';
import { setHumanReviewEnabled } from '@/lib/crawl/settings';
import { configuredHumanModelsReady } from '@/lib/operations/admin-models-human';
import { readHumanModelSource } from '@/lib/operations/human-model-source';
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
  let keys: readonly string[] = [];
  let fingerprint: string | undefined;
  if (enabled === 'true') {
    let source;
    try { source = await readHumanModelSource(); } catch {
      return { error: '사람 위임 모델 출처를 읽지 못했습니다. 설정은 바꾸지 않았습니다.' };
    }
    const selection = source.selection;
    if (source.unknown || source.saveBlocked || selection.source === 'unknown' || !await configuredHumanModelsReady(source.effectiveKeys, selection)) {
      return { error: '사람 위임 검수에 선택한 모델의 연결을 확인하지 못했습니다. 설정은 바꾸지 않았습니다.' };
    }
    keys = source.pools['human-review'] ?? [];
    fingerprint = selection.fingerprint;
  }
  const result = await setHumanReviewEnabled({ enabled: enabled === 'true', expectedGeneration: Number(rawGeneration), actor: admin.login,
    ...(keys.length ? { expectedModelPoolKeys: keys } : {}),
    ...(fingerprint ? { expectedModelSourceFingerprint: fingerprint } : {}) });
  if (!result.ok) return { error: result.issues.join(' ') };
  for (const path of ['/admin', '/admin/models', '/admin/models/human', '/admin/flow', '/admin/review', '/admin/status']) revalidatePath(path);
  return { message: enabled === 'true' ? '자동 위임 설정을 저장했습니다. 모델의 유효한 승인은 기존 최종 발행 검사로 이어집니다.' : '모델 자동 판단을 껐습니다. 진행 중인 결과도 적용하지 않습니다.' };
});
