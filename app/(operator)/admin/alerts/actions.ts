'use server';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { adminLocalLoginEnabled, adminOrigin, authSecret, currentAdmin, LOCAL_ADMIN_LOGIN } from '@/lib/auth/admin';
import { parseAlertSettings } from '@/lib/operations/console-alerts';
import { readConsoleAlertSettings, saveConsoleAlertSettings } from '@/lib/operations/console-alerts-store';
import { webWriteAction } from '@/lib/operations/dr/web-gate';
import { assertJobControlCsrf } from '../status/job-control-csrf';

/**
 * 휴대폰 알림 설정 저장(운영 콘솔 조각 4b) — 할 일 「그대로 둔다」와 같은 틀: 쓰기 관문 → 관리자 확인 → CSRF(작업 제어 토큰) → 값 검사 →
 * 작업 로그 한 줄(console-alert-settings — 전·후). 저장 전 확인은 폼이 먼저 보인다. 지금 값이 그 사이 바뀌었으면(다른 창에서 저장) 거절한다.
 */
export const saveConsoleAlertSettingsAction = webWriteAction(async function saveConsoleAlertSettingsAction(input: {
  enabled: boolean; quietStart: string; quietEnd: string; basedOn: string | null; csrfToken: string; csrfExpiresAt: number }) {
  const admin = await currentAdmin();
  if (!admin) return { error: '관리자 로그인이 필요합니다.' };
  try {
    assertJobControlCsrf({ admin, secret: authSecret(), origin: (await headers()).get('origin'), configuredOrigin: adminOrigin(),
      token: input.csrfToken, expiresAt: input.csrfExpiresAt, local: adminLocalLoginEnabled() && admin.login === LOCAL_ADMIN_LOGIN });
  } catch { return { error: '요청을 확인하지 못했습니다. 새로고침한 뒤 다시 해 주세요.' }; }
  const after = parseAlertSettings(input);
  if (!after) return { error: '조용한 시간은 시작과 끝을 함께 「HH:MM」으로 적거나 둘 다 비워 주세요(시작과 끝이 같으면 안 됩니다).' };
  const current = await readConsoleAlertSettings();
  if ((current.at ?? null) !== (input.basedOn ?? null)) return { error: '그 사이 다른 곳에서 알림 설정이 바뀌었습니다. 새로고침해서 지금 값을 확인해 주세요.' };
  if (JSON.stringify(current.settings) === JSON.stringify(after)) return { message: '바뀐 것이 없습니다.' };
  await saveConsoleAlertSettings(current.settings, after, admin.login);
  revalidatePath('/admin/alerts');
  revalidatePath('/admin/activity');
  revalidatePath('/admin/log');
  return { message: after.enabled ? '저장했습니다. 다음 알림 작업(5분 안)부터 새로 생긴 멈춤·평소와 다름을 알립니다.' : '저장했습니다. 알림을 껐습니다 — 열린 알림 줄은 다음 작업에서 닫힙니다.' };
});
