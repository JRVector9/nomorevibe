'use server';
import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { adminLocalLoginEnabled, adminOrigin, authSecret, currentAdmin, LOCAL_ADMIN_LOGIN } from '@/lib/auth/admin';
import { controlAdminJob, type AdminJobControl } from '@/lib/operations/admin-job-control';
import { webWriteAction } from '@/lib/operations/dr/web-gate';
import { assertJobControlCsrf } from './job-control-csrf';

export const controlJobAction = webWriteAction(async function controlJobAction(input: AdminJobControl & { csrfToken: string; csrfExpiresAt: number }) {
  const admin = await currentAdmin();
  if (!admin) return { error: '관리자 로그인이 필요합니다.' };
  try {
    assertJobControlCsrf({ admin, secret: authSecret(), origin: (await headers()).get('origin'), configuredOrigin: adminOrigin(),
      token: input.csrfToken, expiresAt: input.csrfExpiresAt, local: adminLocalLoginEnabled() && admin.login === LOCAL_ADMIN_LOGIN });
  } catch { return { error: '요청을 확인하지 못했습니다. 새로고침한 뒤 다시 해 주세요.' }; }
  try {
    await controlAdminJob(input, admin.login);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'job_control_conflict') return { error: '다른 작업자가 상태를 바꿨습니다. 새로고침한 뒤 다시 확인해 주세요.' };
    if (code === 'job_control_unsupported_mode') return { error: '이 작업 배치에서는 개별 멈춤을 지원하지 않습니다. 단계 제어를 확인해 주세요.' };
    if (code === 'job_control_invalid' || code === 'job_control_not_found') return { error: '작업과 사유를 확인해 주세요.' };
    throw error;
  }
  revalidatePath('/admin/status');
  revalidatePath('/admin/activity');
  return { message: input.pause ? '다음 실행부터 멈춥니다. 실행 중인 작업은 끝까지 처리합니다.' : '작업을 재개했습니다. 기존 요청·예약·재시도 대기를 따릅니다.' };
});
