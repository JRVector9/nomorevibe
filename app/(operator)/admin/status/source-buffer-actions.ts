'use server';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { adminLocalLoginEnabled, adminOrigin, authSecret, currentAdmin, LOCAL_ADMIN_LOGIN } from '@/lib/auth/admin';
import { setSourceBufferEnabled } from '@/lib/crawl/settings';
import { webWriteAction } from '@/lib/operations/dr/web-gate';
import { assertSourceBufferCsrf } from './source-buffer-csrf';

export type SourceBufferActionResult = { message?: string; error?: string };
export type SourceBufferActionInput = { enabled: boolean; expectedEnabled: boolean; reason: string; csrfToken: string; csrfExpiresAt: number };

/**
 * 원본 공급 조절(source buffer) 켜기·끄기(ops-v8 PR8) — 다른 관리자 쓰기와 같은 문: 재해 복구 쓰기 관문(webWriteAction) →
 * 관리자 세션 → 요청 확인(관리자 주소·세션 HMAC) → 잠근 설정 행에서 화면이 본 값과 견주고 바꾼 뒤 작업 로그(전·후·사유).
 * POST 로 바로 부를 수 있으므로 받은 값은 모두 다시 검사한다.
 */
export const setSourceBufferAction = webWriteAction(async function setSourceBufferAction(input: SourceBufferActionInput): Promise<SourceBufferActionResult> {
  const admin = await currentAdmin();
  if (!admin) return { error: '관리자 로그인이 필요합니다.' };
  try {
    assertSourceBufferCsrf({ admin, secret: authSecret(), origin: (await headers()).get('origin'), configuredOrigin: adminOrigin(),
      token: input.csrfToken, expiresAt: Number(input.csrfExpiresAt), local: adminLocalLoginEnabled() && admin.login === LOCAL_ADMIN_LOGIN });
  } catch {
    return { error: '요청을 확인하지 못했습니다 — 화면을 새로고침한 뒤 다시 해 주세요.' };
  }
  if (typeof input.enabled !== 'boolean' || input.expectedEnabled !== !input.enabled) return { error: '바꿀 값을 확인해 주세요.' };
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '';
  if (!reason) return { error: '사유를 적어 주세요.' };
  const result = await setSourceBufferEnabled({ enabled: input.enabled, expectedEnabled: input.expectedEnabled, actor: admin.login, reason });
  if (!result.ok) return { error: result.issues.join(' · ') };
  revalidatePath('/admin/status');
  return { message: input.enabled ? '원본 공급 조절을 켰습니다 — 다음 수집 회차부터 판정합니다.' : '원본 공급 조절을 껐습니다 — 다음 수집 회차부터 조절하지 않습니다.' };
});
