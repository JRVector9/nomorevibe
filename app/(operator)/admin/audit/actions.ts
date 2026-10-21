'use server';

import { revalidatePath } from 'next/cache';
import { currentAdmin } from '@/lib/auth/admin';
import { cancelProductAudit, GROUP_REMOVE_MAX, GROUP_SCOPES, keepAuditedProduct, removeAuditedProduct, removeAuditedProducts,
  startProductAudit, switchAuditReviewer, type AuditGroupScope } from '@/lib/crawl/product-audit';
import { auditReviewerLabel } from '@/lib/crawl/product-audit-reviewer';
import { releaseAllAuditHolds } from '@/lib/crawl/product-audit-hold';
import { isAuditReasonCategory } from '@/lib/crawl/audit-reason-category';
import { setAuditHold } from '@/lib/crawl/settings';
import { crawlSettingsSchema } from '@/lib/crawl/settings-schema';
import { fixIntroFromRequest, isIntroRequestOutcome, resolveIntroRequest } from '@/lib/domain/products/intro-requests';
import { LIMITS } from '@/lib/domain/products/limits';
import { logger } from '@/lib/observability/logger';
import { recordAdminAction, recordAdminActions } from '@/lib/operations/admin-log';
import { webWriteAction } from '@/lib/operations/dr/web-gate';

export type AuditActionState = { error?: string; message?: string } | null;
/** 묶어 내리기 결과 — 화면이 알림으로 요약한다 */
export type AuditGroupResult = { error: string } | { removed: number; failed: number };
const UNAUTHORIZED = { error: '권한이 없습니다. 다시 로그인해주세요.' };

/**
 * 감사가 짚은 제품 하나를 내리거나 그대로 둔다.
 *
 * 한 번에 한 제품이다. 폼이 제품을 둘 이상 싣고 오면 아무것도 하지 않는다 — 화면에 일괄 버튼이
 * 없어도 요청은 손으로 만들 수 있다. 1차 심사 글의 실측 정확도는 85%다(2026-09-18 홀드아웃,
 * 결정한 26건 중 22건). 여러 건을 한 번에 내리면 모델이 틀린 몫이 사람 눈을 거치지 않고 같이 내려간다.
 */
export const decideAuditFinding = webWriteAction(async function decideAuditFinding(_previous: AuditActionState, form: FormData): Promise<AuditActionState> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const items = form.getAll('item');
  const slugs = form.getAll('slug');
  const decision = form.get('decision');
  const itemId = Number(items[0]);
  const slug = String(slugs[0] ?? '');
  if (items.length !== 1 || slugs.length !== 1 || !Number.isSafeInteger(itemId) || itemId <= 0 || !slug
    || (decision !== 'remove' && decision !== 'keep')) return { error: '한 번에 한 제품만 처리합니다. 새로고침해주세요.' };
  const result = decision === 'remove'
    ? await removeAuditedProduct({ itemId, slug, by: admin.login })
    : await keepAuditedProduct({ itemId, slug, by: admin.login, note: String(form.get('note') ?? '') });
  await recordAdminAction(admin.login, { action: `audit-${decision}`, target: slug,
    detail: { itemId, note: String(form.get('note') ?? '') || null }, ok: result.ok, error: result.ok ? null : result.error });
  if (!result.ok) return { error: result.error };
  logger.info('admin.product_audit_decided', { slug, decision, login: admin.login });
  revalidatePath('/admin/audit');
  revalidatePath('/admin/products');
  return { message: decision === 'remove' ? '내렸습니다.' : '그대로 둡니다.' };
});

/** 새 감사를 연다. 아무것도 내리지 않는다 — 사람이 볼 새 목록을 만들 뿐이다 */
export const startAudit = webWriteAction(async function startAudit(_previous: AuditActionState, form: FormData): Promise<AuditActionState> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const reason = String(form.get('reason') ?? '');
  const reauditKept = form.get('reauditKept') === 'on';
  const result = await startProductAudit({ startedBy: admin.login, reason, reauditKept });
  await recordAdminAction(admin.login, result.ok
    ? { action: 'audit-start', target: `campaign:${result.campaignId}`,
      detail: { reason, reauditKept, enrolled: result.enrolled, keptSkipped: result.keptSkipped } }
    : { action: 'audit-start', target: 'product_audit', detail: { reason, reauditKept }, ok: false, error: result.error });
  if (!result.ok) return { error: result.error };
  logger.info('admin.product_audit_started', { campaign: result.campaignId, enrolled: result.enrolled, login: admin.login });
  revalidatePath('/admin/audit');
  revalidatePath('/admin/status');
  return { message: `${result.enrolled.toLocaleString('ko-KR')}건을 올렸습니다. 유지 판정으로 뺀 것 ${result.keptSkipped.toLocaleString('ko-KR')}건.` };
});

/** 진행 중인 감사를 멈춘다. 지금까지 찾은 것은 그대로 남는다 */
export const cancelAudit = webWriteAction(async function cancelAudit(): Promise<AuditActionState> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const cancelled = await cancelProductAudit();
  await recordAdminAction(admin.login, { action: 'audit-cancel', target: 'product_audit', ok: cancelled,
    error: cancelled ? null : '진행 중인 감사가 없습니다' });
  logger.info('admin.product_audit_cancelled', { cancelled, login: admin.login });
  revalidatePath('/admin/audit');
  return cancelled ? { message: '중단했습니다.' } : { error: '진행 중인 감사가 없습니다.' };
});

/**
 * 묶어 내리기(ADM-07) — 사람이 이름을 훑고 확인한 묶음을 한 번에 내린다. 최대 GROUP_REMOVE_MAX 건.
 *
 * 한 건씩 내리기와 같은 길을 한 건마다 탄다(removeAuditedProducts). 화면이 보낸 것을 그대로 믿지 않는다 —
 * 확신 문턱·주인 없음·아직 아무도 손대지 않음·갈리지 않음과 묶음의 범위(scope — 보류 중이면 지금도 그 항목으로 보류 중인지,
 * 두 모델 모두 거절이면 거절 의견이 있는지)를 잠근 뒤 다시 보고, 맞지 않는 것은 건너뛴다. 범위는 작업 로그의 group 에 남긴다.
 */
export const removeAuditGroup = webWriteAction(async function removeAuditGroup(form: FormData): Promise<AuditGroupResult> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const ids = form.getAll('item').map(Number);
  const slugs = form.getAll('slug').map(String);
  const group = String(form.get('group') ?? '').slice(0, 40);
  const scopeValue = String(form.get('scope') ?? 'reject');
  if (!(GROUP_SCOPES as readonly string[]).includes(scopeValue)) return { error: '묶음의 범위를 읽지 못했습니다. 새로고침해주세요.' };
  const scope = scopeValue as AuditGroupScope;
  if (!ids.length || ids.length !== slugs.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || slugs.some((slug) => !slug)) {
    return { error: '고른 제품을 읽지 못했습니다. 새로고침해주세요.' };
  }
  if (ids.length > GROUP_REMOVE_MAX) return { error: `한 번에 ${GROUP_REMOVE_MAX}건까지 내립니다.` };
  const items = ids.map((itemId, index) => ({ itemId, slug: slugs[index] }));
  const result = await removeAuditedProducts({ items, by: admin.login, scope });
  const failed = new Map(result.failed.map((item) => [item.slug, item.error]));
  await recordAdminActions(admin.login, items.map((item) => ({ action: 'audit-remove', target: item.slug,
    detail: { itemId: item.itemId, group, scope, bulk: items.length }, ok: !failed.has(item.slug), error: failed.get(item.slug) ?? null })));
  logger.info('admin.product_audit_group_removed', { group, scope, removed: result.removed.length, failed: result.failed.length, login: admin.login });
  revalidatePath('/admin/audit');
  revalidatePath('/admin/products');
  return { removed: result.removed.length, failed: result.failed.length };
});

/**
 * 멈춘 감사(심사 글이 바뀜)를 중단하고 지금 글로 새 감사를 연다 — 화면의 기본 버튼 하나(ADM-15).
 * 닫기와 열기는 한 트랜잭션이다(startProductAudit replacing): 새 감사를 열 수 없으면 멈춘 감사도 그대로고, 두 번 눌러도
 * 방금 연 새 감사를 닫지 않는다. 성공하면 중단과 시작을 작업 로그에 각각 남긴다.
 */
export const restartStalledAudit = webWriteAction(async function restartStalledAudit(form: FormData): Promise<AuditActionState> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const campaignId = Number(form.get('campaign'));
  const reason = String(form.get('reason') ?? '');
  if (!Number.isSafeInteger(campaignId) || campaignId <= 0) return { error: '감사를 읽지 못했습니다. 새로고침해주세요.' };
  const result = await startProductAudit({ startedBy: admin.login, reason, reauditKept: false, replacing: campaignId });
  await recordAdminActions(admin.login, result.ok ? [
    { action: 'audit-cancel', target: `campaign:${campaignId}`, detail: { restart: true } },
    { action: 'audit-start', target: `campaign:${result.campaignId}`,
      detail: { reason, reauditKept: false, replaced: campaignId, enrolled: result.enrolled, keptSkipped: result.keptSkipped } },
  ] : [{ action: 'audit-start', target: `campaign:${campaignId}`, detail: { reason, replacing: campaignId }, ok: false, error: result.error }]);
  if (!result.ok) return { error: result.error };
  logger.info('admin.product_audit_restarted', { replaced: campaignId, campaign: result.campaignId, enrolled: result.enrolled, login: admin.login });
  revalidatePath('/admin/audit');
  revalidatePath('/admin/status');
  return { message: `감사 #${campaignId}을 닫고 #${result.campaignId}을 열었습니다 — ${result.enrolled.toLocaleString('ko-KR')}건.` };
});

/**
 * 남은 감사 모델 바꾸기(0112) — 진행 중인 감사의 아직 답이 없는 항목을 Qwen-v2(gpu3090 직접)로 묻는다. 이미 답한 것은 그대로다.
 * 화면이 본 심사자(expected)를 잠근 감사 행과 견줘 다르면 바꾸지 않는다(compare-and-set). 사유는 꼭 받는다 —
 * 성공·거절 모두 switchAuditReviewer 가 같은 트랜잭션에서 작업 로그(audit-switch-model)에 남긴다.
 */
export const switchAuditModel = webWriteAction(async function switchAuditModel(form: FormData): Promise<AuditActionState> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const campaignId = Number(form.get('campaign'));
  const expected = { provider: String(form.get('expectedProvider') ?? ''), model: String(form.get('expectedModel') ?? '') };
  if (!Number.isSafeInteger(campaignId) || campaignId <= 0 || !expected.provider || !expected.model) {
    return { error: '감사를 읽지 못했습니다. 새로고침해주세요.' };
  }
  const result = await switchAuditReviewer({ campaignId, expected, reason: String(form.get('reason') ?? ''), by: admin.login });
  if (!result.ok) return { error: result.error };
  logger.info('admin.product_audit_reviewer_switched', { campaign: campaignId, from: result.from, to: result.to, unanswered: result.unanswered,
    login: admin.login });
  revalidatePath('/admin/audit');
  revalidatePath('/admin/status');
  return { message: `감사 #${campaignId}의 남은 ${result.unanswered.toLocaleString('ko-KR')}건을 ${auditReviewerLabel(result.to)}(으)로 묻습니다. 이미 답한 것은 그대로입니다.` };
});

/**
 * 감사 보류의 스위치·문턱·사유 갈래·두 번째 모델 거절을 바꾼다. 화면이 본 값(expected)과 잠근 행을 견줘 다르면 쓰지 않는다 —
 * 작업 로그는 setAuditHold 가 같은 트랜잭션에 남긴다. 끄거나 좁혀도 이미 건 보류는 남는다(풀려면 '보류 모두 풀기').
 */
export const saveAuditHold = webWriteAction(async function saveAuditHold(_previous: AuditActionState, form: FormData): Promise<AuditActionState> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const holdSchema = crawlSettingsSchema.shape.auditHold;
  let expected;
  try { expected = holdSchema.safeParse(JSON.parse(String(form.get('expected') ?? ''))); } catch { expected = null; }
  const minConfidence = Number(form.get('minConfidence'));
  const next = holdSchema.safeParse({ enabled: form.get('enabled') === 'on', minConfidence,
    categories: [...new Set(form.getAll('category').map(String).filter(isAuditReasonCategory))],
    secondOpinionReject: form.get('secondOpinionReject') === 'on' });
  if (!expected?.success) return { error: '화면의 값을 읽지 못했습니다. 새로고침해주세요.' };
  if (!next.success) return { error: '확신 문턱은 0.80~1.00 사이로 적어 주세요.' };
  const result = await setAuditHold({ next: next.data, expected: expected.data, actor: admin.login, reason: String(form.get('reason') ?? '') });
  if (!result.ok) return { error: result.issues.join(' · ') };
  logger.info('admin.audit_hold_saved', { login: admin.login, enabled: result.auditHold.enabled });
  revalidatePath('/admin/audit');
  return { message: result.auditHold.enabled ? '보류 설정을 저장했습니다.' : '자동 보류를 껐습니다. 이미 건 보류는 남아 있습니다.' };
});

/**
 * 보류를 모두 푼다 — 문턱을 잘못 잡았을 때 되돌리는 길. 아무것도 내리지 않고, 푼 제품은 목록에 돌아온다.
 * 푼 항목은 다시 보류하지 않는다(새 감사의 새 항목은 걸릴 수 있다). 제품마다 기록이, 작업 로그에 한 줄이 남는다.
 */
export const releaseAuditHolds = webWriteAction(async function releaseAuditHolds(form: FormData): Promise<AuditActionState> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const note = String(form.get('note') ?? '').trim().slice(0, 500) || null;
  const released = await releaseAllAuditHolds({ by: admin.login, note });
  await recordAdminAction(admin.login, { action: 'audit-hold-release-all', target: 'product_audit', detail: { released, note } });
  logger.info('admin.audit_hold_released', { released, login: admin.login });
  revalidatePath('/admin/audit');
  revalidatePath('/admin/products');
  return { message: `보류 ${released.toLocaleString('ko-KR')}건을 풀었습니다. 목록에 돌아옵니다.` };
});

/** 요청 번호 — 폼이 하나만 싣는다 */
function requestId(form: FormData): number | null {
  const ids = form.getAll('id');
  const id = Number(ids[0]);
  return ids.length === 1 && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * 소개 수정 요청의 소개 고치기(UX-18) — 요청을 보고 새 한 줄을 적는다. 그 제품의 처리 전 요청을 모두 '고침'으로 닫고,
 * 고치기 전·후 소개를 작업 로그에 남긴다. 검색 노출과 CDN 은 건드리지 않는다(내려달라는 요청과 다른 길).
 */
export const fixIntroRequest = webWriteAction(async function fixIntroRequest(_previous: AuditActionState, form: FormData): Promise<AuditActionState> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const id = requestId(form);
  const slug = String(form.get('slug') ?? '');
  const tagline = String(form.get('tagline') ?? '').trim();
  if (!id || !slug) return { error: '요청을 읽지 못했습니다. 새로고침해주세요.' };
  if (!tagline) return { error: '새 소개를 적어 주세요.' };
  if (tagline.length > LIMITS.tagline) return { error: `소개는 ${LIMITS.tagline}자까지입니다.` };
  const fixed = await fixIntroFromRequest(id, tagline, admin.login);
  await recordAdminAction(admin.login, { action: 'intro-request-edit', target: fixed?.slug ?? slug,
    detail: fixed ? { requestId: id, closed: fixed.closed, before: fixed.before, after: tagline } : { requestId: id },
    ok: fixed !== null, error: fixed ? null : 'stale' });
  if (!fixed) return { error: '이미 처리했거나 고칠 수 없는 제품입니다(내려갔거나 주인이 생김). 새로고침해주세요.' };
  logger.info('admin.intro_request_fixed', { slug: fixed.slug, id, login: admin.login });
  revalidatePath('/admin/audit');
  revalidatePath('/admin/products');
  revalidatePath(`/p/${fixed.slug}`);
  return { message: fixed.closed.length > 1 ? `소개를 고치고 요청 ${fixed.closed.length}건을 닫았습니다.` : '소개를 고쳤습니다.' };
});

/** 소개 수정 요청의 처리함·둠 — 소개는 그대로 두고 요청 하나에 결과만 적는다 */
export const resolveIntroRequestAction = webWriteAction(async function resolveIntroRequestAction(_previous: AuditActionState, form: FormData): Promise<AuditActionState> {
  const admin = await currentAdmin();
  if (!admin) return UNAUTHORIZED;
  const id = requestId(form);
  const outcome = form.get('outcome');
  const slug = String(form.get('slug') ?? '');
  if (!id || !slug || !isIntroRequestOutcome(outcome)) return { error: '요청을 읽지 못했습니다. 새로고침해주세요.' };
  const note = String(form.get('note') ?? '') || null;
  const done = await resolveIntroRequest(id, outcome, admin.login, note);
  await recordAdminAction(admin.login, { action: `intro-request-${outcome}`, target: done?.slug ?? slug,
    detail: { requestId: id, note }, ok: done !== null, error: done ? null : 'stale' });
  if (!done) return { error: '이미 처리한 요청입니다. 새로고침해주세요.' };
  logger.info('admin.intro_request_resolved', { slug: done.slug, id, outcome, login: admin.login });
  revalidatePath('/admin/audit');
  return { message: outcome === 'fixed' ? '처리함으로 닫았습니다.' : '두었습니다.' };
});
