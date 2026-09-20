'use server';

import { revalidatePath } from 'next/cache';
import { currentAdmin } from '@/lib/auth/admin';
import { requestCandidateEvidence, requeueResolvedCandidates } from '@/lib/crawl/admin-review';
import { writeTaglineByHand } from '@/lib/crawl/taglines';
import { getDocument } from '@/lib/crawl/repository';
import { decideCandidate } from '@/lib/crawl/review';
import { changeReviewMode } from '@/lib/crawl/settings';
import { resolveSecondReviews } from '@/lib/crawl/second-review';
import { banProduct } from '@/lib/domain/products/manage';
import type { RequeueState } from './contract';

export type ReviewActionState = { error?: string; message?: string } | null;

/** 사람이 적을 수 있는 소개의 길이. 목록 한 줄에 서는 글이라 짧게 */
const TAGLINE_MIN = 5;
const TAGLINE_MAX = 200;

/**
 * 소개를 직접 적고 승인한다 — 소개가 없어 멈춘 후보(no_description)를 사람이 푸는 길이다.
 *
 * 승인만 하면 소개 자리에 레포 이름이 들어간다. 페이지를 열어 본 사람이 한 줄 적어 두면
 * 발행이 그 줄로 올린다(products.tagline_source = editor, 화면에 "직접 요약"으로 밝힌다).
 * 적은 줄은 모델이 다시 짓지 않는다.
 */
export async function approveWithTagline(_previous: ReviewActionState, form: FormData): Promise<ReviewActionState> {
  const admin = await currentAdmin();
  if (!admin) return { error: '권한이 없습니다. 다시 로그인해주세요.' };
  const repo = String(form.get('repo') ?? '');
  const tagline = String(form.get('tagline') ?? '').replace(/\s+/g, ' ').trim();
  if (tagline.length < TAGLINE_MIN) return { error: `소개를 ${TAGLINE_MIN}자 이상 적어주세요.` };
  if (tagline.length > TAGLINE_MAX) return { error: `소개는 ${TAGLINE_MAX}자까지입니다.` };

  const document = await getDocument(repo);
  if (!document) return { error: '이 후보의 원본을 찾지 못했습니다.' };
  await writeTaglineByHand({ repo, tagline, by: admin.login, documentAt: document.fetchedAt });

  const result = await decideCandidate({
    repo, decision: 'approve', admin: admin.login,
    note: `소개를 직접 적었습니다: ${tagline}`,
    inputHash: String(form.get('inputHash') ?? ''), sourceRevisionHash: String(form.get('sourceRevisionHash') ?? ''),
    candidateRevisionHash: String(form.get('candidateRevisionHash') ?? ''),
  });
  // 적어 둔 줄은 남는다 — 승인이 경합으로 막혀도 다음에 그대로 쓰인다
  if (!result.ok) return { error: result.message };
  revalidatePath('/admin/review');
  return { message: `소개를 적고 승인했습니다. 발행 잡이 이 줄로 올립니다.` };
}
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

/**
 * 지금 기준으로는 보류가 아닌 후보를 규칙 판정으로 되돌린다.
 *
 * 지우거나 대신 결정하지 않는다 — 규칙이 다시 가르도록 큐에 올려놓을 뿐이다.
 */
// useActionState 가 (이전 상태, 폼)을 넘기지만 이 액션은 입력이 없다 — 큐 전체가 대상이다
export async function requeueResolved(): Promise<RequeueState> {
  const admin = await currentAdmin();
  if (!admin) return { error: "권한이 없습니다. 다시 로그인해주세요." };
  const result = await requeueResolvedCandidates(admin.login);
  revalidatePath("/admin/review");
  revalidatePath("/admin/status");
  return { ok: result.requeued, scanned: result.scanned, byReason: result.byReason };
}

/**
 * 공개된 제품을 2차가 제품이 아니라고 본 것 — 사람이 내리거나 그대로 둔다. 자동으로 내리지 않는다.
 */
export async function resolvePublishedSecondReview(_previous: ReviewActionState, form: FormData): Promise<ReviewActionState> {
  const admin = await currentAdmin();
  if (!admin) return { error: '권한이 없습니다. 다시 로그인해주세요.' };
  const id = Number(form.get('id'));
  const slug = String(form.get('slug') ?? '');
  const decision = form.get('decision');
  if (!Number.isSafeInteger(id) || id <= 0 || !slug || (decision !== 'ban' && decision !== 'keep')) return { error: '요청을 읽을 수 없습니다.' };
  if (decision === 'ban') {
    const banned = await banProduct(slug);
    if (!banned.ok) return { error: '제품을 찾지 못했습니다.' };
  }
  const changed = await resolveSecondReviews([id], decision === 'ban' ? 'banned' : 'kept', admin.login);
  revalidatePath('/admin/review');
  revalidatePath('/admin/products');
  return changed ? { message: decision === 'ban' ? '내렸습니다.' : '그대로 둡니다.' } : { error: '이미 처리된 항목입니다.' };
}
