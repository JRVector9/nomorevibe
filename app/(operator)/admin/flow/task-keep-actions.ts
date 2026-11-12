'use server';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { adminLocalLoginEnabled, adminOrigin, authSecret, currentAdmin, LOCAL_ADMIN_LOGIN } from '@/lib/auth/admin';
import { keepConsoleTask, parseConsoleKeep } from '@/lib/operations/console-task-keep';
import { formatKst } from '@/lib/operations/console-tasks';
import { webWriteAction } from '@/lib/operations/dr/web-gate';
import { assertJobControlCsrf } from '../status/job-control-csrf';

/**
 * 운영 홈 할 일의 「사유 남기고 유지」·「그대로 두기」 — 작업 멈춤·재개(controlJobAction)와 같은 틀: 쓰기 관문 → 관리자 확인 → CSRF(작업 제어 토큰) → 값 검사 →
 * 작업 로그 한 줄(console-task-keep, 사유 필수). 잡·모델 상태는 바꾸지 않는다 — 할 일을 정한 기간 동안 목록에서 내릴 뿐이다.
 */
export const keepConsoleTaskAction = webWriteAction(async function keepConsoleTaskAction(input: { taskId: string; ref: string | null; reason: string; title: string;
  csrfToken: string; csrfExpiresAt: number }) {
  const admin = await currentAdmin();
  if (!admin) return { error: '관리자 로그인이 필요합니다.' };
  try {
    assertJobControlCsrf({ admin, secret: authSecret(), origin: (await headers()).get('origin'), configuredOrigin: adminOrigin(),
      token: input.csrfToken, expiresAt: input.csrfExpiresAt, local: adminLocalLoginEnabled() && admin.login === LOCAL_ADMIN_LOGIN });
  } catch { return { error: '요청을 확인하지 못했습니다. 새로고침한 뒤 다시 해 주세요.' }; }
  const parsed = parseConsoleKeep(input);
  if (!parsed) return { error: '할 일과 사유를 확인해 주세요.' };
  const { until } = await keepConsoleTask(parsed, admin.login);
  revalidatePath('/admin/flow');
  revalidatePath('/admin/activity');
  return { message: `${formatKst(until)}까지 할 일 목록에서 내립니다. 그때도 같으면 다시 올라옵니다.` };
});
