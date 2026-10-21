'use server';

import { revalidatePath } from 'next/cache';
import { currentAdmin } from '@/lib/auth/admin';
import { setSplitTiebreak } from '@/lib/crawl/settings';
import { webWriteAction } from '@/lib/operations/dr/web-gate';

export type SplitTiebreakActionState = { error?: string; message?: string } | null;

const flag = (value: FormDataEntryValue | null) => value === 'true' ? true : value === 'false' ? false : null;
const count = (value: FormDataEntryValue | null) => typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : null;

/**
 * 갈림 판가름(Qwen-v2) 스위치와 한 틱의 수 — 화면이 본 값(expected*)과 같을 때만 바꾼다(setSplitTiebreak, compare-and-set).
 * 끄면 다음 호출부터 묻지 않고, 받는 중인 답도 거부로 반영하지 않는다.
 */
export const setSplitTiebreakAction = webWriteAction(async function setSplitTiebreakAction(_previous: SplitTiebreakActionState, form: FormData): Promise<SplitTiebreakActionState> {
  const admin = await currentAdmin();
  if (!admin) return { error: '권한이 없습니다. 다시 로그인해주세요.' };
  const enabled = flag(form.get('enabled')), perTick = count(form.get('perTick'));
  const expectedEnabled = flag(form.get('expectedEnabled')), expectedPerTick = count(form.get('expectedPerTick'));
  if (enabled === null || perTick === null || expectedEnabled === null || expectedPerTick === null) return { error: '스위치 값을 읽을 수 없습니다.' };
  const result = await setSplitTiebreak({ next: { enabled, perTick }, expected: { enabled: expectedEnabled, perTick: expectedPerTick }, actor: admin.login });
  if (!result.ok) return { error: result.issues.join(' ') };
  for (const path of ['/admin', '/admin/review']) revalidatePath(path);
  return { message: enabled ? `갈림 판가름을 켰습니다 — 2차 틱마다 ${perTick}건까지 Qwen-v2 에 묻습니다.` : '갈림 판가름을 껐습니다. 받는 중인 답도 거부로 반영하지 않습니다.' };
});
