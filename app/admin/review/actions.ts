'use server';

import { revalidatePath } from 'next/cache';
import { currentAdmin } from '@/lib/auth/admin';
import { requestCandidateEvidence } from '@/lib/crawl/admin-review';
import { changeReviewMode } from '@/lib/crawl/settings';

export type ReviewActionState = { error?: string; message?: string } | null;
export async function collectCandidateEvidence(_previous: ReviewActionState, form: FormData): Promise<ReviewActionState> {
  const admin = await currentAdmin();
  if (!admin) return { error: '권한이 없습니다. 다시 로그인해주세요.' };
  const result = await requestCandidateEvidence({
    actor: admin.login, repo: String(form.get('repo') ?? ''), reason: String(form.get('note') ?? ''),
    inputHash: String(form.get('inputHash') ?? ''), sourceRevisionHash: String(form.get('sourceRevisionHash') ?? ''),
    candidateRevisionHash: String(form.get('candidateRevisionHash') ?? ''),
  });
  if (!result.ok) return { error: result.message };
  revalidatePath('/admin/review');
  revalidatePath('/admin/status');
  return { message: result.message };
}
export async function setReviewMode(_previous: ReviewActionState, form: FormData): Promise<ReviewActionState> {
  const admin = await currentAdmin();
  if (!admin) return { error: '권한이 없습니다. 다시 로그인해주세요.' };
  const mode = String(form.get('mode') ?? '');
  const expectedMode = String(form.get('expectedMode') ?? '');
  if (!['off', 'observe', 'enforce'].includes(mode) || !['off', 'observe', 'enforce'].includes(expectedMode)) {
    return { error: '알 수 없는 리뷰 모드입니다.' };
  }
  const result = await changeReviewMode({ actor: admin.login, mode: mode as 'off' | 'observe' | 'enforce',
    expectedMode: expectedMode as 'off' | 'observe' | 'enforce', reason: String(form.get('reason') ?? '') });
  if (!result.ok) return { error: result.issues.join(' ') };
  revalidatePath('/admin/review');
  revalidatePath('/admin');
  revalidatePath('/admin/status');
  return { message: '리뷰 모드와 변경 사유를 기록했습니다.' };
}
