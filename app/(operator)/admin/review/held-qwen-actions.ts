'use server';

import { revalidatePath } from 'next/cache';
import { currentAdmin } from '@/lib/auth/admin';
import { setHeldQwenRetry } from '@/lib/crawl/settings';
import { HELD_QWEN_REASONS, type HeldQwenRetrySettings } from '@/lib/crawl/settings-schema';
import { webWriteAction } from '@/lib/operations/dr/web-gate';

export type HeldQwenActionState = { error?: string; message?: string } | null;

/** 화면이 그린 값(expected)과 바꿀 값(next)을 함께 받는다 — 서버가 잠긴 행에서 expected 와 견준 뒤에만 쓴다(compare-and-set) */
function parse(raw: FormDataEntryValue | null): HeldQwenRetrySettings | null {
  if (typeof raw !== 'string' || raw.length > 2_000) return null;
  try {
    const value = JSON.parse(raw) as Partial<HeldQwenRetrySettings>;
    if (typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.perTick) || !Number.isSafeInteger(value.budgetSeconds)
      || !Array.isArray(value.reasons) || value.reasons.some((reason) => !(HELD_QWEN_REASONS as readonly string[]).includes(reason))) return null;
    return { enabled: value.enabled, perTick: value.perTick!, budgetSeconds: value.budgetSeconds!, reasons: [...value.reasons] };
  } catch { return null; }
}

export const setHeldQwenRetryAction = webWriteAction(async function setHeldQwenRetryAction(_previous: HeldQwenActionState, form: FormData): Promise<HeldQwenActionState> {
  const admin = await currentAdmin();
  if (!admin) return { error: '권한이 없습니다. 다시 로그인해주세요.' };
  const next = parse(form.get('next'));
  const expected = parse(form.get('expected'));
  if (!next || !expected) return { error: '설정 값을 읽을 수 없습니다.' };
  const result = await setHeldQwenRetry({ next, expected, actor: admin.login });
  if (!result.ok) return { error: result.issues.join(' ') };
  for (const path of ['/admin/review', '/admin', '/admin/status']) revalidatePath(path);
  return { message: result.qwenHeldRetry.enabled
    ? `Qwen-v2 가 보류 ${result.qwenHeldRetry.reasons.length}개 사유를 한 틱 ${result.qwenHeldRetry.perTick}건씩 다시 봅니다.`
    : 'Qwen-v2 보류 재심사를 껐습니다. 진행 중인 결과도 적용하지 않고, 관문도 Qwen-v2 승인을 받지 않습니다.' };
});
