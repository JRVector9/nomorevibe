'use server';

import { revalidatePath } from 'next/cache';
import { currentAdmin } from '@/lib/auth/admin';
import { requestCandidateEvidence, requeueResolvedCandidates, undoAdminDecision } from '@/lib/crawl/admin-review';
import { writeTaglineByHand } from '@/lib/crawl/taglines';
import { getDocument } from '@/lib/crawl/repository';
import { decideCandidate } from '@/lib/crawl/review';
import { changeReviewMode, getSettings, saveSettings } from '@/lib/crawl/settings';
import { listGatewayModels } from '@/lib/crawl/agent-review-gateway';
import { sameReviewModel } from '@/lib/crawl/review-model-identity';
import { decidePublishedSecondReview } from '@/lib/crawl/published-second-review';
import { recordAdminAction, recordAdminActions } from '@/lib/operations/admin-log';
import { MAX_BULK_DECISIONS, type DecidedCandidate, type RequeueState } from './contract';
import { CLAUDE_MODELS, GROK_MODELS, parseVoterValue } from './voters';

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
  await recordAdminAction(admin.login, { action: 'candidate-approve', target: repo, detail: { tagline },
    ok: result.ok, error: result.ok ? null : result.message });
  // 적어 둔 줄은 남는다 — 승인이 경합으로 막혀도 다음에 그대로 쓰인다
  if (!result.ok) return { error: result.message };
  revalidatePath('/admin/review');
  return { message: `소개를 적고 승인했습니다. 발행 잡이 이 줄로 올립니다.` };
}
export async function collectCandidateEvidence(_previous: ReviewActionState, form: FormData): Promise<ReviewActionState> {
  const admin = await currentAdmin();
  if (!admin) return { error: '권한이 없습니다. 다시 로그인해주세요.' };
  const repo = String(form.get('repo') ?? '');
  const note = String(form.get('note') ?? '');
  const result = await requestCandidateEvidence({
    actor: admin.login, repo, reason: note,
    inputHash: String(form.get('inputHash') ?? ''), sourceRevisionHash: String(form.get('sourceRevisionHash') ?? ''),
    candidateRevisionHash: String(form.get('candidateRevisionHash') ?? ''),
  });
  await recordAdminAction(admin.login, { action: 'evidence-collect', target: repo, detail: { note },
    ok: result.ok, error: result.ok ? null : result.message });
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
  if (!result.ok) {
    // 바꾼 것은 changeReviewMode 트랜잭션이 남긴다. 거절된 것만 여기서
    await recordAdminAction(admin.login, { action: 'review-mode', target: 'crawl_settings',
      detail: { before: expectedMode, after: mode }, ok: false, error: result.issues.join(' ') });
    return { error: result.issues.join(' ') };
  }
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
  const changed = await decidePublishedSecondReview({ id, slug, decision, actor: admin.login });
  await recordAdminAction(admin.login, { action: `published-second-${decision}`, target: slug, detail: { secondReviewId: id },
    ok: changed, error: changed ? null : '이미 처리됐거나 화면이 오래됨' });
  revalidatePath('/admin/review');
  revalidatePath('/admin/products');
  return changed ? { message: decision === 'ban' ? '내렸습니다.' : '그대로 둡니다.' } : { error: '이미 처리됐거나 화면이 오래됐습니다. 새로고침해주세요.' };
}

/**
 * 2차 표를 바로 바꾼다 — Grok 한도가 바닥나거나 게이트웨이 모델이 내려가면 큰 설정 폼을 다시 저장하지 않고 여기서 고른다.
 * 표는 하나만 세운다. 대체(fallbacks)·기준값은 그대로 둔다. 바꾸면 옛 표의 대기 행은 다음 2차 잡이 닫는다(model_removed).
 * 기록은 설정 저장이 같은 트랜잭션에서 남긴다(settings-save, 바뀐 값 전과 후).
 */
export async function switchSecondVoter(_previous: ReviewActionState, form: FormData): Promise<ReviewActionState> {
  const admin = await currentAdmin();
  if (!admin) return { error: '권한이 없습니다. 다시 로그인해주세요.' };
  const choice = parseVoterValue(form.get('voter'));
  if (!choice) return { error: '고를 수 있는 모델이 아닙니다.' };
  // 화면 밖에서 만든 요청도 같은 목록 안에서만 받는다
  const allowed = choice.provider === 'grok-cli' ? (GROK_MODELS as readonly string[]).includes(choice.model)
    : choice.provider === 'claude-cli' ? (CLAUDE_MODELS as readonly string[]).includes(choice.model)
      : (await listGatewayModels())?.includes(choice.model) ?? false;
  if (!allowed) return { error: choice.provider === 'abcllm' ? '게이트웨이에 지금 없는 모델입니다. 새로고침해주세요.' : '고를 수 있는 모델이 아닙니다.' };
  const settings = await getSettings();
  if (sameReviewModel(settings.firstReview?.model, choice.model)) return { error: '1차와 같은 모델은 2차 표가 될 수 없습니다.' };
  const current = settings.secondReview.voters;
  if (current.length === 1 && current[0].provider === choice.provider && current[0].model === choice.model) return { message: '이미 이 모델이 2차 표입니다.' };
  const result = await saveSettings({ secondReview: { ...settings.secondReview, voters: [choice] } }, admin.login);
  if (!result.ok) return { error: result.issues.join(' ') };
  revalidatePath('/admin/review');
  revalidatePath('/admin');
  revalidatePath('/admin/status');
  return { message: `2차 표를 ${choice.model} 로 바꿨습니다. 다음 2차 잡(1분 안)부터 이 모델이 봅니다.` };
}

/**
 * 방금 내린 승인·거부를 되돌린다 — 결정 뒤 알림의 "되돌리기(10초)"가 부른다(2026-10-08 UX 감사 ADM-12).
 *
 * 결정한 뒤 아무 일도 없었을 때만 이전 상태로 돌린다(undoAdminDecision). 발행 워커가 이미 올렸거나 상태를 바꿨으면
 * 그 사유를 돌려준다. 되돌린 것은 같은 트랜잭션에서 작업 로그에 새 줄로 남고, 못 한 것은 여기서 실패로 남긴다.
 */
export async function undoCandidateDecisions(targets: DecidedCandidate[]): Promise<ReviewActionState> {
  const admin = await currentAdmin();
  if (!admin) return { error: '권한이 없습니다. 다시 로그인해주세요.' };
  // 화면 밖에서 만든 요청도 같은 모양만 받는다
  const list = Array.isArray(targets) ? targets.filter((target) => typeof target?.repo === 'string' && target.repo.length <= 200
    && Number.isSafeInteger(target.attemptId) && target.attemptId > 0) : [];
  if (!list.length || list.length !== targets.length) return { error: '되돌릴 결정을 읽을 수 없습니다.' };
  if (list.length > MAX_BULK_DECISIONS) return { error: `한 번에 최대 ${MAX_BULK_DECISIONS}건까지 되돌립니다.` };

  const failures: (DecidedCandidate & { message: string })[] = [];
  for (const target of list) {
    const result = await undoAdminDecision({ repo: target.repo, attemptId: target.attemptId, actor: admin.login });
    if (!result.ok) failures.push({ ...target, message: result.message });
  }
  await recordAdminActions(admin.login, failures.map((failure) => ({ action: 'candidate-undo', target: failure.repo,
    detail: { attemptId: failure.attemptId }, ok: false, error: failure.message })));
  revalidatePath('/admin/review');
  revalidatePath('/admin/status');
  const restored = list.length - failures.length;
  if (!failures.length) return { message: `${restored.toLocaleString('ko-KR')}건을 결정 앞 상태로 되돌렸습니다.` };
  if (list.length === 1) return { error: failures[0].message };
  return { error: `${failures.length}건은 되돌리지 못했습니다(${restored}건은 되돌림) — ${failures[0].repo}: ${failures[0].message}` };
}
